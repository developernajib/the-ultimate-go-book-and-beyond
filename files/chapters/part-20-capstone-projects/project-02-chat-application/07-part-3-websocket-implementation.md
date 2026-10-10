## Part 3: WebSocket Implementation

WebSockets provide full-duplex communication between the client and server, which is what makes real-time chat possible. Unlike regular HTTP requests where the client must always initiate communication, a WebSocket connection stays open so the server can push new messages to clients instantly. In this section, you will build three core components: a `Client` that manages a single WebSocket connection, a `Hub` that coordinates all connected clients and routes messages between them, and a `Room` that groups clients into chat channels. Understanding this architecture is critical because it is the same pattern used by production chat systems at companies like Slack and Discord.

### 3.1 WebSocket Client (`internal/chat/client.go`)

WebSocket connections enable bidirectional real-time communication between the server and browser clients over a persistent TCP connection. After the HTTP upgrade handshake, each connection is served by a pair of dedicated goroutines for reading and writing, which Go's scheduler handles efficiently at scale.

```go
package chat

import (
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer
	pongWait = 60 * time.Second

	// Send pings to peer with this period (must be less than pongWait)
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer
	maxMessageSize = 8192
)

// Client represents a WebSocket connection
type Client struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	Username  string
	Hub       *Hub
	Conn      *websocket.Conn
	Send      chan []byte
	Rooms     map[uuid.UUID]bool // rooms this client is subscribed to
}

// NewClient creates a new WebSocket client
func NewClient(userID uuid.UUID, username string, hub *Hub, conn *websocket.Conn) *Client {
	return &Client{
		ID:       uuid.New(),
		UserID:   userID,
		Username: username,
		Hub:      hub,
		Conn:     conn,
		Send:     make(chan []byte, 256),
		Rooms:    make(map[uuid.UUID]bool),
	}
}

// ReadPump pumps messages from the WebSocket connection to the hub
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.Unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		// Parse incoming message
		var msg IncomingMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Error unmarshaling message: %v", err)
			continue
		}

		// Set sender info
		msg.UserID = c.UserID
		msg.ClientID = c.ID

		// Handle message based on type
		c.Hub.HandleMessage <- &msg
	}
}

// WritePump pumps messages from the hub to the WebSocket connection
func (c *Client) WritePump() {
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
				// Hub closed the channel
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add queued messages to the current WebSocket message
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

// SendMessage sends a message to the client
func (c *Client) SendMessage(msg *OutgoingMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	select {
	case c.Send <- data:
		return nil
	default:
		// Client's send channel is full, close connection
		close(c.Send)
		return ErrClientSendFull
	}
}
```

### 3.2 WebSocket Hub (`internal/chat/hub.go`)

The WebSocket hub maintains a registry of active client connections and routes messages between them using Go channels for thread-safe communication. Centralizing broadcast logic in a single goroutine avoids mutex contention across connections and provides a clean place to enforce per-room membership rules.

