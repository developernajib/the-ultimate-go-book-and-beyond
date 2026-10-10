## 46.7 Company Case Studies

### Google Cloud APIs: The Transcoding Pattern gRPC-Gateway Democratized

Google Cloud exposes its gRPC APIs to REST clients through HTTP/JSON transcoding while staying gRPC internally, and grpc-gateway (a community project under grpc-ecosystem) brings that same pattern to everyone else. Their API Improvement Proposals (AIPs) at `google.aip.dev` codify patterns for resource naming, pagination, long-running operations, and field masks that apply directly to any gRPC-Gateway deployment.

```go
// Google's AIP (API Improvement Proposals) pattern
// https://google.aip.dev/

package gateway

import (
    "context"
    "encoding/base64"
    "fmt"
    "net/http"
    "strconv"
    "strings"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/genproto/googleapis/api/httpbody"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/fieldmaskpb"
)

// Google uses Long-Running Operations (LRO) for async APIs
// The gateway exposes these as standard REST endpoints

// LRO response wrapper (Google Cloud pattern)
type Operation struct {
    Name     string                 `json:"name"`
    Done     bool                   `json:"done"`
    Metadata map[string]any `json:"metadata,omitempty"`
    Result   any            `json:"result,omitempty"`
    Error    *Status                `json:"error,omitempty"`
}

type Status struct {
    Code    int                      `json:"code"`
    Message string                   `json:"message"`
    Details []map[string]any `json:"details,omitempty"`
}

// Google-style resource name parsing
// Format: "projects/{project}/locations/{location}/resources/{resource}"
func ParseResourceName(name string) (map[string]string, error) {
    parts := strings.Split(name, "/")
    if len(parts)%2 != 0 {
        return nil, status.Error(codes.InvalidArgument, "invalid resource name format")
    }

    result := make(map[string]string)
    for i := 0; i < len(parts); i += 2 {
        result[parts[i]] = parts[i+1]
    }
    return result, nil
}

// Google uses FieldMask for partial updates
// This interceptor validates field masks
func FieldMaskValidator(ctx context.Context, req any) error {
    if updater, ok := req.(interface{ GetUpdateMask() *fieldmaskpb.FieldMask }); ok {
        mask := updater.GetUpdateMask()
        if mask == nil || len(mask.GetPaths()) == 0 {
            return status.Error(codes.InvalidArgument, "update_mask is required")
        }

        // Validate paths against allowed fields
        allowed := map[string]bool{
            "display_name": true,
            "labels":       true,
            "config":       true,
        }

        for _, path := range mask.GetPaths() {
            if !allowed[path] {
                return status.Errorf(codes.InvalidArgument,
                    "field %q cannot be updated", path)
            }
        }
    }
    return nil
}

// Google returns raw bytes for file downloads
// This handler supports the HttpBody response type
func FileDownloadHandler(ctx context.Context, w http.ResponseWriter, resp *httpbody.HttpBody) error {
    w.Header().Set("Content-Type", resp.GetContentType())
    w.Header().Set("Content-Disposition", "attachment")
    _, err := w.Write(resp.GetData())
    return err
}

// Google-style pagination token encoding
// Cursor is base64-encoded and opaque to clients
func EncodePaginationToken(lastID string, offset int64) string {
    token := fmt.Sprintf("%s:%d", lastID, offset)
    return base64.StdEncoding.EncodeToString([]byte(token))
}

func DecodePaginationToken(token string) (string, int64, error) {
    decoded, err := base64.StdEncoding.DecodeString(token)
    if err != nil {
        return "", 0, status.Error(codes.InvalidArgument, "invalid page token")
    }

    parts := strings.Split(string(decoded), ":")
    if len(parts) != 2 {
        return "", 0, status.Error(codes.InvalidArgument, "malformed page token")
    }

    offset, err := strconv.ParseInt(parts[1], 10, 64)
    if err != nil {
        return "", 0, status.Error(codes.InvalidArgument, "invalid page token offset")
    }

    return parts[0], offset, nil
}
```

### The Stripe-Style Idempotent Gateway

Stripe's public API popularized gateway-level idempotency: clients include an `Idempotency-Key` header on mutating requests, and the gateway replays the original response on retries instead of executing the operation twice. Bringing that behavior to a dual-protocol service, so REST and gRPC callers get identical replay semantics, is a gateway-middleware job. The following implementation shows this pattern applied to a gRPC-Gateway middleware.

