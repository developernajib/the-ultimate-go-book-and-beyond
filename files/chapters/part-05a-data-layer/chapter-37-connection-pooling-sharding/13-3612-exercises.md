## 37.12 Guided Exercises and Solutions

### Exercise 1: Build an Adaptive Connection Pool

Build a connection pool that automatically adjusts size based on load:

**Solution:**

```go
package pool

import (
    "context"
    "database/sql"
    "log/slog"
    "sync"
    "time"
)

// AdaptivePool adjusts pool size based on demand
type AdaptivePool struct {
    db          *sql.DB
    minConns    int
    maxConns    int
    targetUtil  float64 // Target utilization (e.g., 0.7)
    currentMax  int
    mu          sync.RWMutex
    logger      *slog.Logger
}

// NewAdaptivePool creates an adaptive connection pool
func NewAdaptivePool(dsn string, minConns, maxConns int, targetUtil float64, logger *slog.Logger) (*AdaptivePool, error) {
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, err
    }

    pool := &AdaptivePool{
        db:         db,
        minConns:   minConns,
        maxConns:   maxConns,
        targetUtil: targetUtil,
        currentMax: minConns,
        logger:     logger,
    }

    // Start with minimum
    db.SetMaxOpenConns(minConns)
    db.SetMaxIdleConns(minConns / 2)
    db.SetConnMaxLifetime(5 * time.Minute)

    return pool, nil
}

// Monitor starts the adaptive monitoring loop
func (p *AdaptivePool) Monitor(ctx context.Context, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            p.adjust()
        }
    }
}

func (p *AdaptivePool) adjust() {
    stats := p.db.Stats()

    currentMax := stats.MaxOpenConnections
    inUse := stats.InUse
    waitCount := stats.WaitCount

    utilization := float64(inUse) / float64(currentMax)

    p.mu.Lock()
    defer p.mu.Unlock()

    var newMax int

    // Scale up if utilization high or queries waiting
    if utilization > p.targetUtil || waitCount > 0 {
        // Increase by 25%
        newMax = int(float64(currentMax) * 1.25)
        if newMax > p.maxConns {
            newMax = p.maxConns
        }
        p.logger.Info("scaling up pool",
            "old_max", currentMax,
            "new_max", newMax,
            "utilization", utilization,
            "wait_count", waitCount,
        )
    } else if utilization < p.targetUtil*0.5 && currentMax > p.minConns {
        // Scale down if very underutilized
        newMax = int(float64(currentMax) * 0.75)
        if newMax < p.minConns {
            newMax = p.minConns
        }
        p.logger.Info("scaling down pool",
            "old_max", currentMax,
            "new_max", newMax,
            "utilization", utilization,
        )
    } else {
        return // No change needed
    }

    if newMax != currentMax {
        p.db.SetMaxOpenConns(newMax)
        p.db.SetMaxIdleConns(newMax / 2)
        p.currentMax = newMax
    }
}

// GetStats returns current pool statistics
func (p *AdaptivePool) GetStats() PoolStats {
    stats := p.db.Stats()
    return PoolStats{
        MaxOpen:     stats.MaxOpenConnections,
        Open:        stats.OpenConnections,
        InUse:       stats.InUse,
        Idle:        stats.Idle,
        WaitCount:   stats.WaitCount,
        WaitDuration: stats.WaitDuration,
    }
}

type PoolStats struct {
    MaxOpen      int
    Open         int
    InUse        int
    Idle         int
    WaitCount    int64
    WaitDuration time.Duration
}

// DB returns the underlying database connection
func (p *AdaptivePool) DB() *sql.DB {
    return p.db
}

// Close closes the pool
func (p *AdaptivePool) Close() error {
    return p.db.Close()
}
```

### Exercise 2: Implement Shard Rebalancing

Implement a system to rebalance data when adding a new shard:

**Solution:**

