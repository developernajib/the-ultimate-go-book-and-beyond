## 33.7 LISTEN/NOTIFY

### Real-Time Notifications

PostgreSQL's LISTEN/NOTIFY provides a lightweight pub/sub mechanism built into the database itself. A client issues `LISTEN channel_name` on a connection, and any other session can send messages to that channel with `NOTIFY channel_name, 'payload'` (or the `pg_notify` function). Messages are delivered asynchronously to all listening connections. This avoids adding a separate message broker for simple event-driven workflows like cache invalidation, real-time UI updates, or triggering background jobs when rows change.

In Go with `pgx`, the listener must hold a dedicated connection because `WaitForNotification` blocks until a message arrives. Two valid patterns:

1. **Acquire and hijack from a pool** using `pool.Acquire(ctx)` and calling `conn.Hijack()` to take the underlying `*pgx.Conn` out of pool management. The pool will not try to health-check or reuse it.
2. **Open a standalone connection** with `pgx.Connect(ctx, dsn)` dedicated to notifications.

Either way, do not return the connection to the pool while `LISTEN` is active. If the connection dies, you must reconnect and re-issue every `LISTEN` statement, and you should assume notifications sent during the gap were lost. PostgreSQL's notification queue is disk-backed with a roughly 8 GB default capacity, and overflow makes NOTIFY calls fail rather than silently dropping, so treat LISTEN/NOTIFY as best effort and back it with a durable source of truth (outbox table, WAL-based CDC) if loss is unacceptable. The publisher can use any pooled connection since `pg_notify` is a regular SQL function call.

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"

    "github.com/jackc/pgx/v5/pgconn"
    "github.com/jackc/pgx/v5/pgxpool"
)

func listenForNotifications(ctx context.Context, pool *pgxpool.Pool) error {
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return err
    }
    defer conn.Release()

    _, err = conn.Exec(ctx, "LISTEN events")
    if err != nil {
        return err
    }

    for {
        notification, err := conn.Conn().WaitForNotification(ctx)
        if err != nil {
            return err
        }

        fmt.Printf("Channel: %s, Payload: %s\n", notification.Channel, notification.Payload)

        // Process notification
        handleNotification(notification)
    }
}

func notify(ctx context.Context, pool *pgxpool.Pool, channel, payload string) error {
    _, err := pool.Exec(ctx, "SELECT pg_notify($1, $2)", channel, payload)
    return err
}

// Using trigger for automatic notifications
const notifyTrigger = `
CREATE OR REPLACE FUNCTION notify_event() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('events', json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', NEW.id
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_notify
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION notify_event();
`

// Event handler
type Event struct {
    Table  string `json:"table"`
    Action string `json:"action"`
    ID     int64  `json:"id"`
}

func handleOrderEvent(e Event) {
    log.Printf("handling order event: %+v", e)
}

func handleUserEvent(e Event) {
    log.Printf("handling user event: %+v", e)
}

