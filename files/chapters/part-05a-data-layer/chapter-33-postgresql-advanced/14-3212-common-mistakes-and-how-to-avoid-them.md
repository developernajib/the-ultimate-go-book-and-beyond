## 33.12 Common Mistakes and How to Avoid Them

### Mistake 1: Not Using GIN Indexes for JSONB

Querying JSONB columns without a GIN index forces PostgreSQL to scan every row and decompose its JSON to evaluate the filter condition. On a table with a million rows, this turns a sub-millisecond lookup into a multi-second sequential scan. A GIN index on the JSONB column supports the `@>`, `?`, `?|`, and `?&` operators. For queries that only filter on a single key (like `metadata->>'category'`), an expression index on that specific path is more efficient and smaller than a full GIN index.

```go
// WRONG: Slow JSONB queries without proper indexes
query := `SELECT * FROM products WHERE metadata->>'category' = $1`
// Full table scan!

// CORRECT: Create GIN index for JSONB
// CREATE INDEX idx_products_metadata ON products USING GIN(metadata);
// Or create expression index for specific paths
// CREATE INDEX idx_products_category ON products ((metadata->>'category'));
```

### Mistake 2: Forgetting to Close LISTEN Connections

LISTEN requires a dedicated connection that stays open to receive notifications. If you acquire a connection from the pool with `pool.Acquire` and never release it, you permanently reduce the pool's available connections by one. Over time this leaks connections until the pool is exhausted and all queries block. Always use `defer conn.Release()` and respect context cancellation so the listener shuts down cleanly.

```go
// WRONG: Connection never released
func listenBad(pool *pgxpool.Pool) {
	conn, _ := pool.Acquire(context.Background())
	conn.Conn().Exec(context.Background(), "LISTEN events")

	for {
		notification, _ := conn.Conn().WaitForNotification(context.Background())
		handleNotification(notification)
	}
	// conn.Release() never called - connection leak!
}

// CORRECT: Properly manage connection lifecycle
func listenGood(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release() // Always release!

	_, err = conn.Exec(ctx, "LISTEN events")
	if err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			notification, err := conn.Conn().WaitForNotification(ctx)
			if err != nil {
				return err
			}
			handleNotification(notification)
		}
	}
}
```

### Mistake 3: Advisory Lock Key Collisions

Advisory locks use `int64` keys, so different parts of your application can accidentally use the same key for unrelated locks. A simple integer like `42` might be used by the job processor and the cache invalidator simultaneously, causing one to block the other. The fix is to namespace your lock keys: either hash a structured string like `"jobs:42"` to produce a unique `int64`, or use PostgreSQL's two-argument form `pg_advisory_lock(namespace, key)` which takes two `int32` values.

```go
// WRONG: Simple string keys can collide
lockKey := "process-" + jobID // What if jobID is reused?

// CORRECT: Use namespaced, hashed keys
func lockKey(namespace, id string) int64 {
	h := fnv.New64a()
	h.Write([]byte(namespace + ":" + id))
	return int64(h.Sum64())
}

// Or use two-key advisory locks for better namespacing
func lockWithNamespace(ctx context.Context, pool *pgxpool.Pool, ns, key int64) error {
	_, err := pool.Exec(ctx, "SELECT pg_advisory_lock($1, $2)", ns, key)
	return err
}
```

### Mistake 4: N+1 Queries with JSONB

JSONB makes it easy to store nested data, but that convenience can lead to N+1 patterns where you fetch a list of rows and then issue a separate query for each row's JSONB sub-elements. Instead, extract JSONB data in the same query using functions like `jsonb_array_elements_text` or the `->` operator. This sends one round trip to the database instead of N+1.

```go
// WRONG: N+1 pattern
articles, _ := getArticles(ctx)
for _, article := range articles {
	// Separate query for each article's tags from JSONB
	tags := article.Metadata["tags"].([]string)
}

// CORRECT: Expand JSONB in single query
query := `
	SELECT
		a.id,
		a.title,
		jsonb_array_elements_text(a.metadata->'tags') as tag
	FROM articles a
	WHERE a.id = ANY($1)
