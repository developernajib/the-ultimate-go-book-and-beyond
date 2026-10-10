## Architecture Overview

The gRPC-Gateway pattern runs a generated HTTP/JSON reverse proxy in the same process as the gRPC server, sharing the same handler logic. REST clients send HTTP requests to the gateway mux, which transcodes them to gRPC calls over a loopback or in-process connection. gRPC clients connect directly to the gRPC port, bypassing the mux entirely.

```
gRPC-Gateway Architecture
=========================

Request Flow:
┌──────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                │
├───────────────────────────────┬──────────────────────────────────────────┤
│     Browser/Mobile App        │         Backend Service                  │
│     (REST/HTTP Client)        │         (gRPC Client)                    │
└───────────────┬───────────────┴──────────────────┬───────────────────────┘
                │                                   │
                │ HTTP/1.1 + JSON                   │ HTTP/2 + Protobuf
                ▼                                   │
┌───────────────────────────────────────────────────│───────────────────────┐
│                         GATEWAY LAYER             │                       │
├───────────────────────────────────────────────────│───────────────────────┤
│  ┌─────────────────────────────────────────────┐  │                       │
│  │            HTTP Server (:8080)              │  │                       │
│  │  ┌───────────────────────────────────────┐  │  │                       │
│  │  │     Middleware Chain                  │  │  │                       │
│  │  │  ┌─────────────────────────────────┐  │  │  │                       │
│  │  │  │ CORS → Auth → Rate Limit → Log  │  │  │ │                        │
│  │  │  └─────────────────────────────────┘  │  │  │                       │
│  │  └───────────────────────────────────────┘  │  │                       │
│  │  ┌───────────────────────────────────────┐  │  │                       │
│  │  │     runtime.ServeMux (gRPC-Gateway)   │  │ │                        │
│  │  │  ┌─────────────────────────────────┐  │  │  │                       │
│  │  │  │ URL Pattern Matching            │  │  │  │                       │
│  │  │  │ JSON → Protobuf Transcoding     │  │  │  │                       │
│  │  │  │ Query Param → Field Mapping     │  │  │  │                       │
│  │  │  │ Header → Metadata Forwarding    │  │  │  │                       │
│  │  │  └─────────────────────────────────┘  │  │  │                       │
│  │  └───────────────────────────────────────┘  │  │                       │
│  └──────────────────────┬──────────────────────┘  │                       │
│                         │ gRPC Call               │                       │
│                         ▼                         ▼                       │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │                    gRPC Server (:50051)                           │    │
│  │  ┌─────────────────────────────────────────────────────────────┐  │    │
│  │  │ Interceptor Chain: Trace → Auth → Validate → Log            │  │    │
│  │  └─────────────────────────────────────────────────────────────┘  │    │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐   │    │
│  │  │UserService  │ │OrderService │ │PaymentSvc   │ │MoreServices│   │    │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └────────────┘   │    │
│  └───────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘

HTTP Annotation Mapping:
┌──────────────────────────────────────────────────────────────────────────┐
│  Proto Definition                    │  HTTP Endpoint                    │
├──────────────────────────────────────┼───────────────────────────────────┤
│  rpc GetUser(GetUserRequest)         │  GET /api/v1/users/{id}           │
│    option: get: "/api/v1/users/{id}" │       Path param → request.id     │
├──────────────────────────────────────┼───────────────────────────────────┤
│  rpc ListUsers(ListUsersRequest)     │  GET /api/v1/users?status=active  │
│    option: get: "/api/v1/users"      │       Query param → request.status│
├──────────────────────────────────────┼───────────────────────────────────┤
│  rpc CreateUser(CreateUserRequest)   │  POST /api/v1/users               │
│    option: post + body: "*"          │       JSON body → request fields  │
├──────────────────────────────────────┼───────────────────────────────────┤
│  rpc UpdateUser(UpdateUserRequest)   │  PATCH /api/v1/users/{id}         │
│    option: patch + body: "user"      │       Path + partial body → req   │
├──────────────────────────────────────┼───────────────────────────────────┤
│  rpc DeleteUser(DeleteUserRequest)   │  DELETE /api/v1/users/{id}        │
│    option: delete: "/users/{id}"     │       Path param → request.id     │
└──────────────────────────────────────┴───────────────────────────────────┘

Transcoding Process:
┌───────────────────────────────────────────────────────────────────────┐
│  Step 1: HTTP Request Received                                        │
│  POST /api/v1/users HTTP/1.1                                          │
│  Content-Type: application/json                                       │
│  Authorization: Bearer eyJhbGc...                                     │
│  X-Request-ID: req-12345                                              │
│  {"email": "user@example.com", "name": "John Doe"}                    │
├───────────────────────────────────────────────────────────────────────┤
│  Step 2: Gateway Processing                                           │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ 1. Match URL pattern to RPC method (CreateUser)                 │  │
│  │ 2. Extract path parameters (none in this case)                  │  │
│  │ 3. Parse query parameters (none in this case)                   │  │
│  │ 4. Unmarshal JSON body to CreateUserRequest proto               │  │
│  │ 5. Convert HTTP headers to gRPC metadata                        │  │
│  │    Authorization → :authorization                               │  │
│  │    X-Request-ID → x-request-id                                  │  │
│  └─────────────────────────────────────────────────────────────────┘  │
├───────────────────────────────────────────────────────────────────────┤
│  Step 3: gRPC Call                                                    │
│  CreateUserRequest{                                                   │
│    email: "user@example.com",                                         │
│    name: "John Doe",                                                  │
│  }                                                                    │
│  Metadata: {                                                          │
│    "authorization": "Bearer eyJhbGc...",                              │
│    "x-request-id": "req-12345",                                       │
│  }                                                                    │
├───────────────────────────────────────────────────────────────────────┤
│  Step 4: gRPC Response                                                │
│  CreateUserResponse{                                                  │
│    user: User{id: "usr-123", email: "...", name: "..."}               │
│  }                                                                    │
│  Trailer: {"x-trace-id": "trace-abc"}                                 │
├───────────────────────────────────────────────────────────────────────┤
│  Step 5: HTTP Response                                                │
│  HTTP/1.1 200 OK                                                      │
│  Content-Type: application/json                                       │
│  X-Trace-ID: trace-abc                                                │
│  {"user": {"id": "usr-123", "email": "...", "name": "..."}}           │
└───────────────────────────────────────────────────────────────────────┘

Streaming Bridges:
┌───────────────────────────────────────────────────────────────────────┐
│                    Server-Sent Events (SSE)                           │
│                                                                       │
│  Browser                    Gateway                 gRPC Server       │
│     │                          │                         │            │
│     │──GET /events/stream────► │                         │            │
│     │                          │──WatchEvents(req)─────► │            │
│     │                          │                         │            │
│     │◄─event: update───────────│◄─Event{type: "update"}──│            │
│     │  data: {"id": "1"}       │                         │            │
│     │                          │                         │            │
│     │◄─event: delete───────────│◄─Event{type: "delete"}──│            │
│     │  data: {"id": "2"}       │                         │            │
│     │                          │                         │            │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│                    WebSocket Bridge                                   │
│                                                                       │
│  Browser                    Gateway                 gRPC Server       │
│     │                          │                         │            │
│     │──WS Upgrade──────────► │                         │              │
│     │◄─101 Switching─────────│                         │              │
│     │                          │──Chat(stream)─────────► │            │
│     │                          │                         │            │
│     │──{msg: "hello"}────────► │──ChatMessage──────────► │            │
│     │                          │                         │            │
│     │◄─{msg: "world"}──────────│◄─ChatMessage────────────│            │
│     │                          │                         │            │
│     │──{msg: "foo"}──────────► │──ChatMessage──────────► │            │
│     │◄─{msg: "bar"}────────────│◄─ChatMessage────────────│            │
└───────────────────────────────────────────────────────────────────────┘

Deployment Patterns:
┌───────────────────────────────────────────────────────────────────────┐
│  Pattern 1: Embedded Gateway (Same Process)                           │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                    Single Process                               │  │
│  │  ┌──────────────────┐    ┌──────────────────┐                   │  │
│  │  │  HTTP Gateway    │───►│  gRPC Server     │                   │  │
│  │  │  :8080           │    │  :50051 (local)  │                   │  │
│  │  └──────────────────┘    └──────────────────┘                   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  Pros: Simple deployment, low latency                                 │
│  Cons: Single point of failure, coupled scaling                       │
├───────────────────────────────────────────────────────────────────────┤
│  Pattern 2: Standalone Gateway (Separate Process)                     │
│  ┌──────────────────┐         ┌──────────────────┐                    │
│  │  HTTP Gateway    │────────►│  gRPC Server A   │                    │
│  │  (k8s: 3 pods)   │         │  (k8s: 5 pods)   │                    │
│  │                  │────────►│                  │                    │
│  │                  │         ├──────────────────┤                    │
│  │                  │────────►│  gRPC Server B   │                    │
│  │                  │         │  (k8s: 3 pods)   │                    │
│  └──────────────────┘         └──────────────────┘                    │
│  Pros: Independent scaling, service isolation                         │
│  Cons: Network hop, more complex deployment                           │
├───────────────────────────────────────────────────────────────────────┤
│  Pattern 3: Service Mesh Gateway                                      │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                         Istio/Envoy                             │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │  │
│  │  │ Ingress GW   │  │ gRPC↔HTTP    │  │ Traffic Mgmt │           │  │
│  │  │              │  │ Transcoding  │  │ (A/B, Canary)│           │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘           │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  Pros: Enterprise features, no code changes                           │
│  Cons: Complexity, resource overhead                                  │
└───────────────────────────────────────────────────────────────────────┘

Error Code Mapping:
┌────────────────────┬─────────────────┬────────────────────────────────┐
│  gRPC Code         │  HTTP Status    │  When to Use                   │
├────────────────────┼─────────────────┼────────────────────────────────┤
│  OK                │  200            │  Successful request            │
│  INVALID_ARGUMENT  │  400            │  Bad request data              │
│  UNAUTHENTICATED   │  401            │  Missing/invalid credentials   │
│  PERMISSION_DENIED │  403            │  Valid creds, no access        │
│  NOT_FOUND         │  404            │  Resource doesn't exist        │
│  ALREADY_EXISTS    │  409            │  Create conflict               │
│  RESOURCE_EXHAUSTED│  429            │  Rate limit exceeded           │
│  FAILED_PRECONDITION│ 400           │  State precondition failed      │
│  ABORTED           │  409            │  Concurrent modification       │
│  INTERNAL          │  500            │  Server error                  │
│  UNAVAILABLE       │  503            │  Service temporarily down      │
│  DEADLINE_EXCEEDED │  504            │  Request timeout               │
└────────────────────┴─────────────────┴────────────────────────────────┘
```

