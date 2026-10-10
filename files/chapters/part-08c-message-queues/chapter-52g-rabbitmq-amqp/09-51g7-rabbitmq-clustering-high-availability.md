## 52G.7 RabbitMQ Clustering & High Availability

### Cluster Architecture (RabbitMQ 4.x)

In a RabbitMQ cluster, **all nodes share**: exchange definitions, queue metadata, bindings, users, vhosts, policies. In RabbitMQ 4.x this shared metadata lives in **Khepri**, a Raft-based metadata store that replaces the legacy Mnesia implementation.

- **Khepri** (default in 4.2+, sole supported store from 4.3): Raft-consensus metadata store with predictable recovery semantics. Unlike Mnesia, it tolerates clean recovery after full-cluster outages without manual `force_boot` dances.
- **Mnesia**: legacy metadata store, deprecated and being removed. Upgrading existing clusters should migrate to Khepri via `rabbitmqctl enable_feature_flag khepri_db`.

**Classic queues** are NOT replicated, the queue's data lives on one node. If that node fails, the queue is unavailable until the node returns.

> **Senior track**: **Classic Mirrored Queues (CMQ) were REMOVED entirely in RabbitMQ 4.0.** They were deprecated in 3.9 and no longer exist on 4.x brokers. Any `ha-mode`/`ha-params` policy carried over from 3.x is silently ignored. Migrate to quorum queues (Blue-Green or in-place with the `migrate-mcq-to-qq` tooling) BEFORE upgrading to 4.x, or the queues become single-node classic queues with no replication.

**Quorum queues** (the replicated work-queue type): based on Raft consensus. A quorum queue requires a majority of replicas (⌊n/2⌋+1) to acknowledge a write. With 3 nodes, 1 can fail safely. No split-brain. In 4.0+ they support message TTL, priorities, and single-active consumer, closing the last feature gaps with classic queues.

**Streams** (first-class in 4.x): append-only replicated log with Kafka-like semantics, replayable offsets, and server-side filtering. Use streams when you need log replay, high-fanout consumption, or retention-based storage. Use quorum queues when you need competing-consumer work-queue semantics with per-message ack.

| Workload | Choose |
|----------|--------|
| Task dispatch, RPC, competing consumers | Quorum queue |
| Event sourcing, replay, fan-out to many readers | Stream |
| Transient, local, non-replicated work | Classic queue (single-node) |

### Network Partitions

| Mode | Behavior |
|------|----------|
| `pause_minority` | Minority partition pauses (safe, may interrupt traffic) |
| `autoheal` | Reconnect and discard minority's changes (may lose messages) |
| `ignore` | Continue operating (split-brain risk) |

**Recommendation**: Use `pause_minority` for financial/critical data. `autoheal` for high-availability notification systems.

### Go Connection Failover

RabbitMQ clusters route connections to individual nodes, so a node failure terminates all channels on that node and requires the client to reconnect to a surviving cluster member. The following Go implementation cycles through a list of AMQP URLs with exponential backoff, re-declares all topology on reconnect, and resumes consuming without losing queued messages.

```go
package failover

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ReliableConnection wraps an AMQP connection with automatic reconnection.
type ReliableConnection struct {
	urls    []string
	config  amqp.Config
	conn    *amqp.Connection
	onReady chan struct{}
	logger  *slog.Logger
}

// NewReliableConnection creates a connection that reconnects on failure.
func NewReliableConnection(urls []string, cfg amqp.Config, logger *slog.Logger) *ReliableConnection {
	return &ReliableConnection{
		urls:    urls,
		config:  cfg,
		onReady: make(chan struct{}),
		logger:  logger,
	}
}

// Connect dials all broker URLs in order until one succeeds.
func (r *ReliableConnection) Connect(ctx context.Context) error {
	for _, url := range r.urls {
		conn, err := amqp.DialConfig(url, r.config)
		if err != nil {
			r.logger.Warn("failover: broker unavailable, trying next",
				"url", url, "error", err)
			continue
		}
		r.conn = conn
		r.logger.Info("failover: connected", "url", url)
		return nil
	}
	return fmt.Errorf("failover: all brokers unavailable: %v", r.urls)
}

// RunWithReconnect maintains a live connection, reconnecting with exponential backoff
// whenever the connection drops. Calls onConnected each time a new connection is established.
func (r *ReliableConnection) RunWithReconnect(ctx context.Context, onConnected func(*amqp.Connection) error) {
	attempt := 0
	for {
		if err := r.Connect(ctx); err != nil {
			backoff := exponentialBackoff(attempt, 200*time.Millisecond, 30*time.Second)
			r.logger.Error("failover: connection failed, retrying",
				"attempt", attempt,
				"backoff", backoff,
				"error", err,
			)
			select {
			case <-time.After(backoff):
				attempt++
				continue
			case <-ctx.Done():
				return
			}
		}

		attempt = 0
		notifyClose := r.conn.NotifyClose(make(chan *amqp.Error, 1))

		// Run application logic with this connection.
		if err := onConnected(r.conn); err != nil {
			r.logger.Error("failover: onConnected error", "error", err)
		}

		// Wait for connection close or context cancellation.
		select {
		case amqpErr, ok := <-notifyClose:
			if !ok {
				r.logger.Info("failover: connection closed cleanly")
				return
			}
			r.logger.Error("failover: connection lost",
				"code", amqpErr.Code,
				"reason", amqpErr.Reason,
			)
		case <-ctx.Done():
			_ = r.conn.Close()
			return
		}
	}
}

// Connection returns the current underlying connection. May be nil if not connected.
func (r *ReliableConnection) Connection() *amqp.Connection {
	return r.conn
}

func exponentialBackoff(attempt int, base, max time.Duration) time.Duration {
	backoff := time.Duration(float64(base) * math.Pow(2, float64(attempt)))
	if backoff > max {
		return max
	}
	return backoff
}
```

