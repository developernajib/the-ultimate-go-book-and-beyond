## 102P.2 Server-Sent Events (SSE)

SSE is ideal for server-to-client push: notifications, live feeds, progress updates. Unlike WebSockets, SSE travels over a plain HTTP response with `Content-Type: text/event-stream`, meaning it works through any HTTP proxy or CDN without special protocol negotiation. The implementation below uses a fan-out `Broker` that maintains a registry of per-client channels, drops messages to slow consumers rather than blocking the broadcast path, and supports the `Last-Event-ID` header so clients that reconnect after a network interruption resume from where they left off.

```go
package sse

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Event is an SSE event
type Event struct {
	ID    string      `json:"id,omitempty"`
	Event string      `json:"event,omitempty"`
	Data  any `json:"data"`
	Retry int         `json:"retry,omitempty"` // reconnect interval in ms
}

func (e Event) Format() string {
	var sb strings.Builder
	if e.ID != "" {
		fmt.Fprintf(&sb, "id: %s\n", e.ID)
	}
	if e.Event != "" {
		fmt.Fprintf(&sb, "event: %s\n", e.Event)
	}
	if e.Retry > 0 {
		fmt.Fprintf(&sb, "retry: %d\n", e.Retry)
	}

	var dataStr string
	switch d := e.Data.(type) {
	case string:
		dataStr = d
	case []byte:
		dataStr = string(d)
	default:
		b, _ := json.Marshal(d)
		dataStr = string(b)
	}

	// Multi-line data: each line needs "data: " prefix
	for _, line := range strings.Split(dataStr, "\n") {
		fmt.Fprintf(&sb, "data: %s\n", line)
	}
	sb.WriteByte('\n') // blank line terminates event
	return sb.String()
}

// Broker manages SSE subscribers
type Broker struct {
	subscribers map[string]map[chan Event]bool // topic → channels
	mu          sync.RWMutex
	newSubs     chan subscription
	closeSubs   chan subscription
	events      chan topicEvent
}

type subscription struct {
	topic string
	ch    chan Event
}

type topicEvent struct {
	topic string
	event Event
}

func NewBroker() *Broker {
	b := &Broker{
		subscribers: make(map[string]map[chan Event]bool),
		newSubs:     make(chan subscription, 64),
		closeSubs:   make(chan subscription, 64),
		events:      make(chan topicEvent, 256),
	}
	go b.run()
	return b
}

func (b *Broker) run() {
	for {
		select {
		case sub := <-b.newSubs:
			if b.subscribers[sub.topic] == nil {
				b.subscribers[sub.topic] = make(map[chan Event]bool)
			}
			b.subscribers[sub.topic][sub.ch] = true

		case sub := <-b.closeSubs:
			if subs, ok := b.subscribers[sub.topic]; ok {
				delete(subs, sub.ch)
				close(sub.ch)
				if len(subs) == 0 {
					delete(b.subscribers, sub.topic)
				}
			}

		case te := <-b.events:
			for ch := range b.subscribers[te.topic] {
				select {
				case ch <- te.event:
				default:
					// Slow subscriber: drop event (or use buffered channel)
				}
			}
		}
	}
}

// Publish publishes an event to all subscribers of a topic
func (b *Broker) Publish(topic string, event Event) {
	b.events <- topicEvent{topic: topic, event: event}
}

// Subscribe returns a channel that receives events for a topic
func (b *Broker) Subscribe(topic string) chan Event {
	ch := make(chan Event, 32)
	b.newSubs <- subscription{topic: topic, ch: ch}
	return ch
}

// Unsubscribe removes a subscription
func (b *Broker) Unsubscribe(topic string, ch chan Event) {
	b.closeSubs <- subscription{topic: topic, ch: ch}
}

// ServeSSE handles an SSE HTTP connection
func (b *Broker) ServeSSE(topic string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Set SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("X-Accel-Buffering", "no") // disable Nginx buffering

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// Subscribe to topic
		ch := b.Subscribe(topic)
		defer b.Unsubscribe(topic, ch)

		// Send initial heartbeat
		fmt.Fprintf(w, ": connected\nretry: 5000\n\n")
		flusher.Flush()

		// Heartbeat ticker to keep connection alive through proxies
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				return

			case event, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprint(w, event.Format())
				flusher.Flush()

			case <-ticker.C:
				fmt.Fprintf(w, ": heartbeat\n\n")
				flusher.Flush()
			}
		}
	}
}

// Example: live stock ticker
func LiveStockTicker(broker *Broker) {
	symbols := []string{"AAPL", "GOOGL", "MSFT", "AMZN"}
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0))

	prices := map[string]float64{
		"AAPL": 185.0, "GOOGL": 140.0, "MSFT": 375.0, "AMZN": 175.0,
	}

	ticker := time.NewTicker(1 * time.Second)
	go func() {
		for range ticker.C {
			for _, sym := range symbols {
				change := (rng.Float64() - 0.5) * 2 // -1 to +1
				prices[sym] += change
				broker.Publish("stocks", Event{
					Event: "quote",
					ID:    fmt.Sprintf("%s-%d", sym, time.Now().UnixMilli()),
					Data: map[string]any{
						"symbol": sym,
						"price":  math.Round(prices[sym]*100) / 100,
						"change": math.Round(change*100) / 100,
					},
				})
			}
		}
	}()
}
```

### Junior → FAANG: The Broker Pattern for SSE Fan-Out

The Broker pattern in this section solves the core SSE engineering problem: how does an event published to the system reach all N connected clients efficiently? The naive approach is a shared slice of channels that is locked on every publish. The Broker pattern uses a dedicated goroutine that owns the registry and serializes all register/unregister/publish operations through channels, eliminating lock contention.

The "drop messages to slow consumers" policy is important to understand: if a slow client's channel is full and the broker blocks waiting to send, the entire broadcast is delayed for all other clients. Dropping the message for the slow client and continuing the broadcast is the correct production behavior. The slow client may miss one event, but all other clients receive it on time. A separate monitoring system tracks the slow consumer drop rate.

Interview entry point: describe the Broker pattern as a central goroutine that owns the client registry and serializes all operations through channels. Explain why blocking on slow consumers is unacceptable for a broadcast system.

### Senior @ FAANG: SSE Broker Scalability and the Hand-Off to Redis

The in-process SSE broker works for a single server instance. When you add a second instance, events published on instance A do not reach clients connected to instance B. The scaling solution parallels the WebSocket case: Redis pub/sub as the cross-instance message backplane. Each broker instance subscribes to the channels relevant to its connected clients. An event publisher publishes to Redis, and each broker instance receives the event and delivers it to its local clients.

The `Last-Event-ID` replay mechanism requires a shared event store accessible from all instances. Redis Streams are the natural fit: each event is stored in the stream with a monotonically increasing ID, and reconnecting clients provide their last received ID to replay missed events from any instance. The replay window (how many events to keep in the stream) must be configured based on the expected disconnect duration: if clients can be offline for up to 5 minutes and the event rate is 100 events per second, the stream must retain at least 30,000 events.

At FAANG scale, the SSE broker's fan-out capacity becomes the binding constraint. A single Redis pub/sub channel with 10,000 subscribers requires Redis to deliver 10,000 copies of every message. The hierarchical fan-out pattern (described in the WebSocket section) applies equally here: a small number of broker processes receive from Redis and fan out locally to many connected clients.

---
