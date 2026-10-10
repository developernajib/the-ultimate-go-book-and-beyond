## Streaming Architecture Overview

The streaming architecture diagram shows the four RPC call patterns (unary, server streaming, client streaming, and bidirectional) and how each maps to different use cases. Choosing the right pattern avoids unnecessary buffering and reduces latency for high-frequency or long-running data exchanges.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    gRPC STREAMING PATTERNS                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    SERVER STREAMING (1:N)                              │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Client                           Server                               │  │
│  │  ┌──────┐                        ┌──────┐                              │  │
│  │  │      │ ──── Request ────────► │      │                              │  │
│  │  │      │ ◄─── Response 1 ────── │      │                              │  │
│  │  │      │ ◄─── Response 2 ────── │      │                              │  │
│  │  │      │ ◄─── Response 3 ────── │      │                              │  │
│  │  │      │ ◄─── Response N ────── │      │                              │  │
│  │  │      │ ◄─── EOF ──────────── │      │                               │  │
│  │  └──────┘                        └──────┘                              │  │
│  │                                                                        │  │
│  │  Use Cases: List operations, live feeds, file downloads, log tailing   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    CLIENT STREAMING (N:1)                              │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Client                           Server                               │  │
│  │  ┌──────┐                        ┌──────┐                              │  │
│  │  │      │ ──── Request 1 ──────► │      │                              │  │
│  │  │      │ ──── Request 2 ──────► │      │                              │  │
│  │  │      │ ──── Request 3 ──────► │      │                              │  │
│  │  │      │ ──── Request N ──────► │      │                              │  │
│  │  │      │ ──── EOF ────────────► │      │                              │  │
│  │  │      │ ◄─── Response ──────── │      │                              │  │
│  │  └──────┘                        └──────┘                              │  │
│  │                                                                        │  │
│  │  Use Cases: File uploads, batch operations, aggregations, IoT data     │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                 BIDIRECTIONAL STREAMING (N:M)                          │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Client                           Server                               │  │
│  │  ┌──────┐                        ┌──────┐                              │  │
│  │  │      │ ──── Request 1 ──────► │      │                              │  │
│  │  │      │ ◄─── Response 1 ────── │      │                              │  │
│  │  │      │ ──── Request 2 ──────► │      │                              │  │
│  │  │      │ ◄─── Response 2 ────── │      │                              │  │
│  │  │      │ ◄─── Response 3 ────── │      │  (Independent)               │  │
│  │  │      │ ──── Request 3 ──────► │      │                              │  │
│  │  │      │ ◄─── Response 4 ────── │      │                              │  │
│  │  └──────┘                        └──────┘                              │  │
│  │                                                                        │  │
│  │  Use Cases: Chat, gaming, real-time collaboration, IoT control         │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    STREAM LIFECYCLE                                    │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  SERVER STREAMING:                                                     │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │ 1. Client calls RPC with request                                │   │  │
│  │  │ 2. Server receives request in handler                           │   │  │
│  │  │ 3. Server calls stream.Send() multiple times                    │   │  │
│  │  │ 4. Server returns nil (success) or error                        │   │  │
│  │  │ 5. Client receives io.EOF when stream ends                      │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  │  CLIENT STREAMING:                                                     │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │ 1. Client calls RPC, gets stream                                │   │  │
│  │  │ 2. Client calls stream.Send() multiple times                    │   │  │
│  │  │ 3. Client calls stream.CloseAndRecv()                           │   │  │
│  │  │ 4. Server receives io.EOF when client finishes                  │   │  │
│  │  │ 5. Server returns response                                      │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  │  BIDIRECTIONAL:                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │ 1. Both sides can send/receive independently                    │   │  │
│  │  │ 2. Either side can close their send direction with CloseSend()  │   │  │
│  │  │ 3. Stream ends when both sides are done                         │   │  │
│  │  │ 4. Context cancellation terminates both directions              │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    FLOW CONTROL                                        │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  HTTP/2 Window-Based Flow Control:                                     │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │                                                                 │   │  │
│  │  │  Sender          Window          Receiver                       │   │  │
│  │  │  ┌────┐         [64KB]          ┌────┐                          │   │  │
│  │  │  │    │ ──────────────────────► │    │  Send data               │   │  │
│  │  │  │    │         [32KB]          │    │  Window shrinks          │   │  │
│  │  │  │    │ ◄────────────────────── │    │  WINDOW_UPDATE           │   │  │
│  │  │  │    │         [64KB]          │    │  Window restored         │   │  │
│  │  │  └────┘                         └────┘                          │   │  │
│  │  │                                                                 │   │  │
│  │  │  • HTTP/2 handles flow control automatically                    │   │  │
│  │  │  • Send() blocks if receiver window is full                     │   │  │
│  │  │  • Application should check context cancellation                │   │  │
│  │  │                                                                 │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │               CHOOSING THE RIGHT PATTERN                               │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Pattern      │ When to Use                                            │  │
│  │  ─────────────┼─────────────────────────────────────────────────────── │  │
│  │  Unary        │ Simple request/response, CRUD operations               │  │
│  │  Server       │ Large result sets, real-time updates, downloads        │  │
│  │  Client       │ Uploads, aggregations, batch operations                │  │
│  │  Bidirectional│ Interactive, real-time two-way communication           │  │
│  │                                                                        │  │
│  │  Key Decision Factors:                                                 │  │
│  │  • Data size: Large data → streaming                                   │  │
│  │  • Latency: Need updates ASAP → server streaming                       │  │
│  │  • Interaction: Both sides active → bidirectional                      │  │
│  │  • Order: Must process in order → streaming                            │  │
│  │  • Aggregation: Need final result → client streaming                   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading the Architecture Diagram

