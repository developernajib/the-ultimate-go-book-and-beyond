## 102H.12 Protocol Selection: SSE vs WebSocket vs Long Polling

### Detailed Comparison

| Dimension | Server-Sent Events (SSE) | WebSocket | Long Polling |
|---|---|---|---|
| **Direction** | Server → Client only | Bidirectional | Server → Client (one at a time) |
| **Protocol** | HTTP/1.1, HTTP/2 | Upgrade from HTTP, then WS protocol | Plain HTTP |
| **Browser support** | All modern browsers | All modern browsers | All browsers including IE6 |
| **Proxy/CDN compatibility** | Excellent (plain HTTP) | Variable (some proxies buffer or block) | Excellent |
| **Load balancer** | Standard HTTP LB, HTTP/2 multiplexing | Sticky sessions or sessionless+Redis | Standard HTTP LB |
| **Reconnection** | Automatic (EventSource built-in) | Manual (must implement in JS) | Manual |
| **Event replay** | Built-in via `Last-Event-ID` | Must implement manually | Must implement manually |
| **Binary frames** | No (text/UTF-8 only) | Yes (binary + text frames) | No (HTTP body) |
| **Message ordering** | Guaranteed (stream) | Guaranteed per connection | No guarantee across polls |
| **Overhead per message** | HTTP headers on connection, then minimal | 2-14 bytes framing overhead | Full HTTP request/response |
| **Server goroutines** | 1 per SSE connection | 2 per WS connection (readPump + writePump) | 1 per pending request |
| **Connection limit** | HTTP/2: multiplexed. HTTP/1.1: per-connection | Same as HTTP | Per-request |
| **Latency** | Low (~1-10ms) | Very low (~1-5ms) | High (poll interval + RTT) |

### When to Use SSE

SSE is the correct choice when:

1. **One-way server push**: notifications, live scores, log streaming, build progress, stock tickers, CI/CD pipeline status.
2. **Works through all proxies**: SSE travels over standard HTTP - corporate proxies, Cloudflare, AWS CloudFront all handle it correctly. WebSocket sometimes fails through HTTP-only proxies.
3. **Automatic reconnection matters**: `EventSource` reconnects automatically with `Last-Event-ID` for event replay. No client-side retry logic required.
4. **HTTP/2 multiplexing**: with HTTP/2, multiple SSE streams share one TCP connection - no connection limit issues that HTTP/1.1 SSE has.
5. **Simpler implementation**: SSE is just an HTTP response with `Content-Type: text/event-stream` - works with any HTTP middleware, authentication, and logging that understands HTTP.

### When to Use WebSocket

WebSocket is correct when:

1. **Bidirectional communication**: chat applications, collaborative editing (sending user keystrokes to server), multiplayer games, real-time code editors.
2. **Binary protocol**: game state, audio/video data, custom binary protocols (MessagePack, Protocol Buffers over WebSocket).
3. **Sub-10ms round-trips**: WebSocket avoids HTTP overhead for each exchange. Critical for interactive applications.
4. **Client-to-server streaming**: uploading live telemetry, streaming audio input for speech recognition.

### When to Use Long Polling

Long polling is the pragmatic choice when:

1. **Maximum compatibility**: must work through all proxies, firewalls, and HTTP-only environments with no WebSocket support.
2. **Simple server push for low-frequency events**: if events happen once per minute, long polling's overhead is acceptable and the implementation is trivial.
3. **Existing HTTP infrastructure**: no special load balancer configuration needed. Standard health checks work. No sticky session requirements.

### Go Implementation of All Three for the Same "Live Notifications" Use Case

All three mechanisms share a single `NotificationStore` that maps user IDs to buffered subscriber channels, so the fan-out logic is written once and the transport layer is the only thing that differs. The SSE handler sets `Content-Type: text/event-stream` and writes the `id`/`event`/`data` wire format directly to the `http.ResponseWriter`, the WebSocket handler upgrades the connection and runs a concurrent read pump to process control frames, and the long-poll handler wraps the subscriber channel in a `context.WithTimeout` and returns a single JSON object before the client reconnects. Comparing all three side-by-side highlights how much complexity WebSocket adds (ping/pong, read pump goroutine, write deadlines) versus the simplicity of SSE for purely server-to-client delivery.

