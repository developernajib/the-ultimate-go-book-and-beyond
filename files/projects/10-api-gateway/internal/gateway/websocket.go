// internal/gateway/websocket.go
package gateway

import (
	"net/http"
	"net/url"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// WebSocketProxy creates a reverse proxy for WebSocket connections
func (s *Server) createWebSocketProxy(targetURL *url.URL) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Upgrade connection
        upgrader := websocket.Upgrader{
            CheckOrigin: func(r *http.Request) bool {
                return true // Configure CORS as needed
            },
        }

        clientConn, err := upgrader.Upgrade(w, r, nil)
        if err != nil {
            s.logger.Error("websocket upgrade failed", zap.Error(err))
            return
        }
        defer clientConn.Close()

        // Connect to backend
        backendURL := *targetURL
        backendURL.Scheme = "ws"

        backendConn, _, err := websocket.DefaultDialer.Dial(backendURL.String(), nil)
        if err != nil {
            s.logger.Error("backend websocket connection failed", zap.Error(err))
            return
        }
        defer backendConn.Close()

        // Bidirectional proxy
        errChan := make(chan error, 2)

        // Client -> Backend
        go func() {
            for {
                messageType, message, err := clientConn.ReadMessage()
                if err != nil {
                    errChan <- err
                    return
                }
                if err := backendConn.WriteMessage(messageType, message); err != nil {
                    errChan <- err
                    return
                }
            }
        }()

        // Backend -> Client
        go func() {
            for {
                messageType, message, err := backendConn.ReadMessage()
                if err != nil {
                    errChan <- err
                    return
                }
                if err := clientConn.WriteMessage(messageType, message); err != nil {
                    errChan <- err
                    return
                }
            }
        }()

        // Wait for error
        <-errChan
    })
}
