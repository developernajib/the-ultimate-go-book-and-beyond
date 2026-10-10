# Chapter 42C: Beyond REST - gRPC, GraphQL, WebSocket, and Protocol Selection

> REST is a great default, but defaults are not destinations. At the boundary where services talk to each other a thousand times a second, protocol choice is architecture.

REST over JSON became the default API protocol not because it is optimal but because it is universally accessible. Any HTTP client, any browser, any curl invocation can speak REST without any shared schema or generated code. That accessibility is enormously valuable when you are building a public API consumed by developers you have never met, running tools you cannot control. It is significantly less valuable - and carries real costs - when both sides of the connection are services you own and deploy, written in typed languages, running in the same data center or the same Kubernetes cluster.

The costs of REST between internal services are not hypothetical. JSON serialization is slower than binary encoding by a factor of three to ten times for equivalent payloads, and it allocates heavily - every field name is a string, every number is a string, and the entire payload must be parsed before any field is accessible. HTTP/1.1 multiplexing limitations mean that high-throughput service-to-service calls pay connection overhead at a rate that binary protocols over HTTP/2 do not. The absence of a shared schema contract means that a field rename in a producer silently breaks consumers in ways that no compiler or linter catches until a runtime error surfaces in production. These are concrete engineering problems with concrete costs: latency budgets exceeded, CPU time spent on serialization instead of business logic, and integration bugs that escape to production because no tooling existed to catch them.

gRPC solves all of these problems simultaneously. Protocol Buffers provide a strongly-typed, backward-compatible schema contract that generates idiomatic client and server code in every major language. HTTP/2 multiplexing eliminates per-request connection overhead and enables bidirectional streaming as a first-class primitive, not an afterthought. The generated code means that a breaking change in a `.proto` file produces a compile error in every service that imports it, before a single byte is transmitted at runtime. This combination - type safety, binary efficiency, streaming, and code generation - is why gRPC became the dominant internal RPC protocol at Google, Uber, Netflix, Square, and most organizations running microservices at serious scale.

**What you'll learn in this chapter:**

- Why Protocol Buffers outperform JSON for service-to-service communication and how to design `.proto` schemas for backward and forward compatibility
- How HTTP/2 multiplexing, header compression, and flow control work and why they make gRPC fundamentally more efficient than REST for high-throughput internal traffic
- How to implement all four gRPC streaming patterns - unary, server streaming, client streaming, and bidirectional streaming - with correct error handling and cancellation
- How to build production gRPC interceptors for authentication, tracing, rate limiting, and structured logging
- How to design GraphQL APIs in Go with efficient resolver patterns, the N+1 problem, and dataloader-based batching
- How to implement WebSocket and Server-Sent Events handlers for real-time push scenarios and when to choose each over the other
- How to build an API gateway that routes, transcodes, and enforces policy across REST, gRPC, and GraphQL endpoints simultaneously
- How to make protocol selection decisions based on concrete criteria: audience, payload shape, latency requirements, streaming needs, and schema stability

**Why this matters at scale:**

Google's internal systems have used Protocol Buffers since 2001 and the Stubby RPC framework nearly as long. The public gRPC release in 2015 was the productization of lessons learned running billions of RPCs per second at planetary scale. Uber moved its service-to-service communication onto gRPC as it outgrew its earlier JSON and TChannel RPC layers, and binary serialization is a large part of why: at millions of calls per second, JSON encode/decode alone is a CPU line item. Netflix publicly adopted gRPC for inter-service IPC and built its Ribbon-successor client tooling around it. And the proto-first pattern, define the schema in Protocol Buffers, generate gRPC for internal callers and REST transcoding for external ones, is now the standard way platform teams get type safety inside without sacrificing accessibility outside.

**Prerequisites:** Chapters 29-42B (HTTP server fundamentals, middleware patterns, service architecture). Familiarity with `net/http`, context propagation, and basic protobuf syntax is assumed. Chapter 38 (REST API fundamentals) should be completed first.

---

### Junior → FAANG: Understanding Why Protocol Choice Is an Architectural Decision

Many developers fresh to distributed systems treat REST as a universal default and view gRPC as an "advanced" option reserved for specialists. That framing misses the actual principle: every protocol encodes assumptions about who is calling, how often, what the payload looks like, and what kind of schema contract is acceptable. REST assumes schema-less, human-readable JSON is fine and that callers may not share your code or toolchain. gRPC assumes both sides share a `.proto` contract and are compiled against it. Those assumptions produce radically different failure modes.

The first-job habit to build is linking protocol selection to concrete requirements before writing a line of code. Ask: is the caller a browser, a partner's API client, or a service we own? Is this internal traffic measured in thousands of calls per second, or a public webhook? Does schema stability matter, or is the payload flexible by design? These questions have concrete answers that point to a protocol choice.

For interviews at the junior-to-mid level, the framing FAANG interviewers want is "I chose gRPC because both services are internal, the payload is fixed, we needed streaming, and we own the toolchain" rather than "I used REST because that's what I know." The ability to articulate trade-offs between two defensible options is more valued than knowing every gRPC API call.

A worked mental model: imagine an e-commerce platform. The public checkout API that partners integrate against is REST because they need curl-compatibility and no generated client dependency. The internal inventory-to-warehouse service that processes 50,000 events per minute is gRPC because binary serialization, HTTP/2 multiplexing, and a typed schema catching breaking changes at compile time are worth the additional toolchain complexity.

### Senior @ FAANG: Protocol Governance, Platform Thinking, and Migration Strategy at Scale

At senior and staff level, the question is not "which protocol should I choose for this service" but "how does the platform enforce consistent protocol usage across hundreds of services, reduce the cost of adopting gRPC for teams that have no protobuf experience, and ensure that protocol choices made today do not produce expensive migrations in two years."

This is a governance and platform problem. Google Cloud's approach of using Protocol Buffers as the schema of record with REST transcoding generated from `google.api.http` annotations is an ADR worth studying: it preserves protobuf type safety for internal traffic while generating REST-compatible endpoints for external consumers, avoiding the dual-maintenance problem of keeping a protobuf schema and a hand-written OpenAPI spec in sync. The decision to adopt this pattern is a platform-level commitment, not a per-team choice.

A mature organization operates a buf schema registry (BSR) or equivalent: a central repository where all `.proto` files are versioned, linted on CI via `buf lint`, and breaking-change-checked via `buf breaking` against the previous version before any merge. This registry becomes the contract between producer and consumer teams. Without it, schema drift is caught at runtime rather than at commit time, and the cost of a breaking change is discovered in production.

For L6/L7 thinking, consider the migration surface: a fleet of 200 REST services converting to gRPC is a multi-year program. The pragmatic approach is the strangler fig pattern at the protocol layer: deploy a Connect or grpc-gateway server that speaks both REST and gRPC on the same handler, route new internal traffic to the gRPC path, keep the REST path alive for existing consumers, and retire REST when all consumers have migrated. This approach requires buy-in from platform, SRE, and API governance because it adds operational complexity during the transition window. The ADR for this decision must capture the migration timeline, rollback criteria, and deprecation policy for the REST path.

Bar-raiser signals at interview: candidates who frame this as a platform decision with explicit governance mechanisms (schema registry, breaking-change CI gates, migration maturity model, deprecation runbooks) rather than an individual service decision. The question "how do you scale this decision to 50 teams" separates staff-level thinking from senior-level thinking.
