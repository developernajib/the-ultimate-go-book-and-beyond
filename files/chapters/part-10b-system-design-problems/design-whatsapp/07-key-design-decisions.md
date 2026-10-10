## Key Design Decisions

Every system design involves trade-offs, and interviewers want to hear you articulate not just what you chose but why, and what you give up. The decisions below represent the most impactful architectural choices in a messaging platform at WhatsApp scale.

### Decision 1: Three-Tier Connection Routing (Local → Redis → Offline Queue)

**Choice:** Each WebSocket server holds an in-memory map of userID → connection. Redis stores a `presence:{userID} → serverID` mapping with a 5-minute TTL. Message delivery follows a three-step fallback: check local connections first, then query Redis for the target server, then enqueue to the offline queue.

**Why:** Checking the local map first avoids a network round trip for the common case where sender and recipient are on the same server (co-located users or small deployments). Redis Pub/Sub handles cross-server routing without requiring a centralized message broker for every message. The offline queue holds messages for disconnected users so they are not dropped on the floor.

**Trade-off:** The presence TTL means a user who crashes without a clean disconnect appears online for up to 5 minutes, and this window is nastier than it looks. Redis still names a server, so delivery publishes to that server's channel. Pub/Sub is fire-and-forget: publishing to a channel with no subscribers succeeds and reports one thing only, that zero receivers got it. The routing layer therefore cannot tell "delivered" from "dropped", and the offline-queue fallback never triggers, because nothing returned an error.

This is why the durable write to Cassandra happens *before* the routing attempt, and why routing is treated as a latency optimization rather than the delivery mechanism. The message is safe the moment it is persisted. A client reconnecting asks for everything after its last acknowledged message ID and collects whatever the Pub/Sub hop lost. Designs that route first and persist opportunistically inherit exactly this hole, and it only shows up when a server dies.

---

### Decision 2: Cassandra for Message Storage (vs. PostgreSQL / DynamoDB)

**Choice:** Cassandra partitioned by `conv_id` with time-based clustering. Messages have a 30-day TTL. Group messages are stored once per conversation, not per member.

**Why:** At 100 billion messages per day (1.16 million per second on average, two to three times that at peak), no single-node relational database can handle the write throughput. Cassandra's leaderless replication and append-only storage engine absorb this write rate across a cluster. Partitioning by `conv_id` ensures all messages in a conversation are co-located, making "load chat history" a single-partition sequential read that completes in single-digit milliseconds. The 30-day TTL automatically reclaims storage without cleanup jobs.

**Trade-off:** Cassandra does not support cross-partition joins or transactions. You cannot run a query like "find all messages containing keyword X" across conversations. This is acceptable because messages are E2E encrypted, the server stores opaque blobs and cannot search content anyway.

---

### Decision 3: Hybrid Group Fan-Out (Direct vs. Kafka)

**Choice:** For groups with fewer than 100 members, deliver messages directly from the sender's connection thread using goroutine fan-out. For large groups (up to 1,024 members), publish to a Kafka topic and let a consumer group handle delivery asynchronously.

**Why:** Direct delivery for small groups keeps latency under 50ms, there is no queuing overhead. But delivering to 1,024 recipients synchronously from a single goroutine would block the sender's WebSocket read loop for 200-500ms, causing perceived lag. Kafka decouples the send from the delivery, letting the sender receive an acknowledgment immediately while consumers deliver at their own pace.

**Trade-off:** Large group messages have higher delivery latency (100-500ms vs. sub-50ms for small groups). Members of large groups may see the same message at slightly different times. Both are acceptable trade-offs for preventing sender-side blocking.

---

### Decision 4: Redis List for Offline Queue (vs. Kafka / Database)

**Choice:** Each offline user has a Redis list (`offline:{userID}`) that stores serialized messages. On reconnect, the list is drained in batches with `LPOP count` and delivered in order. Messages expire after 30 days.

**Why:** Redis lists support O(1) append and O(count) pop, making them ideal for per-user queues. Kafka would require a topic per user (2 billion topics is impractical) or complex partition routing. A database-backed queue would add write latency to every offline message delivery. Redis keeps the offline queue in memory, ensuring fast flush on reconnect.

**Draining is where this goes wrong.** The tempting implementation is `LRANGE key 0 -1` to read the batch, then `DEL key` to clear it. Those are two round trips, and they are not one operation. Any message another server `RPUSH`es in the gap between them is deleted having never been read by anyone. Nothing logs an error, the sender saw a successful write, and the message is simply gone. `LPOP key count` reads and removes in a single atomic step, so a concurrent push either precedes the pop and is delivered, or follows it and waits for the next batch. Pair that with only popping what you can actually hand to the socket, and returning the remainder with `LPUSH` if the client stalls, or you have moved the same data loss from Redis into your own process.

**Trade-off:** Redis is not durable by default, so a server restart loses queued messages. Mitigation: AOF persistence with `appendfsync everysec` bounds the loss to roughly one second of writes, and replication with Sentinel or Cluster mode narrows it further. Note that this bounds the loss rather than eliminating it, which is why the offline queue is an optimization for fast reconnect and Cassandra remains the durable record. A client that reconnects re-requests everything after its last acknowledged message ID, so a lost queue entry costs latency, not the message.

---

### Decision 5: End-to-End Encryption (Signal Protocol)

**Choice:** The server never has access to message content. The content column stores the Signal Protocol ciphertext, produced by X3DH key agreement over Curve25519 and the Double Ratchet. Key exchange happens device-to-device. The server sees the metadata: sender, recipient, timestamp, and message size.

**Why:** E2E encryption is WhatsApp's core privacy guarantee. Even if the server is compromised, message content remains unreadable, because the keys were never there to steal. The Double Ratchet provides forward secrecy (compromising today's key does not reveal past messages) and break-in recovery (the ratchet heals after a compromise, so an attacker who steals a key must keep stealing to keep reading).

Two precision points, since both are common ways to lose credibility in an interview. First, do not call this zero-knowledge. Zero-knowledge is a property of proof systems, and E2E is not one. Second, the Double Ratchet does not encrypt records with AES-GCM. The specification's concrete recommendation is AES-256-CBC with PKCS#7 padding plus HMAC-SHA256, encrypt-then-MAC, with HKDF splitting the message key into an encryption key, a MAC key, and an IV.

**Trade-off:** The server cannot moderate content, search messages, generate media thumbnails, or offer server-side backup without additional key management. All of those move on-device or do not happen. The subtler cost is that E2E buys content confidentiality and *not* metadata privacy: the server must route the message, so it necessarily learns who talks to whom and when. That graph is often more sensitive than the text, and any design that claims E2E while indexing message content, or scanning media server-side, has quietly contradicted itself.

---