```go
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"

	"github.com/redis/go-redis/v9"
	"github.com/google/uuid"
)

var (
	ErrClientSendFull = errors.New("client send channel is full")
	ErrRoomNotFound   = errors.New("room not found")
)

// Hub maintains the set of active clients and broadcasts messages
type Hub struct {
	// Registered clients
	Clients map[uuid.UUID]*Client

	// Rooms (channels)
	Rooms map[uuid.UUID]*Room

	// Register requests from clients
	Register chan *Client

	// Unregister requests from clients
	Unregister chan *Client

	// Incoming messages from clients
	HandleMessage chan *IncomingMessage

	// Broadcast messages to rooms
	Broadcast chan *BroadcastMessage

	// Redis client for pub/sub
	RedisClient *redis.Client

	// Message handler
	MessageHandler MessageHandler

	// Presence service
	PresenceService PresenceService

	// Context for shutdown
	ctx    context.Context
	cancel context.CancelFunc

	mu sync.RWMutex
}

// Room represents a chat room/channel
type Room struct {
	ID      uuid.UUID
	Clients map[uuid.UUID]*Client
	mu      sync.RWMutex
}

// NewRoom creates a new room
func NewRoom(id uuid.UUID) *Room {
	return &Room{
		ID:      id,
		Clients: make(map[uuid.UUID]*Client),
	}
}

// AddClient adds a client to the room
func (r *Room) AddClient(client *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Clients[client.ID] = client
}

// RemoveClient removes a client from the room
func (r *Room) RemoveClient(client *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.Clients, client.ID)
}

// GetClients returns all clients in the room
func (r *Room) GetClients() []*Client {
	r.mu.RLock()
	defer r.mu.RUnlock()

	clients := make([]*Client, 0, len(r.Clients))
	for _, client := range r.Clients {
		clients = append(clients, client)
	}
	return clients
}

// NewHub creates a new Hub
func NewHub(redisClient *redis.Client, msgHandler MessageHandler, presenceService PresenceService) *Hub {
	ctx, cancel := context.WithCancel(context.Background())

	return &Hub{
		Clients:         make(map[uuid.UUID]*Client),
		Rooms:           make(map[uuid.UUID]*Room),
		Register:        make(chan *Client),
		Unregister:      make(chan *Client),
		HandleMessage:   make(chan *IncomingMessage, 256),
		Broadcast:       make(chan *BroadcastMessage, 256),
		RedisClient:     redisClient,
		MessageHandler:  msgHandler,
		PresenceService: presenceService,
		ctx:             ctx,
		cancel:          cancel,
	}
}

// Run starts the hub
func (h *Hub) Run() {
	// Start Redis pub/sub listener
	go h.listenRedis()

	for {
		select {
		case client := <-h.Register:
			h.registerClient(client)

		case client := <-h.Unregister:
			h.unregisterClient(client)

		case msg := <-h.HandleMessage:
			h.handleIncomingMessage(msg)

		case broadcast := <-h.Broadcast:
			h.broadcastMessage(broadcast)

		case <-h.ctx.Done():
			log.Println("Hub shutting down")
			return
		}
	}
}

// registerClient registers a new client
func (h *Hub) registerClient(client *Client) {
	h.mu.Lock()
	h.Clients[client.ID] = client
	h.mu.Unlock()

	log.Printf("Client registered: %s (user: %s)", client.ID, client.Username)

	// Update user presence
	h.PresenceService.SetOnline(h.ctx, client.UserID)

	// Send welcome message
	welcomeMsg := &OutgoingMessage{
		Type: MessageTypeConnected,
		Data: map[string]any{
			"client_id": client.ID,
			"message":   "Connected to GoChat",
		},
	}
	client.SendMessage(welcomeMsg)
}

// unregisterClient unregisters a client
func (h *Hub) unregisterClient(client *Client) {
	h.mu.Lock()
	if _, ok := h.Clients[client.ID]; ok {
		delete(h.Clients, client.ID)
		close(client.Send)
	}
	h.mu.Unlock()

	// Remove from all rooms
	for roomID := range client.Rooms {
		h.leaveRoom(client, roomID)
	}

	log.Printf("Client unregistered: %s (user: %s)", client.ID, client.Username)

	// Check if user has other active connections
	hasOtherConnections := false
	h.mu.RLock()
	for _, c := range h.Clients {
		if c.UserID == client.UserID {
			hasOtherConnections = true
			break
		}
	}
	h.mu.RUnlock()

	// Update presence only if no other connections
	if !hasOtherConnections {
		h.PresenceService.SetOffline(h.ctx, client.UserID)
	}
}

// handleIncomingMessage handles incoming messages from clients
func (h *Hub) handleIncomingMessage(msg *IncomingMessage) {
	switch msg.Type {
	case MessageTypeJoinRoom:
		h.handleJoinRoom(msg)
	case MessageTypeLeaveRoom:
		h.handleLeaveRoom(msg)
	case MessageTypeChatMessage:
		h.handleChatMessage(msg)
	case MessageTypeTyping:
		h.handleTyping(msg)
	case MessageTypeReaction:
		h.handleReaction(msg)
	case MessageTypeReadReceipt:
		h.handleReadReceipt(msg)
	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

// handleJoinRoom handles room join requests
func (h *Hub) handleJoinRoom(msg *IncomingMessage) {
	roomID, ok := msg.Data["room_id"].(string)
	if !ok {
		log.Println("Invalid room_id in join room message")
		return
	}

	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		log.Printf("Invalid room UUID: %v", err)
		return
	}

	client := h.getClient(msg.ClientID)
	if client == nil {
		return
	}

	h.joinRoom(client, roomUUID)
}

// handleLeaveRoom handles room leave requests
func (h *Hub) handleLeaveRoom(msg *IncomingMessage) {
	roomID, ok := msg.Data["room_id"].(string)
	if !ok {
		log.Println("Invalid room_id in leave room message")
		return
	}

	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		log.Printf("Invalid room UUID: %v", err)
		return
	}

	client := h.getClient(msg.ClientID)
	if client == nil {
		return
	}

	h.leaveRoom(client, roomUUID)
}

// handleChatMessage handles chat messages
func (h *Hub) handleChatMessage(msg *IncomingMessage) {
	// Validate message
	content, ok := msg.Data["content"].(string)
	if !ok || content == "" {
		log.Println("Invalid content in chat message")
		return
	}

	roomID, ok := msg.Data["room_id"].(string)
	if !ok {
		log.Println("Invalid room_id in chat message")
		return
	}

	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		log.Printf("Invalid room UUID: %v", err)
		return
	}

	// Save message to database
	savedMsg, err := h.MessageHandler.SaveMessage(h.ctx, msg.UserID, roomUUID, content)
	if err != nil {
		log.Printf("Error saving message: %v", err)
		return
	}

	// Broadcast to room via Redis (for horizontal scaling)
	broadcastMsg := &BroadcastMessage{
		RoomID:  roomUUID,
		Message: savedMsg,
	}

	// Publish to Redis
	h.publishToRedis(broadcastMsg)

	// Also broadcast locally (in case Redis is down)
	h.Broadcast <- broadcastMsg
}

// handleTyping handles typing indicators
func (h *Hub) handleTyping(msg *IncomingMessage) {
	roomID, ok := msg.Data["room_id"].(string)
	if !ok {
		return
	}

	roomUUID, err := uuid.Parse(roomID)
	if err != nil {
		return
	}

	isTyping, ok := msg.Data["is_typing"].(bool)
	if !ok {
		isTyping = true
	}

	// Set typing status in Redis (with TTL)
	h.PresenceService.SetTyping(h.ctx, msg.UserID, roomUUID, isTyping)

	// Broadcast typing indicator to room
	typingMsg := &OutgoingMessage{
		Type: MessageTypeTyping,
		Data: map[string]any{
			"user_id":   msg.UserID,
			"room_id":   roomUUID,
			"is_typing": isTyping,
		},
	}

	h.broadcastToRoom(roomUUID, typingMsg, msg.ClientID)
}

// handleReaction handles message reactions
func (h *Hub) handleReaction(msg *IncomingMessage) {
	// Implementation for reactions
	// Similar pattern to chat messages
}

// handleReadReceipt handles read receipts
func (h *Hub) handleReadReceipt(msg *IncomingMessage) {
	// Implementation for read receipts
	// Similar pattern to chat messages
}

// joinRoom adds a client to a room
func (h *Hub) joinRoom(client *Client, roomID uuid.UUID) {
	h.mu.Lock()
	room, exists := h.Rooms[roomID]
	if !exists {
		room = NewRoom(roomID)
		h.Rooms[roomID] = room
	}
	h.mu.Unlock()

	room.AddClient(client)
	client.Rooms[roomID] = true

	log.Printf("Client %s joined room %s", client.ID, roomID)

	// Send join confirmation
	joinMsg := &OutgoingMessage{
		Type: MessageTypeJoinedRoom,
		Data: map[string]any{
			"room_id": roomID,
		},
	}
	client.SendMessage(joinMsg)

	// Notify other users in the room
	presenceMsg := &OutgoingMessage{
		Type: MessageTypeUserJoined,
		Data: map[string]any{
			"user_id":  client.UserID,
			"username": client.Username,
			"room_id":  roomID,
		},
	}
	h.broadcastToRoom(roomID, presenceMsg, client.ID)
}

// leaveRoom removes a client from a room
func (h *Hub) leaveRoom(client *Client, roomID uuid.UUID) {
	h.mu.Lock()
	room, exists := h.Rooms[roomID]
	h.mu.Unlock()

	if !exists {
		return
	}

	room.RemoveClient(client)
	delete(client.Rooms, roomID)

	log.Printf("Client %s left room %s", client.ID, roomID)

	// Notify other users
	presenceMsg := &OutgoingMessage{
		Type: MessageTypeUserLeft,
		Data: map[string]any{
			"user_id":  client.UserID,
			"username": client.Username,
			"room_id":  roomID,
		},
	}
	h.broadcastToRoom(roomID, presenceMsg, client.ID)

	// Clean up empty rooms
	if len(room.GetClients()) == 0 {
		h.mu.Lock()
		delete(h.Rooms, roomID)
		h.mu.Unlock()
	}
}

// broadcastMessage broadcasts a message to a room
func (h *Hub) broadcastMessage(broadcast *BroadcastMessage) {
	outMsg := &OutgoingMessage{
		Type: MessageTypeNewMessage,
		Data: broadcast.Message,
	}

	h.broadcastToRoom(broadcast.RoomID, outMsg, uuid.Nil)
}

// broadcastToRoom sends a message to all clients in a room except excluded client
func (h *Hub) broadcastToRoom(roomID uuid.UUID, msg *OutgoingMessage, excludeClientID uuid.UUID) {
	h.mu.RLock()
	room, exists := h.Rooms[roomID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	for _, client := range room.GetClients() {
		if client.ID != excludeClientID {
			client.SendMessage(msg)
		}
	}
}

// getClient retrieves a client by ID
func (h *Hub) getClient(clientID uuid.UUID) *Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.Clients[clientID]
}

// Shutdown gracefully shuts down the hub
func (h *Hub) Shutdown() {
	h.cancel()

	// Close all client connections
	h.mu.Lock()
	for _, client := range h.Clients {
		close(client.Send)
		client.Conn.Close()
	}
	h.mu.Unlock()
}

// Redis Pub/Sub for horizontal scaling

// publishToRedis publishes a broadcast message to Redis
func (h *Hub) publishToRedis(msg *BroadcastMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling broadcast message: %v", err)
		return
	}

	channel := "gochat:broadcast:" + msg.RoomID.String()
	if err := h.RedisClient.Publish(h.ctx, channel, data).Err(); err != nil {
		log.Printf("Error publishing to Redis: %v", err)
	}
}

// listenRedis listens for messages from Redis pub/sub
func (h *Hub) listenRedis() {
	// Subscribe to all broadcast channels
	pubsub := h.RedisClient.PSubscribe(h.ctx, "gochat:broadcast:*")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for msg := range ch {
		var broadcast BroadcastMessage
		if err := json.Unmarshal([]byte(msg.Payload), &broadcast); err != nil {
			log.Printf("Error unmarshaling Redis message: %v", err)
			continue
		}

		// Broadcast to local clients
		h.Broadcast <- &broadcast
	}
}
```

