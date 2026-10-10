## 33.13 Interview Questions

### Question 1: When would you use JSONB vs a separate table?

**Answer**: Use JSONB for:
- Flexible/evolving schemas
- Nested data that's queried as a unit
- Metadata that varies per row
- Document-style data

Use separate tables for:
- Data that needs referential integrity
- Frequently filtered/joined columns
- Data that needs strict schema validation
- Many-to-many relationships

**What FAANG expects**: A concrete trade-off between write amplification and query flexibility. JSONB rewrites the whole document on any update (no partial-column TOAST), so a counter inside JSONB under heavy contention is a bad fit. Mention GIN index variants (`jsonb_path_ops` for containment-only, roughly half the size of the default `jsonb_ops`) and the `@>`, `@?`, `@@` operator family. Strong candidates describe a hybrid: promote hot attributes to real columns with expression indexes or generated columns, keep the long tail in JSONB.

**Follow-ups**:
- How would you enforce that every JSONB document has a `tenant_id` key? (CHECK constraint with `jsonb_path_exists`, or a generated column that fails on NULL.)
- Your JSONB column is 2 KB average, what happens on UPDATE of one key? (Full row rewrite plus TOAST churn. Split the hot subtree into its own column.)
- When does a GIN index hurt? (Write-heavy tables: GIN maintenance lands in the pending list and vacuum, watch for bloat and tune `gin_pending_list_limit`.)

### Question 2: How does PostgreSQL full-text search compare to Elasticsearch?

**Answer**: PostgreSQL FTS is best for:
- Moderate dataset sizes (millions of rows)
- When you already use PostgreSQL
- Simpler deployment/operations
- Transactional consistency with data

Elasticsearch is better for:
- Very large datasets (billions of documents)
- Complex search requirements (facets, aggregations)
- Near real-time search
- When search is a core feature

**What FAANG expects**: Awareness that the choice is operational, not just functional. PostgreSQL FTS keeps the index transactional with the row (no CDC pipeline, no dual-write consistency bug), which matters for correctness-sensitive domains (payments, compliance). Elasticsearch wins on relevance tuning (BM25 parameters, custom analyzers), horizontal scale-out, and aggregation-heavy analytics. Strong candidates name the breakpoint: typically tens of millions of documents or sub-100ms P99 on multi-term queries is where PostgreSQL starts to struggle without careful partitioning.

**Follow-ups**:
- How would you add synonyms or stemming exceptions in PostgreSQL FTS? (`CREATE TEXT SEARCH DICTIONARY` with `synonym` template or `ispell` for morphology.)
- Describe the migration path when PostgreSQL FTS becomes the bottleneck. (Dual-write with an outbox table to Elasticsearch via a Debezium or logical-replication consumer, then cut reads over.)
- How do you implement typeahead/autocomplete in PostgreSQL? (`to_tsquery` with `:*` prefix operators, or `pg_trgm` with a GIN/GiST trigram index for fuzzy matching.)

### Question 3: Explain advisory locks vs row locks

**Answer**:
- **Row locks** (`FOR UPDATE`): Lock specific database rows, tied to transactions
- **Advisory locks**: Application-level locks, can span transactions, lighter weight

```go
// Row lock, locks the row in database
tx.QueryRow("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", id)

// Advisory lock, application-level coordination
pool.Exec("SELECT pg_advisory_lock($1)", lockID)
```

Use advisory locks for distributed coordination, row locks for data integrity.

**What FAANG expects**: Precision about scope and failure semantics. Row locks are table-row level and released with the transaction: safe by construction. Session-scoped advisory locks outlive transactions and require the same physical connection for acquire and release, if the goroutine panics or the connection is returned to the pool before unlock, the lock leaks until the session ends. Strong candidates reach for `pg_advisory_xact_lock` by default because it piggybacks on transaction cleanup and is panic-safe. They also mention that advisory-lock IDs are `bigint` and should be namespaced (e.g. hash of `(feature, entity_id)`) to avoid collisions.

**Follow-ups**:
- Your worker acquires `pg_advisory_lock(42)`, then a context timeout cancels the goroutine. What happens? (Lock held until the session ends or the connection is closed. This is why `pg_advisory_xact_lock` is safer.)
- How would you implement leader election across N replicas? (All replicas call `pg_try_advisory_lock(well_known_id)` on a dedicated connection. Whoever gets `true` is leader. On disconnect, PostgreSQL releases the lock and a new election occurs.)
- What is `SELECT ... FOR UPDATE SKIP LOCKED` and when would you use it over advisory locks? (Job queue dequeue pattern, lets N workers pick distinct rows without serializing.)

