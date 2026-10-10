## Exercises

1. **Implement SSE Fallback**: Add a Server-Sent Events endpoint at `/events` that streams the same metric updates as the WebSocket. Use `http.Flusher` to push events, and implement a content negotiation middleware that routes clients to SSE when WebSocket upgrade fails. Verify that the SSE stream handles client disconnection without leaking goroutines.

2. **Add Authentication**: Validate a JWT token passed as a query parameter during the WebSocket upgrade handshake (`/ws?token=...`). Reject the upgrade with HTTP 401 if the token is expired or has an invalid signature. Extract the user ID from claims and use it to scope channel subscriptions. Write a test that verifies expired tokens are rejected before the connection upgrades.

3. **Dashboard Persistence**: Store each user's subscribed channels and layout preferences in PostgreSQL. On WebSocket reconnection, restore the previous subscription set automatically. Implement a `PATCH /api/dashboards/:id` endpoint for saving layout changes, and verify that concurrent saves from multiple tabs use optimistic locking (version column) to prevent lost updates.

4. **Alert System**: Add a `ThresholdAlertService` that evaluates metric values against configurable thresholds (e.g., CPU > 90% for 5 consecutive samples). Broadcast alert messages on a dedicated `alerts` WebSocket channel. Include hysteresis to prevent flapping. An alert should only clear when the metric drops below a lower recovery threshold. Write tests for both the firing and recovery paths.

5. **Horizontal Scaling**: Deploy two WebSocket server instances and use Redis Pub/Sub as the cross-instance broadcast layer. Verify that a metric published to one server's ingestion endpoint appears on WebSocket clients connected to the other server. Measure the added latency from the Redis hop using the existing `WSMessageLatency` histogram.

6. **Load Test Expansion**: Extend the load test runner to simulate realistic user behavior: connect, subscribe to 3-5 channels, idle for 30-60 seconds, unsubscribe from one channel, subscribe to another, then disconnect. Add a `--scenario` flag to switch between the current constant-rate pattern and this realistic pattern. Compare the two scenarios' P99 latency and backpressure drop counts.

---

### Junior -> FAANG: Using These Exercises to Build a Portfolio

Each of these exercises produces a deployable artifact, not just working code. Exercise 2 (JWT auth) should be in your portfolio as a demonstration that you can implement auth without a framework and explain why JWT validation belongs at the upgrade handshake. Exercise 4 (alert system with hysteresis) demonstrates that you understand the difference between a naive threshold check and a stateful alert that prevents flapping.

For Exercise 3 (dashboard persistence): implement this with a `PATCH /api/dashboards/:id` endpoint that uses an optimistic locking pattern (version column in PostgreSQL, returning 409 when the client's version does not match the server's). Then write a test that sends two concurrent updates with the same version and verifies that exactly one succeeds. This test is the kind of concrete concurrency scenario that appears in backend coding interviews.

For Exercise 5 (horizontal scaling): the most valuable part of this exercise is measuring the latency added by the Redis hop. A message that goes through Redis Pub/Sub adds roughly 0.5-2ms of latency compared to a local hub broadcast. Understanding that number, and knowing it is acceptable for a monitoring dashboard but potentially not for a financial trading dashboard, is the kind of concrete tradeoff knowledge that distinguishes engineers who have built systems from those who have only read about them.

Approach each exercise with a test-first habit: before implementing the SSE fallback, write a test that fails because the endpoint does not exist. Then implement the minimum code to make it pass. Then write the goroutine leak test and make that pass. This discipline is faster than it feels, and it produces code that you can confidently show in a code review.

### Senior @ FAANG: Designing Exercises That Reveal Engineering Judgment

These exercises are well-designed for developing implementation skills. At the L6/L7 level, the more interesting exercises are the ones that require making and defending architectural decisions, not just implementing a specified design.

**Exercise 2 extended (auth governance):** The exercise specifies JWT validation at the upgrade handshake. A staff-level extension is to design the token refresh strategy for long-lived WebSocket connections. JWTs expire, typically in hours. A connection that has been open for 12 hours will hold an expired token. What is the correct behavior? Options include: close the connection when the token expires and require re-authentication (simple but disruptive for users), accept a new token via a WebSocket message and validate it server-side (requires server-side state), or use a separate refresh channel (REST endpoint) that issues new connection credentials and sends them to the WebSocket client. Each option has different security and UX implications. Designing this refresh protocol and writing an ADR for the decision is a staff-level exercise.

**Exercise 5 extended (multi-node reliability):** The basic exercise verifies that a metric published to one node appears on clients connected to another. A staff-level extension asks: what is the graceful shutdown procedure for a WebSocket node that is receiving live traffic? Kubernetes sends SIGTERM and waits the grace period. During that window, the node should stop accepting new connections, drain existing connections by sending a "please reconnect" message to each client, wait for clients to reconnect to other nodes, and then exit. Implementing and testing this drain procedure, and measuring the reconnection latency for clients during a rolling deploy, is the kind of operational engineering that distinguishes platform engineers from application engineers.

**Exercise 6 extended (traffic shape and SLO validation):** The exercise compares constant-rate and realistic traffic P99 latency. A staff-level extension connects the load test results to SLO compliance. If the SLO is P99 latency below 200ms and the realistic traffic scenario produces P99 of 180ms, the system has 20ms of headroom. At 1.5x realistic traffic (a modest spike), does the P99 stay below 200ms? This is capacity planning, not just load testing. Writing a capacity model that maps traffic multiplier to P99 latency, using the load test data as calibration input, is the kind of artifact that a staff engineer produces to support quarterly capacity reviews.