```go
package rebalance

import (
    "context"
    "database/sql"
    "fmt"
    "hash/fnv"
    "log/slog"
    "sync"
    "sync/atomic"
    "time"
)

// Rebalancer handles shard rebalancing
type Rebalancer struct {
    shards    []*sql.DB
    newShards []*sql.DB
    logger    *slog.Logger

    // State
    phase     atomic.Int32
    progress  atomic.Int64
    total     atomic.Int64

    // Control
    batchSize int
    workers   int
}

type RebalancePhase int32

const (
    PhaseIdle RebalancePhase = iota
    PhaseDualWrite
    PhaseCopying
    PhaseVerifying
    PhaseSwitching
    PhaseComplete
)

// NewRebalancer creates a new rebalancer
func NewRebalancer(shards []*sql.DB, logger *slog.Logger) *Rebalancer {
    return &Rebalancer{
        shards:    shards,
        logger:    logger,
        batchSize: 1000,
        workers:   4,
    }
}

// AddShards adds new shards and starts rebalancing
func (r *Rebalancer) AddShards(ctx context.Context, newShards []*sql.DB) error {
    r.newShards = append(r.shards, newShards...)

    // Phase 1: Start dual-write
    r.phase.Store(int32(PhaseDualWrite))
    r.logger.Info("rebalance started", "new_shard_count", len(r.newShards))

    // Phase 2: Copy existing data
    r.phase.Store(int32(PhaseCopying))
    if err := r.copyData(ctx); err != nil {
        return fmt.Errorf("copy failed: %w", err)
    }

    // Phase 3: Verify data
    r.phase.Store(int32(PhaseVerifying))
    if err := r.verify(ctx); err != nil {
        return fmt.Errorf("verify failed: %w", err)
    }

    // Phase 4: Switch to new shard mapping
    r.phase.Store(int32(PhaseSwitching))
    r.shards = r.newShards
    r.newShards = nil

    // Phase 5: Complete
    r.phase.Store(int32(PhaseComplete))
    r.logger.Info("rebalance complete")

    return nil
}

func (r *Rebalancer) copyData(ctx context.Context) error {
    // Count total rows to copy
    var total int64
    for _, shard := range r.shards {
        var count int64
        shard.QueryRowContext(ctx, "SELECT COUNT(*) FROM data").Scan(&count)
        total += count
    }
    r.total.Store(total)

    // Copy from each old shard
    var wg sync.WaitGroup
    errCh := make(chan error, len(r.shards))

    for _, oldShard := range r.shards {
        wg.Add(1)
        go func(shard *sql.DB) {
            defer wg.Done()
            if err := r.copyFromShard(ctx, shard); err != nil {
                errCh <- err
            }
        }(oldShard)
    }

    wg.Wait()
    close(errCh)

    for err := range errCh {
        if err != nil {
            return err
        }
    }

    return nil
}

func (r *Rebalancer) copyFromShard(ctx context.Context, oldShard *sql.DB) error {
    var lastID int64

    for {
        // Fetch batch
        rows, err := oldShard.QueryContext(ctx, `
            SELECT id, shard_key, data FROM data
            WHERE id > $1
            ORDER BY id
            LIMIT $2
        `, lastID, r.batchSize)
        if err != nil {
            return err
        }

        var batch []struct {
            ID       int64
            ShardKey string
            Data     []byte
        }

        for rows.Next() {
            var row struct {
                ID       int64
                ShardKey string
                Data     []byte
            }
            if err := rows.Scan(&row.ID, &row.ShardKey, &row.Data); err != nil {
                rows.Close()
                return err
            }
            batch = append(batch, row)
            lastID = row.ID
        }
        rows.Close()

        if len(batch) == 0 {
            break // No more rows
        }

        // Write to new shard locations
        for _, row := range batch {
            newShardIdx := r.getNewShardIndex(row.ShardKey)
            newShard := r.newShards[newShardIdx]

            _, err := newShard.ExecContext(ctx, `
                INSERT INTO data (id, shard_key, data)
                VALUES ($1, $2, $3)
                ON CONFLICT (id) DO NOTHING
            `, row.ID, row.ShardKey, row.Data)
            if err != nil {
                return err
            }
        }

        r.progress.Add(int64(len(batch)))

        r.logger.Debug("copy progress",
            "progress", r.progress.Load(),
            "total", r.total.Load(),
        )

        // Small delay to reduce impact
        time.Sleep(10 * time.Millisecond)
    }

    return nil
}

func (r *Rebalancer) verify(ctx context.Context) error {
    // Sample verification - check random rows
    sampleSize := 1000
    verified := 0

    for i := 0; i < sampleSize; i++ {
        // Pick random old shard and row
        oldShardIdx := i % len(r.shards)
        oldShard := r.shards[oldShardIdx]

        var id int64
        var shardKey string
        var data []byte

        err := oldShard.QueryRowContext(ctx, `
            SELECT id, shard_key, data FROM data
            ORDER BY RANDOM() LIMIT 1
        `).Scan(&id, &shardKey, &data)
        if err != nil {
            continue
        }

        // Verify in new location
        newShardIdx := r.getNewShardIndex(shardKey)
        newShard := r.newShards[newShardIdx]

        var newData []byte
        err = newShard.QueryRowContext(ctx,
            "SELECT data FROM data WHERE id = $1",
            id,
        ).Scan(&newData)
        if err != nil {
            return fmt.Errorf("row %d missing in new shard %d", id, newShardIdx)
        }

        if string(data) != string(newData) {
            return fmt.Errorf("row %d data mismatch", id)
        }

        verified++
    }

    r.logger.Info("verification complete", "verified", verified)
    return nil
}

func (r *Rebalancer) getNewShardIndex(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32()) % len(r.newShards)
}

// GetProgress returns rebalancing progress
func (r *Rebalancer) GetProgress() (phase RebalancePhase, progress, total int64) {
    return RebalancePhase(r.phase.Load()), r.progress.Load(), r.total.Load()
}

// IsDualWriteActive returns true during dual-write phase
func (r *Rebalancer) IsDualWriteActive() bool {
    phase := RebalancePhase(r.phase.Load())
    return phase == PhaseDualWrite || phase == PhaseCopying || phase == PhaseVerifying
}

// GetShardForWrite returns the shard(s) for writing
func (r *Rebalancer) GetShardForWrite(key string) []*sql.DB {
    if !r.IsDualWriteActive() {
        // Normal operation - single shard
        idx := r.getNewShardIndex(key)
        return []*sql.DB{r.shards[idx]}
    }

    // Dual-write: write to both old and new locations
    oldIdx := r.getOldShardIndex(key)
    newIdx := r.getNewShardIndex(key)

    if oldIdx == newIdx {
        return []*sql.DB{r.shards[oldIdx]}
    }

    return []*sql.DB{r.shards[oldIdx], r.newShards[newIdx]}
}

func (r *Rebalancer) getOldShardIndex(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32()) % len(r.shards)
}
```

