## 102H.9 Mid-Chapter Practical Exercises

1. **Chat Room**: Build a WebSocket chat server with rooms, join/leave notifications, and user presence. Handle the case where a user disconnects mid-conversation.

2. **Live Dashboard**: Build an SSE-based live metrics dashboard. Show GC stats, goroutine count, and custom business metrics updating in real time.

3. **Redis Fan-Out**: Extend the Hub to use Redis pub/sub. Deploy two instances and verify messages from a client on instance 1 reach clients on instance 2.

4. **Reconnection Buffer**: Implement a message buffer with ID-based replay. Simulate a client disconnecting for 30 seconds and verify it receives all missed messages on reconnect.

5. **Rate Limiting**: Add per-client rate limiting to the WebSocket server. Disconnect clients that exceed 100 messages/second.

6. **Collaborative Counter**: Build a simple collaborative counter using WebSocket. Multiple browsers can increment/decrement the same counter and see updates in real time.

7. **Presence System**: Implement a Redis-based presence system. Show a user list that updates in real-time as users connect and disconnect.

8. **Load Test**: Load test the WebSocket server to 10K concurrent connections using k6 with WebSocket support. Measure memory usage and broadcast latency.

### Junior → FAANG: Which Exercises to Prioritize and Why

Exercise 1 (Chat Room) is the foundational exercise and should be completed before any other. It requires all the core concepts: goroutine lifecycle, hub pattern, connection registration and deregistration, and graceful disconnect handling. Most WebSocket interview questions can be answered by narrating your experience implementing this exercise.

Exercise 8 (Load Test) is the second highest priority because it makes performance characteristics concrete. Many engineers know that WebSocket connections are "lightweight" but cannot say what "lightweight" means numerically. After running a load test to 10K connections on your hardware, you will know the actual memory per connection, the broadcast latency at different connection counts, and where the bottleneck appears. These concrete numbers are invaluable in design discussions.

Exercise 5 (Redis Pub/Sub) should be completed third, because it introduces the distributed dimension. Implementing the Redis backplane yourself and then testing that a message published via one server instance arrives at a client connected to a different instance is the exercise that validates understanding of the multi-instance scaling problem.

### Senior @ FAANG: Extending Exercises to Production Validation Standards

The exercises as written produce working implementations. Extending them to production validation standards is the senior-level work. For exercise 1 (Chat Room), production validation means: load test with k6 measuring p50/p95/p99 broadcast latency under varying connection counts, memory profiling with `pprof` to confirm goroutine and heap growth is O(connections) not O(messages), and a chaos test where the Redis connection is interrupted mid-operation and client-visible behavior is observed and documented.

For exercise 8 (Load Test), the production extension is establishing baseline metrics and alerting thresholds: what is the expected p99 broadcast latency at 10K connections, and at what connection count does it start to degrade? What is the goroutine count at saturation, and at what count does the scheduler start to introduce observable delay? These baselines become the SLO inputs for a production deployment.

The most valuable extension across all exercises is a deliberate failure injection framework: what happens when the hub goroutine panics? When Redis returns an error mid-publish? When a single client holds a reference to a send channel that is never drained? Answering these questions with observed behavior rather than assumed behavior is what separates engineers who have operated real-time systems in production from those who have only built them in development.

---
