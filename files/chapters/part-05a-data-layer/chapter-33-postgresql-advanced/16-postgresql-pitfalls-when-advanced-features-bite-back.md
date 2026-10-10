## PostgreSQL Pitfalls: When Advanced Features Bite Back

### The JSONB Index Illusion

**The Incident**: A SaaS platform stored user preferences as JSONB. Queries on `preferences->>'theme'` were fast initially. As data grew to 10M rows, queries slowed to 8 seconds. The team added a GIN index on the JSONB column. Queries were still slow. They didn't realize GIN indexes don't help with `->>` (text extraction) operators - only with containment (`@>`) and existence (`?`) operators. The query planner ignored the expensive GIN index entirely.

```go
// WRONG: GIN index doesn't help with ->> queries
// CREATE INDEX idx_prefs ON users USING GIN (preferences);
func getUsersByTheme(ctx context.Context, pool *pgxpool.Pool, theme string) ([]User, error) {
    // This does a full table scan despite the GIN index!
    rows, err := pool.Query(ctx, `
        SELECT id, name FROM users
        WHERE preferences->>'theme' = $1
    `, theme)
    // ...
}

// CORRECT: Use expression index for ->> queries
// CREATE INDEX idx_prefs_theme ON users ((preferences->>'theme'));
func getUsersByTheme(ctx context.Context, pool *pgxpool.Pool, theme string) ([]User, error) {
    // Now uses the expression index
    rows, err := pool.Query(ctx, `
        SELECT id, name FROM users
        WHERE preferences->>'theme' = $1
    `, theme)
    // ...
}

// Or use containment with GIN for complex queries
// CREATE INDEX idx_prefs_gin ON users USING GIN (preferences jsonb_path_ops);
func getUsersByPreferences(ctx context.Context, pool *pgxpool.Pool, prefs map[string]any) ([]User, error) {
    prefsJSON, _ := json.Marshal(prefs)

    // This DOES use GIN index
    rows, err := pool.Query(ctx, `
        SELECT id, name FROM users
        WHERE preferences @> $1::jsonb
    `, prefsJSON)
    // ...
}

// Even better: Use JSONB columns for specific fields if queried often
// ALTER TABLE users ADD COLUMN theme TEXT GENERATED ALWAYS AS (preferences->>'theme') STORED;
// CREATE INDEX idx_users_theme ON users (theme);
```

### The LISTEN/NOTIFY Buffer Overflow

**The Incident**: A real-time notification system used PostgreSQL's LISTEN/NOTIFY for event distribution. It worked great in development. In production with 1,000 events/second, listeners started missing notifications. The issue: NOTIFY only delivers to sessions that are connected and actively listening at delivery time. Notifications are not persisted for disconnected or slow consumers, so a listener that drops its connection, reconnects, or falls behind draining its session queue misses everything sent in the gap. (The global queue is disk-backed with a roughly 8 GB cap, and if it ever fills, the sending transaction fails with an error rather than dropping silently.) The team discovered this during a Black Friday sale when 40% of order notifications were lost to listener reconnects under load.

