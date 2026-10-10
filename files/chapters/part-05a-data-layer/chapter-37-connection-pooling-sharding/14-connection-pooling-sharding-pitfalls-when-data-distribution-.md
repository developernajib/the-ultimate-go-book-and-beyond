## Connection Pooling & Sharding Pitfalls: When Data Distribution Goes Wrong

### The Connection Pool Exhaustion Cascade

**The Incident**: A high-traffic API had 20 application instances, each with `MaxOpenConns=100`. Total: 2,000 potential connections. The PostgreSQL server was configured for `max_connections=500`. During a traffic spike, pool exhaustion cascaded: the database rejected new connections, Go pools blocked waiting for connections, HTTP handlers timed out, load balancers marked instances unhealthy, and traffic shifted to remaining instances - which then also exhausted. 100% of API requests failed for 15 minutes.

```go
// WRONG: Pool config doesn't account for multiple instances
func setupDB() *sql.DB {
    db, _ := sql.Open("postgres", dsn)
    db.SetMaxOpenConns(100) // x 20 instances = 2000 > 500 max_connections
    return db
}

// CORRECT: Calculate pool size based on total infrastructure
type PoolConfig struct {
    MaxDBConnections    int // PostgreSQL max_connections
    AppInstances        int // Number of app pods/containers
    ReservedConnections int // For superuser, monitoring, migrations
    SafetyMargin        float64 // 0.8 = use 80% of available
}

func calculatePoolSize(cfg PoolConfig) int {
    available := cfg.MaxDBConnections - cfg.ReservedConnections
    perInstance := float64(available) / float64(cfg.AppInstances)
    return int(perInstance * cfg.SafetyMargin)
}

func setupDB(cfg Config) *sql.DB {
    db, _ := sql.Open("postgres", dsn)

    // Calculate appropriate pool size
    poolSize := calculatePoolSize(PoolConfig{
        MaxDBConnections:    500,
        AppInstances:        cfg.ExpectedInstances, // 20
        ReservedConnections: 20,  // monitoring, migrations
        SafetyMargin:        0.8,
    })
    // (500 - 20) / 20 * 0.8 = 19 connections per instance

    db.SetMaxOpenConns(poolSize)
    db.SetMaxIdleConns(poolSize / 2)
    db.SetConnMaxLifetime(30 * time.Minute)
    db.SetConnMaxIdleTime(5 * time.Minute)

    return db
}

// Even better: Use PgBouncer for connection pooling
// PgBouncer config:
// max_client_conn = 10000
// default_pool_size = 50
// min_pool_size = 10
// server_idle_timeout = 600

// App connects to PgBouncer, not directly to PostgreSQL
func setupDBWithPgBouncer() *sql.DB {
    db, _ := sql.Open("postgres", pgbouncerDSN)
    // Can use higher limits since PgBouncer multiplexes
    db.SetMaxOpenConns(200)
    db.SetMaxIdleConns(50)
    return db
}
```

### The Read Replica Stale Data Bug

**The Incident**: An order system routed reads to replicas for performance. A customer placed an order, then immediately viewed their order history. The read hit a replica that was 2 seconds behind. "Order not found." The customer panicked and placed the order again. Double charge. Investigation revealed the replica lag was normal (under SLA), but the application didn't handle it. Over 500 duplicate orders that month.

