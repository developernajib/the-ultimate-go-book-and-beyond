## 102H.2 Server-Sent Events (SSE) Implementation

### 2.1 SSE Server Implementation

Server-Sent Events use a long-lived HTTP response with `Content-Type: text/event-stream` to push data from server to browser over a standard HTTP connection. Unlike WebSockets, SSE is unidirectional, ideal for notifications, live dashboards, and log streaming, and benefits from automatic browser reconnection with `Last-Event-ID` replay. The `Broker` below manages per-topic subscriber sets using `sync.Map` and drops slow consumers rather than blocking the broadcast path.

```go
package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Event represents a Server-Sent Event.
type Event struct {
	ID      string          // Optional: event ID for reconnection.
	Type    string          // Optional: event type (default: "message").
	Data    json.RawMessage // Event data (JSON).
	Retry   int             // Optional: reconnection delay in ms.
}

// Bytes returns the SSE wire format for this event.
func (e Event) Bytes() []byte {
	var buf []byte
	if e.ID != "" {
		buf = append(buf, fmt.Sprintf("id: %s\n", e.ID)...)
	}
	if e.Type != "" && e.Type != "message" {
		buf = append(buf, fmt.Sprintf("event: %s\n", e.Type)...)
	}
	if e.Retry > 0 {
		buf = append(buf, fmt.Sprintf("retry: %d\n", e.Retry)...)
	}
	buf = append(buf, fmt.Sprintf("data: %s\n\n", e.Data)...)
	return buf
}

// Subscriber represents an SSE client connection.
type Subscriber struct {
	ID         string
	UserID     string
	Topics     map[string]struct{}
	events     chan Event
	lastEventID string
	done       chan struct{}
}

// Broker manages SSE subscribers and event distribution.
type Broker struct {
	subscribers sync.Map // subscriberID → *Subscriber
	topicSubs   sync.Map // topic → sync.Map[subscriberID → *Subscriber]

	totalSubs    atomic.Int64
	totalEvents  atomic.Uint64

	cfg BrokerConfig
}

// BrokerConfig holds SSE broker configuration.
type BrokerConfig struct {
	BufferSize      int
	KeepaliveInterval time.Duration
	ClientTimeout   time.Duration
}

func DefaultBrokerConfig() BrokerConfig {
	return BrokerConfig{
		BufferSize:        64,
		KeepaliveInterval: 25 * time.Second,
		ClientTimeout:     5 * time.Minute,
	}
}

func NewBroker(cfg BrokerConfig) *Broker {
	return &Broker{cfg: cfg}
}

// Subscribe creates a new SSE subscriber for the given topics.
func (b *Broker) Subscribe(ctx context.Context, subscriberID, userID string, topics []string) *Subscriber {
	sub := &Subscriber{
		ID:     subscriberID,
		UserID: userID,
		Topics: make(map[string]struct{}, len(topics)),
		events: make(chan Event, b.cfg.BufferSize),
		done:   make(chan struct{}),
	}
	for _, t := range topics {
		sub.Topics[t] = struct{}{}
	}

	b.subscribers.Store(subscriberID, sub)
	b.totalSubs.Add(1)

	for _, topic := range topics {
		topicVal, _ := b.topicSubs.LoadOrStore(topic, &sync.Map{})
		topicSubs := topicVal.(*sync.Map)
		topicSubs.Store(subscriberID, sub)
	}

	// Remove subscriber when context is done.
	go func() {
		select {
		case <-ctx.Done():
		case <-sub.done:
		}
		b.Unsubscribe(subscriberID)
	}()

	return sub
}

// Unsubscribe removes a subscriber.
func (b *Broker) Unsubscribe(subscriberID string) {
	val, ok := b.subscribers.LoadAndDelete(subscriberID)
	if !ok {
		return
	}
	sub := val.(*Subscriber)
	b.totalSubs.Add(-1)

	// Remove from topic indexes.
	for topic := range sub.Topics {
		if topicVal, ok := b.topicSubs.Load(topic); ok {
			topicVal.(*sync.Map).Delete(subscriberID)
		}
	}

	close(sub.done)
	close(sub.events)
}

// Publish sends an event to all subscribers of the given topic.
func (b *Broker) Publish(topic string, event Event) {
	topicVal, ok := b.topicSubs.Load(topic)
	if !ok {
		return
	}
	topicSubs := topicVal.(*sync.Map)
	b.totalEvents.Add(1)

	topicSubs.Range(func(key, val any) bool {
		sub := val.(*Subscriber)
		select {
		case sub.events <- event:
		default:
			// Subscriber is too slow - close it.
			go b.Unsubscribe(sub.ID)
		}
		return true
	})
}

// PublishToUser sends an event to all sessions of a specific user.
func (b *Broker) PublishToUser(userID string, event Event) {
	b.subscribers.Range(func(key, val any) bool {
		sub := val.(*Subscriber)
		if sub.UserID == userID {
			select {
			case sub.events <- event:
			default:
			}
		}
		return true
	})
}

// ServeSSE handles an SSE HTTP connection.
func (b *Broker) ServeSSE(sub *Subscriber, w http.ResponseWriter, r *http.Request) {
	// Set SSE headers.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering.

	// Get flusher for streaming responses.
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Send retry hint to client.
	fmt.Fprintf(w, "retry: 3000\n\n")
	flusher.Flush()

	// Send initial comment to establish connection.
	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	keepalive := time.NewTicker(b.cfg.KeepaliveInterval)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.done:
			return
		case event, ok := <-sub.events:
			if !ok {
				return
			}
			w.Write(event.Bytes())
			flusher.Flush()
		case <-keepalive.C:
			// SSE comment as keepalive (prevents proxy timeouts).
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// SSEHandler returns an HTTP handler for SSE connections.
func (b *Broker) SSEHandler(getUserID func(*http.Request) string, topics func(*http.Request) []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := getUserID(r)
		if userID == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		subTopics := topics(r)
		if len(subTopics) == 0 {
			http.Error(w, "no topics specified", http.StatusBadRequest)
			return
		}

		subID := fmt.Sprintf("%s-%d", userID, time.Now().UnixNano())
		sub := b.Subscribe(r.Context(), subID, userID, subTopics)
		b.ServeSSE(sub, w, r)
	}
}
```

