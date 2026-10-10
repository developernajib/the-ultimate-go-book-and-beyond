## 37B.14 Common Mistakes

### Mistake 1: Using Random UUIDs as Primary Keys

Random UUIDs (v4) produce uniformly distributed values that scatter B-tree inserts across the entire index, causing page splits, cache eviction, and write amplification. Use sequential IDs or time-ordered UUIDs instead.

```sql
-- BAD: causes B-tree fragmentation and high split rate
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ...
);

-- GOOD: sequential IDs or time-ordered UUIDs
CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,  -- sequential, cache-friendly
    ...
);

-- OR: ULID (sortable UUID) using pg_ulid extension
CREATE TABLE orders (
    id TEXT PRIMARY KEY DEFAULT gen_ulid(),
    ...
);
```

### Mistake 2: Missing ANALYZE After Bulk Loads

After a bulk load, the planner's statistics are stale. Without running `ANALYZE`, the planner may choose sequential scans over index scans because it thinks the table has far fewer rows than it actually does.

```sql
-- After loading millions of rows, statistics are stale
COPY orders FROM '/tmp/orders.csv' WITH (FORMAT csv);

-- ALWAYS run ANALYZE after bulk loads
ANALYZE orders;

-- For very large tables, target only affected columns
ANALYZE orders (user_id, status, created_at);
```

### Mistake 3: Creating Indexes on Low-Cardinality Columns

An index on a column with only a few distinct values (like `status`) is rarely useful because most queries will return too many rows for the planner to prefer an index scan over a sequential scan. A partial index on the selective value is far more effective.

```sql
-- BAD: status has 3 possible values, index is useless for full-table queries
CREATE INDEX idx_orders_status ON orders (status);

-- The planner will ignore this index for queries returning > ~5% of rows
-- It wastes space and slows down writes

-- GOOD: partial index for the selective case
CREATE INDEX idx_orders_processing ON orders (created_at)
    WHERE status = 'processing';  -- only 0.1% of rows
```

### Mistake 4: Using VACUUM FULL in Production

`VACUUM FULL` rewrites the entire table and takes an exclusive lock, blocking all reads and writes for the duration. On a large table, this can take hours. Use regular `VACUUM` (which runs concurrently) or `pg_repack` for online defragmentation.

```sql
-- TERRIBLE: takes an exclusive lock on the table, blocking all reads and writes
VACUUM FULL orders; -- blocks for hours on a large table

-- GOOD: regular VACUUM (non-locking)
VACUUM ANALYZE orders;

-- GOOD: pg_repack for online defragmentation (no exclusive lock)
-- pg_repack -t orders -d mydb
```

### Mistake 5: Not Handling Serialization Failures

When using `SERIALIZABLE` isolation, PostgreSQL will abort transactions that would violate serializability with error code `40001`. Applications must catch this error and retry the entire transaction. Failing to do so means users see intermittent, unexplained errors under concurrent load.

```go
// BAD: ignores serialization failure, leaves user with error
func transferFunds(ctx context.Context, pool *pgxpool.Pool, from, to int64, amountCents int64) error {
    tx, _ := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
    defer tx.Rollback(ctx)
    // ... do work ...
    return tx.Commit(ctx) // may return ERROR 40001 - not retried!
}

// GOOD: retry on serialization failure (see WithTx implementation above)
func transferFunds(ctx context.Context, pool *pgxpool.Pool, from, to int64, amountCents int64) error {
    return WithTx(ctx, pool, Serializable, func(ctx context.Context, tx pgx.Tx) error {
        // ... do work ...
        return nil
    }) // WithTx handles retries automatically
}
```

### Mistake 6: Forgetting to Set random_page_cost for SSD

The default `random_page_cost = 4.0` assumes spinning disks where random reads are 4x slower than sequential reads. On SSDs, random and sequential reads have nearly identical latency. Leaving the default causes the planner to prefer sequential scans when an index scan would be faster.

```sql
-- Default random_page_cost = 4.0 (appropriate for spinning disk)
-- On SSD, random reads are nearly as fast as sequential reads
-- This causes the planner to prefer seq scans over index scans on SSD servers

-- Fix: set in postgresql.conf or per session
SET random_page_cost = 1.1;  -- or 1.0 for NVMe SSDs

-- Check if planner is avoiding index scans unnecessarily:
SHOW random_page_cost;
```

