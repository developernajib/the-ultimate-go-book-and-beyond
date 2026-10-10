## Exercises

1. **Distributed Chat with Redis:** Extend the `DistributedHub` implementation above to run two instances on ports 8080 and 8081. Verify that a message sent by a client on port 8080 is received by a client on port 8081. Use Redis locally with `docker run -p 6379:6379 redis`.

2. **SSE with Replay:** Implement the `SSEHub` from this chapter. Simulate a client that disconnects for 10 seconds and reconnects with `Last-Event-ID`. Verify the client receives all missed events. Publish 1 event per second from a background goroutine.

3. **Presence System:** Using the `PresenceManager`, build a `/presence?room=lobby` HTTP endpoint that returns the current online users as JSON. Start 5 simulated users in goroutines, each calling `RunHeartbeatLoop`. Verify the endpoint returns all 5 users. Kill 2 goroutines and confirm they disappear from the list within `presenceTTL`.

4. **OT Conflict Resolution:** Using the `OTServer` from this chapter, simulate two clients concurrently editing a document. Client A inserts "Hello" at position 0. Client B simultaneously inserts "World" at position 0 (based on the same revision). Submit both ops to the server and verify the final document contains both texts without data loss.

5. **Rate Limiting Under Load:** Build a load test using Go's `net/http` and `gorilla/websocket` test client. Connect 100 clients and have each send 200 messages/second. Verify that connections exceeding `maxMsgPerSecond` (50/sec) are disconnected with close code 1008. Count disconnections and assert at least 50% of clients are disconnected.

6. **Connection Draining Deploy:** Set up the graceful drain server from this chapter. Open 20 long-lived WebSocket connections, then send `SIGTERM` to the process. Verify that: (a) new connection attempts receive 503 immediately, (b) existing connections remain open and functional, (c) the process exits only after all 20 connections are closed or `drainTimeout` expires.

### Junior → FAANG: Making Exercises Count for Interview Preparation

Each exercise in this section produces interview material if you approach it with intentional reflection. After completing exercise 1 (Distributed Chat with Redis), write down: how many messages per second can the system handle before Redis becomes the bottleneck? How does message latency change as you add more clients? What happens when you stop and restart one of the two servers mid-conversation? The answers to these questions are the raw material for real-world answers to "tell me about a distributed real-time system you built."

Exercise 6 (Connection Draining) is particularly valuable for demonstrating operational maturity. Most engineers have not thought carefully about what happens to in-flight connections during a deployment. Being able to describe the exact behavior (503 to new connections, graceful close frames to existing connections, timeout-based force close) and having implemented it shows that you think about operations, not just features.

### Senior @ FAANG: Exercises as Platform Validation Tests

At senior level, these exercises are validation tests for platform primitives that will be used by multiple teams. Exercise 3 (backpressure with slow client) should be run not just until it works, but until the behavior under all three backpressure configurations (drop, buffer, disconnect) is documented with measured latency and memory data. That documentation becomes the input for the platform SLA.

Exercise 6 (connection draining) should be extended to a chaos engineering scenario: what happens if the drain is interrupted by a second SIGTERM? What happens if Redis is unavailable during the drain? What happens if a client reconnects to the same server during the drain period? Each of these scenarios reveals a potential failure mode in the drain implementation. Documenting the behavior under each scenario and ensuring it matches the product's resilience requirements is the production-readiness validation work that distinguishes platform engineering from feature engineering.

---
