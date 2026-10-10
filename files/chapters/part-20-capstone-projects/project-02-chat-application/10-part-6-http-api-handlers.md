## Part 6: HTTP API Handlers

While WebSockets handle real-time messaging, your application still needs traditional HTTP endpoints for operations like user registration, login, channel creation, and fetching message history. In this section, you will build RESTful API handlers that validate input, interact with the storage layer, and return properly formatted JSON responses. These handlers also serve as the entry point for WebSocket upgrades, a client first authenticates over HTTP and then upgrades the connection to a WebSocket for real-time communication.

### 6.1 API Handlers (`internal/api/handlers.go`)
HTTP API handlers expose room management, message history retrieval, and user profile operations over a conventional REST interface. Separating these handlers from the WebSocket path allows REST clients to interact with the chat system without maintaining a persistent connection.

```go
package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
	"github.com/yourusername/gochat/internal/auth"
	"github.com/yourusername/gochat/internal/models"
	"github.com/yourusername/gochat/internal/storage"
)

type Handlers struct {
	pgStore    *storage.PostgresStore
	redisStore *storage.RedisStore
	jwtService *auth.JWTService
}

func NewHandlers(pgStore *storage.PostgresStore, redisStore *storage.RedisStore, jwtService *auth.JWTService) *Handlers {
	return &Handlers{
		pgStore:    pgStore,
		redisStore: redisStore,
		jwtService: jwtService,
	}
}

// Authentication handlers

func (h *Handlers) Register(w http.ResponseWriter, r *http.Request) {
	var req models.CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate request
	if req.Username == "" || req.Email == "" || req.Password == "" {
		respondError(w, http.StatusBadRequest, "Missing required fields")
		return
	}

	if len(req.Password) < 8 {
		respondError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}

	// Hash password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Error creating user")
		return
	}

	// Create user
	user, err := h.pgStore.CreateUser(r.Context(), &req, string(hashedPassword))
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Generate JWT
	token, err := h.jwtService.GenerateToken(user.ID, user.Username)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Error generating token")
		return
	}

	respondJSON(w, http.StatusCreated, &models.LoginResponse{
		Token: token,
		User:  user.ToPublic(),
	})
}

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	var req models.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Get user by username
	user, err := h.pgStore.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	// Verify password
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		respondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	// Generate JWT
	token, err := h.jwtService.GenerateToken(user.ID, user.Username)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Error generating token")
		return
	}

	respondJSON(w, http.StatusOK, &models.LoginResponse{
		Token: token,
		User:  user.ToPublic(),
	})
}

// Channel handlers

func (h *Handlers) CreateChannel(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req models.CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	channel, err := h.pgStore.CreateChannel(r.Context(), &req, userID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusCreated, channel)
}

func (h *Handlers) GetChannels(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	channels, err := h.pgStore.GetUserChannels(r.Context(), userID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, channels)
}

func (h *Handlers) GetChannel(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	channelID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid channel ID")
		return
	}

	// Check if user is member of channel
	isMember, err := h.pgStore.IsUserInChannel(r.Context(), userID, channelID)
	if err != nil || !isMember {
		respondError(w, http.StatusForbidden, "Access denied")
		return
	}

	channel, err := h.pgStore.GetChannelByID(r.Context(), channelID)
	if err != nil {
		respondError(w, http.StatusNotFound, "Channel not found")
		return
	}

	respondJSON(w, http.StatusOK, channel)
}

// Message handlers

func (h *Handlers) GetMessages(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	channelID, err := uuid.Parse(chi.URLParam(r, "channelId"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid channel ID")
		return
	}

	// Check if user is member of channel
	isMember, err := h.pgStore.IsUserInChannel(r.Context(), userID, channelID)
	if err != nil || !isMember {
		respondError(w, http.StatusForbidden, "Access denied")
		return
	}

	// Parse query parameters
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	var before *uuid.UUID
	beforeStr := r.URL.Query().Get("before")
	if beforeStr != "" {
		if b, err := uuid.Parse(beforeStr); err == nil {
			before = &b
		}
	}

	messages, err := h.pgStore.GetMessages(r.Context(), channelID, limit, before)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, messages)
}

func (h *Handlers) SearchMessages(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		respondError(w, http.StatusBadRequest, "Missing query parameter")
		return
	}

	var channelID *uuid.UUID
	channelIDStr := r.URL.Query().Get("channel_id")
	if channelIDStr != "" {
		cid, err := uuid.Parse(channelIDStr)
		if err == nil {
			// Verify user has access to channel
			isMember, err := h.pgStore.IsUserInChannel(r.Context(), userID, cid)
			if err == nil && isMember {
				channelID = &cid
			}
		}
	}

	limit := 20
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	offset := 0
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		if o, err := strconv.Atoi(offsetStr); err == nil && o >= 0 {
			offset = o
		}
	}

	messages, err := h.pgStore.SearchMessages(r.Context(), query, channelID, limit, offset)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, messages)
}

// Helper functions

func respondJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}
```

