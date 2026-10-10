## Section 4: WebSocket and Server-Sent Events

WebSocket and SSE fill the gap that gRPC and REST cannot address cleanly: bidirectional and server-push communication with browser clients. gRPC-Web exists but has limitations, and WebSocket is the universal real-time primitive for the browser.

### 4.1 WebSocket Handler

After the upgrade, both ends communicate by sending and receiving typed messages over the persistent connection. Message types (`TextMessage`, `BinaryMessage`, `PingMessage`) determine how the peer interprets the payload.

```go
package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Message is the envelope for all WebSocket messages.
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Hub manages all active WebSocket connections.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]*Client // key: userID
	events  EventBus
}

type Client struct {
	userID string
	conn   *websocket.Conn
	send   chan Message
	done   chan struct{}
}

type EventBus interface {
	Subscribe(userID string) (<-chan Message, func())
}

func NewHub(events EventBus) *Hub {
	return &Hub{
		clients: make(map[string]*Client),
		events:  events,
	}
}

// ServeHTTP upgrades the HTTP connection to WebSocket and manages the lifecycle.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		http.Error(w, "X-User-ID header required", http.StatusUnauthorized)
		return
	}

	// Accept the WebSocket connection. AcceptOptions control compression and
	// origin validation - always restrict OriginPatterns in production.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: false, // validate Origin header
		CompressionMode:    websocket.CompressionContextTakeover,
	})
	if err != nil {
		slog.Error("websocket accept", "error", err, "user", userID)
		return
	}

	client := &Client{
		userID: userID,
		conn:   conn,
		send:   make(chan Message, 32),
		done:   make(chan struct{}),
	}

	h.register(client)
	defer h.unregister(client)

	ctx := r.Context()

	// Subscribe to server-side events for this user.
	eventCh, unsub := h.events.Subscribe(userID)
	defer unsub()

	// Write pump: forward events and queued messages to the client.
	go func() {
		for {
			select {
			case msg := <-client.send:
				writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := wsjson.Write(writeCtx, conn, msg)
				cancel()
				if err != nil {
					return
				}
			case msg, ok := <-eventCh:
				if !ok {
					return
				}
				writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := wsjson.Write(writeCtx, conn, msg)
				cancel()
				if err != nil {
					return
				}
			case <-client.done:
				return
			}
		}
	}()

	// Read pump: handle incoming messages from the client.
	for {
		var msg Message
		if err := wsjson.Read(ctx, conn, &msg); err != nil {
			var closeErr websocket.CloseError
			if errors.As(err, &closeErr) {
				slog.Info("websocket closed", "user", userID, "code", closeErr.Code)
			} else {
				slog.Error("websocket read", "error", err, "user", userID)
			}
			close(client.done)
			return
		}
		h.handleClientMessage(ctx, client, msg)
	}
}

func (h *Hub) handleClientMessage(ctx context.Context, c *Client, msg Message) {
	switch msg.Type {
	case "ping":
		c.send <- Message{Type: "pong"}
	case "subscribe":
		// Handle subscription requests from the client.
		slog.Info("client subscribe", "user", c.userID, "payload", string(msg.Payload))
	default:
		slog.Warn("unknown message type", "type", msg.Type, "user", c.userID)
	}
}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c.userID] = c
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if existing, ok := h.clients[c.userID]; ok && existing == c {
		delete(h.clients, c.userID)
		c.conn.Close(websocket.StatusNormalClosure, "session ended")
	}
}

// Broadcast sends a message to all connected clients.
func (h *Hub) Broadcast(msg Message) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		select {
		case c.send <- msg:
		default:
			// Client's send buffer is full - drop or close.
			slog.Warn("client send buffer full, dropping", "user", c.userID)
		}
	}
}
```

### 4.2 Server-Sent Events (SSE)

SSE is strictly server→client, works over plain HTTP/1.1, and reconnects automatically in browsers. Use it when clients only need to receive events, not send them.

```go
package sse

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// Event represents a single SSE event.
type Event struct {
	ID    string // optional - enables Last-Event-ID for replay
	Event string // optional - event type name
	Data  any    // serialized as JSON
}

// EventSource manages an SSE stream for one HTTP connection.
type EventSource struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

// NewEventSource sets up SSE headers and returns a writer helper.
// Returns nil if the ResponseWriter does not support flushing.
func NewEventSource(w http.ResponseWriter) (*EventSource, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return nil, false
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering
	w.WriteHeader(http.StatusOK)

	return &EventSource{w: w, flusher: flusher}, true
}

// Send writes one SSE event to the wire and flushes immediately.
func (es *EventSource) Send(e Event) error {
	if e.ID != "" {
		fmt.Fprintf(es.w, "id: %s\n", e.ID)
	}
	if e.Event != "" {
		fmt.Fprintf(es.w, "event: %s\n", e.Event)
	}

	data, err := json.Marshal(e.Data)
	if err != nil {
		return fmt.Errorf("marshal event data: %w", err)
	}
	fmt.Fprintf(es.w, "data: %s\n\n", data)
	es.flusher.Flush()
	return nil
}

// SendKeepAlive sends a comment line to prevent proxy timeouts.
func (es *EventSource) SendKeepAlive() {
	fmt.Fprintf(es.w, ": keep-alive\n\n")
	es.flusher.Flush()
}

// SSEHandler is an example handler that streams order events.
func SSEHandler(events EventBus) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID := r.URL.Query().Get("order_id")
		if orderID == "" {
			http.Error(w, "order_id required", http.StatusBadRequest)
			return
		}

		es, ok := NewEventSource(w)
		if !ok {
			return
		}

		ctx := r.Context()
		eventCh, unsub := events.Subscribe(orderID)
		defer unsub()

		// Send keep-alive every 15s so proxies don't close the connection.
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		// Replay last known event ID if the client reconnected.
		if lastID := r.Header.Get("Last-Event-ID"); lastID != "" {
			slog.Info("SSE reconnect", "order", orderID, "last_event", lastID)
			// TODO: replay events since lastID from durable store
		}

		for {
			select {
			case <-ctx.Done():
				return

			case <-ticker.C:
				es.SendKeepAlive()

			case msg, ok := <-eventCh:
				if !ok {
					return
				}
				if err := es.Send(Event{
					ID:    fmt.Sprintf("%d", time.Now().UnixNano()),
					Event: msg.Type,
					Data:  msg.Payload,
				}); err != nil {
					slog.Error("SSE send", "error", err, "order", orderID)
					return
				}
			}
		}
	}
}

type EventBus interface {
	Subscribe(key string) (<-chan struct {
		Type    string
		Payload any
	}, func())
}
```

