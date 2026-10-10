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
