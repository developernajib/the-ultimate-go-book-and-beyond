## Summary

gRPC interceptors essentials:

1. **Server Interceptors**: Logging, recovery, auth, rate limiting, validation - applied in correct order (recovery first, validation last)
2. **Client Interceptors**: Retry with idempotency checks, metadata propagation, timeout enforcement
3. **Streaming Interceptors**: Must wrap ServerStream/ClientStream to modify context and intercept messages
4. **Metrics**: Prometheus counters, histograms for request duration, gauges for in-flight requests
5. **Tracing**: OpenTelemetry propagation via metadata carrier, span creation for server and client
6. **Chaining**: Use ChainUnaryInterceptor/ChainStreamInterceptor with proper ordering
7. **Company Patterns**: Google's deadline propagation, Uber's caller identification, Netflix's circuit breakers

### Junior -> FAANG: What the Summary Does Not Say

The seven-point summary is accurate but omits the nuances that interviewers probe. Three additions that will strengthen your understanding:

**On point 3 (streaming interceptors):** The summary says "must wrap ServerStream/ClientStream to modify context and intercept messages." The unstated reason is that `ServerStream.Context()` returns the context that was created at stream initialization and cannot be replaced. The only way to add values to it is to provide a new `Context()` via a wrapper. This immutability is by design: it prevents handlers from accidentally canceling the stream's context by wrapping it with a timeout.

**On point 6 (chaining):** The summary says "use ChainUnaryInterceptor/ChainStreamInterceptor with proper ordering." The unstated point is that you cannot have more than one `grpc.UnaryInterceptor` option on a single server. If you call `grpc.NewServer(grpc.UnaryInterceptor(a), grpc.UnaryInterceptor(b))`, grpc-go panics at construction with "The unary server interceptor was already set and may not be reset." `ChainUnaryInterceptor` exists precisely to solve this: pass all interceptors to one option. This is a common source of bugs when developers add a new interceptor by adding a second `grpc.UnaryInterceptor` option rather than adding to the existing chain. Note that `ChainUnaryInterceptor` and a single `UnaryInterceptor` can coexist (the single one runs first), but two of the same kind cannot.

**On point 7 (company patterns):** The summary presents company patterns as distinct. In practice, production systems combine all three: deadline propagation from Google, caller identification from Uber, and circuit breaking from Netflix. These are composable interceptors that chain together. A complete production server interceptor chain might be: recovery, tracing, metrics, caller identification, deadline propagation, auth, rate limiting, circuit breaking (as a client interceptor on downstream calls), and validation.

### Senior @ FAANG: The Interceptor Platform at Full Maturity

A fully mature interceptor platform at L6/L7 scale has the following properties that go beyond what the summary captures.

**Self-service with guardrails:** Service teams can register custom interceptors via a declared API. The platform validates that custom interceptors are inserted at approved positions in the chain (for example, between rate limiting and validation, not before recovery). Custom interceptors that attempt to insert before recovery or after validation are rejected at server startup with a clear error message.

**Versioned interceptor releases:** Platform interceptor changes are released as versioned library updates. Services adopt new versions on their own schedule. The platform maintains N-2 version compatibility, meaning a service can lag two minor versions behind the current interceptor library without losing support. Security patches bypass the versioning schedule and are applied via a mandatory upgrade within 72 hours of release. This versioning model prevents the "update everything at once" problem that makes shared library changes risky.

**Observability of the interceptor layer itself:** The platform emits metrics for the interceptor layer: `interceptor_duration_seconds` labeled by interceptor name and method, `interceptor_errors_total` labeled by interceptor name, error code, and method. These metrics allow on-call engineers to determine whether a latency regression comes from a handler or from an interceptor (for example, a newly deployed auth interceptor that is hitting a slow JWKS endpoint). Without these metrics, diagnosing interceptor-introduced latency requires examining individual spans in a tracing system, which is slower and requires knowledge of the tracing backend.

**Graduation path:** The interceptor platform should have a graduation path for new interceptors: start as an experimental opt-in interceptor (teams add it explicitly), graduate to a default opt-in interceptor (teams must explicitly opt out), graduate to a mandatory interceptor (cannot be removed). This path allows validation of a new interceptor's behavior at scale before it becomes a requirement. The auth interceptor went through this path at every major company that adopted gRPC: it started as a recommendation, became a default, and is now enforced by the platform for all services that handle authenticated traffic.

---
