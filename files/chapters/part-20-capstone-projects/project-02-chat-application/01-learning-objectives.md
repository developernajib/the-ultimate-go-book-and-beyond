## Learning Objectives

By completing this project, you will:

1. Master WebSocket programming in Go
2. Build horizontally scalable real-time systems
3. Implement message brokers for cross-server communication
4. Design efficient database schemas for chat applications
5. Handle file uploads and media processing
6. Implement user presence and typing indicators
7. Build production-ready authentication and authorization
8. Scale WebSocket servers across multiple instances
9. Implement rate limiting and security best practices
10. Deploy a complete real-time application

---

### Junior → FAANG: Mapping Objectives to Concurrency Concepts

Objectives 1 through 4 (WebSocket, concurrent connections, fan-out, presence) are all concurrency problems in disguise. Each one requires understanding how goroutines share state safely. Before your interview, be able to describe what happens when two goroutines simultaneously try to write to the same WebSocket connection (undefined behavior, potential panic) and how your code prevents it (a write mutex or a dedicated writer goroutine per connection).

Presence tracking (knowing who is online) is a deceptively tricky distributed systems problem. The naive approach (a Redis key per user that expires) has a race condition: the TTL may expire before the client sends a heartbeat, producing a false "offline" signal. The correct approach uses a heartbeat interval shorter than the TTL by a safety margin and refreshes the key on each heartbeat. Know this detail.

### Senior @ FAANG: Delivery Guarantees as a Product Contract

The ten objectives above are implementation milestones. The senior framing is: what delivery guarantee does this system provide to its users? "At most once" (messages may be lost but never duplicated), "at least once" (messages are never lost but may be duplicated), or "exactly once" (messages are never lost and never duplicated)?

WebSocket delivery is inherently at-most-once: if the connection drops after the message is sent but before the client processes it, the message is lost. Moving to at-least-once requires client-side acknowledgment and server-side retry. Exactly once requires distributed transactions or idempotency keys with deduplication logic. Each guarantee is progressively more expensive to implement and operate. The ADR must document which guarantee the product requires and why, because all subsequent design decisions flow from that choice.

---