### Question 4: How do CTEs affect query performance?

**Answer**: Before PostgreSQL 12, CTEs were "optimization fences" that materialized results. Since PostgreSQL 12, CTEs can be inlined. Key considerations:

```sql
-- May be slower: CTE materialized unnecessarily
WITH user_orders AS (
    SELECT * FROM orders WHERE user_id = $1
)
SELECT * FROM user_orders WHERE status = 'pending';

-- Better: Let planner optimize
SELECT * FROM orders WHERE user_id = $1 AND status = 'pending';

-- CTEs are still useful for:
--   1. Recursive queries (required)
--   2. Query organization/readability
--   3. When you need the result multiple times
--   4. INSERT/UPDATE/DELETE in CTEs
```

**What FAANG expects**: The precise rule: on PostgreSQL 12+, a non-recursive CTE is inlined only if it is referenced exactly once, has no side effects, and is not marked `MATERIALIZED`. Force materialization with `WITH foo AS MATERIALIZED (...)` when you want to compute once and reuse, or block it with `AS NOT MATERIALIZED` to force inlining. Strong candidates know that data-modifying CTEs (`WITH x AS (INSERT ... RETURNING ...)`) always run once and are the idiomatic way to do multi-table writes atomically. They read `EXPLAIN (ANALYZE, BUFFERS)` to spot a `CTE Scan` node, which signals materialization.

**Follow-ups**:
- Write a single statement that moves rows from `orders` to `archived_orders` and returns the moved IDs. (`WITH moved AS (DELETE FROM orders WHERE ... RETURNING *) INSERT INTO archived_orders SELECT * FROM moved RETURNING id`.)
- A recursive CTE over an org chart runs forever. What happened? (Cycle in the data, add a cycle detection `UNION ALL ... WHERE NOT c.id = ANY(ct.path)` or use the PG 14+ `CYCLE` clause.)
- Why might inlining make a query slower? (Predicate push-down can change join order in a way that defeats a selective index. Use `MATERIALIZED` to pin the plan.)

### Question 5: How would you implement database-backed job queue?

**Answer**: Use `FOR UPDATE SKIP LOCKED` pattern:

```go
func dequeueJob(ctx context.Context, pool *pgxpool.Pool) (*Job, error) {
	tx, _ := pool.Begin(ctx)
	defer tx.Rollback(ctx)

	var job Job
	err := tx.QueryRow(ctx, `
		SELECT id, payload, attempts
		FROM jobs
		WHERE status = 'pending'
		AND scheduled_at <= NOW()
		ORDER BY priority DESC, scheduled_at
		FOR UPDATE SKIP LOCKED
		LIMIT 1
	`).Scan(&job.ID, &job.Payload, &job.Attempts)

	if err != nil {
		return nil, err
	}

	_, err = tx.Exec(ctx, `
		UPDATE jobs SET status = 'processing', locked_at = NOW()
		WHERE id = $1
	`, job.ID)

	tx.Commit(ctx)
	return &job, nil
}
```

**What FAANG expects**: A durable design that survives crashes and scales horizontally. `FOR UPDATE SKIP LOCKED` is the right primitive, it lets N concurrent workers grab distinct rows without contention. Strong candidates also cover: partial index on `(scheduled_at) WHERE status = 'pending'` to keep lookup O(log n) as the jobs table grows, a visibility-timeout reaper that re-queues rows where `locked_at < NOW() - interval '5 min'` to handle worker crashes, an `attempts` counter with exponential backoff and a dead-letter status, and batched claims (`LIMIT 50`) to amortize round-trip latency. They mention LISTEN/NOTIFY as a wake-up signal so workers do not poll unnecessarily, with a timer fallback in case notifications were dropped.

