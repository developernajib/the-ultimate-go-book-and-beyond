# Chapter 43: gRPC Fundamentals

When services communicate hundreds of thousands of times per second, the overhead of HTTP/1.1 and JSON serialization becomes measurable - in latency, bandwidth, and CPU cycles. REST was designed for human-readable, browser-friendly APIs and was never optimized for machine-to-machine communication at datacenter scale.

Go and gRPC share a common origin at Google and complement each other well. gRPC's generated stubs replace fragile, hand-maintained HTTP client code, while Protocol Buffers provide a strongly-typed, language-neutral contract that compilers validate before any bytes hit the wire. Go's goroutine model maps naturally onto gRPC's multiplexed HTTP/2 streams, supporting thousands of concurrent RPCs without thread-per-connection overhead.

This chapter establishes the foundation you need to build gRPC services in Go from first principles. You will learn how Protocol Buffers define service contracts, how the `protoc` toolchain generates idiomatic Go code, and how to implement all four gRPC communication patterns - unary, server streaming, client streaming, and bidirectional streaming. You will also cover the operational essentials: error handling with rich status codes, health checks, graceful shutdown, and in-memory testing strategies that keep your CI pipeline fast.

**What you'll learn in this chapter:**
- How gRPC's layered protocol stack (HTTP/2, HPACK, Protocol Buffers) achieves its performance characteristics
- Writing `.proto` service definitions with proper naming conventions and backward-compatible versioning
- Generating Go server stubs and client code with `protoc-gen-go` and `protoc-gen-go-grpc`
- Implementing unary RPC handlers with correct context propagation and deadline awareness
- Using all four streaming patterns and understanding when each is appropriate
- Mapping gRPC status codes to meaningful application errors with rich error detail types
- Testing gRPC services with `bufconn` for fast, zero-network-overhead integration tests
- Configuring production server options: TLS, keepalives, max message size, and graceful drain

**Why this matters at scale:**
Google runs billions of gRPC calls per second across its internal infrastructure. Companies like Uber, Netflix, and Cloudflare use gRPC as the primary inter-service protocol because its binary framing and multiplexing reduce tail latency and infrastructure cost - savings that compound as service counts grow.

**Prerequisites:** Chapters 1-10 (Go fundamentals), Chapter 29 (HTTP servers), Chapter 38 (REST API design)

### Junior → FAANG: Building Your Mental Model of gRPC Before the Interview

Many early-career engineers treat gRPC as "just REST with a different serialization format." That framing leads to wrong answers in interviews and wrong designs on the job. The foundational shift is understanding that gRPC is a contract-first, code-generated RPC framework where the `.proto` file is the source of truth, not a documentation artifact added after the fact.

The prerequisite gaps that most trip up juniors:

- **HTTP/2 is not HTTP/1.1 with faster handshakes.** HTTP/2 introduces multiplexed streams over a single connection, which is why gRPC can have thousands of concurrent RPCs without thread-per-connection overhead. If you cannot explain what a stream ID is and why head-of-line blocking is solved at the HTTP/2 level, practice this before interviews.
- **Protocol Buffers encode field numbers, not names.** Serialized bytes carry `field_number << 3 | wire_type`, not the string `"email"`. This is why field number stability is a hard rule: changing a number silently corrupts old messages already on the wire.
- **Context propagation is not optional.** Every gRPC call must carry a context with a deadline. Forgetting this causes goroutines to leak on the server side when clients disconnect. In your first job, always reach for `context.WithTimeout` before calling any downstream RPC.

A worked habit to build immediately: run `grpcurl` or `grpcui` against your local development server with reflection enabled. Understanding how to inspect a live service through its proto reflection endpoint builds the intuition you need to debug production issues later.

Entry-point framing for interviews: when asked "why gRPC instead of REST?", lead with the contract-enforcement story (`.proto` catches breaking changes at compile time), follow with the performance story (binary framing, connection multiplexing), and mention streaming as a first-class primitive rather than a bolt-on afterthought.

### Senior @ FAANG: Platform and Governance Thinking for gRPC at Scale

At the L6/L7 level the interview question is never "can you implement a gRPC server." It is "how would you govern gRPC usage across 200 teams so the platform does not become a distributed monolith of incompatible contracts." The answers live in tooling, policy, and organizational design.

**ADR: Adopting gRPC as the internal RPC standard.** A well-formed ADR captures the forces in tension: binary serialization wins on throughput and payload size, but debugging is harder without tooling investment (you need `grpcurl`, `grpcui`, and OpenTelemetry before the platform is usable). The ADR should document the decision to require `buf` for linting and breaking-change detection in CI, the policy on gRPC-Gateway for external-facing transcoding, and the strategy for teams still on REST (migrate on new service boundaries, not forced rewrites).

**Proto governance as a platform concern.** At scale, proto files are not per-team assets. They are organizational contracts. The platform team owns the Buf Schema Registry (BSR) or an internal equivalent, enforces `FILE`-level breaking change detection on every PR, and gates merges on `buf lint` passing with the `DEFAULT` ruleset. The breaking-change policy needs to distinguish between internal services (can coordinate migrations) and external clients (must provide multi-version support windows). Staff engineers own the policy decision on which breaking-change categories block CI versus which emit warnings.

**Maturity model for gRPC platform adoption:**
- Level 0: Individual teams run `protoc` manually, generated code checked into source.
- Level 1: Centralized `buf generate` in CI, generated code excluded from source, BSR publishes versioned modules.
- Level 2: Breaking-change detection blocks merges. All services export RED metrics via shared interceptor library. Distributed tracing with `W3C traceparent` propagated in metadata.
- Level 3: xDS-based service discovery replaces DNS-based resolution. Per-service retry policy and timeout budgets are expressed in service config pushed from a control plane. Load balancing is health-aware with locality weighting.
- Level 4: Full zero-trust with mTLS between all services, service identity from SPIFFE/SPIRE, per-RPC RBAC enforced in a shared authz interceptor loaded from a policy store.

**Bar-raiser signals in a staff-level interview:** The bar-raiser is testing whether you think in fleet-wide impact. Proposals like "each team manages their own proto files" or "we'll add linting later" are red flags because they defer the cost of technical debt to a point where fixing it requires coordinated migration across hundreds of services. The correct posture is: establish governance at the platform layer before the first production service ships, because retrofitting contract enforcement onto 50 existing services is a multi-quarter program.

**L6/L7 concern: build vs. buy for the proto registry.** Buf Schema Registry is the obvious choice for most organizations. The staff-level question is whether the BSR's per-module access control, policy enforcement hooks, and generated SDK publishing meet your organization's compliance requirements (SOC 2, FedRAMP, data residency). If not, you need an internal registry, and the build cost must be weighed against the governance value. This is a canonical L7 "platform decision under uncertainty" problem: make the call, document the reasoning, and create the feedback loop that lets you revise it.

---
