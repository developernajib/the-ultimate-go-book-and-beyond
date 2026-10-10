## 8. Multi-Region PostgreSQL with Patroni-Style Failover

Production multi-region PostgreSQL uses Patroni for HA within a region and logical replication (or Citus for sharding) across regions. The `MultiRegionPool` below manages connections to multiple PostgreSQL instances spread across regions. All write queries are routed to the single primary node, while read queries are sent to the nearest healthy replica to minimize latency. The pool continuously monitors each node's health via `PingContext` and tracks replication lag in bytes by querying PostgreSQL's WAL (Write-Ahead Log) position functions. When the primary fails, the `PromoteReplica` method demotes the old primary and promotes a replica, mimicking what Patroni does automatically in production through its REST API and distributed consensus via etcd or ZooKeeper.

```go
// pgmulti/pool.go
package pgmulti

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Role describes a node's current PostgreSQL role.
type NodeRole string

const (
	NodeRolePrimary  NodeRole = "primary"
	NodeRoleReplica  NodeRole = "replica"
	NodeRoleUnknown  NodeRole = "unknown"
)

// DBNode represents a single PostgreSQL instance.
type DBNode struct {
	DSN        string
	Region     string
	NodeRole   NodeRole
	db         *sql.DB
	healthy    atomic.Bool
	lagBytes   atomic.Int64
}

// Open opens the underlying connection pool.
func (n *DBNode) Open(maxOpen, maxIdle int, lifetime time.Duration) error {
	db, err := sql.Open("postgres", n.DSN)
	if err != nil {
		return fmt.Errorf("opening db for region %s: %w", n.Region, err)
	}
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(maxIdle)
	db.SetConnMaxLifetime(lifetime)
	n.db = db
	n.healthy.Store(true)
	return nil
}

// DB returns the underlying *sql.DB.
func (n *DBNode) DB() *sql.DB { return n.db }

// MultiRegionPool manages connections to multiple PostgreSQL nodes.
// Writes go to the primary - reads can be distributed across healthy replicas.
type MultiRegionPool struct {
	mu      sync.RWMutex
	nodes   []*DBNode
	primary atomic.Pointer[DBNode]
	logger  *slog.Logger
}

func NewMultiRegionPool(logger *slog.Logger) *MultiRegionPool {
	return &MultiRegionPool{logger: logger}
}

// AddNode registers a node. Call SetPrimary to designate the write target.
func (p *MultiRegionPool) AddNode(n *DBNode) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nodes = append(p.nodes, n)
}

// SetPrimary marks the node at dsn as the write primary.
func (p *MultiRegionPool) SetPrimary(dsn string) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, n := range p.nodes {
		if n.DSN == dsn {
			n.NodeRole = NodeRolePrimary
			p.primary.Store(n)
			p.logger.Info("primary updated", "dsn", dsn, "region", n.Region)
			return nil
		}
	}
	return fmt.Errorf("node with DSN %q not found", dsn)
}

// Primary returns the current write primary. Error if none is designated.
func (p *MultiRegionPool) Primary() (*DBNode, error) {
	n := p.primary.Load()
	if n == nil {
		return nil, errors.New("no primary designated")
	}
	if !n.healthy.Load() {
		return nil, fmt.Errorf("primary node %s is unhealthy", n.Region)
	}
	return n, nil
}

// ReadReplica returns the nearest healthy replica to the given region.
// Falls back to primary if no replica is available.
func (p *MultiRegionPool) ReadReplica(preferRegion string) (*DBNode, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	// Prefer replica in same region first.
	for _, n := range p.nodes {
		if n.Region == preferRegion && n.NodeRole == NodeRoleReplica && n.healthy.Load() {
			return n, nil
		}
	}
	// Any healthy replica.
	for _, n := range p.nodes {
		if n.NodeRole == NodeRoleReplica && n.healthy.Load() {
			return n, nil
		}
	}
	// Fall back to primary.
	return p.Primary()
}

// ExecPrimary executes a write query on the primary.
func (p *MultiRegionPool) ExecPrimary(ctx context.Context, query string, args ...any) (sql.Result, error) {
	primary, err := p.Primary()
	if err != nil {
		return nil, err
	}
	return primary.db.ExecContext(ctx, query, args...)
}

// QueryReplica runs a read query on the best available replica.
func (p *MultiRegionPool) QueryReplica(ctx context.Context, preferRegion, query string, args ...any) (*sql.Rows, error) {
	node, err := p.ReadReplica(preferRegion)
	if err != nil {
		return nil, err
	}
	return node.db.QueryContext(ctx, query, args...)
}

// HealthLoop checks each node's health on the given interval.
func (p *MultiRegionPool) HealthLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.mu.RLock()
			nodes := make([]*DBNode, len(p.nodes))
			copy(nodes, p.nodes)
			p.mu.RUnlock()

			for _, n := range nodes {
				n := n
				go func() {
					pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
					defer cancel()
					if err := n.db.PingContext(pingCtx); err != nil {
						n.healthy.Store(false)
						p.logger.Warn("node unhealthy", "region", n.Region, "err", err)
					} else {
						n.healthy.Store(true)
						p.checkReplicationLag(ctx, n)
					}
				}()
			}
		}
	}
}

func (p *MultiRegionPool) checkReplicationLag(ctx context.Context, n *DBNode) {
	if n.NodeRole != NodeRoleReplica {
		return
	}
	row := n.db.QueryRowContext(ctx,
		`SELECT COALESCE(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0)`)
	var lagBytes int64
	if err := row.Scan(&lagBytes); err != nil {
		return
	}
	n.lagBytes.Store(lagBytes)
	p.logger.Debug("replication lag", "region", n.Region, "lag_bytes", lagBytes)
}

// PromoteReplica performs a manual failover: promotes regionID to primary.
// In production this would call Patroni's REST API (POST /failover).
func (p *MultiRegionPool) PromoteReplica(ctx context.Context, regionID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	var target *DBNode
	for _, n := range p.nodes {
		if n.Region == regionID {
			target = n
			break
		}
	}
	if target == nil {
		return fmt.Errorf("region %q not found", regionID)
	}

	// Demote existing primary.
	if old := p.primary.Load(); old != nil {
		old.NodeRole = NodeRoleReplica
	}

	target.NodeRole = NodeRolePrimary
	p.primary.Store(target)
	p.logger.Info("failover complete", "new_primary", regionID)
	return nil
}
```