**Follow-ups**:
- At 10K jobs/sec, where does this break? (Index bloat on the partial index, VACUUM pressure from the high UPDATE rate, and row-lock contention on the ORDER BY. Mitigations: partition by `(created_at)` or priority, move completed rows out quickly, or switch to a log-structured broker like Kafka.)
- How do you guarantee exactly-once execution of side effects? (You can't end to end, but you can enqueue the side effect transactionally via the outbox pattern and make the handler idempotent via an idempotency key.)
- A worker pulls a job, crashes mid-processing. How do you recover? (Reaper sweeps rows whose `locked_at` exceeds the visibility timeout and resets them to `pending`, incrementing `attempts`.)

### Junior → FAANG: Interview Entry-Point and Signal Ladder

The five questions above are archetypes. Real FAANG loops will remix them into problem statements where the candidate must pick the pattern, justify the choice, and debug a broken version. Juniors who memorize answers fail. Juniors who know the shape of the answer and can adapt it to new constraints advance.

Prerequisite gaps to close before your first Postgres-heavy interview loop:
1. You must have run `EXPLAIN (ANALYZE, BUFFERS)` on a real query in production or staging at least ten times. If you have only seen `EXPLAIN` output in slides, the interviewer will catch you on the first follow-up.
2. You must know the MVCC basics cold. When a row is UPDATE'd, Postgres inserts a new tuple and marks the old one dead. VACUUM reclaims the dead tuples. Long-running transactions block VACUUM. This one paragraph answers half of all Postgres interview questions.
3. You must know the index types: btree, hash, GIN, GiST, SP-GiST, BRIN, HNSW (via pgvector). For each, know one use case and one anti-use-case. Example: BRIN is tiny and fast on append-only time-series tables, useless on randomly distributed data.
4. You must have read at least one major `pg_stat_statements` dump and been able to name the top query. If you have not, pick any Postgres tutorial dataset, generate load, and do it this weekend.

Worked example to practice the "why did this fail?" reflex. Given: "Our job queue using `FOR UPDATE SKIP LOCKED` worked fine at 100 jobs/sec. At 5000 jobs/sec it fell over." Walk through:
- Check `pg_stat_user_tables.n_dead_tup` on the jobs table. If it is 10x the live row count, autovacuum is losing.
- Check `pg_stat_statements` for the dequeue query. If `mean_exec_time` is stable but `calls` is 5000/sec, you are CPU-bound on planning. Use a prepared statement.
- Check `pg_stat_activity` for workers blocked on `LWLock:WALInsert`. If many workers commit simultaneously, the WAL insert lock serializes them. Commit batching or `synchronous_commit = off` for non-critical jobs is the lever.
- Check partial index definition. `WHERE status = 'pending'` must be the exact predicate, including type coercion.

Signal ladder for entry-level roles (L3/SWE I, L4/SWE II):
- L3: Can name JSONB vs table trade-offs, knows `FOR UPDATE`, can write a CTE. Cannot yet reason about lock escalation or VACUUM.
- L4: Can read `EXPLAIN ANALYZE`, knows GIN vs btree, can implement the SKIP LOCKED job queue from memory, knows why CTEs changed in PG 12. Can debug one slow query unassisted.

Interview entry-point questions graded easiest to hardest:
1. "What is an index?" (L3 warm-up.)
2. "When would you use a partial index?" (L4 baseline.)
3. "Walk me through a dequeue operation with 20 concurrent workers on a jobs table." (L4/L5 separator.)
4. "Your p99 latency doubled after a deploy that added one new query. How do you diagnose it?" (L5 signal.)

### Senior @ FAANG: Bar-Raiser Questions and the L3-to-L7 Signal Ladder

Every FAANG Postgres interview loop has a bar-raiser slot. The bar-raiser does not care whether the candidate gets the "right" answer. They care whether the candidate reasons about production constraints under ambiguity. The questions below are drawn from the kinds of problems that staff and principal engineers actually face at Postgres-heavy shops like Figma, Shopify, Notion, Instacart, and GitLab in 2026.

Bar-raiser question 1: the 9-month migration story. "Tell me about a database migration you led that took more than six months. What surprised you?" Staff-level signal:
- The candidate structures the answer as shadow traffic phase, dual-write phase, cutover phase, cleanup phase.
- They mention at least one thing that went wrong and was not in the plan (replication lag spike, schema drift between environments, a forgotten consumer of the old table).
- They discuss the rollback criteria. Not "we had a rollback plan" but "we had a specific lag threshold past which we would abort the cutover."
- They name the stakeholders managed: SRE, security, the team whose schema was being migrated, and the teams consuming the data.

Bar-raiser question 2: index bloat debug. "You are paged at 2 AM. A query that normally runs in 10 ms is running in 4 seconds. Autovacuum is running. Replication is healthy. Walk me through it." Staff-level signal:
- Reaches for `pg_stat_user_indexes` to compare `idx_scan` counts before and after.
- Checks `pgstatindex` for bloat percentage, knowing that btree indexes degrade when the leaf density drops below 50%.
- Considers that the query might have shifted plans. Runs `EXPLAIN (ANALYZE, BUFFERS)` and compares to a known-good plan captured from `auto_explain` logs.
- Knows that `REINDEX CONCURRENTLY` is the fix but also knows it can fail partway and leave an INVALID index.
- Does not jump to "restart the database." That answer fails the interview.

Bar-raiser question 3: replica lag cascade. "Your primary is fine. Replica 1 is 30 seconds behind. Replicas 2 and 3 are 5 minutes behind and growing. The application is starting to return stale data. What do you do?" Staff-level signal:
- Distinguishes streaming replication from logical replication. Streaming lag is usually WAL apply bottleneck (replica can't keep up with disk writes or has a long-running query blocking recovery). Logical lag is usually a slow consumer or a schema change the subscription cannot handle.
- Checks `pg_stat_replication` for `write_lag`, `flush_lag`, `replay_lag`. The difference between these tells you whether the lag is network, disk, or CPU bound.
- Knows about `hot_standby_feedback`. If enabled, long read queries on replicas prevent vacuum on primary, creating a feedback loop. If disabled, you get query cancellations on replicas under heavy primary write load. There is no free lunch.
- Considers failing over to the healthy replica and rebuilding the lagging ones from base backup as a last resort. Knows the RTO/RPO implications.

Bar-raiser question 4: extension review. "Your team wants to adopt pgvector. Write the ADR in ten minutes." Staff-level signal:
- Memory footprint of HNSW indexes (typical: 2-4x the size of the raw vector data).
- Operational story: does the managed provider (RDS, Aurora, AlloyDB, Supabase) support the pgvector version you need? RDS was notoriously slow to support pgvector 0.5+.
- Rollback: HNSW index build is expensive. If you drop pgvector, you lose all vector data unless you dump the raw vectors separately.
- Alternatives considered: dedicated vector DB (Pinecone, Weaviate, Qdrant, Turbopuffer) vs in-Postgres. The candidate should articulate the consolidation-vs-specialization trade-off.

L3 to L7 signal ladder for Postgres interview loops:
- L3 (SWE I, new grad): Names index types, writes simple SELECT/UPDATE/DELETE, can explain WHERE vs HAVING. Cannot read EXPLAIN yet.
- L4 (SWE II): Reads EXPLAIN, writes CTEs and window functions, understands transactions and isolation levels at a surface level. Can debug a missing index.
- L5 (Senior SWE): Understands MVCC, VACUUM, HOT updates. Can design a schema for a moderately complex feature. Can debug a live performance regression with `pg_stat_statements`.
- L6 (Staff SWE): Leads schema design reviews. Writes ADRs for extension adoption. Understands the operational cost of choices (index maintenance, replication lag, autovacuum tuning). Has run at least one migration at scale.
- L7 (Principal / Senior Staff): Sets the platform strategy. Decides Citus vs Aurora vs vanilla, makes the major-version upgrade call across the fleet, runs incident reviews that change the architecture. Is the person the VP calls at 3 AM.

Rubric for grading a candidate's answer to "design a Postgres-backed job queue":
- L4: Names SKIP LOCKED, writes the basic query. Misses the reaper.
- L5: Adds partial index, visibility timeout, attempts counter, LISTEN/NOTIFY wake-up. Knows about idempotency keys.
- L6: Discusses partitioning strategy for the jobs table, index bloat mitigation, and when to migrate off Postgres (roughly 10K jobs/sec sustained). Has opinions on river, pgq, Graphile Worker vs rolling your own. Considers observability from day one (metrics on queue depth, oldest pending age, per-handler latency).
- L7: Questions the premise. "Should this be a queue or a workflow engine? Should it be Postgres or Temporal or Kafka? What are the durability and ordering requirements? What is the team's operational maturity?" Frames the answer in terms of organizational cost, not just technical fit.

Operational vignettes that separate L6 from L7:
- The candidate is told their proposed solution will require 2 SRE-years of ongoing maintenance. Do they push back or accept? L7 negotiates the scope or pushes for a managed service. L6 accepts and builds a runbook.
- The candidate's approach works but requires every team to adopt a new schema-change tool. How do they drive adoption? L7 builds the golden-path template, funds the migration with a platform team, and measures adoption as an OKR. L6 writes the docs and hopes.

Interview anti-patterns that drop a candidate's level:
- Quoting benchmark numbers without naming the version, hardware, or workload.
- Claiming "Postgres can handle anything" without acknowledging the operational limits.
- Not knowing that `pg_stat_statements` exists, or never having read its output.
- Recommending VACUUM FULL as a routine operation.
- Confusing `SERIALIZABLE` in Postgres (SSI) with `SERIALIZABLE` in other databases (2PL).

---