The diagram communicates more than it appears to at first glance. Focus on the lifecycle boxes, not just the arrow directions.

The server-streaming lifecycle shows the server returning `nil` or an error to end the stream. This is the handler return value, not a separate close call. A beginner mistake is to call `stream.CloseSend()` in a server-streaming handler. That method does not exist on the server stream object. The server closes by returning from the handler.

The client-streaming lifecycle shows `CloseAndRecv()` on the client side. This is the only way to signal end-of-stream to the server and receive the final response in a single operation. Many beginners call `Send` in a loop and then forget `CloseAndRecv`, leaving the server's `Recv` loop blocked on `io.EOF` that never arrives.

The flow control diagram shows a single 64 KB window. In practice there are two windows per stream: one at the stream level and one at the connection level. The connection window caps total in-flight data across all streams multiplexed on that connection. If you have 100 active streams each trying to send 64 KB, the connection window becomes the bottleneck. This is why `grpc.InitialConnWindowSize` must be raised alongside `grpc.InitialWindowSize` for high-concurrency workloads.

The decision table at the bottom is the one to memorize for interviews. Practice applying it to novel scenarios: "Would you use streaming to serve a leaderboard that updates every 5 seconds?" (server streaming, not polling), "Would you use streaming to process a 50,000-row CSV import?" (client streaming), "Would you use bidirectional streaming for a request-reply RPC where you need to pipeline 10 in-flight requests?" (yes, bidirectional with explicit correlation IDs).

### Senior @ FAANG: Architecture Decisions Hidden in the Diagram

The four-pattern taxonomy in this diagram is correct but incomplete for production decision-making. Two dimensions are missing: connection topology and stream lifetime.

**Connection topology.** The diagram shows one client and one server. In a microservices environment, the "client" is often another service running multiple replicas, each maintaining a pool of connections to the "server" replicas. A bidirectional streaming RPC is pinned to a single server replica for its lifetime. If that replica crashes, all streams on it terminate. The client must detect this via `io.EOF` or a non-OK status on `Recv`, then reconnect to a different replica and rebuild state. The architecture diagram for a real system must show the reconnect path and state recovery mechanism, not just the happy-path message flows.

**Stream lifetime and resource accounting.** Each open stream consumes a goroutine on the server (the handler goroutine), a flow control budget on the HTTP/2 connection, and memory for the message serialization buffers. A server with 10,000 concurrent bidirectional streams holds 10,000 goroutines at minimum. At 2 KB stack each (Go's initial goroutine stack), that is 20 MB just for stacks, and in practice more because a handler that touches serialization buffers and downstream calls grows its stack well past the 2 KB floor. Capacity planning for a streaming service must include per-stream resource cost, not just RPS. The decision to use bidirectional streaming over 1,000 concurrent connections rather than 1,000 unary RPCs per second is not always a win. Model both and measure.

**Pattern selection as an ADR.** At staff level, choosing a streaming pattern for a new service warrants a short Architecture Decision Record. The ADR should capture: the data shape and rate that motivates streaming, the selected pattern and rejected alternatives, the flow control and backpressure strategy, the reconnect and resume protocol, the observable metrics (per-stream message rate, send latency p99, active stream count), and the load balancing strategy (L4 vs L7, drain behavior on deploy). Without this record, the next engineer to touch the service does not know which constraints were deliberate and which were accidental.

---
