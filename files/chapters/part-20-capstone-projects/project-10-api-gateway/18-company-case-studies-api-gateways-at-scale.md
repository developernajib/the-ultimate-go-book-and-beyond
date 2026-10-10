## Company Case Studies: API Gateways at Scale

Understanding how major companies build and operate their API gateways gives you valuable context for your own design decisions. Each company below solved a different set of challenges -- from Kong's focus on a rich plugin ecosystem, to Netflix Zuul's dynamic routing filters, to Envoy's cloud-native xDS configuration APIs. Studying these real-world systems shows you which patterns scale to billions of requests and which trade-offs each team made along the way.

### Kong: Plugin-Driven API Gateway

Kong processes trillions of API requests:

```go
// Kong-style plugin-driven API gateway
package kong

import (
    "context"
    "net/http"
    "sync"
)

// KongGateway manages API routing and plugins
type KongGateway struct {
    router       *Router
    pluginChain  *PluginChain
    upstreams    map[string]*Upstream
    services     map[string]*Service
    consumers    map[string]*Consumer
    adminAPI     *AdminAPI
}

// Service represents a Kong service
type Service struct {
    ID           string            `json:"id"`
    Name         string            `json:"name"`
    Protocol     string            `json:"protocol"`
    Host         string            `json:"host"`
    Port         int               `json:"port"`
    Path         string            `json:"path,omitempty"`
    Retries      int               `json:"retries"`
    ConnectTimeout int             `json:"connect_timeout"`
    WriteTimeout int               `json:"write_timeout"`
    ReadTimeout  int               `json:"read_timeout"`
    Tags         []string          `json:"tags,omitempty"`
}

// Route defines how requests reach services
type Route struct {
    ID          string   `json:"id"`
    Name        string   `json:"name,omitempty"`
    Protocols   []string `json:"protocols"`
    Methods     []string `json:"methods,omitempty"`
    Hosts       []string `json:"hosts,omitempty"`
    Paths       []string `json:"paths,omitempty"`
    Headers     map[string][]string `json:"headers,omitempty"`
    StripPath   bool     `json:"strip_path"`
    ServiceID   string   `json:"service_id"`
    Plugins     []string `json:"plugins,omitempty"`
}

// Plugin represents a Kong plugin
type Plugin struct {
    ID        string                 `json:"id"`
    Name      string                 `json:"name"`
    Config    map[string]any `json:"config"`
    Enabled   bool                   `json:"enabled"`
    ServiceID string                 `json:"service_id,omitempty"`
    RouteID   string                 `json:"route_id,omitempty"`
    ConsumerID string               `json:"consumer_id,omitempty"`
    Protocols []string               `json:"protocols"`
    Priority  int                    `json:"priority"`
}

// HandleRequest processes an incoming request through plugin chain
func (g *KongGateway) HandleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Match route
    route, service, err := g.router.Match(r)
    if err != nil {
        http.Error(w, "Route not found", http.StatusNotFound)
        return
    }

    // Build plugin chain for this request
    plugins := g.pluginChain.GetPlugins(route, service)

    // Create Kong context
    kongCtx := &KongContext{
        Route:    route,
        Service:  service,
        Request:  r,
        Response: &ResponseCapture{ResponseWriter: w},
    }

    // Execute access phase plugins
    for _, plugin := range plugins {
        if !plugin.Access(kongCtx) {
            return // Plugin short-circuited
        }
    }

    // Proxy to upstream
    upstream := g.upstreams[service.Host]
    target := upstream.NextTarget()

    proxyReq := g.buildProxyRequest(ctx, r, service, target)

    // Execute pre-proxy plugins
    for _, plugin := range plugins {
        plugin.PreProxy(kongCtx, proxyReq)
    }

    // Send request to upstream
    resp, err := g.doProxy(ctx, proxyReq)
    if err != nil {
        http.Error(w, "Upstream error", http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    kongCtx.UpstreamResponse = resp

    // Execute response phase plugins
    for _, plugin := range plugins {
        plugin.Response(kongCtx)
    }

    // Copy response to client
    g.copyResponse(w, resp)

    // Execute log phase plugins (async)
    go func() {
        for _, plugin := range plugins {
            plugin.Log(kongCtx)
        }
    }()
}
```

### AWS API Gateway: Serverless API Management

AWS API Gateway patterns:

