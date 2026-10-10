## 55.4 WebSocket Hub Implementation

The WebSocket hub serializes all connection lifecycle events (registrations, unregistrations, and broadcasts) through a single goroutine's `select` loop, avoiding the need for fine-grained locking on the client map during fan-out. This is the same pattern used by the Gorilla WebSocket chat example and scales well to tens of thousands of connections per process. The hub tracks per-channel subscriptions so broadcasts target only interested clients, and a periodic ticker detects stale connections that failed to send a pong within the configured timeout.

```go
// backend/internal/websocket/hub.go
package websocket

import (
    "context"
    "encoding/json"
    "log/slog"
    "sync"
    "time"

    "github.com/gorilla/websocket"
    "dashboard/internal/observability"
)

// Message types for WebSocket communication
type MessageType string

const (
    MessageTypeSubscribe   MessageType = "subscribe"
    MessageTypeUnsubscribe MessageType = "unsubscribe"
    MessageTypeMetrics     MessageType = "metrics"
    MessageTypePing        MessageType = "ping"
    MessageTypePong        MessageType = "pong"
    MessageTypeError       MessageType = "error"
)

// Message represents a WebSocket message
type Message struct {
    Type      MessageType     `json:"type"`
    Channel   string          `json:"channel,omitempty"`
    Payload   json.RawMessage `json:"payload,omitempty"`
    Timestamp time.Time       `json:"timestamp"`
}

// Client represents a single WebSocket connection
type Client struct {
    ID           string
    Hub          *Hub
    Conn         *websocket.Conn
    Send         chan []byte
    Channels     map[string]bool
    mu           sync.RWMutex
    lastActivity time.Time
}

// Hub maintains active clients and broadcasts messages
type Hub struct {
    // Registered clients
    clients map[*Client]bool

    // Channel subscriptions: channel -> clients
    channels map[string]map[*Client]bool

    // Inbound messages from clients
    broadcast chan []byte

    // Register requests from clients
    register chan *Client

    // Unregister requests from clients
    unregister chan *Client

    // Metrics for observability
    metrics *observability.DashboardMetrics

    // Synchronization
    mu sync.RWMutex

    // Configuration
    maxClients int
    logger     *slog.Logger
}

// NewHub creates a new Hub instance
func NewHub(metrics *observability.DashboardMetrics, maxClients int, logger *slog.Logger) *Hub {
    return &Hub{
        clients:    make(map[*Client]bool),
        channels:   make(map[string]map[*Client]bool),
        broadcast:  make(chan []byte, 256),
        register:   make(chan *Client),
        unregister: make(chan *Client),
        metrics:    metrics,
        maxClients: maxClients,
        logger:     logger,
    }
}

// Run starts the hub's main loop
func (h *Hub) Run(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            h.shutdown()
            return

        case client := <-h.register:
            h.registerClient(client)

        case client := <-h.unregister:
            h.unregisterClient(client)

        case message := <-h.broadcast:
            h.broadcastMessage(message)

        case <-ticker.C:
            h.updateMetrics()
            h.cleanupStaleClients()
        }
    }
}

func (h *Hub) registerClient(client *Client) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if len(h.clients) >= h.maxClients {
        h.logger.Warn("max clients reached, rejecting connection",
            "current", len(h.clients),
            "max", h.maxClients,
        )
        close(client.Send)
        return
    }

    h.clients[client] = true
    h.metrics.WSConnectionsActive.Inc()
    h.metrics.WSConnectionsTotal.Inc()

    h.logger.Info("client registered",
        "client_id", client.ID,
        "total_clients", len(h.clients),
    )
}

func (h *Hub) unregisterClient(client *Client) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if _, ok := h.clients[client]; ok {
        delete(h.clients, client)
        close(client.Send)
        h.metrics.WSConnectionsActive.Dec()

        // Remove from all channels
        for channel := range client.Channels {
            if clients, ok := h.channels[channel]; ok {
                delete(clients, client)
                if len(clients) == 0 {
                    delete(h.channels, channel)
                }
            }
        }

        h.logger.Info("client unregistered",
            "client_id", client.ID,
            "total_clients", len(h.clients),
        )
    }
}

// Subscribe adds a client to a channel
func (h *Hub) Subscribe(client *Client, channel string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if _, ok := h.channels[channel]; !ok {
        h.channels[channel] = make(map[*Client]bool)
    }
    h.channels[channel][client] = true

    client.mu.Lock()
    client.Channels[channel] = true
    client.mu.Unlock()

    h.logger.Debug("client subscribed to channel",
        "client_id", client.ID,
        "channel", channel,
    )
}

// Unsubscribe removes a client from a channel
func (h *Hub) Unsubscribe(client *Client, channel string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if clients, ok := h.channels[channel]; ok {
        delete(clients, client)
        if len(clients) == 0 {
            delete(h.channels, channel)
        }
    }

    client.mu.Lock()
    delete(client.Channels, channel)
    client.mu.Unlock()
}

// BroadcastToChannel sends a message to all clients subscribed to a channel
func (h *Hub) BroadcastToChannel(channel string, msg Message) {
    h.mu.RLock()
    clients, ok := h.channels[channel]
    if !ok {
        h.mu.RUnlock()
        return
    }
    // Copy client list to avoid holding lock during send
    clientList := make([]*Client, 0, len(clients))
    for client := range clients {
        clientList = append(clientList, client)
    }
    h.mu.RUnlock()

    data, err := json.Marshal(msg)
    if err != nil {
        h.logger.Error("failed to marshal message", "error", err)
        return
    }

    for _, client := range clientList {
        select {
        case client.Send <- data:
            h.metrics.WSMessagesSent.WithLabelValues(string(msg.Type)).Inc()
        default:
            // Client's buffer is full, close connection
            h.unregister <- client
        }
    }
}

func (h *Hub) broadcastMessage(message []byte) {
    h.mu.RLock()
    defer h.mu.RUnlock()

    for client := range h.clients {
        select {
        case client.Send <- message:
        default:
            close(client.Send)
            delete(h.clients, client)
        }
    }
}

func (h *Hub) updateMetrics() {
    h.mu.RLock()
    defer h.mu.RUnlock()

    h.metrics.ActiveDashboards.Set(float64(len(h.channels)))
}

func (h *Hub) cleanupStaleClients() {
    h.mu.Lock()
    defer h.mu.Unlock()

    staleThreshold := time.Now().Add(-5 * time.Minute)
    for client := range h.clients {
        if client.lastActivity.Before(staleThreshold) {
            h.logger.Info("removing stale client", "client_id", client.ID)
            delete(h.clients, client)
            close(client.Send)
        }
    }
}

func (h *Hub) shutdown() {
    h.mu.Lock()
    defer h.mu.Unlock()

    for client := range h.clients {
        close(client.Send)
    }
    h.clients = make(map[*Client]bool)
    h.channels = make(map[string]map[*Client]bool)
}

// ClientCount returns current number of connected clients
func (h *Hub) ClientCount() int {
    h.mu.RLock()
    defer h.mu.RUnlock()
    return len(h.clients)
}

// ChannelCount returns current number of active channels
func (h *Hub) ChannelCount() int {
    h.mu.RLock()
    defer h.mu.RUnlock()
    return len(h.channels)
}
```

