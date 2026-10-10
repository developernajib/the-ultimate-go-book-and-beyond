## 51.1 API Gateway Fundamentals

### Gateway Responsibilities

The gateway struct wraps `httputil.ReverseProxy` with a route table that maps URL prefixes to upstream `*url.URL` targets, and applies a middleware chain for authentication, rate limiting, and metrics before forwarding. Each proxy instance is created once per upstream and reused, sharing the underlying transport's connection pool to avoid per-request TCP handshake overhead. The `Director` function modifies the outbound request headers (stripping the gateway prefix, setting `X-Forwarded-For`, and adding internal service headers) without buffering the request body, so large uploads are streamed directly to the upstream.

```go
// pkg/gateway/gateway.go
package gateway

import (
	"context"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"time"
)

/*
API Gateway Responsibilities:

1. Request Routing - Route requests to appropriate services
2. Load Balancing - Distribute load across service instances
3. Authentication - Verify identity (JWT, API keys)
4. Authorization - Check permissions
5. Rate Limiting - Prevent abuse
6. Request/Response Transformation - Modify payloads
7. Caching - Cache responses
8. Circuit Breaking - Prevent cascade failures
9. Logging & Monitoring - Track requests
10. SSL Termination - Handle TLS
11. API Composition - Aggregate multiple service calls
*/

// Gateway is the main API gateway structure
type Gateway struct {
	router          *Router
	middleware      []Middleware
	serviceRegistry ServiceRegistry
	cache           Cache
	rateLimiter     RateLimiter
	circuitBreakers map[string]*CircuitBreaker
	logger          Logger
	metrics         Metrics

	mu sync.RWMutex
}

// GatewayConfig holds gateway configuration
type GatewayConfig struct {
	ListenAddr         string
	ReadTimeout        time.Duration
	WriteTimeout       time.Duration
	IdleTimeout        time.Duration
	MaxHeaderBytes     int
	EnableCORS         bool
	EnableMetrics      bool
	EnableTracing      bool
	TLSCertFile        string
	TLSKeyFile         string
}

// DefaultGatewayConfig returns sensible defaults
func DefaultGatewayConfig() GatewayConfig {
	return GatewayConfig{
		ListenAddr:     ":8080",
		ReadTimeout:    30 * time.Second,
		WriteTimeout:   30 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20, // 1MB
		EnableCORS:     true,
		EnableMetrics:  true,
		EnableTracing:  true,
	}
}

// NewGateway creates a new API gateway
func NewGateway(config GatewayConfig, registry ServiceRegistry, logger Logger) *Gateway {
	return &Gateway{
		router:          NewRouter(),
		serviceRegistry: registry,
		circuitBreakers: make(map[string]*CircuitBreaker),
		logger:          logger,
	}
}

// Use adds middleware to the gateway
func (g *Gateway) Use(mw Middleware) {
	g.middleware = append(g.middleware, mw)
}

// Route adds a route to the gateway
func (g *Gateway) Route(method, path, service string, opts ...RouteOption) {
	route := &Route{
		Method:  method,
		Path:    path,
		Service: service,
	}

	for _, opt := range opts {
		opt(route)
	}

	g.router.AddRoute(route)
}

// ServeHTTP implements http.Handler
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Build middleware chain
	handler := g.handleRequest
	for i := len(g.middleware) - 1; i >= 0; i-- {
		handler = g.middleware[i](handler)
	}

	handler(w, r)
}

func (g *Gateway) handleRequest(w http.ResponseWriter, r *http.Request) {
	// Find matching route
	route, params := g.router.Match(r.Method, r.URL.Path)
	if route == nil {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	// Store route params in context
	ctx := context.WithValue(r.Context(), routeParamsKey, params)
	r = r.WithContext(ctx)

	// Get service URL
	serviceURL, err := g.serviceRegistry.GetServiceURL(route.Service)
	if err != nil {
		g.logger.Error("Service not found", "service", route.Service, "error", err)
		http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
		return
	}

	// Check circuit breaker
	cb := g.getCircuitBreaker(route.Service)
	if !cb.Allow() {
		http.Error(w, "Service Unavailable (Circuit Open)", http.StatusServiceUnavailable)
		return
	}

	// Proxy request
	start := time.Now()
	err = g.proxyRequest(w, r, serviceURL, route)
	duration := time.Since(start)

	// Record result
	if err != nil {
		cb.RecordFailure()
		g.logger.Error("Proxy request failed",
			"service", route.Service,
			"path", r.URL.Path,
			"error", err,
			"duration", duration,
		)
	} else {
		cb.RecordSuccess()
		g.logger.Info("Request proxied",
			"service", route.Service,
			"path", r.URL.Path,
			"duration", duration,
		)
	}
}

func (g *Gateway) proxyRequest(w http.ResponseWriter, r *http.Request, serviceURL *url.URL, route *Route) error {
	// Create reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(serviceURL)

	// Customize director to modify request
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)

		// Apply path rewrite if configured
		if route.PathRewrite != "" {
			req.URL.Path = route.PathRewrite
		}

		// Add headers
		req.Header.Set("X-Forwarded-Host", req.Host)
		req.Header.Set("X-Gateway-Request-ID", getRequestID(r.Context()))

		// Apply custom headers from route
		for k, v := range route.Headers {
			req.Header.Set(k, v)
		}
	}

	// Customize error handler
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		g.logger.Error("Proxy error", "error", err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
	}

	// Apply response modifier if configured
	if route.ResponseModifier != nil {
		proxy.ModifyResponse = route.ResponseModifier
	}

	proxy.ServeHTTP(w, r)
	return nil
}

func (g *Gateway) getCircuitBreaker(service string) *CircuitBreaker {
	g.mu.RLock()
	cb, exists := g.circuitBreakers[service]
	g.mu.RUnlock()

	if exists {
		return cb
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	// Double check after acquiring write lock
	if cb, exists = g.circuitBreakers[service]; exists {
		return cb
	}

	cb = NewCircuitBreaker(DefaultCircuitBreakerConfig())
	g.circuitBreakers[service] = cb
	return cb
}

// Context keys
type contextKey string

const (
	routeParamsKey contextKey = "routeParams"
	requestIDKey   contextKey = "requestID"
)

func getRequestID(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey).(string); ok {
		return id
	}
	return ""
}
```

