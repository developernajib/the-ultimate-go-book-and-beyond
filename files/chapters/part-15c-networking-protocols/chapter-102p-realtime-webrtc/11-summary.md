## 102P.9 Mid-Chapter Synthesis: Real-Time & WebRTC Core Architecture Recap

| Topic | Key Pattern |
|-------|-------------|
| WebSocket hub | Single channel per client. One reader/writer goroutine pair |
| Backpressure | Non-blocking send. Disconnect slow clients |
| Keepalive | Ping every 54s. Pong timeout 60s. Read deadline reset on pong |
| SSE | `text/event-stream`, `http.Flusher`, heartbeat comments |
| WebRTC signaling | SDP offer/answer + ICE candidate relay |
| GCounter | Max merge. Grows only |
| LWW Register | Timestamp + nodeID tie-break |
| OR-Set | Tags per element. Observe-remove semantics |
| OT Transform | Transform concurrent ops. Server orders all ops |
| Presence | Redis sorted set + TTL. Pub/sub for change events |

### Junior → FAANG: The Summary Table as a Flash Card Set

Each row in this table is a flash card. Practice recalling the key pattern from the topic, and the topic from the key pattern. "One reader/writer goroutine pair" should immediately surface "WebSocket hub per-connection model." "Max merge, grows only" should immediately surface "G-Counter CRDT." This bidirectional recall is what enables fast, fluent answers in interviews where the question may be phrased from either direction.

The rows that reward deeper study beyond the summary: OT Transform (because the summary hides the complexity of the transform function itself) and WebRTC signaling (because "SDP offer/answer + ICE candidate relay" is the what, not the how or why). Use the summary as a starting point for identifying which topics need more depth, not as a complete study guide.

### Senior @ FAANG: The Missing Rows in the Summary Table

A production deployment summary for this chapter would add rows that are not in the table: "Connection draining: SIGTERM handler sets accepting=false, returns 503, waits for existing connections to close with drain timeout." "CRDT GC: periodic compaction of tombstones requires acknowledgment from all replicas that they have applied the stable state." "SFU topology: room-pinned SFU assignment with load-based failover, geographic routing for initial placement." These rows represent the operational depth that separates a prototype from a production system.

At FAANG, the summary table for an infrastructure component is an operational contract: what behavior is guaranteed, what are the limits, and what happens at the limits? The gaps in the summary table are the gaps in the operational contract. Identifying and filling those gaps before a production deployment is the L6 platform engineering contribution.

---
