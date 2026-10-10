## 48.7 Common Mistakes

### Mistake 1: Not Propagating Headers

When a Go service makes outbound HTTP calls without forwarding the incoming `traceparent` and `x-b3-*` headers, distributed traces appear as isolated single-hop spans in Jaeger or Zipkin, making it impossible to correlate a slow downstream call with the original user request. The fix extracts the trace context from the incoming request's context and injects it into every outbound request using the OpenTelemetry propagator, so the mesh sees a connected trace graph across all services.

```go
// WRONG: Making outbound calls without propagating trace context
func (s *Service) HandleRequest(w http.ResponseWriter, r *http.Request) {
    // Process request...

    // Call another service - TRACE CONTEXT IS LOST!
    req, _ := http.NewRequest("GET", "http://other-service/api", nil)
    resp, err := s.client.Do(req) // No headers propagated!
}

// CORRECT: Always propagate trace headers
func (s *Service) HandleRequestCorrect(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Process request...

    // Propagate all trace headers
    req, _ := http.NewRequestWithContext(ctx, "GET", "http://other-service/api", nil)

    // Copy trace headers
    for _, header := range []string{
        "x-request-id", "x-b3-traceid", "x-b3-spanid",
        "x-b3-parentspanid", "x-b3-sampled", "traceparent", "tracestate",
    } {
        if value := r.Header.Get(header); value != "" {
            req.Header.Set(header, value)
        }
    }

    resp, err := s.client.Do(req)
}

// BEST: Use OpenTelemetry propagator
func (s *Service) HandleRequestBest(w http.ResponseWriter, r *http.Request) {
    // Extract incoming context
    ctx := otel.GetTextMapPropagator().Extract(
        r.Context(),
        propagation.HeaderCarrier(r.Header),
    )

    // Create span for this handler
    ctx, span := s.tracer.Start(ctx, "HandleRequest")
    defer span.End()

    // Make outbound call with propagated context
    req, _ := http.NewRequestWithContext(ctx, "GET", "http://other-service/api", nil)
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

    resp, err := s.client.Do(req)
}
```

### Mistake 2: Ignoring Mesh Timeouts

When the Istio `VirtualService` enforces a 10-second timeout but the Go service sets a 30-second `http.Client` timeout, the sidecar will cancel the request at 10 seconds with a `504` while the Go goroutine continues blocking for up to 20 more seconds, wasting a goroutine and its associated resources. Application-side timeouts must always be shorter than mesh-configured timeouts so that Go's `context.DeadlineExceeded` fires first, allowing the service to return a well-formed error rather than receiving an opaque proxy response.

```go
// WRONG: Application timeout longer than mesh timeout
// Istio VirtualService has timeout: 10s
// But Go service has:

func (s *Service) CallWithTimeout(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second) // 30s > mesh 10s!
    defer cancel()

    resp, err := s.client.Call(ctx, req)
    if err != nil {
        // Error will be from mesh timeout (10s), not application
        // But application doesn't know the real cause
        return err
    }
    return nil
}

// CORRECT: Align timeouts with mesh configuration
func (s *Service) CallWithTimeoutCorrect(ctx context.Context) error {
    // Match mesh timeout (or slightly less for cleanup)
    meshTimeout := 10 * time.Second
    appTimeout := meshTimeout - 500*time.Millisecond

    ctx, cancel := context.WithTimeout(ctx, appTimeout)
    defer cancel()

    resp, err := s.client.Call(ctx, req)
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            // We know this is our timeout, not mesh
            return fmt.Errorf("application timeout after %v: %w", appTimeout, err)
        }
        return err
    }
    return nil
}

// BEST: Read timeout from environment/config that matches mesh
type Config struct {
    // These should match Istio VirtualService settings
    RequestTimeout    time.Duration `env:"REQUEST_TIMEOUT" default:"9s"`
    RetryAttempts     int           `env:"RETRY_ATTEMPTS" default:"2"`
    RetryPerTryTimeout time.Duration `env:"RETRY_PER_TRY_TIMEOUT" default:"3s"`
}
```

### Mistake 3: Hardcoding Service URLs

Hardcoding fully qualified Kubernetes DNS names (like `user-service.production.svc.cluster.local`) couples application code to the namespace, cluster, and port layout. When teams move services between namespaces, switch clusters, or apply Istio traffic management rules, every hardcoded URL breaks. Using short service names and environment variables lets the mesh's DNS resolution and traffic policies work correctly without code changes.

