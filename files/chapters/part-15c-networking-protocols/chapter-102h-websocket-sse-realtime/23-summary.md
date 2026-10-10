## Summary

- **Horizontal scaling** requires externalising connection state. Redis pub/sub is the standard message bus for cross-node WebSocket delivery. Consistent hashing reduces Redis traffic by routing rooms to home servers.
- **Graceful draining** is essential for zero-downtime deploys. Stop accepting new connections first, then wait for existing connections to close within a configurable timeout.
- **SSE with Last-Event-ID** provides seamless reconnection with no client-side code. Maintain an in-memory event buffer on the server. Replay missed events on reconnect.
- **HTTP/2 multiplexing** eliminates SSE's connection limit problem - each SSE stream is one H2 stream over a shared TCP connection.
- **CQRS with Kafka** decouples write throughput from read fan-out. Kafka provides durability and replay. WebSocket servers are pure consumers.
- **Presence systems** use Redis sorted sets with timestamp scores. TTL-based pruning handles ungraceful disconnects without explicit cleanup.
- **Operational Transform** is the correct approach for collaborative editing with a single authoritative server ordering ops. For multi-master scenarios, CRDTs (G-Counter, OR-Set, LWW-Register) converge without coordination.
- **Production hardening** requires: connection pool limits, per-connection rate limiting, `SetReadLimit` on every connection, write deadlines on every send, and a single writer goroutine per connection.
- **Metrics** should track active connections, messages/sec, error rates, and a latency histogram. Expose via Prometheus `/metrics` or `expvar` `/debug/vars`.
- **The five critical anti-patterns** to avoid: concurrent writes to one connection, blocking hub on slow clients, missing read limits, unset proxy buffering headers, and immediate reconnect without backoff.

### Junior → FAANG: The Five Anti-Patterns as Your Self-Review Checklist

The five anti-patterns in this summary are your pre-ship checklist for any WebSocket implementation. Run through them before opening a PR: is there any code path where two goroutines write to the same connection? Can a slow client block the hub goroutine? Is `SetReadLimit` called on every connection? Are the proxy unbuffering headers set in the HTTP handler? Does the client reconnection code use exponential backoff? A single yes to any of these means the implementation is not production-ready.

Practicing this checklist on your own code before code review will reduce the number of review cycles and build a reputation for shipping correct, production-ready code from the first submission. That reputation is built by consistent attention to the details that most engineers skip.

### Senior @ FAANG: The Summary as a Platform Health Framework

At FAANG scale, the bullet points in this summary are KPIs for platform health, not just implementation reminders. Horizontal scaling with Redis pub/sub: what is the Redis pub/sub latency p99 and is it within the product SLA? CRDT convergence for collaborative editing: what is the measured convergence time under simulated concurrent edits and is it within the UX requirement? Production hardening: are all five anti-patterns enforced by the platform layer or only recommended in documentation?

The governance question that is rarely asked but always matters: how does the platform team know when a new service has been deployed that uses WebSocket without the production hardening controls? The answer requires either mandatory integration with a platform SDK (which enforces controls at the library level) or a scanning system that detects WebSocket handlers missing required headers and rate limiting, and flags them in a security review queue. Neither of these is easy to build, but both are better than discovering missing controls after an incident.

---

### Navigation

- **Previous Chapter**: [Part XV-C - Networking Protocols & Real-Time Communication](../00-part-intro.md)
- **Next Chapter**: [Chapter 102I - Protocol Internals: HTTP/2, HTTP/3, and QUIC](../chapter-102i-protocol-internals/00-introduction.md)

