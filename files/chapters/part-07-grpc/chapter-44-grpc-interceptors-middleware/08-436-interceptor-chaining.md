## 44.6 Interceptor Chaining

### Chaining Multiple Interceptors

`grpc.ChainUnaryInterceptor` and `grpc.ChainStreamInterceptor` are built into grpc-go itself - they accept a variadic list of interceptors and execute them in the order they are passed. The first interceptor in the list is the outermost. It runs first on the request path and last on the response path. This ordering matters: recovery must be outermost to catch panics from every subsequent interceptor, and validation should be innermost so it runs only after authentication succeeds.

> **Historical note.** Older code bases reach for `grpc_middleware.ChainUnaryServer` from `github.com/grpc-ecosystem/go-grpc-middleware` v1. That helper existed because grpc-go did not support chaining natively at the time. v2 of the library removed its own chain helpers specifically because grpc-go absorbed this feature. If you see `grpc_middleware.ChainUnaryServer` in a codebase, it is a sign the dependency is still pinned to v1 and should be migrated to v2 + native chaining.

### Recommended chain ordering (outer -> inner)

The mnemonic is: *outer interceptors see everything. inner interceptors are gated by everything above them.*

1. **Recovery** - outermost, so it catches panics from every other interceptor. If tracing panics, recovery must still return a clean `Internal` error.
2. **Tracing / StatsHandler** - starts the server span before any other layer, so auth failures, rate-limit rejections, and validation errors all show up as spans with the correct parent.
3. **Metrics** - observes every request including auth rejections, which is essential for detecting credential-stuffing attempts. If metrics sits below auth, you go blind during an attack.
4. **Logging** - logs authenticated and unauthenticated attempts. correlation IDs extracted here are visible to every layer below.
5. **Auth** - gate: requests that fail here never reach rate limiting or validation.
6. **Rate limiting** - per-user or per-tenant, which requires the authenticated identity from the previous layer. Rate limiting by IP only can live above auth instead.
7. **Validation** - innermost, since validating anonymous or rate-limited requests is wasted CPU.

```go
package main

import (
    "log/slog"
    "os"

    "google.golang.org/grpc"
    "github.com/prometheus/client_golang/prometheus"

    "github.com/myapp/interceptor"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    metrics := interceptor.NewServerMetrics(prometheus.DefaultRegisterer)

    // Create server with chained interceptors
    server := grpc.NewServer(
        // Unary interceptors (executed in order)
        grpc.ChainUnaryInterceptor(
            interceptor.RecoveryInterceptor(logger),        // 1. Recovery (outermost)
            interceptor.TracingInterceptor(),               // 2. Tracing
            metrics.UnaryServerInterceptor(),               // 3. Metrics
            interceptor.LoggingInterceptor(logger),         // 4. Logging
            interceptor.AuthInterceptor(authConfig),        // 5. Auth
            interceptor.RateLimitInterceptor(limiter, keyFunc), // 6. Rate limit
            interceptor.ValidationInterceptor(),            // 7. Validation (innermost)
        ),

        // Stream interceptors
        grpc.ChainStreamInterceptor(
            interceptor.StreamRecoveryInterceptor(logger),
            interceptor.StreamTracingInterceptor(),
            metrics.StreamServerInterceptor(),
            interceptor.StreamLoggingInterceptor(logger),
            interceptor.StreamAuthInterceptor(authConfig),
        ),
    )

    // Register services and start server...
}
```

### Custom Interceptor Chain

Sometimes you need interceptors to run conditionally (for example, skipping authentication on the health check endpoint). The `InterceptorChain` below adds a condition function to each interceptor. At request time, it builds a handler chain from only the interceptors whose conditions match, so skipped interceptors add zero overhead to the call path.

```go
package interceptor

import (
    "context"

    "google.golang.org/grpc"
)

// InterceptorChain allows conditional interceptor application
type InterceptorChain struct {
    interceptors []conditionalInterceptor
}

type conditionalInterceptor struct {
    interceptor grpc.UnaryServerInterceptor
    condition   func(info *grpc.UnaryServerInfo) bool
}

func NewInterceptorChain() *InterceptorChain {
    return &InterceptorChain{}
}

// Add adds an interceptor that always runs
func (c *InterceptorChain) Add(i grpc.UnaryServerInterceptor) *InterceptorChain {
    c.interceptors = append(c.interceptors, conditionalInterceptor{
        interceptor: i,
        condition:   func(*grpc.UnaryServerInfo) bool { return true },
    })
    return c
}

// AddConditional adds an interceptor that runs based on condition
func (c *InterceptorChain) AddConditional(i grpc.UnaryServerInterceptor, condition func(*grpc.UnaryServerInfo) bool) *InterceptorChain {
    c.interceptors = append(c.interceptors, conditionalInterceptor{
        interceptor: i,
        condition:   condition,
    })
    return c
}

// Build creates the final interceptor
func (c *InterceptorChain) Build() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Build chain of applicable interceptors
        chain := handler
        for i := len(c.interceptors) - 1; i >= 0; i-- {
            ci := c.interceptors[i]
            if ci.condition(info) {
                interceptor := ci.interceptor
                next := chain
                chain = func(ctx context.Context, req any) (any, error) {
                    return interceptor(ctx, req, info, next)
                }
            }
        }

        return chain(ctx, req)
    }
}

// Usage
func setupServer() *grpc.Server {
    chain := NewInterceptorChain().
        Add(RecoveryInterceptor(logger)).
        Add(LoggingInterceptor(logger)).
        AddConditional(AuthInterceptor(config), func(info *grpc.UnaryServerInfo) bool {
            // Skip auth for health check
            return info.FullMethod != "/grpc.health.v1.Health/Check"
        }).
        Add(ValidationInterceptor())

    return grpc.NewServer(
        grpc.UnaryInterceptor(chain.Build()),
    )
}
```