### Mistake 7: Replication Slot Accumulating WAL

A replication slot tells PostgreSQL to retain WAL files until the subscriber confirms it has consumed them. If the subscriber goes offline, WAL accumulates without limit on the primary, eventually filling the disk and causing a full outage. Always set `max_slot_wal_keep_size` and monitor slot lag.

```sql
-- Danger: a stopped logical replication subscriber causes WAL accumulation
SELECT slot_name, active,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag
FROM pg_replication_slots;

-- Set a safety limit (PostgreSQL 13+)
-- max_slot_wal_keep_size = 10GB  (in postgresql.conf)

-- Monitor and alert when lag exceeds threshold
-- Drop dead slots immediately:
SELECT pg_drop_replication_slot('dead_subscriber_slot');
```

### Mistake 8: Not Using CONCURRENTLY for Index Creation

`CREATE INDEX` without `CONCURRENTLY` takes a lock that blocks all writes to the table for the entire build duration. On a 50M-row table, this can take minutes to hours. Always use `CREATE INDEX CONCURRENTLY` in production, which builds the index without blocking writes (at the cost of taking longer and not being usable inside a transaction block).

```sql
-- BAD: blocks all writes for the duration (hours on large tables)
CREATE INDEX idx_orders_user_id ON orders (user_id);

-- GOOD: runs without blocking writes (slower, but non-blocking)
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);

-- Note: CONCURRENTLY cannot run inside a transaction block
-- It may fail if there are concurrent schema changes
-- Check pg_indexes after completion to verify the index is valid
SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass))
FROM pg_indexes WHERE tablename = 'orders';
```

### Junior to FAANG: these mistakes as a first-year curriculum

Every mistake above is a junior-year lesson that compounds into a senior-year incident. The prerequisite gap is not knowing which mistake, but knowing how to detect that you made it. A junior who can spot these after the fact is useful. A junior who can spot them in review is on the L4 track.

Worked example for mistake 1 (random UUIDs). A first-year ships a new service with `gen_random_uuid()` as the primary key because the security team said "do not leak row counts". Two months later, ingest rate drops 40% at the same TPS. Investigation reflex: `SELECT pg_size_pretty(pg_relation_size('t')), pg_size_pretty(pg_indexes_size('t'))` shows the index is 3x the expected size. `pgstattuple` shows 70% page fullness on the btree. Root cause: random insertion causes splits and low fill. Fix: migrate to UUIDv7 going forward, `REINDEX CONCURRENTLY` to compact the existing index. Lesson: the security requirement was "not sequential-integer", not "not-time-ordered". UUIDv7 satisfies both.

"Why did this fail?" reflex table for the first year on-call.

```
Symptom                              Suspect first
-----------------------------------  ----------------------------------------
Slow query that used to be fast      Stale stats, bloat, or plan flip
Disk filling on primary              Replication slot or WAL archive failure
Long VACUUM that never finishes      Long txn or replication slot pinning xmin
Writes blocked                        CREATE INDEX without CONCURRENTLY
Random 40001 errors under load       SERIALIZABLE without retry loop
Index exists but is not used         random_page_cost = 4 on SSD, or stale stats
```

Interview entry-point at L3/L4. "You deployed a service and three weeks later the database is running out of disk. Where do you look first?" Expected: `pg_replication_slots` for stuck subscribers, `pg_stat_archiver` for failed WAL archiving, `pg_stat_user_tables` for bloat, and `pg_database_size` per database to spot a rogue log table. A junior who says "increase the disk" has not learned the lesson.

### Senior at FAANG: mistakes as incident reports and governance

Staff and principal engineers do not prevent these mistakes by warning juniors. They prevent them by making the mistakes physically impossible or automatically detected. The governance question is: "for each mistake in this section, what is the platform control that prevents it, and if prevention is not feasible, what is the detection SLO?"

