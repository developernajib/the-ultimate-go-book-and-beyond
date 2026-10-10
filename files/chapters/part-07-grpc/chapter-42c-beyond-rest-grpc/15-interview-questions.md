## Interview Questions

**Q: When would you choose gRPC over REST?**

A: Choose gRPC for: (1) internal microservice communication where you control both sides, (2) high-throughput APIs where Protocol Buffers' binary encoding saves 30-50% bandwidth vs JSON, (3) streaming requirements (server/client/bidirectional), (4) strongly-typed contracts that generate client code in multiple languages, (5) when you need multiplexed streams over HTTP/2. Stick with REST for: public APIs consumed by browsers, simple CRUD with low traffic, or teams without protobuf tooling.

*What FAANG expects:* A business-versus-engineering tradeoff, not a religious answer. They want to hear that you consider audience (internal vs third-party), operational cost of codegen pipelines, the maturity of protobuf tooling in your org, and that you are comfortable with Connect or grpc-gateway when a single service needs to serve both a browser and internal callers.

*Follow-ups:*
- How would you migrate a REST service to gRPC without a flag day? (grpc-gateway / Connect dual-protocol, version parity, shadow traffic)
- What are the costs of gRPC that REST avoids? (debuggability, observability tooling gaps, HTTP/2 proxy quirks, binary payloads in logs)
- How do you expose a gRPC service to browser clients in 2026? (Connect-Go single handler serves Connect + gRPC + gRPC-Web. Envoy is no longer required)

---

**Q: How do you prevent N+1 queries in GraphQL?**

A: The DataLoader pattern: instead of each resolver independently querying the database, DataLoader collects all IDs in a batch window (typically 1ms or end of request), fires a single batched query, and distributes results. Without DataLoader a page of 20 orders with 3 items each = 1 + 20×3 = 61 queries. With DataLoader: 1 (orders) + 1 (batch all product IDs) = 2 queries.

*What FAANG expects:* That you understand the root cause (per-field resolver fan-out, no query planner), that you can reason about the batch window vs latency tradeoff, and that you know DataLoader is *per-request* to avoid cross-request cache poisoning.

*Follow-ups:*
- Why is DataLoader scoped per-request and not global? (auth boundaries, stale data, memory growth)
- How do you detect N+1 in production? (per-request DB query counter, OpenTelemetry span count per GraphQL op, APM query analysis)
- What about persisted queries and APQ? (limits attack surface + reduces payload size for mobile)

---

**Q: What's the difference between gRPC server streaming and WebSockets?**

A: **gRPC server streaming** is unidirectional server→client over HTTP/2 - the client sends one request and receives a stream of typed responses. Schema-driven, generated client, best for service-to-service. **WebSockets** are full-duplex, protocol-agnostic, work natively in browsers, and are better when the client needs to send multiple messages after the handshake (chat, collaborative editing, gaming). Use gRPC streaming for typed service-to-service streams. WebSockets for interactive browser applications.

*What FAANG expects:* You pick the transport based on client identity (browser vs service), direction (push vs duplex), and payload (typed vs opaque). Bonus: mention SSE for pure server-push to browsers because it's simpler and proxy-friendlier than WebSocket.

*Follow-ups:*
- How do you handle backpressure in each? (gRPC flow control via HTTP/2 windows. WebSocket requires application-level buffering)
- What happens on a network blip? (gRPC: reconnect + re-auth + resume. WebSocket: manual reconnect + replay. SSE: auto-reconnect via `Last-Event-ID`)
- When would you pick gRPC-Web or Connect over WebSocket? (typed schema + generated client for the browser without losing the gRPC contract)

---

**Q: How do you handle backward compatibility in Protocol Buffers?**

A: Three rules: (1) Never change a field number - it is the wire identity of a field, not the name. (2) Never reuse a deleted field number - add `reserved` statements to prevent this. (3) New fields in proto3 are optional with zero-value defaults, so adding them is always safe for existing clients. Breaking changes include: changing field types incompatibly, removing required fields (proto2), changing `oneof` structure. Use `buf breaking` in CI to catch violations automatically.

*What FAANG expects:* Precise language - they want to hear "field number is wire identity" and "reserved prevents accidental reuse." They also want to see that you know about Protobuf Editions (2023+) replacing `syntax = "proto3"`, where presence, enum openness, and other behaviors are controlled per-field via `features`.