```go
// WRONG: Assuming NOTIFY is reliable for high throughput
func notifyOrderCreated(ctx context.Context, pool *pgxpool.Pool, order Order) error {
    payload, _ := json.Marshal(order)
    _, err := pool.Exec(ctx, "NOTIFY orders, $1", string(payload))
    return err // May succeed even if notification is dropped!
}

func listenOrders(ctx context.Context, pool *pgxpool.Pool) {
    conn, _ := pool.Acquire(ctx)
    defer conn.Release()

    conn.Conn().Exec(ctx, "LISTEN orders")

    for {
        notification, _ := conn.Conn().WaitForNotification(ctx)
        processOrder(notification.Payload) // May miss notifications!
    }
}

// CORRECT: Use NOTIFY as a hint, not as the source of truth
type OrderEventProcessor struct {
    pool       *pgxpool.Pool
    lastSeenID int64
}

func (p *OrderEventProcessor) Start(ctx context.Context) error {
    conn, err := p.pool.Acquire(ctx)
    if err != nil {
        return err
    }
    defer conn.Release()

    // Listen for hints that new data is available
    if _, err := conn.Exec(ctx, "LISTEN orders_hint"); err != nil {
        return err
    }

    // Process any backlog first
    if err := p.processBacklog(ctx); err != nil {
        return err
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Wait for notification OR timeout
        ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
        _, err := conn.Conn().WaitForNotification(ctx)
        cancel()

        if err != nil {
            // On timeout or error, poll anyway
            // This catches any missed notifications
        }

        // Always poll the table for actual data
        if err := p.processBacklog(ctx); err != nil {
            log.Printf("process error: %v", err)
        }
    }
}

func (p *OrderEventProcessor) processBacklog(ctx context.Context) error {
    rows, err := p.pool.Query(ctx, `
        SELECT id, payload, created_at
        FROM order_events
        WHERE id > $1
        ORDER BY id
        LIMIT 1000
    `, p.lastSeenID)
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var event OrderEvent
        if err := rows.Scan(&event.ID, &event.Payload, &event.CreatedAt); err != nil {
            return err
        }

        if err := p.processEvent(ctx, &event); err != nil {
            return err // Stop and retry from here
        }

        p.lastSeenID = event.ID
        p.saveCheckpoint(ctx, p.lastSeenID) // For restart recovery
    }

    return rows.Err()
}
```

### The Advisory Lock Deadlock

**The Incident**: A distributed task scheduler used PostgreSQL advisory locks to prevent duplicate execution. Two different code paths acquired locks in different orders: Path A locked "task-123" then "resource-456", Path B locked "resource-456" then "task-123". Under load, they deadlocked. PostgreSQL detected the deadlock and killed one connection, but the service kept retrying, creating a deadlock storm. Each deadlock logged an error, and the log volume crashed the logging infrastructure.

```go
// WRONG: Acquiring multiple locks in inconsistent order
func processTaskA(ctx context.Context, pool *pgxpool.Pool, taskID, resourceID int64) error {
    // Lock task first
    _, err := pool.Exec(ctx, "SELECT pg_advisory_lock($1)", taskID)
    if err != nil {
        return err
    }
    defer pool.Exec(ctx, "SELECT pg_advisory_unlock($1)", taskID)

    // Then lock resource
    _, err = pool.Exec(ctx, "SELECT pg_advisory_lock($1)", resourceID)
    if err != nil {
        return err
    }
    defer pool.Exec(ctx, "SELECT pg_advisory_unlock($1)", resourceID)

    return doWork()
}

func processTaskB(ctx context.Context, pool *pgxpool.Pool, taskID, resourceID int64) error {
    // Lock resource first (DEADLOCK RISK!)
    _, err := pool.Exec(ctx, "SELECT pg_advisory_lock($1)", resourceID)
    // ...
    _, err = pool.Exec(ctx, "SELECT pg_advisory_lock($1)", taskID)
    // ...
}

// CORRECT: Consistent lock ordering and timeout
func acquireLocks(ctx context.Context, pool *pgxpool.Pool, lockIDs ...int64) (func(), error) {
    // Sort lock IDs to ensure consistent ordering
    sorted := make([]int64, len(lockIDs))
    copy(sorted, lockIDs)
    slices.Sort(sorted)

    acquired := make([]int64, 0, len(sorted))
    cleanup := func() {
        for i := len(acquired) - 1; i >= 0; i-- {
            pool.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", acquired[i])
        }
    }

    for _, id := range sorted {
        // Use try_lock with timeout to avoid indefinite blocking
        var locked bool
        err := pool.QueryRow(ctx,
            "SELECT pg_try_advisory_lock($1)", id).Scan(&locked)
        if err != nil {
            cleanup()
            return nil, fmt.Errorf("lock %d: %w", id, err)
        }

        if !locked {
            cleanup()
            return nil, ErrLockNotAcquired
        }

        acquired = append(acquired, id)
    }

    return cleanup, nil
}

func processTask(ctx context.Context, pool *pgxpool.Pool, taskID, resourceID int64) error {
    // Always acquire in sorted order
    cleanup, err := acquireLocks(ctx, pool, taskID, resourceID)
    if err != nil {
        if errors.Is(err, ErrLockNotAcquired) {
            // Back off and retry
            return ErrRetryable
        }
        return err
    }
    defer cleanup()

    return doWork()
}
```