### Junior → FAANG: Prerequisite Gaps, Worked Extensions, and "Why Did This Fail?" Drills

Before running either exercise as-is, notice what they do not do. Exercise 1 reads `db.Stats()` but never distinguishes "pool full because legitimate traffic" from "pool full because a single slow query is holding 20 connections." Exercise 2 uses plain modulo hashing, so adding one shard remaps almost all keys. These are intentional gaps. A junior engineer who ships Exercise 2 to production has reinvented the classic resharding meltdown from first principles: add one node and watch almost every key remap at once. Work through the extensions below before you claim either exercise is done.

Worked extension for Exercise 1. Add a feedback term from Postgres-side metrics. Query `pg_stat_activity` for `count(*) WHERE state = 'active' AND query_start < now() - interval '1 second'`. If that count exceeds `0.5 * MaxOpenConnections`, the pool is backed up on a slow query, not on capacity. Scaling up in that state is wrong, it adds more slow queries. The adaptive controller should decline to scale in that case and emit a metric `pool.scale_declined_slow_queries_total`. This is the bar between L4 and L5 on an adaptive-pool exercise.

Worked extension for Exercise 2. Replace modulo with consistent hashing with 128 vNodes per physical shard. Import `github.com/buraksezer/consistent` or implement the ring yourself. Measure the key movement when adding a shard. With modulo going from 4 to 5 shards, 80 percent of keys move. With consistent hashing and 128 vNodes, roughly 20 percent move. The difference is 4x less backfill traffic, 4x less dual-write divergence risk, and 4x shorter rebalance window.

First-job context. Most teams will never ask you to build these from scratch. They will ask you to operate them, which means reading the metrics, recognizing the failure modes, and filing the right JIRA when the adaptive pool oscillates. Run Exercise 1 with a load generator that produces spiky traffic (30 seconds of 1000 QPS, 30 seconds of 10 QPS) and watch the pool size oscillate. The fix is hysteresis, scale up fast but scale down slow (a 5-minute exponential decay). This is the same pattern HPA uses in Kubernetes and for the same reason.

"Why did this fail?" drill 1. You run Exercise 1 in production and the pool never scales down. Why. Answer, `db.Stats().InUse` includes connections held by long-running BEGIN blocks, so utilization never drops below target. Fix, sample utilization over a 5-minute window and use the minimum, not the instantaneous value.

"Why did this fail?" drill 2. You run Exercise 2 and verification fails on 0.1 percent of rows. Why. Answer, dual-write writes both old and new, but a row updated during backfill can land in the new shard before the backfill writer overwrites it with stale data. Fix, backfill uses `ON CONFLICT DO NOTHING` (which the code does) but also requires that dual-write carries a monotonic version or timestamp, and verification compares the latest version.