### Junior → FAANG: Clustering Concepts You Must Explain in Interviews

RabbitMQ clustering comes up in every senior interview and frequently in junior-level interviews at companies that run their own brokers. Know these four points before walking into any interview.

**What is shared across cluster nodes:**

All nodes share exchange definitions, queue metadata, bindings, users, virtual hosts, and policies. This is the control plane. In RabbitMQ 4.x, this shared metadata lives in Khepri, a Raft-based store. What is NOT automatically shared: queue data. Unless you use quorum queues or streams, each queue's messages live on the single node where the queue was declared.

**Why classic mirrored queues were removed:**

Classic mirrored queues replicated queue data using a custom gossip-based protocol that had two fatal flaws. First, unsynchronized mirrors: when a mirror was catching up to the leader after joining, any message in the sync window could be lost if the leader crashed during sync. Second, split-brain: during a network partition, both sides could accept writes and diverge. Raft-based quorum queues eliminate both by requiring a quorum majority to acknowledge every write before confirming it to the producer.

**The odd-number cluster rule:**

Quorum (and Raft in general) requires a majority of nodes to be available to make progress. In a 2-node cluster, losing one node means the surviving node cannot achieve a majority of 2, so it stops accepting writes. You lose availability without gaining anything. Always run 3, 5, or 7 nodes. Three nodes tolerate one failure. Five nodes tolerate two failures.

**Go-side reconnection is not automatic:**

`amqp091-go` deliberately does not reconnect automatically. When the connection closes, you receive an error on the `NotifyClose` channel and must rebuild the connection, channel, and consumer from scratch. This is a feature, not a gap. Automatic reconnection would hide the fact that pending confirms, in-flight messages, and consumer registrations all need to be rebuilt. The `ReliableConnection` in this section is the minimal correct pattern.

### Senior @ FAANG: Cluster Operations, Partition Tolerance, and Upgrade Strategy

At the senior level, the interesting questions about RabbitMQ clustering are not about normal operation but about what happens during failure, maintenance, and version upgrades.

**Khepri and what it changes operationally:**

Before Khepri (RabbitMQ 3.x with Mnesia), a full cluster outage where all nodes were cleanly shut down required a specific node to be started first (`force_boot`) to avoid Mnesia's split-brain recovery logic blocking startup. This was a documented manual procedure that on-call engineers had to know. Khepri's Raft-based recovery selects a leader automatically from the nodes that have the most up-to-date state, eliminating the need for `force_boot` in most cases. The operational runbook for full-cluster recovery changes significantly when upgrading from 3.x to 4.x. Update your runbooks before the upgrade, not after the incident.

**Network partition mode selection as an ADR:**

The `pause_minority` mode stops minority-partition nodes from accepting writes or reads. This preserves consistency at the cost of availability. The `autoheal` mode allows minority partitions to continue operating and then discards their writes when the partition heals. For most production workloads, `pause_minority` is correct because message loss during partition healing is harder to recover from than a brief write unavailability. Document this choice. Teams that inherit a cluster with `autoheal` and do not understand why it is set often switch it to `pause_minority` without understanding the availability impact during network flaps.

**Rolling upgrade strategy for 3.x to 4.x:**

Upgrading a running cluster from RabbitMQ 3.13 to 4.x requires migrating off classic mirrored queues first. The process: run `rabbitmqctl list_queues name type` to identify all queues. Any queue with type `classic` and an `ha-mode` policy is a candidate for migration. Use the `migrate-mcq-to-qq` tooling on 3.13 to convert them to quorum queues in place. Verify all consumers reconnect and process correctly. Then upgrade nodes one at a time in a rolling fashion. Only after all nodes are on 4.x can you enable Khepri via `rabbitmqctl enable_feature_flag khepri_db`. Do not enable Khepri during the rolling upgrade window because mixed-version clusters cannot use it.

**Thundering herd on broker restart:**

When a broker node restarts after a failure, all consumers that were connected to that node attempt to reconnect simultaneously. In a cluster with 200 service instances each making one connection, 200 connections arrive within a few seconds. If each service also re-declares its topology at startup, the broker processes thousands of QueueDeclare and ExchangeDeclare commands concurrently. Under this load, some declares fail transiently, triggering more reconnect cycles. The mitigation is jittered backoff on the client side (the `exponentialBackoff` function with a random offset) and lazy topology declaration (declare topology only once at cluster startup via a dedicated operations service, not in every application instance).

---
