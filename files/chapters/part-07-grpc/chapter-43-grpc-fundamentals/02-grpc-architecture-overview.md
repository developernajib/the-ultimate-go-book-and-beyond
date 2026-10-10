## gRPC Architecture Overview

The architecture diagram below shows how Protocol Buffers define the contract, how generated code provides type-safe stubs, and how the gRPC framework handles HTTP/2 multiplexing, flow control, and deadline propagation. Interceptors extend this pipeline with cross-cutting behavior on both the client and server sides.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         gRPC ARCHITECTURE                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        PROTOCOL STACK                                  │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │   ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │   │  Application Layer: gRPC Service Methods                        │  │  │
│  │   │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │  │  │
│  │   │  │ GetUser()   │ │ ListUsers() │ │ CreateUser()│                │  │  │
│  │   │  └─────────────┘ └─────────────┘ └─────────────┘                │  │  │
│  │   └─────────────────────────────────────────────────────────────────┘  │  │
│  │                               │                                        │  │
│  │                               ▼                                        │  │
│  │   ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │   │  Serialization: Protocol Buffers (Binary)                       │  │  │
│  │   │  • Schema-first design with .proto files                        │  │  │
│  │   │  • Auto-generated client/server stubs                           │  │  │
│  │   │  • ~10x smaller than JSON, ~10x faster                          │  │  │
│  │   └─────────────────────────────────────────────────────────────────┘  │  │
│  │                               │                                        │  │
│  │                               ▼                                        │  │
│  │   ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │   │  Transport: HTTP/2                                              │  │  │
│  │   │  • Multiplexed streams over single connection                   │  │  │
│  │   │  • Header compression (HPACK)                                   │  │  │
│  │   │  • Flow control, server push                                    │  │  │
│  │   │  • Persistent connections                                       │  │  │
│  │   └─────────────────────────────────────────────────────────────────┘  │  │
│  │                               │                                        │  │
│  │                               ▼                                        │  │
│  │   ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │   │  Security: TLS 1.2+                                             │  │  │
│  │   └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    gRPC COMMUNICATION PATTERNS                         │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  1. UNARY RPC                    2. SERVER STREAMING                   │  │
│  │  ┌────────┐      ┌────────┐      ┌────────┐      ┌────────┐            │  │
│  │  │ Client │─req─►│ Server │      │ Client │─req─►│ Server │            │  │
│  │  │        │◄─res─│        │      │        │◄─res─│        │            │  │
│  │  └────────┘      └────────┘      │        │◄─res─│        │            │  │
│  │  One request → One response      │        │◄─res─│        │            │  │
│  │                                  └────────┘      └────────┘            │  │
│  │                                  One request → Stream of responses     │  │
│  │                                                                        │  │
│  │  3. CLIENT STREAMING             4. BIDIRECTIONAL STREAMING            │  │
│  │  ┌────────┐      ┌────────┐      ┌────────┐      ┌────────┐            │  │
│  │  │ Client │─req─►│ Server │      │ Client │◄─────►│ Server │           │  │
│  │  │        │─req─►│        │      │        │ req/  │        │           │  │
│  │  │        │─req─►│        │      │        │ res   │        │           │  │
│  │  │        │◄─res─│        │      └────────┘      └────────┘            │  │
│  │  └────────┘      └────────┘      Both send streams independently       │  │
│  │  Stream of requests → One response                                     │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    PROTO FILE STRUCTURE                                │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  user/v1/user.proto                                                    │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │  │
│  │  │ syntax = "proto3";                                               │  │  │
│  │  │ package user.v1;                                                 │  │  │
│  │  │                                                                  │  │  │
│  │  │ message User {           // Data model                           │  │  │
│  │  │   string id = 1;         // Field number (not position)          │  │  │
│  │  │   string email = 2;                                              │  │  │
│  │  │ }                                                                │  │  │
│  │  │                                                                  │  │  │
│  │  │ message GetUserRequest {  // Request wrapper                     │  │  │
│  │  │   string id = 1;                                                 │  │  │
│  │  │ }                                                                │  │  │
│  │  │                                                                  │  │  │
│  │  │ service UserService {     // Service definition                  │  │  │
│  │  │   rpc GetUser(GetUserRequest) returns (User);                    │  │  │
│  │  │ }                                                                │  │  │
│  │  └──────────────────────────────────────────────────────────────────┘  │  │
│  │                               │                                        │  │
│  │                               ▼ protoc / buf                           │  │
│  │  Generated Code:                                                       │  │
│  │  ┌──────────────────────┐  ┌──────────────────────┐                    │  │
│  │  │ user.pb.go           │  │ user_grpc.pb.go      │                    │  │
│  │  │ - User struct        │  │ - UserServiceServer  │                    │  │
│  │  │ - GetUserRequest     │  │ - UserServiceClient  │                    │  │
│  │  │ - Serialization      │  │ - RegisterServer()   │                    │  │
│  │  └──────────────────────┘  └──────────────────────┘                    │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                  gRPC vs REST COMPARISON                               │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Aspect          │ gRPC                  │ REST/JSON                   │  │
│  │  ────────────────┼───────────────────────┼──────────────────────────── │  │
│  │  Serialization   │ Protocol Buffers      │ JSON/XML                    │  │
│  │  Transport       │ HTTP/2                │ HTTP/1.1 or HTTP/2          │  │
│  │  Contract        │ Strict (.proto)       │ Loose (OpenAPI optional)    │  │
│  │  Streaming       │ Native support        │ Requires WebSocket/SSE      │  │
│  │  Browser Support │ Requires proxy        │ Native                      │  │
│  │  Debugging       │ Requires tools        │ curl/browser                │  │
│  │  Payload Size    │ ~10x smaller          │ Larger (text-based)         │  │
│  │  Latency         │ Lower                 │ Higher                      │  │
│  │  Code Generation │ Required              │ Optional                    │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    gRPC STATUS CODES                                   │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Code                │ HTTP Equiv │ Use Case                           │  │
│  │  ────────────────────┼────────────┼──────────────────────────────────  │  │
│  │  OK (0)              │ 200        │ Success                            │  │
│  │  INVALID_ARGUMENT (3)│ 400        │ Client sent bad data               │  │
│  │  NOT_FOUND (5)       │ 404        │ Resource doesn't exist             │  │
│  │  ALREADY_EXISTS (6)  │ 409        │ Resource already exists            │  │
│  │  PERMISSION_DENIED(7)│ 403        │ No permission                      │  │
│  │  UNAUTHENTICATED(16) │ 401        │ Not logged in                      │  │
│  │  RESOURCE_EXHAUSTED  │ 429        │ Rate limited                       │  │
│  │  INTERNAL (13)       │ 500        │ Server error                       │  │
│  │  UNAVAILABLE (14)    │ 503        │ Service down (retry)               │  │
│  │  DEADLINE_EXCEEDED(4)│ 504        │ Timeout                            │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading the Architecture Diagram Like an Interviewer

