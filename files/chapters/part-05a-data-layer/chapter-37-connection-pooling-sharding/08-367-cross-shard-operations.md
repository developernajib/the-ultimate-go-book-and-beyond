## 37.7 Cross-Shard Operations

### The First Rule: Don't Do Cross-Shard Transactions

Before any code, internalize this: **if your application requires cross-shard ACID transactions, your shard key is wrong**. Production teams at Shopify, Pinterest, Instagram, and Slack all say the same thing: redesign to keep related data on one shard, or accept eventual consistency. Two-phase commit (2PC) is in this chapter for completeness, but it is the tool of last resort because:

- **Blocking on coordinator failure**: if the coordinator crashes between PREPARE and COMMIT, participant shards hold locks on prepared transactions indefinitely. Postgres `prepared_transactions` can pin WAL and block autovacuum, snowballing into a primary outage.
- **Latency**: 2PC requires two round-trips (prepare + commit) to every participant. P99 latency is dominated by the slowest shard.
- **Availability**: CAP strikes. During a partition, 2PC chooses consistency and refuses writes. A saga with idempotent compensations keeps accepting work.

**The production playbook (ordered):**

1. **Denormalize** - duplicate the data you need on both shards so the transaction touches only one. Disk is cheap, distributed coordination is not.
2. **Saga pattern** - model the workflow as a sequence of local transactions with compensating actions for rollback. Used by DoorDash for order fulfillment, by banks for transfers. Implement with a durable workflow engine (Temporal is the de-facto standard in Go).
3. **Outbox pattern** - write the business record and an "event to publish" row in the same local transaction, then a separate process drains the outbox to the other shard/service. Guarantees at-least-once delivery with idempotent consumers.
4. **2PC** - only when you truly need ACID across shards and cannot denormalize. Use sparingly, with aggressive timeouts, and monitor `pg_prepared_xacts` religiously.

### Cross-Shard Transactions (2PC)

A database transaction groups multiple statements into an atomic unit of work: either all succeed and commit, or all fail and roll back. In Go, transactions begin with `db.BeginTx`, and a deferred function checks the error to call either `tx.Commit` or `tx.Rollback`.

```go
package sharding

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
    "time"
)

// TwoPhaseCommit implements 2PC for cross-shard transactions
type TwoPhaseCommit struct {
    router *ShardRouter
}

func NewTwoPhaseCommit(router *ShardRouter) *TwoPhaseCommit {
    return &TwoPhaseCommit{router: router}
}

// Transaction holds state for cross-shard transaction
type Transaction struct {
    id     string
    txns   map[int]*sql.Tx
    shards map[int]*sql.DB
}

// Begin starts transactions on specified shards
func (tpc *TwoPhaseCommit) Begin(ctx context.Context, shardIndexes []int) (*Transaction, error) {
    tx := &Transaction{
        id:     generateTxID(),
        txns:   make(map[int]*sql.Tx),
        shards: make(map[int]*sql.DB),
    }

    for _, idx := range shardIndexes {
        shard := tpc.router.GetShardByIndex(idx)
        tx.shards[idx] = shard

        sqlTx, err := shard.BeginTx(ctx, nil)
        if err != nil {
            // Rollback already started transactions
            tx.Rollback(ctx)
            return nil, fmt.Errorf("begin on shard %d: %w", idx, err)
        }
        tx.txns[idx] = sqlTx
    }

    return tx, nil
}

// Exec executes on a specific shard
func (t *Transaction) Exec(ctx context.Context, shardIdx int, query string, args ...any) (sql.Result, error) {
    tx, ok := t.txns[shardIdx]
    if !ok {
        return nil, fmt.Errorf("no transaction for shard %d", shardIdx)
    }
    return tx.ExecContext(ctx, query, args...)
}

// Prepare phase - prepare all shards
func (t *Transaction) Prepare(ctx context.Context) error {
    var wg sync.WaitGroup
    errors := make(chan error, len(t.txns))

    for idx, tx := range t.txns {
        wg.Add(1)
        go func(idx int, tx *sql.Tx) {
            defer wg.Done()
            // PostgreSQL: PREPARE TRANSACTION
            _, err := tx.ExecContext(ctx, fmt.Sprintf("PREPARE TRANSACTION '%s_%d'", t.id, idx))
            if err != nil {
                errors <- fmt.Errorf("prepare on shard %d: %w", idx, err)
            }
        }(idx, tx)
    }

    wg.Wait()
    close(errors)

    for err := range errors {
        if err != nil {
            // Rollback prepared transactions
            t.RollbackPrepared(ctx)
            return err
        }
    }

    return nil
}

// Commit phase - commit all prepared transactions
func (t *Transaction) Commit(ctx context.Context) error {
    var wg sync.WaitGroup
    errors := make(chan error, len(t.shards))

    for idx, shard := range t.shards {
        wg.Add(1)
        go func(idx int, db *sql.DB) {
            defer wg.Done()
            _, err := db.ExecContext(ctx, fmt.Sprintf("COMMIT PREPARED '%s_%d'", t.id, idx))
            if err != nil {
                errors <- fmt.Errorf("commit on shard %d: %w", idx, err)
            }
        }(idx, shard)
    }

    wg.Wait()
    close(errors)

    for err := range errors {
        if err != nil {
            return err
        }
    }

    return nil
}

// Rollback rolls back all transactions
func (t *Transaction) Rollback(ctx context.Context) {
    for _, tx := range t.txns {
        tx.Rollback()
    }
}

// RollbackPrepared rolls back prepared transactions
func (t *Transaction) RollbackPrepared(ctx context.Context) {
    for idx, shard := range t.shards {
        shard.ExecContext(ctx, fmt.Sprintf("ROLLBACK PREPARED '%s_%d'", t.id, idx))
    }
}

func generateTxID() string {
    return fmt.Sprintf("tx_%d", time.Now().UnixNano())
}
```