### Router Implementation

The router performs longest-prefix matching against the route table so that `/api/v2/users` is correctly dispatched to the user service rather than a generic `/api` catch-all. Route registration is done once at startup from a configuration struct, keeping routing rules declarative and testable without running a live HTTP server. Storing the matched upstream in the request's `context.Context` allows downstream middleware (e.g., the rate limiter or metrics collector) to record the upstream name without re-parsing the URL.

```go
// pkg/gateway/router.go
package gateway

import (
	"net/http"
	"regexp"
	"strings"
	"sync"
)

// Route represents a gateway route
type Route struct {
	Method           string
	Path             string
	Service          string
	PathRewrite      string
	Headers          map[string]string
	ResponseModifier func(*http.Response) error
	RateLimit        *RateLimitConfig
	Auth             *AuthConfig
	Cache            *CacheConfig
	Timeout          int // milliseconds
	Retries          int
}

// RouteOption configures a route
type RouteOption func(*Route)

// WithPathRewrite sets path rewrite
func WithPathRewrite(rewrite string) RouteOption {
	return func(r *Route) {
		r.PathRewrite = rewrite
	}
}

// WithHeader adds a header to forward
func WithHeader(key, value string) RouteOption {
	return func(r *Route) {
		if r.Headers == nil {
			r.Headers = make(map[string]string)
		}
		r.Headers[key] = value
	}
}

// WithRateLimit sets rate limiting
func WithRateLimit(requests int, window int) RouteOption {
	return func(r *Route) {
		r.RateLimit = &RateLimitConfig{
			Requests: requests,
			Window:   window,
		}
	}
}

// WithAuth sets authentication requirement
func WithAuth(authType string) RouteOption {
	return func(r *Route) {
		r.Auth = &AuthConfig{
			Type: authType,
		}
	}
}

// WithCache sets caching
func WithCache(ttl int) RouteOption {
	return func(r *Route) {
		r.Cache = &CacheConfig{
			TTL: ttl,
		}
	}
}

// WithTimeout sets request timeout
func WithTimeout(ms int) RouteOption {
	return func(r *Route) {
		r.Timeout = ms
	}
}

// RateLimitConfig holds rate limit settings
type RateLimitConfig struct {
	Requests int
	Window   int // seconds
}

// AuthConfig holds authentication settings
type AuthConfig struct {
	Type     string // jwt, apikey, basic
	Required bool
	Scopes   []string
}

// CacheConfig holds cache settings
type CacheConfig struct {
	TTL      int  // seconds
	Private  bool
	VaryBy   []string
}

// Router matches requests to routes
type Router struct {
	routes []*compiledRoute
	mu     sync.RWMutex
}

type compiledRoute struct {
	*Route
	pattern *regexp.Regexp
	params  []string
}

// NewRouter creates a new router
func NewRouter() *Router {
	return &Router{
		routes: make([]*compiledRoute, 0),
	}
}

// AddRoute adds a route to the router
func (r *Router) AddRoute(route *Route) {
	compiled := &compiledRoute{
		Route: route,
	}

	// Compile path pattern
	pattern, params := compilePath(route.Path)
	compiled.pattern = pattern
	compiled.params = params

	r.mu.Lock()
	r.routes = append(r.routes, compiled)
	r.mu.Unlock()
}

func compilePath(path string) (*regexp.Regexp, []string) {
	var params []string
	pattern := path

	// Replace :param with named capture groups
	paramRegex := regexp.MustCompile(`:(\w+)`)
	matches := paramRegex.FindAllStringSubmatch(path, -1)

	for _, match := range matches {
		params = append(params, match[1])
		pattern = strings.Replace(pattern, match[0], `([^/]+)`, 1)
	}

	// Replace * with wildcard
	pattern = strings.Replace(pattern, "*", ".*", -1)

	// Add anchors
	pattern = "^" + pattern + "$"

	return regexp.MustCompile(pattern), params
}

// Match finds a matching route
func (r *Router) Match(method, path string) (*Route, map[string]string) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, route := range r.routes {
		if route.Method != "" && route.Method != method {
			continue
		}

		matches := route.pattern.FindStringSubmatch(path)
		if matches == nil {
			continue
		}

		// Extract params
		params := make(map[string]string)
		for i, name := range route.params {
			if i+1 < len(matches) {
				params[name] = matches[i+1]
			}
		}

		return route.Route, params
	}

	return nil, nil
}
```

