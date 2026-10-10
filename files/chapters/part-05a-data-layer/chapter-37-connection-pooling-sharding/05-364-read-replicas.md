## 37.4 Read Replicas

### Read/Write Splitting and the Replication Lag Problem

Most production workloads are read-heavy (often 10:1 or worse). Sending all reads to the primary wastes its write capacity and prevents horizontal scaling. But read replicas introduce a subtle correctness problem: **replication lag**. Postgres streaming replication and MySQL binlog replication are both asynchronous by default, and a replica typically lags the primary by milliseconds under normal load, seconds under write spikes, and occasionally minutes when a long transaction on the primary blocks WAL replay.

This creates the **read-your-writes** problem: a user submits a comment (write to primary), the HTTP response triggers a page refresh that lists comments (read from replica), the new comment is not yet replicated, and the user sees stale data. Three production-grade mitigations:

1. **Read-after-write routing**: pin reads to the primary for a short window (5-30 seconds) after a user performs a write. Track the write timestamp per user session in Redis or a signed cookie.
2. **LSN tracking (Postgres)**: after a write, capture the replica-visible write LSN via `pg_current_wal_lsn()`. On subsequent reads, query `pg_last_wal_replay_lsn()` on the replica and fall back to the primary if it hasn't caught up. This is what Vitess and pgcat implement under the hood.
3. **Synchronous replicas for critical reads**: configure one replica with `synchronous_commit=on` for reads that cannot tolerate lag (payment confirmations, auth state). Pay the write-latency cost only where it matters.

A `ReplicaSet` holds a reference to the primary and one or more read replicas, distributing reads across replicas with round-robin or random selection and falling back to the primary when all replicas are unhealthy. The mutex protects the replica slice so replicas can be added or removed at runtime without a restart.

```go
package database

import (
    "context"
    "database/sql"
    "errors"
    "math/rand/v2"
    "sync"
    "sync/atomic"
)

// ReplicaSet manages primary and read replicas
type ReplicaSet struct {
    primary  *sql.DB
    replicas []*sql.DB
    mu       sync.RWMutex
    counter  uint64 // for round-robin
}

func NewReplicaSet(primary *sql.DB, replicas ...*sql.DB) *ReplicaSet {
    return &ReplicaSet{
        primary:  primary,
        replicas: replicas,
    }
}

// Primary returns the primary database for writes
func (rs *ReplicaSet) Primary() *sql.DB {
    return rs.primary
}

// Replica returns a read replica using round-robin
func (rs *ReplicaSet) Replica() *sql.DB {
    rs.mu.RLock()
    defer rs.mu.RUnlock()

    if len(rs.replicas) == 0 {
        return rs.primary // Fallback to primary
    }

    idx := atomic.AddUint64(&rs.counter, 1) % uint64(len(rs.replicas))
    return rs.replicas[idx]
}

// RandomReplica returns a random replica
func (rs *ReplicaSet) RandomReplica() *sql.DB {
    rs.mu.RLock()
    defer rs.mu.RUnlock()

    if len(rs.replicas) == 0 {
        return rs.primary
    }

    return rs.replicas[rand.IntN(len(rs.replicas))]
}

// HealthyReplica returns a healthy replica
func (rs *ReplicaSet) HealthyReplica(ctx context.Context) (*sql.DB, error) {
    rs.mu.RLock()
    defer rs.mu.RUnlock()

    for _, replica := range rs.replicas {
        if err := replica.PingContext(ctx); err == nil {
            return replica, nil
        }
    }

    // All replicas unhealthy, check primary
    if err := rs.primary.PingContext(ctx); err == nil {
        return rs.primary, nil
    }

    return nil, errors.New("no healthy database available")
}

// RemoveReplica removes an unhealthy replica
func (rs *ReplicaSet) RemoveReplica(replica *sql.DB) {
    rs.mu.Lock()
    defer rs.mu.Unlock()

    for i, r := range rs.replicas {
        if r == replica {
            rs.replicas = append(rs.replicas[:i], rs.replicas[i+1:]...)
            return
        }
    }
}

// AddReplica adds a replica back
func (rs *ReplicaSet) AddReplica(replica *sql.DB) {
    rs.mu.Lock()
    defer rs.mu.Unlock()
    rs.replicas = append(rs.replicas, replica)
}
```

### Repository with Read/Write Splitting

The repository implementation translates domain method calls into SQL queries, isolating the service layer from database-specific concerns. Each method accepts a context to propagate deadlines and cancellation into the query execution.