### 3.3 Message Types (`internal/chat/message.go`)

The following type definitions establish the core data model for the 3.3 Message Types (`internal/chat/message.go`) domain. These types are the shared language between layers of the system, so their field names, nullability, and validation rules are chosen for clarity and correctness.

```go
package chat

import (
	"context"

	"github.com/google/uuid"
	"github.com/yourusername/gochat/internal/models"
)

// IncomingMessage represents a message from a client
type IncomingMessage struct {
	Type     MessageTypeEnum        `json:"type"`
	Data     map[string]any `json:"data"`
	UserID   uuid.UUID              `json:"-"` // Set by server
	ClientID uuid.UUID              `json:"-"` // Set by server
}

// OutgoingMessage represents a message to a client
type OutgoingMessage struct {
	Type MessageTypeEnum `json:"type"`
	Data any     `json:"data"`
}

// BroadcastMessage represents a message to broadcast to a room
type BroadcastMessage struct {
	RoomID  uuid.UUID       `json:"room_id"`
	Message *models.Message `json:"message"`
}

// MessageTypeEnum represents message types
type MessageTypeEnum string

const (
	// Client -> Server
	MessageTypeJoinRoom    MessageTypeEnum = "join_room"
	MessageTypeLeaveRoom   MessageTypeEnum = "leave_room"
	MessageTypeChatMessage MessageTypeEnum = "chat_message"
	MessageTypeTyping      MessageTypeEnum = "typing"
	MessageTypeReaction    MessageTypeEnum = "reaction"
	MessageTypeReadReceipt MessageTypeEnum = "read_receipt"

	// Server -> Client
	MessageTypeConnected   MessageTypeEnum = "connected"
	MessageTypeJoinedRoom  MessageTypeEnum = "joined_room"
	MessageTypeLeftRoom    MessageTypeEnum = "left_room"
	MessageTypeNewMessage  MessageTypeEnum = "new_message"
	MessageTypeUserJoined  MessageTypeEnum = "user_joined"
	MessageTypeUserLeft    MessageTypeEnum = "user_left"
	MessageTypeError       MessageTypeEnum = "error"
)

// MessageHandler interface for saving/retrieving messages
type MessageHandler interface {
	SaveMessage(ctx context.Context, userID, channelID uuid.UUID, content string) (*models.Message, error)
	GetMessages(ctx context.Context, channelID uuid.UUID, limit int, before *uuid.UUID) ([]*models.Message, error)
	DeleteMessage(ctx context.Context, messageID, userID uuid.UUID) error
	AddReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error
	RemoveReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error
}

// PresenceService interface for managing user presence
type PresenceService interface {
	SetOnline(ctx context.Context, userID uuid.UUID) error
	SetOffline(ctx context.Context, userID uuid.UUID) error
	SetTyping(ctx context.Context, userID, channelID uuid.UUID, isTyping bool) error
	GetOnlineUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error)
	GetTypingUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error)
}
```

