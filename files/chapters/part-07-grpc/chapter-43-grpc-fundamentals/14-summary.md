## Summary

Core building blocks for production gRPC services in Go:

1. **Protocol Buffers** define services and messages in `.proto` files. Versioned packages and stable field numbers enable backward-compatible schema evolution.
2. **Server implementation** requires embedding the generated `Unimplemented*Server` type for forward compatibility, then overriding individual RPC methods.
3. **Streaming patterns** - unary, server streaming, client streaming, and bidirectional - each suit different data flow requirements. Choose based on whether the data is bounded, large, or real-time.
4. **Error handling** maps domain errors to gRPC status codes. Rich error details via `status.WithDetails` give clients enough information to take corrective action. Never expose internal state in error messages.
5. **Testing** with `bufconn` provides full-stack integration coverage without opening network ports. Unit tests call handler methods directly with mock stores.
6. **Production patterns** from Google (field masks), Uber (hedged requests, deadline propagation), Netflix (circuit breakers, request coalescing), and Dropbox (consistent hashing) demonstrate gRPC at scale.
7. **Observability** through interceptors provides metrics, distributed tracing, and structured logging across all RPCs.

### Junior → FAANG: Consolidating the Chapter Into Interview-Ready Knowledge

Seven points covered in this chapter. Here is how to use them in interviews:

**When asked "how does gRPC work?"** Lead with the contract: a `.proto` file defines the service. `protoc` (or `buf`) generates Go types and server/client stubs. The server implements the generated interface. The framework handles HTTP/2 framing, Protobuf serialization, and deadline propagation automatically. Finish with the performance story: binary framing plus connection multiplexing produce measurably lower latency than REST at high request rates.

**When asked "which streaming pattern would you use for X?"** Apply the decision framework: start with unary, upgrade to streaming only when you have a specific reason (large response, incremental results, long-lived subscription, or true bidirectional interactivity). Name the reason explicitly, not just the pattern.

**When asked about error handling:** Lead with status codes and the retry-or-not classification. Mention rich error details (`status.WithDetails`) as the mechanism for machine-readable context. Emphasize that internal errors must never leak to the caller: log internally, return a safe message.

**When asked about testing:** Name bufconn immediately. Explain that it exercises the full stack (serialization, interceptors, deadline propagation) without real network ports. Distinguish it from direct method call tests, which are faster but bypass the transport layer.

**When given a system design question involving microservices:** Reach for gRPC as the inter-service protocol when the services are internal, latency-sensitive, and need streaming or polyglot support. Reach for REST when the API is public-facing or needs browser support without a proxy.

### Senior @ FAANG: Platform-Level Synthesis and Maturity Assessment

The seven summary points above describe a correctly functioning gRPC service. At the L6 level, the question is whether your organization's gRPC platform enables all seven points for every service by default, or whether each team reinvents them independently.

A mature gRPC platform delivers the following capabilities as infrastructure, not as each team's responsibility:

- **Schema management:** Centralized proto repository, `buf lint` and `buf breaking` in CI, generated SDKs published to internal package registries, API review process for new services.
- **Baseline server template:** Standard interceptor chain (auth, rate limiting, error sanitization, observability), production-sane defaults (keepalive, max message size, max connection age), health check endpoint, graceful shutdown with bounded drain window.
- **Client wrappers:** Generated client wrappers that include circuit breakers, retries with correct idempotency semantics, deadline injection, and distributed tracing propagation.
- **Observability baseline:** Every service emits RED metrics (`grpc_requests_total`, `grpc_request_duration_seconds` as a histogram) with `method` and `code` labels, W3C traceparent propagated in metadata, structured logs with trace ID.
- **Load balancing infrastructure:** Documented policy for how gRPC traffic is load-balanced (service mesh, headless service with DNS, or xDS control plane), tested under rolling deploy and scale-out scenarios, with runbook for hot-spot incidents.
- **Breaking change safety:** `buf breaking` blocks merges, JSON-format compatibility is checked alongside wire compatibility, field mask update patterns are enforced in the API review checklist.
- **Testing infrastructure:** Platform `grpctest` package for bufconn setup, goroutine leak detection in streaming tests, integration test fixtures that build the full production interceptor chain.

Assess your organization against this list. Gaps in the platform are opportunities for L6 leverage: a single platform improvement benefits every service team simultaneously, compounding in value as the fleet grows. Prioritize the gaps that currently require the most per-team effort or produce the most per-team incidents.

---