```go
package repository

import (
    "context"
    "database/sql"
)

// DB interface for database operations
type DB interface {
    QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
    QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
    ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// ReplicaAwareRepository uses appropriate database for reads/writes
type ReplicaAwareRepository struct {
    primary  *sql.DB
    replicas *ReplicaSet
}

func NewReplicaAwareRepository(primary *sql.DB, replicas *ReplicaSet) *ReplicaAwareRepository {
    return &ReplicaAwareRepository{
        primary:  primary,
        replicas: replicas,
    }
}

// User represents a user entity
type User struct {
    ID    int64
    Name  string
    Email string
}

// GetByID reads from replica
func (r *ReplicaAwareRepository) GetByID(ctx context.Context, id int64) (*User, error) {
    db := r.replicas.Replica() // Read from replica

    var user User
    err := db.QueryRowContext(ctx,
        "SELECT id, name, email FROM users WHERE id = $1",
        id,
    ).Scan(&user.ID, &user.Name, &user.Email)

    if err != nil {
        return nil, err
    }
    return &user, nil
}

// Create writes to primary
func (r *ReplicaAwareRepository) Create(ctx context.Context, user *User) error {
    _, err := r.primary.ExecContext(ctx,
        "INSERT INTO users (name, email) VALUES ($1, $2)",
        user.Name, user.Email,
    )
    return err
}

// GetByIDFromPrimary for read-after-write consistency
func (r *ReplicaAwareRepository) GetByIDFromPrimary(ctx context.Context, id int64) (*User, error) {
    var user User
    err := r.primary.QueryRowContext(ctx,
        "SELECT id, name, email FROM users WHERE id = $1",
        id,
    ).Scan(&user.ID, &user.Name, &user.Email)

    if err != nil {
        return nil, err
    }
    return &user, nil
}
```

### Junior → FAANG: the three things about read replicas you will be asked about

First, read replicas exist to offload read traffic from the primary, not to add capacity for writes. All writes go to the primary, and the primary streams the write-ahead log to replicas, which replay it. If writes are your bottleneck, replicas do not help, you need sharding or a different data model. Second, replicas are eventually consistent, typically lagging the primary by a few milliseconds under normal load but capable of multi-second or multi-minute lag under spike or long transactions. Third, read-after-write is the most common correctness bug. User posts a comment (write to primary), page refresh fetches comments (read from replica, replica has not replayed yet), comment is missing. Users file this as a bug. You fix it by routing reads to the primary for a short window after a write for that user, keyed by session.

Worked example of the routing layer. In your repository, `GetByID` reads from a replica, `Create` writes to primary, and `GetByIDFromPrimary` exists explicitly for read-after-write. The service layer decides which to call based on context, typically by checking a "recently wrote" flag stored in Redis or a signed cookie with an expiry of 10 to 30 seconds. Simpler alternative for session-consistent reads: do the read within the same transaction as the write on the primary, which gives you strong consistency at the cost of holding a transaction open longer.

Interview entry-point. "What is replication lag and how do you handle it?" Answer: replication lag is the delay between a commit on the primary and its visibility on a replica. You measure it with `pg_stat_replication.replay_lag` on the primary or `EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())` on the replica. You handle it by choosing, per query, whether the query can tolerate lag. Tolerant reads (list of blog posts, search results) go to replicas. Intolerant reads (user profile right after edit, payment confirmation, auth token validation) go to the primary or use LSN-based read-your-writes routing.

### Senior @ FAANG: routing architecture, failover orchestration, and consistency contracts

Replica routing is an ADR, not a code decision. The three design axes: granularity (per-query, per-transaction, per-request, per-session), consistency model (eventual, read-your-writes, bounded staleness, strong), and failover semantics (auto-promote, human-in-loop, multi-region). Staff engineers produce a routing contract that names every query class and its target.

