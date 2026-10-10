## 102H.18 Production Hardening, Rate Limiting & Observability

### Connection Pooling and Per-Connection Rate Limiting

Unrestrained WebSocket connections can exhaust server file descriptors and memory, while misbehaving clients that flood messages can degrade service for everyone else. The `ConnectionPool` below uses a lock-free compare-and-swap counter to enforce a hard cap on concurrent connections, and the `HardenedClient` applies a token bucket rate limiter per connection, disconnecting any client that exceeds its message budget rather than queuing unbounded traffic.

```go
package hardening

import (
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

const (
	maxConnections     = 50000
	maxMsgPerSecond    = 50    // per connection
	maxMsgBurst        = 10
	maxMessageBytes    = 4096  // 4 KB per message
	writeWaitHardened  = 10 * time.Second
	pongWaitHardened   = 60 * time.Second
	pingPeriodHardened = 54 * time.Second
)

// ConnectionPool limits the total number of concurrent WebSocket connections.
type ConnectionPool struct {
	current atomic.Int64
	max     int64
}

func NewConnectionPool(max int64) *ConnectionPool {
	return &ConnectionPool{max: max}
}

func (p *ConnectionPool) Acquire() bool {
	for {
		cur := p.current.Load()
		if cur >= p.max {
			return false
		}
		if p.current.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func (p *ConnectionPool) Release() {
	p.current.Add(-1)
}

func (p *ConnectionPool) Active() int64 {
	return p.current.Load()
}

// HardenedClient wraps a WebSocket connection with production safety features.
type HardenedClient struct {
	conn      *websocket.Conn
	send      chan []byte
	limiter   *rate.Limiter
	pool      *ConnectionPool
	closeOnce sync.Once
	closed    chan struct{}
	userID    string
}

func NewHardenedClient(conn *websocket.Conn, pool *ConnectionPool, userID string) *HardenedClient {
	return &HardenedClient{
		conn:    conn,
		send:    make(chan []byte, 256),
		limiter: rate.NewLimiter(rate.Limit(maxMsgPerSecond), maxMsgBurst),
		pool:    pool,
		closed:  make(chan struct{}),
		userID:  userID,
	}
}

func (c *HardenedClient) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
		c.conn.Close()
		c.pool.Release()
	})
}

func (c *HardenedClient) readPump(onMessage func([]byte)) {
	defer c.Close()

	c.conn.SetReadLimit(maxMessageBytes)
	c.conn.SetReadDeadline(time.Now().Add(pongWaitHardened))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWaitHardened))
		return nil
	})

	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws unexpected close user=%s: %v", c.userID, err)
			}
			return
		}

		// Rate limit incoming messages.
		if !c.limiter.Allow() {
			log.Printf("rate limit exceeded user=%s - disconnecting", c.userID)
			c.conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(1008, "rate limit exceeded"),
				time.Now().Add(writeWaitHardened),
			)
			return
		}

		onMessage(msg)
	}
}

func (c *HardenedClient) writePump() {
	ticker := time.NewTicker(pingPeriodHardened)
	defer func() {
		ticker.Stop()
		c.Close()
	}()

	for {
		select {
		case <-c.closed:
			return

		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWaitHardened))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("ws write error user=%s: %v", c.userID, err)
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWaitHardened))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("ws ping error user=%s: %v", c.userID, err)
				return
			}
		}
	}
}

// ServeHardened is a production-ready WebSocket handler.
func ServeHardened(pool *ConnectionPool, upgrader websocket.Upgrader, onMessage func(userID string, msg []byte)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check connection pool limit before upgrading.
		if !pool.Acquire() {
			http.Error(w, "server at capacity", http.StatusServiceUnavailable)
			return
		}

		userID := r.Header.Get("X-User-ID")
		if userID == "" {
			pool.Release()
			http.Error(w, "X-User-ID header required", http.StatusBadRequest)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			pool.Release()
			log.Printf("upgrade error: %v", err)
			return
		}

		client := NewHardenedClient(conn, pool, userID)
		go client.writePump()
		client.readPump(func(msg []byte) {
			onMessage(userID, msg)
		})
	}
}
```

### Metrics: Active Connections, Messages/sec, Latency Histogram

Observability is essential for diagnosing real-time systems under load. The `RTMetrics` type below exposes atomic counters for connections and message throughput, along with a fixed-width latency histogram that buckets end-to-end processing times from sub-millisecond to over 500ms. All counters are published via Go's `expvar` endpoint so they can be scraped by Prometheus or read directly from `/debug/vars` without adding a dependency.

