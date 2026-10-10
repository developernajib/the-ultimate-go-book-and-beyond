package api

import (
	"log"
	"net/http"

	"github.com/example/chat-application/internal/auth"
	"github.com/example/chat-application/internal/chat"
	"github.com/gorilla/websocket"
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
