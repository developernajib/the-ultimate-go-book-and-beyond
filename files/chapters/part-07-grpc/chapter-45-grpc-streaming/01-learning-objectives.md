## Learning Objectives

After completing this chapter, you will be able to:

- **Distinguish the three streaming patterns**: server streaming, client streaming, and bidirectional streaming, and know when each applies
- **Implement server streaming** for list operations, live feeds, and file downloads
- **Build client streaming** for file uploads, batch operations, and data aggregation
- **Create bidirectional streams** for chat applications, real-time sync, and gaming
- **Handle flow control and backpressure** to prevent overwhelming slow consumers
- **Implement error recovery** with retry logic and partial failure handling
- **Apply production patterns** such as message batching, application-level heartbeats, and resumable transfers

### Junior -> FAANG: Mapping Objectives to Interview Topics

Each objective in this list maps directly to a category of interview question. Knowing which objective is being probed helps you frame your answer correctly.

"Distinguish the three streaming patterns" is always the first question. Interviewers use it to filter candidates who only know unary gRPC. Prepare a one-sentence definition and a concrete use-case for each pattern. Do not conflate "server streaming" with WebSocket push or SSE. Know that the `stream` keyword placement in the proto definition is what determines the pattern.

"Handle flow control and backpressure" is the second most common topic. Candidates who answer only "use a buffered channel" fail. The expected answer mentions HTTP/2 flow control windows at the transport layer, bounded application channels between producer and `stream.Send`, and rate limiters for fairness across multiple concurrent streams.

"Implement error recovery" covers partial failure, retry, and resumable transfers. Entry-level answers describe `for` loops with retry counters. Stronger answers describe exponential backoff with jitter, cursor-based resumption, and the distinction between retryable codes (`Unavailable`, `ResourceExhausted`) and non-retryable codes (`InvalidArgument`, `NotFound`).

Use these objectives as a self-assessment checklist before interviews. If you cannot write a working code sketch for each one from memory in under five minutes, the chapter content needs more practice time.

### Senior @ FAANG: Reframing Objectives as Platform Capabilities

At senior and staff level, these objectives are not skills you demonstrate once in an interview. They are capabilities your team must own continuously as traffic grows, backends are replaced, and client SDKs evolve across multiple language ecosystems.

**Flow control governance.** The default HTTP/2 window sizes work for development. In production, they need to be tuned per workload type: log-shipping streams benefit from larger windows (1 MB per stream), interactive command-and-control streams benefit from smaller windows to bound latency. These settings belong in a service mesh configuration or a gRPC channel options registry, not in application code scattered across microservices. Staff engineers define the tuning policy and enforce it via Helm chart defaults or Terraform modules.

**Error recovery at the platform layer.** Individual services implementing custom retry loops is a duplication of concern. At L6/L7 thinking, retry policy belongs in the proxy layer (Envoy retry policy with per-try timeout and budget-based retry limiting) and the service mesh (Istio `VirtualService` retryOn configuration). Application code should signal retriability via gRPC status codes and let the infrastructure layer decide whether and how to retry. This separation also makes retry storms visible in a single place: the proxy metrics dashboard.

**Resumable transfers as a platform primitive.** Rather than every team building its own chunk-offset-checksum protocol for large uploads, staff engineers design a shared resumable transfer service: a content-addressed blob store with an upload session API, chunk acknowledgment, and automatic expiry of abandoned sessions. Teams consume this primitive rather than reinventing it. The learning objective "implement resumable streaming" becomes "design the resumable transfer platform that eliminates the need for teams to implement it themselves."

---
