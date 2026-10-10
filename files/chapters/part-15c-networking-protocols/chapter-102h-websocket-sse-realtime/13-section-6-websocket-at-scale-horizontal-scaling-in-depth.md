## 102H.11 Horizontal Scaling in Depth & Connection Draining

Section 3 introduced Redis pub/sub for multi-node WebSocket. This section goes deeper: sticky sessions vs sessionless design, graceful shutdown with connection draining, and load testing with k6.

### Sticky Sessions vs Sessionless Design

**Sticky sessions** (also called session affinity): the load balancer routes all WebSocket connections from a given client to the same backend server. Implemented via IP hash, cookie-based affinity (AWS ALB's `AWSALB` cookie), or user-ID-based consistent hashing.

Advantages: no cross-node coordination for per-connection state. Simpler in-process hub.
Disadvantages: uneven load distribution if some users are heavier than others. A server restart drops all connections on that node simultaneously (thundering herd on reconnect).

**Sessionless design**: any node can serve any client. State is externalized to Redis. The in-process hub only routes to connections currently on *this* node. Redis pub/sub delivers messages from other nodes.

This is the production-correct approach for large-scale systems. The Redis-backed hub from Section 3 implements this - reproduced here with connection draining enhancements:

```go
package hub

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "github.com/gorilla/websocket"
    "github.com/redis/go-redis/v9"
)

const (
    writeWait       = 10 * time.Second
    pongWait        = 60 * time.Second
    pingPeriod      = (pongWait * 9) / 10
    maxMessageBytes = 8192
    sendBufferSize  = 256

    // drainTimeout is how long we wait for in-flight messages to flush
    // before forcibly closing a connection during graceful shutdown.
    drainTimeout = 30 * time.Second
)

// Client represents a single WebSocket connection.
type Client struct {
    hub      *RedisHub
    conn     *websocket.Conn
    send     chan []byte
    userID   string
    channels []string
    mu       sync.Mutex
    draining bool // true when we are shutting down this connection
}

// RedisHub routes messages between local clients and uses Redis pub/sub
// to broadcast across all nodes in the cluster.
type RedisHub struct {
    rdb      *redis.Client
    clients  sync.Map          // map[userID]*Client
    upgrader websocket.Upgrader
    logger   *slog.Logger

    // shutdown signals graceful drain
    shutdown chan struct{}
    wg       sync.WaitGroup
}

func NewRedisHub(rdb *redis.Client, logger *slog.Logger) *RedisHub {
    return &RedisHub{
        rdb: rdb,
        upgrader: websocket.Upgrader{
            ReadBufferSize:  1024,
            WriteBufferSize: 1024,
            CheckOrigin: func(r *http.Request) bool {
                // Production: validate r.Header.Get("Origin") against allowlist
                return true
            },
        },
        logger:   logger,
        shutdown: make(chan struct{}),
    }
}

// Publish sends a message to all subscribers of channelName across all nodes.
func (h *RedisHub) Publish(ctx context.Context, channelName string, payload any) error {
    data, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("marshal payload: %w", err)
    }
    return h.rdb.Publish(ctx, channelName, data).Err()
}

// Subscribe starts the Redis subscriber for a given channel and delivers
// messages to local clients subscribed to that channel.
func (h *RedisHub) Subscribe(ctx context.Context, channelName string) {
    pubsub := h.rdb.Subscribe(ctx, channelName)
    defer pubsub.Close()

    ch := pubsub.Channel()
    for {
        select {
        case msg, ok := <-ch:
            if !ok {
                return
            }
            h.deliverToLocalClients(channelName, []byte(msg.Payload))
        case <-ctx.Done():
            return
        case <-h.shutdown:
            return
        }
    }
}

func (h *RedisHub) deliverToLocalClients(channelName string, data []byte) {
    h.clients.Range(func(_, v any) bool {
        c := v.(*Client)
        c.mu.Lock()
        subscribed := false
        for _, ch := range c.channels {
            if ch == channelName {
                subscribed = true
                break
            }
        }
        draining := c.draining
        c.mu.Unlock()

        if subscribed && !draining {
            select {
            case c.send <- data:
            default:
                // Send buffer full - client is too slow, disconnect it
                h.logger.Warn("client send buffer full, disconnecting",
                    slog.String("userID", c.userID))
                h.disconnectClient(c)
            }
        }
        return true
    })
}

func (h *RedisHub) disconnectClient(c *Client) {
    h.clients.Delete(c.userID)
    close(c.send)
}

// ServeWS upgrades the HTTP connection to WebSocket and starts read/write pumps.
func (h *RedisHub) ServeWS(w http.ResponseWriter, r *http.Request, userID string, channels []string) {
    conn, err := h.upgrader.Upgrade(w, r, nil)
    if err != nil {
        h.logger.Error("websocket upgrade failed", slog.String("error", err.Error()))
        return
    }

    client := &Client{
        hub:      h,
        conn:     conn,
        send:     make(chan []byte, sendBufferSize),
        userID:   userID,
        channels: channels,
    }

    h.clients.Store(userID, client)
    h.wg.Add(2)

    go client.writePump()
    go client.readPump()
}

func (c *Client) readPump() {
    defer func() {
        c.hub.clients.Delete(c.userID)
        c.conn.Close()
        c.hub.wg.Done()
    }()

    c.conn.SetReadLimit(maxMessageBytes)
    c.conn.SetReadDeadline(time.Now().Add(pongWait))
    c.conn.SetPongHandler(func(string) error {
        c.conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    for {
        _, message, err := c.conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err,
                websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                c.hub.logger.Warn("unexpected websocket close",
                    slog.String("userID", c.userID),
                    slog.String("error", err.Error()))
            }
            return
        }
        // Echo to own channels via Redis so other nodes also receive it
        ctx := context.Background()
        for _, ch := range c.channels {
            c.hub.rdb.Publish(ctx, ch, message)
        }
    }
}

func (c *Client) writePump() {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        c.conn.Close()
        c.hub.wg.Done()
    }()

    for {
        select {
        case message, ok := <-c.send:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if !ok {
                // Hub closed the send channel - send close frame
                c.conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }
            if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
                return
            }

        case <-ticker.C:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }
}
```

### Graceful Shutdown: Connection Draining

During a rolling deploy, the old pod must stop accepting new connections and flush pending messages before terminating. This prevents clients losing messages mid-delivery:

```go
// GracefulShutdown implements the draining protocol:
// 1. Stop accepting new WebSocket upgrades (handled at HTTP server level via Shutdown)
// 2. Mark all clients as draining - no new messages accepted into send buffer
// 3. Send WebSocket close frame to each client with 1001 "Going Away"
// 4. Wait for all writePumps and readPumps to exit, or timeout after drainTimeout
func (h *RedisHub) GracefulShutdown() {
    close(h.shutdown)

    // Mark all clients as draining and send close frame
    h.clients.Range(func(_, v any) bool {
        c := v.(*Client)
        c.mu.Lock()
        c.draining = true
        c.mu.Unlock()

        // Send close frame with "Going Away" - client should reconnect to another node
        deadline := time.Now().Add(writeWait)
        c.conn.SetWriteDeadline(deadline)
        c.conn.WriteMessage(websocket.CloseMessage,
            websocket.FormatCloseMessage(websocket.CloseGoingAway, "server restarting"))
        return true
    })

    // Wait for all goroutines to exit, bounded by drainTimeout
    done := make(chan struct{})
    go func() {
        h.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        h.logger.Info("all websocket connections drained cleanly")
    case <-time.After(drainTimeout):
        h.logger.Warn("drain timeout reached, forcing connection close")
        // Force-close any remaining connections
        h.clients.Range(func(_, v any) bool {
            v.(*Client).conn.Close()
            return true
        })
    }
}

// Integration with net/http graceful shutdown:
func RunServer(addr string, hub *RedisHub) error {
    mux := http.NewServeMux()
    mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
        userID := r.URL.Query().Get("user_id")
        channels := r.URL.Query()["channel"]
        hub.ServeWS(w, r, userID, channels)
    })

    srv := &http.Server{
        Addr:    addr,
        Handler: mux,
    }

    // Signal handling for graceful shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
        <-sigCh

        // Phase 1: stop HTTP - no new upgrades
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        srv.Shutdown(ctx)

        // Phase 2: drain existing WebSocket connections
        hub.GracefulShutdown()
    }()

    return srv.ListenAndServe()
}
```

### Load Testing WebSocket Servers with k6

k6 has native WebSocket support. This script simulates 5,000 concurrent connections each sending messages every second for 60 seconds:

```javascript
// k6-websocket-load-test.js
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const msgsSent    = new Counter('ws_messages_sent');
const msgsReceived = new Counter('ws_messages_received');
const msgLatency  = new Trend('ws_message_latency_ms');

export const options = {
    stages: [
        { duration: '30s', target: 1000 },  // ramp up to 1K connections
        { duration: '30s', target: 5000 },  // ramp up to 5K connections
        { duration: '60s', target: 5000 },  // hold at 5K
        { duration: '30s', target: 0 },     // ramp down
    ],
    thresholds: {
        ws_message_latency_ms: ['p(95)<100'],  // 95th percentile under 100ms
        ws_messages_received:  ['count>10000'],
    },
};

export default function () {
    const userID = `user-${__VU}-${__ITER}`;
    const url = `ws://localhost:8080/ws?user_id=${userID}&channel=load-test`;

    const res = ws.connect(url, {}, function (socket) {
        socket.on('open', () => {
            // Send a ping message every second
            const interval = setInterval(() => {
                const sentAt = Date.now();
                socket.send(JSON.stringify({ type: 'ping', ts: sentAt, from: userID }));
                msgsSent.add(1);
            }, 1000);

            socket.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.ts) {
                        msgLatency.add(Date.now() - msg.ts);
                    }
                    msgsReceived.add(1);
                } catch (_) {}
            });

            socket.on('close', () => clearInterval(interval));
            socket.on('error', (e) => console.error('ws error:', e));

            // Hold connection open for the VU duration
            socket.setTimeout(() => socket.close(), 120000);
        });
    });

    check(res, { 'status is 101': (r) => r && r.status === 101 });
}
```

Run: `k6 run --out json=results.json k6-websocket-load-test.js`

Key metrics to watch during load test:
- `ws_message_latency_ms` p95 - should stay under 100ms at target load
- `go_goroutines` Prometheus metric - should be stable (2 per connection + hub overhead)
- `process_resident_memory_bytes` - watch for linear growth indicating leak
- Redis `pubsub_channels` and `pubsub_patterns` metrics - channel count growth

### Junior → FAANG: Sticky Sessions Versus Sessionless: The Tradeoff in One Sentence

Sticky sessions route every WebSocket connection from a given client to the same server instance. This simplifies in-process state (the server can store connection context in memory). Sessionless design allows any server to handle any message, which requires externalizing all connection-relevant state to a shared store (Redis). Sticky sessions are simpler to implement and harder to operate. Sessionless is harder to implement and simpler to operate, because load balancers can freely distribute connections and server failures only affect the clients connected to that server.

For a first job, understanding this tradeoff at the conceptual level is sufficient. In production systems, the operational simplicity of sessionless design usually wins for systems with more than a few servers, because sticky sessions create uneven load distribution (one server may accumulate more active users) and complicate rolling deployments (you cannot take a server out of rotation without disconnecting all its clients).

### Senior @ FAANG: Graceful Draining and the Rolling Deployment Contract

Graceful connection draining is the contract that makes zero-downtime rolling deployments possible for WebSocket servers. When a server receives `SIGTERM`, it must: stop accepting new connections (return 503 to new WebSocket upgrade requests), notify existing connections that a graceful close is in progress (send a close frame or a custom message that triggers client-side reconnection with backoff), wait for existing connections to close naturally or force-close them after a drain timeout, and then exit.

The engineering challenge is the drain timeout. If the timeout is too short, connections are forcibly terminated and clients experience a disconnect during the deployment. If the timeout is too long, the deployment pipeline stalls waiting for the server to drain. The right value depends on the product's connection lifetime distribution: a system where most connections are short-lived (under 30 seconds) can use a short drain timeout. A system where connections are persistent for hours (chat, collaborative editing) needs either a longer timeout or an active notification that sends clients a "please reconnect to a new server" message.

The infrastructure concern at L6: the load balancer must remove the draining server from the rotation before the drain starts, so new connection requests are not sent to a server that is about to exit. This requires health check integration: the draining server returns unhealthy on its health check endpoint so the load balancer stops routing to it, while continuing to serve existing connections until the drain is complete. Implementing this correctly requires understanding the load balancer's health check polling interval and the lag between an unhealthy response and actual traffic removal.

---