### The CTE Materialization Surprise

**The Incident**: A reporting query used CTEs for readability. Performance was acceptable until PostgreSQL 12, where CTEs became inlineable by default. A query that took 200ms suddenly took 45 seconds after the upgrade. The CTE was being executed multiple times because the planner inlined it into each reference. The old "optimization fence" behavior was actually protecting them from a terrible query plan.

```go
// Query that worked well before PostgreSQL 12
const reportQuery = `
WITH user_stats AS (
    SELECT user_id, COUNT(*) as order_count, SUM(total_cents) as total_spent_cents
    FROM orders
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY user_id
)
SELECT u.name, s.order_count, s.total_spent_cents
FROM users u
JOIN user_stats s ON u.id = s.user_id
WHERE s.order_count > 5 OR s.total_spent_cents > 100000
`
// In PG11: CTE materialized once, joined to users
// In PG12+: CTE may be inlined, causing the aggregation to run multiple times

// CORRECT: Explicit materialization control
const reportQueryFixed = `
WITH user_stats AS MATERIALIZED (  -- Force materialization
    SELECT user_id, COUNT(*) as order_count, SUM(total_cents) as total_spent_cents
    FROM orders
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY user_id
)
SELECT u.name, s.order_count, s.total_spent_cents
FROM users u
JOIN user_stats s ON u.id = s.user_id
WHERE s.order_count > 5 OR s.total_spent_cents > 100000
`

// Or use NOT MATERIALIZED when inlining helps
const simpleQuery = `
WITH active_users AS NOT MATERIALIZED (
    SELECT id FROM users WHERE last_login > NOW() - INTERVAL '7 days'
)
SELECT * FROM orders WHERE user_id IN (SELECT id FROM active_users)
`

// Best practice: Test both and use EXPLAIN ANALYZE
func runReportWithPlanCheck(ctx context.Context, pool *pgxpool.Pool) error {
    // In development, always check the plan
    var plan string
    err := pool.QueryRow(ctx, "EXPLAIN ANALYZE "+reportQueryFixed).Scan(&plan)
    if err != nil {
        return err
    }

    // Log slow query plans
    if strings.Contains(plan, "Seq Scan") && strings.Contains(plan, "rows=1000000") {
        log.Warn("report query doing sequential scan on large table", "plan", plan)
    }

    return nil
}
```

### The Full-Text Search Ranking Trap

**The Incident**: A product search used PostgreSQL full-text search with `ts_rank()` for relevance ordering. Users complained that exact matches weren't appearing first. Searching "iPhone 15 Pro" would show "iPhone 15 Pro Max" before "iPhone 15 Pro" because the longer description had more keyword matches. The team spent weeks tuning weights before realizing `ts_rank()` doesn't prioritize exact phrase matches.