```go
// WRONG: Always routing reads to replica
type DBRouter struct {
    primary *sql.DB
    replica *sql.DB
}

func (r *DBRouter) GetOrder(ctx context.Context, orderID int64) (*Order, error) {
    return r.queryOrder(ctx, r.replica, orderID) // May be stale!
}

// CORRECT: Read-your-writes consistency
type DBRouter struct {
    primary      *sql.DB
    replica      *sql.DB
    recentWrites *ttlcache.Cache[int64, time.Time] // UserID -> last write time
}

func (r *DBRouter) CreateOrder(ctx context.Context, order *Order) error {
    err := r.insertOrder(ctx, r.primary, order)
    if err == nil {
        // Track that this user has recent writes
        r.recentWrites.Set(order.UserID, time.Now(), 30*time.Second)
    }
    return err
}

func (r *DBRouter) GetOrders(ctx context.Context, userID int64) ([]*Order, error) {
    db := r.selectDB(ctx, userID)
    return r.queryOrders(ctx, db, userID)
}

func (r *DBRouter) selectDB(ctx context.Context, userID int64) *sql.DB {
    // If user has recent writes, read from primary
    if _, ok := r.recentWrites.Get(userID); ok {
        return r.primary
    }

    // Check if context explicitly requests primary
    if readFromPrimary(ctx) {
        return r.primary
    }

    return r.replica
}

// Context-based primary selection for critical reads
type contextKey string
const readPrimaryKey contextKey = "read_primary"

func WithReadPrimary(ctx context.Context) context.Context {
    return context.WithValue(ctx, readPrimaryKey, true)
}

func readFromPrimary(ctx context.Context) bool {
    v, _ := ctx.Value(readPrimaryKey).(bool)
    return v
}

// Usage in handler
func (h *Handler) GetOrder(w http.ResponseWriter, r *http.Request) {
    orderID := parseOrderID(r)
    userID := getUserID(r)

    // Use primary for order just placed (within 30s of creation)
    ctx := r.Context()
    if isRecentOrder(orderID) {
        ctx = WithReadPrimary(ctx)
    }

    order, err := h.db.GetOrder(ctx, orderID)
    // ...
}
```

### The Shard Key Selection Disaster

**The Incident**: A social media platform sharded by `user_id`. Queries for individual users were fast. Then product launched "trending posts" which required aggregating across all users. Every trending query hit all 64 shards. With 1,000 requests/second, that's 64,000 cross-shard queries/second. Latency went from 10ms to 5 seconds. The sharding strategy optimized for writes but destroyed read performance for the most important feature.

```go
// WRONG: Shard key doesn't match query patterns
type UserSharder struct {
    shards []*sql.DB
}

func (s *UserSharder) GetTrendingPosts(ctx context.Context) ([]*Post, error) {
    // Must query ALL shards for trending!
    var allPosts []*Post
    var wg sync.WaitGroup
    var mu sync.Mutex

    for _, shard := range s.shards {
        wg.Add(1)
        go func(db *sql.DB) {
            defer wg.Done()
            posts, _ := queryPosts(ctx, db, "SELECT * FROM posts WHERE created_at > $1 ORDER BY likes DESC LIMIT 100", yesterday)
            mu.Lock()
            allPosts = append(allPosts, posts...)
            mu.Unlock()
        }(shard)
    }
    wg.Wait()

    // Sort and take top 100 from all shards
    sortByLikes(allPosts)
    if len(allPosts) > 100 {
        allPosts = allPosts[:100]
    }
    return allPosts, nil
}

// CORRECT: Hybrid approach with denormalization
type HybridDataLayer struct {
    userShards    []*sql.DB        // Sharded by user_id
    trendingCache *redis.Client    // Pre-computed trending
    searchIndex   *elasticsearch.Client // For cross-shard queries
}

func (h *HybridDataLayer) CreatePost(ctx context.Context, post *Post) error {
    // 1. Write to user's shard
    shard := h.getShardForUser(post.UserID)
    if err := insertPost(ctx, shard, post); err != nil {
        return err
    }

    // 2. Index for search (async)
    go h.searchIndex.Index("posts", post)

    // 3. Update trending candidates (async)
    go h.updateTrendingCandidate(ctx, post)

    return nil
}

func (h *HybridDataLayer) GetTrendingPosts(ctx context.Context) ([]*Post, error) {
    // Read from pre-computed cache (no scatter-gather!)
    postIDs, err := h.trendingCache.ZRevRange(ctx, "trending:posts", 0, 99).Result()
    if err != nil {
        return nil, err
    }

    // Batch fetch posts from their respective shards
    return h.batchGetPosts(ctx, postIDs)
}

func (h *HybridDataLayer) batchGetPosts(ctx context.Context, postIDs []string) ([]*Post, error) {
    // Group by shard
    shardPosts := make(map[int][]string)
    for _, postID := range postIDs {
        userID := extractUserID(postID)
        shardIdx := h.getShardIndex(userID)
        shardPosts[shardIdx] = append(shardPosts[shardIdx], postID)
    }

    // Parallel fetch from each shard
    var wg sync.WaitGroup
    results := make(chan *Post, len(postIDs))

    for shardIdx, ids := range shardPosts {
        wg.Add(1)
        go func(idx int, ids []string) {
            defer wg.Done()
            posts, _ := h.queryPostsByIDs(ctx, h.userShards[idx], ids)
            for _, p := range posts {
                results <- p
            }
        }(shardIdx, ids)
    }

    go func() {
        wg.Wait()
        close(results)
    }()

    var posts []*Post
    for p := range results {
        posts = append(posts, p)
    }
    return posts, nil
}
```

