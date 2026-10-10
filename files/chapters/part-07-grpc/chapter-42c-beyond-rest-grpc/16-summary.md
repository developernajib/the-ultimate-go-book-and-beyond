## Summary

Modern Go API design requires fluency across multiple protocols - each optimized for different tradeoffs:

- **gRPC**: Binary efficiency, type safety, streaming - the right default for internal service-to-service communication. Protocol Buffers generate typed clients in every language. HTTP/2 multiplexing eliminates per-request connection overhead.
- **All four streaming patterns**: Unary (request/response), server streaming (one request, many responses), client streaming (many requests, one response), and bidirectional streaming (concurrent message flows in both directions).
- **gRPC interceptors**: The middleware layer for cross-cutting concerns - authentication, rate limiting, distributed tracing, panic recovery, and circuit breaking - all composable via `grpc.ChainUnaryInterceptor`.
- **Protocol Buffers advanced features**: `oneof` for mutually exclusive fields, field masks for partial updates, `Any` for dynamic types, and `reserved` for safe schema evolution.
- **TLS and mTLS**: TLS protects data in transit, and mTLS authenticates the caller's service identity without application-level tokens - mandatory for zero-trust internal networks.
- **Health checking**: Implement the gRPC health protocol from day one. Kubernetes liveness and readiness probes, load balancers, and `grpc-health-probe` all speak this protocol natively.
- **GraphQL**: Eliminates over-fetching and under-fetching for flexible API consumers. DataLoader is mandatory in production to prevent N+1 database queries.
- **WebSocket**: Full-duplex browser communication for interactive real-time applications - chat, collaborative editing, live dashboards.
- **SSE**: Simpler than WebSocket for server-push-only scenarios. Works over HTTP/1.1, auto-reconnects, and is proxy-transparent.
- **Connect protocol**: gRPC compatibility + HTTP/1.1 + browser-native fetch access without a proxy layer. The pragmatic choice when browser clients need to speak protobuf-defined services.
- **API gateway**: Protocol translation, authentication, rate limiting, and request aggregation in a single ingress layer - decouples external API contracts from internal service architecture.

Protocol selection comes down to five questions: (1) Who is the caller - browser, mobile, internal service? (2) Does the caller need to send data or only receive it? (3) Is the payload shape fixed or client-defined? (4) What are the latency and throughput requirements? (5) Does your team have protobuf tooling experience? REST remains the right default for public APIs. gRPC is the right default for internal services. GraphQL is the right choice when clients need flexible queries. WebSocket/SSE are the right choices for real-time push.

---

### Junior → FAANG: What to Take Away for the Next Job and the Next Interview

The core mental model from this chapter is that protocol selection is an engineering decision with concrete consequences, not a preference. The protocols covered here each solve a specific class of problem, and choosing the wrong one accumulates technical debt that compounds as traffic grows.

The four things to commit to memory for interviews and first-job work:

First, gRPC is for typed, high-throughput, internal service communication where you own both sides. The performance benefit is real but secondary to the contract benefit: catching breaking changes at compile time rather than in production.

Second, the N+1 problem in GraphQL is not a GraphQL-specific bug. It is a consequence of the resolver pattern and is solved by DataLoader. Every GraphQL server in production needs DataLoader for any field that loads from a database or downstream service.

Third, gRPC status codes are a contract, not a convenience. `codes.Unavailable` tells callers to retry. `codes.InvalidArgument` tells callers to fix the request. `codes.Internal` tells callers nothing actionable. Map domain errors correctly from the first deployment.

Fourth, the production lifecycle of a gRPC service requires health checking, graceful drain, and TLS from the start. Adding these after the fact requires coordinated changes across the service, its Kubernetes deployment manifest, its load balancer configuration, and its monitoring dashboards. Doing it right the first time is categorically less work.

### Senior @ FAANG: Platform Architecture Synthesis and Staff-Level Impact

The chapter's content maps to a platform architecture for API communication that a staff engineer is expected to design, advocate for, and drive adoption of across an organization. The individual technical skills (implementing interceptors, writing proto schemas, configuring TLS) are necessary but not sufficient at this level. The platform thinking is what scales impact.

A well-operated API platform has the following properties. Protocol decisions are made once at the platform level and enforced consistently: gRPC for internal, REST for external, GraphQL for BFF layers where client flexibility is required. The schema registry holds all proto files with automated lint and breaking-change checks. A shared interceptor library provides auth, tracing, rate limiting, and logging with zero per-service configuration overhead. Service provisioning templates (Helm charts, Terraform modules, or Kubernetes controllers) include health checking, graceful drain configuration, and mTLS out of the box. Teams spend their time building product features, not reimplementing infrastructure.

The path to this state is an incremental maturity model. Start with the schema registry and breaking-change CI gates, which provide immediate value and are low-disruption. Then roll out the shared interceptor library, which provides observability improvements that motivate adoption. Then migrate to mTLS through SPIRE or the service mesh, which is the highest-friction change and benefits from the trust built by the earlier investments.

At L7, the signal the organization needs from you is not "I know how gRPC works" but "I defined the platform strategy for API communication, drove adoption across 50 teams, and built the tooling that makes the right thing the easy thing." The technical depth in this chapter is the prerequisite. The organizational design and execution is the actual staff-level work.
