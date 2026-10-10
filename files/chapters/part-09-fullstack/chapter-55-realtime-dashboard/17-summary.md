## Summary

- **WebSocket vs SSE**: WebSocket provides full-duplex, low-latency communication ideal for dashboards requiring client commands. SSE is simpler and HTTP/2-compatible but supports only server-to-client streaming - choose based on whether the client needs to send data back.
- **Time-series data aggregation**: Pre-aggregate metrics at write time using rolling windows or ring buffers to avoid expensive fan-out reads. Store raw data only when drill-down analysis is required.
- **Frontend rendering strategies**: Throttle DOM updates to the screen refresh rate (16 ms) using `requestAnimationFrame` or debounced batching. Avoid per-message re-renders to prevent UI jank under high-frequency updates.
- **Backpressure handling**: When clients consume slower than the server produces, use bounded channels and drop or downsample the oldest samples rather than buffering indefinitely, preventing memory exhaustion.
- **Reconnection logic**: Implement exponential backoff with jitter on the client side. Upon reconnect, request a snapshot of current state plus a delta of missed events to restore consistency without a full page reload.
- **Data windowing**: Retain only a configurable rolling window of metric history per connection (e.g., the last 5 minutes) using circular buffers, ensuring memory usage stays bounded regardless of uptime.
- **Caching hot metrics**: Store the latest aggregated values in an in-process cache (or Redis) so new subscribers receive an immediate snapshot on connect instead of waiting for the next broadcast cycle.
- **Authentication for WebSocket**: Validate JWT tokens during the HTTP upgrade handshake - not per-message - since WebSocket connections have no built-in per-frame auth. Reject the upgrade early if the token is invalid or expired.
- **Horizontal scaling**: Use a Redis pub/sub channel as the shared message bus across server instances so that any server can broadcast to all connected clients regardless of which instance holds their WebSocket connection.
- **Monitoring real-time systems**: Track active connection count, messages per second, channel fan-out latency, and dropped-update rate as key health signals. Alert when backpressure drop rate exceeds a threshold.

---

### Junior -> FAANG: Summary as a Study Guide

Use this summary as a flashcard set. For each bullet point, close the book and explain the concept in one sentence. If you cannot, that is the topic to re-read.

The most important bullet for first-year engineers is "backpressure handling": when clients consume slower than the server produces, use bounded channels and drop rather than buffering indefinitely. This principle applies to every asynchronous system you will ever build, not just WebSocket servers.

The second most important is "data windowing": retain only a configurable rolling window. Every time you have a data structure that grows over time (a log, a history, a queue), ask "what bounds this?" If there is no bound, you have a latent memory leak.

For the reconnection logic bullet: the exponential backoff formula with jitter is a standard algorithm that appears in distributed systems interviews. Practice implementing it from memory. The core is: `delay = min(base * 2^attempt, maxDelay) + rand(0, jitter)`. Start with `base = 100ms`, `maxDelay = 30s`, `jitter = base`. This produces reconnection attempts at approximately 100ms, 200ms, 400ms, 800ms, and so on, up to 30 seconds, with randomization to avoid synchronized reconnects.

For the authentication bullet: "validate during the HTTP upgrade handshake, not per-message" is the key constraint. WebSocket frames have no built-in auth mechanism. Once the connection is established, the server must trust it for its lifetime. This means the initial auth check must be thorough: validate signature, check expiry, verify audience, and authorize the specific resource the client is requesting access to.

### Senior @ FAANG: Summary as an Organizational Checklist

Each summary point maps to an operational or platform checklist item at L6/L7 level.

**WebSocket vs SSE (platform API contract):** This should be an explicit entry in the platform's developer documentation: when to use WebSocket endpoints and when to use SSE endpoints, with guidance on which load balancer configurations are required for each. Teams that choose the wrong abstraction for their use case create technical debt that is expensive to migrate away from after clients are built.

**Time-series data aggregation (data governance):** The choice of pre-aggregate at write time vs aggregate at query time is a data governance decision. Write-time aggregation reduces query cost but loses raw data granularity. Query-time aggregation preserves raw data but scales poorly with data volume. The decision must be made per metric type (high-frequency infrastructure metrics vs low-frequency business metrics), documented, and enforced by the ingestion schema.

**Backpressure handling (reliability contract):** The platform's reliability contract should state explicitly what happens to data when a downstream consumer is slow. For monitoring metrics: drop and count. For billing events: propagate pressure upstream with an error. For user action logs: buffer in a durable queue. Each policy should be documented per data type and validated in load tests.

**Horizontal scaling via Redis (platform topology governance):** The Redis Pub/Sub bus is a shared resource. As teams onboard to the platform, the number of channels and the volume of messages on the bus grows. A staff engineer tracks bus utilization and defines scaling thresholds: when utilization exceeds 70%, provision an additional Redis cluster shard. When a single channel carries more than 10% of total bus traffic, investigate whether that channel should have its own dedicated bus instance. This is the kind of proactive capacity management that prevents the bus from becoming a single point of failure.

**Authentication for WebSocket (security posture):** At FAANG, WebSocket authentication is not just a per-service decision. It is a platform security requirement. The platform enforces that all WebSocket connections must present a valid JWT from the organization's identity provider, that the JWT must be validated against the organization's public key infrastructure (not a hardcoded secret), and that the claims must include the user's identity, organization, and the specific resource being accessed. Deviations from this standard require a security review and an explicit approval from the security team.
