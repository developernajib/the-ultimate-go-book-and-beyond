## Learning Objectives

After completing this chapter, you will be able to:

- **Understand gRPC architecture** including HTTP/2 transport, Protocol Buffers serialization, and service definitions
- **Design Protocol Buffer schemas** with proper versioning, naming conventions, and backward compatibility
- **Implement all four gRPC patterns** including unary, server streaming, client streaming, and bidirectional streaming
- **Build production gRPC servers** with proper server configuration, graceful shutdown, and health checks
- **Create reliable gRPC clients** with connection management, retries, deadlines, and cancellation
- **Handle errors correctly** using gRPC status codes and rich error details
- **Test gRPC services** using bufconn for in-memory testing and proper mocking strategies

### Junior → FAANG: Turning Objectives Into Interview Answers

Learning objectives are the exam syllabus. For each bullet above, you need both a conceptual answer and a code example you can sketch on a whiteboard or in a shared editor.

The objectives most commonly tested at the entry-level gRPC interview:

- **gRPC architecture**: Know the four layers (application, Protocol Buffers, HTTP/2, TLS) and what each provides. Interviewers often ask "why is gRPC faster than REST?" and want to hear about binary framing and connection multiplexing, not just "it uses protobufs."
- **All four patterns**: Be able to name a real use case for each. "Client streaming is good for bulk inserts" is stronger than reciting the definition. Practice explaining when *not* to use a pattern (do not reach for bidirectional streaming unless both sides need to send concurrently and independently).
- **Error handling**: Know the 17 status codes. The ones that decide retry logic are `UNAVAILABLE` (retry), `DEADLINE_EXCEEDED` (usually do not retry), `INVALID_ARGUMENT` (never retry). Being wrong on retryability in a system design interview is a clear signal to the interviewer.
- **bufconn testing**: Interviewers at FAANG ask "how do you test gRPC without a real server?" The answer is bufconn. Be ready to explain why it exercises the full serialization and interceptor stack while keeping tests fast and port-free.

A first-job habit: implement learning objectives in order. Do not skip to testing before you have a working server and client. The objectives are sequenced by dependency.

### Senior @ FAANG: Reframing Objectives as Platform Requirements

At the senior level, learning objectives become service design requirements. The question is not "can I implement these" but "how do I make these easy and correct for every team in the organization."

**Architecture as a platform primitive.** The architecture objective becomes: who owns the base gRPC server template that all teams fork? That template should embed the production interceptor chain (auth, rate limiting, observability, error sanitization) by default, not as an opt-in. When defaults are correct, new services are secure and observable from day one without each team making independent decisions.

**Proto schema design as an organizational API.** The protocol buffer objectives translate to: who reviews new `.proto` files? At companies like Google, proto changes go through a dedicated API review process before merging, even for internal services. The reviewer checks naming consistency (using the Google API Improvement Proposals as the standard), field presence correctness, versioning discipline, and whether the service boundary is right or whether the design indicates a missed service decomposition.

**Testing objectives as a coverage gate.** "Test gRPC services using bufconn" becomes a CI enforcement question. The platform should require a minimum level of bufconn integration test coverage for any service that registers with the service registry. A service that passes `go vet` and unit tests but has no integration test against its own proto interface is a future outage waiting to happen when a proto change is not caught before deploy.

**Error handling as a contract.** The error handling objective at the senior level is about establishing a fleet-wide error mapping policy. Every service should use the same interceptor to translate domain errors to gRPC status codes. When error codes are assigned inconsistently (one team returns `INTERNAL` for not-found, another returns `NOT_FOUND`), client teams write defensive code against every possible code for every RPC, and the status code stops carrying information. Enforcing the mapping in a shared library is a staff-level platform decision with direct impact on reliability.

---