### The Cross-Shard Transaction Nightmare

**The Incident**: A payment system sharded by `user_id`. Transferring money between users required updating two shards. The team implemented 2PC (two-phase commit) manually. During a network partition, one shard committed and the other didn't. $50,000 appeared in one account without leaving the other. The reconciliation took 3 months to sort out all affected transactions.

```go
// WRONG: Manual 2PC across shards
func (s *Sharder) Transfer(ctx context.Context, fromUser, toUser int64, amount int64) error {
    fromShard := s.getShardForUser(fromUser)
    toShard := s.getShardForUser(toUser)

    // Begin both transactions
    fromTx, _ := fromShard.BeginTx(ctx, nil)
    toTx, _ := toShard.BeginTx(ctx, nil)

    // Debit from source
    fromTx.Exec("UPDATE accounts SET balance = balance - $1 WHERE user_id = $2", amount, fromUser)

    // Credit to destination
    toTx.Exec("UPDATE accounts SET balance = balance + $1 WHERE user_id = $2", amount, toUser)

    // Try to commit both - THIS IS NOT ATOMIC!
    if err := fromTx.Commit(); err != nil {
        toTx.Rollback()
        return err
    }
    if err := toTx.Commit(); err != nil {
        // fromTx already committed! Money disappeared!
        return err
    }
    return nil
}

// CORRECT: Saga pattern with compensation
type TransferSaga struct {
    shards     []*sql.DB
    eventStore *EventStore
}

func (s *TransferSaga) Transfer(ctx context.Context, transferID string, fromUser, toUser int64, amount int64) error {
    // Record transfer intent
    if err := s.eventStore.RecordIntent(ctx, TransferIntent{
        ID:       transferID,
        FromUser: fromUser,
        ToUser:   toUser,
        Amount:   amount, // int64 cents
        Status:   "pending",
    }); err != nil {
        return err
    }

    // Step 1: Reserve funds (don't debit yet)
    fromShard := s.getShardForUser(fromUser)
    _, err := fromShard.ExecContext(ctx, `
        UPDATE accounts
        SET reserved = reserved + $1
        WHERE user_id = $2 AND balance - reserved >= $1
    `, amount, fromUser)
    if err != nil {
        s.eventStore.UpdateStatus(ctx, transferID, "failed", "insufficient funds")
        return ErrInsufficientFunds
    }

    s.eventStore.UpdateStatus(ctx, transferID, "reserved", "")

    // Step 2: Credit destination
    toShard := s.getShardForUser(toUser)
    _, err = toShard.ExecContext(ctx, `
        UPDATE accounts SET balance = balance + $1 WHERE user_id = $2
    `, amount, toUser)
    if err != nil {
        // Compensate: release reservation
        fromShard.ExecContext(ctx, `
            UPDATE accounts SET reserved = reserved - $1 WHERE user_id = $2
        `, amount, fromUser)
        s.eventStore.UpdateStatus(ctx, transferID, "failed", err.Error())
        return err
    }

    s.eventStore.UpdateStatus(ctx, transferID, "credited", "")

    // Step 3: Complete debit (move from reserved to spent)
    _, err = fromShard.ExecContext(ctx, `
        UPDATE accounts
        SET balance = balance - $1, reserved = reserved - $1
        WHERE user_id = $2
    `, amount, fromUser)
    if err != nil {
        // Compensate: reverse credit
        toShard.ExecContext(ctx, `
            UPDATE accounts SET balance = balance - $1 WHERE user_id = $2
        `, amount, toUser)
        fromShard.ExecContext(ctx, `
            UPDATE accounts SET reserved = reserved - $1 WHERE user_id = $2
        `, amount, fromUser)
        s.eventStore.UpdateStatus(ctx, transferID, "failed", err.Error())
        return err
    }

    s.eventStore.UpdateStatus(ctx, transferID, "completed", "")
    return nil
}

// Background worker reconciles incomplete transfers
func (s *TransferSaga) ReconcileIncomplete(ctx context.Context) error {
    pending, _ := s.eventStore.GetByStatus(ctx, "reserved", 5*time.Minute)
    for _, transfer := range pending {
        // Check if credit happened
        // If yes: complete. If no: compensate.
        s.reconcile(ctx, transfer)
    }
    return nil
}
```

