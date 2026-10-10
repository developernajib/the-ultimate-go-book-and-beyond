## 102H.10 Mid-Chapter Synthesis: Core Architecture Recap

Real-time communication in Go requires careful architecture:

- **WebSocket**: Full-duplex, low-latency. Requires read/write pump separation, heartbeat/ping-pong, and buffered send channels. Scale with Redis pub/sub.
- **SSE**: Unidirectional, simpler. Native browser reconnection. Works through HTTP/2. Best for live feeds, notifications, dashboards.
- **Hub Pattern**: Central message routing with room-based fan-out. Go's `sync.Map` for thread-safe client registry. Disconnect slow clients gracefully.
- **Distribution**: Redis pub/sub for cross-node delivery. Consistent hashing for room affinity.
- **Presence**: Redis sorted sets with TTL-based expiry for online user tracking.
- **Reconnection**: External session state, message buffers, ID-based replay.
- **Collaborative Editing**: Operational Transformation for conflict resolution, per-document sync servers for ordering.

The key challenge in real-time systems is the long-lived connection model - it requires explicit lifecycle management, heartbeat maintenance, and graceful degradation that HTTP request-response systems don't need.

### Junior → FAANG: What to Carry Forward from This Chapter

The two concepts with the highest interview return on investment from this chapter are the single-writer-per-connection rule and the Redis pub/sub horizontal scaling pattern. If you understand why concurrent writes are unsafe (gorilla/websocket is not goroutine-safe for writes) and how to fix it (dedicated writer goroutine with a channel), you can answer the most common WebSocket implementation question. If you understand why a single-server hub breaks when you add a second server and how Redis pub/sub solves it, you can answer the most common real-time scaling question.

A solid summary to practice delivering in 60 seconds: "WebSocket is a full-duplex protocol over a single TCP connection. In Go, each connection runs a reader goroutine and a writer goroutine. A hub goroutine serializes broadcast operations. For multi-server scaling, Redis pub/sub acts as the cross-instance message backplane. SSE is simpler for unidirectional use cases and gets HTTP/2 multiplexing automatically."

### Senior @ FAANG: The Architectural Summary That Matters for Design Reviews

At senior level, the summary to carry forward is a maturity model for real-time infrastructure. Level 1: single-server in-memory hub, goroutine-per-connection, no horizontal scaling. Level 2: Redis pub/sub backplane, stateless connection servers, sticky sessions at the load balancer. Level 3: routing tier for stateless load balancing, replay buffer for at-least-once delivery, connection draining for zero-downtime deployments. Level 4: hierarchical fan-out for very high fan-out scenarios, CRDT-based state synchronization for multi-writer scenarios, global connection routing across geographic regions.

The organizational maturity model parallels the technical one. Level 1: one team owns the WebSocket server and the product that uses it. Level 2: a platform team owns the connection tier and the Redis backplane, product teams use it through an SDK. Level 3: the platform team provides SLOs for the connection tier (availability, message latency, connection capacity) and operates it with on-call coverage. Level 4: the connection tier is a first-class service with its own reliability engineering, capacity planning, and multi-region deployment.

Understanding both models and being able to articulate where a given organization sits on both is the staff-level contribution to real-time system design discussions.

---