---

### Junior -> FAANG: Understanding the Hub Pattern and Its Limits

The hub's single goroutine `select` loop is the most important design choice in this file. Before you can explain why it is correct, you need to understand what it prevents: concurrent writes to the `clients` map from multiple goroutines would cause a data race without the hub serializing them.

A common first-job mistake is reaching for a mutex everywhere without thinking about whether a single-goroutine design would be simpler. The hub avoids the `RWMutex` on the `clients` map during the broadcast loop by using channels to serialize mutations. This means `broadcastMessage` can iterate over `h.clients` without holding a lock, because the only goroutine that modifies `h.clients` is the hub's own `Run` loop.

Notice the asymmetry: `BroadcastToChannel` holds a read lock to snapshot the client list, then drops the lock before sending. This is correct because it uses the copy, not the live map, during the send. `broadcastMessage` does not hold a lock at all, which is safe only because it runs inside the hub's `select` loop goroutine, which is the only goroutine that writes to `h.clients`. If you cannot explain this distinction in an interview, practice it.

First-job habit: when you see a `default` branch in a channel `select`, ask what gets dropped and whether the drop is logged. In `BroadcastToChannel`, a full buffer causes the client to be unregistered. That is a policy choice. Different systems make different choices here (drop message, close connection, queue on overflow). Know which choice your codebase makes.