### Junior → FAANG: The Hub-Client Pattern as a Concurrency Study

The Hub-Client pattern (a central Hub goroutine managing all Client goroutines) is the canonical Go concurrency pattern for WebSocket servers. The Hub owns the set of connected clients and routes messages using channels, avoiding the need for shared-memory locking. Each Client has a dedicated read goroutine and write goroutine, so reads and writes never race.

For interviews, explaining why the Hub uses channels instead of a mutex to manage the client set demonstrates Go concurrency fluency. A mutex would work but requires careful lock ordering and makes it easy to introduce deadlocks. Channels make the control flow explicit: a client registers by sending itself on the `register` channel, unregisters by sending on the `unregister` channel, and sends messages via the `broadcast` channel. The Hub's `select` loop processes these sequentially, eliminating any concurrency concern within the Hub itself.

Goroutine lifecycle management is the most common bug in WebSocket servers. Every goroutine started for a client must terminate when the connection closes. Verify this by running your server with `go test -race` and checking for goroutine leaks using `goleak`.

### Senior @ FAANG: Hub Scalability and the Single-Process Bottleneck

The Hub in this implementation is a single goroutine processing all client events serially. For a small chat application, this is fine. At scale, the single Hub goroutine becomes a throughput bottleneck: it can only process messages as fast as a single CPU core allows.

The standard scaling approach is to shard the Hub: rather than one Hub per server, use one Hub per channel (or per group of channels). Each Hub goroutine processes events only for its assigned channels. This increases parallelism and reduces contention. The routing layer (which Hub handles a given channel) can be a simple modulo-based hash or a consistent hash for better distribution.

At FAANG scale, each WebSocket server typically runs hundreds of channel Hubs. The memory footprint per Hub must be minimized: avoid storing full message history in-memory, use bounded channels to prevent unbounded buffer growth, and implement backpressure signals when a client's write buffer is full (indicate slow consumer, not a bug). Documenting the memory model (maximum connections per server, bytes per connection, maximum in-flight messages) is required before production deployment.

---
