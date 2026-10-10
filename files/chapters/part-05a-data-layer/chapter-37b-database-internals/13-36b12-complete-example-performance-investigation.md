## 37B.12 Complete Example: Performance Investigation

### Scenario: Slow Query Alert at 02:00 UTC

This walkthrough applies every concept from the chapter to a realistic production incident. Each step uses a different diagnostic tool and draws on a different area of database internals knowledge.

```
Alert: p99 query latency for /api/orders endpoint increased from 4ms to 850ms
Time: 02:00 UTC
Table: orders (50M rows, 3 months of data)
```

### Step 1: Capture the Slow Query

The `pg_stat_statements` extension tracks execution statistics for all queries. Sort by `mean_exec_time` to find the worst offenders.

```sql
-- Check pg_stat_statements for the problematic query
SELECT
    substring(query, 1, 100) AS query,
    calls,
    round(mean_exec_time::numeric, 2) AS avg_ms,
    round(max_exec_time::numeric, 2) AS max_ms,
    round(total_exec_time::numeric / 1000, 2) AS total_sec,
    rows / calls AS avg_rows
FROM pg_stat_statements
WHERE query ILIKE '%orders%'
  AND calls > 100
ORDER BY mean_exec_time DESC
LIMIT 10;
```

Identifies: `SELECT * FROM orders WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 20`

### Step 2: Run EXPLAIN ANALYZE

Run `EXPLAIN ANALYZE` with `BUFFERS` to see both the plan and the actual I/O cost. Pay attention to "Rows Removed by Filter" and "Buffers: read" - these reveal wasted work.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders
WHERE user_id = 42 AND status = 'active'
ORDER BY created_at DESC
LIMIT 20;
Limit  (cost=0.56..892.14 rows=20 width=128) (actual time=845.234..845.240 rows=20 loops=1)
  ->  Index Scan Backward using idx_orders_user_id on orders
        (cost=0.56..26780.14 rows=600 width=128) (actual time=845.234..845.237 rows=20 loops=1)
        Index Cond: (user_id = 42)
        Filter: (status = 'active')
        Rows Removed by Filter: 85432          <-- RED FLAG
Buffers: shared hit=182 read=85234             <-- RED FLAG: 85234 disk reads
Planning Time: 0.412 ms
Execution Time: 845.318 ms
```

**Finding 1**: Index scan on `user_id` alone, then filtering `status = 'active'` - removing 85,432 rows. The index does not include `status`.

### Step 3: Check for Table Bloat

Dead tuples inflate table size and force the index scan to read through pages of invisible rows. Check the dead tuple ratio and when autovacuum last ran.

```sql
SELECT
    n_live_tup,
    n_dead_tup,
    round(n_dead_tup::numeric / n_live_tup * 100, 1) AS dead_pct,
    last_autovacuum,
    pg_size_pretty(pg_relation_size('orders')) AS table_size
FROM pg_stat_user_tables
WHERE relname = 'orders';
n_live_tup | n_dead_tup | dead_pct | last_autovacuum        | table_size
-----------+------------+----------+------------------------+-----------
50000000   | 12500000   | 25.0     | 2026-03-12 23:45:00    | 18 GB
```

**Finding 2**: 25% dead tuples. Autovacuum ran 2+ hours ago. High write rate overnight - autovacuum fell behind.

### Step 4: Check Planner Statistics

The `pg_stats` view shows what the planner thinks the data distribution looks like. Compare the `most_common_vals` and `most_common_freqs` to the actual distribution to see if statistics are stale.

```sql
SELECT
    most_common_vals,
    most_common_freqs,
    n_distinct
FROM pg_stats
WHERE tablename = 'orders'
  AND attname = 'status';
