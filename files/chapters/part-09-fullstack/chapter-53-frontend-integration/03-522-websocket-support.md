## 53.2 WebSocket Support

### WebSocket Server

The WebSocket upgrade moves a standard HTTP connection into a full-duplex channel, enabling the server to push events to the browser without polling. Maintaining per-connection write channels and a central hub that serializes broadcasts keeps goroutines safe from concurrent map and connection writes. The implementation below wires together the upgrader, per-client pumps, and a project-scoped room model that limits which clients receive which events.

```go
// pkg/websocket/server.go
package websocket

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Server manages WebSocket connections
type Server struct {
	upgrader websocket.Upgrader
	clients  map[*Client]bool
	rooms    map[string]map[*Client]bool

	broadcast  chan *Message
	register   chan *Client
	unregister chan *Client

	logger *slog.Logger
	mu     sync.RWMutex
}

// Client represents a WebSocket client
type Client struct {
	ID     string
	UserID string
	Conn   *websocket.Conn
	Send   chan []byte
	Rooms  map[string]bool
	server *Server
}

// Message represents a WebSocket message
type Message struct {
	Type    string          `json:"type"`
	Room    string          `json:"room,omitempty"`
	Payload json.RawMessage `json:"payload"`
	From    string          `json:"from,omitempty"`
}

// NewServer creates a new WebSocket server
func NewServer(logger *slog.Logger) *Server {
	return &Server{
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				// In production, verify origin
				return true
			},
		},
		clients:    make(map[*Client]bool),
		rooms:      make(map[string]map[*Client]bool),
		broadcast:  make(chan *Message, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		logger:     logger,
	}
}

// Run starts the WebSocket server
func (s *Server) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return

		case client := <-s.register:
			s.mu.Lock()
			s.clients[client] = true
			s.mu.Unlock()

			s.logger.Info("Client connected",
				"client_id", client.ID,
				"user_id", client.UserID,
			)

		case client := <-s.unregister:
			s.mu.Lock()
			if _, ok := s.clients[client]; ok {
				delete(s.clients, client)

				// Remove from all rooms
				for room := range client.Rooms {
					if clients, ok := s.rooms[room]; ok {
						delete(clients, client)
						if len(clients) == 0 {
							delete(s.rooms, room)
						}
					}
				}

				close(client.Send)
			}
			s.mu.Unlock()

			s.logger.Info("Client disconnected",
				"client_id", client.ID,
				"user_id", client.UserID,
			)

		case message := <-s.broadcast:
			s.handleBroadcast(message)
		}
	}
}

func (s *Server) handleBroadcast(message *Message) {
	data, err := json.Marshal(message)
	if err != nil {
		s.logger.Error("Failed to marshal message", "error", err)
		return
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	if message.Room != "" {
		// Send to specific room
		if clients, ok := s.rooms[message.Room]; ok {
			for client := range clients {
				select {
				case client.Send <- data:
				default:
					close(client.Send)
					delete(s.clients, client)
				}
			}
		}
	} else {
		// Broadcast to all clients
		for client := range s.clients {
			select {
			case client.Send <- data:
			default:
				close(client.Send)
				delete(s.clients, client)
			}
		}
	}
}

// HandleConnection handles a new WebSocket connection
func (s *Server) HandleConnection(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("Failed to upgrade connection", "error", err)
		return
	}

	// Get user ID from context (set by auth middleware)
	userID := getUserIDFromContext(r.Context())

	client := &Client{
		ID:     generateClientID(),
		UserID: userID,
		Conn:   conn,
		Send:   make(chan []byte, 256),
		Rooms:  make(map[string]bool),
		server: s,
	}

	s.register <- client

	// Start client goroutines
	go client.writePump()
	go client.readPump()
}

// Broadcast sends a message to all clients or a specific room
func (s *Server) Broadcast(msgType string, room string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	message := &Message{
		Type:    msgType,
		Room:    room,
		Payload: data,
	}

	s.broadcast <- message
	return nil
}

// SendToUser sends a message to a specific user
func (s *Server) SendToUser(userID, msgType string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	messageData, err := json.Marshal(&Message{
		Type:    msgType,
		Payload: data,
	})
	if err != nil {
		return err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	for client := range s.clients {
		if client.UserID == userID {
			select {
			case client.Send <- messageData:
			default:
			}
		}
	}

	return nil
}

// JoinRoom adds a client to a room
func (s *Server) JoinRoom(client *Client, room string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.rooms[room]; !ok {
		s.rooms[room] = make(map[*Client]bool)
	}
	s.rooms[room][client] = true
	client.Rooms[room] = true

	s.logger.Debug("Client joined room",
		"client_id", client.ID,
		"room", room,
	)
}

// LeaveRoom removes a client from a room
func (s *Server) LeaveRoom(client *Client, room string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if clients, ok := s.rooms[room]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(s.rooms, room)
		}
	}
	delete(client.Rooms, room)
}

// Client methods

func (c *Client) readPump() {
	defer func() {
		c.server.unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.server.logger.Error("WebSocket error", "error", err)
			}
			break
		}

		// Handle incoming message
		c.handleMessage(message)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Batch pending messages
			n := len(c.Send)
			for i := 0; i < n; i++ {
				w.Write(newline)
				w.Write(<-c.Send)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleMessage(data []byte) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		c.server.logger.Error("Failed to unmarshal message", "error", err)
		return
	}

	msg.From = c.UserID

	switch msg.Type {
	case "join_room":
		var payload struct {
			Room string `json:"room"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			c.server.JoinRoom(c, payload.Room)
		}

	case "leave_room":
		var payload struct {
			Room string `json:"room"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			c.server.LeaveRoom(c, payload.Room)
		}

	default:
		// Broadcast to room or all
		c.server.broadcast <- &msg
	}
}

// Constants
const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024 // 512KB
)

var newline = []byte{'\n'}

func generateClientID() string {
	return fmt.Sprintf("client_%d", time.Now().UnixNano())
}

func getUserIDFromContext(ctx context.Context) string {
	if userID, ok := ctx.Value("user_id").(string); ok {
		return userID
	}
	return ""
}
```

### Junior -> FAANG: Understanding the WebSocket Hub Pattern

The central insight of this implementation is that the hub goroutine is the sole writer to the `clients` and `rooms` maps. All other goroutines (one `readPump` and one `writePump` per connection) never touch these maps directly. They communicate with the hub through buffered channels. This eliminates data races on the maps without requiring locks in the per-connection goroutines, which is why the `readPump` and `writePump` functions contain no mutex calls.

The first habit to build is understanding what happens when the `client.Send` channel is full (the `default` branch in `handleBroadcast`). When this fires, the hub closes the channel and removes the client from the map while holding the read lock. This is a design smell because closing a channel while holding a read lock and having other goroutines potentially receive on that channel can cause a panic. The safer pattern is to send a signal to a separate cleanup channel and let the hub goroutine handle the close under a write lock on its next iteration.

For entry-level interviews, being able to trace the lifecycle of a single connection through all its states (upgrade, register, read loop running, message received, broadcast to room, ping-pong heartbeat, error on read, unregister, close) is the expected bar. Draw it as a sequence diagram if asked to explain the design.

### Senior @ FAANG: Scaling the Hub Beyond a Single Process

The hub pattern in this section is correct for a single process. It breaks the moment you deploy two pods behind a load balancer. Client A connected to Pod 1 sends a message to room "project-42". The hub on Pod 1 broadcasts to room members it knows about. Client B in room "project-42" is connected to Pod 2. Pod 2 never receives the broadcast.

**The pub/sub backbone solution.** Each hub subscribes to a shared channel (Redis Pub/Sub, Redis Streams, Kafka, or a managed pub/sub service). When a hub receives a broadcast, it publishes the message to the shared channel in addition to delivering it locally. Every hub in every pod receives the published message and delivers it to its local room members. The at-least-once guarantee of the backbone determines whether clients can see duplicate messages, so design the client message handler to be idempotent using the `message.ID` field.

**ADR: which backbone to choose.** Redis Pub/Sub is fire-and-forget with no persistence. A pod that is momentarily disconnected from Redis misses messages published during the outage. Redis Streams retain messages and allow consumer groups to replay from a last-seen ID, which matches the WebSocket resumption pattern. Kafka provides ordering guarantees per topic-partition, which is essential when message ordering within a room matters (e.g., collaborative document editing). Choose based on the product's ordering and durability requirements, not on familiarity.

**Graceful rolling deploy.** When Kubernetes sends SIGTERM to a WebSocket pod, the pod must: (1) stop accepting new WebSocket upgrades by returning an error from the upgrader, (2) wait for in-flight broadcasts on the hub channel to drain, (3) send a `1001 Going Away` close frame to every connected client so they reconnect to a different pod, and (4) return from the main function. The time budget for steps 2-4 is determined by the `terminationGracePeriodSeconds` in the Kubernetes pod spec. For a hub with thousands of connections, this can take several seconds. Set the grace period to at least 30 seconds, monitor the connection drain time in your deployment metrics, and alert if the drain takes longer than 20 seconds (leaving only a 10-second buffer before Kubernetes sends SIGKILL).

**Connection pressure and backpressure.** The `client.Send` channel buffer size of 256 is arbitrary. At high message volume, a slow client will fill its buffer quickly. The current implementation closes the connection when the buffer is full, which is the right decision (slow consumers must not apply backpressure to fast producers). However, closing without logging the reason makes it impossible to distinguish deliberate drops from bugs. Add a `clientDroppedMessages` counter metric per drop event, tagged with the room ID. A spike in this counter means either a specific room is producing too many messages for its subscribers to consume, or a specific client is too slow (poor network, throttled device). The first is a product problem, the second is a client-side problem. Both are invisible without the metric.

**CheckOrigin in production.** The `CheckOrigin` function in `NewServer` returns `true` unconditionally, which accepts upgrades from any origin. This bypasses CSRF protection for WebSocket connections. In production, `CheckOrigin` must validate the `Origin` header against the same allowlist used by the CORS middleware. Failure to do this allows a malicious page on any origin to initiate an authenticated WebSocket connection using the user's session cookies.

---
