# Chapter 45: gRPC Streaming

*Streaming is not just about performance. It's about enabling entirely new interaction patterns.*

Some problems are fundamentally ill-suited to request-response. Fetching a live stock feed, uploading a multi-gigabyte log archive, synchronizing state between a mobile device and a backend, or running a speech-to-text transcription - these all involve data that flows continuously in one or both directions. Forcing them through unary RPC means either buffering entire payloads in memory before responding (creating latency and OOM risk) or polling at intervals (wasting bandwidth and introducing lag). Neither option scales gracefully, and both paper over the actual shape of the problem.

gRPC streaming is the natural solution. Built on HTTP/2's multiplexed bidirectional byte streams, it lets clients and servers send sequences of messages over a single connection without the overhead of establishing new connections or buffering full payloads. In Go, this maps onto channel-like send/receive loops that feel idiomatic: a server streaming handler ranges over results and calls `stream.Send`. A client streaming handler calls `stream.Send` in a loop and `stream.CloseAndRecv` when finished. Bidirectional streaming composes both patterns, enabling full-duplex communication where either side can send at any time.

This chapter covers all three streaming patterns with emphasis on the production concerns that tutorials skip: flow control and backpressure to prevent fast producers from overwhelming slow consumers, partial failure handling when a stream breaks mid-transfer, context cancellation propagation across long-lived streams, and reconnection strategies for resilience. You will build concrete examples (a live log tailing service, a file upload pipeline, and a real-time chat system) that illustrate each pattern's trade-offs.

**What you'll learn in this chapter:**
- The mechanical differences between server streaming, client streaming, and bidirectional streaming RPCs
- Implementing server streaming for paginated list operations, live feeds, and large file downloads
- Building client streaming handlers for batch ingestion, file uploads, and aggregation pipelines
- Creating bidirectional streams for chat, real-time sync, and low-latency gaming backends
- Understanding HTTP/2 flow control windows and applying backpressure to protect slow consumers
- Propagating context cancellation and deadlines correctly through long-lived stream loops
- Handling partial failures with per-message acknowledgment and resumable transfer patterns
- Testing streaming RPCs with deterministic fake streams and race-condition detection

**Why this matters at scale:**
Bidirectional streaming is how control planes push real-time signals to fleets of thousands of agents over single connections, and server streaming is how data pipelines fan out terabytes of log data per hour - patterns that are only practical because HTTP/2 multiplexing eliminates the per-stream connection overhead that would make them cost-prohibitive with HTTP/1.1.

**Prerequisites:** Chapter 43 (gRPC Fundamentals), Chapter 44 (Interceptors), Chapter 11 (Go concurrency and channels)

### Junior -> FAANG: Understanding Why Streaming Exists

When you first encounter gRPC streaming, the temptation is to treat it as a "fancy for-loop over unary calls." That mental model leads to poor design choices. Streaming exists because HTTP/1.1 request-response is fundamentally synchronous: one request, one response, done. Polling to simulate continuous data means wasting bandwidth, introducing latency spikes, and adding retry complexity that lives in your application code rather than the transport.

The beginner habit to break is reaching for streaming whenever data is "large." Size alone is not the deciding factor. A 500 MB SQL dump returned in a single protobuf message (bypassing the 4 MB default limit via `MaxRecvMsgSize`) is worse than a server-streaming RPC that yields rows as they are scanned. But a 10-field user profile update is worse as a stream than a plain unary RPC. The actual decision axis is: does the data have a natural sequential shape that the consumer can act on incrementally, or is it a bounded blob that must be received atomically?

For a first job, know these three things cold:

1. `stream.Send` on the server side and `stream.Recv` on the client side are the only two methods you call in a stream loop. Everything else is lifecycle plumbing.
2. `io.EOF` from `Recv` means clean close. Anything else is an error. Do not treat `io.EOF` as an error.
3. Always pass the stream's context (via `stream.Context()`) into any downstream call. If you create a bare `context.Background()` inside a stream handler, you break cancellation propagation and leak goroutines.

Interview entry point: be ready to sketch all four RPC patterns (unary, server-streaming, client-streaming, bidirectional) with a one-sentence use-case for each. Interviewers at L3-L4 level expect this fluency.

### Senior @ FAANG: Platform Framing for Streaming APIs

At staff level, choosing gRPC streaming is an architectural decision that commits downstream consumers to a stateful, connection-bound protocol. That commitment has consequences that last years, and they surface in ways junior engineers do not anticipate.

**Connection affinity and load balancing.** A long-lived gRPC stream is pinned to a single backend for its lifetime. L4 load balancers (AWS NLB, GCP Network LB) route by TCP connection, so a stream that lives for hours saturates one backend while others sit idle. L7 load balancers (Envoy, GCP Cloud Load Balancing in gRPC mode) can load-balance at the HTTP/2 stream level, but only for new streams, not mid-stream. This means that adding capacity during a traffic spike does not relieve existing stream load until clients reconnect. An ADR for a streaming API must explicitly address how the system handles backend draining during deploys: servers must send `GOAWAY`, clients must watch for it and reconnect, and the reconnect storm must be modeled before going to production.

**Observability contract.** Unary RPCs produce one request span per call. A server-streaming RPC that runs for 90 minutes produces one span with a 90-minute duration and a message count metric. Your tracing system, SLO dashboards, and alerting rules are almost certainly designed around unary call semantics. Before shipping a streaming API, define: what is the unit of latency measurement (per-message send latency? time-to-first-byte? stream duration?), what constitutes an error (any `Send` failure? only stream termination with a non-OK code?), and how you will detect a "stuck" stream that is open but not making progress.

**Maturity model.** The progression from naive to production-grade streaming has five stages: (1) no context checking and no flow control, (2) context-aware loops with bounded buffers, (3) application-level heartbeats and reconnect logic, (4) resumable streams with sequence numbers and server-side retention windows, (5) full platform support with L7 load balancing, per-stream metrics, circuit breaking, and graceful drain on rollout. Most teams ship at stage 1 or 2 and discover stages 3-5 through incidents. Staff engineers write the ADR that skips stages 1-2 before the first deploy.

**Bar-raiser signal.** When a candidate says "I would use bidirectional streaming for the real-time sync service," the bar-raiser follow-up is: "How does your service drain during a rolling restart without dropping messages for connected clients?" A weak answer describes `SIGTERM` handling. A strong answer describes `GOAWAY` with a drain window, client-side reconnect with exponential backoff and jitter, server-side new-stream rejection during drain, and how in-flight messages are recovered via sequence number replay rather than re-delivery from memory.

---
