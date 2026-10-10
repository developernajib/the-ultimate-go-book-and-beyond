// internal/http/handler/websocket.go
package handler

import (
    "net/http"
    "time"

    "github.com/gorilla/websocket"
    "github.com/example/social-network/internal/service"
    "go.uber.org/zap"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin: func(r *http.Request) bool {
        // In production, check origin properly
        return true
    },
}

type WebSocketHandler struct {
    notifService *service.NotificationService
    logger       *zap.Logger
}

func NewWebSocketHandler(
    notifService *service.NotificationService,
    logger *zap.Logger,
) *WebSocketHandler {
    return &WebSocketHandler{
        notifService: notifService,
        logger:       logger,
    }
}

func (h *WebSocketHandler) HandleNotifications(w http.ResponseWriter, r *http.Request) {
    userID := getUserIDFromContext(r.Context())

    // Upgrade connection
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        h.logger.Error("failed to upgrade websocket", zap.Error(err))
        return
    }
    defer conn.Close()

    // Add connection to notification service
    h.notifService.AddConnection(userID, conn)
    defer h.notifService.RemoveConnection(userID, conn)

    h.logger.Info("websocket connection established",
        zap.String("user_id", userID.String()),
    )

    // Set up ping/pong for connection health
    conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    conn.SetPongHandler(func(string) error {
        conn.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    // Start ping ticker
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    go func() {
        for range ticker.C {
            if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }()

    // Read messages (mainly for keepalive)
    for {
        _, _, err := conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                h.logger.Error("websocket error", zap.Error(err))
            }
            break
        }
    }

    h.logger.Info("websocket connection closed",
        zap.String("user_id", userID.String()),
    )
}
