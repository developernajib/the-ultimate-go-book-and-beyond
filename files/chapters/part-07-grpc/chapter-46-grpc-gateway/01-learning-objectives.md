## Learning Objectives

By the end of this chapter, you will be able to:

- **Understand gRPC-Gateway architecture** and how HTTP/JSON requests translate to gRPC calls
- **Configure HTTP annotations** in proto files for RESTful endpoint mapping
- **Build production gateways** with custom error handling, middleware, and graceful shutdown
- **Implement streaming bridges** using Server-Sent Events and WebSocket protocols
- **Transform requests and responses** with custom marshalers and middleware
- **Generate OpenAPI specifications** and serve interactive API documentation
- **Apply production gateway patterns** including service discovery, idempotency, and API versioning

### Junior -> FAANG: Mapping Objectives to Interview Expectations

Learning objectives in a book tell you what the chapter covers, but FAANG interviews probe whether you can apply those skills under ambiguity. Here is how each objective maps to what an interviewer actually wants to see.

"Understand gRPC-Gateway architecture" means you can draw the request flow on a whiteboard: HTTP client hits the gateway mux, the mux deserializes JSON into a proto message, it dials the gRPC backend and calls the generated stub, receives the proto response, serializes it back to JSON, and returns an HTTP response. If you cannot sketch that without looking it up, you are not ready for a system design question that involves it.

"Configure HTTP annotations" means you know that `get: "/v1/users/{id}"` binds the `{id}` path segment to the `id` field of the request message, that `body: "*"` means the full request body maps to the proto message, and that unmapped proto fields appear as query parameters automatically. You have also seen what breaks when you use `body: "nested_field"` but the JSON does not contain that key.

"Build production gateways" means you have thought about what happens when the gRPC backend is unavailable, when the backend returns a non-standard gRPC status, and when the gateway itself is overloaded. A "production" gateway has a timeout on the backend dial, a graceful shutdown sequence, and a health endpoint that actually reflects backend state.

"Implement streaming bridges" means you understand why `EventSource` in a browser cannot use gRPC directly, what the SSE wire format looks like (`data:` and `event:` lines), and what happens when the browser disconnects mid-stream without sending a close frame.

The habit to build: for each objective, find one production failure mode related to it and know how to detect and prevent it. Interviewers remember candidates who say "and here is how this breaks in production" because it signals real experience.

### Senior @ FAANG: Translating Objectives into Platform Requirements

A senior engineer reading a list of learning objectives asks a different set of questions: which of these belong in a platform-level service and which belong in each team's codebase, and how do we enforce consistency across dozens of teams without becoming a bottleneck?

"Configure HTTP annotations" at the platform level becomes a question of linting standards. If 30 teams each define their own annotation conventions, you end up with `/v1/users/{user_id}` in one service and `/v1/users/{id}` in another, making the API catalog confusing for external partners. A platform team writes a `buf` lint plugin or a custom checker that enforces naming conventions, required operation annotations (summary, tags, at least one documented error response), and URL versioning format.

"Build production gateways" at the platform level becomes a question of shared infrastructure. Do you provide a gateway deployment that teams register their protos with, or do each teams embed the gateway in their service binary? The former scales the platform team's review load, the latter scales each team's operational burden. At L6 and above, you are expected to have a reasoned position on this and to have socialized it with multiple stakeholders.

"Generate OpenAPI specifications" at the platform level means the spec is a publishable artifact that goes through review, versioning, and access control. It is not just a debug convenience. At Google and Stripe scale, the OpenAPI spec is the contract that external developers integrate against, and changing it without notice breaks partner systems.

Staff-level concern: the learning objectives in this chapter implicitly assume you own one service. At staff level, the question is how you design the gateway layer so that the 50th team to adopt it has the same quality as the first, with minimal one-on-one platform support.

---
