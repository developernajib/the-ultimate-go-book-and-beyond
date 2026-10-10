## 102H.15 Distributed WebSocket Infrastructure & Consistent Hashing

### Horizontal Scaling with Redis Pub/Sub

A single WebSocket server works fine up to tens of thousands of connections, but production systems require horizontal scaling. The fundamental challenge: WebSocket connections are stateful and pinned to one server. A message sent by client A (on server 1) must reach client B (on server 2). Redis pub/sub is the standard message bus for cross-node delivery.

**Architecture:**

```
Client A ──► Server 1 ──► Redis PUBLISH room:42 msg
                              │
               ┌──────────────┘
               ▼
         Redis Pub/Sub
               │
     ┌─────────┴──────────┐
     ▼                    ▼
  Server 1           Server 2
(delivers to        (delivers to
 local clients)      local clients)
```

**Full Redis-Backed Hub Implementation:**

```go
package scalehub

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 4096
	sendBufferSize = 256
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// Message is the wire format for all WebSocket messages.
type Message struct {
	Room    string `json:"room"`
	UserID  string `json:"user_id"`
	Payload string `json:"payload"`
	SeqID   int64  `json:"seq_id"`
}

// Client represents a single WebSocket connection.
type Client struct {
	hub    *DistributedHub
	conn   *websocket.Conn
	send   chan []byte
	room   string
	userID string
}

// DistributedHub manages local clients and bridges to Redis for cross-node delivery.
type DistributedHub struct {
	mu      sync.RWMutex
	rooms   map[string]map[*Client]struct{} // room → set of local clients
	rdb     *redis.Client
	ctx     context.Context
	cancel  context.CancelFunc
	nodeID  string
}

func NewDistributedHub(rdb *redis.Client, nodeID string) *DistributedHub {
	ctx, cancel := context.WithCancel(context.Background())
	return &DistributedHub{
		rooms:  make(map[string]map[*Client]struct{}),
		rdb:    rdb,
		ctx:    ctx,
		cancel: cancel,
		nodeID: nodeID,
	}
}

// Subscribe starts listening on Redis channels for this hub's rooms.
// This should run in a dedicated goroutine.
func (h *DistributedHub) Subscribe(rooms ...string) {
	pubsub := h.rdb.Subscribe(h.ctx, rooms...)
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case <-h.ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			// Deliver to all local clients in this room.
			h.broadcast(msg.Channel, []byte(msg.Payload))
		}
	}
}

// Publish sends a message to all subscribers across all nodes via Redis.
func (h *DistributedHub) Publish(room string, msg []byte) {
	if err := h.rdb.Publish(h.ctx, room, msg).Err(); err != nil {
		log.Printf("redis publish error room=%s: %v", room, err)
	}
}

// broadcast delivers a raw message to all local clients in a room.
func (h *DistributedHub) broadcast(room string, msg []byte) {
	h.mu.RLock()
	clients, ok := h.rooms[room]
	h.mu.RUnlock()
	if !ok {
		return
	}

	// Snapshot clients to avoid holding lock during send.
	snapshot := make([]*Client, 0, len(clients))
	h.mu.RLock()
	for c := range clients {
		snapshot = append(snapshot, c)
	}
	h.mu.RUnlock()

	for _, c := range snapshot {
		select {
		case c.send <- msg:
		default:
			// Slow consumer - disconnect to avoid blocking others.
			h.unregister(c)
			c.conn.Close()
		}
	}
}

// register adds a client to a room and subscribes the Redis channel if first client.
func (h *DistributedHub) register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, exists := h.rooms[c.room]; !exists {
		h.rooms[c.room] = make(map[*Client]struct{})
		// Subscribe to this room's Redis channel in a new goroutine.
		go h.Subscribe(c.room)
	}
	h.rooms[c.room][c] = struct{}{}
}

// unregister removes a client from its room.
func (h *DistributedHub) unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.rooms[c.room]; ok {
		delete(clients, c)
		if len(clients) == 0 {
			delete(h.rooms, c.room)
		}
	}
}

// Shutdown signals all goroutines to stop.
func (h *DistributedHub) Shutdown() {
	h.cancel()
}

// readPump pumps messages from WebSocket → Redis pub/sub.
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister(c)
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, rawMsg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read error user=%s: %v", c.userID, err)
			}
			return
		}

		msg := &Message{
			Room:    c.room,
			UserID:  c.userID,
			Payload: string(rawMsg),
			SeqID:   time.Now().UnixNano(),
		}
		data, _ := json.Marshal(msg)
		// Publish to Redis so ALL nodes deliver it.
		c.hub.Publish(c.room, data)
	}
}

// writePump pumps messages from the send channel → WebSocket.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func serveWS(hub *DistributedHub, w http.ResponseWriter, r *http.Request) {
	room := r.URL.Query().Get("room")
	userID := r.URL.Query().Get("user_id")
	if room == "" || userID == "" {
		http.Error(w, "room and user_id required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	client := &Client{
		hub:    hub,
		conn:   conn,
		send:   make(chan []byte, sendBufferSize),
		room:   room,
		userID: userID,
	}

	hub.register(client)
	go client.writePump()
	client.readPump() // blocks until disconnected
}
```

