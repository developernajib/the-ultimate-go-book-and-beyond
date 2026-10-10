## 102H.1 Production WebSocket Server Architecture

### 1.1 Production WebSocket Hub

A production WebSocket hub must handle thousands of concurrent connections safely using lock-free data structures wherever possible. The `Hub` below uses `sync.Map` for both the client registry and room memberships, ensuring goroutine-safe access without a single global mutex becoming a bottleneck. Atomic counters track live metrics, and buffered channels decouple broadcasting from the event loop so a slow consumer cannot stall others.

```go
package websocket

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Message types.
const (
	MsgTypeText   = "text"
	MsgTypeJoin   = "join"
	MsgTypeLeave  = "leave"
	MsgTypePing   = "ping"
	MsgTypePong   = "pong"
	MsgTypeError  = "error"
	MsgTypeBroadcast = "broadcast"
)

// Message is the application-level WebSocket message.
type Message struct {
	Type      string          `json:"type"`
	Room      string          `json:"room,omitempty"`
	From      string          `json:"from,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Timestamp int64           `json:"ts"`
}

// Client represents a connected WebSocket client.
type Client struct {
	ID       string
	UserID   string
	conn     *websocket.Conn
	hub      *Hub
	send     chan Message // Buffered outgoing message channel.
	rooms    map[string]struct{}
	mu       sync.RWMutex
	lastPing time.Time
}

// Hub manages all connected clients and room memberships.
type Hub struct {
	// Thread-safe client registry.
	clients sync.Map // clientID → *Client

	// Room memberships: roomID → set of clientIDs.
	rooms sync.Map // roomID → *sync.Map[clientID → *Client]

	// Broadcast channels.
	broadcast  chan RoomMessage // Messages to broadcast to a room.
	register   chan *Client
	unregister chan *Client

	// Metrics.
	totalConnections atomic.Int64
	totalMessages    atomic.Uint64

	// Configuration.
	cfg HubConfig
}

// HubConfig holds Hub configuration.
type HubConfig struct {
	MaxMessageSize    int64
	WriteWait         time.Duration
	PongWait          time.Duration
	PingInterval      time.Duration
	CloseGracePeriod  time.Duration
	MaxClientsPerRoom int
}

// DefaultHubConfig returns production-safe defaults.
func DefaultHubConfig() HubConfig {
	return HubConfig{
		MaxMessageSize:   65536, // 64KB
		WriteWait:        10 * time.Second,
		PongWait:         60 * time.Second,
		PingInterval:     54 * time.Second, // Must be < PongWait.
		CloseGracePeriod: 5 * time.Second,
		MaxClientsPerRoom: 10000,
	}
}

// RoomMessage is a message destined for a room.
type RoomMessage struct {
	Room    string
	Message Message
	Exclude string // Optional: exclude this client ID.
}

// NewHub creates a new WebSocket hub.
func NewHub(cfg HubConfig) *Hub {
	return &Hub{
		broadcast:  make(chan RoomMessage, 1024),
		register:   make(chan *Client, 256),
		unregister: make(chan *Client, 256),
		cfg:        cfg,
	}
}

// Run starts the hub's event loop.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case client := <-h.register:
			h.clients.Store(client.ID, client)
			h.totalConnections.Add(1)
		case client := <-h.unregister:
			if _, ok := h.clients.LoadAndDelete(client.ID); ok {
				h.totalConnections.Add(-1)
				h.leaveAllRooms(client)
				close(client.send)
			}
		case roomMsg := <-h.broadcast:
			h.sendToRoom(roomMsg)
		}
	}
}

// Broadcast sends a message to all clients in a room.
func (h *Hub) Broadcast(room string, msg Message, exclude string) {
	select {
	case h.broadcast <- RoomMessage{Room: room, Message: msg, Exclude: exclude}:
	default:
		// Broadcast channel full - message dropped.
	}
}

// SendToClient sends a message to a specific client.
func (h *Hub) SendToClient(clientID string, msg Message) bool {
	val, ok := h.clients.Load(clientID)
	if !ok {
		return false
	}
	client := val.(*Client)
	select {
	case client.send <- msg:
		return true
	default:
		return false // Client send buffer full.
	}
}

func (h *Hub) sendToRoom(roomMsg RoomMessage) {
	roomVal, ok := h.rooms.Load(roomMsg.Room)
	if !ok {
		return
	}
	roomClients := roomVal.(*sync.Map)

	h.totalMessages.Add(1)
	roomClients.Range(func(key, val any) bool {
		clientID := key.(string)
		if clientID == roomMsg.Exclude {
			return true
		}
		client := val.(*Client)
		select {
		case client.send <- roomMsg.Message:
		default:
			// Client is slow - disconnect it.
			h.unregister <- client
		}
		return true
	})
}