```go
// Stripe-style idempotent gateway
package gateway

import (
    "bytes"
    "context"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "strings"
    "sync"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// IdempotencyStore tracks request outcomes for replay
type IdempotencyStore interface {
    Get(ctx context.Context, key string) (*IdempotentResult, bool)
    Set(ctx context.Context, key string, result *IdempotentResult, ttl time.Duration) error
    Lock(ctx context.Context, key string) (unlock func(), err error)
}

type IdempotentResult struct {
    StatusCode int               `json:"status_code"`
    Headers    map[string]string `json:"headers"`
    Body       []byte            `json:"body"`
    CreatedAt  time.Time         `json:"created_at"`
}

// IdempotencyMiddleware implements Stripe-style idempotency
func IdempotencyMiddleware(store IdempotencyStore) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Only POST/PUT/DELETE are idempotent
            if r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodDelete {
                next.ServeHTTP(w, r)
                return
            }

            key := r.Header.Get("Idempotency-Key")
            if key == "" {
                next.ServeHTTP(w, r)
                return
            }

            // Generate fingerprint including method, path, and body hash
            fingerprint := generateFingerprint(r, key)

            // Check for existing result
            if result, found := store.Get(r.Context(), fingerprint); found {
                // Replay the stored response
                for k, v := range result.Headers {
                    w.Header().Set(k, v)
                }
                w.Header().Set("Idempotent-Replayed", "true")
                w.WriteHeader(result.StatusCode)
                w.Write(result.Body)
                return
            }

            // Lock to prevent concurrent execution with same key
            unlock, err := store.Lock(r.Context(), fingerprint)
            if err != nil {
                http.Error(w, "idempotency conflict", http.StatusConflict)
                return
            }
            defer unlock()

            // Double-check after acquiring lock
            if result, found := store.Get(r.Context(), fingerprint); found {
                for k, v := range result.Headers {
                    w.Header().Set(k, v)
                }
                w.Header().Set("Idempotent-Replayed", "true")
                w.WriteHeader(result.StatusCode)
                w.Write(result.Body)
                return
            }

            // Execute and capture response
            recorder := &responseRecorder{
                ResponseWriter: w,
                statusCode:     http.StatusOK,
            }
            next.ServeHTTP(recorder, r)

            // Store result (only for successful or idempotent-safe errors)
            if recorder.statusCode < 500 {
                store.Set(r.Context(), fingerprint, &IdempotentResult{
                    StatusCode: recorder.statusCode,
                    Headers:    extractHeaders(recorder.Header()),
                    Body:       recorder.body.Bytes(),
                    CreatedAt:  time.Now(),
                }, 24*time.Hour)
            }
        })
    }
}

func generateFingerprint(r *http.Request, key string) string {
    h := sha256.New()
    h.Write([]byte(key))
    h.Write([]byte(r.Method))
    h.Write([]byte(r.URL.Path))
    // Include body hash for mutation detection
    if r.Body != nil {
        body, _ := io.ReadAll(r.Body)
        r.Body = io.NopCloser(bytes.NewReader(body))
        h.Write(body)
    }
    return hex.EncodeToString(h.Sum(nil))
}

func extractHeaders(header http.Header) map[string]string {
    result := make(map[string]string)
    for k, v := range header {
        if len(v) > 0 {
            result[k] = v[0]
        }
    }
    return result
}

type responseRecorder struct {
    http.ResponseWriter
    statusCode int
    body       bytes.Buffer
}

func (r *responseRecorder) WriteHeader(code int) {
    r.statusCode = code
    r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
    r.body.Write(b)
    return r.ResponseWriter.Write(b)
}

// Stripe-style versioned error responses
type StripeError struct {
    Type    string `json:"type"`
    Code    string `json:"code,omitempty"`
    Message string `json:"message"`
    Param   string `json:"param,omitempty"`
    DocURL  string `json:"doc_url,omitempty"`
}

func StripeErrorHandler(ctx context.Context, mux *runtime.ServeMux,
    marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {

    st := status.Convert(err)
    httpStatus := runtime.HTTPStatusFromCode(st.Code())

    stripeErr := StripeError{
        Type:    mapCodeToStripeType(st.Code()),
        Message: st.Message(),
    }

    // Add documentation URL
    stripeErr.DocURL = fmt.Sprintf("https://docs.example.com/errors#%s",
        strings.ToLower(st.Code().String()))

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpStatus)
    json.NewEncoder(w).Encode(map[string]any{
        "error": stripeErr,
    })
}

func mapCodeToStripeType(code codes.Code) string {
    switch code {
    case codes.InvalidArgument:
        return "invalid_request_error"
    case codes.Unauthenticated:
        return "authentication_error"
    case codes.PermissionDenied:
        return "authorization_error"
    case codes.NotFound:
        return "invalid_request_error"
    case codes.ResourceExhausted:
        return "rate_limit_error"
    default:
        return "api_error"
    }
}
```

### HashiCorp: Gateway with Service Discovery

