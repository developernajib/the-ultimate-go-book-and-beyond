## Summary

gRPC streaming essentials:

1. **Server Streaming**: Send multiple responses for one request - ideal for lists, feeds, downloads
2. **Client Streaming**: Send multiple requests for one response - ideal for uploads, batching
3. **Bidirectional**: Independent streams in both directions - ideal for chat, real-time collaboration
4. **Flow Control**: HTTP/2 handles automatically, but use bounded buffers and rate limiting at application level
5. **Error Handling**: Check context cancellation, handle partial failures, implement retry with resume
6. **Company Patterns**: Google's Pub/Sub pull, Twitch's batched chat, Discord's gateway heartbeats

### Junior -> FAANG: Consolidating the Chapter for Interviews

Six summary points map to six interview topic clusters. Here is the consolidation that ties them to interview expectations.

**Patterns (point 1-3):** Know all three patterns by proto syntax and by goroutine model. `stream` before return type = server streaming, one handler goroutine calling `Send` in a loop. `stream` before parameter = client streaming, one handler goroutine calling `Recv` in a loop, one `SendAndClose` at the end. Both = bidirectional, two goroutines per side (send and receive), coordinated shutdown.

**Flow control (point 4):** Two layers. HTTP/2 (64 KB default window, transport-managed, automatic). Application layer (bounded channel between producer and `Send`, rate limiter for fairness). The sentence "HTTP/2 handles flow control automatically" is true but incomplete. The application layer is what prevents OOM on the server.

**Error handling (point 5):** Three-tier classification: stream terminates cleanly (`io.EOF`), stream terminates with retryable error (`Unavailable`, `ResourceExhausted`), stream terminates with non-retryable error (all others). Resume logic requires the last processed sequence number. Backoff requires jitter.

**Company patterns (point 6):** Each pattern encodes a design principle. Pub/Sub: ack-based delivery confirmation over the reverse direction. Twitch: drop slow consumers rather than buffer unboundedly. Discord: application-level heartbeats separate from TCP keepalives. Memorize these three design principles, not the code.

### Senior @ FAANG: Summary as a Platform Maturity Model

This chapter's content maps to a five-stage streaming maturity model for engineering organizations.

**Stage 1: Ad-hoc streaming.** Teams implement server-streaming and client-streaming handlers case by case, without shared patterns or platform support. Common symptoms: context cancellation ignored in some handlers, unbounded buffering in others, no goroutine leak testing. This is where most teams start.

**Stage 2: Pattern adoption.** Teams adopt shared patterns from this chapter: cursor-based pagination in server streaming, `CloseAndRecv` discipline in client streaming, separate goroutines in bidirectional streaming. Code review checklists enforce the patterns. Goroutine leak tests are added to CI.

**Stage 3: Application-level robustness.** Services implement application-level heartbeats, bounded send buffers with explicit drop policies, and basic reconnect logic with exponential backoff and jitter. Sequence numbers are added to resumable streams. SLO dashboards track per-stream message rate and send latency in addition to stream duration.

**Stage 4: Platform services.** The resumable upload protocol is extracted into a shared platform service. Bidirectional streaming boilerplate is generated from proto definitions. Server interceptors enforce memory limits and goroutine leak prevention. Per-stream metrics are collected uniformly via interceptors.

**Stage 5: Operational excellence.** Load balancing is L7 with Envoy, with stream rebalancing on scale-out events. `GOAWAY` handling is tested in chaos experiments (backends killed mid-stream). Drain time during deploys is measured and bounded by max stream age policies. Session state for resumable streams is stored in a geo-replicated distributed database. Incident playbooks cover all six pitfall categories. The streaming platform is a first-class platform component with its own oncall rotation.

Staff engineers drive organizations from Stage 1 to Stage 3. Principal and distinguished engineers drive from Stage 3 to Stage 5. Knowing which stage your organization is at, and which specific gaps to close next, is the staff-level skill this chapter builds toward.

---