### Consistent Hashing for Connection Routing

Rather than using Redis for all cross-node delivery, you can route specific rooms to specific servers using consistent hashing. This reduces Redis traffic significantly for high-volume rooms.

```go
package chash

import (
	"fmt"
	"hash/crc32"
	"sort"
    "slices"
	"sync"
)

// Ring is a consistent hash ring for distributing rooms across nodes.
type Ring struct {
	mu       sync.RWMutex
	replicas int
	keys     []int            // sorted
	hashMap  map[int]string   // hash → node address
}

func NewRing(replicas int) *Ring {
	return &Ring{
		replicas: replicas,
		hashMap:  make(map[int]string),
	}
}

func (r *Ring) Add(nodes ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, node := range nodes {
		for i := 0; i < r.replicas; i++ {
			h := int(crc32.ChecksumIEEE([]byte(fmt.Sprintf("%d:%s", i, node))))
			r.keys = append(r.keys, h)
			r.hashMap[h] = node
		}
	}
	slices.Sort(r.keys)
}

func (r *Ring) Remove(node string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := 0; i < r.replicas; i++ {
		h := int(crc32.ChecksumIEEE([]byte(fmt.Sprintf("%d:%s", i, node))))
		idx := sort.SearchInts(r.keys, h)
		if idx < len(r.keys) && r.keys[idx] == h {
			r.keys = append(r.keys[:idx], r.keys[idx+1:]...)
		}
		delete(r.hashMap, h)
	}
}

// Get returns the node responsible for the given key (e.g., room ID).
func (r *Ring) Get(key string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.keys) == 0 {
		return ""
	}
	h := int(crc32.ChecksumIEEE([]byte(key)))
	idx := sort.SearchInts(r.keys, h)
	if idx == len(r.keys) {
		idx = 0 // wrap around
	}
	return r.hashMap[r.keys[idx]]
}

// Usage:
// ring := NewRing(150) // 150 virtual nodes per server
// ring.Add("ws-server-1:8080", "ws-server-2:8080", "ws-server-3:8080")
// node := ring.Get("room:42") // deterministically routes room 42 to one server
```

### WebSocket Connection Draining for Zero-Downtime Deploys

Killing a WebSocket server abruptly disconnects all clients. Graceful draining allows in-flight connections to finish naturally.

```go
package drain

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// ConnectionTracker tracks active WebSocket connections for graceful drain.
type ConnectionTracker struct {
	mu      sync.Mutex
	wg      sync.WaitGroup
	draining bool
	count   int
}

func (ct *ConnectionTracker) Add() bool {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if ct.draining {
		return false // reject new connections during drain
	}
	ct.count++
	ct.wg.Add(1)
	return true
}

func (ct *ConnectionTracker) Done() {
	ct.mu.Lock()
	ct.count--
	ct.mu.Unlock()
	ct.wg.Done()
}

func (ct *ConnectionTracker) StartDrain() {
	ct.mu.Lock()
	ct.draining = true
	ct.mu.Unlock()
	log.Printf("draining: waiting for %d connections to close", ct.count)
}

// WaitWithTimeout waits for all connections to close, or until timeout.
func (ct *ConnectionTracker) WaitWithTimeout(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		ct.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// GracefulServer wraps http.Server with connection drain logic.
func RunGracefulServer(addr string, handler http.Handler, drainTimeout time.Duration) {
	tracker := &ConnectionTracker{}

	srv := &http.Server{
		Addr: addr,
		Handler: withDrainMiddleware(handler, tracker),
	}

	// Listen for OS signals.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()
	log.Printf("WebSocket server listening on %s", addr)

	<-quit
	log.Println("shutdown signal received")

	// 1. Stop accepting new connections.
	tracker.StartDrain()

	// 2. Tell the HTTP server to stop accepting new requests.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("http shutdown error: %v", err)
	}

	// 3. Wait for existing WebSocket connections to finish.
	if ok := tracker.WaitWithTimeout(drainTimeout); ok {
		log.Println("all connections drained cleanly")
	} else {
		log.Printf("drain timeout after %v - forcefully closing", drainTimeout)
	}
}

// withDrainMiddleware rejects new upgrades when draining.
func withDrainMiddleware(next http.Handler, tracker *ConnectionTracker) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !tracker.Add() {
			http.Error(w, "server shutting down", http.StatusServiceUnavailable)
			return
		}
		defer tracker.Done()
		next.ServeHTTP(w, r)
	})
}
```