```go
// WRONG: Relying solely on ts_rank for relevance
func searchProducts(ctx context.Context, pool *pgxpool.Pool, query string) ([]Product, error) {
    rows, err := pool.Query(ctx, `
        SELECT id, name, description,
               ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
        FROM products
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT 20
    `, query)
    // "iPhone 15 Pro Max" may rank higher than "iPhone 15 Pro"
}

// CORRECT: Combine multiple ranking signals
func searchProducts(ctx context.Context, pool *pgxpool.Pool, query string) ([]Product, error) {
    rows, err := pool.Query(ctx, `
        SELECT id, name, description,
            -- Exact name match gets highest priority
            CASE WHEN LOWER(name) = LOWER($1) THEN 1000 ELSE 0 END +
            -- Name starts with query
            CASE WHEN LOWER(name) LIKE LOWER($1) || '%' THEN 500 ELSE 0 END +
            -- Phrase match in name
            CASE WHEN name_vector @@ phraseto_tsquery('english', $1) THEN 200 ELSE 0 END +
            -- Regular full-text rank
            ts_rank(search_vector, plainto_tsquery('english', $1)) * 10 +
            -- Popularity boost
            LOG(sales_count + 1)
            AS combined_rank
        FROM products
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ORDER BY combined_rank DESC
        LIMIT 20
    `, query)
    return scanProducts(rows)
}

// Even better: Use websearch_to_tsquery for user-friendly syntax (PG11+)
func searchProductsAdvanced(ctx context.Context, pool *pgxpool.Pool, query string) ([]Product, error) {
    rows, err := pool.Query(ctx, `
        SELECT id, name, description,
            ts_rank(search_vector, websearch_to_tsquery('english', $1)) as rank,
            ts_headline('english', description, websearch_to_tsquery('english', $1),
                'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15') as snippet
        FROM products
        WHERE search_vector @@ websearch_to_tsquery('english', $1)
        ORDER BY
            -- Exact phrase match first
            (search_vector @@ phraseto_tsquery('english', $1)) DESC,
            rank DESC
        LIMIT 20
    `, query)
    // websearch_to_tsquery handles "quoted phrases" and -exclusions
}
```

### Quick Reference: PostgreSQL Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| JSONB index type mismatch | Queries ignore index | Expression index for ->>, GIN for @> |
| LISTEN/NOTIFY overflow | Missing notifications | Use as hint, poll for data |
| Advisory lock deadlock | Connection killed, retries | Consistent lock ordering |
| CTE materialization | Query plan regression | Explicit MATERIALIZED keyword |
| ts_rank limitations | Poor relevance | Combine multiple ranking signals |
| NOTIFY payload size | Truncated data | Store data in table, send ID |
| GIN index bloat | Slow inserts/updates | VACUUM, fastupdate=off |
| Connection in LISTEN | Pool exhaustion | Dedicated connection for LISTEN |

### Junior → FAANG: Reading Pitfalls as Incident Reports

Every pitfall above is a compressed postmortem. Junior engineers read them as rules ("don't use `->>` with GIN"). FAANG-track engineers read them as incident narratives and ask: what were the leading indicators, what did the on-call runbook look like, and how would the platform prevent it next time?

Prerequisite skills to build the "why did this fail?" reflex on pitfalls:
1. Be able to construct each pitfall in a local Postgres 18 container within 20 minutes. If you cannot reproduce the JSONB index illusion by hand, you do not truly understand it.
2. Know the `EXPLAIN (ANALYZE, BUFFERS)` output for both the broken and the fixed version. The difference is the diagnostic signal.
3. Know which pg_stat view would have paged you first. JSONB index illusion: `pg_stat_user_indexes.idx_scan = 0` on the supposed index. LISTEN/NOTIFY overflow: `pg_notification_queue_usage()` above 50%. Advisory deadlock: `pg_stat_database.deadlocks` incrementing. CTE materialization: `auto_explain` log entries with duration regressions after deploy. FTS ranking: product complaints without a DB signal (the worst kind).