### Choosing Your Transcoding Approach (2026)

gRPC-Gateway is not the only option for exposing gRPC services over REST/JSON. Three viable strategies exist in 2026, and the right choice depends on who owns the service and when it was built.

| Approach | Where it lives | Code gen? | Best for |
|----------|----------------|-----------|----------|
| **grpc-gateway v2** (`grpc-ecosystem/grpc-gateway/v2`) | In-process Go reverse proxy | Yes, `protoc-gen-grpc-gateway` | Existing gRPC services that need a REST surface without rewriting handlers, teams already invested in `protoc` + `buf` |
| **Connect-Go** (`connectrpc.com/connect` + `connectrpc.com/vanguard`) | Same handler serves gRPC, gRPC-Web, Connect, and REST | Yes, `protoc-gen-connect-go`, and Vanguard transcodes at runtime | New services where you own both sides, avoids the separate gateway binary and gives browser-native JSON over HTTP/1.1 for free |
| **Envoy gRPC-JSON transcoder** | Sidecar / ingress filter | No, uses proto descriptor set at runtime | Infrastructure teams that want transcoding done at the edge with zero Go code changes, multi-language backends behind one mesh |

Rules of thumb:
- **Greenfield Go service, browser clients matter**: prefer Connect-Go. One handler, one binary, JSON works out of the box, and `vanguard-go` covers the grpc-gateway use case when you need pure REST paths.
- **Existing `proto3` service, need REST for partners**: use grpc-gateway v2, it is the path of least resistance and OpenAPI falls out of the same build.
- **Polyglot backend (Go, Java, Python) behind Envoy or Istio**: use the Envoy transcoder. It is configured once in the mesh and does not couple to any single language's toolchain.

