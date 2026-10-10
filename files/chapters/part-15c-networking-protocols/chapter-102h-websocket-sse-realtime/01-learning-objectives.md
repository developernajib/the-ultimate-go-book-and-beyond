## Learning Objectives

By the end of this chapter, you will be able to:
- Build production WebSocket servers handling 100K+ concurrent connections
- Implement Server-Sent Events (SSE) for unidirectional streaming
- Design pub/sub systems for real-time message broadcasting
- Handle WebSocket connection lifecycle, heartbeats, and reconnection
- Implement room-based chat, live dashboards, and collaborative editing
- Build horizontally scalable real-time systems using Redis pub/sub
- Apply backpressure and flow control for slow consumers
- Compare WebSocket, SSE, HTTP/2 Push, and long-polling for different use cases

### Junior → FAANG: Translating Learning Objectives into Interview Readiness

Each objective in this list maps to a specific interview question type. "Build production WebSocket servers handling 100K+ concurrent connections" maps to "how does your goroutine model scale, and what limits throughput?" "Apply backpressure and flow control for slow consumers" maps to "what happens when a client reads slower than the server writes?" "Compare WebSocket, SSE, HTTP/2 Push, and long-polling" maps to the classic "when would you choose X over Y?" decision framework question.

For the decision framework objective specifically: the answer structure that works well in interviews is to identify the key differentiating dimensions (bidirectionality, protocol overhead, browser support, connection count per origin, reconnection behavior) and map each protocol to its optimal scenario, rather than giving a generic "it depends." SSE is optimal for unidirectional server-to-client updates where clients are browsers and reconnection is needed automatically. WebSocket is optimal for bidirectional, low-latency applications. Long-polling is a fallback for environments where persistent connections are blocked by proxies.

### Senior @ FAANG: Which Objectives Reveal Depth at L6

The objectives that differentiate L5 from L6 in real-time systems design are the last three: backpressure, horizontal scaling, and protocol comparison. An L5 candidate implements backpressure by dropping messages when a send channel is full. An L6 candidate designs a backpressure system that distinguishes between transient slow consumers (where buffering is appropriate) and persistently slow consumers (where connection termination is the correct action), and can explain how to measure which situation you are in.

For horizontal scaling, the L5 answer is "Redis pub/sub." The L6 answer describes the Redis pub/sub model's limitations (no persistence, no guaranteed delivery, at-most-once semantics), when those limitations matter for the product (they matter in financial systems, they may not matter in cursor position sharing), and what the alternatives are (Redis Streams for at-least-once with replay, NATS JetStream for durable consumer groups, Kafka for high-throughput ordered event streams).

---
