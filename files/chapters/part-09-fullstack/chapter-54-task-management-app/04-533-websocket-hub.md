## 54.3 WebSocket Hub

The WebSocket hub routes events from backend mutations to connected browser clients. It maintains a registry of active connections indexed by project room, so the API layer can notify only the clients watching the affected project. The `Run` method uses a select loop over three channels (`register`, `unregister`, `broadcast`) to serialize registry mutations. A `sync.RWMutex` guards the room map so broadcasts can read concurrently while joins and leaves acquire the write lock.

```go
// backend/internal/ws/hub.go
package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

type Hub struct {
	clients    map[*Client]bool
	rooms      map[string]map[*Client]bool
	broadcast  chan *RoomMessage
	register   chan *Client
	unregister chan *Client
	logger     *slog.Logger
	mu         sync.RWMutex
}

type Client struct {
	ID     string
	UserID string
	Conn   *websocket.Conn
	Send   chan []byte
	Rooms  map[string]bool
	hub    *Hub
}

type Message struct {
	Type    string      `json:"type"`
	Payload any `json:"payload"`
}

type RoomMessage struct {
	Room    string
	Message Message
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func NewHub(logger *slog.Logger) *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		rooms:      make(map[string]map[*Client]bool),
		broadcast:  make(chan *RoomMessage, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		logger:     logger,
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()

			h.logger.Info("WebSocket client connected",
				"client_id", client.ID,
				"user_id", client.UserID,
			)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)

				for room := range client.Rooms {
					if clients, ok := h.rooms[room]; ok {
						delete(clients, client)
						if len(clients) == 0 {
							delete(h.rooms, room)
						}
					}
				}

				close(client.Send)
			}
			h.mu.Unlock()

			h.logger.Info("WebSocket client disconnected",
				"client_id", client.ID,
				"user_id", client.UserID,
			)

		case rm := <-h.broadcast:
			h.mu.RLock()
			if clients, ok := h.rooms[rm.Room]; ok {
				data, _ := json.Marshal(rm.Message)
				for client := range clients {
					select {
					case client.Send <- data:
					default:
						close(client.Send)
						delete(h.clients, client)
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) HandleConnection(w http.ResponseWriter, r *http.Request, jwtSecret string) {
	// Get token from query param
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Validate token
	claims, err := validateToken(token, jwtSecret)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	userID := claims["sub"].(string)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("WebSocket upgrade failed", "error", err)
		return
	}

	client := &Client{
		ID:     fmt.Sprintf("ws_%d", time.Now().UnixNano()),
		UserID: userID,
		Conn:   conn,
		Send:   make(chan []byte, 256),
		Rooms:  make(map[string]bool),
		hub:    h,
	}

	h.register <- client

	go client.writePump()
	go client.readPump()
}

func (h *Hub) JoinRoom(client *Client, room string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.rooms[room]; !ok {
		h.rooms[room] = make(map[*Client]bool)
	}
	h.rooms[room][client] = true
	client.Rooms[room] = true

	h.logger.Debug("Client joined room",
		"client_id", client.ID,
		"room", room,
	)
}

func (h *Hub) LeaveRoom(client *Client, room string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.rooms[room]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.rooms, room)
		}
	}
	delete(client.Rooms, room)
}

func (h *Hub) BroadcastToRoom(room string, message Message) {
	h.broadcast <- &RoomMessage{
		Room:    room,
		Message: message,
	}
}

func (h *Hub) BroadcastToUser(userID string, message Message) {
	data, _ := json.Marshal(message)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		if client.UserID == userID {
			select {
			case client.Send <- data:
			default:
			}
		}
	}
}

// Client methods
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
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
				c.hub.logger.Error("WebSocket read error", "error", err)
			}
			break
		}

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
				w.Write([]byte{'\n'})
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
	var msg struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}

	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "join":
		var payload struct {
			Room string `json:"room"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			// Validate room access (e.g., check project membership)
			if strings.HasPrefix(payload.Room, "project:") {
				c.hub.JoinRoom(c, payload.Room)
			}
		}

	case "leave":
		var payload struct {
			Room string `json:"room"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			c.hub.LeaveRoom(c, payload.Room)
		}

	case "presence":
		// Update user presence
		for room := range c.Rooms {
			c.hub.BroadcastToRoom(room, Message{
				Type: "user_active",
				Payload: map[string]any{
					"user_id": c.UserID,
					"room":    room,
				},
			})
		}
	}
}

func validateToken(tokenString, secret string) (jwt.MapClaims, error) {
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(secret), nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(jwt.MapClaims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024
)
```

### Junior -> FAANG: WebSocket Fundamentals FAANG Interviewers Test

The most common WebSocket interview question at FAANG is: "Walk me through what happens when a client connects, sends a message, and disconnects." You should be able to answer this at the goroutine level: the `readPump` goroutine blocks on `ReadMessage`, the `writePump` goroutine selects over a `Send` channel and a ping ticker, and disconnect triggers `unregister` which closes the `Send` channel which causes `writePump` to exit cleanly.

The second most common question: "Why do you need both a read goroutine and a write goroutine?" Because the WebSocket protocol requires that reads and writes not be concurrent from two goroutines. Gorilla's `Conn` is not safe for concurrent use. The send channel serializes writes onto the single write goroutine, and reads happen on their own goroutine. This is the standard Gorilla example pattern and interviewers expect you to name it.

Know what `CheckOrigin: func(r *http.Request) bool { return true }` means in production. It bypasses the browser's CORS protection for WebSocket upgrades. Acceptable in development, never acceptable in production. The correct implementation checks the `Origin` header against an allowlist.

### Senior @ FAANG: Hub Design Failures at Scale

The hub in this file has three architectural problems that a staff engineer identifies in the first code review.

**Problem 1: single-process fan-out.** The `rooms` map lives in process memory. The moment you deploy two backend instances behind a load balancer, a task update handled by instance A never reaches clients connected to instance B. The fix is to move the broadcast channel into a pub/sub system (Redis Streams, NATS JetStream, or Kafka, depending on your delivery guarantees). Each hub subscribes to its project room topics and fans out locally. The ADR question is: do you need ordered delivery per room? NATS JetStream gives you ordered delivery per subject, and Redis Streams give you consumer group semantics. For a Kanban board, ordering matters: a `task_moved` event arriving before `task_created` is incoherent.

**Problem 2: the broadcast/unregister race.** The broadcast case acquires an `RLock`, reads the room's client set, and attempts to drain a disconnecting client's `Send` channel by closing it and deleting from `h.clients`. But `h.clients` is not covered by the RLock, and the delete inside the RLock region while another goroutine holds the same RLock for broadcast is a data race. The concurrent hub pattern from the Gorilla examples uses the select loop (single goroutine) to serialize all client-set mutations, never touching the map from the broadcast path directly. The code here mixes the select-loop pattern and the mutex pattern incorrectly.

**Problem 3: no backpressure.** The `default:` case in the broadcast path closes the slow client's send channel. This is a correct approach for shedding slow consumers, but the client's `readPump` goroutine is still running and will block on `unregister` indefinitely if the hub's select loop is busy. A production hub sets a write deadline on the connection (`SetWriteDeadline`) so the OS closes the underlying TCP socket, which causes `readPump`'s `ReadMessage` to return an error and the goroutine to exit through the normal unregister path.

**Token-in-query-string security.** Passing the JWT in the URL (`?token=...`) is problematic: it appears in server access logs, proxy logs, and browser history. The preferred pattern is to perform the WebSocket handshake with a short-lived, single-use ticket: the client requests a ticket from an authenticated REST endpoint, and the ticket is redeemed during the WebSocket upgrade. The ticket lives in a Redis key with a 30-second TTL.

---