### Quick Reference: Connection Pooling & Sharding Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Pool exhaustion cascade | All instances fail together | Calculate pool per max_connections/instances |
| Replica stale reads | Users see old data | Read-your-writes consistency |
| Wrong shard key | Cross-shard queries everywhere | Match shard key to query patterns |
| Cross-shard transactions | Partial commits, inconsistency | Saga pattern with compensation |
| Hot shards | Uneven load distribution | Hash-based sharding, consistent hashing |
| Resharding data loss | Data lost during migration | Dual-write period, verification |
| Connection leaks | Pool grows, DB overloaded | Proper Close(), connection max lifetime |
| Shard discovery | Stale shard map | Service discovery, config refresh |

### Junior → FAANG: Reading Incident Reports as a Career Skill

Every pitfall above is a lightly disguised real incident. In your first year at a FAANG, your best learning loop is to read the public post-mortems, map them onto these patterns, and present one in your team's weekly reading group. You will compound faster from one careful read of the GitHub 2018 incident post-mortem than from a month of LeetCode.

Worked example. Read the pool-exhaustion cascade above and then read the Robinhood March 2020 outage report. The mechanics are identical. The market opens, traffic spikes, DB connections saturate, pool waits cascade into upstream timeouts, upstream retries amplify load, every downstream degrades. If you can draw this diagram on a whiteboard without notes, you are at the bar for a mid-level SRE interview.

First-job context for the stale-read incident. The "customer placed order then saw empty history" pattern is the single most common replica-lag bug in ecommerce. You will encounter it. The fix is not "read from primary for everything." The fix is the typed session API shown in the senior sections earlier, or the simpler recent-writes cache shown in the CORRECT snippet above. Know the difference, the session API scales to any write type, the cache only handles per-user read-your-writes.

"Why did this fail?" reflex applied to the shard-key disaster. A junior reads this and concludes "I should shard by post_id then." A mid-level reads this and concludes "I need to know the top 5 queries before I pick a shard key." A senior reads this and concludes "the analytics query pattern was wrong for an OLTP shard scheme, and the fix is to off-load trending to a precomputed materialized view, not to reshard." The senior answer is the right one because resharding a live 64-shard cluster to fix a read pattern is a 6-month project, while building a Redis sorted set of trending candidates is a 2-week project.

Worked example on the cross-shard transfer nightmare. The saga code above is correct but incomplete. Ask yourself what happens if the process crashes between Step 2 (credit destination) and Step 3 (complete debit). The reconciliation worker must detect this state and either retry Step 3 or compensate Step 2. Draw the state diagram, identify every crash point, write the recovery action for each. If you cannot do this exercise for a saga, do not ship a saga.

### Senior @ FAANG: Incident Reports, Maturity Model, and the Database-Platform Charter

The four pitfalls above are not engineering problems, they are program problems. Each one has been shipped by a FAANG-tier company in the last five years despite having engineers who knew better. The senior job is to understand why strong teams ship these pitfalls anyway, and to build the guardrails that make it structurally impossible.