`
```

### Mistake 5: Full-Text Search Without Ranking

Using `WHERE search_vector @@ plainto_tsquery($1)` without `ORDER BY ts_rank(...)` returns matching rows in arbitrary order, typically by physical storage position. This means the most relevant result might appear last. Always use `ts_rank` or `ts_rank_cd` to score results and order by relevance. The `ts_rank_cd` variant accounts for cover density (how close matching terms are to each other), which generally produces better rankings for multi-word queries.

```go
// WRONG: Returns unordered results
query := `SELECT * FROM articles WHERE search_vector @@ plainto_tsquery($1)`

// CORRECT: Always rank and order results
query := `
	SELECT
		id, title, body,
		ts_rank_cd(search_vector, plainto_tsquery('english', $1), 32) as rank
	FROM articles
	WHERE search_vector @@ plainto_tsquery('english', $1)
	ORDER BY rank DESC
	LIMIT 20
`
```

### Junior → FAANG: The "Why Did This Fail?" Reflex

Every mistake above has a signature in the database. Junior engineers fix the symptom. FAANG-track engineers build the reflex to ask "what would I have seen before this broke, and what dashboard or log would have told me?" That reflex is the difference between being a ticket closer and being an on-call engineer the team trusts.

Diagnostic ladder for each mistake:
1. Missing GIN index on JSONB. Signal in `pg_stat_statements`: `mean_exec_time` climbing while `calls` stays flat. Signal in `pg_stat_user_tables`: `seq_scan` incrementing on the table while `idx_scan` stays at zero. Fix verification: after adding the index, `EXPLAIN (ANALYZE, BUFFERS)` should show `Bitmap Index Scan on idx_products_metadata` and shared buffer reads should drop by 100x or more.
2. LISTEN connection leak. Signal: `pg_stat_activity` shows connections in `idle` state with `query = 'LISTEN events'` and a `backend_start` older than any service restart. pgbouncer's `SHOW POOLS` shows `cl_active` climbing while `sv_idle` drops to zero. Fix verification: after deploying the `defer conn.Release()` patch, rolling restart and watch `pg_stat_activity` drain within the session timeout.
3. Advisory lock collision. Signal: `pg_locks` with `locktype = 'advisory'` shows two different sessions on the same `classid, objid` pair and one is `granted = false`. Fix verification: hash collisions remain possible even with FNV. Monitor for lock wait events in `pg_stat_activity.wait_event_type = 'Lock'`.
4. N+1 with JSONB. Signal: application traces show a parent span with N child DB spans. pg_stat_statements shows a high-call-count query with low per-call time but massive aggregate time. Fix verification: after batching, the parent span should have one DB child span and aggregate time drops by 10x to 100x.
5. Full-text search without ranking. Signal: product complaints about "bad search results" with no ORM or DB error. This is the worst kind of bug because it never shows up in error rates. Fix verification: click-through rate on search results page and offline relevance evaluation on a labeled query set.

Prerequisite gaps and interview entry-point:
- "What does `EXPLAIN (ANALYZE, BUFFERS)` tell you that `EXPLAIN` alone does not?" Expected answer: ANALYZE executes the query and shows actual row counts and timing, BUFFERS shows cache hit/miss ratios per node. If actual rows differ from estimated rows by 10x or more, statistics are stale or the planner cannot estimate the selectivity of a JSONB predicate and you need a functional index or extended statistics.
- "What is the difference between `idx_scan` and `idx_tup_fetch` in `pg_stat_user_indexes`?" Expected answer: `idx_scan` counts how many times the index was used, `idx_tup_fetch` counts how many heap tuples were fetched via the index. A large gap means the index is returning many candidates but few pass the heap filter, which suggests the index is not selective enough.
- "Walk me through what happens when autovacuum runs on a table with long-running transactions open." Expected answer: autovacuum cannot remove dead tuples newer than the oldest running transaction's xmin. Long transactions cause bloat. `pg_stat_activity.backend_xmin` and `pg_stat_activity.xact_start` are the columns to check.

