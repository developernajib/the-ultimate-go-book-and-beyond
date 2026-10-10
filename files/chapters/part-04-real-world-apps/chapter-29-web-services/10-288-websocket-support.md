## 29.8 WebSocket Support

### Library Choice (April 2026)

Two libraries dominate WebSocket work in Go:

- **`github.com/gorilla/websocket`**, the long-standing default. Mature, extensive API, permissive read/write semantics. Shown below.
- **`github.com/coder/websocket`** (formerly `nhooyr.io/websocket`, rehomed to Coder in 2024). Smaller surface, context-first API, `net.Conn` adapter, concurrent-safe writes. Preferred for new code where context cancellation and simplicity matter.

For greenfield services, `coder/websocket` is usually the better pick. gorilla is still the right answer when integrating with existing middleware or the hub pattern below.

### WebSocket Handler (gorilla/websocket)

WebSocket connections start as a normal HTTP request that gets "upgraded" to a persistent, bidirectional TCP connection. The `gorilla/websocket` package handles the upgrade handshake. The Hub pattern shown below manages connected clients centrally: a `register` channel adds new clients, `unregister` removes them, and `broadcast` fans messages out to all connected clients. Each client runs separate read and write goroutines to avoid blocking the Hub's event loop.

**Security note:** the `CheckOrigin` function below allows every origin and is appropriate only for development. In production, whitelist your known front-end origins explicitly, otherwise any site can open a cross-origin WebSocket to your server and ride the user's cookies (CSWSH). Also set `conn.SetReadLimit`, `SetReadDeadline`, and send periodic pings to bound memory and detect dead peers.

```go
package websocket

import (
    "log/slog"
    "net/http"
    "sync"

    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin: func(r *http.Request) bool {
        // Implement proper origin checking in production
        return true
    },
}

type Hub struct {
    clients    map[*Client]bool
    broadcast  chan []byte
    register   chan *Client
    unregister chan *Client
    mu         sync.RWMutex
    logger     *slog.Logger
}

type Client struct {
    hub    *Hub
    conn   *websocket.Conn
    send   chan []byte
    userID string
}

func NewHub(logger *slog.Logger) *Hub {
    return &Hub{
        clients:    make(map[*Client]bool),
        broadcast:  make(chan []byte),
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
            h.logger.Info("client connected", "user_id", client.userID)

        case client := <-h.unregister:
            h.mu.Lock()
            if _, ok := h.clients[client]; ok {
                delete(h.clients, client)
                close(client.send)
            }
            h.mu.Unlock()
            h.logger.Info("client disconnected", "user_id", client.userID)

        case message := <-h.broadcast:
            h.mu.Lock()
            for client := range h.clients {
                select {
                case client.send <- message:
                default:
                    close(client.send)
                    delete(h.clients, client)
                }
            }
            h.mu.Unlock()
        }
    }
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        h.logger.Error("upgrade failed", "error", err)
        return
    }

    client := &Client{
        hub:    h,
        conn:   conn,
        send:   make(chan []byte, 256),
        userID: r.URL.Query().Get("user_id"),
    }

    h.register <- client

    go client.writePump()
    go client.readPump()
}

func (c *Client) readPump() {
    defer func() {
        c.hub.unregister <- c
        c.conn.Close()
    }()

    for {
        _, message, err := c.conn.ReadMessage()
        if err != nil {
            break
        }
        c.hub.broadcast <- message
    }
}

func (c *Client) writePump() {
    defer c.conn.Close()

    for message := range c.send {
        if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
            return
        }
    }
}
```

### Modern Alternative: coder/websocket

The same echo handler with `coder/websocket` is about a third the code and carries context cancellation throughout:

```go
package ws

import (
    "context"
    "net/http"
    "time"

    "github.com/coder/websocket"
    "github.com/coder/websocket/wsjson"
)

func Echo(w http.ResponseWriter, r *http.Request) {
    c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
        OriginPatterns: []string{"app.example.com"}, // explicit whitelist
    })
    if err != nil {
        return
    }
    defer c.CloseNow()

    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
    defer cancel()

    for {
        var msg map[string]any
        if err := wsjson.Read(ctx, c, &msg); err != nil {
            return // normal close or deadline
        }
        if err := wsjson.Write(ctx, c, msg); err != nil {
            return
        }
    }
    _ = c.Close(websocket.StatusNormalClosure, "bye")
}
```

`coder/websocket` enforces concurrent-write safety internally, integrates with `context.Context` for cancellation, and treats unknown origins as an error by default. For cluster-wide broadcast you still build a Hub, the pattern is unchanged.

### Junior to FAANG: WebSockets Without Shooting Yourself in the Foot

Five traps every new engineer falls into. First, no read deadline, dead TCP connections pin goroutines forever. Always `SetReadLimit` and `SetReadDeadline`, refresh the deadline on each ping or message. Second, no `CheckOrigin` (or allow-all), any website can open a WS to your server and abuse user cookies (CSWSH). Third, single-goroutine write from multiple producers without a channel, races and panics. Use the Hub's send channel or `coder/websocket`'s concurrent-safe writer. Fourth, no bounded send buffer, a slow consumer fills memory. Cap at 256 messages, disconnect on overflow. Fifth, no heartbeat, proxies close idle connections after 60 seconds silently. Ping every 30 seconds.

