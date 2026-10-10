## 52G.1 AMQP Protocol Fundamentals

### AMQP 0-9-1 vs AMQP 1.0

AMQP exists in two incompatible versions. RabbitMQ implements **AMQP 0-9-1** (the de facto industry standard), while Azure Service Bus and ActiveMQ Artemis use **AMQP 1.0** (the OASIS standard). They are not wire-compatible.

Key AMQP 0-9-1 concepts:
- **Connection**: A single TCP connection to the broker. Expensive to establish (TLS handshake, auth). Share per process.
- **Channel**: A lightweight virtual connection multiplexed over one TCP connection. Channels are not goroutine-safe - use one channel per goroutine or serialize access.
- **Virtual Host (vhost)**: Namespace isolation. Each vhost has its own exchanges, queues, bindings, and permissions. Use separate vhosts for staging/production.
- **Frame Types**: Method frames (RPC commands), Header frames (message properties), Body frames (payload), Heartbeat frames.
- **Heartbeats**: TCP keepalive at the AMQP level. Default 60 seconds. Essential for detecting dead connections through firewalls/load balancers that drop idle TCP.

### Go Connection Setup

Establishing a resilient AMQP connection in Go requires handling both the initial dial and automatic reconnection on channel or connection errors. The following code wraps `amqp.Dial` with exponential backoff, channel recreation logic, and a health-check goroutine that monitors the connection's `NotifyClose` channel.

```go
package rabbitmq

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Config holds RabbitMQ connection configuration.
type Config struct {
	URL       string        // amqp://user:pass@host:5672/vhost
	TLSConfig *tls.Config   // nil for plain AMQP
	Heartbeat time.Duration // recommended: 10s
	Locale    string        // "en_US"
}

// DefaultConfig returns production-ready defaults.
func DefaultConfig(url string) Config {
	return Config{
		URL:       url,
		Heartbeat: 10 * time.Second,
		Locale:    "en_US",
	}
}

// Connect establishes a connection with proper configuration.
// Returns the connection - caller is responsible for closing.
func Connect(cfg Config) (*amqp.Connection, error) {
	dialConfig := amqp.Config{
		Heartbeat: cfg.Heartbeat,
		Locale:    cfg.Locale,
		TLSClientConfig: cfg.TLSConfig,
	}

	var conn *amqp.Connection
	var err error

	if cfg.TLSConfig != nil {
		conn, err = amqp.DialTLS(cfg.URL, cfg.TLSConfig)
	} else {
		conn, err = amqp.DialConfig(cfg.URL, dialConfig)
	}
	if err != nil {
		return nil, fmt.Errorf("rabbitmq: dial %s: %w", cfg.URL, err)
	}

	slog.Info("rabbitmq: connected",
		"url", cfg.URL,
		"heartbeat", cfg.Heartbeat,
	)
	return conn, nil
}
```

### Channel Multiplexing and the Channel Pool Pattern

Channels are cheap to create but are **not goroutine-safe**. A common anti-pattern is sharing one channel across goroutines without a mutex. The production pattern is a **channel pool**:

```go
package rabbitmq

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ChannelPool manages a pool of AMQP channels over a single connection.
// Channels are returned to the pool after use, avoiding creation overhead.
type ChannelPool struct {
	conn     *amqp.Connection
	pool     chan *amqp.Channel
	mu       sync.Mutex
	maxSize  int
	logger   *slog.Logger
}

// NewChannelPool creates a pool with capacity maxSize.
func NewChannelPool(conn *amqp.Connection, maxSize int, logger *slog.Logger) (*ChannelPool, error) {
	p := &ChannelPool{
		conn:    conn,
		pool:    make(chan *amqp.Channel, maxSize),
		maxSize: maxSize,
		logger:  logger,
	}

	// Pre-warm a few channels.
	for i := 0; i < min(maxSize/2, 4); i++ {
		ch, err := conn.Channel()
		if err != nil {
			return nil, fmt.Errorf("channel pool: create initial channel: %w", err)
		}
		p.pool <- ch
	}

	return p, nil
}

// Acquire gets a channel from the pool or creates a new one.
func (p *ChannelPool) Acquire(ctx context.Context) (*amqp.Channel, error) {
	select {
	case ch := <-p.pool:
		// Verify channel is still open.
		if ch.IsClosed() {
			p.logger.Warn("channel pool: discarding closed channel, creating new")
			return p.conn.Channel()
		}
		return ch, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		// Pool empty; create new channel up to maxSize.
		return p.conn.Channel()
	}
}

// Release returns a channel to the pool. If the channel is closed, it is discarded.
func (p *ChannelPool) Release(ch *amqp.Channel) {
	if ch == nil || ch.IsClosed() {
		return
	}
	select {
	case p.pool <- ch:
	default:
		// Pool full; close the excess channel.
		_ = ch.Close()
	}
}

// Close drains and closes all channels in the pool.
func (p *ChannelPool) Close() {
	close(p.pool)
	for ch := range p.pool {
		_ = ch.Close()
	}
}
```