func handleNotification(n *pgconn.Notification) {
    var event Event
    if err := json.Unmarshal([]byte(n.Payload), &event); err != nil {
        log.Printf("Invalid event payload: %v", err)
        return
    }

    switch event.Table {
    case "orders":
        handleOrderEvent(event)
    case "users":
        handleUserEvent(event)
    }
}
```

### Junior → FAANG: why LISTEN/NOTIFY exists and when to reach for it

Pub/sub inside your database sounds surprising at first. The design makes sense once you realize Postgres already has a persistent connection, a transaction boundary, and a trigger system. LISTEN/NOTIFY piggybacks on all three so you can get asynchronous fan-out without running Kafka, Redis, or NATS.

The delivery rules you need to internalize before writing any producer. A `NOTIFY` inside a transaction is buffered and only delivered when that transaction commits. If you roll back, listeners see nothing. Duplicate notifications with identical channel and payload within a single transaction are collapsed into one. The payload is a text string with an 8000-byte limit (not 8KB exactly, it is 8000 bytes minus protocol overhead). Larger payloads must be sent as an ID that listeners use to fetch the real row from a table.

Worked first-job example. You want the web frontend to refresh a dashboard when an admin updates feature flags. A trigger on `feature_flags` calls `pg_notify('feature_flags_changed', NEW.key)`, the Go backend listens on that channel and broadcasts over a WebSocket. Total infrastructure: none beyond what you already run. Total code: a trigger function, a goroutine running `WaitForNotification`, and a WebSocket hub.

Interview entry-point. Be able to state three things. One, `pg_notify` is transaction scoped and delivered on commit. Two, LISTEN holds a dedicated connection and does not work through connection poolers in transaction or statement mode. Three, if the listener disconnects, notifications sent during the gap are lost. These three facts rule out most inappropriate uses.

### Senior @ FAANG: operational failure modes and when to quit

LISTEN/NOTIFY is a lovely prototype tool and a dangerous production event bus. The failure modes are not obvious until you are on an incident call at 3am.

pgBouncer incompatibility. In `transaction` or `statement` pooling mode, pgBouncer hands out a different backend connection every time, so your `LISTEN` runs on a connection you do not own on the next call. You must either use `session` pooling for the listener (which defeats the point of pgBouncer) or bypass the pooler entirely with a direct connection to Postgres. In a Kubernetes environment this means a separate Service or a direct pod-to-pod connection for the listener, with its own TLS config and its own credentials. Engineers regularly discover this when their new pooler deployment silently drops every notification.

Reconnect gap and no durability. Notifications sent while the listener is disconnected are gone. There is no replay, no offset, no consumer group. If delivery-at-least-once matters, LISTEN/NOTIFY alone is wrong. The correct pattern is the transactional outbox: the same transaction that mutates the business table inserts a row into `outbox(id, payload, created_at, delivered_at)` and calls `pg_notify` as a wake-up hint. A worker consumes the outbox with `SELECT ... FOR UPDATE SKIP LOCKED`. NOTIFY becomes a low-latency nudge, the outbox is the durable source of truth, and a periodic poll covers notification loss. This is the same shape you would implement with Debezium plus Kafka, minus the operational surface area, and it scales to tens of thousands of events per second on a single node.

Queue and payload limits. The global async notification queue is disk-backed (an SLRU under `pg_notify/`) with a roughly 8 GB default capacity, and overflow causes the sending transaction to fail with `too many notifications in the NOTIFY queue`. Monitor `pg_notification_queue_usage()` and alert when it exceeds 25%. Payload size is 8000 bytes. Encode as JSON only the fields listeners strictly need for routing, never the full row.

Ordering and fan-out semantics. Notifications on a single channel are delivered in commit order to each listener, but there is no total order across channels, and there is no backpressure from listeners to senders. A slow listener does not slow down producers. It accumulates in that listener's session queue until overflow, then its session gets disconnected. For multi-consumer fan-out at scale (thousands of listeners, hundreds of thousands of events per second), LISTEN/NOTIFY is the wrong shape. The right answer is Kafka or Redis Streams or NATS JetStream. Postgres's async queue is not designed to be the spine of a high-throughput streaming platform.

When to move off. Write down the move-off trigger before you need it. Concrete criteria: notification queue usage routinely exceeds 10%, listeners exceed a few dozen, the payload keeps wanting to be larger than a few hundred bytes, you need replay, you need consumer groups, you need partitioning, you need exactly-once. Any one of these is a signal. Two of them is a mandate. The migration path depends on needs: Redis Pub/Sub for fire-and-forget at very low latency, Redis Streams or NATS JetStream for durable consumer groups at moderate scale, Kafka when you need multi-hour replay and strong partitioning guarantees. For many teams the correct middle ground in 2026 is NATS JetStream co-located in the same cluster as Postgres, with the outbox worker bridging the two.

Security surface. `NOTIFY` takes arbitrary text. Triggers that embed row contents into the payload can leak data across tenants if everyone listens on the same channel. Use per-tenant channels (`notify('t_' || tenant_id, ...)`) or include authorization metadata and enforce it in the listener. Audit trigger bodies for SQL injection via table or column names derived from input.

Code-review checks for LISTEN/NOTIFY in a PR. Does it go through a pooler? (Reject or document the direct connection.) Is there a reconnect loop with backoff and re-`LISTEN` on every socket? Is there a durable source of truth (outbox or CDC) that covers notification loss? Is the payload bounded to well under 8000 bytes? Is there a metric for queue usage and a runbook for overflow? Missing any of these is a release blocker, not a nit.

---