HashiCorp integrates Consul service discovery with gRPC-Gateway for dynamic backend routing. Instead of hard-coding backend addresses, the gateway resolves service names through Consul's health API, updating its connection pool as instances appear and disappear. This pattern suits deployments where backend services scale independently and register themselves with a service catalog.

```go
// HashiCorp-style gateway with Consul integration
package gateway

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "github.com/hashicorp/consul/api"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/resolver"
)

// ConsulResolver implements gRPC resolver for Consul service discovery
type ConsulResolver struct {
    client      *api.Client
    serviceName string
    cc          resolver.ClientConn
    ctx         context.Context
    cancel      context.CancelFunc
    logger      *slog.Logger
}

func NewConsulResolverBuilder(client *api.Client) resolver.Builder {
    return &consulResolverBuilder{client: client}
}

type consulResolverBuilder struct {
    client *api.Client
}

func (b *consulResolverBuilder) Build(target resolver.Target, cc resolver.ClientConn,
    opts resolver.BuildOptions) (resolver.Resolver, error) {

    ctx, cancel := context.WithCancel(context.Background())
    r := &ConsulResolver{
        client:      b.client,
        serviceName: target.Endpoint(),
        cc:          cc,
        ctx:         ctx,
        cancel:      cancel,
        logger:      slog.Default(),
    }

    go r.watch()
    return r, nil
}

func (b *consulResolverBuilder) Scheme() string {
    return "consul"
}

func (r *ConsulResolver) watch() {
    var lastIndex uint64

    for {
        select {
        case <-r.ctx.Done():
            return
        default:
        }

        services, meta, err := r.client.Health().Service(
            r.serviceName, "", true, &api.QueryOptions{
                WaitIndex: lastIndex,
                WaitTime:  30 * time.Second,
            },
        )

        if err != nil {
            r.logger.Error("consul watch error", "error", err)
            time.Sleep(5 * time.Second)
            continue
        }

        lastIndex = meta.LastIndex

        addrs := make([]resolver.Address, 0, len(services))
        for _, svc := range services {
            addr := fmt.Sprintf("%s:%d", svc.Service.Address, svc.Service.Port)
            addrs = append(addrs, resolver.Address{
                Addr: addr,
                ServerName: r.serviceName,
                Attributes: nil,
            })
        }

        r.cc.UpdateState(resolver.State{Addresses: addrs})
        r.logger.Info("updated backends",
            "service", r.serviceName,
            "count", len(addrs))
    }
}

func (r *ConsulResolver) ResolveNow(opts resolver.ResolveNowOptions) {}
func (r *ConsulResolver) Close() { r.cancel() }

// DynamicGateway routes to discovered backends
type DynamicGateway struct {
    consulClient *api.Client
    mux          *runtime.ServeMux
    connections  map[string]*grpc.ClientConn
    connMu       sync.RWMutex
    logger       *slog.Logger
}

func NewDynamicGateway(consulAddr string) (*DynamicGateway, error) {
    client, err := api.NewClient(&api.Config{
        Address: consulAddr,
    })
    if err != nil {
        return nil, fmt.Errorf("consul client: %w", err)
    }

    // Register Consul resolver
    resolver.Register(NewConsulResolverBuilder(client))

    return &DynamicGateway{
        consulClient: client,
        mux:          runtime.NewServeMux(),
        connections:  make(map[string]*grpc.ClientConn),
        logger:       slog.Default(),
    }, nil
}

// RegisterService dynamically registers a gRPC service
func (g *DynamicGateway) RegisterService(ctx context.Context, serviceName string,
    registerFunc func(context.Context, *runtime.ServeMux, *grpc.ClientConn) error) error {

    g.connMu.Lock()
    defer g.connMu.Unlock()

    // Create connection using Consul resolver
    target := fmt.Sprintf("consul:///%s", serviceName)
    conn, err := grpc.NewClient(target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultServiceConfig(`{
            "loadBalancingPolicy": "round_robin",
            "healthCheckConfig": {
                "serviceName": ""
            }
        }`),
    )
    if err != nil {
        return fmt.Errorf("dial %s: %w", serviceName, err)
    }

    g.connections[serviceName] = conn

    // Register handler
    if err := registerFunc(ctx, g.mux, conn); err != nil {
        return fmt.Errorf("register %s: %w", serviceName, err)
    }

    g.logger.Info("registered service", "name", serviceName)
    return nil
}

// Health check endpoint with backend status
func (g *DynamicGateway) HealthHandler(w http.ResponseWriter, r *http.Request) {
    g.connMu.RLock()
    defer g.connMu.RUnlock()

    status := map[string]any{
        "status":   "healthy",
        "backends": make(map[string]string),
    }

    allHealthy := true
    for name, conn := range g.connections {
        state := conn.GetState().String()
        status["backends"].(map[string]string)[name] = state
        if state != "READY" {
            allHealthy = false
        }
    }

    if !allHealthy {
        status["status"] = "degraded"
    }

    w.Header().Set("Content-Type", "application/json")
    if !allHealthy {
        w.WriteHeader(http.StatusServiceUnavailable)
    }
    json.NewEncoder(w).Encode(status)
}

func (g *DynamicGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    g.mux.ServeHTTP(w, r)
}
```

