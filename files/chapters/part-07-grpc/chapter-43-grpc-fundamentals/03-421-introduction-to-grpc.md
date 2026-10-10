## 43.1 Introduction to gRPC

### Why gRPC?

gRPC uses HTTP/2 multiplexing so thousands of concurrent RPCs share one TCP connection without head-of-line blocking, and Protocol Buffers serialization produces messages 3-10× smaller than equivalent JSON. The `.proto` file serves as the single source of truth for both server and client code, and `protoc` generates type-safe stubs that eliminate an entire class of integration bugs at compile time.

```go
package main

/*
gRPC Advantages over REST:

1. Performance
   - Binary serialization (Protocol Buffers)
   - HTTP/2 multiplexing
   - Smaller payload sizes
   - Persistent connections

2. Strong Typing
   - Schema-first design
   - Generated type-safe code
   - Compile-time validation
   - No runtime surprises

3. Streaming
   - Bidirectional streaming
   - Server-side streaming
   - Client-side streaming
   - Real-time data flows

4. Code Generation
   - Auto-generated client/server code
   - Multiple language support
   - Consistent APIs across services

5. Built-in Features
   - Deadlines/timeouts
   - Cancellation
   - Interceptors (middleware)
   - Load balancing
*/

/*
When to Use gRPC:

✓ Microservice-to-microservice communication
✓ Low-latency, high-throughput systems
✓ Polyglot environments
✓ Streaming data
✓ Internal APIs

When REST might be better:

✓ Public APIs (browser support)
✓ Simple CRUD operations
✓ Human-readable debugging
✓ Hypermedia/HATEOAS requirements
*/
```

### gRPC Communication Patterns

gRPC supports four communication patterns. Unary is one request followed by one response - the most common pattern, analogous to a function call. Server streaming sends one request and receives multiple responses, useful for paginated results or event subscriptions. Client streaming sends multiple requests and receives a single response, suited for file uploads or batch ingestion. Bidirectional streaming lets both sides send independently, enabling real-time interactive protocols like chat. The pattern is declared in the `.proto` service definition using the `stream` keyword on request or response types.

```go
package main

/*
gRPC Communication Patterns:

1. Unary RPC
   Client sends one request, server sends one response
   Like a function call
   Example: GetUser(id) -> User

2. Server Streaming RPC
   Client sends one request, server sends stream of responses
   Example: ListUsers(filter) -> stream User

3. Client Streaming RPC
   Client sends stream of requests, server sends one response
   Example: stream UploadChunk -> UploadResult

4. Bidirectional Streaming RPC
   Both client and server send streams
   Example: stream ChatMessage <-> stream ChatMessage
*/
```

### Junior → FAANG: Internalizing When to Use Each Pattern

The four patterns are not equally useful in practice. Unary handles roughly 70-80% of real-world gRPC use cases. The key interview mistake is reaching for bidirectional streaming by default because it sounds powerful.

A decision framework that works in interviews: start with unary. Upgrade only when you have a specific reason.

- Upgrade to server streaming when the response is a collection that could be very large (thousands of items), when the client can begin processing individual items before the full list is ready (reducing first-byte latency), or when the server pushes updates to the client over a long-lived subscription.
- Upgrade to client streaming when the client has a collection to send (bulk insert, file upload in chunks) and sending it as one giant message would exceed the message size limit or produce unacceptable memory pressure.
- Upgrade to bidirectional streaming only when both sides need to send data independently and concurrently, and the session has meaningful per-connection state that makes reconnection expensive. Chat and real-time gaming are the canonical examples.

A first-job habit: read the "When REST might be better" list in the code comment above. Many teams default to gRPC because it is newer, but if your API has public browser consumers or is inherently CRUD with hypermedia links, REST is the correct choice. Knowing when not to use a technology is a signal of engineering maturity that FAANG interviewers notice.

For the "When to Use gRPC" list: the most important entry is "Polyglot environments." The proto contract generates type-safe stubs in Go, Java, Python, and a dozen other languages from one source file. In a REST-only world, each client team maintains its own SDK or hand-rolls HTTP calls against documentation. Proto-generated stubs eliminate this divergence and give you compile-time breakage instead of runtime surprises when the server changes a field.

### Senior @ FAANG: Protocol Selection as an Architectural Decision Record

Choosing between gRPC and REST (or GraphQL, or NATS, or Kafka) is an architectural decision that should be documented, not debated ad hoc. At the L6 level you are expected to produce ADRs that teams can reference for months after you have moved on to other work.

**Forces in a gRPC adoption ADR:**
- Performance: binary framing and connection multiplexing reduce latency and bandwidth at high request rates. The benefit is measurable but only significant above a threshold (roughly 1,000+ RPS per service pair). Below that threshold, REST's debugging simplicity often wins.
- Type safety: generated stubs enforce the contract at compile time. This is especially valuable in a polyglot organization where Java, Go, and Python services call each other. A mismatched field type in a REST API surfaces as a runtime `400` or a null pointer. In a proto contract it surfaces as a `protoc` compile error before any code deploys.
- Browser support: gRPC requires a proxy or gRPC-Web for browser clients. If your organization has browser-facing APIs, the ADR must address transcoding (gRPC-Gateway, Envoy's gRPC-JSON transcoder) or a dual-stack decision (gRPC internally, REST externally).
- Operational complexity: `grpcurl` and `grpcui` are necessary for debugging, and they require reflection to be enabled on the server. Reflection must be disabled in production for security reasons (it exposes the full service schema). Teams need internal tooling to bridge this gap.

**Pattern selection at the fleet level.** When you own a platform used by dozens of services, the streaming pattern question becomes a governance question. Bidirectional streaming RPCs cannot be load-balanced by L4/L7 proxies that do not understand HTTP/2 streams. Each streaming connection is pinned to one backend. If your platform uses DNS-round-robin or a classic load balancer (AWS ALB in HTTP mode), a service that introduces bidirectional streaming will silently bypass load balancing and pin traffic to single backends. The platform team must document this constraint and provide guidance: either use a service mesh (Envoy/Linkerd) that balances at the stream level, or restrict bidirectional streaming to stateful services where pinning is intentional.

**Maturity signal for L7:** You can explain the difference between load-balancing HTTP/2 connections (L4, incorrect for gRPC) and load-balancing HTTP/2 streams (L7, correct for gRPC), and you have a recommendation for which infrastructure component in your organization's stack provides correct gRPC load balancing today. If none does, you have a written plan to close that gap.

---
