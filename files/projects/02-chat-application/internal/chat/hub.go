package chat

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
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