Worked example on the LISTEN/NOTIFY Black Friday incident. A junior on-call engineer gets paged for "40% of order notifications missing." Walk through:
1. Check `pg_stat_activity` for connections with `query = 'LISTEN orders'`. If the count is low, listeners may have died. If normal, move on.
2. Run `SELECT pg_notification_queue_usage()`. If above 0.5, the queue is under pressure. If above 0.9, notifications are being dropped.
3. Check `pg_stat_activity` for slow or stuck listening sessions, including a listener parked inside a long transaction. The async notification queue is a shared structure that can only be truncated up to the read position of the slowest connected listener, so one lagging listener makes the queue grow for everyone until it approaches the cap and NOTIFY starts failing. This is the most common root cause of queue pressure.
4. Mitigation: terminate the long-running transactions (with owner approval), then verify queue drains. Permanent fix: use the outbox pattern with NOTIFY as a wake-up hint, exactly like the correct example in this section.

Interview entry-point questions on pitfalls:
- "If I have `CREATE INDEX ON users USING GIN (preferences)`, which of these queries uses the index: `WHERE preferences @> '{"theme":"dark"}'`, `WHERE preferences->>'theme' = 'dark'`, `WHERE preferences ? 'theme'`?" Expected: first and third yes, second no.
- "Why is `pg_advisory_xact_lock` safer than `pg_advisory_lock` in most cases?" Expected: released on transaction end, panic-safe, no risk of leaking if the connection is returned to the pool.
- "Your query took 200ms on PG 11 and 45s on PG 12. What changed?" Expected: CTE inlining behavior change, fix with `MATERIALIZED` keyword.

### Senior @ FAANG: Incident Governance and Prevention Platforms

Each pitfall in this section would be a P1 or P2 incident at a FAANG company. Staff engineers do not just fix them. They ask: why did our platform let this ship? What guardrail was missing? What runbook was incomplete? The senior lens on pitfalls is always "how do we prevent the next 100 teams from making the same mistake?"

ADR template: preventing the JSONB index illusion fleet-wide.

```
# ADR-0XXX: JSONB Indexing Standards

## Context
Teams frequently index JSONB columns without understanding operator support.
Recent incidents: 3 in the last quarter, each with multi-day triage.

## Decision
1. All JSONB columns over 1 KB average size require an ADR citing access patterns.
2. Default index choice:
   - Queries use ->> or ->: require expression index on the specific path.
   - Queries use @> or ?: require GIN with jsonb_path_ops.
   - Both patterns: both indexes, plus monitoring on index bloat.
3. CI linter rejects GIN on a JSONB column that is only queried with ->>.
4. Hot keys promoted to generated columns with dedicated btree.

## Consequences
- Review overhead on new JSONB columns, roughly 30 minutes per ADR.
- Expected reduction: 80% of JSONB-related slow-query incidents.

## Observability
- pg_stat_user_indexes.idx_scan monitored per index, alert if zero after 7 days.
- Automated weekly review of top 20 queries from pg_stat_statements that scan
  JSONB columns without using an index.
```

Maturity model applied to pitfalls:
- L1: Each pitfall is discovered organically by a team, fixed locally, and forgotten.
- L2: Postmortems are written but not shared. Each team re-discovers the same pitfall.
- L3: A central platform team maintains a pitfall catalog. New hires are onboarded through it.
- L4: Pitfalls are encoded as CI checks, linters, or runtime metrics. JSONB index validation runs on every migration. Deadlock rate is an SLI. Notification queue usage has an alert.
- L5: The platform is opinionated enough that the pitfall cannot be shipped. Schema-change tooling rejects GIN-on-JSONB-for-->> patterns automatically. Advisory locks require a namespace registry lookup. LISTEN/NOTIFY is deprecated in favor of a managed event bus.

Runbook: advisory lock deadlock storm.

