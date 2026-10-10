## Exercises

1. **Server Streaming with Backpressure**: Implement a `ListLogs` server-streaming RPC that streams 10,000 log entries to the client. On the client side, introduce an artificial 10ms processing delay per message to simulate a slow consumer. Ensure the server checks `stream.Context().Err()` after each `Send` and aborts cleanly if the client disconnects. Write a test that cancels the client context after 100 messages and asserts the server goroutine exits within 500ms.

2. **Client Streaming Batch Upload**: Build a `BatchCreateUsers` client-streaming RPC where the client streams `CreateUserRequest` messages and the server accumulates them, inserting in a single batch when the stream closes. The server must return `codes.InvalidArgument` if any individual message contains an empty `email` field (without processing the batch). Write a test covering: all-valid batch (returns count), one invalid message mid-stream (returns error), and empty stream (returns count of 0).

3. **Bidirectional Chat with Heartbeats**: Implement a `Chat` bidirectional streaming RPC. Each message has a `type` field: `CHAT` or `HEARTBEAT`. The server must echo `HEARTBEAT` messages back immediately and broadcast `CHAT` messages to all connected clients. Implement application-level heartbeat detection: if no message is received from a client within 5 seconds, the server must close that stream with `codes.DeadlineExceeded`. Write a test that connects two clients, sends a chat from one, and asserts the other receives it.

4. **Resumable File Upload**: Extend a client-streaming `UploadFile` RPC to support resumable uploads. The first message must be metadata containing a `upload_id`, `total_size`, and `resume_offset`. The server reads from the specified `resume_offset` and returns a `UploadResponse` with the final `file_id` and total bytes written. Simulate a mid-upload disconnection in a test, then reconnect with the same `upload_id` and the correct `resume_offset`, and assert the complete file content is received correctly by the server.

5. **Flow Control with Bounded Channel**: Implement a server-streaming `StreamMetrics` RPC that reads from an unbounded metrics source (a goroutine producing values every 1ms). Use a bounded channel of capacity 100 as a buffer between the producer and the `stream.Send` loop. When the channel is full, drop the oldest metric and increment a `grpc_metrics_dropped_total` Prometheus counter. Write a test with a slow-reading client and assert the dropped counter is non-zero and the server never crashes or blocks.

6. **Parallel Stream Fan-Out**: Build a client that opens 5 concurrent `StreamPrices` server-streaming RPCs to the same gRPC server and merges all incoming price updates into a single `chan Price` using a fan-in goroutine. Ensure all 5 streams are canceled cleanly when the merged channel consumer calls cancel. Write a test asserting that after cancel, all 5 stream goroutines terminate within 1 second (use `sync.WaitGroup` with a timeout).

7. **Bidirectional Stream Ordering Guarantee**: Implement a `Transform` bidirectional streaming RPC that processes requests in order: each request contains a sequence number `seq_id` and a string `value`. The server must respond with `seq_id` and `transformed_value` (uppercase of `value`), maintaining strict ordering (response `seq_id` must match request `seq_id`). Write a test that sends 50 messages concurrently from separate goroutines and asserts all 50 responses are received with correctly matched `seq_id` values, demonstrating that gRPC streams preserve message order.

### Junior -> FAANG: Getting Maximum Value from These Exercises

These seven exercises are ordered by difficulty. Complete them in order and treat each one as a mini production service, not a toy.

**For exercises 1-3 (server streaming, client streaming, bidirectional):** Write the proto definition first, generate the Go stubs, then implement the handler, then the client, then the test. Do not skip the test. The test is where you discover the subtle lifecycle bugs (goroutine leaks, missing `CloseAndRecv`, context not propagated). Use `goleak.VerifyNone(t)` at the end of each test to catch goroutine leaks mechanically.

**For exercise 4 (resumable upload):** This is the most interview-relevant exercise. The core implementation is straightforward. The interview value is in the edge cases: what happens if the client sends a `resume_offset` larger than the bytes the server has? (Return `InvalidArgument`.) What happens if the client sends a `resume_offset` that is mid-chunk? (Accept from the exact byte, since offsets are byte-level.) What happens if the `upload_id` is unknown? (Return `NotFound`.) Write tests for each of these edge cases.

**For exercise 5 (flow control with bounded channel):** The Prometheus counter requirement is the part most candidates skip. Add it. Instrument the `grpc_metrics_dropped_total` counter with a `reason` label (e.g., `reason="buffer_full"`). Write the test to assert the counter is non-zero, which requires exposing the metrics registry in the test. This is the habit of making invisible behavior (dropped events) visible in production.

**For exercises 6-7 (fan-out and ordering guarantee):** These are the exercises that distinguish candidates who understand Go concurrency from those who pattern-match on examples. Implement them from scratch without looking at the chapter's code. When the test fails (it will), use the race detector (`go test -race`) to find the concurrent access patterns. The ordering guarantee exercise in particular reveals whether you understand that gRPC streams preserve message order within a single direction, which is the key invariant the test is designed to confirm.

### Senior @ FAANG: Extending the Exercises for Platform-Level Thinking

Each exercise has a natural extension that shifts the scope from "implement the feature" to "design the platform."

**Exercise 1 extension:** Add per-stream Prometheus metrics (messages sent, bytes sent, context cancellations) instrumented via a server-streaming interceptor, not inside the handler. The interceptor wraps `stream.Send` to count messages and bytes. The handler remains clean. This is the platform pattern: cross-cutting concerns belong in interceptors.

**Exercise 2 extension:** Implement admission control in the handler: if more than 1,000 items have been received in the current stream and the `BatchCreateUsers` RPC's batch limit is 500, return `ResourceExhausted` immediately without processing the excess items. Extend the test to verify the error code and that no partial processing occurred.

**Exercise 3 extension:** Add a second bidirectional streaming client to the test. Both clients join the same "room." Client A sends a `CHAT` message. Assert that client B receives it within 100ms. Then deliberately delay client B's `Recv` loop (simulate a slow consumer) and assert that client A's `CHAT` delivery to client B is eventually dropped with a logged warning rather than blocking client A's delivery. This tests the fan-out correctness and the slow-consumer handling simultaneously.

**Exercise 4 extension:** Store upload session state in a `sync.Map` with a TTL eviction goroutine. Sessions older than 24 hours are deleted. Write a test that creates a session, waits (mock the clock) past the TTL, then attempts to resume. Assert `NotFound` is returned. This tests the session lifecycle management that production systems require.

**Exercise 5 extension:** Replace the in-process metrics producer with an interface that can be swapped for a Kafka consumer in integration tests. Write the integration test using `testcontainers-go` to spin up a real Kafka broker, configure the producer to publish metrics to a Kafka topic, and configure the streaming server to consume from that topic. This exercises the full production data path at the cost of a slower test, which is appropriate for a weekly CI run rather than the main test suite.