The rest of this chapter focuses on grpc-gateway v2 because it remains the dominant choice for Go services that adopted gRPC before Connect existed. The concepts (HTTP annotations, body/path/query binding, streaming bridges) translate directly to Vanguard and Envoy.

### Junior -> FAANG: Reading Architecture Diagrams and Knowing Where to Look When Things Break

The architecture diagram in this section shows three deployment patterns: embedded gateway, standalone gateway, and service mesh. For a junior engineer, the most important thing is to know which pattern your team uses so you know where to look when a request fails.

In the embedded pattern, both the gRPC server and the HTTP gateway are in the same binary. When `/api/v1/users/123` returns 500, you look at the logs of the single process. There is no separate gateway log to check.

In the standalone pattern, the HTTP gateway is a separate deployment. A failed request might fail at the gateway (wrong proto version, backend unreachable) or at the gRPC backend. You must check two log streams. The trace ID (forwarded via `X-Request-ID` or `traceparent`) is how you correlate the two.

In the mesh pattern, Envoy does the transcoding and you often have no Go code to read. The failure shows up in Envoy's access logs, and the fix may require editing a mesh config, not application code.

The transcoding process steps in the architecture section are worth memorizing. Specifically, step 2 shows the five things the gateway does to every request: URL pattern matching, path param extraction, query param parsing, JSON body unmarshaling, and header-to-metadata conversion. When a request arrives with the correct URL but wrong behavior, work through these five steps in order. Most "why is my field missing" bugs live in step 4 (JSON key does not match the proto field name) or step 5 (a header the handler expects was never forwarded).