```go
package notifications

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

// Notification is the event payload delivered by all three mechanisms.
type Notification struct {
    ID        string    `json:"id"`
    UserID    string    `json:"user_id"`
    Type      string    `json:"type"`
    Message   string    `json:"message"`
    CreatedAt time.Time `json:"created_at"`
}

// NotificationStore holds pending notifications and waiting subscribers.
type NotificationStore struct {
    mu          sync.RWMutex
    subscribers map[string][]chan Notification // userID -> channels
}

func NewNotificationStore() *NotificationStore {
    return &NotificationStore{
        subscribers: make(map[string][]chan Notification),
    }
}

func (s *NotificationStore) subscribe(userID string) (chan Notification, func()) {
    ch := make(chan Notification, 10)
    s.mu.Lock()
    s.subscribers[userID] = append(s.subscribers[userID], ch)
    s.mu.Unlock()

    unsubscribe := func() {
        s.mu.Lock()
        defer s.mu.Unlock()
        subs := s.subscribers[userID]
        for i, c := range subs {
            if c == ch {
                s.subscribers[userID] = append(subs[:i], subs[i+1:]...)
                close(ch)
                break
            }
        }
    }
    return ch, unsubscribe
}

// Publish delivers a notification to all subscribers of userID.
func (s *NotificationStore) Publish(n Notification) {
    s.mu.RLock()
    subs := s.subscribers[n.UserID]
    s.mu.RUnlock()

    for _, ch := range subs {
        select {
        case ch <- n:
        default:
            // Subscriber too slow - drop rather than block
        }
    }
}

// --- MECHANISM 1: Server-Sent Events ---

func (s *NotificationStore) HandleSSE(w http.ResponseWriter, r *http.Request) {
    userID := r.URL.Query().Get("user_id")
    if userID == "" {
        http.Error(w, "user_id required", http.StatusBadRequest)
        return
    }

    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming not supported", http.StatusInternalServerError)
        return
    }

    // SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

    // Send initial keep-alive comment to establish the stream
    fmt.Fprintf(w, ": connected\n\n")
    flusher.Flush()

    ch, unsubscribe := s.subscribe(userID)
    defer unsubscribe()

    // Keep-alive ticker - SSE connections close silently after 30s without data on some proxies
    ticker := time.NewTicker(25 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case n, ok := <-ch:
            if !ok {
                return
            }
            data, err := json.Marshal(n)
            if err != nil {
                continue
            }
            // SSE wire format: id, event type, data fields
            fmt.Fprintf(w, "id: %s\nevent: notification\ndata: %s\n\n", n.ID, data)
            flusher.Flush()

        case <-ticker.C:
            // SSE keep-alive comment (ignored by EventSource client)
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()

        case <-r.Context().Done():
            return
        }
    }
}

// --- MECHANISM 2: WebSocket ---

var wsUpgrader = websocket.Upgrader{
    ReadBufferSize:  512,
    WriteBufferSize: 512,
    CheckOrigin:     func(r *http.Request) bool { return true },
}

func (s *NotificationStore) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
    userID := r.URL.Query().Get("user_id")
    if userID == "" {
        http.Error(w, "user_id required", http.StatusBadRequest)
        return
    }

    conn, err := wsUpgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }
    defer conn.Close()

    ch, unsubscribe := s.subscribe(userID)
    defer unsubscribe()

    conn.SetReadLimit(512)
    conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    conn.SetPongHandler(func(string) error {
        conn.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    // Read pump in goroutine - required to process control frames (ping/pong/close)
    go func() {
        for {
            if _, _, err := conn.ReadMessage(); err != nil {
                unsubscribe() // trigger channel close, exit write loop
                return
            }
        }
    }()

    pingTicker := time.NewTicker(54 * time.Second)
    defer pingTicker.Stop()

    for {
        select {
        case n, ok := <-ch:
            if !ok {
                conn.WriteMessage(websocket.CloseMessage,
                    websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
                return
            }
            data, _ := json.Marshal(n)
            conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
                return
            }

        case <-pingTicker.C:
            conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }
}

// --- MECHANISM 3: Long Polling ---

func (s *NotificationStore) HandleLongPoll(w http.ResponseWriter, r *http.Request) {
    userID := r.URL.Query().Get("user_id")
    if userID == "" {
        http.Error(w, "user_id required", http.StatusBadRequest)
        return
    }

    // Long poll timeout - client will reconnect after this
    ctx, cancel := context.WithTimeout(r.Context(), 28*time.Second)
    defer cancel()

    ch, unsubscribe := s.subscribe(userID)
    defer unsubscribe()

    // Wait for a notification or timeout
    select {
    case n, ok := <-ch:
        if !ok {
            w.WriteHeader(http.StatusGone)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(n)

    case <-ctx.Done():
        // Return 204 No Content - client reconnects immediately
        w.WriteHeader(http.StatusNoContent)
    }
    // Client must re-issue the request immediately after receiving a response
}
```

