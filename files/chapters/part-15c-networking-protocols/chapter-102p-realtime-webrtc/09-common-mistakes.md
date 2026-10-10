## 102P.7 Common Pitfalls in Real-Time Systems

| Mistake | Problem | Solution |
|---------|---------|----------|
| Unbuffered write channel | Blocks on slow client | Use buffered channel (256+). Drop and close slow clients |
| No ping/pong keepalive | Connections silently die behind proxies | Send ping every 54s. Expect pong within 60s |
| Sending from multiple goroutines | WebSocket is not goroutine-safe | Single writer goroutine per connection (writePump) |
| No backpressure on broadcast | Memory exhaustion with slow clients | Non-blocking send. Disconnect slow clients |
| Forgetting compression | 5-10× more data over wire | `EnableCompression: true` in upgrader |
| OT without server-side ordering | Conflicts not resolved correctly | Server is the authority. All ops go through server |
| CRDT for complex data | Some CRDTs grow unboundedly | Use compaction/garbage collection for tombstones |
| No reconnection logic in client | Network blip = disconnected user | Exponential backoff with SSE `retry:` or WS reconnect |

### Junior → FAANG: The Three Mistakes with the Highest Incident Rate

The three mistakes with the highest production incident rate in real-time systems are: no reconnection logic (users see "disconnected" errors during any network interruption, even a one-second mobile handoff), OT without server-side ordering (document corruption under concurrent edits that passes testing because tests are sequential), and no backpressure on slow clients (one slow client can block broadcast for all other clients in the room).

Practice explaining each of these in two sentences: what the symptom is, and what the fix is. "No reconnection logic: users see a broken state after any network interruption. Fix: implement exponential backoff reconnection on the client, and design the server to handle reconnects without creating duplicate state."

### Senior @ FAANG: Mistakes as Signals for Missing Architectural Constraints

Each mistake in this table reveals a missing architectural constraint. "OT without server-side ordering" means the architecture did not define where the operation ordering authority lives. The fix is not just "add server-side ordering". It is updating the architectural documentation to explicitly specify that the OT server is the sole ordering authority, and adding a CI test that verifies the server correctly handles concurrent operations from two simulated clients.

"CRDT for complex data with unbounded growth" means the CRDT selection did not include a GC strategy. The architectural constraint that was missing: every CRDT type deployed in production must have a documented GC protocol with a tested implementation. Without this constraint, CRDT implementations accumulate unbounded state until they cause an OOM, which happens in production, not in tests.

The platform engineering response to common mistakes: each mistake that appears more than twice across teams becomes a platform requirement. A CRDT library that enforces GC through its API (requiring a GC strategy to be provided at construction time) prevents the mistake at the point of use. This is the "make the wrong thing impossible" approach to platform design.