### Senior @ FAANG: Governance, Runbooks, and Fleet-Wide Regression Prevention

At L6 and above, you are not debugging one slow JSONB query. You are deciding how 400 application engineers across 80 services avoid shipping the next one without turning every PR into a database review bottleneck. The mistakes in this section are not individual bugs. They are organizational signals that your platform lacks guardrails.

EXPLAIN (ANALYZE, BUFFERS) governance. Every staff-owned Postgres platform in 2026 has some form of automated plan regression detection. The pattern is:
1. Every migration PR triggers a CI job that runs the top N queries from `pg_stat_statements` against a restored production snapshot with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
2. Plans are diffed against the baseline. New Seq Scans on tables above 1 GB, increased Buffers reads, or nested loop explosions fail the build.
3. Rollout gates on replica lag and plan stability for 24 hours before the canary widens.

Some teams have publicly described gating schema changes on bloat measurements and plan diffs as part of their pg_repack discipline. The ADR commits the platform team to maintaining the CI job, the snapshot refresh cadence (weekly is typical), and the runbook for overriding a plan regression (usually: staff engineer sign-off plus a rollback plan).

pgBadger and pgwatch2 adoption as the observability baseline. pgBadger parses `log_min_duration_statement` output into HTML reports. pgwatch2 is a metrics collector that feeds Grafana with `pg_stat_*` views. Both are open source and both are table stakes at L3 maturity. The ADR question is whether to self-host or rely on the managed provider's equivalent (Performance Insights on RDS, Query Insights on AlloyDB, Supabase's built-in dashboards). Managed is cheaper to operate but loses fidelity. Self-hosted is mandatory if you run multi-cloud or hybrid.

Schema-change tooling ADR. Every mistake in this section can be prevented by running migrations through a tool that knows about Postgres locking behavior. The 2026 landscape:
- pgroll from Xata. Expand/contract migrations with backfill, zero-downtime column renames, and automatic rollback. Best for teams that already practice expand/contract.
- reshape. Ruby-influenced but Postgres-native, supports column renames via views. Smaller community than pgroll.
- pg_osc (pg-online-schema-change). Trigger-based like gh-ost for MySQL, useful for large table rewrites without locking.
- Ghost-style tools from cloud providers. AlloyDB and Aurora both ship online DDL features that obsolete some of the above on their respective platforms.

The ADR picks one tool as the default and documents the escape hatch. "All migrations go through pgroll. Manual migrations require staff-level approval and must include a rollback SQL file."

Bloat management runbook. Index bloat and table bloat are the two silent killers that cause the kind of Mistake-4-style slowdowns where nothing is broken but everything is slow.

```
# Runbook: Postgres Bloat Investigation

## Detection
1. Query pgstattuple_approx on tables > 10 GB weekly
2. Alert when dead_tuple_percent > 20% or free_percent > 30%
3. For indexes, check pg_stat_user_indexes.idx_scan vs pgstatindex avg_leaf_density

## Triage
1. Identify the oldest transaction blocking vacuum:
   SELECT pid, xact_start, state, query
   FROM pg_stat_activity
   WHERE backend_xmin IS NOT NULL
   ORDER BY xact_start ASC LIMIT 5
2. If a long transaction is the culprit, coordinate termination with the service owner
3. If autovacuum is falling behind, check autovacuum_max_workers and
   autovacuum_vacuum_cost_limit

## Remediation
1. Table bloat: pg_repack with --no-superuser-check, monitor replication lag
2. Index bloat: REINDEX CONCURRENTLY (PG 12+), never REINDEX without CONCURRENTLY on hot tables
3. Emergency: VACUUM FULL only during planned maintenance, takes AccessExclusiveLock

## Post-incident
- Record bloat percentage before and after
- Update autovacuum parameters for the table if baseline bloat is high
- File follow-up to review application patterns causing churn
```

