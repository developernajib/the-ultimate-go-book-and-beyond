## 60.7 Scaling Strategies

### Database Sharding

Database sharding horizontally partitions the URL table across multiple database instances, with a `ShardRouter` directing reads and writes to the correct shard based on a hash of the short ID. Consistent hashing is preferred over simple modulo sharding because adding a new shard only remaps a fraction of keys rather than reshuffling the entire dataset. Each shard is an independent PostgreSQL instance with its own connection pool, so a failure or slowdown on one shard affects only the URLs routed to that shard rather than the entire service.

```go
// sharding/url_sharding.go
package sharding

import (
    "context"
    "database/sql"
    "hash/fnv"

    "yourproject/repository"
)

// ShardRouter routes requests to the correct shard
type ShardRouter struct {
    shards    []*sql.DB
    numShards int
}

// NewShardRouter creates a new shard router
func NewShardRouter(shards []*sql.DB) *ShardRouter {
    return &ShardRouter{
        shards:    shards,
        numShards: len(shards),
    }
}

// GetShard returns the shard for a short ID
func (r *ShardRouter) GetShard(shortID string) *sql.DB {
    h := fnv.New32a()
    h.Write([]byte(shortID))
    shardIndex := h.Sum32() % uint32(r.numShards)
    return r.shards[shardIndex]
}

// GetShardIndex returns the shard index
func (r *ShardRouter) GetShardIndex(shortID string) int {
    h := fnv.New32a()
    h.Write([]byte(shortID))
    return int(h.Sum32() % uint32(r.numShards))
}

// AllShards returns all shards for broadcast queries
func (r *ShardRouter) AllShards() []*sql.DB {
    return r.shards
}

// ShardedRepository handles sharded URL storage
type ShardedRepository struct {
    router *ShardRouter
}

// Create inserts a URL into the correct shard
func (r *ShardedRepository) Create(ctx context.Context, url *repository.URL) error {
    shard := r.router.GetShard(url.ShortID)

    query := `
        INSERT INTO urls (short_id, long_url, user_id, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at
    `

    return shard.QueryRowContext(ctx, query,
        url.ShortID,
        url.LongURL,
        url.UserID,
        url.ExpiresAt,
    ).Scan(&url.ID, &url.CreatedAt)
}

// Get retrieves a URL from the correct shard
func (r *ShardedRepository) Get(ctx context.Context, shortID string) (*repository.URL, error) {
    shard := r.router.GetShard(shortID)

    query := `
        SELECT id, short_id, long_url, user_id, created_at, expires_at, is_active
        FROM urls
        WHERE short_id = $1 AND is_active = true
    `

    var url repository.URL
    err := shard.QueryRowContext(ctx, query, shortID).Scan(
        &url.ID,
        &url.ShortID,
        &url.LongURL,
        &url.UserID,
        &url.CreatedAt,
        &url.ExpiresAt,
        &url.IsActive,
    )

    if err == sql.ErrNoRows {
        return nil, repository.ErrURLNotFound
    }

    return &url, err
}
```

### Read Replicas

Read replicas offload the heavy read traffic, URL lookups on every redirect, from the primary database, which must remain available for writes. The `ReadReplicaPool` uses an atomic counter for lock-free round-robin selection, distributing reads evenly across replicas without introducing mutex contention on the hot redirect path. A context flag (`read_from_primary`) lets callers opt into read-your-writes consistency immediately after a create or update, avoiding the lag introduced by replication delay.

```go
// replica/read_replica.go
package replica

import (
    "context"
    "database/sql"
    "sync/atomic"
)

// ReadReplicaPool manages read replicas with round-robin selection
type ReadReplicaPool struct {
    primary  *sql.DB
    replicas []*sql.DB
    counter  uint64
}

// NewReadReplicaPool creates a new read replica pool
func NewReadReplicaPool(primary *sql.DB, replicas []*sql.DB) *ReadReplicaPool {
    return &ReadReplicaPool{
        primary:  primary,
        replicas: replicas,
    }
}

// Primary returns the primary database for writes
func (p *ReadReplicaPool) Primary() *sql.DB {
    return p.primary
}

// Replica returns a read replica using round-robin
func (p *ReadReplicaPool) Replica() *sql.DB {
    if len(p.replicas) == 0 {
        return p.primary
    }

    idx := atomic.AddUint64(&p.counter, 1) % uint64(len(p.replicas))
    return p.replicas[idx]
}

// primaryKey is an unexported context key type. Raw string keys are
// collision-prone across packages, which is why go vet flags them.
type primaryKey struct{}

// ReadFromPrimary marks the context so subsequent reads use the
// primary, giving read-your-writes consistency after a create.
func ReadFromPrimary(ctx context.Context) context.Context {
    return context.WithValue(ctx, primaryKey{}, true)
}

// ReplicaWithContext returns a replica with context-aware selection
func (p *ReadReplicaPool) ReplicaWithContext(ctx context.Context) *sql.DB {
    if preferPrimary, ok := ctx.Value(primaryKey{}).(bool); ok && preferPrimary {
        return p.primary
    }
    return p.Replica()
}
```

---

### Junior → FAANG: Sharding and Replication Concepts for Interviews

Horizontal scaling terminology is frequently misunderstood by junior candidates. Getting the definitions right matters because using terms loosely in a FAANG interview signals imprecision in thinking.

**Sharding vs partitioning.** Sharding distributes data across multiple separate databases (different hosts). Partitioning splits data within a single database (different tables or table segments on the same host). The chapter implements sharding: each shard is an independent `sql.DB` instance. PostgreSQL's `PARTITION BY RANGE` in the schema section is partitioning. Know the difference.

**FNV hash routing is deterministic but inflexible.** The `ShardRouter` uses FNV hash modulo the number of shards. This works correctly as long as the number of shards stays constant. If you add a shard, changing the modulus changes the shard assignment for a large fraction of existing keys, and those keys are now on the wrong shard. Consistent hashing solves this by mapping keys to a ring where adding a node only remaps the keys between the new node and its neighbor. Know the trade-off: FNV-modulo is simpler to implement but requires a migration when resharding. Consistent hashing is more complex but enables zero-downtime shard addition.

**Read replicas reduce read load but introduce replication lag.** PostgreSQL streaming replication is asynchronous by default. A write to the primary may take 10-100ms to appear on a replica depending on network latency and replica load. The `ReplicaWithContext` method uses a typed context key (set via `ReadFromPrimary`) to force reads to the primary for "read-your-writes" consistency immediately after a create operation. This pattern is important for correctness: if a user creates a short URL and immediately tries to redirect through it, the redirect lookup must not miss because the replica has not yet received the write.

---

### Senior @ FAANG: Scaling Strategy as an Operational Maturity Model

At L6/L7, scaling is not a single architectural decision. It is a progression through a maturity model, and each tier of scaling introduces new operational complexity that must be planned for.

**Scaling maturity has distinct tiers.** Tier 1: a single PostgreSQL instance with an in-process cache handles up to approximately 10K reads per second. Tier 2: add Redis and read replicas to handle 100K reads per second. Tier 3: add CDN edge caching and connection pooling (PgBouncer) to handle 1M reads per second. Tier 4: add horizontal sharding to handle 10M+ reads per second. Each tier requires different operational tooling, different failure modes, and different runbooks. At FAANG, you document which tier the service is at and what the triggers are for moving to the next tier (for example, "when p99 redirect latency exceeds 50ms at peak, initiate Tier 3 migration").

**Resharding is an operational event that requires a migration plan.** The `ShardedRepository` routes reads and writes using FNV-modulo. Adding a shard requires a migration plan: (1) add the new shard as an empty database instance, (2) run a background migration job that copies the approximately 1/n of rows that will be re-routed to the new shard, (3) switch to dual-write (write to both old and new shards for the migrating key range), (4) verify the new shard has all data, (5) cut over read traffic to the new shard, (6) remove writes to the old shard, (7) verify no traffic and decommission. This six-step migration with verification gates is the standard resharding playbook. Writing it before you need it is the difference between a planned migration and an incident.

**Read replica lag is an observable metric that needs an SLO.** The `ReadReplicaPool` round-robins across replicas without checking their replication lag. A replica that is 5 minutes behind the primary (due to a long-running vacuum or network partition) will serve stale data. Production services monitor `pg_stat_replication.write_lag` on the primary and remove replicas from the pool when lag exceeds a threshold (typically 500ms to 2 seconds for a URL shortener). This requires integration between the replica pool and a health check that queries replication lag. Document the SLO: "Replicas with lag exceeding 1 second are removed from the pool. The service falls back to the primary for reads if all replicas are removed." This is operationally necessary because a replica serving stale data may return "URL not found" for a URL that was just created, causing spurious redirect failures.
