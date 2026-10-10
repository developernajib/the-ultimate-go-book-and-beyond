## 102H.16 Server-Sent Events Deep Dive & HTTP/2 Multiplexing

### Full SSE Implementation with Last-Event-ID and Reconnection

The browser's `EventSource` API automatically reconnects and sends the `Last-Event-ID` header with the last received event ID. A production SSE server must honor this for seamless reconnection.

```go
package sse

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Event represents a single SSE event.
type Event struct {
	ID      int64
	Type    string // empty = "message"
	Data    string
	Retry   int // reconnect interval hint in ms (0 = don't send)
}

func (e Event) Write(w http.ResponseWriter) {
	if e.ID > 0 {
		fmt.Fprintf(w, "id: %d\n", e.ID)
	}
	if e.Type != "" {
		fmt.Fprintf(w, "event: %s\n", e.Type)
	}
	if e.Retry > 0 {
		fmt.Fprintf(w, "retry: %d\n", e.Retry)
	}
	fmt.Fprintf(w, "data: %s\n\n", e.Data)
}

// EventBuffer holds the last N events for replay on reconnect.
type EventBuffer struct {
	mu     sync.RWMutex
	events []Event
	size   int
	seq    atomic.Int64
}

func NewEventBuffer(size int) *EventBuffer {
	return &EventBuffer{
		events: make([]Event, 0, size),
		size:   size,
	}
}

func (b *EventBuffer) Push(eventType, data string) Event {
	id := b.seq.Add(1)
	e := Event{ID: id, Type: eventType, Data: data}

	b.mu.Lock()
	b.events = append(b.events, e)
	if len(b.events) > b.size {
		b.events = b.events[len(b.events)-b.size:]
	}
	b.mu.Unlock()
	return e
}

// Since returns all events with ID > lastID. Used for reconnect replay.
func (b *EventBuffer) Since(lastID int64) []Event {
	b.mu.RLock()
	defer b.mu.RUnlock()

	var result []Event
	for _, e := range b.events {
		if e.ID > lastID {
			result = append(result, e)
		}
	}
	return result
}

// Room manages SSE subscribers for a single room.
type Room struct {
	mu          sync.RWMutex
	subscribers map[chan Event]struct{}
	buffer      *EventBuffer
}

func NewRoom(bufferSize int) *Room {
	return &Room{
		subscribers: make(map[chan Event]struct{}),
		buffer:      NewEventBuffer(bufferSize),
	}
}

func (r *Room) Subscribe() chan Event {
	ch := make(chan Event, 64)
	r.mu.Lock()
	r.subscribers[ch] = struct{}{}
	r.mu.Unlock()
	return ch
}

func (r *Room) Unsubscribe(ch chan Event) {
	r.mu.Lock()
	delete(r.subscribers, ch)
	r.mu.Unlock()
	close(ch)
}

// Publish stores the event and fans out to all local subscribers.
func (r *Room) Publish(eventType, data string) Event {
	e := r.buffer.Push(eventType, data)

	r.mu.RLock()
	subscribers := make([]chan Event, 0, len(r.subscribers))
	for ch := range r.subscribers {
		subscribers = append(subscribers, ch)
	}
	r.mu.RUnlock()

	for _, ch := range subscribers {
		select {
		case ch <- e:
		default:
			// Slow consumer: drop event (they'll replay on reconnect).
			log.Printf("sse: slow consumer dropped event id=%d", e.ID)
		}
	}
	return e
}

// SSEHub manages multiple rooms.
type SSEHub struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

func NewSSEHub() *SSEHub {
	return &SSEHub{rooms: make(map[string]*Room)}
}

func (h *SSEHub) Room(name string) *Room {
	h.mu.RLock()
	r, ok := h.rooms[name]
	h.mu.RUnlock()
	if ok {
		return r
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	// Double-check after acquiring write lock.
	if r, ok = h.rooms[name]; ok {
		return r
	}
	r = NewRoom(500) // buffer last 500 events per room
	h.rooms[name] = r
	return r
}

// ServeSSE handles an SSE connection, replaying missed events on reconnect.
func (h *SSEHub) ServeSSE(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		http.Error(w, "room required", http.StatusBadRequest)
		return
	}

	// Parse Last-Event-ID for reconnect replay.
	var lastID int64
	if raw := r.Header.Get("Last-Event-ID"); raw != "" {
		if id, err := strconv.ParseInt(raw, 10, 64); err == nil {
			lastID = id
		}
	}

	// Required SSE headers.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	room := h.Room(roomName)

	// Replay missed events before subscribing.
	if lastID > 0 {
		for _, e := range room.buffer.Since(lastID) {
			e.Write(w)
		}
		flusher.Flush()
	}

	// Send retry hint to client: reconnect after 3 seconds.
	fmt.Fprintf(w, "retry: 3000\n\n")
	flusher.Flush()

	ch := room.Subscribe()
	defer room.Unsubscribe(ch)

	// Keepalive ticker (comment prevents proxies from closing idle connections).
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok {
				return
			}
			e.Write(w)
			flusher.Flush()
		case <-keepalive.C:
			// SSE comment as keepalive - EventSource ignores it.
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}
```

### Event Types in SSE

SSE supports named event types. The browser `EventSource` API routes them to specific listeners:

```go
// Server side - typed events:
room.Publish("user_joined", `{"user":"alice","room":"general"}`)
room.Publish("message",     `{"text":"hello","user":"alice"}`)
room.Publish("user_left",   `{"user":"alice"}`)

// Client side (JavaScript):
// const es = new EventSource('/events?room=general');
// es.addEventListener('user_joined', e => console.log('joined:', JSON.parse(e.data))) - // es.addEventListener('message',     e => console.log('msg:',    JSON.parse(e.data))) - // es.addEventListener('user_left',   e => console.log('left:',   JSON.parse(e.data))) - // es.onmessage = e => console.log('default:', e.data) - // catches events with no type
```

### SSE over HTTP/2 (Multiplexed Streams)

HTTP/2 multiplexes multiple streams over a single TCP connection. This eliminates the browser's 6-connection-per-origin limit, making SSE significantly more scalable:

```go
package sse

import (
	"crypto/tls"
	"golang.org/x/net/http2"
	"log"
	"net/http"
)

func runHTTP2SSEServer(hub *SSEHub) {
	mux := http.NewServeMux()
	mux.HandleFunc("/events", hub.ServeSSE)
	mux.HandleFunc("/publish", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		room := r.URL.Query().Get("room")
		eventType := r.URL.Query().Get("type")
		if room == "" || eventType == "" {
			http.Error(w, "room and type required", http.StatusBadRequest)
			return
		}
		defer r.Body.Close()
		var buf [4096]byte
		n, _ := r.Body.Read(buf[:])
		hub.Room(room).Publish(eventType, string(buf[:n]))
		w.WriteHeader(http.StatusNoContent)
	})

	srv := &http.Server{
		Addr:    ":8443",
		Handler: mux,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}

	// Enable HTTP/2 - requires TLS in production.
	if err := http2.ConfigureServer(srv, &http2.Server{
		MaxConcurrentStreams: 1000,
	}); err != nil {
		log.Fatalf("http2 config error: %v", err)
	}

	log.Println("HTTP/2 SSE server on :8443")
	log.Fatal(srv.ListenAndServeTLS("server.crt", "server.key"))
}
```

**HTTP/2 benefits for SSE:**
- Browser can open hundreds of SSE connections (each is one HTTP/2 stream over one TCP connection)
- Eliminates the 6-connection-per-origin limit of HTTP/1.1
- Server push can pre-send initial state before the client subscribes
- Lower overhead per connection (header compression via HPACK)

### SSE vs WebSocket Decision Framework

```
                    ┌─────────────────────────────────────┐
                    │   Do you need client → server msgs? │
                    └──────────┬──────────────────────────┘
                               │
               ┌───────────────┼───────────────┐
               │ No            │               │ Yes
               ▼               │               ▼
   ┌───────────────────────┐   │   ┌───────────────────────┐
   │ Is HTTP/2 available?  │   │   │ Need binary frames?   │
   └──────────┬────────────┘   │   └──────────┬────────────┘
              │                │              │
     ┌────────┴────────┐       │   ┌──────────┴──────────┐
     │ Yes       No    │       │   │ Yes            No   │
     ▼           ▼    │       │   ▼                ▼    │
   SSE/H2      SSE   │       │ WebSocket   ┌─────────┐  │
   (optimal) (H1.1)  │       │             │Sub-10ms │  │
                      │       │             │latency? │  │
                      │       │             └────┬────┘  │
                      │       │                  │        │
                      │       │         ┌────────┴────┐  │
                      │       │         │Yes      No  │  │
                      │       │         ▼          ▼  │  │
                      │       │      WebSocket    SSE  │  │
                      └───────┴──────────────────────-┘
```

**Choose SSE when:** live feeds, notifications, server logs, dashboards, progress updates, CI/CD output streaming.

**Choose WebSocket when:** chat, collaborative editing, multiplayer games, financial trading UIs, remote desktop/terminal.

### Junior → FAANG: SSE Implementation Details That Distinguish Correct from Incorrect

Three implementation details make the difference between a correct SSE implementation and one that breaks under real-world conditions. First, the `X-Accel-Buffering: no` header (for Nginx) and `Cache-Control: no-cache` header must be set, or proxies may buffer the event stream and delay delivery by seconds. Second, `http.Flusher` must be called after every event write. Without it, Go's buffered response writer batches events and clients receive them in delayed bursts. Third, the client context must be monitored so that the server goroutine exits promptly when the client disconnects, rather than continuing to produce events into a channel that nobody is reading.

Practice implementing SSE from scratch, including the `Last-Event-ID` replay, and verify it with `curl -N` and a browser `EventSource`. The `-N` flag disables curl's buffering and lets you see events as they arrive.

### Senior @ FAANG: SSE in Production: Proxy Configuration, HTTP/2, and Scale

SSE over HTTP/1.1 consumes one TCP connection per client. Over HTTP/2, multiple SSE streams can multiplex over a single TCP connection from a browser's perspective, but each server-side SSE handler still holds one goroutine and one response writer. At 100K concurrent clients, the goroutine and file descriptor cost is the same whether HTTP/1.1 or HTTP/2 is used.

The proxy configuration problem is particularly acute in enterprise environments. Corporate HTTP proxies often buffer all response bodies and only deliver them when the connection closes. SSE's design (an open-ended HTTP response body) means corporate proxies may buffer all events until the connection is closed, defeating the real-time delivery model entirely. The solution is TLS (proxies generally do not buffer HTTPS responses) and the `X-Accel-Buffering: no` header for Nginx-based proxies. Document this as a known operational constraint for any SSE-based product that targets enterprise customers.

At FAANG scale, SSE is often replaced by WebSocket even for unidirectional use cases, because the operational tooling (connection draining, load balancer support, proxy configuration) is better established for WebSocket. The decision to use SSE in production should include an operational assessment of the proxy and load balancer environment, not just a feature comparison.

---
