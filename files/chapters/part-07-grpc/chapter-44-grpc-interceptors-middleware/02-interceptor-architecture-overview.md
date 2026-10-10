## Interceptor Architecture Overview

gRPC interceptors form a pipeline around every RPC call, analogous to HTTP middleware. The diagram shows how unary and streaming interceptors chain from outermost to innermost, and how context propagation carries deadlines and metadata through the entire stack.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                   gRPC INTERCEPTOR ARCHITECTURE                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     INTERCEPTOR TYPES                                  │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  SERVER INTERCEPTORS                 CLIENT INTERCEPTORS               │  │
│  │  ┌──────────────────────────┐       ┌──────────────────────────┐       │  │
│  │  │ UnaryServerInterceptor   │       │ UnaryClientInterceptor   │       │  │
│  │  │ (ctx, req, info, handler)│       │ (ctx, method, req, reply,│       │  │
│  │  │ → (resp, error)          │       │  cc, invoker, opts)      │       │  │
│  │  │                          │       │ → error                  │       │  │
│  │  └──────────────────────────┘       └──────────────────────────┘       │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────┐       ┌──────────────────────────┐       │  │
│  │  │ StreamServerInterceptor  │       │ StreamClientInterceptor  │       │  │
│  │  │ (srv, stream, info,      │       │ (ctx, desc, cc, method,  │       │  │
│  │  │  handler) → error        │       │  streamer, opts)         │       │  │
│  │  │                          │       │ → (stream, error)        │       │  │
│  │  └──────────────────────────┘       └──────────────────────────┘       │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │               INTERCEPTOR EXECUTION FLOW                               │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Client                                        Server                  │  │
│  │  ┌──────────────────────┐                     ┌──────────────────────┐ │  │
│  │  │ Application Code     │                     │ Service Handler      │ │  │
│  │  └──────────┬───────────┘                     └──────────▲───────────┘ │  │
│  │             │                                            │             │  │
│  │             ▼                                            │             │  │
│  │  ┌──────────────────────┐                     ┌──────────┴───────────┐ │  │
│  │  │ Client Interceptor 1 │                     │ Server Interceptor 1 │ │  │
│  │  │ (e.g., Logging)      │                     │ (e.g., Recovery)     │ │  │
│  │  └──────────┬───────────┘                     └──────────▲───────────┘ │  │
│  │             │                                            │             │  │
│  │             ▼                                            │             │  │
│  │  ┌──────────────────────┐                     ┌──────────┴───────────┐ │  │
│  │  │ Client Interceptor 2 │                     │ Server Interceptor 2 │ │  │
│  │  │ (e.g., Retry)        │                     │ (e.g., Tracing)      │ │  │
│  │  └──────────┬───────────┘                     └──────────▲───────────┘ │  │
│  │             │                                            │             │  │
│  │             ▼                                            │             │  │
│  │  ┌──────────────────────┐                     ┌──────────┴───────────┐ │  │
│  │  │ Client Interceptor 3 │                     │ Server Interceptor 3 │ │  │
│  │  │ (e.g., Auth Token)   │                     │ (e.g., Auth)         │ │  │
│  │  └──────────┬───────────┘                     └──────────▲───────────┘ │  │
│  │             │                                            │             │  │
│  │             │        HTTP/2 + Protocol Buffers           │             │  │
│  │             └────────────────────────────────────────────┘             │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │               RECOMMENDED INTERCEPTOR ORDER                            │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  SERVER SIDE (Outer → Inner):                                          │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │ 1. Recovery    → Catch panics first                             │   │  │
│  │  │ 2. Tracing     → Start span early for full coverage             │   │  │
│  │  │ 3. Metrics     → Measure everything including auth failures     │   │  │
│  │  │ 4. Logging     → Log all requests                               │   │  │
│  │  │ 5. Auth        → Authenticate before business logic             │   │  │
│  │  │ 6. Rate Limit  → Limit after auth (per-user limits)             │   │  │
│  │  │ 7. Validation  → Validate just before handler                   │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  │  CLIENT SIDE (Outer → Inner):                                          │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │ 1. Tracing     → Propagate trace context                        │   │  │
│  │  │ 2. Metrics     → Measure all calls including retries            │   │  │
│  │  │ 3. Logging     → Log all attempts                               │   │  │
│  │  │ 4. Retry       → Retry before other interceptors give up        │   │  │
│  │  │ 5. Timeout     → Enforce deadline                               │   │  │
│  │  │ 6. Auth        → Add token just before call                     │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │               STREAMING INTERCEPTOR PATTERNS                           │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Wrapped ServerStream                                                  │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │ type wrappedStream struct {                                     │   │  │
│  │  │     grpc.ServerStream                                           │   │  │
│  │  │     ctx context.Context  // Modified context                    │   │  │
│  │  │ }                                                               │   │  │
│  │  │                                                                 │   │  │
│  │  │ func (w *wrappedStream) Context() context.Context {             │   │  │
│  │  │     return w.ctx  // Return modified context                    │   │  │
│  │  │ }                                                               │   │  │
│  │  │                                                                 │   │  │
│  │  │ func (w *wrappedStream) RecvMsg(m any) error {                  │   │  │
│  │  │     err := w.ServerStream.RecvMsg(m)                            │   │  │
│  │  │     // Log, count, validate message                             │   │  │
│  │  │     return err                                                  │   │  │
│  │  │ }                                                               │   │  │
│  │  │                                                                 │   │  │
│  │  │ func (w *wrappedStream) SendMsg(m any) error {                  │   │  │
│  │  │     // Transform, log, count message                            │   │  │
│  │  │     return w.ServerStream.SendMsg(m)                            │   │  │
│  │  │ }                                                               │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                  COMMON INTERCEPTOR PATTERNS                           │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Pattern          │ Purpose              │ Example                     │  │
│  │  ─────────────────┼──────────────────────┼───────────────────────────  │  │
│  │  Before/After     │ Wrap handler call    │ Logging, Metrics            │  │
│  │  Context Modify   │ Add values to ctx    │ Auth (add user)             │  │
│  │  Short-circuit    │ Return early         │ Auth fail, Rate limit       │  │
│  │  Transform        │ Modify req/resp      │ Validation, Sanitization    │  │
│  │  Retry            │ Call multiple times  │ Client retry                │  │
│  │  Recovery         │ Catch panics         │ Panic recovery              │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading the Architecture Diagram