*Follow-ups:*
- How do Editions change the compatibility story? (same wire format. `features.field_presence` controls whether absence is distinguishable from zero)
- What is an "unknown field" and why does preserving it matter? (round-tripping through a middlebox that doesn't know the new field)
- How do you version a gRPC service at scale? (package versioning: `order.v1`, `order.v2`, and never break v1 while v2 exists)

---

**Q: When would you use SSE vs WebSocket for a notification system?**

A: If notifications only flow server→client (stock tickers, activity feeds, order status updates), use SSE. It's simpler, works over HTTP/1.1, auto-reconnects with `Last-Event-ID`, and is proxy-friendly. If the client also needs to send messages to the server (acknowledge, filter, heartbeat at the application layer), use WebSocket. For a notification system where the backend pushes events and the client only reads, SSE is the right choice.

*What FAANG expects:* A defensible pick based on directionality and a cost analysis: SSE is cheaper to operate (stateless HTTP, load-balancer friendly, CDN-cacheable at the edge for public feeds), WebSocket demands sticky routing and higher per-connection cost.

*Follow-ups:*
- How do you scale 1M concurrent SSE connections? (many small pods behind an L4 LB, shard by user, pub/sub fanout via Redis Streams or NATS)
- What prevents a proxy from buffering SSE? (`Content-Type: text/event-stream`, `X-Accel-Buffering: no` for nginx, frequent flushes, keep-alive comments)
- How do you replay missed events on reconnect? (durable event store keyed by `Last-Event-ID`, bounded retention window)

---

**Q: What is mTLS and when should you use it for gRPC services?**

A: Mutual TLS requires both client and server to present a certificate signed by a shared CA. The server proves its identity to the client, and the client also proves its identity to the server - the server can extract the client's `Subject.CommonName` (or preferably a SPIFFE URI SAN) from the peer certificate and use it as an authenticated service identity without any application-level token. Use mTLS for service-to-service gRPC in a zero-trust network where you cannot rely on network-level isolation. In Kubernetes, tools like cert-manager, SPIRE, or a service mesh (Istio, Linkerd) automate issuance and rotation.

*What FAANG expects:* You understand mTLS gives you **service identity**, not a user identity. That CommonName is weak and SPIFFE IDs are the modern primitive. And that cert rotation must be automated because long-lived certs are a worse failure mode than rotation bugs.

*Follow-ups:*
- Why SPIFFE over CommonName? (URI SAN, intentionally short-lived, issued by a workload API, no cross-cluster trust anchor needed)
- Who authorizes the call after mTLS has authenticated it? (service-level RBAC via policy engine - OPA, Istio AuthorizationPolicy - or application-level check on the SPIFFE ID)
- How do you debug an mTLS failure in prod? (`grpcurl -insecure` is wrong. Use `openssl s_client -connect`, inspect cert chain, check clock skew, check CA trust bundle)

---

**Q: What is the Connect protocol and why would you use it instead of plain gRPC?**

A: Connect (from Buf) is a protocol that is backward compatible with gRPC but adds first-class HTTP/1.1 support and a JSON-friendly framing mode. A single `connect-go` handler serves Connect, standard gRPC, and gRPC-Web on the same port - no Envoy, no side-car. Browser clients call it directly with `fetch()`, and internal services keep speaking gRPC unchanged. debugging is `curl -H 'Content-Type: application/json'`. Use Connect when you need browser clients to call protobuf-defined services, or want curl-debuggable JSON endpoints alongside binary gRPC for internal callers.

*What FAANG expects:* Clarity that Connect is a protocol *plus* a server implementation that triple-speaks (Connect + gRPC + gRPC-Web) from one handler, and that this obsoletes the typical `Envoy → gRPC` topology for most web apps. Bonus for mentioning schema codegen via `buf generate`.

*Follow-ups:*
- How does Connect's streaming differ from gRPC's? (Connect supports server-streaming over HTTP/1.1 via chunked transfer. bidi streaming still requires HTTP/2)
- What does this mean for operators? (no proxy needed, fewer moving parts. But you lose Envoy's L7 features - decide per org)
- How does Connect handle errors? (`Status` with code + message + details. wire-compatible with `google.rpc.Status` for gRPC-originated calls)

---

**Q: How does gRPC deadline propagation work and why does it matter?**

A: When a gRPC client sets a deadline on a call (via `ctx`), the deadline is transmitted to the server as a `grpc-timeout` header. The server's context inherits this deadline, so `ctx.Done()` fires on the server side when the client's deadline expires - even if the server is still processing. This prevents wasted work: if the client has already timed out, the server should stop. Always check `ctx.Err()` in long-running handlers and propagate the same context to downstream calls so the entire chain cancels together.

*What FAANG expects:* You see deadlines as a **whole-system property**: one number set at the ingress flows through every downstream hop and each hop decrements its budget before making its own calls. Without propagation, backend timeouts are tuned in isolation and you see cascading timeouts under load.

*Follow-ups:*
- What happens if a hop does `context.Background()` instead of forwarding `ctx`? (deadline detached. Load amplification under failure. classic outage root cause)
- How do you budget deadlines across a fan-out call? (subtract expected local work, divide remainder by parallel downstreams, or use a shorter-of-N strategy)
- How do you observe deadline exhaustion? (`codes.DeadlineExceeded` rate per method, p99 latency near the client deadline, `grpc-timeout` header in traces)

---

**Q: How do you build health checks and graceful shutdown for a production gRPC service?**

A: Register `grpc.health.v1.Health` on the server. Kubernetes liveness/readiness probes speak gRPC natively (`livenessProbe.grpc`), and `grpc-health-probe` is the standard sidecar for environments that don't. On SIGTERM, flip the health server to `NOT_SERVING` first so load balancers stop sending new traffic, wait a few seconds for propagation, then call `server.GracefulStop()` to drain in-flight RPCs. Add a `preStop` sleep in the pod spec so the endpoint controller has time to remove the pod from service endpoints before the container starts draining.

*What FAANG expects:* The ordering (NOT_SERVING → wait → GracefulStop), awareness that LB convergence is not instantaneous, and that drain timeouts must be bounded so a stuck stream doesn't block rollout indefinitely.

*Follow-ups:*
- What if a streaming RPC refuses to close during drain? (hard timeout + force stop. cancel the stream's context. Log for investigation)
- Why is `NOT_SERVING` necessary if K8s already removes the pod? (race window - readiness probe cycle + endpoints propagation can exceed SIGTERM timing)
- How do you distinguish liveness from readiness for gRPC? (liveness = process is up. Readiness = dependencies healthy and service should receive traffic)

---

**Q: How do you return rich, machine-readable errors from gRPC?**

A: `status.Error(codes.X, msg)` gives you the code plus a human message. For structured detail use `status.New(...).WithDetails(...)` and attach protos from `google.rpc.error_details` (e.g., `BadRequest` with per-field violations, `RetryInfo` with a retry delay, `QuotaFailure`, `PreconditionFailure`). The client reads the typed details via `status.Convert(err).Details()` and can branch on field-level errors without parsing strings. Never leak internal errors - map domain errors to a specific code and return a sanitized message.

*What FAANG expects:* That you know `google.rpc.Status` is the wire format behind `status.Error`, that rich details are opt-in, and that you never return `codes.Internal` for everything - specific codes (`NotFound`, `InvalidArgument`, `PermissionDenied`, `ResourceExhausted`, `FailedPrecondition`) make client logic tractable.

*Follow-ups:*
- When to use `FailedPrecondition` vs `InvalidArgument`? (FP: server state wrong, like "account frozen". IA: request shape wrong, like "email missing")
- How do rich error details interact with API gateways? (gateway must preserve the details proto when translating to HTTP. Most do via trailers)
- What's your retry-safety classification? (retryable: `Unavailable`, `DeadlineExceeded` (careful), `ResourceExhausted` with RetryInfo. Non-retryable: `InvalidArgument`, `FailedPrecondition`, `PermissionDenied`)

---

### Junior → FAANG: How to Approach gRPC Interview Questions

FAANG gRPC interview questions at the junior-to-mid level test two things: whether you have hands-on experience implementing these patterns in practice (not just reading about them), and whether you can explain trade-offs rather than memorizing answers.

For the "gRPC vs REST" question, the failure mode is giving a binary answer. Interviewers at FAANG probe for nuance: "I use gRPC for internal services but REST for the public API because external partners cannot take a code generation dependency on our proto files." That reasoning process signals production experience.

For the N+1 question, be ready to demonstrate the math concretely. An interviewer who asks "how does DataLoader prevent N+1" wants to hear you walk through the query count with and without DataLoader, not just say "it batches queries." Batching is the mechanism. The consequence is reducing 61 queries to 2. Concrete numbers show you understand the problem, not just the solution.

For error handling questions, practice distinguishing codes without pausing. Being able to say immediately "that would be `codes.FailedPrecondition` because the account exists but is in a state that prevents the operation, versus `codes.InvalidArgument` which is for malformed input" shows genuine familiarity with the API.

Prepare for follow-up questions that go one level deeper on every topic. FAANG interviews follow the pattern: state a correct answer, then receive a follow-up that probes whether you actually understand it or memorized it. The follow-ups listed after each question in this section are realistic examples of where the conversation goes.

### Senior @ FAANG: Bar-Raiser Signals in gRPC System Design Interviews

At the senior and staff level, gRPC interview questions are typically embedded in system design interviews rather than standalone protocol questions. The signal that interviewers at FAANG look for is whether you naturally apply gRPC principles as part of a larger system design, rather than being prompted to consider them.

In a system design interview for a real-time order tracking system, a bar-raiser candidate volunteers: "for the internal event pipeline between order service and notification service, I would use gRPC server streaming rather than polling, because it eliminates the polling overhead and the schema contract ensures the event type is always valid. For the browser-facing push, I would use SSE because it auto-reconnects and the browser does not need to send events back to the server." That proactive protocol selection with justification is a bar-raiser signal.

For backward compatibility questions, bar-raiser answers include the organizational mechanism, not just the technical mechanism. "I would add `buf breaking` to CI so the schema registry rejects breaking changes before they reach production, and adopt a package versioning policy where breaking changes require a new package version (`order.v2`) with a defined deprecation window for v1" is more complete than "I would use `reserved` fields and not reuse field numbers."

For the mTLS question at staff level, the expected depth includes: who operates the CA, how certs are rotated automatically, how you authorize a specific workload identity after authentication, and what the blast radius is if the CA is compromised. A candidate who answers all of these without being prompted has demonstrated staff-level security architecture thinking.

The deadline propagation question is a strong discriminator at senior level. Candidates who understand that deadline propagation is a whole-system property and can describe a real outage pattern (one service not forwarding context causes cascading timeouts when that service is slow under load) demonstrate production experience that cannot be faked from reading documentation.
