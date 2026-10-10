## 102P.11 Real-Time Collaboration with CRDTs (Advanced Sync)

### LWW Register vs RGA for Text

| CRDT Type | Algorithm | Strengths | Weaknesses |
|---|---|---|---|
| **LWW Register** | Last Write Wins by timestamp | Simple, O(1) merge | Interleaving conflict on concurrent edits |
| **RGA** (Replicated Growable Array) | Causal ordering via unique IDs | Correct character interleaving | O(n) insertion in naive form |
| **YATA** (Y.js) | RGA variant with origin pointers | Fast, compact, used in Yjs | Complex tombstone GC |

Google Docs uses OT (server orders everything). Figma, Notion, and Linear use CRDTs (Y.js or Automerge) for offline-first, peer-to-peer convergence.

### Yjs Update Model

Yjs serializes document state as **binary update payloads**. A client applies a remote update with `Y.applyUpdate(doc, update)`. The Go server does not need to understand the payload - it only needs to:
1. Broadcast the update to all peers in the room.
2. Persist the accumulated state vector for late-joining clients.

### Go CRDT Sync Server for Yjs

The Go sync server acts as a relay and persistence layer for Yjs documents: it does not parse or understand the binary CRDT payload, but it accumulates all update blobs in order so that late-joining clients can receive the full document state in a single `sync` message. The `DocState` below stores ordered update slices in memory (Redis-backed in production), while each WebSocket room goroutine broadcasts each new update to all connected peers after appending it to the persistent history.

```go
package crdt

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// DocState holds the accumulated Yjs binary state for a document.
// In production this would be backed by Redis or a database.
type DocState struct {
	mu      sync.RWMutex
	updates [][]byte // ordered list of Yjs update blobs
}

// Append adds a new Yjs update to persistent history.
func (d *DocState) Append(update []byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cp := make([]byte, len(update))
	copy(cp, update)
	d.updates = append(d.updates, cp)
}

// Snapshot returns all updates for a late-joining client.
func (d *DocState) Snapshot() [][]byte {
	d.mu.RLock()
	defer d.mu.RUnlock()
	result := make([][]byte, len(d.updates))
	copy(result, d.updates)
	return result
}

// CRDTHub manages WebSocket connections per document room.
type CRDTHub struct {
	mu    sync.RWMutex
	rooms map[string]*crdtRoom
}

type crdtRoom struct {
	docState *DocState
	clients  map[*crdtClient]struct{}
	mu       sync.RWMutex
}

type crdtClient struct {
	conn   *websocket.Conn
	send   chan []byte
	roomID string
	hub    *CRDTHub
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:    func(r *http.Request) bool { return true },
}

// NewCRDTHub initializes an empty hub.
func NewCRDTHub() *CRDTHub {
	return &CRDTHub{rooms: make(map[string]*crdtRoom)}
}

func (h *CRDTHub) getOrCreateRoom(roomID string) *crdtRoom {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[roomID]; ok {
		return r
	}
	r := &crdtRoom{
		docState: &DocState{},
		clients:  make(map[*crdtClient]struct{}),
	}
	h.rooms[roomID] = r
	return r
}

// ServeWS upgrades an HTTP connection and starts the read/write pumps.
func (h *CRDTHub) ServeWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		http.Error(w, "room required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[CRDT] upgrade: %v", err)
		return
	}

	room := h.getOrCreateRoom(roomID)
	client := &crdtClient{
		conn:   conn,
		send:   make(chan []byte, 128),
		roomID: roomID,
		hub:    h,
	}

	room.mu.Lock()
	room.clients[client] = struct{}{}
	room.mu.Unlock()

	// Send full document snapshot so the new client converges immediately.
	go func() {
		for _, update := range room.docState.Snapshot() {
			client.send <- update
		}
	}()

	go client.writePump()
	client.readPump(room)
}

// readPump reads Yjs updates from the client and broadcasts them.
func (c *crdtClient) readPump(room *crdtRoom) {
	defer func() {
		room.mu.Lock()
		delete(room.clients, c)
		room.mu.Unlock()
		close(c.send)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(65536)
	_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})

	for {
		_, update, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway) {
				log.Printf("[CRDT] read error: %v", err)
			}
			return
		}

		// Persist the update.
		room.docState.Append(update)

		// Broadcast to all peers except sender.
		room.mu.RLock()
		for peer := range room.clients {
			if peer == c {
				continue
			}
			select {
			case peer.send <- update:
			default:
				log.Printf("[CRDT] dropping update for slow client")
			}
		}
		room.mu.RUnlock()
	}
}

// writePump sends queued updates to the WebSocket client.
func (c *crdtClient) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case update, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.BinaryMessage, update); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
```

### Operational Transforms vs CRDTs - When to Use Each

| Criteria | OT | CRDT |
|---|---|---|
| **Centralization** | Requires central server to order ops | Fully decentralized, P2P possible |
| **Offline support** | Limited (requires reconnect to transform) | Native - merge on reconnect |
| **Undo/Redo** | Simple (server keeps op log) | Complex (requires intention preservation) |
| **Text editing** | Google Docs, Etherpad | Figma, Notion, Linear, Automerge |
| **Implementation complexity** | Moderate (transform functions per op type) | High (CRDT invariant design) |
| **Tombstone growth** | Not applicable | Must GC deleted positions |

**Rule of thumb**: Choose OT when you have a reliable server and need reliable undo. Choose CRDTs when you need offline-first, multi-master replication, or P2P sync.

### Junior → FAANG: Why LWW Is Wrong for Text and RGA Is Right

Using LWW (Last-Write-Wins) for text editing silently discards work. If user A and user B both edit the same sentence simultaneously, LWW picks the later timestamp's version and discards the other. Neither user knows their edit was lost. For user-visible content, this is a data loss bug, not just an eventual consistency anomaly.

RGA (Replicated Growable Array) solves this by assigning each character a unique identifier (node ID + sequence number) that is stable across merges. Concurrent insertions at the same position both survive: the identifier determines the tie-breaking order. No character is ever discarded. The tradeoff is higher memory cost (each character carries its identifier) and more complex merge logic.

The practical takeaway: for any data where "losing work silently" is unacceptable, use an intent-preserving CRDT (RGA, YATA) rather than LWW. For data where "most recent wins" is semantically correct (user's cursor position, user's display name), LWW is appropriate.

### Senior @ FAANG: Advanced Sync Protocols and the Production Boundary

The rule of thumb at the end of this section (OT for reliable server + undo, CRDTs for offline-first + P2P) is correct but incomplete. The production boundary condition that the rule of thumb does not address: what happens when the chosen approach meets an unexpected requirement?

The OT approach hits its limit when a product that launched with a server requirement is asked to support offline editing. Adding offline editing to an OT system requires either a local server per device (running OT server logic on-device, which is complex) or migrating to a CRDT-based sync protocol (which requires migrating the existing document storage format). Neither is cheap.

The CRDT approach hits its limit when a product that launched with CRDT-based text editing is asked to implement "reliable undo." CRDT undo is not trivial: undoing a CRDT operation requires inverting it, but if other operations have been applied since, the inverse may not apply cleanly. CRDTs with MVCC (multi-version concurrency control) can support undo, but this is a significant implementation complexity increase over basic CRDT merge.

The governance question: when choosing OT vs CRDT, explicitly document which future requirements are unblocked and which are blocked by the choice. This makes the tradeoff visible in the ADR and prevents the "we didn't know it would matter" post-hoc justification when a feature is expensive to implement.

---