### Scatter-Gather Pattern

When a query cannot be routed to a single shard, for example, a global search or an aggregate count, the application must fan the query out to every shard, collect the partial results, and merge them. Scatter-gather has a brutal economic property: **P99 latency is the max over all shards, and tail latencies amplify**. With 10 shards each at P99=50ms, the scatter-gather P99 is ~150ms because you are sampling from the tail 10 times. At 100 shards, every query hits the slow shard.

**Mitigations used in production:**

- **Hedging/speculative retries**: after the median shard latency, issue a duplicate request to the same shard's read replica. Cancel whichever loses. Cuts tail latency by 30-50%.
- **Denormalized read models**: precompute the global aggregate into a Redis counter or a dedicated analytics shard (ClickHouse, Druid). Use scatter-gather only for cache miss / backfill.
- **Bounded fan-out**: route queries by a secondary index to a subset of shards. Instagram's feed uses per-user "inbox" tables so the timeline query hits one shard, not all.
- **Cancellation propagation**: pass the request context to every shard goroutine and respect `ctx.Err()`. When the HTTP client times out, in-flight shard queries should cancel immediately - otherwise you burn database capacity on results nobody will read.

The `ScatterGather` struct below sends the same query to all shards concurrently using one goroutine per shard, then provides helpers for common merge strategies: summing counts, and performing a merge-sort across sorted per-shard result sets with a global limit.

