## 52H.1 NATS Core - Pub/Sub, Request/Reply, Queue Groups

NATS core is a lightweight, in-memory publish-subscribe system. It follows a fire-and-forget model: if no subscriber is listening when a message is published, the message is gone. This at-most-once semantics makes NATS core ideal for telemetry, heartbeats, and RPC patterns where occasional loss is acceptable.

### Subject Hierarchy

NATS subjects use dot notation for hierarchy. Two wildcards exist:

- `*` - matches exactly one token: `orders.*.created` matches `orders.us.created` but not `orders.us.east.created`
- `>` - matches one or more tokens (must be last): `orders.>` matches `orders.us.created`, `orders.eu.updated`, etc.

**Naming convention**: `service.verb.noun` - e.g., `payments.process.request`, `users.created.event`, `inventory.update.sku123`

```go
// file: internal/nats/core/client.go
package natsclient

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// Config holds NATS connection configuration.
type Config struct {
	URLs          []string
	Username      string
	Password      string
	TLSCert       string
	TLSKey        string
	TLSCA         string
	MaxReconnects int
	ReconnectWait time.Duration
}

// Client wraps a NATS connection with structured logging and lifecycle management.
type Client struct {
	conn   *nats.Conn
	logger *slog.Logger
}

// NewClient establishes a NATS connection with production-grade options.
func NewClient(cfg Config, logger *slog.Logger) (*Client, error) {
	opts := []nats.Option{
		nats.Name("go-service"),
		nats.MaxReconnects(cfg.MaxReconnects),
		nats.ReconnectWait(cfg.ReconnectWait),

		// Drain before disconnect - allows in-flight messages to complete.
		nats.DrainTimeout(30 * time.Second),

		// Reconnect handler - log reconnections for alerting.
		nats.ReconnectHandler(func(nc *nats.Conn) {
			logger.Warn("nats reconnected",
				slog.String("url", nc.ConnectedUrl()),
				slog.Int("reconnects", int(nc.Stats().Reconnects)),
			)
		}),

		// Disconnect handler.
		nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
			if err != nil {
				logger.Error("nats disconnected", slog.String("error", err.Error()))
			}
		}),

		// Closed handler - connection is permanently closed.
		nats.ClosedHandler(func(nc *nats.Conn) {
			logger.Info("nats connection closed")
		}),

		// Error handler for async errors (slow consumer, etc.).
		nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
			logger.Error("nats async error",
				slog.String("subject", sub.Subject),
				slog.String("error", err.Error()),
			)
		}),
	}

	if cfg.Username != "" {
		opts = append(opts, nats.UserInfo(cfg.Username, cfg.Password))
	}

	if cfg.TLSCert != "" {
		opts = append(opts, nats.ClientCert(cfg.TLSCert, cfg.TLSKey))
		opts = append(opts, nats.RootCAs(cfg.TLSCA))
	}

	url := nats.DefaultURL
	if len(cfg.URLs) > 0 {
		url = fmt.Sprintf("nats://%s", cfg.URLs[0])
		for _, u := range cfg.URLs[1:] {
			url += fmt.Sprintf(",nats://%s", u)
		}
	}

	conn, err := nats.Connect(url, opts...)
	if err != nil {
		return nil, fmt.Errorf("connecting to nats: %w", err)
	}

	logger.Info("nats connected",
		slog.String("url", conn.ConnectedUrl()),
		slog.String("server_id", conn.ConnectedServerId()),
	)

	return &Client{conn: conn, logger: logger}, nil
}

// Publish sends a message to the given subject (fire-and-forget).
func (c *Client) Publish(subject string, data []byte) error {
	if err := c.conn.Publish(subject, data); err != nil {
		return fmt.Errorf("publish to %s: %w", subject, err)
	}
	return nil
}

// Subscribe creates a subscription. The handler is called for each message.
func (c *Client) Subscribe(subject string, handler nats.MsgHandler) (*nats.Subscription, error) {
	sub, err := c.conn.Subscribe(subject, handler)
	if err != nil {
		return nil, fmt.Errorf("subscribe to %s: %w", subject, err)
	}
	c.logger.Info("subscribed", slog.String("subject", subject))
	return sub, nil
}

// QueueSubscribe registers a queue group subscriber.
// Only ONE subscriber in the same queue group receives each message.
func (c *Client) QueueSubscribe(subject, queue string, handler nats.MsgHandler) (*nats.Subscription, error) {
	sub, err := c.conn.QueueSubscribe(subject, queue, handler)
	if err != nil {
		return nil, fmt.Errorf("queue subscribe %s/%s: %w", subject, queue, err)
	}
	c.logger.Info("queue subscribed",
		slog.String("subject", subject),
		slog.String("queue", queue),
	)
	return sub, nil
}

// Request sends a message and waits for a single reply (RPC pattern).
func (c *Client) Request(ctx context.Context, subject string, data []byte) (*nats.Msg, error) {
	deadline, ok := ctx.Deadline()
	timeout := 5 * time.Second
	if ok {
		timeout = time.Until(deadline)
	}

	msg, err := c.conn.Request(subject, data, timeout)
	if err != nil {
		return nil, fmt.Errorf("request to %s: %w", subject, err)
	}
	return msg, nil
}

// Drain gracefully shuts down - processes in-flight messages then closes.
func (c *Client) Drain() error {
	if err := c.conn.Drain(); err != nil {
		return fmt.Errorf("draining nats: %w", err)
	}
	return nil
}

// Conn returns the underlying connection for JetStream context creation.
func (c *Client) Conn() *nats.Conn {
	return c.conn
}
```