**Client-side long polling pattern (JavaScript)**:

```javascript
async function longPoll(userID) {
    while (true) {
        try {
            const res = await fetch(`/notifications/poll?user_id=${userID}`);
            if (res.status === 200) {
                const notification = await res.json();
                handleNotification(notification);
            }
            // 204 = timeout, reconnect immediately
            // Any other status: wait briefly before retry
            if (res.status !== 200 && res.status !== 204) {
                await new Promise(r => setTimeout(r, 2000)); // backoff on error
            }
        } catch (err) {
            await new Promise(r => setTimeout(r, 2000)); // network error backoff
        }
    }
}
```

### Junior → FAANG: How to Apply This Decision Framework in a System Design Interview

Decision frameworks like the one in this section are most useful when you can apply them in under 60 seconds. Practice the following narration for a system design interview: "The first question is bidirectionality: does the client send data after the connection is established? If yes, WebSocket. If no, SSE unless the environment is known to have WebSocket-hostile proxies, in which case SSE anyway with POST for client messages. If neither persistent connection is feasible, long-polling as a fallback."

The second dimension that often decides the question in practice is browser support and auto-reconnection. SSE's `EventSource` reconnects automatically with the last event ID. WebSocket requires you to implement reconnection logic. If you are building a product where network reliability is uncertain (mobile users, enterprise VPN environments), SSE's automatic reconnection is a concrete engineering advantage.

Do not skip to "I'd use WebSocket" without working through the decision dimensions. Interviewers at FAANG specifically watch for candidates who default to the most complex option without justifying why simpler options are insufficient.

### Senior @ FAANG: When None of the Three Options Is Right

At FAANG scale, the decision framework often leads to "none of the above." gRPC streaming provides bidirectional streaming over HTTP/2 with full Protobuf typing and load balancer compatibility. It is often the right choice for internal service-to-service real-time communication where the clients are Go services rather than browsers. NATS subjects with push consumers provide message delivery with backpressure guarantees that WebSocket and SSE do not have natively. Kafka topics with consumer groups provide ordered, durable, at-least-once delivery for high-throughput event streams.

The L6 signal is recognizing that WebSocket and SSE are client-server protocols optimized for browser clients, and that the correct real-time protocol for internal services is often a message queue or a streaming RPC framework. Many FAANG engineering organizations use WebSocket/SSE at the edge (browser to gateway) and gRPC streaming or NATS/Kafka for internal fan-out, combining the ergonomics of each protocol with the clients it is designed for. Describing this two-tier architecture in a system design interview demonstrates awareness of the full protocol landscape.

---