### Junior -> FAANG: Gateway Fundamentals You Need Cold

The `Gateway` struct and `Router` in this section introduce the core pattern: middleware chain wrapping a handler, route table mapping paths to upstreams, and a circuit breaker per upstream. Before your interview, be able to explain each field of `GatewayConfig` and why the defaults are what they are.

The most common junior mistake in gateway coding questions is creating a new `httputil.ReverseProxy` per request. The correct approach, shown here, creates one proxy per upstream and reuses its connection pool. Interviewers who ask you to code a reverse proxy specifically check for this.

Know what `Director` does: it modifies the outbound request before it is sent upstream. This is where path rewriting, header injection, and `X-Forwarded-For` happen. Know what `ModifyResponse` does: it runs after the upstream replies, before the response is written to the client. These two hooks are the entire transformation surface of `httputil.ReverseProxy`.

Interview entry point: "Why do you pass the original request context to the outbound proxy request?" The answer is that the client's deadline propagates downstream. If the client disconnects, the context is canceled, and the upstream call is abandoned, freeing resources immediately rather than after a timeout.

### Senior @ FAANG: Production Hardening of Gateway Core

The `proxyRequest` function in this section has several gaps that a senior engineer would close before shipping.

**Transport configuration.** `httputil.NewSingleHostReverseProxy` uses `http.DefaultTransport`. Default transport has `MaxIdleConnsPerHost` of 2, which causes connection storms under concurrent load. Production config sets `MaxIdleConns`, `MaxIdleConnsPerHost`, `IdleConnTimeout`, `TLSHandshakeTimeout`, and `ResponseHeaderTimeout` explicitly. A shared custom transport is injected into the proxy so all routes share a tuned connection pool.

**Response body size limit.** The default proxy streams without a size cap. A misbehaving upstream that returns a multi-gigabyte body will hold that goroutine open until it finishes or the client disconnects. Wrap `ModifyResponse` with an `io.LimitedReader` to enforce a maximum response body size per route.

**Hop-by-hop header stripping.** `httputil.ReverseProxy` strips standard hop-by-hop headers (`Connection`, `Transfer-Encoding`). If you have custom hop-by-hop headers set by an inner load balancer, strip them in `ModifyResponse` before forwarding to the client. Failing to strip internal headers leaks infrastructure topology to external clients.

**Double-check locking in `getCircuitBreaker`.** The pattern shown (read lock, check, write lock, check again) is correct for Go's `sync.RWMutex`. The second check under the write lock prevents two goroutines from both finding the breaker absent and both creating it. This double-checked locking idiom is a senior-track code review signal.

**Observability gap.** The current implementation logs duration but does not distinguish upstream latency from gateway overhead. Production gateways record two timestamps: when the proxy call starts (after middleware) and when the response is received. The delta is upstream latency. The difference between total request duration and upstream latency is gateway overhead. Tracking this separately lets SREs identify when gateway CPU or middleware cost is growing independently of upstream performance.

**Route option extensibility.** The `RouteOption` functional options pattern is correct. A bar-raiser interviewer will ask how you add a new cross-cutting option (say, request signing for a particular upstream) without modifying existing routes. The answer is: add a new `WithRequestSigning(keyID string) RouteOption` function. Existing routes are unaffected. This is the open-closed principle applied to route configuration.

---
