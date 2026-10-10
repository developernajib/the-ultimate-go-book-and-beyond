## 37E.3 Go Driver Setup

### Production gocql Configuration

The `gocql` driver provides low-level Cassandra access, while `gocqlx` adds struct binding and named query support on top of it. The session configuration below enables connection pooling, retry policies, and host discovery appropriate for a production Cassandra cluster.

```go
// go.mod
// require github.com/gocql/gocql v1.6.0
// require github.com/scylladb/gocqlx/v3 v3.0.0

package cassandra

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"time"

	"github.com/gocql/gocql"
	"github.com/scylladb/gocqlx/v3"
)

// Config holds Cassandra connection configuration
type Config struct {
	Hosts            []string
	Keyspace         string
	Username         string
	Password         string
	Consistency      gocql.Consistency
	SerialConsistency gocql.SerialConsistency
	ReconnectInterval time.Duration
	Timeout          time.Duration
	ConnectTimeout   time.Duration
	NumConns         int    // connections per host
	TLSEnabled       bool
	LocalDC          string // for DC-aware routing
}

// DefaultConfig returns production-ready defaults
func DefaultConfig(hosts []string, keyspace string) Config {
	return Config{
		Hosts:             hosts,
		Keyspace:          keyspace,
		Consistency:       gocql.LocalQuorum,
		SerialConsistency: gocql.LocalSerial,
		ReconnectInterval: 1 * time.Second,
		Timeout:           5 * time.Second,
		ConnectTimeout:    10 * time.Second,
		NumConns:          2, // 2 connections per host per goroutine
	}
}

// NewSession creates a production Cassandra session
func NewSession(cfg Config, log *slog.Logger) (*gocqlx.Session, error) {
	cluster := gocql.NewCluster(cfg.Hosts...)
	cluster.Keyspace = cfg.Keyspace
	cluster.Consistency = cfg.Consistency
	cluster.SerialConsistency = cfg.SerialConsistency
	cluster.ReconnectInterval = cfg.ReconnectInterval
	cluster.Timeout = cfg.Timeout
	cluster.ConnectTimeout = cfg.ConnectTimeout
	cluster.NumConns = cfg.NumConns

	// Authentication
	if cfg.Username != "" {
		cluster.Authenticator = gocql.PasswordAuthenticator{
			Username: cfg.Username,
			Password: cfg.Password,
		}
	}

	// DC-aware routing: prefer local DC for reads
	if cfg.LocalDC != "" {
		cluster.PoolConfig.HostSelectionPolicy = gocql.DCHostPool(
			cfg.LocalDC,
			gocql.RoundRobinHostPolicy(),
			gocql.RoundRobinHostPolicy(),
		)
	}

	// Token-aware routing: route to correct replica
	cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(
		gocql.DCAwareRoundRobinPolicy(cfg.LocalDC),
		gocql.ShuffleReplicas(),
	)

	if cfg.TLSEnabled {
		cluster.SslOpts = &gocql.SslOptions{
			Config: &tls.Config{
				MinVersion: tls.VersionTLS13,
			},
		}
	}

	// Query observer for metrics
	cluster.QueryObserver = &queryObserver{log: log}
	cluster.BatchObserver = &batchObserver{log: log}

	session, err := gocqlx.WrapSession(cluster.CreateSession())
	if err != nil {
		return nil, fmt.Errorf("cassandra session: %w", err)
	}

	log.Info("cassandra connected",
		"hosts", cfg.Hosts,
		"keyspace", cfg.Keyspace,
		"consistency", cfg.Consistency.String(),
	)

	return &session, nil
}

// queryObserver implements slow query logging
type queryObserver struct {
	log *slog.Logger
}

func (o *queryObserver) ObserveQuery(ctx context.Context, q gocql.ObservedQuery) {
	if q.Err != nil {
		o.log.Error("cassandra query error",
			"query", q.Statement,
			"host", q.Host.String(),
			"err", q.Err,
			"latency_ms", q.End.Sub(q.Start).Milliseconds(),
		)
		return
	}
	latency := q.End.Sub(q.Start).Milliseconds()
	if latency > 50 {
		o.log.Warn("slow cassandra query",
			"query", q.Statement,
			"latency_ms", latency,
			"rows", q.Rows,
		)
	}
}

type batchObserver struct {
	log *slog.Logger
}

func (o *batchObserver) ObserveBatch(ctx context.Context, b gocql.ObservedBatch) {
	if b.Err != nil {
		o.log.Error("cassandra batch error", "err", b.Err)
	}
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Entry Points

A junior reading the config above should be able to name what each knob does and why the default is what it is. `NumConns = 2` means two TCP connections per host, which matters because the CQL protocol multiplexes up to thirty two thousand in flight requests per connection but gocql caps it lower by default, and under contention a second connection removes the per connection mutex bottleneck. `Timeout = 5s` is the per query timeout and it is intentionally higher than a typical web request budget because it is a driver safety net, not the primary deadline. The primary deadline comes from `ctx` on every call. `ConnectTimeout = 10s` is how long the driver waits for the initial TCP and CQL handshake before marking a host as down. `LocalQuorum` plus `TokenAwareHostPolicy` wrapping `DCAwareRoundRobinPolicy` is the production default because it routes every read and write to a replica in the local datacenter that owns the token, which minimizes latency and avoids cross region traffic.

The worked entry point is to run the session constructor against a local three node Docker cluster, execute a `SELECT cluster_name FROM system.local` with a one second context, and confirm it returns in under ten milliseconds. Then add `chaostoolkit` or simply `docker pause` on one node and confirm the driver continues to serve traffic via the other two, with the observer logging a warning about the down host. Then kill a second node and watch the driver return `gocql.ErrNoConnections` because QUORUM at RF=3 cannot be satisfied with only one replica alive. That sequence makes the consistency level concrete.

First job interviewers ask about the difference between prepared and unprepared statements. Prepared statements send the query text once, get back a query id, and subsequent executions send only the id plus bound parameters. This saves parsing cost on the server and removes the possibility of CQL injection. gocql prepares automatically when you use `session.Query(cql).Bind(args...)` and caches the prepared statement per connection. The junior level mistake is to build queries with `fmt.Sprintf` and miss the performance and security benefits. Never do that.

### Senior @ FAANG: Staff and Principal Framing

Staff level driver configuration is where the theoretical architecture meets operational reality. The host selection policy composition above has a subtle bug that is common in production code. The code sets `PoolConfig.HostSelectionPolicy = gocql.DCHostPool(...)` and then overwrites it with `TokenAwareHostPolicy(DCAwareRoundRobinPolicy(...))`. Only the second assignment takes effect, which is what you want, but it illustrates how easy it is to ship a misconfiguration that silently disables token awareness. The correct composition is always `TokenAwareHostPolicy` wrapping `DCAwareRoundRobinPolicy` with the local DC name, because token awareness routes directly to a replica that owns the token (saving one network hop versus a random coordinator) and DC awareness keeps traffic in region. `ShuffleReplicas()` randomizes the order among the replicas that own the token, which prevents hot spotting on the first replica in the token ring.

Retry policy defaults are often wrong for your workload. The default `SimpleRetryPolicy{NumRetries: 3}` retries on any error, which is safe for idempotent reads but dangerous for non idempotent writes because a timeout does not mean the write failed. It may have committed on the coordinator and just timed out on the response. The correct policy is `ExponentialBackoffRetryPolicy{NumRetries: 3, Min: 10ms, Max: 500ms}` for reads and a custom policy for writes that retries only on `gocql.ErrUnavailable` (replicas not enough) and not on `gocql.RequestErrWriteTimeout` unless you have designed the write to be idempotent via a version column or a client generated UUID primary key. Speculative execution via `gocql.SimpleSpeculativeExecution{NumAttempts: 2, TimeoutDelay: 50ms}` issues a parallel query to a second replica after a delay if the first has not responded, and it meaningfully cuts p99 latency on reads at the cost of roughly ten percent extra read traffic. Enable it for latency sensitive reads and leave it off for writes.

Prepared statement re preparation is the most subtle failure mode. When a schema change happens, the server invalidates its prepared statement cache and returns `UNPREPARED` on the next execution. gocql handles this by re preparing automatically on the affected connection, but during a rolling DDL across a large cluster, every connection on every client process re prepares roughly simultaneously, producing a thundering herd that can spike coordinator CPU. The staff level mitigation is to stagger schema changes, pre warm prepared statements on process startup against a canary keyspace, and monitor the `prepared_statements_executed` metric for sudden drops that indicate widespread re preparation. gocqlx maintains its own prepared statement cache keyed by query text, and its `qb` query builder produces stable text that hits the cache consistently. Query text stability matters. If you concatenate a dynamic value into the CQL (which you should never do), every distinct value produces a distinct prepared statement and blows out the server side cache.

Connection pooling on Scylla requires a shard aware driver. The `scylladb/gocql` fork (or gocql v1.7+ which ships native shard awareness) reads the Scylla advertised shard count and opens one connection per shard per host, and routes queries to the connection owning the target shard. Without shard awareness, Scylla's shard per core architecture forces cross shard forwarding inside the node, which gives up roughly half the throughput gain. If your team runs Scylla, the driver choice is part of the architecture, not a detail. The `HostPool` construction must also be sized for your topology. For a twelve node cluster with sixteen cores per node on Scylla, you need at minimum 192 connections per client process, and the `NumConns` setting governs the per host count. Under that sizing, per connection mutex contention becomes invisible and p99 tail latency drops noticeably.

TLS configuration at production scale must pin to TLS 1.3, enable client certificate authentication against an internal CA, and rotate certificates on a schedule shorter than the certificate lifetime. The `SslOpts` struct supports `CertPath`, `KeyPath`, and `CaPath` for mutual TLS, and `EnableHostVerification` should always be true in production. Authenticator should never embed plain text passwords in code or environment variables in long lived form. Integrate with Vault, AWS Secrets Manager, or IRSA for short lived credentials, and wrap `gocql.PasswordAuthenticator` in a refresh loop that rotates the password on expiry. The query observer is the right hook for propagating OpenTelemetry spans. Extract the parent span from context, start a child span keyed on the statement hash (not the full statement text, to keep cardinality bounded), and tag it with the host, consistency level, and result status. That one integration makes Cassandra visible in distributed traces and eliminates entire classes of diagnostic dead ends.

---