Incident-report framing for mistake 7 (replication slot accumulating WAL). GitLab's January 2017 outage is the canonical write-up. The failure chain: a replication issue caused a backlog, an engineer ran `rm -rf` on what he thought was the lagging standby but was actually the primary, and then discovered five separate backup mechanisms had all silently failed. The Postgres-internals subset of that incident is: slot retention was unbounded, monitoring on slot lag was absent, and the runbook assumed the standby was identifiable by hostname rather than by querying replication state on the instance. Senior lesson: `max_slot_wal_keep_size` is not a safety net. It is a tripwire. The real control is monitoring plus automated slot ejection plus a runbook that begins "run `SELECT pg_is_in_recovery()` on every instance before destructive actions".

Governance catalog mapping mistakes to platform controls.

```
Mistake                         Control                                      Detection SLO
------------------------------  -------------------------------------------  ------------------
Random UUID PK                  Schema review lint (pgAudit/Atlas policy)    Caught at PR time
Missing ANALYZE after bulk load Migration framework auto-runs ANALYZE        N/A (prevented)
Low-cardinality index           Schema review + pg_stat_user_indexes audit   7-day unused alert
VACUUM FULL in production       DBA-only role, no VACUUM FULL grant to app   Audit log
Serialization failure ignored   SDK wrapper (WithTx) mandatory via linter    Caught at PR time
random_page_cost default        Golden Terraform module sets 1.1 on SSD      Drift detection
Slot accumulating WAL           max_slot_wal_keep_size + Prom alert          5 min from breach
CREATE INDEX without CONCURRENTLY Migration tool rejects non-concurrent DDL  Caught at PR time
```

ADR template for database-change review.

```
Title: Database change review policy for production clusters

Context:
  - 40+ services, 150+ schema changes per month, 3 incidents/quarter traced
    to schema changes that passed review.

Decision:
  - All schema changes go through Atlas or sqlc migration tooling with a
    policy engine that rejects: non-CONCURRENT index creation, DROP COLUMN
    on tables >1M rows without a deprecation window, ADD COLUMN NOT NULL
    without default, and any VACUUM FULL or CLUSTER statement.
  - Plan-diff bot runs EXPLAIN on representative queries before and after
    a migration against a production-sized replica, posts the diff to the PR.
  - Staff DBA sign-off required for changes flagged as high-risk by the
    policy engine.

Consequences:
  - PR latency increases by ~1 day for high-risk changes.
  - Incident rate from schema changes expected to drop by ~70%.
  - Teams must learn the tooling; 2-week ramp.
```

Maturity model for "common mistakes" governance (L1 to L5).

```
L1 Reactive:   mistakes discovered at 3am via pager. Runbook is tribal.
L2 Documented: wiki page lists the mistakes. Some teams read it, most do not.
L3 Monitored:  detection in place for the most damaging mistakes (slot lag,
               bloat, unused indexes, serialization failures). Alerts fire.
L4 Prevented:  schema review lint, SDK mandatory wrappers, golden config
               modules, migration tooling with policy engine. Most mistakes
               cannot reach production.
L5 Platformed: internal database-as-a-service where even the correct mistakes
               would need a config override. New teams inherit L4 by default.
               Post-incident reviews target the platform gap, not the human.
```

Staff review lens on "common mistakes" incidents. When an incident trace concludes "the engineer ran VACUUM FULL by mistake", the post-mortem action items should never be "train the engineer". The correct items are: "revoke VACUUM FULL grants from application roles, add a production-role lint to reject VACUUM FULL in migrations, add a `pg_stat_activity` alert on any query type that acquires AccessExclusiveLock on a >10GB table outside the maintenance window". Every mistake in section 37B.14 should have at least one structural control, not a cultural one. Cultural controls degrade. Structural controls do not.

Bar-raiser L6/L7 question. "You inherit a 200-service monolith-to-microservices migration and every team is making the same ten database mistakes. You have 6 months and 4 DBAs. Prioritize." Expected framework: rank by blast radius (slot-accumulating WAL is a primary outage, unused index is a cost leak), build tooling first for the top 3, socialize via office hours for the next 3, accept the remaining 4 as known-and-monitored. Tie tooling adoption to a platform adoption SLO, track it per team, escalate through engineering leadership when adoption stalls. Principals do not ship 10 fixes in 6 months. They ship 3 irreversible improvements and a cultural mechanism.

---
