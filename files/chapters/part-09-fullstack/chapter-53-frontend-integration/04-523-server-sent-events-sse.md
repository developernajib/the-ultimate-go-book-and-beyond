## 53.3 Server-Sent Events (SSE)

Server-Sent Events provide a lightweight, one-way push channel from server to browser using a plain HTTP response that never closes. Unlike WebSockets, SSE reuses standard HTTP infrastructure, works through most proxies, and reconnects automatically on the client side. The pattern is ideal for read-only feeds (live metrics, notification streams, audit logs) where bidirectional messaging is unnecessary overhead.

```go
// pkg/sse/server.go
package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Event represents an SSE event
type Event struct {
	ID    string
	Type  string
	Data  any
	Retry int // milliseconds
}

// Client represents an SSE client
type Client struct {
	ID       string
	UserID   string
	Channel  chan *Event
	Channels map[string]bool // subscribed channels
}

// Server manages SSE connections
type Server struct {
	clients    map[*Client]bool
	channels   map[string]map[*Client]bool
	register   chan *Client
	unregister chan *Client
	broadcast  chan *channelEvent
	logger     *slog.Logger
	mu         sync.RWMutex
}

type channelEvent struct {
	channel string
	event   *Event
}

// NewServer creates a new SSE server
func NewServer(logger *slog.Logger) *Server {
	return &Server{
		clients:    make(map[*Client]bool),
		channels:   make(map[string]map[*Client]bool),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan *channelEvent, 256),
		logger:     logger,
	}
}

// Run starts the SSE server
func (s *Server) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return

		case client := <-s.register:
			s.mu.Lock()
			s.clients[client] = true
			s.mu.Unlock()

			s.logger.Info("SSE client connected",
				"client_id", client.ID,
				"user_id", client.UserID,
			)

		case client := <-s.unregister:
			s.mu.Lock()
			if _, ok := s.clients[client]; ok {
				delete(s.clients, client)

				// Remove from all channels
				for channel := range client.Channels {
					if clients, ok := s.channels[channel]; ok {
						delete(clients, client)
						if len(clients) == 0 {
							delete(s.channels, channel)
						}
					}
				}

				close(client.Channel)
			}
			s.mu.Unlock()

			s.logger.Info("SSE client disconnected",
				"client_id", client.ID,
			)

		case ce := <-s.broadcast:
			s.mu.RLock()
			if clients, ok := s.channels[ce.channel]; ok {
				for client := range clients {
					select {
					case client.Channel <- ce.event:
					default:
						// Client buffer full, skip
					}
				}
			}
			s.mu.RUnlock()
		}
	}
}

// HandleConnection handles a new SSE connection
func (s *Server) HandleConnection(w http.ResponseWriter, r *http.Request) {
	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

	// Get channels from query params
	channels := r.URL.Query()["channel"]

	// Get user ID from context
	userID := getUserIDFromContext(r.Context())

	client := &Client{
		ID:       fmt.Sprintf("sse_%d", time.Now().UnixNano()),
		UserID:   userID,
		Channel:  make(chan *Event, 64),
		Channels: make(map[string]bool),
	}

	// Subscribe to channels
	s.mu.Lock()
	for _, channel := range channels {
		if _, ok := s.channels[channel]; !ok {
			s.channels[channel] = make(map[*Client]bool)
		}
		s.channels[channel][client] = true
		client.Channels[channel] = true
	}
	s.mu.Unlock()

	s.register <- client

	// Get flusher for streaming
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	// Send initial connection event
	fmt.Fprintf(w, "event: connected\ndata: {\"client_id\":\"%s\"}\n\n", client.ID)
	flusher.Flush()

	// Heartbeat ticker
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	// Listen for events
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			s.unregister <- client
			return

		case event, ok := <-client.Channel:
			if !ok {
				return
			}

			data, err := json.Marshal(event.Data)
			if err != nil {
				continue
			}

			if event.ID != "" {
				fmt.Fprintf(w, "id: %s\n", event.ID)
			}
			if event.Type != "" {
				fmt.Fprintf(w, "event: %s\n", event.Type)
			}
			if event.Retry > 0 {
				fmt.Fprintf(w, "retry: %d\n", event.Retry)
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()

		case <-heartbeat.C:
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}

// Publish sends an event to a channel
func (s *Server) Publish(channel, eventType string, data any) {
	event := &Event{
		ID:   fmt.Sprintf("%d", time.Now().UnixNano()),
		Type: eventType,
		Data: data,
	}

	s.broadcast <- &channelEvent{
		channel: channel,
		event:   event,
	}
}

// PublishToUser sends an event to a specific user
func (s *Server) PublishToUser(userID, eventType string, data any) {
	event := &Event{
		ID:   fmt.Sprintf("%d", time.Now().UnixNano()),
		Type: eventType,
		Data: data,
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	for client := range s.clients {
		if client.UserID == userID {
			select {
			case client.Channel <- event:
			default:
			}
		}
	}
}

// Subscribe adds a client to a channel
func (s *Server) Subscribe(client *Client, channel string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.channels[channel]; !ok {
		s.channels[channel] = make(map[*Client]bool)
	}
	s.channels[channel][client] = true
	client.Channels[channel] = true
}

// Unsubscribe removes a client from a channel
func (s *Server) Unsubscribe(client *Client, channel string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if clients, ok := s.channels[channel]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(s.channels, channel)
		}
	}
	delete(client.Channels, channel)
}

func getUserIDFromContext(ctx context.Context) string {
	if userID, ok := ctx.Value("user_id").(string); ok {
		return userID
	}
	return ""
}
```