The client above handles connection lifecycle, plain pub/sub, queue groups, and request/reply. For the request/reply pattern specifically, the server side needs a dedicated handler that sends responses back on the reply subject. The following `ServeRPC` method registers a subject as an RPC endpoint - callers invoke it through the `Request` method shown above, and the handler returns the response payload or an error.

```go
// file: internal/nats/core/rpc_server.go
package natsclient

import (
	"encoding/json"
	"log/slog"

	"github.com/nats-io/nats.go"
)

// RPCHandler is the function signature for request-reply handlers.
type RPCHandler func(req []byte) ([]byte, error)

// ServeRPC registers a subject as an RPC endpoint.
// Callers use client.Request() to invoke it.
func (c *Client) ServeRPC(subject string, handler RPCHandler) (*nats.Subscription, error) {
	return c.conn.Subscribe(subject, func(msg *nats.Msg) {
		response, err := handler(msg.Data)
		if err != nil {
			c.logger.Error("rpc handler error",
				slog.String("subject", subject),
				slog.String("error", err.Error()),
			)
			// Send error response so caller doesn't time out.
			errResp, _ := json.Marshal(map[string]string{"error": err.Error()})
			if replyErr := msg.Respond(errResp); replyErr != nil {
				c.logger.Error("failed to send error reply",
					slog.String("error", replyErr.Error()),
				)
			}
			return
		}

		if err := msg.Respond(response); err != nil {
			c.logger.Error("failed to respond",
				slog.String("subject", subject),
				slog.String("error", err.Error()),
			)
		}
	})
}
```

### Junior -> FAANG: Getting NATS Core Right in Your First Service

The most common first-job mistakes with NATS core fall into two categories: misunderstanding at-most-once semantics and not handling the connection lifecycle.

For semantics: if you are tempted to use `conn.Publish` for anything important (orders, payments, user-visible actions), stop and reach for JetStream instead. NATS core is appropriate for three use cases: heartbeats and health pings, high-frequency telemetry where occasional loss is statistically acceptable, and synchronous RPC via request/reply where the caller handles timeout and retry itself.

For the connection lifecycle, the `Client` code above registers four handlers. New engineers often omit these and then wonder why their service silently stops processing messages after a NATS server restart. Make the disconnect handler increment a Prometheus counter named something like `nats_connection_disruptions_total`. That counter is your on-call alert signal.

A concrete interview exercise: implement a service that uses `QueueSubscribe` to load-balance image thumbnail requests across three workers, where each worker has a configurable concurrency limit. Walk through what happens when one worker crashes and reconnects. Verify that the queue group distributes work to the two remaining workers during the outage.

### Senior @ FAANG: Queue Groups, Subject Design, and Authorization at Scale

The `Client` struct shown here is a correct starting point, but a platform-level NATS client used by dozens of services needs additional concerns that do not show up in a single-service implementation.

Subject namespace governance is the first concern. In a multi-team environment without enforced conventions, subjects sprawl: one team uses `service.action.entity`, another uses `entity.action.service`, a third uses arbitrary dotted strings. This matters because NATS account permissions and leaf-node routing policies are applied to subject prefixes. If subjects are not structured with the authorization boundary in the prefix, permissions become unmaintainable. A platform team should define a subject taxonomy like `<team>.<service>.<version>.<verb>.<noun>` and enforce it via a linter that runs in CI. The `>` wildcard on a prefix like `payments.>` then composes cleanly into account-level allow rules.

The `DrainTimeout` in the `Client` constructor deserves explicit mention in a senior review. `Drain` processes all in-flight subscriptions before closing. If a service has a slow subscriber that is still processing a message when the shutdown signal arrives, `Drain` will block up to `DrainTimeout` waiting for it. In a Kubernetes pod with a default `terminationGracePeriodSeconds` of 30 seconds, a 30-second `DrainTimeout` can cause the pod to be SIGKILL'd before drain completes if the pod startup itself takes any time. The safe configuration is `DrainTimeout` set to `terminationGracePeriodSeconds` minus a 5-second buffer, and that value should come from an environment variable rather than being hardcoded.

The request/reply `ServeRPC` pattern above sends error responses as JSON with an `"error"` key. At scale, this becomes a contract that must be versioned. A structured error response with a machine-readable code field (`{"code": "RATE_LIMIT_EXCEEDED", "message": "...", "retry_after_ms": 5000}`) allows callers to implement typed error handling rather than string-matching. Define the error schema in your platform's internal proto or schema package and generate Go types from it. String-based error responses are a tech debt accelerant in RPC systems.

---