Worked example, a heartbeat that survives proxies.

```go
const (
    pongWait   = 60 * time.Second
    pingPeriod = 30 * time.Second
    writeWait  = 10 * time.Second
)
c.SetReadLimit(64 * 1024)
c.SetReadDeadline(time.Now().Add(pongWait))
c.SetPongHandler(func(string) error {
    c.SetReadDeadline(time.Now().Add(pongWait))
    return nil
})
ticker := time.NewTicker(pingPeriod)
defer ticker.Stop()
for {
    select {
    case <-ticker.C:
        c.SetWriteDeadline(time.Now().Add(writeWait))
        if err := c.WriteMessage(websocket.PingMessage, nil); err != nil { return }
    // ...
    }
}
```

Interview framing. "How does a WebSocket survive a 60-second idle proxy timeout." Answer, ping-pong every 30 seconds, close on missed pong. Bonus, mention that `coder/websocket` handles this automatically via context deadlines.

### Senior at FAANG: WebSocket Infrastructure at Scale

Scale dimensions for WS. Connection count per pod (typically 10k to 50k, Go goroutines are cheap but memory per connection plus send buffer adds up). Fan-out rate (Hub-per-pod breaks when you need to broadcast across pods). Shutdown (existing connections must be drained or reconnected gracefully on deploy). State (does the server hold chat state in memory, or is it in Redis/Kafka with the WS just as a pipe).

Cross-pod fan-out patterns. Redis pubsub (simple, non-durable, fine for broadcast). NATS JetStream (durable, partitioned, supports replay). Kafka (high throughput, ordered per partition, replay capable, heavier ops). For 10k to 100k connections, Redis pubsub plus sticky sessions at the LB is standard. For 1M+ connections (Slack, Discord scale), Kafka or NATS with partitioning by channel ID is required.

Horizontal scaling architecture. Each pod owns a subset of connections. Pods subscribe to a shared bus. A message published on `channel.123` reaches every pod, and each pod forwards to its local subscribers. This topology lets you scale pods independently of connection count. The trap, every pod sees every message, so at high message rate the bus becomes the bottleneck. Partition the bus (one pubsub topic per channel, one consumer group per region).

Deployment and rolling restarts. WebSocket connections are long-lived and do not naturally reconnect on pod termination. Implement client-side reconnect with jittered exponential backoff (cap at 30 seconds) and a server-side "please reconnect" frame sent at `preStop`. Align pod `terminationGracePeriodSeconds` with expected drain time (30 to 60 seconds typical). Never expect `Shutdown` to terminate WS cleanly, implement the drain protocol yourself.

Authentication on WebSocket. The WS upgrade is an HTTP request, authenticate it via cookies or `Authorization` header before calling `Upgrade`. Never trust query-string tokens for auth (they leak in logs, referer, history). If the subprotocol requires a token, use `Sec-WebSocket-Protocol` to pass it (still logged, but the convention scopes it). Rotate auth tokens during long-lived connections via in-band protocol, re-auth when the access token expires rather than dropping the connection.

Backpressure and flow control. When a consumer's `send` channel fills, the Hub above closes and unregisters the client. That is correct for broadcast systems. For per-client request/response systems, prefer to buffer with a cap then drop oldest, or signal the client "slow consumer, disconnecting in 5 seconds." Document the policy per service.

Observability. Metrics. `ws_connections_total` gauge, `ws_messages_sent_total` counter by direction, `ws_connection_duration_seconds` histogram on close, `ws_reconnects_total` on the client side (report via beacon). Alert on anomalous reconnect rate, that means pods are flapping or a client bug is present.

Security. Validate `Origin` strictly, reject unknown. Set `SetReadLimit` to a conservative cap (1 MB for typical chat, 64 KB for commands). Never deserialize arbitrary JSON into reflection-heavy types without bounds, use fixed schemas. Rate-limit per-connection (messages per second) and per-user (total connections). Block known abuse patterns (token churn, rapid reconnect loops).

Compatibility with HTTP/2 and HTTP/3. WS over h2 (RFC 8441) is supported by browsers and by `coder/websocket` (experimental for h2 in 2026). WS over h3 is not yet standardized. WebTransport is the eventual replacement for WS over h3 but the ecosystem is still immature. Staff decision, stay on WS over h1.1 at the LB, with h2 for everything else, revisit WebTransport in 2027.

Alternatives to consider before choosing WS. Server-Sent Events for server-to-client only. Long polling for extreme proxy-compatibility. gRPC streaming for service-to-service. WebTransport for future-looking use cases. For client-to-server push from browser, WS remains the answer in 2026.

Staff archetype. The Realtime Infra Lead owns the WS platform, the fan-out bus choice, the reconnect protocol, and the scale-out sizing model. Partners with product on real-time UX and with SRE on the state of the bus.

Multi-year roadmap. Year 1, unify on `coder/websocket`, migrate off gorilla where feasible, land the drain protocol. Year 2, scale the fan-out bus, measure per-channel cost, introduce per-channel partitioning. Year 3, evaluate WebTransport for new use cases, migrate select endpoints. Year 4, cross-region WS fan-out via geo-replicated bus (Confluent, NATS clusters).

---
