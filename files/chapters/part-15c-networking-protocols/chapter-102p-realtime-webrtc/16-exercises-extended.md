## Exercises

### Exercise 7: Build a Go Signaling Server with Room Management

Implement a production-grade WebRTC signaling server with the following requirements:

**Requirements:**
- REST endpoint `POST /rooms` - creates a room, returns `{ roomId, turnCredential }`.
- WebSocket endpoint `WS /rooms/:id/signal` - handles SDP offer/answer and ICE candidate relay.
- Each room has a max capacity of 8 peers (return `423 Locked` when full).
- Peers are assigned a UUID on join. On disconnect, broadcast a `peer-left` event to remaining peers.
- Ephemeral TURN credentials (HMAC-SHA1, 1-hour TTL) are generated and returned at room join.
- Room state stored in memory with a 30-minute inactivity TTL (use `time.AfterFunc`).

**Signal message format:**

```json
{ "type": "offer",     "from": "uuid-a", "to": "uuid-b", "sdp": "..." }
{ "type": "answer",    "from": "uuid-b", "to": "uuid-a", "sdp": "..." }
{ "type": "ice",       "from": "uuid-a", "to": "uuid-b", "candidate": "..." }
{ "type": "peer-joined", "peerId": "uuid-c" }
{ "type": "peer-left",   "peerId": "uuid-a" }
```

**Hints:**
- Use a `map[peerID]*websocket.Conn` per room (protected by `sync.RWMutex`).
- The signaling server only relays messages - it never interprets SDP or ICE payloads.
- Test with two browser tabs using the browser's native `RTCPeerConnection`.

---

### Exercise 8: Implement a Simple CRDT Text Editor Sync Server

Build a Go WebSocket server that synchronizes a shared plain-text document across multiple clients using a simple **Last-Write-Wins** CRDT for individual characters.

**Requirements:**
- Each character in the document is identified by a globally unique `(siteID, clock)` tuple.
- Insertions carry: `{ opType: "insert", id: [siteID, clock], after: [siteID, clock] | null, char: "x" }`.
- Deletions carry: `{ opType: "delete", id: [siteID, clock] }`.
- The server maintains the full ordered sequence of (non-deleted) character nodes.
- New clients receive a full snapshot on join (all insert operations in causal order).
- Operations are broadcast to all other clients after the server applies them.

**Go data model:**

```go
// CharNode represents a single character in the CRDT sequence.
type CharNode struct {
	ID       [2]int64 // [siteID, clock]
	AfterID  *[2]int64
	Char     rune
	Deleted  bool
}

// CRDTDoc is the server-side document state.
type CRDTDoc struct {
	mu    sync.RWMutex
	nodes []*CharNode // ordered by causal position
}
```

**Stretch goals:**
- Implement cursor position broadcasting (each client sends cursor position as a separate op type).
- Add a simple HTTP endpoint `GET /doc/:id/text` that returns the current plain-text content.
- Benchmark concurrent insert throughput with 10 goroutines simulating clients (`go test -bench=.`).

### Junior → FAANG: Sequencing the Exercises for Maximum Learning

Exercise 7 (signaling server with room management) is the right starting point because it is the most interview-relevant exercise in this section. After completing it, you can describe the WebRTC signaling flow from implementation experience rather than from reading. The signaling server is also the exercise with the most transferable skills: WebSocket hub, room state management, state machine enforcement, and concurrent access patterns.

Exercise 9 (CRDT RGA implementation) is the deepest exercise and requires the most background reading. Start with the RGA paper or the Yjs source code before implementing to understand the algorithm. Implementing it from scratch and running the concurrent insert benchmark reveals the performance characteristics that production CRDT systems must optimize.

The exercises that produce the most interview-ready artifacts: exercise 7 (signaling server you can walk through in detail), exercise 9 (CRDT implementation with benchmark results you can quote), and the concurrent insert benchmark from part 8 (concrete throughput numbers for a CRDT structure).

### Senior @ FAANG: Extending Exercises to Production-Ready Systems

Each exercise in this section is a prototype. Extending it to production-ready requires adding the operational dimensions that the exercise omits. Exercise 7 (signaling server): add horizontal scaling with consistent hashing, session state persistence in Redis for reconnection recovery, ICE success rate metrics per room, and a graceful shutdown that signals all rooms that the server is restarting.

Exercise 9 (CRDT implementation): add GC with acknowledgment protocol (simulate two clients, both acknowledge the compaction point, verify tombstones are removed), measure memory growth over 10,000 insertions with and without GC, and document the GC protocol as an API contract.

The production-readiness test for any real-time system exercise: disconnect one party mid-session. What happens? Does the system recover gracefully? Does the data remain consistent? Does the other party receive a clear indication that their collaborator disconnected? Answers to these questions separate prototypes from production systems.


---