### Senior @ FAANG: Hub Scalability Limits and the Multi-Node Fan-out Problem

The hub implementation here is correct and production-ready for a single-node deployment. The L6/L7 concern is what happens when the process cannot hold all connections.

**Per-process capacity ceiling:** The hub's `maxClients` field enforces a hard ceiling. The question a staff engineer asks is: what is the right value for this ceiling, and how is it calculated? The answer depends on three variables: the write buffer size per client (`WSWriteBufferSize`), the goroutine stack size for the read pump per client (approximately 8KB initial, growing as needed), and the message rate (higher rate means the write goroutine is scheduled more frequently, consuming more CPU). At 256-byte write buffers and 1KB goroutine stacks, 50,000 connections cost roughly 65MB for buffers and another 50MB for stacks, plus GC overhead. At 4KB write buffers, the same 50,000 connections cost 200MB+ just for buffers. The ceiling is a function of available memory and acceptable GC pressure, not an arbitrary round number.

**The `cleanupStaleClients` race:** There is a subtle issue in `cleanupStaleClients`: it acquires a write lock and iterates over `h.clients` while deleting entries. Deleting from a Go map while ranging over it is safe in Go, but the write lock means no other hub operation can proceed during cleanup. For a hub with 50,000 connections and a 5-minute stale threshold, cleanup runs every 30 seconds and checks every connection. At 50k entries with cheap checks, this is still fast. But if cleanup is extended with more expensive operations (network pings, database lookups), the lock duration grows and broadcast latency spikes. The correct fix is to build a separate stale-connection candidate list in the read phase, drop the lock, and then individually unregister each candidate through the normal `unregister` channel.

**The unregister channel deadlock risk:** In `BroadcastToChannel`, a full client buffer sends to `h.unregister`. But `h.unregister` is an unbuffered channel. If the hub's `Run` goroutine is blocked on a long `broadcastMessage` call, sending to `h.unregister` will block too. Under sustained fan-out to many slow clients, multiple goroutines could pile up trying to send to `h.unregister`, each holding a reference to the slow client. The fix is to make `h.unregister` buffered or to use a separate goroutine for cleanup. This is a latent bug that surfaces only under load, exactly the kind of issue a bar-raiser looks for when reviewing WebSocket hub designs.

**Cross-node fan-out as a platform decision:** The hub only serves clients connected to the same process. Horizontal scaling requires publishing to a shared bus (Redis Pub/Sub, NATS, or Kafka) and having each hub subscribe. The platform decision is which bus to use and what delivery guarantees it provides. Redis Pub/Sub is at-most-once (a message published during a Redis failover may be lost). NATS JetStream provides at-least-once with persistence. Kafka provides ordered, durable delivery with replay. For a live dashboard where missing one tick of CPU data is acceptable, Redis Pub/Sub is the right tradeoff. For a financial dashboard where missing an alert is not acceptable, NATS JetStream or Kafka is required. A staff engineer documents this decision in an ADR so that future teams building on the platform understand why the bus was chosen and when they need to deviate.