The diagram above contains more information than it first appears. Focus on three things that catch junior engineers off guard in interviews and on the job.

First, the four interceptor type signatures are not interchangeable. A `UnaryServerInterceptor` will not compile if you pass it where a `StreamServerInterceptor` is expected. When you add a new cross-cutting concern, you must implement both variants or streaming RPCs are silently unprotected.

Second, the recommended ordering is load-bearing, not cosmetic. The diagram shows recovery before tracing before metrics before logging before auth. Each position is chosen because of what the layer above it needs to observe. Metrics sitting above auth means you see authentication failures in your dashboards. Metrics sitting below auth means those failed calls are invisible. In production this matters because a credential-stuffing attack produces a flood of auth failures, and if metrics sits below auth you are effectively blind to the attack signal.

Third, the wrapped `ServerStream` pattern is the key difference between unary and streaming interceptors. For unary, the context flows through naturally. For streaming, the context is fixed at stream creation. If you need to add a value to the context (for example, the authenticated user), you must wrap the stream in a struct that overrides `Context()` to return the enriched context. This is the single most common bug in streaming interceptor implementations.

### Senior @ FAANG: Architecture as a Contract

At staff level, an architecture diagram is a contract, not just documentation. The interceptor order diagram defines what every service can rely on: if the platform enforces this order, then every handler can assume the user is already in the context by the time it runs. If a handler must defensively check for nil user, that is a sign the platform contract is not being enforced.

The table of patterns (Before/After, Context Modify, Short-circuit, Transform, Retry, Recovery) is the vocabulary for interceptor design reviews. When a team proposes a new interceptor, the first question is which pattern it belongs to. A short-circuit interceptor that sometimes also transforms the response is doing two things and should be split. A retry interceptor that also adds logging is conflating two concerns.

The diagram also implicitly shows the observability surface. The `stats.Handler` API (not shown) sits below the interceptor layer and sees raw transport events: connection setup, TLS handshake completion, per-message bytes on the wire, and stream teardown reasons. For accuracy, transport-level metrics belong in `stats.Handler` (use `otelgrpc.NewServerHandler()`). Application-level concerns (user identity, business error codes, feature-flag decisions) belong in interceptors. Mixing the two leads to either underinstrumentation (missing transport errors) or overinstrumentation (duplicated metrics that double-count).

A mature platform team documents this explicitly: the `stats.Handler` is responsible for RED metrics and distributed tracing. Interceptors are responsible for auth, rate limiting, validation, and business-specific telemetry. No team is allowed to write a metrics interceptor that duplicates what `otelgrpc` already provides, because duplicate metrics confuse on-call engineers during incidents.

---