The error code mapping table is a cheat sheet for writing correct error handlers. Bookmark it, and note that it matches grpc-gateway's default `HTTPStatusFromCode`. `RESOURCE_EXHAUSTED` maps to 429, not 503, and `UNAVAILABLE` maps to 503, not 500. `FAILED_PRECONDITION` maps to 400 by default (the canonical gRPC-to-HTTP mapping), so if you want 412 for a conditional-request precondition you must write a custom error handler. Getting these wrong causes client retry logic to behave incorrectly.

### Senior @ FAANG: Architecture Decisions That Scale, and the Ones That Do Not

The three deployment patterns in this section represent different points on the autonomy-vs-consistency spectrum, and understanding the failure modes of each is what separates a senior from a mid-level engineer.

**Embedded gateway failure modes.** When the gateway and gRPC server share a process, a memory leak in the JSON marshaling path (common at high QPS when large response messages are serialized) affects both the REST and gRPC surfaces simultaneously. You cannot scale the REST surface independently of the gRPC surface. If your REST traffic is bursty (public API) and your gRPC traffic is steady (internal microservices), the embedded pattern couples their resource requirements in a way that makes capacity planning harder.

**Standalone gateway failure modes.** The standalone pattern introduces a network hop between the gateway and the backend. At 50k QPS, the baseline connection overhead between the gateway and a single backend becomes meaningful. You need connection pooling tuned to the expected concurrency, keepalive parameters set correctly (the defaults allow connections to go idle and then pay a new TCP handshake cost on the next request), and circuit breakers so a slow backend does not hold connections open and exhaust the gateway's file descriptor limit.

**Service mesh failure modes.** Envoy's gRPC-JSON transcoder requires the proto descriptor set to be available at Envoy startup. If the descriptor set is out of sync with what the backend expects (a team deployed a new proto without updating the mesh config), Envoy silently drops or misroutes requests. The governance requirement is that the mesh config update and the backend deployment must be atomic from the perspective of external clients, which typically means a two-phase rollout: deploy the backend first with backward-compatible protos, update the mesh config, then cut traffic.

**Bar-raiser lens on the "choosing your transcoding approach" table.** The table lists three options with a "best for" column. A bar-raiser interviewer will push past the "best for" column and ask: what is the migration path when your chosen approach no longer fits? If you start with embedded grpc-gateway and later need independent scaling of the REST surface, can you extract the gateway without rewriting the proto annotations? (Yes, the annotations stay. You just change where the gateway binary runs.) If you start with Envoy and need per-service custom error shapes, what is the path? (Write a Lua filter or move to per-service gateway.) Knowing the migration path is a signal that you are thinking about the lifecycle of the decision, not just the decision in isolation.

**L6/L7 concern: the error code mapping as a contract.** The mapping table (gRPC code to HTTP status) looks like an implementation detail, but it is actually an API contract. External clients write retry logic based on whether they get a 429 (retry with backoff) or a 503 (retry immediately). If your custom error handler maps `RESOURCE_EXHAUSTED` to 503 instead of 429, every client that follows the HTTP spec will hammer your service with retries during rate limiting. This is a class of bug that cannot be found by unit testing the error handler in isolation. It requires contract testing the full gateway response against the expected HTTP semantics.

---