Incident report lens, Notion's 2021 sharding rollout. Notion migrated from a single Postgres to a sharded topology, 480 logical shards spread across 32 physical instances, keyed by workspace_id (a natural fit for their block data model). A rollout of that size surfaces the failure modes you will recognize from the pitfalls above. Pool sizing done per-shard as if each shard were independent multiplies the connection count on the shared PgBouncer tier. Dual-write lag produces user-visible "not found" errors during cutover windows, when reads reach the new shard before the async backfill lands. And reshard tooling that ignores Postgres `VACUUM` pressure on the source lets source-side IOPS saturate and degrade user-facing writes. The governance lessons are per-rollout pool budgeting, cutover gated on backfill-lag reaching zero, and source-side load budgeting (cap backfill at a fraction of source IOPS).

Incident report lens, Vitess resharding in large MySQL fleets. Companies that run Vitess across thousands of shards (Slack and YouTube among them) have hit resharding incidents caused by VReplication lag during cutover combined with schema changes landing in the same window. The pattern is a DDL migration lands on the source, VReplication replays it on the target, the replay is slower than expected, and the cutover trigger fires on row-count match while schemas still diverge. The remediations that generalize are a strict change-freeze window around any reshard and a two-signal cutover gate (row-count AND schema-hash match). Ship both in your reshard workflow.

Incident report lens, Discord message ordering. Discord migrated from Cassandra to ScyllaDB in 2022 and documented the migration in detail. The relevant lesson for sharding is not the tech choice, it is that their original Cassandra shard scheme put all messages for a channel in one partition, and hot channels (100k+ members) produced unbounded partitions that broke compaction. The fix was to bucket by `channel_id + time_bucket`, limiting partition size. The governance lesson is that shard keys must bound worst-case partition size, not just distribute average load. Review every shard-key ADR for the question "what is the 99.9p partition size in 2 years."

Incident report lens, replica lag as a correctness bug. A common read-your-writes failure: a user performs a write and a moment later a read hits a lagging replica, so their own change appears missing for a few seconds. The remediation is a lag-aware read router that checks replica lag before routing, a small default lag threshold, and a fallback to primary when all replicas exceed it. GitHub's open-source `freno` is prior art for lag-based throttling. The governance lesson is that replica-lag blindness is a correctness bug, not a performance bug, and replica-lag observability must be a P0 signal with paging.

Maturity model, data-distribution dimension. L1, single database, no pool configuration, no replicas. L2, single database with a pool and one async replica, reads go to replica unconditionally (stale-read bugs present). L3, typed session API for read-your-writes, pool sizing computed from server capacity, bounded pool with acquire timeouts. L4, sharded topology with dedicated shard-routing library, consistent hashing with vNodes, saga pattern for cross-shard writes, dual-write tooling for reshards. L5, self-service sharded platform with automated rebalancing, shard-key review as a schema-review step, resharding as a Temporal workflow, replica-lag gating as a platform primitive. L6, control plane that manages pool sizing dynamically across 400 services, per-tenant shard isolation for large customers, continuous rebalancing based on observed hot-spot signals, and a published SLO catalog covering p99 query latency, stale-read bound, and reshard blast radius.

Platform team charter for the database-platform org. Ownership, the shared client library, the shard-routing library, the reshard workflow, the observability stack, and the on-call rotation. Charter principles, application teams do not configure pools directly, application teams do not implement their own shard routers, application teams do not run their own cross-shard transactions. Exceptions require written sign-off from the platform lead and a 90-day review. Budgeted work, 30 percent on library improvements, 30 percent on active reshard programs, 20 percent on observability and tooling, 20 percent on on-call and incident response. Non-budgeted work, emergency migrations triggered by customer incidents (tracked separately and capped at 10 percent of total capacity).

Bar-raiser synthesis question. "You join as a staff engineer on database-platform. The company runs 400 Go services against 50 Postgres clusters, no shared client library, no shard-routing library, every team has rolled their own. You have 18 months. What do you build first." Strong answer picks observability first (you cannot improve what you cannot measure), then the shared client library with typed sessions and bounded pools (catches 80 percent of incidents with minimal team disruption), then the shard-routing library (used by the 10 largest services first). Weak answer starts with the reshard workflow because it is the most technically interesting. The point of the question is to see whether the candidate picks leverage over novelty. Leverage wins.

---