Granularity tradeoffs. Per-query routing (this `SELECT` goes to replica, that one to primary) is the most flexible and the most error-prone because each query author decides. Per-transaction routing (a transaction is either read-only-on-replica or read-write-on-primary) is cleaner and matches Postgres semantics, but creates surprises when a transaction started as read-only needs to write. Per-request routing (this HTTP request touches only replicas, that one only primary) is what many frameworks default to, but fails read-after-write unless you layer session stickiness. Per-session routing (this user's reads go to primary for 30 seconds after their last write) is the read-your-writes pattern and the most user-friendly. The right answer is usually per-session on top of per-query, with the session layer overriding the per-query default when write-recency demands it.

Read-after-write implementations in order of strength. (A) Time-based stickiness: after a write for user U, set a cookie or Redis key `user:U:write_ts=now()` with TTL 30 seconds. All reads for U during that window go to primary. Cheap, approximate, fails if replica lag exceeds 30 seconds. (B) LSN-based routing: after a write, capture `pg_current_wal_lsn()` and attach to the session. On reads, compare to `pg_last_wal_replay_lsn()` on the candidate replica. If replica is behind, route to primary or another replica that has caught up. Exact, requires LSN propagation through your session layer. Vitess and PgCat implement variants of this. (C) Synchronous replica: configure one replica with `synchronous_commit=remote_apply`, which blocks the primary commit until that replica has applied the WAL. Reads against this replica are strongly consistent at the cost of write latency equal to WAN RTT to the replica. Use for payments, auth, and other correctness-critical paths only. (D) Session mode at the pooler: PgBouncer in session mode pins a client to one backend per transaction, enabling `SET` commands, but does not solve replica routing. PgCat can route based on SQL content (writes to primary, reads to replicas) with optional LSN checks.

Replica lag handling. Measurement: on the primary, `pg_stat_replication.replay_lag` is a `interval`, alert if sustained above 1 second. On the replica, `now() - pg_last_xact_replay_timestamp()` gives wall-clock lag, which is more conservative (returns nonzero even when replica is idle and waiting). Enforcement: if you want to refuse reads from a replica that is more than N seconds behind, your routing layer polls lag every few seconds and marks replicas unhealthy above the threshold. Hot standby feedback (`hot_standby_feedback=on`) tells the primary to avoid vacuuming rows that replica queries still need, preventing query cancellations on the replica due to snapshot conflicts at the cost of bloat on the primary. Synchronous replication tiers: `synchronous_commit=off` (async, fastest, replica-lag problem), `remote_write` (primary commits after replica receives WAL, not applied), `remote_apply` (primary commits after replica applies WAL, strongest consistency, slowest). Semisynchronous patterns (Postgres `synchronous_standby_names` with `ANY 1 (replica_a, replica_b)`) give durability against primary loss with tolerable latency by waiting for any one of a quorum.

Failover orchestration. The major options in 2026: Patroni (Python, etcd/Consul/Zookeeper for DCS, most popular self-managed), Stolon (Go, similar model), pg_auto_failover (simpler monitor-based design from Citus/Microsoft), AWS RDS failover (managed, minute-scale RTO), Aurora auto-failover (managed, sub-30s RTO, uses shared storage so no WAL replay), Patroni on Kubernetes via Spilo or CrunchyData PGO. The application-side concerns are identical across all of them: (1) DNS-based endpoint or proxy-based endpoint, (2) how fast the application notices the switch, and (3) what happens to in-flight connections. DNS-based failover (RDS default) means your pool keeps hitting the old IP until DNS TTL expires and `MaxConnLifetime` rotates connections. A TTL of 5 seconds plus `MaxConnLifetime` of 5 minutes means up to 5 minutes of errored writes against the demoted primary, which is unacceptable. Fixes: shorter `MaxConnLifetime`, application-layer detection of read-only errors (Postgres `25006 read_only_sql_transaction`) with immediate pool invalidation, or a proxy tier (PgBouncer, PgCat, RDS Proxy) that handles endpoint switching centrally.

Reader endpoints versus custom routers. AWS Aurora provides a reader endpoint that load-balances across replicas, which is convenient but opaque (you cannot pin to a specific replica, you cannot route based on lag). Custom routers in the application layer (your `ReplicaSet` above) give you control at the cost of owning the health-checking, lag-tracking, and rebalancing logic. PgCat in replica-routing mode is the middle ground: external pooler that handles the routing but lets you configure per-replica weights and lag thresholds. The choice depends on whether your platform team owns a pooler tier. If yes, push routing into PgCat. If no, implement in the application with the repository pattern shown above, plus LSN tracking for read-your-writes.

Write-first/read-fallback pattern. For operations that must succeed even during replica issues, the pattern is: attempt on replica with a short timeout (say, 100ms), fall back to primary on timeout or error. This bounds tail latency at the cost of occasional primary load spikes. The inverse, read-first/write-fallback, does not exist because writes to replicas fail with `read_only_sql_transaction`.

Pool hedging on replicas is more defensible than on primaries because reads are idempotent. A hedged read fires a request to replica A, and after 20ms of waiting, fires a duplicate to replica B, returning whichever answers first. The cost is up to 2x replica load, the benefit is tail-latency collapse. Google's Bigtable client implements this natively. In Go, you build it with a `context.WithCancel` pair and a `select` on two result channels.

Connection-lifecycle observability for replica setups requires labels. Every pool metric should carry a `role={primary,replica}` and `replica_id=<name>` label. Alerts differentiate: primary pool saturation is a capacity incident, replica pool saturation might just mean one replica is slow and the router should route around it. Add `replication_lag_seconds{replica_id}` as a gauge, alert above 1 second for 5 minutes. OTEL spans around `pool.Acquire` should include `db.role` and `db.replica` attributes so distributed traces show which backend served each query, which is invaluable during lag incidents.

Multi-region concerns. Cross-region replicas add WAN latency to replica reads (50 to 200 ms), which is often worse than reading from the primary in-region. The pattern for multi-region is: regional primaries (if you can shard by region), or a global primary with regional read replicas serving low-latency reads with accepted eventual consistency. Aurora Global Database and Spanner offer the strongest forms of this. Writes in the remote region pay the cross-region RTT regardless. The application must surface this to product teams so they do not promise sub-100ms writes in a region without a local primary.

---