// JoinRoom adds a client to a room.
func (h *Hub) JoinRoom(clientID, room string) error {
	val, ok := h.clients.Load(clientID)
	if !ok {
		return fmt.Errorf("client not found")
	}
	client := val.(*Client)

	// Get or create room.
	roomClientsVal, _ := h.rooms.LoadOrStore(room, &sync.Map{})
	roomClients := roomClientsVal.(*sync.Map)

	// Check room capacity.
	count := 0
	roomClients.Range(func(k, v any) bool {
		count++
		return count < h.cfg.MaxClientsPerRoom
	})
	if count >= h.cfg.MaxClientsPerRoom {
		return fmt.Errorf("room %s is full", room)
	}

	roomClients.Store(clientID, client)

	client.mu.Lock()
	client.rooms[room] = struct{}{}
	client.mu.Unlock()

	return nil
}

// LeaveRoom removes a client from a room.
func (h *Hub) LeaveRoom(clientID, room string) {
	val, ok := h.rooms.Load(room)
	if !ok {
		return
	}
	roomClients := val.(*sync.Map)
	roomClients.Delete(clientID)

	if clientVal, ok := h.clients.Load(clientID); ok {
		client := clientVal.(*Client)
		client.mu.Lock()
		delete(client.rooms, room)
		client.mu.Unlock()
	}
}

func (h *Hub) leaveAllRooms(client *Client) {
	client.mu.RLock()
	rooms := make([]string, 0, len(client.rooms))
	for room := range client.rooms {
		rooms = append(rooms, room)
	}
	client.mu.RUnlock()

	for _, room := range rooms {
		h.LeaveRoom(client.ID, room)
	}
}

// Stats returns hub statistics.
type HubStats struct {
	Connections int64
	Messages    uint64
	Rooms       int
}

func (h *Hub) Stats() HubStats {
	rooms := 0
	h.rooms.Range(func(k, v any) bool {
		rooms++
		return true
	})
	return HubStats{
		Connections: h.totalConnections.Load(),
		Messages:    h.totalMessages.Load(),
		Rooms:       rooms,
	}
}
```

### 1.2 WebSocket Connection Handler

Each WebSocket connection is served by two goroutines, one for reading and one for writing, following the gorilla/websocket requirement that only one goroutine reads and only one writes at a time. The `readPump` owns the read side and extends the deadline on every pong frame to detect dead connections, while the `writePump` owns the write side and batches any pending messages into a single WebSocket frame to reduce syscall overhead.

```go
package websocket

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// CheckOrigin should validate the request origin in production.
	CheckOrigin: func(r *http.Request) bool {
		// In production: check r.Header.Get("Origin") against allowlist.
		return true
	},
}

// ServeWS handles WebSocket upgrade and runs the client's read/write pumps.
func ServeWS(hub *Hub, userID string, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}

	client := &Client{
		ID:       generateClientID(),
		UserID:   userID,
		conn:     conn,
		hub:      hub,
		send:     make(chan Message, 256),
		rooms:    make(map[string]struct{}),
		lastPing: time.Now(),
	}

	hub.register <- client

	// Start read and write pumps in separate goroutines.
	// writePump owns the conn write side - readPump owns the read side.
	go client.writePump()
	go client.readPump()
}

// readPump reads messages from the WebSocket connection.
// One goroutine per client - safe to call conn.ReadMessage() from here.
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(c.hub.cfg.MaxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(c.hub.cfg.PongWait))

	// Handle pong messages - extends the read deadline.
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(c.hub.cfg.PongWait))
		c.lastPing = time.Now()
		return nil
	})

	for {
		_, rawMsg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway,
				websocket.CloseAbnormalClosure) {
				log.Printf("unexpected close: client=%s err=%v", c.ID, err)
			}
			return
		}

		var msg Message
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			c.sendError("invalid message format")
			continue
		}
		msg.From = c.UserID
		msg.Timestamp = time.Now().UnixMilli()

		c.handleMessage(msg)
	}
}