### Sticky Sessions vs. Stateless with Redis

| Approach | Pros | Cons | When to Use |
|---|---|---|---|
| Sticky sessions (IP hash / cookie) | Simple, no Redis overhead | Uneven load distribution. Deploys disconnect users | Small clusters, simple setup |
| Redis pub/sub (stateless nodes) | True horizontal scale. Deploy freely | Redis becomes bottleneck. Network hop per message | Production scale, frequent deploys |
| Consistent hashing + Redis fallback | Room affinity reduces Redis traffic. Resilient | Complex routing logic | High-throughput rooms (sports events, trading) |
| WebSocket over gRPC streams | Backend-to-backend scale. Typed | Complex client setup | Microservice fan-out |

**Rule of thumb:** Use sticky sessions up to ~3 nodes, Redis pub/sub beyond that.

### gorilla/websocket vs coder/websocket

Both are production-grade. The choice depends on your constraints:

```go
// gorilla/websocket - battle-tested, explicit control
import "github.com/gorilla/websocket"

// Connection owned by two goroutines: readPump + writePump.
// You must NOT call concurrent writes - use a write pump with a channel.
// Pros:
//   - Mature, widely used, excellent documentation
//   - Fine-grained control over buffers, deadlines, close frames
//   - Supports compression (permessage-deflate)
// Cons:
//   - Manual concurrency management (easy to cause data races)
//   - Larger API surface

// coder/websocket (formerly nhooyr.io/websocket) - modern, context-aware
import "github.com/coder/websocket"

// Read and write are safe to call concurrently - uses context for cancellation.
// Pros:
//   - Context-based cancellation (fits Go idioms)
//   - One reader plus one writer may run concurrently (writes serialized internally)
//   - Smaller binary (no net/http dependency duplication)
//   - Works with net/http and fasthttp
// Cons:
//   - Newer, smaller community
//   - Slightly higher overhead from internal locking

// coder/websocket example:
conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
    Subprotocols: []string{"chat"},
})
if err != nil {
    return err
}
defer conn.CloseNow()

ctx := r.Context()
for {
    typ, msg, err := conn.Read(ctx)
    if err != nil {
        return err
    }
    if err := conn.Write(ctx, typ, msg); err != nil {
        return err
    }
}
```

**Recommendation:** Use `gorilla/websocket` if you need maximum control and have the team discipline for concurrency management. Use `coder/websocket` (the maintained home of the former `nhooyr.io/websocket`) for new projects where context propagation and simpler concurrency are priorities.

### Junior → FAANG: Library Selection as a Team Decision

The library recommendation at the end of this section (`gorilla/websocket` vs `nhooyr.io/websocket`) is a team decision, not an individual decision. The choice of WebSocket library affects every engineer who touches WebSocket code: `gorilla/websocket` requires discipline around the single-writer rule, while `nhooyr.io/websocket` enforces correct concurrency via context propagation. If your team has engineers who are new to Go's concurrency model, `nhooyr.io/websocket` reduces the surface area for common mistakes.

Before proposing a library change on an existing codebase, understand the migration cost. `gorilla/websocket` and `nhooyr.io/websocket` have different APIs. A migration requires updating every connection handler. Propose the migration with a concrete migration plan (how many files, estimated time, rollback plan) rather than just the recommendation.

### Senior @ FAANG: Library Architecture and Long-Term Maintenance Risk

The `gorilla` organization archived `gorilla/websocket` in December 2022 and then unarchived it in February 2024 under new maintainership. This episode is a case study in the risk of depending on a small open-source project for critical infrastructure. The correct response to a dependency entering archive status is not panic, but it is a formal dependency risk assessment: what is the blast radius if this library stops being maintained? Can we fork it if necessary? What is the migration path to an alternative?

For WebSocket specifically, the alternatives are well-established enough that any migration is feasible. But the general principle applies to every critical dependency: platform teams at L6 maintain a risk register for dependencies with single maintainers, archived status, or known security vulnerabilities, and they have documented migration plans before those dependencies become urgent problems. This is dependency governance at the level of infrastructure risk management, not just license compliance.

---