### 6.2 WebSocket Upgrade Handler (`internal/api/websocket.go`)

WebSocket connections enable bidirectional real-time communication between the server and browser clients over a persistent TCP connection. After the HTTP upgrade handshake, each connection is served by a pair of dedicated goroutines for reading and writing, which Go's scheduler handles efficiently at scale.

```go
package api

import (
	"log"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/yourusername/gochat/internal/auth"
	"github.com/yourusername/gochat/internal/chat"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// In production, check origin properly
		return true
	},
}

type WSHandler struct {
	hub        *chat.Hub
	jwtService *auth.JWTService
}

func NewWSHandler(hub *chat.Hub, jwtService *auth.JWTService) *WSHandler {
	return &WSHandler{
		hub:        hub,
		jwtService: jwtService,
	}
}

func (h *WSHandler) ServeWebSocket(w http.ResponseWriter, r *http.Request) {
	// Get token from query parameter (for WebSocket, we can't use headers easily)
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "Missing token", http.StatusUnauthorized)
		return
	}

	// Validate token
	claims, err := h.jwtService.ValidateToken(token)
	if err != nil {
		http.Error(w, "Invalid token", http.StatusUnauthorized)
		return
	}

	// Upgrade HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	// Create client
	client := chat.NewClient(claims.UserID, claims.Username, h.hub, conn)

	// Register client
	h.hub.Register <- client

	// Start goroutines
	go client.WritePump()
	go client.ReadPump()
}
```

### Junior → FAANG: HTTP Handlers as Contract Enforcement Points

HTTP handlers are the first line of defense against bad input. Every handler should validate input before touching business logic: check required fields are present, validate format (UUID, email), enforce size limits (message length, file size), and reject unexpected values. This validation should happen at the handler layer, not buried in the storage layer.

For the WebSocket upgrade handler specifically, authentication must happen before the upgrade. Once the connection is upgraded to WebSocket, HTTP middleware no longer runs. The common mistake is to validate the JWT after the upgrade, which means the WebSocket goroutines are started before authentication is confirmed.

Input validation libraries (like `go-playground/validator`) reduce boilerplate. Define your validation rules as struct tags and call the validator in one line. Know how to use them and how to return structured validation error responses.

### Senior @ FAANG: Handler Design as an API Governance Problem

At senior level, API handlers are governed by API versioning policy, input validation standards, and error response schemas. A senior engineer does not design these for one service. They define the pattern and ensure all services follow it.

The WebSocket upgrade handler has an important operational property: the response headers sent during the HTTP upgrade are the last chance to communicate with the client over HTTP. This includes setting cookies, CORS headers, and Strict-Transport-Security headers. After the upgrade, those mechanisms do not apply. Ensure all required security headers are set before calling `upgrader.Upgrade()`.

Handler testing at scale requires contract testing, not just unit testing. When the handler's response schema changes, consumers of the API break. Contract tests (using tools like Pact) define the expected request/response shape from the consumer's perspective and verify that the provider satisfies those contracts. This is a platform governance concern: which teams are responsible for defining contracts, how are breaking changes announced, and what is the migration timeline?

---