### 4.3 WebSocket vs SSE vs gRPC Streaming Decision Guide

Choosing among the three real-time transports is a function of who the client is and which direction the data flows. Browsers want SSE for pure server-push (auto-reconnect, HTTP/1.1, proxy-friendly), WebSocket for full-duplex interactive traffic (chat, collab editing, gaming), and gRPC streaming only when the backend already speaks gRPC and you can ship a Connect or gRPC-Web shim. Service-to-service always prefers gRPC streaming for the schema, typed codegen, and HTTP/2 multiplexing.

```
┌─────────────────────────────────────────────────────────────────────┐
│              Real-Time Communication Selection                      │
│                                                                     │
│  Requirement                     Best Choice                        │
│  ──────────────────────────────  ───────────                        │
│  Browser client, server-push     SSE                                │
│  Browser client, bidirectional   WebSocket                          │
│  Service-to-service streaming    gRPC streaming                     │
│  Mobile app real-time updates    gRPC streaming or WebSocket        │
│  Reconnect / replay support      SSE (Last-Event-ID)                │
│  Chat, gaming, live collab       WebSocket                          │
│  Stock tickers, notifications    SSE                                │
│  Proxy/firewall constrained      SSE (plain HTTP/1.1)               │
│  Binary payload, high throughput gRPC streaming                     │
│                                                                     │
│  Key differences:                                                   │
│  SSE:       HTTP/1.1 compatible, auto-reconnect, text only          │
│  WebSocket: Full-duplex, binary/text, manual reconnect              │
│  gRPC:      HTTP/2, typed schema, service-to-service only           │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: First-Job Habits for WebSocket and SSE Implementation

The most common junior mistake with WebSocket is running both read and write operations in the same goroutine. The `coder/websocket` library (formerly `nhooyr.io/websocket`) permits one reader goroutine and one writer goroutine to run concurrently, and the pattern in the example uses exactly that: a dedicated write pump goroutine handles all sends, and the main goroutine handles all reads. This prevents the send channel from blocking the read loop, which would cause the connection to appear stale from the server's perspective when the client is sending a burst of messages.

For SSE, the critical first-job concept is understanding why `Flush()` must be called after every event. HTTP responses are normally buffered: the server collects bytes until the buffer fills or the response completes, then sends them in one burst. SSE requires each event to be sent immediately. Without `Flush()`, events accumulate in the buffer and the client sees nothing until the buffer fills, defeating the purpose of server-sent events entirely.

The `X-Accel-Buffering: no` header in the SSE implementation is easy to overlook and causes subtle production bugs. Nginx, by default, buffers upstream responses before sending them to clients. An SSE stream from a Go server passing through nginx without this header will appear completely stuck from the browser's perspective. The header disables nginx buffering for that specific response.

For FAANG interviews, if asked about real-time architectures, demonstrate that you understand connection lifecycle: how long-lived connections drain gracefully on shutdown, how you prevent goroutine leaks when clients disconnect, and how you handle the back-pressure case where the client's receive buffer is full.

### Senior @ FAANG: Scaling WebSocket and SSE to Millions of Connections

Scaling stateful long-lived connections is a fundamentally different problem from scaling stateless HTTP request handling. A REST API behind a load balancer is trivially horizontally scalable: add more servers, the load balancer distributes requests, done. WebSocket and SSE connections are stateful: the event subscription for a user's session exists in one server process's memory. When a backend server restarts, all connections to that server drop.

The standard production architecture for large-scale SSE and WebSocket at FAANG level is a pub/sub fanout layer between the event producers and the connection servers. Producers (order service, notification service, etc.) publish events to a message bus: Redis Streams, NATS, Kafka, or Pub/Sub depending on durability requirements. Connection servers subscribe to topics relevant to their connected clients and forward matching events. A connection server restart drops its subscriptions, reconnects to the bus, and resumes. The client reconnects to any available connection server (routing is sticky at the L4 load balancer level, but any server can serve any client because state is in the bus, not the server).

The `Last-Event-ID` mechanism in SSE is the durability bridge between client reconnects and the event bus. When a client reconnects after a network blip, it sends the ID of the last event it received. The connection server queries the event bus for all events after that ID within the retention window and replays them before resuming live streaming. This requires the event bus to retain events for at least as long as the maximum reconnect window you guarantee to clients. For an order notification system, a 24-hour retention window is typical.

At Google scale, the connection server tier itself becomes a platform product: a fleet of servers that handle the WebSocket or SSE protocol, subscribe to internal event buses, and manage connection lifecycle, provided as a managed service to product teams. Individual teams define which events to push to which users, while the platform handles the connection multiplexing, auth, reconnect, and drain. This is the L7 thinking: instead of every team reimplementing WebSocket infrastructure, the platform builds it once correctly.