### Junior -> FAANG: Why SSE Over WebSocket for Read-Only Streams

The decision between SSE and WebSocket is often made by default (WebSocket because it sounds more powerful) rather than by deliberate trade-off analysis. SSE is a better default for server-to-client-only streams because it is HTTP. It works through every proxy that handles HTTP/1.1 or HTTP/2. It reconnects automatically without any client-side code. The browser sends the `Last-Event-ID` header on reconnect so the server can replay missed events. None of these properties require any extra work from the client developer.

WebSocket requires: a connection upgrade negotiation (one extra round trip), explicit client-side reconnection logic, explicit heartbeat/ping handling to detect dead connections, and a custom framing protocol for everything. WebSocket is the right choice when the client must also send data to the server at high frequency (gaming, collaborative editing, cursor sync). For dashboards, notifications, audit logs, and progress streams, SSE is almost always the better choice.

The first interview-level habit is to recognize the HTTP/1.1 connection limit problem (six per domain) and immediately follow it with the solution: use HTTP/2 for SSE. HTTP/2 multiplexes all SSE streams over a single TCP connection, eliminating the limit entirely. Mention `X-Accel-Buffering: no` as the nginx directive that prevents nginx from buffering SSE responses, which would delay event delivery unpredictably.

### Senior @ FAANG: SSE Durability, Resumption, and Multi-Region Delivery

**Event durability and the `Last-Event-ID` contract.** The `Publish` method in this section assigns a nanosecond Unix timestamp as the event ID. This is a weak ID for resumption because: (1) two events published in rapid succession on the same process can share a timestamp, (2) clocks are not monotonic across pod restarts, and (3) there is no persistence of events between the client's disconnect and reconnect. A production resumption system needs a persistent event log (Redis Stream, Postgres sequence column, or Kafka offset) and a query path that returns events newer than the `Last-Event-ID` the client sends on reconnect. Design this as a separate `getEventsSince(userID string, lastID string) ([]Event, error)` interface so the SSE handler is decoupled from the storage implementation.

**ADR: how long to retain events for resumption.** A client that was offline for two hours should not receive two hours of events on reconnect, especially for a dashboard notification feed where older events are irrelevant. Define a retention window (for example, 5 minutes for real-time dashboards, 24 hours for audit notification feeds) as an explicit product decision and document it. Implement it as a parameter on the `getEventsSince` query, not as an afterthought. Clients that reconnect outside the retention window receive a special `event: replay-unavailable` event so they can refresh their full state from a REST endpoint instead.

**Channel fan-out at scale.** The `broadcast` channel in this section is a single goroutine processing events one at a time. At high event volume (tens of thousands of events per second across all channels), this goroutine becomes a bottleneck. The first optimization is to shard the server into N goroutines by channel hash, so events for different channels are processed concurrently. The second is to move to a pull model: instead of the server pushing to each client's channel, each client goroutine polls a shared ring buffer for events newer than its last-seen position. The pull model eliminates the per-client channel allocation and simplifies backpressure handling because a slow client simply reads from the ring buffer later without blocking the producer.

**Multi-region SSE and the sticky-session problem.** SSE connections are long-lived (minutes to hours). A rolling deploy or pod autoscale event disrupts all active SSE connections simultaneously, causing a reconnection storm. Mitigation: use a graceful drain signal that sends a `retry: 30000\nevent: reconnect\ndata: drain\n\n` event to all clients before pod shutdown. Clients see the `reconnect` event, interpret the `retry` as a suggestion to wait 30 seconds before reconnecting, and spread their reconnections over 30 seconds instead of all hitting the new pods in the first second.

In a multi-region deployment, an SSE client connected to a Go pod in `us-west-2` cannot receive events published by a service in `ap-southeast-1` unless there is a cross-region event bus. The correct platform architecture is: publishers write events to a global event bus (Kafka with cross-region replication, or a managed service like Google Pub/Sub or AWS EventBridge), and each regional SSE server subscribes to that bus. Regional SSE servers deliver only events relevant to their local clients by filtering on `userID` or channel name at the subscription level.

**Observability signals specific to SSE.** Monitor: active SSE connection count per pod (alert if below expected minimum, indicating connection drain after a deploy), event delivery latency from `Publish` call to `flusher.Flush` completion, heartbeat miss rate (a client that stops receiving heartbeats has a broken connection that the server has not detected yet), and reconnection rate (a spike indicates a mass disconnect from a deploy, network event, or server-side error). These four metrics give you full visibility into SSE health without reading logs.

---