### Junior → FAANG: SSE as the Underrated Protocol for Notification Use Cases

SSE has an undeserved reputation for being a "simpler but weaker WebSocket." It is not a weaker protocol. It is a protocol optimized for a specific and common use case: server-to-client event streams. For notification feeds, progress reporting, live data dashboards, and log streaming, SSE is often the better choice because it requires less implementation complexity on both ends, uses standard HTTP/2 multiplexing automatically, and provides browser-level reconnection via the `EventSource` API.

The habit to build early: when evaluating whether to use WebSocket or SSE, ask "does the client ever send data after the connection is established?" If the answer is no (the client only receives), SSE is the correct choice. If the answer is yes even occasionally, SSE can still work by combining SSE for server-to-client messages with regular HTTP POST requests for client-to-server messages. This hybrid is used in some production systems because it avoids the complexity of full WebSocket lifecycle management.

Interview entry point: explain `text/event-stream` format (data, event, id, retry fields), the `Last-Event-ID` header for reconnection with replay, and why SSE gets HTTP/2 multiplexing for free while WebSocket does not.

### Senior @ FAANG: SSE Delivery Guarantees and the Replay Buffer Design

SSE reconnection with `Last-Event-ID` provides at-least-once delivery from the browser's perspective: the browser sends the last event ID it received, and the server replays events from that point. But "at-least-once" only holds if the server actually maintains a replay buffer. Implementing the replay buffer correctly is where most SSE production systems fail.

The replay buffer design requires three decisions. First, what is the buffer scope: per-user, per-channel, or global? Per-user buffers are necessary if events are personalized. Per-channel buffers work for broadcast scenarios. Second, what is the storage backend: in-memory (fast but not durable), Redis (durable, survives process restart), or a message queue (durable, ordered, with consumer group semantics)? Redis Streams are the canonical choice because the stream ID is monotonically increasing and maps directly to the `Last-Event-ID` semantics. Third, what is the retention policy: time-based (keep events for 24 hours), count-based (keep the last 1,000 events), or size-based? The retention policy determines how far back a reconnecting client can recover.

The security dimension that is often missed: `Last-Event-ID` is client-controlled. A malicious client can send an arbitrary event ID to request replay from an arbitrary point in the stream. The server must validate that the requested event ID is within the allowed replay window and that the authenticated user is authorized to receive the replayed events. Omitting this validation allows replay of other users' events or replay beyond the retention window.

---