```go
package sharding

import (
    "context"
    "database/sql"
    "sort"
    "sync"
)

// ScatterGather executes queries across all shards and aggregates results
type ScatterGather struct {
    router *ShardRouter
}

func NewScatterGather(router *ShardRouter) *ScatterGather {
    return &ScatterGather{router: router}
}

// Result from a single shard
type ShardResult struct {
    ShardIndex int
    Rows       *sql.Rows
    Error      error
}

// Query executes on all shards concurrently
func (sg *ScatterGather) Query(ctx context.Context, query string, args ...any) []ShardResult {
    shards := sg.router.AllShards()
    results := make([]ShardResult, len(shards))

    var wg sync.WaitGroup
    for i, shard := range shards {
        wg.Add(1)
        go func(idx int, db *sql.DB) {
            defer wg.Done()
            rows, err := db.QueryContext(ctx, query, args...)
            results[idx] = ShardResult{
                ShardIndex: idx,
                Rows:       rows,
                Error:      err,
            }
        }(i, shard)
    }

    wg.Wait()
    return results
}

// AggregateCount sums counts from all shards
func (sg *ScatterGather) AggregateCount(ctx context.Context, query string, args ...any) (int64, error) {
    results := sg.Query(ctx, query, args...)

    var total int64
    for _, result := range results {
        if result.Error != nil {
            return 0, result.Error
        }
        defer result.Rows.Close()

        if result.Rows.Next() {
            var count int64
            if err := result.Rows.Scan(&count); err != nil {
                return 0, err
            }
            total += count
        }
    }

    return total, nil
}

// MergeSort merges sorted results from all shards
func (sg *ScatterGather) MergeSort(
    ctx context.Context,
    query string,
    scanRow func(*sql.Rows) (any, error),
    less func(a, b any) bool,
    limit int,
    args ...any,
) ([]any, error) {
    results := sg.Query(ctx, query, args...)

    // Collect all results
    var allItems []any
    for _, result := range results {
        if result.Error != nil {
            return nil, result.Error
        }
        defer result.Rows.Close()

        for result.Rows.Next() {
            item, err := scanRow(result.Rows)
            if err != nil {
                return nil, err
            }
            allItems = append(allItems, item)
        }
    }

    // Sort all results
    sort.Slice(allItems, func(i, j int) bool {
        return less(allItems[i], allItems[j])
    })

    // Apply limit
    if limit > 0 && len(allItems) > limit {
        allItems = allItems[:limit]
    }

    return allItems, nil
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

Cross shard operations are where junior engineers first learn that distributed systems do not have transactions the way textbooks describe them. If you try to wrap two shards in a single `BEGIN` to `COMMIT` block and one of them fails between, you have half committed state and no way to undo it cleanly. That is the entire motivation for two phase commit, sagas, and the outbox pattern.

A worked example to anchor intuition. A user transfers 50 dollars from their checking account on shard 3 to their savings account on shard 7. Three things could happen. One, you use 2PC, both shards prepare, both commit, and if the coordinator crashes between prepare and commit you have an operational incident where DBAs manually resolve prepared transactions. Two, you use a saga: debit checking on shard 3 in a local transaction, write an event, a worker consumes the event and credits savings on shard 7, if the credit fails you publish a compensating event that re credits checking. The user may briefly see 50 dollars missing from both accounts, which your product has to accept. Three, you redesign so both accounts live on the same shard (shard by `customer_id` not by `account_id`), and the transfer becomes a single local transaction. Option three is the senior answer almost every time.

Entry level interview questions. What does PREPARE TRANSACTION do in Postgres. It writes the transaction to disk in a durable prepared state, releases the session, and the transaction can be committed or rolled back later by name, even after a crash. What is the failure mode of 2PC. If the coordinator dies between prepare and commit, participants hold locks forever until a human intervenes. What is a saga. A sequence of local transactions where each step has a compensating action for rollback. When is eventual consistency acceptable. When the business can tolerate a brief window of inconsistency and you have a reconciliation process that catches divergence.

The scatter gather code in this section looks innocent but is one of the most dangerous patterns in a sharded system. Read the senior section below before shipping it.

### Senior @ FAANG: Cross-Shard Coordination at Staff and Principal Scope

The distributed transaction problem is the oldest unsolved problem in databases and the solutions available to you fall on a spectrum from strictly serializable (Spanner, Calvin, FoundationDB) to eventually consistent with compensations (sagas, outbox). The choice is a business decision disguised as a technical one. Senior engineers pick the weakest consistency model the business can tolerate, because every stronger model costs latency, availability, or both.

Two phase commit is correct in theory and dangerous in practice. Its pathological failure mode is the coordinator crash after prepare and before commit. Participant shards hold prepared transactions, which in Postgres pin the WAL segment, block autovacuum, and eventually cause the primary to run out of disk. Production 2PC deployments require a durable coordinator (Zookeeper, etcd, a dedicated Postgres table with lease semantics), automated heuristic resolution after a timeout, and monitoring on `pg_prepared_xacts` that pages when any transaction sits prepared longer than 60 seconds. MySQL XA has similar issues with `XA RECOVER`. The MySQL team explicitly warns against XA for high throughput workloads because the binlog coordination cost is catastrophic. The short version: 2PC is the last resort, not the first.

The saga pattern (Garcia Molina 1987) is the dominant production answer. A saga is a sequence of local transactions T1, T2, T3 with compensating actions C1, C2, C3 such that if Tk fails, you run C(k-1), C(k-2), ..., C1 in reverse order. Sagas come in two flavors. Orchestration has a central coordinator (Temporal, Cadence, AWS Step Functions, Netflix Conductor) that tracks state and issues the next step, and is easier to reason about and debug. Choreography has each service publishing events that trigger the next step, and is lower latency but harder to trace. Temporal has become the de facto standard for Go shops because it handles retries, timers, and history replay with a Go SDK that makes workflows look like normal code. Uber, Coinbase, Stripe, Netflix, and Snap all use Temporal or an internal equivalent for cross service coordination. The cost of sagas is that compensations must be written for every step and tested in isolation, which doubles the test surface.

The outbox pattern is the cheapest correct implementation of at least once cross shard messaging. In the same local transaction that modifies business data, insert a row into an `outbox` table. A separate worker (CDC via Debezium, a polling worker, or logical replication) reads the outbox and publishes to Kafka or directly to the other shard. The contract is that the outbox row and the business row commit together or not at all, so you never have a business change without a corresponding event. Consumers must be idempotent because delivery is at least once. LinkedIn, Shopify, and every team using event sourcing at scale runs this pattern. The modern 2024 to 2026 evolution is Debezium sourced from Postgres logical replication rather than a polling worker, which gives you millisecond latency with zero application cost.

Cross shard JOINs are where performance goes to die. Four production patterns exist. First, reference table replication: small tables that rarely change (currency codes, countries, product catalog) are replicated to every shard. Citus calls these reference tables and handles the replication transparently. Second, data duplication: if tenant A needs to JOIN users to orders and orders lives on a different shard, denormalize the user fields you need onto orders. Storage is cheap and 2026 NVMe is 30 dollars per TB. Third, CDC fed materialized tables: stream both shards into Kafka, run a Flink or Materialize job that joins and writes to a destination table, query the destination for the join result. Netflix's Keystone and LinkedIn's Brooklin are industrial scale versions of this. Fourth, query federation: Trino (formerly Presto), Starburst, or ClickHouse with distributed tables can execute a JOIN across heterogeneous data sources, good for analytical queries but always slower than a local JOIN. Never run cross shard JOIN on the hot request path, budget it to async analytics only.

Cross shard ORDER BY with LIMIT is a distributed top K problem. The correct algorithm is to fetch the top K from each shard, merge sort at the router, and take the global top K. Offsets are where it breaks: `ORDER BY x LIMIT 100 OFFSET 10000` must fetch 10100 rows from every shard, not 100 per shard, because you cannot know which shard's offset 100 is the global offset 100. Vitess, Citus, and PgCat all handle this correctly but the cost is linear in offset. The senior answer is to never use offset pagination across shards, use keyset pagination (WHERE id greater than last seen id) which fetches K rows per shard regardless of how deep you are. Every time you see `OFFSET` in a sharded query it is a performance bug.

Cross shard GROUP BY works for distributive and algebraic aggregates and fails for holistic ones. Distributive: SUM, COUNT, MIN, MAX. You compute per shard, then combine at the router. Algebraic: AVG. You compute SUM and COUNT per shard, combine at the router as `sum(SUM) / sum(COUNT)`. Holistic: MEDIAN, COUNT DISTINCT, PERCENTILE. These cannot be computed from per shard summaries without additional data. Approximations (HyperLogLog for COUNT DISTINCT, t digest for percentiles, Greenwald Khanna summaries for quantiles) are the only tractable answer. ClickHouse, Druid, and Pinot have all of these baked in. If your application calls exact COUNT DISTINCT across shards, someone will page at 3 AM.

Scatter gather economics. The P99 latency of a fan out to N shards approaches the P(1 minus 1/N) latency of a single shard, because you are sampling N times from the tail. For N equals 100 and per shard P99 equals 50 ms, the scatter gather P99 is closer to the single shard P99.99, which is often 500 ms or worse. Jeff Dean's 2013 "Tail at Scale" paper is the foundational reference and every senior engineer must internalize it. Mitigations: hedged requests (fire a duplicate after P50, take the first response), backup requests with cross server cancellation, partial result tolerance (accept 95 percent of shards responding, timeout the rest), request classification (separate latency sensitive scatter gather from batch scatter gather into different pools).

pgBouncer pause and resume is the underrated tool for cross shard operational changes. `PAUSE` holds new queries at the pooler while existing transactions complete, and then `RESUME` releases them. It is how you do zero downtime failover for Postgres: pause pgBouncer, promote the replica, update pgBouncer's target, resume. Combined with `RECONNECT` it lets you move shards without application awareness. PgCat extends this with per shard pause so you can reshard one shard while leaving others serving.

Failure mode matrix every senior engineer should carry in their head. 2PC under coordinator failure: participants stuck prepared, manual recovery, worst in class. Saga under step failure: compensations run, brief inconsistency window, business must tolerate. Outbox under worker lag: events delayed but not lost, consumers must handle delivery delays. Scatter gather under one slow shard: every query suffers tail latency, mitigate with hedging. Cross shard JOIN on hot path: cascading slowness, latency amplification, always an architecture bug. Pick your poison with intent, not by accident.

---
