## System Architecture

### High-Level Architecture

The chat system uses a multi-server WebSocket topology where a load balancer with sticky sessions routes each client to a single server for the lifetime of its connection. Because messages sent to one server must reach clients connected to other servers, Redis Pub/Sub acts as the cross-server message bus: every server subscribes to the channels its clients have joined, and publishing a message to Redis fans it out to all subscribed servers simultaneously. PostgreSQL provides durable message history and user records, ensuring conversations survive server restarts.

```
┌─────────────┐
│   Client    │ (Web/Mobile)
└──────┬──────┘
       │ WebSocket
       │
┌──────▼──────┐
│  Load       │
│  Balancer   │ (Sticky Sessions)
└──────┬──────┘
       │
       ├───────────────┬───────────────┐
       │               │               │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│  WebSocket  │ │  WebSocket  │ │  WebSocket  │
│  Server 1   │ │  Server 2   │ │  Server 3   │
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
                 ┌─────▼─────┐
                 │   Redis   │ (Pub/Sub + Cache)
                 └─────┬─────┘
                       │
                 ┌─────▼─────┐
                 │PostgreSQL │ (Persistence)
                 └───────────┘
```

### Components
1. **WebSocket Servers**: Handle real-time connections
2. **Redis Pub/Sub**: Cross-server message broadcasting
3. **Redis Cache**: User sessions, presence data, rate limiting
4. **PostgreSQL**: Message persistence, user data, channels
5. **S3-compatible Storage**: File uploads (MinIO for local dev)
6. **REST API**: Initial authentication, channel management

### Junior → FAANG: Architecture Vocabulary for the Interview

The multi-server WebSocket topology with Redis Pub/Sub fan-out is the canonical real-time architecture. Learn this diagram well enough to draw it from memory and narrate it in two minutes. The sticky session requirement (each client must consistently connect to the same server for its connection lifetime) is a subtle detail that interviewers often probe: "what happens if the load balancer doesn't support sticky sessions?" The answer is that every message write would need to be routed through the central broker regardless of which server the client is on, which Redis Pub/Sub already provides. Sticky sessions reduce Redis traffic by keeping clients on a server that already has the subscription open.

The "REST API for initial auth, WebSockets for messaging" split is a deliberate design choice. WebSockets do not carry standard HTTP headers on each message, so authentication must happen at connection time (using a token in the initial HTTP upgrade request). Be able to explain that constraint and how you validate the token.

### Senior @ FAANG: Architecture Tradeoffs at Each Layer

At senior level, the architecture diagram is a starting point for a tradeoff analysis, not a final answer. Each component choice has alternatives:

WebSockets versus server-sent events (SSE): SSE is simpler (HTTP, no special server support), supports only server-to-client push, and works through standard HTTP proxies. WebSockets support bidirectional communication but require WebSocket-aware proxies and load balancers. For a read-heavy use case (like a notifications feed), SSE is often the right choice. For a bidirectional chat system, WebSockets are correct. Document this decision.

Redis Pub/Sub versus Kafka: Redis Pub/Sub is simple and low-latency but has no message persistence (messages not received at the moment of publish are lost) and limited throughput. Kafka provides durable, ordered, replayable message streams with high throughput but adds significant operational complexity. For a chat system at Slack scale, Kafka is the correct choice for the message bus. For a chat system at GoChat scale (thousands of users), Redis Pub/Sub is sufficient and simpler. The scaling threshold that triggers the migration is worth documenting.

PostgreSQL as the message store has a critical limitation at scale: message tables grow without bound and queries against old messages slow down over time. Partitioning by time (monthly or weekly partitions, with older partitions archived to cold storage) is the standard mitigation. The retention and archival policy is a product and compliance decision. At FAANG, these policies are negotiated between engineering, legal, and product teams before the system is built.

---