---

### Junior -> FAANG: Read-Replica Routing and Replication Lag Trade-offs

The `MultiRegionPool` demonstrates the primary pattern for database read scaling in multi-region systems: writes go to the primary, reads go to the nearest healthy replica. The critical prerequisite gap for junior engineers is understanding what "nearest" means for a database read.

For a user query that needs absolutely current data (checking whether a payment just went through), you cannot use a replica, you must read from the primary. Replicas introduce replication lag. Even in a fast network, streaming replication lag is typically 1-100ms but can spike to seconds under heavy write load. A query that reads account balance from a replica may return a value that is 500ms stale. For most reads (product catalog, user profile) this is acceptable. For financial reads, it is not.

The interview question pattern: "How do you decide whether to read from a primary or replica?" Strong answer: "Tag reads with a consistency requirement. Reads tagged `strong` go to primary. Reads tagged `eventual` go to the nearest healthy replica with lag below the service's RPO threshold. Default to `eventual` for reads that do not have a business reason for strong consistency."

Practice: add a `ReadPrimary(ctx, query, args)` method to `MultiRegionPool` that documents its purpose (strong consistency reads) and routes explicitly to the primary regardless of region.

### Senior @ FAANG: Database Topology as Infrastructure Policy

**Patroni's role versus the application pool.** The `MultiRegionPool` above manages connection routing at the application layer. Patroni manages primary election at the database layer using etcd or ZooKeeper for consensus. These are separate concerns at separate layers, and they must agree on who the primary is. If Patroni promotes a new primary but the application pool has not been updated, writes go to the old node, which Patroni has now demoted to a replica and put in read-only mode, causing write failures. A production system integrates pool updates with Patroni events via its REST API or a webhook callback.

**Replication lag in bytes versus seconds.** The `checkReplicationLag` method queries `pg_wal_lsn_diff` which returns lag in bytes. Bytes are harder to reason about than seconds because write rate varies. A 1MB lag at 10 MB/s throughput is 100ms. The same 1MB lag at 100 KB/s throughput is 10 seconds. A production health probe converts byte lag to time lag by dividing by the current write throughput. PostgreSQL exposes this via `pg_stat_replication` on the primary, which includes the `sent_lsn`, `write_lsn`, and `flush_lsn` fields that allow reconstruction of lag in time units.

**Connection pool sizing is a multiplication problem.** Each `DBNode` uses `sql.DB` which maintains a connection pool. In a multi-region deployment with 3 regions, 3 application instances per region, and a `MaxOpenConns` of 10, the primary receives up to `3 * 3 * 10 = 90` connections simultaneously. Production PostgreSQL instances typically support 100-500 connections before connection overhead degrades throughput. This arithmetic must happen at deployment time, not during an incident. PgBouncer or pgpool-II as a connection pooler sits between the application pool and PostgreSQL to multiplex thousands of application connections onto a small pool of server connections.

**PromoteReplica and fencing.** The `PromoteReplica` method in the pool demotes the old primary by setting its role to `NodeRoleReplica`. But the actual PostgreSQL process on the old primary does not know it has been demoted: it is still running as a primary until Patroni issues a `pg_ctl demote` command. During the gap between application-layer demotion and Patroni-layer demotion, two primaries exist simultaneously (split-brain). A production failover procedure must fence the old primary (via STONITH, a revoked Patroni lease, or a security group change that blocks inbound connections) before promoting the replica.

**Cross-region logical replication topology decisions.** The section mentions Citus sharding for cross-region distribution. A staff engineer choosing between Citus sharding, PostgreSQL logical replication, and an application-layer replication engine (like the one in section 7) makes this decision based on: (1) write conflict tolerance (logical replication does not resolve conflicts, the engine does), (2) schema complexity (Citus requires sharding key design upfront), and (3) operational maturity of the team (Citus adds significant operational complexity). This decision should be in an ADR.