### Junior -> FAANG: What These Case Studies Actually Teach

The three case studies in this section (Google, Stripe, HashiCorp) are not just examples of gRPC-Gateway features. They demonstrate that mature engineering organizations treat API design and gateway infrastructure as long-term investments, not one-time implementations.

The Google AIP patterns (resource names, pagination tokens, field masks) exist because Google operates hundreds of APIs across thousands of teams. Without a common convention, each team would invent its own pagination scheme, its own error format, and its own resource naming style. The AIPs are the governance mechanism that prevents this. If you join a company with many internal APIs and no common conventions, proposing an AIP-inspired internal guideline is a high-impact contribution.

The Stripe idempotency pattern is the most directly applicable to first-job work. Mutating operations (POST, PUT, DELETE) that are exposed to unreliable networks (mobile clients, third-party integrations) must be idempotent. Without idempotency, a client that retries after a network timeout may create duplicate records. The `Idempotency-Key` pattern solves this at the gateway layer without requiring every backend handler to implement duplicate detection. When you design your first payment, order creation, or user registration endpoint, add idempotency support before the feature is shipped. Adding it after the fact requires backfilling keys for existing operations and migrating the storage schema.

The HashiCorp Consul resolver demonstrates why hard-coded backend addresses are wrong for any service that scales. Even if you start with a single backend instance, you will eventually need to roll out a new version without downtime, which requires at least two instances. A hard-coded address makes this impossible without restarting the gateway. The resolver pattern, whether Consul-based or Kubernetes-based, is the correct baseline.

Interview habit: for any system design question involving an API gateway, mention idempotency for mutating operations, service discovery for backend routing, and health aggregation for the gateway's health endpoint. These three topics consistently separate engineers who have built production gateways from those who have only read about them.

### Senior @ FAANG: Drawing Architectural Lessons from Each Case Study

**Google AIP and the cost of inconsistency.** The AIP patterns exist not because they are the best possible design in isolation but because they are the best design at scale across many teams and many years. The resource name format (`projects/{project}/resources/{resource}`) is verbose, but it is self-documenting and globally unique. The LRO (Long-Running Operation) pattern adds complexity, but it decouples the client's wait from the operation's duration in a way that survives process restarts and load balancer timeouts. The lesson for staff-level engineers is that API design decisions compound: a convention adopted by 5 teams becomes mandatory for the 50th team, and changing it requires migrating all 50.

**Stripe idempotency and the distributed systems guarantee.** The idempotency implementation in this section uses an in-process store with a mutex. In production, Stripe's idempotency store is distributed (likely Redis or a database) because idempotency guarantees must survive process restarts and hold across multiple gateway replicas. The lock-before-store pattern prevents concurrent duplicate requests from both proceeding: one wins the lock, executes, and stores, while the other waits for the lock, finds the result, and replays. The critical correctness property is that the lock must be held for the duration of the operation, not just during the lookup. If two requests race and both see "not found," both will execute. The distributed lock is what prevents this. At scale, the distributed lock becomes a contention point. Stripe's solution is a short lock timeout (reject concurrent duplicate requests with a 409) rather than waiting indefinitely.

**HashiCorp Consul and the gateway-as-a-service problem.** The `DynamicGateway` pattern shows a gateway that discovers its backends at runtime. This is architecturally correct for a shared gateway serving multiple teams. The governance question it does not answer is: who decides which services are registered with the shared gateway? In a large organization, a self-service registration model (any team can register any service) leads to undocumented endpoints, inconsistent error shapes, and security surprises. The correct model is a registration workflow that requires API review (does the proto annotation match the intended semantics? does the error handler conform to the platform standard?) before a service is admitted to the shared gateway. This registration workflow is a platform product, not a one-time setup.

**Cross-cutting lesson for L6/L7.** All three case studies share a pattern: a successful API infrastructure team builds primitives (AIP conventions, idempotency middleware, service discovery) that other teams use without thinking about them. The measure of success is that teams adopting the platform defaults get production-quality gateway behavior without doing any gateway-specific work. The failure mode is that the platform provides building blocks but no defaults, and every team assembles them differently. Staff-level work in the API gateway space is often about converting building blocks into opinionated defaults with good documentation and strong linting.

---