```go
// AWS API Gateway-style serverless API management
package awsgateway

import (
    "context"
    "encoding/json"
)

// APIGateway manages REST and WebSocket APIs
type APIGateway struct {
    restAPIs      map[string]*RestAPI
    websocketAPIs map[string]*WebSocketAPI
    lambdaInvoker *LambdaInvoker
    authorizers   map[string]*Authorizer
    usagePlans    map[string]*UsagePlan
}

// RestAPI represents an API Gateway REST API
type RestAPI struct {
    ID            string                `json:"id"`
    Name          string                `json:"name"`
    Description   string                `json:"description"`
    Version       string                `json:"version"`
    EndpointType  string                `json:"endpointType"` // EDGE, REGIONAL, PRIVATE
    Resources     map[string]*Resource  `json:"resources"`
    Stages        map[string]*Stage     `json:"stages"`
    Models        map[string]*Model     `json:"models"`
}

// Resource represents an API resource
type Resource struct {
    ID           string            `json:"id"`
    Path         string            `json:"path"`
    PathPart     string            `json:"pathPart"`
    ParentID     string            `json:"parentId,omitempty"`
    Methods      map[string]*Method `json:"methods"`
}

// Method defines an HTTP method on a resource
type Method struct {
    HttpMethod         string                 `json:"httpMethod"`
    AuthorizationType  string                 `json:"authorizationType"` // NONE, AWS_IAM, CUSTOM, COGNITO
    AuthorizerID       string                 `json:"authorizerId,omitempty"`
    ApiKeyRequired     bool                   `json:"apiKeyRequired"`
    RequestParameters  map[string]bool        `json:"requestParameters,omitempty"`
    RequestModels      map[string]string      `json:"requestModels,omitempty"`
    Integration        *Integration           `json:"integration"`
    MethodResponses    map[string]*MethodResponse `json:"methodResponses"`
}

// Integration connects a method to backend
type Integration struct {
    Type                  string            `json:"type"` // AWS_PROXY, AWS, HTTP_PROXY, HTTP, MOCK
    HttpMethod            string            `json:"httpMethod,omitempty"`
    Uri                   string            `json:"uri"`
    ConnectionType        string            `json:"connectionType,omitempty"`
    RequestParameters     map[string]string `json:"requestParameters,omitempty"`
    RequestTemplates      map[string]string `json:"requestTemplates,omitempty"`
    IntegrationResponses  map[string]*IntegrationResponse `json:"integrationResponses,omitempty"`
}

// InvokeLambdaProxy handles AWS_PROXY integration
func (g *APIGateway) InvokeLambdaProxy(ctx context.Context, apiID, resourcePath, httpMethod string, event *APIGatewayProxyRequest) (*APIGatewayProxyResponse, error) {
    // Get API and resource
    api := g.restAPIs[apiID]
    resource := api.FindResource(resourcePath)
    method := resource.Methods[httpMethod]

    // Check authorization
    if method.AuthorizationType != "NONE" {
        if err := g.authorize(ctx, method, event); err != nil {
            return &APIGatewayProxyResponse{
                StatusCode: 401,
                Body:       `{"message":"Unauthorized"}`,
            }, nil
        }
    }

    // Check API key if required
    if method.ApiKeyRequired {
        if err := g.validateAPIKey(ctx, event.Headers["x-api-key"]); err != nil {
            return &APIGatewayProxyResponse{
                StatusCode: 403,
                Body:       `{"message":"Forbidden"}`,
            }, nil
        }
    }

    // Invoke Lambda
    lambdaARN := method.Integration.Uri
    payload, _ := json.Marshal(event)

    result, err := g.lambdaInvoker.Invoke(ctx, lambdaARN, payload)
    if err != nil {
        return &APIGatewayProxyResponse{
            StatusCode: 502,
            Body:       `{"message":"Internal server error"}`,
        }, nil
    }

    var response APIGatewayProxyResponse
    json.Unmarshal(result, &response)

    return &response, nil
}
```

### Netflix Zuul: Dynamic Routing Gateway

Netflix's Zuul gateway architecture:

```go
// Netflix Zuul-style dynamic routing gateway
package zuul

import (
    "context"
    "net/http"
    "sync"
)

// ZuulGateway handles dynamic routing with filters
type ZuulGateway struct {
    filterChain     *FilterChain
    discoveryClient *EurekaClient
    routeLocator    *RouteLocator
    ribbonClient    *RibbonLoadBalancer
    hystrixBreaker  *HystrixBreaker
}

// Filter phases in Zuul
type FilterPhase string

const (
    PreFilter   FilterPhase = "pre"
    RouteFilter FilterPhase = "route"
    PostFilter  FilterPhase = "post"
    ErrorFilter FilterPhase = "error"
)

// ZuulFilter interface for request/response processing
type ZuulFilter interface {
    FilterType() FilterPhase
    FilterOrder() int
    ShouldFilter(ctx *RequestContext) bool
    Run(ctx *RequestContext) error
}

// RequestContext carries request state through filter chain
type RequestContext struct {
    Request         *http.Request
    Response        http.ResponseWriter
    RouteHost       string
    ServiceID       string
    RequestURI      string
    ResponseStatus  int
    ResponseBody    []byte
    Throwable       error
    DebugRouting    bool
    DebugRequest    bool
    Data            sync.Map
}

// HandleRequest processes request through filter chain
func (g *ZuulGateway) HandleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := &RequestContext{
        Request:  r,
        Response: w,
    }

    // Pre-filters
    if err := g.runFilters(ctx, PreFilter); err != nil {
        g.runFilters(ctx, ErrorFilter)
        return
    }

    // Route filters (actual proxying)
    if err := g.runFilters(ctx, RouteFilter); err != nil {
        g.runFilters(ctx, ErrorFilter)
        return
    }

    // Post-filters
    g.runFilters(ctx, PostFilter)
}

// runFilters executes all filters of a given type
func (g *ZuulGateway) runFilters(ctx *RequestContext, phase FilterPhase) error {
    filters := g.filterChain.GetFilters(phase)

    for _, filter := range filters {
        if !filter.ShouldFilter(ctx) {
            continue
        }

        if err := filter.Run(ctx); err != nil {
            ctx.Throwable = err
            return err
        }
    }

    return nil
}

// ServiceDiscoveryFilter resolves service IDs to hosts
type ServiceDiscoveryFilter struct {
    discoveryClient *EurekaClient
}

func (f *ServiceDiscoveryFilter) FilterType() FilterPhase { return PreFilter }
func (f *ServiceDiscoveryFilter) FilterOrder() int        { return 10 }
func (f *ServiceDiscoveryFilter) ShouldFilter(ctx *RequestContext) bool { return true }

func (f *ServiceDiscoveryFilter) Run(ctx *RequestContext) error {
    // Extract service ID from path
    serviceID := extractServiceID(ctx.Request.URL.Path)

    // Lookup in Eureka
    instances, err := f.discoveryClient.GetInstances(serviceID)
    if err != nil || len(instances) == 0 {
        return ErrServiceNotFound
    }

    ctx.ServiceID = serviceID
    ctx.Data.Store("instances", instances)

    return nil
}
```

### Envoy: Cloud-Native Proxy

Envoy's xDS dynamic configuration:

```go
// Envoy-style xDS configuration service
package envoy

import (
    "context"
    "sync"
)

// XDSServer provides Envoy xDS APIs
type XDSServer struct {
    clusters  map[string]*Cluster
    listeners map[string]*Listener
    routes    map[string]*RouteConfiguration
    endpoints map[string]*ClusterLoadAssignment
    mu        sync.RWMutex
    watchers  map[string][]chan *DiscoveryResponse
}

// Cluster represents an Envoy cluster (upstream)
type Cluster struct {
    Name                 string               `json:"name"`
    Type                 string               `json:"type"` // STATIC, STRICT_DNS, LOGICAL_DNS, EDS
    ConnectTimeout       string               `json:"connect_timeout"`
    LbPolicy             string               `json:"lb_policy"` // ROUND_ROBIN, LEAST_REQUEST, RING_HASH
    CircuitBreakers      *CircuitBreakers     `json:"circuit_breakers,omitempty"`
    HealthChecks         []*HealthCheck       `json:"health_checks,omitempty"`
    OutlierDetection     *OutlierDetection    `json:"outlier_detection,omitempty"`
}

// Listener represents an Envoy listener
type Listener struct {
    Name         string         `json:"name"`
    Address      *Address       `json:"address"`
    FilterChains []*FilterChain `json:"filter_chains"`
}

// StreamClusters implements CDS streaming
func (s *XDSServer) StreamClusters(ctx context.Context, req *DiscoveryRequest, stream ClusterStream) error {
    // Get initial clusters
    s.mu.RLock()
    clusters := make([]*Cluster, 0, len(s.clusters))
    for _, c := range s.clusters {
        clusters = append(clusters, c)
    }
    s.mu.RUnlock()

    // Send initial response
    response := &DiscoveryResponse{
        TypeUrl:   "type.googleapis.com/envoy.config.cluster.v3.Cluster",
        Resources: clustersToAny(clusters),
        Nonce:     generateNonce(),
    }

    if err := stream.Send(response); err != nil {
        return err
    }

    // Watch for updates
    updates := make(chan *DiscoveryResponse, 10)
    s.mu.Lock()
    s.watchers["clusters"] = append(s.watchers["clusters"], updates)
    s.mu.Unlock()

    defer func() {
        s.mu.Lock()
        // Remove watcher
        s.mu.Unlock()
    }()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case update := <-updates:
            if err := stream.Send(update); err != nil {
                return err
            }
        }
    }
}
```

### Key Takeaways from Industry Leaders

| Platform | Key Innovation | Scale |
|----------|---------------|-------|
| Kong | Plugin ecosystem, declarative config | Billions of requests |
| AWS API Gateway | Serverless, Lambda integration | Managed service |
| Netflix Zuul | Dynamic routing, filter chain | Netflix traffic |
| Envoy | xDS APIs, cloud-native | CNCF standard |

---