```go
package metrics

import (
	"expvar"
	"net/http"
	"sync/atomic"
	"time"
)

// RTMetrics tracks real-time connection and message metrics.
type RTMetrics struct {
	ActiveConnections atomic.Int64
	TotalConnections  atomic.Int64
	MessagesReceived  atomic.Int64
	MessagesSent      atomic.Int64
	Errors            atomic.Int64

	// Latency histogram buckets (ms): <1, <5, <10, <50, <100, <500, >=500
	latencyBuckets [7]atomic.Int64
}

var Global = &RTMetrics{}

func init() {
	// Expose metrics via expvar (accessible at /debug/vars).
	expvar.Publish("ws_active_connections", expvar.Func(func() any {
		return Global.ActiveConnections.Load()
	}))
	expvar.Publish("ws_total_connections", expvar.Func(func() any {
		return Global.TotalConnections.Load()
	}))
	expvar.Publish("ws_messages_received", expvar.Func(func() any {
		return Global.MessagesReceived.Load()
	}))
	expvar.Publish("ws_messages_sent", expvar.Func(func() any {
		return Global.MessagesSent.Load()
	}))
	expvar.Publish("ws_errors", expvar.Func(func() any {
		return Global.Errors.Load()
	}))
}

func (m *RTMetrics) RecordLatency(d time.Duration) {
	ms := d.Milliseconds()
	switch {
	case ms < 1:
		m.latencyBuckets[0].Add(1)
	case ms < 5:
		m.latencyBuckets[1].Add(1)
	case ms < 10:
		m.latencyBuckets[2].Add(1)
	case ms < 50:
		m.latencyBuckets[3].Add(1)
	case ms < 100:
		m.latencyBuckets[4].Add(1)
	case ms < 500:
		m.latencyBuckets[5].Add(1)
	default:
		m.latencyBuckets[6].Add(1)
	}
}

func (m *RTMetrics) LatencyHistogram() map[string]int64 {
	labels := []string{"<1ms", "<5ms", "<10ms", "<50ms", "<100ms", "<500ms", ">=500ms"}
	result := make(map[string]int64, len(labels))
	for i, label := range labels {
		result[label] = m.latencyBuckets[i].Load()
	}
	return result
}

// MetricsHandler returns an HTTP handler that reports all metrics as JSON.
func MetricsHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		http.DefaultServeMux.ServeHTTP(w, r) // delegates to expvar handler
	}
}

// Instrument wraps message handling to record latency.
func Instrument(handler func([]byte)) func([]byte) {
	return func(msg []byte) {
		start := time.Now()
		Global.MessagesReceived.Add(1)
		handler(msg)
		Global.RecordLatency(time.Since(start))
	}
}
```

### Graceful Shutdown with Prometheus Integration

For production systems using Prometheus, expose metrics in the standard format. The variables below use `promauto` to self-register on the default Prometheus registry so they are automatically included in `/metrics` scrapes without manual registration calls.

```go
package prommetrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"time"
)

var (
	ActiveConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "websocket_active_connections",
		Help: "Number of currently active WebSocket connections.",
	})

	ConnectionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "websocket_connections_total",
		Help: "Total WebSocket connections, labeled by outcome.",
	}, []string{"outcome"}) // outcome: accepted, rejected, error

	MessagesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "websocket_messages_total",
		Help: "Total messages, labeled by direction.",
	}, []string{"direction"}) // direction: inbound, outbound

	MessageLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "websocket_message_latency_seconds",
		Help:    "End-to-end message latency in seconds.",
		Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0},
	})

	RoomSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "websocket_room_size",
		Help: "Number of clients in each room.",
	}, []string{"room"})
)

// RecordMessage records an inbound message and its processing latency.
func RecordMessage(direction string, processTime time.Duration) {
	MessagesTotal.WithLabelValues(direction).Inc()
	if direction == "inbound" {
		MessageLatency.Observe(processTime.Seconds())
	}
}
```

### Junior → FAANG: Production Hardening as Defense in Depth

Production hardening for WebSocket servers follows a defense-in-depth model: multiple layers of protection, each catching what the previous layer misses. Connection limit (`http.Server.MaxHeaderBytes`, custom connection counter) prevents resource exhaustion from too many connections. Per-connection rate limiting (token bucket) prevents a single client from monopolizing server resources. `SetReadLimit` prevents a malicious client from sending an arbitrarily large message that exhausts memory. Write deadlines prevent a slow client from blocking the writer goroutine indefinitely.

The habit to build: treat each of these controls as a required checklist item for any WebSocket handler you ship, not as optional performance tuning. A WebSocket server without these controls is not a "simple" server. It is a server with known denial-of-service vulnerabilities.

For interviews: if asked "what would you do to harden a WebSocket server for production?", list these controls in order of importance: connection limit, per-connection rate limit, read size limit, write deadline, and graceful shutdown with drain. This demonstrates that you think about WebSocket servers as a security surface, not just a communication mechanism.

### Senior @ FAANG: Production Hardening Policies as Platform Contracts

At FAANG scale, production hardening controls are platform-level policies, not per-service configurations. The connection tier enforces a maximum connections-per-server limit. The platform SDK enforces per-connection rate limiting with a standard algorithm (token bucket with documented parameters). The platform enforces `SetReadLimit` at the library level so individual services cannot omit it. Write deadlines are enforced by the platform's WebSocket wrapper, not by individual service code.

This policy-at-the-platform-layer approach solves a common organizational problem: if hardening is optional, services that are not under immediate attack will skip it to save development time, and then become the attack vector when a motivated adversary scans for unprotected endpoints. Mandatory platform-level controls eliminate the "we'll add it later" failure mode.

The security review process for new real-time features at L6+ should include: connection limit verification (what is the maximum client count this feature adds, and does it fit within the platform connection budget?), rate limit review (what is the expected message rate, and is the token bucket sized appropriately for both normal and abuse cases?), and authorization audit (who is allowed to subscribe to which channels, and is that enforced at the connection level or only at the message level?).

---
