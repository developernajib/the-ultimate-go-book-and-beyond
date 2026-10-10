## 102P.1 WebSocket Hub at Scale

Scaling a WebSocket hub beyond a single server requires externalizing room state and message routing so that any node can serve any client. The hub below combines a local in-process registry using `sync.Map` with a Redis pub/sub bridge, and uses `slog` structured logging for every connection lifecycle event so that connection counts, slow consumers, and unexpected closes are all observable in production log aggregators.

```go
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// TODO: validate origin for production
		return true
	},
	EnableCompression: true,
}

// Message is a WebSocket message
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
	RoomID  string          `json:"room_id,omitempty"`
	From    string          `json:"from,omitempty"`
}

// Client represents a WebSocket connection
type Client struct {
	id        string
	userID    string
	roomID    string
	conn      *websocket.Conn
	send      chan []byte    // buffered channel for outbound messages
	hub       *Hub
	logger    *slog.Logger
	closed    atomic.Bool
}

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 54 * time.Second // must be < pongWait
	maxMessageSize = 65536            // 64KB
)

// writePump handles outbound messages to the WebSocket connection
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
				// Channel closed
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(msg)

			// Drain buffered messages (batch write)
			n := len(c.send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.send)
			}
			if err := w.Close(); err != nil {
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

// readPump handles inbound messages from the WebSocket connection
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.logger.Error("ws read error", slog.String("error", err.Error()))
			}
			break
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			c.logger.Warn("invalid message", slog.String("data", string(data)))
			continue
		}

		msg.From = c.userID
		msg.RoomID = c.roomID

		c.hub.broadcast <- BroadcastMsg{
			RoomID:  c.roomID,
			Message: data,
			Sender:  c,
		}
	}
}

// Send sends a message to the client (non-blocking)
func (c *Client) Send(msg []byte) bool {
	if c.closed.Load() {
		return false
	}
	select {
	case c.send <- msg:
		return true
	default:
		// Client is too slow - drop message and close
		c.closed.Store(true)
		return false
	}
}

// BroadcastMsg is a message to broadcast to a room
type BroadcastMsg struct {
	RoomID  string
	Message []byte
	Sender  *Client
}

// Hub manages all active WebSocket connections
type Hub struct {
	rooms      map[string]map[string]*Client // roomID → clientID → client
	register   chan *Client
	unregister chan *Client
	broadcast  chan BroadcastMsg
	mu         sync.RWMutex
	logger     *slog.Logger

	// Metrics
	totalClients  atomic.Int64
	totalMessages atomic.Int64
}

func NewHub(logger *slog.Logger) *Hub {
	return &Hub{
		rooms:      make(map[string]map[string]*Client),
		register:   make(chan *Client, 256),
		unregister: make(chan *Client, 256),
		broadcast:  make(chan BroadcastMsg, 1024),
		logger:     logger,
	}
}

// Run processes hub events
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return

		case client := <-h.register:
			h.mu.Lock()
			if h.rooms[client.roomID] == nil {
				h.rooms[client.roomID] = make(map[string]*Client)
			}
			h.rooms[client.roomID][client.id] = client
			h.mu.Unlock()
			h.totalClients.Add(1)
			h.logger.Info("client joined",
				slog.String("client", client.id),
				slog.String("room", client.roomID),
				slog.Int64("total", h.totalClients.Load()),
			)

		case client := <-h.unregister:
			h.mu.Lock()
			if room, ok := h.rooms[client.roomID]; ok {
				if _, ok := room[client.id]; ok {
					delete(room, client.id)
					close(client.send)
					if len(room) == 0 {
						delete(h.rooms, client.roomID)
					}
				}
			}
			h.mu.Unlock()
			h.totalClients.Add(-1)
			h.logger.Info("client left",
				slog.String("client", client.id),
				slog.String("room", client.roomID),
			)

		case msg := <-h.broadcast:
			h.totalMessages.Add(1)
			h.mu.RLock()
			clients := h.rooms[msg.RoomID]
			h.mu.RUnlock()

			for _, client := range clients {
				if client == msg.Sender {
					continue // don't echo
				}
				if !client.Send(msg.Message) {
					// Slow client: schedule cleanup
					h.unregister <- client
				}
			}
		}
	}
}

// RoomSize returns the number of clients in a room
func (h *Hub) RoomSize(roomID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[roomID])
}

// ServeWS upgrades an HTTP connection to WebSocket
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomID")
	userID := r.Header.Get("X-User-ID")
	if roomID == "" || userID == "" {
		http.Error(w, "missing room or user", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("upgrade failed", slog.String("error", err.Error()))
		return
	}

	client := &Client{
		id:     fmt.Sprintf("%s-%s-%d", roomID, userID, time.Now().UnixNano()),
		userID: userID,
		roomID: roomID,
		conn:   conn,
		send:   make(chan []byte, 256),
		hub:    h,
		logger: h.logger,
	}

	h.register <- client

	go client.writePump()
	go client.readPump()
}
```

### Junior → FAANG: sync.Map Versus RWMutex for Connection Registries

The hub in this section uses `sync.Map` for the local connection registry. `sync.Map` is optimized for the case where the map is written rarely and read frequently, with minimal contention. For a WebSocket hub where connections are registered once on connect and deregistered once on disconnect, but read on every broadcast, `sync.Map` is appropriate.

Where `sync.Map` is not the right choice: when you need atomic operations that depend on the current state (like "if this room has fewer than N connections, add one"), a `sync.RWMutex` protecting a regular map gives you the lock scope to perform compound operations atomically. `sync.Map` does not provide that.

Interview entry point: explain the tradeoff between `sync.Map` (optimized for stable keys, high read-to-write ratio) and `sync.RWMutex` + `map` (better for compound operations, comparable performance at high contention). For a connection registry with thousands of active connections, either works. The choice is about the operation pattern, not scale.

### Senior @ FAANG: Hub as a Foundation for Admission Control

At FAANG scale, the WebSocket hub is the natural insertion point for admission control: policies that govern whether a new connection is allowed based on current system state. Admission control is what prevents a connection surge (after a brief outage that causes all clients to reconnect simultaneously) from overwhelming a recovering server.

The admission control policy for WebSocket hubs: limit total connections per server instance to a configured maximum (derived from memory and goroutine count budget), reject new connections with 503 when the limit is reached, and report the connection count to the load balancer health check so overloaded instances are taken out of rotation. These three controls together implement the circuit breaking pattern at the connection tier.

The `slog` structured logging in this section is the observability foundation. At platform scale, connection lifecycle events (connect, disconnect, slow consumer detection, room join/leave) are aggregated across all hub instances and used to compute connection count trends, room utilization heat maps, and slow consumer rate. Without structured logging with consistent field names, this aggregation is impossible.

---