### Junior → FAANG: AMQP Fundamentals You Must Know Cold

The AMQP protocol fundamentals section contains four concepts that appear in almost every RabbitMQ interview. You need to know them without hesitation.

**Connection vs channel (the most common interview question):**

A connection is one TCP socket. Establishing it involves a TCP handshake, TLS negotiation, and AMQP capability exchange. It costs tens of milliseconds. A channel is a numbered virtual stream multiplexed over that TCP socket. Opening a channel costs microseconds. You share one connection across your process and open one channel per goroutine. Sharing a channel across goroutines is a protocol error because AMQP frames from concurrent goroutines interleave and corrupt the stream.

**Virtual hosts for environment isolation:**

In your first job, you will likely see a single vhost `/` for everything. This is a red flag. The correct pattern is separate vhosts for production, staging, and development environments. A consumer bug in staging that floods a queue should not trigger memory alarms in production. Vhosts provide this isolation at zero cost since they share the underlying Erlang process.

**Heartbeats are not optional:**

Firewalls between your Go service and the RabbitMQ broker have idle connection timeouts, often 60 to 90 seconds. Without AMQP heartbeats, a connection that has no traffic for 90 seconds is silently dropped by the firewall. Your Go service continues to think the connection is alive, publishes succeed at the channel level, and messages disappear. Setting `Heartbeat: 10 * time.Second` means the broker and client exchange heartbeat frames every 10 seconds, keeping the connection alive and detecting true failures within 20 seconds.

**The channel pool pattern in Go:**

The pool in the code above solves a real concurrency problem. Without it, each goroutine either shares a channel (race condition) or creates and destroys channels per operation (resource exhaustion). The pool gives each goroutine exclusive access to a channel for the duration of one operation, then returns it. Verify the channel is not closed before returning it from `Acquire` because a channel error closes the channel permanently and you must not reuse it.

### Senior @ FAANG: Protocol Depth and Operational Consequences

At the senior level, understanding the AMQP protocol is not just about using it correctly. It is about diagnosing production failures by reading protocol traces and designing systems that degrade gracefully when the protocol behaves unexpectedly.

**Channel closure as a failure mode:**

In production, channels close for reasons that are not network failures. A common trigger is declaring a queue with arguments that differ from an existing declaration. The broker responds with `PRECONDITION_FAILED` and closes the channel. The `amqp091-go` library does not transparently reopen the channel. The consuming goroutine's delivery channel becomes closed, the `ok` flag in the select loop turns false, and if the goroutine does not handle this case, it exits silently. The fix is always to check `ok` on delivery channel reads and treat a closed delivery channel as a signal to rebuild the entire channel and consumer registration, not just to log and return.

**Frame type awareness for debugging:**

Production debugging of RabbitMQ issues often requires reading broker logs at the frame level. The four AMQP frame types serve distinct purposes. Method frames carry the RPC commands (Publish, Consume, Ack). Header frames carry the message properties (content type, delivery mode, TTL, priority). Body frames carry the payload in chunks up to the negotiated frame max size. Heartbeat frames carry no payload. When you see a message that is published successfully but has no delivery mode set, the broker still accepts it but treats it as transient, which means a broker restart loses it despite the queue being durable.

**Channel pool sizing and connection lifecycle:**

The channel pool size should be bounded by the number of concurrent goroutines that need to publish, not by the number of messages per second. If you have 20 publishing goroutines, a pool of 20-30 channels is sufficient. Larger pools waste Erlang process memory on the broker. The pool must also handle the case where the underlying connection dies. When `conn.Channel()` returns an error because the connection is closed, the pool must signal all waiting goroutines and block new acquisitions until a new connection is established. The code above does not handle this case explicitly, which is the right place to extend it in production.

**ADR: when to use channel pools vs one-channel-per-goroutine:**

The channel pool pattern makes sense when the number of goroutines is large and variable, such as in an HTTP handler that also publishes to RabbitMQ per request. In this case, creating a channel per request handler is prohibitive. When the number of goroutines is small and fixed, such as a worker pool of exactly 10 goroutines, the simpler pattern is one dedicated channel per goroutine with no pool. The pool adds complexity that is only justified by variable concurrency. Document this choice in an ADR so future engineers do not add pool complexity to fixed-concurrency scenarios.

---