most_common_vals        | most_common_freqs | n_distinct
------------------------+-------------------+-----------
{archived,active,pending| {0.95,0.04,0.01}  | 3
```

**Finding 3**: 95% of rows are `archived`, only 4% are `active`. The planner's estimate of 600 matching rows (for `user_id=42 AND status='active'`) is wildly off - actual: 20 (after removing 85,432 non-active rows for that user).

### Step 5: Apply Fixes

Armed with the diagnosis, apply targeted fixes. A partial composite index eliminates the filter step entirely, fresh statistics correct the planner's estimates, and aggressive autovacuum settings prevent the bloat from recurring.

```sql
-- Fix 1: Add composite index with status as leading column for this query pattern
-- OR add status to existing index
CREATE INDEX CONCURRENTLY idx_orders_user_status_created
    ON orders (user_id, status, created_at DESC)
    WHERE status = 'active';  -- partial index: only active orders

-- Fix 2: Refresh statistics immediately
ANALYZE orders;

-- Fix 3: Force autovacuum for the table
VACUUM ANALYZE orders;

-- Fix 4: Tune autovacuum for this high-write table
ALTER TABLE orders SET (
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 100,
    autovacuum_analyze_scale_factor = 0.005
);
```

### Step 6: Verify the Fix

Re-run the same `EXPLAIN ANALYZE` to confirm the new index is being used and the filter step is gone.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders
WHERE user_id = 42 AND status = 'active'
ORDER BY created_at DESC
LIMIT 20;
Limit  (cost=0.44..4.12 rows=20 width=128) (actual time=0.082..0.134 rows=20 loops=1)
  ->  Index Scan Backward using idx_orders_user_status_created on orders
        (cost=0.44..4.12 rows=20 width=128) (actual time=0.081..0.127 rows=20 loops=1)
        Index Cond: ((user_id = 42) AND (status = 'active'))
Buffers: shared hit=4 read=0
Planning Time: 0.188 ms
Execution Time: 0.142 ms
```

From **845ms to 0.14ms**. No heap reads for non-active rows. Index-only scan on the partial index.

### Junior to FAANG: reading a plan without panic

The prerequisite gap is not SQL fluency. It is knowing that `EXPLAIN` (plan estimates) and `EXPLAIN ANALYZE` (actual execution) and `EXPLAIN (ANALYZE, BUFFERS)` (actual plus I/O) are three different tools. A junior who runs only `EXPLAIN` on a slow query and reports "the cost is 26780" has produced noise. Cost numbers are not milliseconds. They are arbitrary units relative to `seq_page_cost = 1.0`. The only numbers that matter in an incident are `actual time`, `actual rows`, `Rows Removed by Filter`, and `Buffers: shared read`.

Worked example for the reflex. Given the plan above, a first-year on-call should walk through it in this order. (1) Find the top node's `actual time`. It is 845ms. (2) Find where time is spent. The child index scan is also 845ms, so the Limit is not the cost, the index scan is. (3) Look at `actual rows` vs planner `rows`. Planner said 600, reality was 20 (after filter). 30x misestimate means statistics are lying. (4) Look at `Rows Removed by Filter`. 85432 rows were fetched from disk and thrown away. That is the bug. (5) Look at `Buffers: read`. 85234 cold pages, roughly 666MB of random I/O at 2am when the buffer cache is cold. That is why it is slow.

"Why did this fail?" reflex for the 02:00 UTC shape. Why 02:00 specifically? Because overnight batch jobs churn data, the buffer cache gets evicted, autovacuum is behind on a high-write table, and the first foreground query after the batch pays the cold-cache tax. The junior lesson is: latency problems that only appear at specific hours are almost never "the network". They are cache eviction, vacuum timing, backup I/O contention, or a cron job on the same host.

Interview entry-point at L3/L4. "What does `Buffers: shared hit=182 read=85234` mean?" Answer: 182 pages were in the shared buffer cache, 85234 were read from OS/disk. Reads are the expensive ones. "Why is `EXPLAIN ANALYZE` dangerous on a production UPDATE?" Because it actually runs the query. Wrap it in `BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;`. "What is a partial index?" An index that only contains rows matching a WHERE predicate. Smaller, faster, and only usable when the query's predicate implies the index predicate.

### Senior at FAANG: performance investigation as a platform discipline

At staff/principal level, the investigation above is a junior-on-call exercise. Your job is to make sure that investigation can happen without a staff engineer in the room. That means the platform has to capture the evidence before the incident, not during it.

Production evidence capture stack. `auto_explain` loaded via `shared_preload_libraries` with `auto_explain.log_min_duration = 500ms`, `log_analyze = on`, `log_buffers = on`, `log_timing = on`, `log_format = json`. This captures the plan-with-actuals for any slow query without requiring re-run. `pg_stat_statements` with `pg_stat_statements.max = 10000` and `track = all`, reset weekly and snapshotted to a long-term store. `pg_wait_sampling` or `pg_stat_kcache` for wait-event attribution, because "slow" is not a diagnosis, "waiting on LWLock:BufferMapping" or "IO:DataFileRead" is. Log-based sampling via pgBadger for historical trending. Commercial layer: pganalyze or Datadog Database Monitoring for cross-host correlation, Percona PMM for the open-source equivalent.

ADR template for database observability.

```
Title: Production query observability for Tier-1 Postgres clusters

Decision:
  - auto_explain enabled on all primaries and replicas with 500ms threshold,
    JSON format, 10% sampling above threshold to bound log volume.
  - pg_stat_statements with 10000 slots, snapshotted every 5 minutes to S3
    via a sidecar, diffed into per-query time-series.
  - pg_wait_sampling at 10ms resolution, exported to Prometheus.
  - Commercial: pganalyze for plan regression detection and index advisor.
  - Plan regressions (p95 latency for a queryid up 3x week-over-week) open
    a Jira ticket automatically, assigned to the owning service.

Consequences:
  - ~2% CPU overhead from auto_explain sampling, accepted.
  - ~5GB/day of log volume per primary, retained 14 days hot, 90 days cold.
  - Every slow query has a plan captured without re-run, so investigations
    do not require reproducing the state.
```

Maturity model for performance investigation (L1 to L5).

```
L1 Reactive:    "the database is slow" -> someone SSHes in, runs top, guesses.
L2 Metric:      dashboards show CPU, connections, query rate. No query-level
                attribution. Incidents still require expert pattern matching.
L3 Query-level: pg_stat_statements snapshots, slow query log, someone on the
                team can read EXPLAIN ANALYZE. Investigation is a runbook.
L4 Plan-level:  auto_explain captures plans in prod, plan regressions alert,
                index advisor suggests candidates, wait events attributed.
L5 Predictive:  plan stability tracked per queryid, canary analysis on new
                indexes, automated rollback of index changes that regress
                p99, chaos-injected bloat to validate autovacuum tuning.
```

Bar-raiser interview questions at L6/L7. "Walk me through how an index lookup becomes a heap fetch, and when the planner chooses Index Only Scan instead." Expected: btree descent to leaf, leaf yields ctid (page, offset), visibility map check, if all-visible then no heap fetch (Index Only Scan), else heap page read and MVCC visibility check per tuple. "A replica is 90 seconds behind at peak. Diagnose." Expected: check `pg_stat_replication` for which LSN is lagging (sent/write/flush/replay), check `pg_stat_activity` on standby for blocking long queries, check `pg_wait_sampling` on standby for Recovery waits, check standby disk I/O saturation, check if `hot_standby_feedback` is pinning vacuum on primary. "Design a CDC pipeline for 10K tables from Postgres to Snowflake with <2min freshness." Expected: logical replication with `pgoutput`, Debezium or custom consumer, partition Kafka topics by table hash, Snowpipe or Snowflake Kafka connector, schema registry for DDL changes, dead-letter queue for poison messages, per-slot lag monitoring, `pg_failover_slots` for HA, backpressure via consumer lag metrics.

Staff review checklist when a team proposes a schema or index change. (1) Has the new index been created `CONCURRENTLY`? Otherwise it locks writes. (2) Is there a plan for removing the index if it is unused? `pg_stat_user_indexes.idx_scan = 0` after a week means dead weight on every write. (3) Does the index support existing queries via index-only scans, or will it always require a heap fetch? Check `pg_class.relallvisible` and the query's SELECT list. (4) Will the index bloat faster than autovacuum can keep up? Partial indexes on `status = 'active'` churn every time a row leaves that state. (5) For composite indexes, is the column order aligned with query predicates? `(user_id, status, created_at DESC)` supports `WHERE user_id = ? AND status = ?` but not `WHERE status = ?` alone. (6) Statistics target for skewed columns set appropriately? `ALTER TABLE ... ALTER COLUMN status SET STATISTICS 1000` when `most_common_freqs` span orders of magnitude.

The GitLab 2017 incident frames the governance lesson. A staff engineer ran `rm -rf` on the primary thinking it was the standby, and the backups, basebackups, replication, and S3 snapshots had all silently failed for different reasons. The technical fix was restoring from a 6-hour-old LVM snapshot. The platform lesson was that a backup is not a backup until a restore has been performed from it in the last 30 days, and a replica is not a replica until a failover has been performed from it in the last 90 days. Senior engineers codify these as SLOs with automated audits, not as runbook suggestions.

---