```go
// WRONG: Hardcoding full URLs
var (
    userServiceURL = "http://user-service.production.svc.cluster.local:8080"
    orderServiceURL = "http://order-service.production.svc.cluster.local:8080"
)

func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
    url := fmt.Sprintf("%s/users/%s", userServiceURL, id)
    // This breaks when:
    // - Namespace changes
    // - Service moves to different cluster
    // - Traffic management rules are applied
}

// CORRECT: Use Kubernetes service names
var (
    userServiceHost = "user-service"   // Just the service name
    orderServiceHost = "order-service"
)

func (s *Service) GetUserCorrect(ctx context.Context, id string) (*User, error) {
    // Mesh DNS resolves this correctly
    url := fmt.Sprintf("http://%s/users/%s", userServiceHost, id)
    // Works with:
    // - Namespace routing
    // - Traffic splitting
    // - Cross-cluster routing
}

// BEST: Use environment variables for full flexibility
type ServiceConfig struct {
    UserServiceHost  string `env:"USER_SERVICE_HOST" default:"user-service"`
    UserServicePort  int    `env:"USER_SERVICE_PORT" default:"80"`
    OrderServiceHost string `env:"ORDER_SERVICE_HOST" default:"order-service"`
    OrderServicePort int    `env:"ORDER_SERVICE_PORT" default:"80"`
}
```

### Mistake 4: Ignoring mTLS in Local Development

Branching on an `ISTIO_ENABLED` environment variable creates two separate code paths that diverge in behavior. The correct approach is to always use plain HTTP in application code and let the sidecar proxy handle mTLS transparently. This way the same binary runs identically in the mesh (where Envoy encrypts traffic) and locally (where it communicates in plaintext). For local development, use `docker-compose` with a mesh or Istio's permissive mTLS mode rather than maintaining separate TLS logic in Go.

```go
// WRONG: Different code paths for mesh vs non-mesh
func (s *Service) CreateClient() *http.Client {
    if os.Getenv("ISTIO_ENABLED") == "true" {
        // In mesh - no TLS needed (Envoy handles it)
        return &http.Client{}
    } else {
        // Local - use TLS
        return &http.Client{
            Transport: &http.Transport{
                TLSClientConfig: &tls.Config{...},
            },
        }
    }
}

// CORRECT: Always use plain HTTP, let mesh handle TLS
func (s *Service) CreateClientCorrect() *http.Client {
    // Same code everywhere - mesh handles mTLS transparently
    return &http.Client{
        Timeout: 30 * time.Second,
        Transport: &http.Transport{
            MaxIdleConns:        100,
            MaxIdleConnsPerHost: 10,
            IdleConnTimeout:     90 * time.Second,
        },
    }
}

// For local development, use docker-compose with Linkerd/Istio
// or use permissive mTLS mode during development
```

### Mistake 5: Not Implementing Proper Health Checks

A health handler that returns `200 OK` unconditionally will keep the service in the load-balancing rotation even when its database connection is lost or a critical dependency is unreachable. Kubernetes and Istio will continue routing traffic to a pod that cannot serve requests. A production readiness probe must verify all critical dependencies (database ping, cache connectivity) and return `503 Service Unavailable` if any are unhealthy, so the mesh can drain traffic from the pod before the operator investigates.

```go
// WRONG: Simple health check that doesn't reflect readiness
func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// CORRECT: Separate liveness and readiness with dependency checks
type HealthChecker struct {
    db       *sql.DB
    cache    *redis.Client
    ready    atomic.Bool
}

// Liveness: Is the process alive?
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    // Simple check - if we can respond, we're alive
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"alive"}`))
}

// Readiness: Can we handle traffic?
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    if !h.ready.Load() {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte(`{"status":"not ready","reason":"initializing"}`))
        return
    }

    // Check dependencies
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    checks := map[string]error{
        "database": h.db.PingContext(ctx),
        "cache":    h.cache.Ping(ctx).Err(),
    }

    allHealthy := true
    result := make(map[string]string)
    for name, err := range checks {
        if err != nil {
            result[name] = err.Error()
            allHealthy = false
        } else {
            result[name] = "ok"
        }
    }

    if !allHealthy {
        w.WriteHeader(http.StatusServiceUnavailable)
    } else {
        w.WriteHeader(http.StatusOK)
    }

    json.NewEncoder(w).Encode(map[string]any{
        "status": allHealthy,
        "checks": result,
    })
}