The architecture diagram above is the single mental model you need for 80% of gRPC interview questions. Practice narrating each layer from the bottom up:

1. TLS provides the encrypted channel. Without it, metadata headers (including auth tokens) are plaintext.
2. HTTP/2 provides multiplexing. Each RPC is a stream with a numeric stream ID. Multiple streams share one TCP connection. This is why creating a new `ClientConn` per request is so wasteful: you discard the multiplexing advantage and pay TLS handshake overhead on every call.
3. Protocol Buffers handle serialization. The generated `.pb.go` file contains the `Marshal` and `Unmarshal` logic. You never call these directly in application code. The gRPC framework calls them when you return a response struct from a handler.
4. The service method layer is where your code lives. The generated `*_grpc.pb.go` file defines the interface you implement.

The gRPC vs REST comparison table at the bottom of the diagram contains one entry that juniors regularly get wrong in interviews: "Browser Support: Requires proxy." This matters for system design. If you choose gRPC for a public-facing API, you must either provide a gRPC-Gateway (REST/JSON transcoding) or a gRPC-Web proxy. Telling an interviewer "we'll use gRPC for the frontend too" without mentioning this gap is a red flag.

The status code table is your retry decision tree. Memorize three categories: codes that signal the client should retry with backoff (`UNAVAILABLE`, `RESOURCE_EXHAUSTED`), codes that signal the client made a mistake and should not retry (`INVALID_ARGUMENT`, `NOT_FOUND`, `UNAUTHENTICATED`), and codes that are ambiguous and require idempotency analysis before retrying (`INTERNAL`, `DEADLINE_EXCEEDED`).

### Senior @ FAANG: Architecture Decisions Hidden in the Diagram

The diagram presents the protocol stack as fixed. At the senior level, each layer boundary is an architectural decision point with trade-offs.

**TLS termination placement.** The diagram shows TLS at the transport layer. In a service mesh with sidecar proxies (Envoy/Linkerd), TLS terminates at the sidecar, and traffic between the sidecar and the application container is plaintext on localhost. This means the application does not manage certificates, rotation is handled by the mesh control plane (SPIFFE/SPIRE), and mTLS is automatic between all services. The ADR for this decision is: do we require application-level TLS configuration (operationally complex, consistent across all environments) or do we delegate to the mesh (simpler for applications, but the mesh becomes a critical dependency and a security boundary)? At L6+, you own this decision and its rollback plan.

**HTTP/2 flow control and backpressure.** The HTTP/2 layer has per-stream and per-connection flow control windows. The default window size is 65,535 bytes (about 64 KB). A server streaming RPC that sends large messages faster than the client consumes them will stall on the server-side `Send` call as the HTTP/2 window fills. Senior engineers must understand this when designing high-throughput streaming systems. Increasing window sizes (`grpc.InitialWindowSize`, `grpc.InitialConnWindowSize`) reduces stalls but increases buffering in the kernel, which can hide slow consumers and lead to large memory spikes under backpressure. The design question is always: do you want to buffer in the kernel (larger windows) or propagate backpressure into your application code (smaller windows with a producer that blocks on `Send`)?

**The generated code boundary as a governance point.** The diagram shows `.pb.go` and `_grpc.pb.go` as outputs. At the platform level, the generated code boundary is where you enforce organizational standards. Wrapper types around the generated client (as shown in the diagram's client struct pattern) let you inject circuit breakers, rate limiters, and observability without requiring each team to configure them independently. The platform team publishes the wrapper. Teams consume the wrapper, not the raw generated client. This is the Repository pattern applied to RPC clients, and it is the correct L6 abstraction boundary.

**Status code semantics as an organizational contract.** The status code table must be enforced as a shared standard, not individual team preference. When one team uses `FAILED_PRECONDITION` for "user account locked" and another uses `PERMISSION_DENIED` for the same condition, client teams cannot write generic error handling logic. The platform team should publish a decision guide that maps common domain conditions (not found, access denied, rate limited, temporarily unavailable) to canonical status codes, review that guide during API review, and enforce it via linting rules in the proto review pipeline.

---