### Senior @ FAANG: Staff-Level Extensions, Shard-Aware Repository Pattern, and Resharding Choreography

At staff level these exercises are starter kits. The real artifacts are the library, the repository pattern, and the choreographed rollout. Below are the three extensions I would expect a candidate for L6 to produce in a take-home or a design round.

Staff extension 1, bounded-load consistent hash library. The naive consistent-hash ring with 128 vNodes still produces roughly 1.5x to 2x load imbalance in the worst case because vNode placement is random. Implement the Google 2016 paper "Consistent Hashing with Bounded Loads" (Mirrokni, Thorup, Zadimoghaddam). The algorithm caps each shard at `(1 + epsilon) * average_load` and redirects overflow to the next shard in the ring. Epsilon at 0.25 gives a proven worst-case imbalance of 25 percent while keeping key movement on resize at `O(1/epsilon^2)` of the average shard. Google's Cloud Pub/Sub and Vimeo's load balancer are documented users, and `github.com/lafikl/consistent` is a Go implementation of the algorithm. Fork it, add vNodes, add tenant-affinity overrides for the celebrity problem, and add observability (per-shard load gauge, rebalance count, redirect depth histogram). This is the shape of a real platform library.

Staff extension 2, shard-aware repository pattern. Exercise 2 mixes routing, migration state, and data access in one struct. Split it. Define a `Router` interface that takes a shard key and a query class and returns a `*sql.DB` plus a `Placement` value that records which logical shard this physical handle represents. Define a `Repository[T]` generic that accepts a `Router` and exposes typed `Find`, `Save`, `Delete`, `Scan` operations. The repository refuses cross-shard operations at the type level by requiring a shard key parameter on every method. Queries that cannot express a shard key (`ScanAll`) return an iterator that explicitly fans out and documents the cost. This is the shape I would ship as the canonical shard-aware data layer. It makes misuse a compile error.

```go
type Router interface {
    RouteByKey(key string, class QueryClass) (*sql.DB, Placement, error)
    FanOut(class QueryClass) ([]FanOutTarget, error)
}

type QueryClass int

const (
    ClassReadFresh QueryClass = iota
    ClassReadStale
    ClassWrite
    ClassAnalytics
)

type Repository[T any] struct {
    router Router
    table  string
    scan   func(*sql.Rows) (T, error)
}

func (r *Repository[T]) FindByShardKey(ctx context.Context, key string, id int64) (T, error) {
    db, placement, err := r.router.RouteByKey(key, ClassReadFresh)
    if err != nil {
        var zero T
        return zero, err
    }
    row := db.QueryRowContext(ctx, "SELECT * FROM "+r.table+" WHERE id = $1", id)
    t, err := r.scanRow(row)
    observeQuery(placement, "find", err)
    return t, err
}
```

Staff extension 3, resharding choreography with a state machine. Exercise 2 runs phases inline, which is wrong at scale. Real reshards take weeks and must survive operator shifts, coordinator crashes, and partial failures per vNode. Model the reshard as a Temporal workflow with per-vNode child workflows. Each child owns one vNode through states `Prepared`, `DualWriteActive`, `Backfilling`, `BackfillComplete`, `Verified`, `CutoverReads`, `CutoverWrites`, `Drained`, `Deleted`. Transitions require explicit operator approval between `Verified` and `CutoverReads`. Each state persists to the workflow history so a crash resumes exactly where it left off. The parent workflow schedules children at a rate that respects global backfill budget (for example, no more than 3 vNodes cutting over reads in a 24-hour window). Governance requires an operational runbook per state documenting the rollback action. This is the pattern Vitess VReplication implements and the pattern that distinguishes a production-ready reshard from a demo.

Governance notes for these exercises. The adaptive pool (Exercise 1) should never ship without a kill switch that pins `MaxOpenConns` to a static value. Adaptive systems that cannot be turned off during incidents are liabilities. The resharding tool (Exercise 2) should never ship without a verification gate that blocks cutover on any checksum mismatch and requires written sign-off from the data-platform on-call. Put both in the platform-team charter, document them in the service-owner runbook, and enforce them in the deploy pipeline.

Platform-team charter entry. The database-platform team owns the adaptive pool library, the consistent-hash router library, the repository pattern, the reshard workflow, and the observability stack that surfaces pool health and shard balance. Application teams consume these, they do not reimplement. The charter specifies a 30-day SLA for new feature requests, a two-quarter deprecation window for API changes, and a 24x7 on-call during any active reshard. Without this charter, every service builds its own pool sizing and shard router, and your company rediscovers all five common mistakes in 400 independent voices.

---