// Set ready after initialization complete
func (h *HealthChecker) SetReady() {
    h.ready.Store(true)
}
```

### Junior → FAANG: Making These Mistakes Detectable Before They Hit Production

The five mistakes in this section share a common property: they are invisible at unit test time and only surface in a mesh environment. Junior engineers need habits that catch these before code review.

For header propagation (Mistake 1), add a unit test that creates a handler, calls it with a request that carries a `traceparent` header, and verifies the outbound request (captured by a test HTTP server) also carries that header. This test will fail immediately if you forget to propagate. Make this test pattern a template in your team's internal cookbook.

For timeout alignment (Mistake 2), document the Istio VirtualService timeout in the same config struct that sets the Go client timeout. Co-locating both values in code makes it obvious when they diverge. A comment like `// must be less than the VirtualService timeout (10s) in istio/user-service-vs.yaml` is worth more than a review reminder.

For service URL hardcoding (Mistake 3), the linter `exhaustruct` or a custom `go vet` check can flag string literals containing `.svc.cluster.local`. Alternatively, make a `ServiceURL` type that reads from environment variables and panics at startup if the variable is not set, preventing deployment with default hardcoded values.

For the mTLS code path split (Mistake 4), the fix is also a policy: if the PR diff shows a conditional that branches on `ISTIO_ENABLED`, reject it in code review. The mesh handles mTLS transparently. Any conditional based on mesh presence indicates the engineer is fighting the mesh rather than working with it.

For health checks (Mistake 5), the test is a readiness probe integration test in CI: bring up the service container, kill the database container, and verify the readiness endpoint returns 503 within the probe timeout window. This test is cheap to write and catches regressions immediately.

### Senior @ FAANG: Systematic Prevention, Policy Enforcement, and Organizational Anti-Patterns

The five mistakes in this section are not random errors. They are predictable failure modes that emerge from a gap between the platform team's mental model and the application team's mental model of how the mesh works. Senior engineers eliminate the gap systematically, not by reviewing individual PRs.

**Platform-enforced timeout contracts.** Mistake 2 (timeout misalignment) recurs because VirtualService timeouts and Go client timeouts are set in different files by different people on different timescales. The platform's solution is to publish timeout values as well-known environment variables injected by the mesh (or by the deployment pipeline): `REQUEST_TIMEOUT_MS=9500` is set by the platform for every pod, and the Go service reads it at startup. The VirtualService is generated from the same source as the environment variable. They cannot diverge because they share a single source of truth.

**GitOps-enforced service naming.** Mistake 3 (hardcoded service URLs) should be caught by a policy-as-code check, not by code review. A custom Semgrep rule that matches `http://.*\.svc\.cluster\.local` in Go source files fails the CI pipeline before the PR is merged. This is more reliable than reviewer attention because it runs on every commit.

**Health endpoint contract testing.** Mistake 5 (shallow health checks) is best prevented by a contract test specification: the platform publishes a standard that readiness probes must return 503 within two seconds of any critical dependency failure. A conformance test (analogous to Kubernetes conformance tests) verifies each service meets the standard. Services that fail the conformance test cannot be deployed to production. This is the type of quality gate that distinguishes FAANG-scale platforms from ad hoc deployments.

**The organizational anti-pattern behind Mistake 4.** When engineers add `if os.Getenv("ISTIO_ENABLED") == "true"` branches, it is often a symptom of a deeper problem: the local development environment does not have a mesh, so the code must work in both environments. The correct fix is not to branch the code but to fix the development environment: use `k3d` or `minikube` with Istio installed, or use `mkcert` and a local reverse proxy that simulates the mTLS termination. Organizations that invest in local mesh environments eliminate this entire class of bugs because the application code never needs to know whether a mesh is present.

**Common mistake audits as a quarterly practice.** A useful staff-level practice is a quarterly "mesh anti-pattern audit": run `istioctl analyze` across all namespaces, check for VirtualServices with no matching service, DestinationRules referencing non-existent subsets, AuthorizationPolicies with overly permissive wildcard rules, and pods not enrolled in the mesh that should be. This audit takes an afternoon and surfaces the configuration drift that accumulates between major deployments. Make the audit report a standing agenda item in the platform review meeting.

---
