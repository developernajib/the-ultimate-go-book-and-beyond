# Chapter 44: gRPC Interceptors & Middleware

*Interceptors are to gRPC what middleware is to HTTP: the backbone of cross-cutting concerns.*

Every production gRPC service eventually needs the same set of capabilities regardless of what business logic it implements: structured logging so you can diagnose failures, authentication so only authorized callers proceed, rate limiting so a misbehaving client cannot take the system down, and distributed tracing so a slow request can be traced across ten service boundaries. Implementing these concerns directly inside each handler is the path to duplicated code, inconsistent behavior, and tests that are impossible to isolate. A cross-cutting concern baked into business logic is technical debt compounding at every deployment.

gRPC's interceptor model solves this cleanly. Interceptors wrap the handler invocation at the framework level - before the request reaches your code and after the response leaves it - giving you a single, composable place to implement observability, security, and resilience. Go's functional composition makes interceptor chains easy to reason about: each interceptor is a function that calls the next, forming a pipeline where concerns can be added, removed, or reordered without touching handler code. This mirrors the middleware pattern that made HTTP frameworks like Express and Chi popular, but adapted to gRPC's unary and streaming semantics.

This chapter takes you from the interceptor type signatures through to fully production-hardened middleware chains. You will implement server-side interceptors for logging, panic recovery, JWT authentication, and Prometheus metrics, then mirror those concerns on the client side with retry logic, timeout propagation, and metadata injection. You will also tackle the harder problem of streaming interceptors, which require wrapping the stream interface to intercept individual messages rather than a single request-response pair.

**What you'll learn in this chapter:**
- The four interceptor function signatures (unary/streaming × server/client) and when each applies
- Building a structured logging interceptor that captures method, duration, status code, and request ID
- Implementing panic recovery to prevent a single handler crash from killing the server process
- Writing a JWT authentication interceptor with per-method bypass for public endpoints
- Adding Prometheus metrics and OpenTelemetry trace spans without polluting handler code
- Creating client-side retry interceptors with exponential backoff and idempotency guards
- Wrapping streaming RPCs to log per-message events and propagate cancellation correctly
- Chaining multiple interceptors with correct ordering (auth before rate limit before logging)

**Why this matters at scale:**
Uber's Go services process millions of gRPC calls per minute through shared interceptor chains that enforce rate limits, emit telemetry, and validate tokens. Centralizing these concerns means a security fix or metric change deploys once and takes effect across every service simultaneously, rather than requiring a coordinated rollout across hundreds of handlers.

**A note on the modern ecosystem (Go 1.27, 2026):**
- `grpc-ecosystem/go-grpc-middleware/v2` removed its own `ChainUnaryServer`/`ChainStreamServer` helpers because grpc-go now supports chaining natively via `grpc.ChainUnaryInterceptor`/`grpc.ChainStreamInterceptor`. v1 remains only for legacy compatibility and should not be used in new code.
- OpenTelemetry's `otelgrpc` instrumentation has shifted its recommendation from interceptor-based instrumentation to `stats.Handler`-based instrumentation (`otelgrpc.NewServerHandler` / `otelgrpc.NewClientHandler` with `grpc.StatsHandler(...)`). StatsHandlers see lower-level transport events (connection setup, per-message bytes) that interceptors cannot observe, producing more accurate metrics and traces. We teach the interceptor path in depth because it is the foundation - but we call out StatsHandler alternatives where they are now preferred in production.
- The Jaeger native exporter was retired in favor of OTLP. Modern deployments export spans over OTLP (`go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc`) to an OpenTelemetry Collector, which fans out to Jaeger, Tempo, Datadog, or whichever backend you run.

**Prerequisites:** Chapter 43 (gRPC Fundamentals), Chapter 29 (HTTP middleware patterns), Chapter 39 (JWT and authentication)

### Junior -> FAANG: Understanding Why Interceptors Exist

New engineers sometimes wonder why interceptors are needed at all. The short answer is that without them, every handler implements its own logging, its own auth check, and its own panic catch. When a security bug is found in token validation, you fix it in one interceptor file and every endpoint is patched. If auth logic lives in each handler, you chase it across a hundred files.

A useful mental model for juniors: an interceptor is a function that receives a "next" function and decides whether to call it, when to call it, and what to do with its result. This is exactly the same pattern as HTTP middleware in Express, Chi, or net/http. If you can write a logging middleware for an HTTP server, you already understand 80% of what a gRPC interceptor does.

The key gap for junior engineers is often the streaming case. In HTTP, every request is unary: one request in, one response out. gRPC adds three more shapes: server streaming, client streaming, and bidirectional streaming. Each shape needs its own interceptor variant, and modifying context or counting messages on a stream requires wrapping the stream object rather than intercepting a single call. That wrapper pattern trips up most engineers the first time.

For FAANG entry-level interviews, expect questions like: "Walk me through what happens when a gRPC request arrives at a server with three chained interceptors." Practice articulating the call stack from outermost interceptor through handler and back, and be ready to explain why recovery must be outermost.

### Senior @ FAANG: Interceptor Infrastructure as a Platform Capability

At staff and principal level, the question is not "how do I write an interceptor" but "how do I govern the interceptor ecosystem across 500 services so that every service inherits correct behavior without any team needing to think about it."

**Architecture Decision Records worth filing:**

The first ADR every platform team should write for interceptors is the split between framework-owned interceptors and service-owned interceptors. Framework-owned interceptors (recovery, tracing, metrics, auth) are injected by the service scaffold or the shared server factory. No individual team configures them. Service-owned interceptors (business-specific rate limits, tenant isolation, feature flags) are registered by the service itself. This boundary prevents teams from accidentally disabling recovery or inserting auth in the wrong position.

The second ADR is the choice between `stats.Handler` and interceptor-based observability. `stats.Handler` sees transport events (connection setup, per-message bytes, stream close reasons) that interceptors cannot observe. For RED metrics and distributed tracing, `stats.Handler` via `otelgrpc.NewServerHandler()` is the better choice in 2026. Interceptors remain appropriate for auth, rate limiting, and business-logic-adjacent concerns because they run in the request processing pipeline where context values and early returns are natural. Documenting this split prevents teams from writing redundant interceptors that duplicate what `otelgrpc` already provides.

**Maturity model for interceptor infrastructure:**

Level 1 (reactive): each service writes its own interceptors, no sharing, inconsistent behavior.

Level 2 (library): a shared `pkg/interceptors` package provides standard interceptors. Services import it, but opt-in is optional and ordering is at team discretion.

Level 3 (enforced): a service factory or scaffold generates the server setup. Standard interceptors are injected automatically. Custom interceptors can be added only inside defined extension points. Ordering is enforced.

Level 4 (observable governance): the platform emits a metric for every server that reports which interceptors are registered and in what order. An alerting rule fires if recovery is missing or if auth appears before recovery. This makes drift from policy visible without requiring manual audits.

**Bar-raiser signals at L6/L7 interviews:**

Candidates who think at staff level will connect interceptor design to blast radius. They will ask: if a shared interceptor has a bug, how many services are affected and how quickly can you roll it back without a coordinated deploy? They will propose canary release for shared interceptor changes, versioned packages with pinned dependencies per service, and a compatibility test suite that every service runs against new interceptor versions before adoption. They will also flag that an interceptor adding blocking I/O (for example, a remote auth call without circuit breaking) becomes a single point of failure for every service that uses it, and will demand a fallback mode and a kill switch from day one.

---