// writePump sends messages from the client's send channel to the WebSocket connection.
// One goroutine per client - owns the write side of the connection.
func (c *Client) writePump() {
	ticker := time.NewTicker(c.hub.cfg.PingInterval)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(c.hub.cfg.WriteWait))
			if !ok {
				// Hub closed the channel - send close message.
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			// Write message as JSON.
			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			if err := json.NewEncoder(w).Encode(msg); err != nil {
				w.Close()
				return
			}

			// Flush any pending messages (batch writes).
			n := len(c.send)
			for i := 0; i < n; i++ {
				if err := json.NewEncoder(w).Encode(<-c.send); err != nil {
					break
				}
			}
			w.Close()

		case <-ticker.C:
			// Send ping to detect dead connections.
			c.conn.SetWriteDeadline(time.Now().Add(c.hub.cfg.WriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleMessage(msg Message) {
	switch msg.Type {
	case MsgTypeJoin:
		var payload struct {
			Room string `json:"room"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.Room == "" {
			c.sendError("invalid join payload")
			return
		}
		if err := c.hub.JoinRoom(c.ID, payload.Room); err != nil {
			c.sendError(err.Error())
			return
		}
		// Notify room.
		c.hub.Broadcast(payload.Room, Message{
			Type:      MsgTypeJoin,
			Room:      payload.Room,
			From:      c.UserID,
			Timestamp: time.Now().UnixMilli(),
		}, c.ID)

	case MsgTypeLeave:
		var payload struct {
			Room string `json:"room"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			c.hub.LeaveRoom(c.ID, payload.Room)
		}

	case MsgTypeText:
		var payload struct {
			Room string `json:"room"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			c.sendError("invalid text message")
			return
		}

		// Validate text length.
		if len(payload.Text) > 4096 {
			c.sendError("message too long")
			return
		}

		c.hub.Broadcast(payload.Room, msg, "")

	default:
		c.sendError(fmt.Sprintf("unknown message type: %s", msg.Type))
	}
}

func (c *Client) sendError(reason string) {
	msg := Message{
		Type:      MsgTypeError,
		Timestamp: time.Now().UnixMilli(),
	}
	payload, _ := json.Marshal(map[string]string{"reason": reason})
	msg.Payload = payload
	select {
	case c.send <- msg:
	default:
	}
}

func generateClientID() string {
	return fmt.Sprintf("client-%d", time.Now().UnixNano())
}
```

### Junior → FAANG: The Single Writer Rule and Why It Exists

The most important rule in WebSocket programming is that only one goroutine may write to a connection at a time. `gorilla/websocket` documents this explicitly and does not provide internal locking. If two goroutines call `WriteMessage` on the same connection simultaneously, the result is a data race that can corrupt the frame or panic. The pattern this section demonstrates, a dedicated writer goroutine reading from a buffered channel, is the canonical solution.

Practice tracing the goroutine model in the hub code: there is one `Hub.run()` goroutine that serializes all broadcast and register/unregister operations. Each client has one reader goroutine and one writer goroutine. The reader goroutine receives frames from the network. The writer goroutine sends frames. The hub communicates with writer goroutines through buffered channels. Draw this on paper until it is clear. When an interviewer asks "how does your WebSocket server handle concurrent clients?", this diagram is your answer.

Interview entry point: describe the hub pattern as a fan-out mechanism where the hub's central goroutine is the only place that touches the client registry, eliminating lock contention by using channel-based serialization instead of mutexes.

### Senior @ FAANG: Hub Contention, Sharding, and Lock-Free Alternatives

The hub pattern has a scaling ceiling: all broadcast operations serialize through the single `Hub.run()` goroutine. At low connection counts (under 10,000) this is not observable. At 100,000 connections broadcasting large messages at high frequency, the hub goroutine becomes a bottleneck and broadcast latency starts to grow. The metrics signal is `hub_broadcast_latency_seconds` p99 growing linearly with message rate.

The architectural solution is hub sharding: instead of one hub for all clients, create N hubs where each client is assigned to a hub by a consistent hash of its room or user ID. Broadcast to room X goes to the shard responsible for room X. The tradeoff is that room-level broadcasts must know which shard a room belongs to, and cross-shard broadcasts (system-wide notifications) require broadcasting to all shards. Implementing this correctly requires a clear invariant about what the sharding key is and what operations cross shard boundaries.

At FAANG scale (Slack, Discord), the hub is not an in-process data structure at all. It is a distributed system: connection servers hold the goroutine and channel state, and routing is handled by a separate routing tier that knows which connection server holds which user's WebSocket connection. A message to user X is published to an internal message bus, the routing tier looks up which connection server holds X's connection, and that server's hub delivers the message. This architecture allows the connection layer and the message routing layer to scale independently.

---