### Junior -> FAANG: The Mnemonic and the Reasoning

The mnemonic in this section ("outer interceptors see everything, inner interceptors are gated by everything above them") is the key insight for interview questions about interceptor ordering. Commit it to memory, then be able to derive the correct order from first principles without the mnemonic.

The derivation goes like this: recovery must be outermost because its purpose is to catch panics from every other interceptor. Metrics must sit above auth because you need to observe authentication failures. Auth must sit above rate limiting when rate limits are per-user, because you need the user identity to key the rate limiter. Validation is innermost because validating a request that would be rejected by auth or rate limiting wastes CPU.

The `InterceptorChain` with condition functions is a useful pattern for a specific problem: health check endpoints that must bypass authentication. The naive solution is to add the health check to the `PublicMethods` list in the auth interceptor. The `InterceptorChain` approach is more explicit: the condition function for the auth interceptor filters out the health check method. Both work, but the condition function approach keeps the bypass logic collocated with the interceptor that is being bypassed, rather than scattered across a global config list.

For the interview: be able to explain the closure capture in `Build()`. The `interceptor := ci.interceptor` assignment inside the loop is necessary to capture the loop variable correctly. Without it, all closures in the chain capture the same `ci` variable, which by the time the chain runs, holds the last value from the loop. This is a classic Go closure-in-loop bug.

### Senior @ FAANG: Interceptor Chain Governance and Testing

**Chain testing as a contract:** The chain ordering is a correctness requirement. It should be verified by a test that constructs the chain and asserts the order by injecting interceptors that record their execution order. At platform level, this test runs in CI for every service scaffold change and prevents accidental reordering.

```go
// Pattern for verifying chain order in tests
func TestInterceptorOrder(t *testing.T) {
    var order []string
    makeInterceptor := func(name string) grpc.UnaryServerInterceptor {
        return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
            order = append(order, name+":before")
            resp, err := handler(ctx, req)
            order = append(order, name+":after")
            return resp, err
        }
    }

    server := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            makeInterceptor("recovery"),
            makeInterceptor("auth"),
            makeInterceptor("validation"),
        ),
    )
    // ... invoke an RPC through the server
    // assert order == ["recovery:before", "auth:before", "validation:before",
    //                  "validation:after", "auth:after", "recovery:after"]
}
```

**Conditional interceptors and the bypass audit trail:** The `InterceptorChain.AddConditional` pattern is powerful but must be audited carefully. Every condition function that bypasses authentication is a potential security hole. At platform level, bypass conditions should be restricted to a small allowlist of approved patterns (health check paths, internal-only methods) and any new bypass must go through a security review. The platform should also emit a metric when a request triggers a bypass condition, so the bypass rate is observable and anomalies (an external caller hitting a health-check bypass at high rate) are detectable.

**Chain composition vs flat registration:** The examples show all interceptors registered at server construction time. An alternative pattern is chain composition: each service registers a platform chain (provided by the scaffold) plus its own chain. The server factory merges them in the correct order. This makes the platform-owned interceptors invisible to service teams (they cannot accidentally reorder or remove them) while still allowing service-specific interceptors to be added. The implementation is straightforward: the factory owns positions 1-N for platform interceptors and appends service-provided interceptors starting at position N+1. This mirrors how some HTTP frameworks handle middleware: the framework registers its own middleware first, then the application registers its own.

**Performance characteristics of deep chains:** Each interceptor in the chain adds a function call overhead. For a 7-interceptor chain on a simple gRPC call that completes in 100 microseconds, the overhead is measurable in benchmarks but typically negligible in production. The real cost is in interceptors that perform I/O (auth token validation against a remote service, rate limit checks against Redis). Profiling the interceptor chain with `go test -bench` before adding a new I/O-bound interceptor is a discipline that prevents latency regressions.

---