```
# Runbook: Advisory Lock Deadlock Storm

## Detection
- pg_stat_database.deadlocks rate > 10/min for any database
- Log volume spike on "deadlock detected" messages
- Application timeout rate climbing on lock acquisition paths

## Immediate mitigation
1. Identify the two code paths in the deadlock victim log:
   SELECT classid, objid, mode, pid FROM pg_locks
   WHERE locktype = 'advisory' AND NOT granted;
2. If the storm is active, rate-limit the offending endpoint at the load balancer.
3. If identifiable, revert the most recent deploy that added a new lock acquisition.

## Root-cause analysis
1. Enumerate all code paths that acquire multiple advisory locks.
2. Verify lock ordering is deterministic (sorted by ID) across every path.
3. Replace pg_advisory_lock with pg_try_advisory_lock plus timeout where possible.
4. Consider replacing the pattern with SELECT FOR UPDATE if the locked
   entity maps to a real row.

## Prevention
- Add a platform linter: any code path calling pg_advisory_lock more than once
  must route through the centralized acquireLocks helper.
- Add CI check: grep for pg_advisory_lock calls outside the approved helper.
- Track advisory lock namespace in a registry service. Conflicts caught at PR time.
```

Extension adoption governance for the pitfalls in this section:
- pg_cron to drive the outbox processor? Evaluate whether the scheduled job survives leader failover. On Aurora, pg_cron runs only on the writer, so a failover pauses the job until the new writer starts. That is a valid tradeoff but must be documented.
- pg_partman for the order_events outbox table? Mandatory above 100 GB. The ADR must specify partition pruning strategy, retention policy, and interaction with logical replication (partitioned tables on publishers require PG 13+ handling).
- ParadeDB or pg_search to replace hand-rolled ts_rank tuning? Worth evaluating at L4 maturity. ADR must address licensing, extension version pinning, and rollback story if the search experience regresses.

Version upgrade ADR for the pitfalls: the CTE materialization surprise is the canonical reason staff engineers do not run `pg_upgrade --link` without a parallel plan capture step. The runbook is:
1. Before upgrade, capture `EXPLAIN (FORMAT JSON)` for the top 500 queries from `pg_stat_statements` on the old version.
2. After upgrade on a staging replica, re-run the captures and diff. Any plan that changed from `CTE Scan` to inlined execution, or vice versa, is flagged for review.
3. Gate the production upgrade on zero unreviewed plan regressions.

GitLab has publicly described variants of this process. The lesson is that major version upgrades are query-plan migrations as much as they are binary migrations.

Bar-raiser question on pitfalls: "Your team wants to replace LISTEN/NOTIFY with a real event bus. Kafka, NATS, or Redpanda. How do you decide?" Staff-level signal:
- The candidate acknowledges that LISTEN/NOTIFY is not a queue. It is a best-effort notification with no replay.
- They evaluate the trade-off: an event bus adds operational complexity but provides durability, replay, consumer groups, and backpressure.
- They name the intermediate step: the outbox pattern with NOTIFY as hint and the event table as source of truth. This gets you durability without adopting a new system.
- They discuss CDC via Debezium or the Postgres logical replication plugin as the bridge from outbox to event bus.
- They frame the decision in terms of organizational cost: one team can run the outbox pattern in a week, running a Kafka cluster is a dedicated team.

On-call rotation for pitfalls: every pitfall in this section should have a named owner on the platform team, a runbook linked from the pager payload, and a monthly review of whether the pitfall is still relevant. If a pitfall has not fired an incident in 12 months and CI checks cover it, archive the runbook. If it fires twice in a quarter, escalate to an architecture review.

Tooling and observability stack that a mature Postgres platform runs in 2026:
- pg_stat_statements (mandatory, in shared_preload_libraries).
- auto_explain with `log_min_duration = 1000` and `log_analyze = true` on non-hot-path workloads.
- pgBadger parsing `log_line_prefix = '%t [%p]: db=%d,user=%u,app=%a,client=%h '` output weekly.
- pgwatch2 or a managed equivalent (RDS Performance Insights, AlloyDB Query Insights) for real-time metrics.
- A plan regression detector, either homegrown or from a vendor like pganalyze or Datadog DBM.
- A schema change tool (pgroll, reshape, or pg_osc) that gates on lock acquisition timeouts and replica lag.
- A bloat dashboard from pgstattuple_approx on a weekly cron.
- A game day calendar that exercises each of the five pitfalls at least annually.

---
