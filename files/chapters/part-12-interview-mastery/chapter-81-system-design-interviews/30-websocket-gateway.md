## WebSocket Gateway

WebSocket and streaming connections enable full-duplex or server-push communication over persistent connections, essential for real-time features such as live updates. The implementation below demonstrates proper connection management, message framing, and graceful shutdown.

```go
package gateway

import (
    "net/http"
    "sync"

    "github.com/google/uuid"
    "github.com/gorilla/websocket"
)

// Connection represents a client WebSocket connection
type Connection struct {
    ID       string
    UserID   string
    Conn     *websocket.Conn
    Send     chan []byte
}

// Gateway manages all WebSocket connections
type Gateway struct {
    mu          sync.RWMutex
    connections map[string]*Connection    // connID -> connection
    userConns   map[string]map[string]bool // userID -> set of connIDs

    chatService ChatService
    presence    PresenceService
}

// HandleConnection handles a new WebSocket connection
func (g *Gateway) HandleConnection(w http.ResponseWriter, r *http.Request, userID string) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }

    c := &Connection{
        ID:     uuid.New().String(),
        UserID: userID,
        Conn:   conn,
        Send:   make(chan []byte, 256),
    }

    g.registerConnection(c)
    g.presence.SetOnline(r.Context(), userID)

    // Start read/write goroutines
    go g.readPump(c)
    go g.writePump(c)
}

func (g *Gateway) readPump(c *Connection) {
    defer func() {
        g.unregisterConnection(c)
        c.Conn.Close()
    }()

    for {
        _, message, err := c.Conn.ReadMessage()
        if err != nil {
            return
        }

        // Parse and route message
        msg, err := parseMessage(message)
        if err != nil {
            continue
        }

        switch msg.Type {
        case "send_message":
            g.handleSendMessage(c, msg)
        case "typing":
            g.handleTyping(c, msg)
        case "read_receipt":
            g.handleReadReceipt(c, msg)
        }
    }
}

func (g *Gateway) writePump(c *Connection) {
    for message := range c.Send {
        if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
            return
        }
    }
}

// SendToUser sends a message to all connections of a user
func (g *Gateway) SendToUser(userID string, message []byte) {
    g.mu.RLock()
    connIDs := g.userConns[userID]
    g.mu.RUnlock()

    for connID := range connIDs {
        g.mu.RLock()
        conn := g.connections[connID]
        g.mu.RUnlock()

        if conn != nil {
            select {
            case conn.Send <- message:
            default:
                // Connection buffer full, close it
                g.unregisterConnection(conn)
            }
        }
    }
}
```


### Junior → FAANG: WebSocket Gateway Design Basics

A WebSocket gateway is the entry point for persistent client connections in a chat system. Its responsibilities include connection establishment and authentication, routing incoming messages to the appropriate internal service, and delivering outgoing messages to the connected client. Unlike HTTP servers, a WebSocket gateway is stateful: each connection is pinned to a specific server process for the lifetime of the connection. This means standard HTTP load balancing (round-robin across servers) does not work for message delivery. You need a routing layer that knows which server holds which user's connection.

### Senior @ FAANG: WebSocket Gateway Scalability, Observability, and Deployment Strategy

At the senior level, the WebSocket gateway is one of the hardest components to operate at scale because of its statefulness. Key operational concerns: rolling deployments require graceful connection draining (connections must be migrated or gracefully terminated with reconnect signals before a server goes down for maintenance), memory leaks in the connection management layer cause slow degradation over hours of uptime, and a burst of reconnections after a gateway restart creates a thundering herd that can overload authentication and presence services. At the L6 bar, expect questions about how you monitor the health of the connection layer: connection count per server, message delivery latency per connection, error rates for failed deliveries, and the ratio of reconnection attempts to established connections (a spike in reconnections is an early signal of network instability). Staff-level concerns include the deployment topology: co-locating gateway servers in the same availability zone as the users they serve reduces latency, but this requires geo-aware DNS or Anycast routing, and the failure domain analysis becomes more complex.
