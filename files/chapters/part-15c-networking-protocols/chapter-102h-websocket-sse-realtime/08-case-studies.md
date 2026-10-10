## 102H.6 Real-World Case Studies (Discord, Stripe, Figma)

### Case Study 1: Discord's WebSocket Architecture

**Scale**: millions of concurrent WebSocket connections across multiple regions (Discord's engineering posts describe gateway fleets in the multi-million concurrent range).

**Architecture**:
- **Gateway nodes**: Handle raw WebSocket connections. Each node supports 100K-250K connections.
- **Session server**: Maintains user session state, separate from gateway. Allows gateway restarts without dropping state.
- **Resume**: Clients send sequence number. On reconnect, server replays missed events from sequence number.
- **Heartbeat**: Server sends `HELLO` with `heartbeat_interval`. Client must send `HEARTBEAT` within interval or connection is closed.
- **Sharding**: Client ID % NUM_SHARDS determines which gateway cluster handles the client.

**Go-specific**:
- gorilla/websocket with custom read/write pump per connection
- Redis pub/sub for cross-shard broadcasting
- Connection metadata stored in Redis (500 bytes per connection × 8.5M = 4.25GB)

### Case Study 2: Stripe's Dashboard Real-Time Updates

**Use case**: Live payment feed on Stripe Dashboard - transactions appear in real-time as they happen.

**Architecture**: SSE (not WebSocket) because:
- Unidirectional (server → browser only)
- Works through HTTP/2 and CDN proxies
- Auto-reconnect is built into browsers
- Lower server overhead than WebSocket

**Implementation**:
- Each user session subscribes to SSE endpoint with their account ID
- Payment events published to Redis Streams
- SSE workers consume Redis Streams and push to connected browsers
- Event IDs = Redis stream IDs - enables resume after disconnect

**Scale**: 100K+ connected dashboards, 1M+ events/day.

### Case Study 3: Figma's Collaborative Editor

**Use case**: Multiple designers editing the same file in real-time.

**Architecture**:
- WebSocket for low-latency bidirectional updates
- Operational Transformation (OT) for conflict resolution
- Each document has a dedicated "sync server" (a single authoritative node for ordering)
- Changes: client → sync server → OT → broadcast to all clients
- Presence: who's viewing, cursor position, selections - all via WebSocket

**Scalability challenge**: Single sync server per document is a bottleneck.
**Solution**: Shard documents across many sync servers. Rarely-edited documents are idle and use minimal resources.

### Junior → FAANG: Reading Engineering Case Studies for Interview Material

Each case study in this section is a source of interview answers. The Discord architecture teaches: Erlang for process-per-connection at massive scale, Go for services where the goroutine model fits. The Figma architecture teaches: document sharding as the solution to the single-sync-server bottleneck. These are the kind of specific, well-sourced examples that make interview answers memorable.

The habit to build: when you read an engineering blog post from a major company, extract two things. First, what was the problem at scale that their previous architecture could not handle? Second, what was the specific technical decision that solved it? Discord's move from Python monolith to Elixir for connection handling is a clean example of identifying the right language for the concurrency model. Figma's document sharding is a clean example of identifying the right partitioning key (document ID) for horizontal scaling.

Interview entry point: "tell me about a real-time system you have studied or worked on at scale." Having studied Discord and Figma's architectures in detail, and being able to explain the specific tradeoffs they made, is a strong answer even without personal production experience at that scale.

### Senior @ FAANG: Case Studies as Sources of Architectural Anti-Patterns

At senior level, case studies are most valuable for the anti-patterns they reveal, not just the solutions. Discord's "Why Discord Is Switching from Go to Rust" post is about memory allocation pressure and GC pauses under sustained load, not about language preference. Figma's sync server sharding addresses the single-point-of-coordination bottleneck, but also reveals the challenge of document migration when shards become unbalanced. These are patterns that appear in every large-scale real-time system.

The pattern to extract from the Figma case: document sharding solves the per-document coordination bottleneck, but creates a new problem when a single document has more concurrent editors than one shard server can handle. The next level of scaling for collaborative editing is intra-document sharding by operation type or by document section. This is the engineering problem that companies like Google Docs and Notion face at their scale, and it leads to CRDT-based architectures where coordination is eliminated rather than centralized.

The L6 interview signal: candidates who can move from "here is how company X solved their problem" to "here is the next-order problem that solution creates, and here is how you would approach it" are demonstrating the kind of second-order systems thinking that FAANG bar-raiser rounds are designed to elicit.

---