Version upgrade ADR: pg_upgrade vs logical replication switchover. Postgres 18 GA shipped in fall 2025, and every platform team is now writing this ADR for the PG 16 to 18 jump.

- `pg_upgrade --link` is fast (minutes of downtime on TB-scale clusters) but requires matching extension versions on both sides, a full reindex on GIN and BRIN indexes in some cases, and careful handling of logical replication slots. One shot, hard to roll back.
- Logical replication switchover requires provisioning a parallel PG 18 cluster, streaming from PG 16 via logical replication (or pglogical on older versions), reconciling replication slot lag, then cutting traffic over with pgbouncer pause/resume. Downtime drops to under a minute. Rollback is replaying the delta back to PG 16.

The ADR picks the approach per cluster size and risk tolerance. GitLab publicly documented the logical replication path for their multi-TB cluster. AWS's blue/green deployments for RDS automate the pattern but hide the control surface. The senior lesson is that the "right" answer depends on whether your team has rehearsed the rollback, not on which is theoretically better.

Managed Postgres trade-off matrix for 2026. Staff engineers are expected to present this on demand:
- Aurora Postgres. Best storage layer with 6-way replication and instant restore. Weakest on extension support (no pg_repack on Aurora, limited TimescaleDB). Aurora Limitless adds sharding but is still maturing.
- AlloyDB. Columnar accelerator for mixed OLTP/OLAP, strong on Postgres compatibility, good pricing for GCP-native orgs. Younger than Aurora.
- CockroachDB. Postgres wire-compatible but not Postgres. Pick only if you need global consistency across regions and can accept the SQL dialect gaps.
- Neon. Storage-compute separation, branching for dev environments, serverless scale-to-zero. Best for dev/preview environments, production adoption is growing.
- Supabase. Postgres plus an opinionated backend stack (PostgREST, pgvector, Realtime). Good for product teams, less control for platform teams.
- Citus (self-hosted or Azure Cosmos for Postgres). Distributed tables via sharding, proven at Microsoft scale. Operational overhead is real.
- Crunchy Bridge / Crunchy Data Postgres. Closest to vanilla Postgres with full extension access. Less automation than Aurora.

Bar-raiser questions for staff candidates on common mistakes:
1. "Your team ships a JSONB GIN index migration on a 500 GB table. The migration runs for 8 hours and then times out. What did you do wrong, and what do you do next?" Signal: knows about `CREATE INDEX CONCURRENTLY`, knows about maintenance_work_mem, knows that a failed CONCURRENTLY leaves an INVALID index that must be dropped before retry.
2. "You discover your team has been writing `SELECT FOR UPDATE` in a hot code path. Latency is fine but you suspect a ticking time bomb. What are you worried about?" Signal: row-level lock queueing under contention, deadlock risk if lock order is inconsistent, vacuum blocked by long transactions holding the locks.
3. "Describe how you would roll out pgvector to a fleet of 200 Postgres clusters." Signal: extension version pinning, canary cluster, rollout gates on memory usage (HNSW indexes are memory-hungry), rollback plan if an index corruption bug surfaces.

On-call rotation design for Postgres platform teams. The mistakes in this section are all recoverable if caught within minutes and catastrophic if caught within days. A mature rotation has primary and secondary coverage 24/7, a weekly handoff meeting that reviews the top 10 pg_stat_statements entries per cluster, a monthly game day that exercises failover and PITR, and a quarterly review of the maturity model position with the VP of infrastructure. L5 platform teams publish their SLOs for provisioning time, failover RTO/RPO, and schema change lead time, and they are measured against them.

---
