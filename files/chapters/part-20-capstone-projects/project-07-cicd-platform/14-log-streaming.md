## Log Streaming

Real-time log streaming lets developers watch their builds execute live, just like they would in a terminal. This is one of the most user-visible features of any CI/CD platform. We implement it using WebSockets, which provide a persistent bidirectional connection between the browser and the server. The hub-and-client pattern shown below manages all active WebSocket connections, routes log lines to the correct subscribers based on the job ID, and handles client disconnections gracefully without leaking goroutines or memory.

### WebSocket Hub for Real-Time Logs

Create `internal/websocket/hub.go`:

```go
package websocket

import (
	"sync"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// Hub maintains active WebSocket connections and broadcasts messages
type Hub struct {
	// Registered clients by job run ID
	clients map[uuid.UUID]map[*Client]bool

	// Broadcast channel for log messages
	broadcast chan *LogMessage

	// Register requests from clients
	register chan *Client

	// Unregister requests from clients
	unregister chan *Client

	mu sync.RWMutex
}

// LogMessage represents a log message to broadcast
type LogMessage struct {
	JobRunID uuid.UUID
	Data     []byte
}

// NewHub creates a new WebSocket hub
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[uuid.UUID]map[*Client]bool),
		broadcast:  make(chan *LogMessage, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

// Run starts the hub's main loop
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.registerClient(client)

		case client := <-h.unregister:
			h.unregisterClient(client)

		case message := <-h.broadcast:
			h.broadcastMessage(message)
		}
	}
}

// registerClient registers a new client
func (h *Hub) registerClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.clients[client.jobRunID] == nil {
		h.clients[client.jobRunID] = make(map[*Client]bool)
	}

	h.clients[client.jobRunID][client] = true

	log.Info().
		Str("job_run_id", client.jobRunID.String()).
		Int("total_clients", len(h.clients[client.jobRunID])).
		Msg("Client registered")
}

// unregisterClient unregisters a client
func (h *Hub) unregisterClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.clients[client.jobRunID]; ok {
		if _, exists := clients[client]; exists {
			delete(clients, client)
			close(client.send)

			// Clean up empty job run maps
			if len(clients) == 0 {
				delete(h.clients, client.jobRunID)
			}

			log.Info().
				Str("job_run_id", client.jobRunID.String()).
				Msg("Client unregistered")
		}
	}
}

// broadcastMessage broadcasts a message to all clients of a job run
func (h *Hub) broadcastMessage(message *LogMessage) {
	h.mu.RLock()
	clients := h.clients[message.JobRunID]
	h.mu.RUnlock()

	for client := range clients {
		select {
		case client.send <- message.Data:
		default:
			// Client send buffer is full, close the connection
			h.unregister <- client
		}
	}
}

// Broadcast sends a message to all clients of a job run
func (h *Hub) Broadcast(jobRunID uuid.UUID, data []byte) {
	h.broadcast <- &LogMessage{
		JobRunID: jobRunID,
		Data:     data,
	}
}

// ClientCount returns the number of connected clients for a job run
func (h *Hub) ClientCount(jobRunID uuid.UUID) int {
	h.mu.RLock()
	defer h.mu.RUnlock()

	return len(h.clients[jobRunID])
}
```

### WebSocket Client

Create `internal/websocket/client.go`:

```go
package websocket

import (
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
)

const (
	// Time allowed to write a message to the peer
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer
	pongWait = 60 * time.Second

	// Send pings to peer with this period (must be less than pongWait)
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer
	maxMessageSize = 512
)

// Client represents a WebSocket client connection
type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan []byte
	jobRunID uuid.UUID
}

// NewClient creates a new WebSocket client
func NewClient(hub *Hub, conn *websocket.Conn, jobRunID uuid.UUID) *Client {
	return &Client{
		hub:      hub,
		conn:     conn,
		send:     make(chan []byte, 256),
		jobRunID: jobRunID,
	}
}

// ReadPump pumps messages from the WebSocket connection to the hub
func (c *Client) ReadPump() {
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
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Warn().Err(err).Msg("WebSocket read error")
			}
			break
		}

		// Echo back (for ping/pong)
		_ = message
	}
}

// WritePump pumps messages from the hub to the WebSocket connection
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add queued messages to the current WebSocket message
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
```

---
