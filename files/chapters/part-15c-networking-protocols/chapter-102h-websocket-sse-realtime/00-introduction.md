# Chapter 102H: WebSocket, SSE, and Real-Time Communication

> *"The web was built for documents, but users want conversations. Real-time communication transforms a passive page into a living, breathing experience - and Go's concurrency model makes it uniquely suited to sustain millions of those conversations at once."*

The HTTP request-response cycle, elegant as it is, was designed for fetching documents - not for the live, bidirectional data flows that define modern applications. Chat platforms, collaborative editors, live dashboards, multiplayer games, and financial trading terminals all share a common requirement: the server must push data to the client the instant something changes, without waiting to be asked. WebSockets and Server-Sent Events (SSE) are the two battle-tested answers to this problem, and Go's runtime - with its lightweight goroutines and channel-based concurrency - is one of the best runtimes in existence for operating them at scale.

WebSockets upgrade a standard HTTP connection into a persistent, full-duplex channel. Once the handshake completes, either side can send frames at any time with no polling overhead. The `gorilla/websocket` library has been the de facto Go implementation for years, exposing a clean API over the raw protocol and handling fragmentation, ping/pong keep-alives, and close handshakes. SSE takes a simpler, unidirectional approach: the server opens a long-lived HTTP response and streams `text/event-stream` data to the client. Because SSE rides plain HTTP/2, it benefits from multiplexing and automatic reconnection - making it the pragmatic choice for notification feeds, progress reporting, and log streaming where client-to-server messaging is not required.

Scaling real-time systems introduces coordination challenges that do not exist in stateless REST APIs. A single server can hold WebSocket connections in memory, but when you add a second instance the connection state is partitioned - a message published to instance A never reaches clients connected to instance B unless you introduce a shared backplane. Redis pub/sub, with its sub-millisecond fan-out latency, is the standard solution at moderate scale. At higher scale, dedicated brokers such as NATS or Kafka carry messages across the cluster while Go's goroutine-per-connection model handles local delivery. This chapter covers the full path: from a single-server WebSocket echo server all the way to a Redis-backed, horizontally scalable broadcast system with graceful connection draining during rolling deployments.

**What you'll learn in this chapter:**

- Building production WebSocket servers with `gorilla/websocket` that handle 100K+ concurrent connections
- Implementing Server-Sent Events (SSE) for efficient unidirectional server-to-client streaming over HTTP/2
- Designing hub-and-spoke pub/sub architectures for room-based broadcasting and presence tracking
- Managing WebSocket connection lifecycle: handshake, heartbeat/ping-pong, graceful close, and reconnection backoff
- Scaling real-time systems horizontally using Redis pub/sub as a cross-instance message backplane
- Applying backpressure and slow-consumer detection to prevent one lagging client from stalling the entire system
- Comparing WebSocket, SSE, HTTP/2 Push, long-polling, and gRPC streaming for different real-time use cases
- Implementing graceful connection draining during rolling deployments with zero dropped messages

**Why this matters at scale:**

Slack maintains millions of persistent WebSocket connections across its global infrastructure to deliver instant messaging to teams. Figma's collaborative design platform relies on real-time WebSocket state synchronization so that cursor movements and edits appear instantaneously for every collaborator. Robinhood uses SSE-based market data streams to push live price ticks to millions of retail traders. Cloudflare's Workers platform powers real-time APIs for customers who cannot tolerate polling latency. Each of these systems was built on the same foundational primitives covered in this chapter - the engineering challenge lies in combining them correctly at scale.

**Prerequisites:** Chapters on Go concurrency (goroutines, channels, sync primitives), HTTP server fundamentals, and basic Redis familiarity are assumed. Familiarity with the WebSocket RFC (RFC 6455) is helpful but not required.

### Junior → FAANG: Why Real-Time Protocols Are an Interview Staple

WebSocket and SSE appear in FAANG interviews at a rate disproportionate to how often most engineers implement them from scratch. The reason is that they test multiple foundational skills simultaneously: HTTP upgrade mechanics, goroutine lifecycle management, backpressure, connection state at scale, and distributed system coordination. Knowing the protocol well enough to implement a correct hub-and-spoke model, and being able to explain why a naive implementation breaks under concurrent load, is the entry point.

The most common interview failure mode: candidates who have used `gorilla/websocket` but cannot explain what happens if two goroutines call `conn.WriteMessage` concurrently (undefined behavior, potential panic or corrupted frames). Always describe WebSocket as requiring a single writer goroutine per connection, and explain why.

Interview entry point: when asked to design a chat system, start with a single-server WebSocket hub, describe the goroutine model (one reader goroutine and one writer goroutine per connection), then explain how you would extend it horizontally with Redis pub/sub as the cross-instance backplane.

### Senior @ FAANG: Real-Time Systems as Platform Infrastructure

At FAANG scale, real-time infrastructure is not a feature, it is a platform. Slack's WebSocket gateway, Discord's voice infrastructure, and Figma's collaboration layer are standalone platform teams, not feature teams. This distinction has architectural implications: platform teams design for N consumers with varying SLAs, not for one product with known load patterns.

The ADR for real-time infrastructure must answer: what is the connection lifecycle model (persistent per user, ephemeral per action, or session-based)? What is the delivery guarantee (at most once, at least once, or exactly once)? What is the ordering guarantee (global, per-channel, or best effort)? What is the horizontal scaling model (sticky sessions, consistent hashing, or stateless with shared backplane)? These questions have different answers for a chat product versus a collaborative editor versus a live financial dashboard, and the platform design must accommodate all intended consumers without requiring each to build their own connection management.

The L6 signal in real-time design interviews: candidates who define the delivery and ordering guarantees first, before discussing implementation, are demonstrating that they understand real-time systems as distributed systems problems, not just protocol problems.

---
