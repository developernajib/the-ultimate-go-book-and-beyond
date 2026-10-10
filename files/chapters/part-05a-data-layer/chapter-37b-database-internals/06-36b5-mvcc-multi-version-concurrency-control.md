## 37B.5 MVCC (Multi-Version Concurrency Control)

### The Problem: Readers Blocking Writers

Traditional locking systems use read locks and write locks:
- A writer takes an exclusive lock, and readers must wait
- Many readers take shared locks, and writers must wait for all readers to finish

This creates contention in any workload with mixed reads and writes. In a high-traffic web application, this means reads blocking writes and writes blocking reads - unacceptable.

**MVCC's solution**: Never block reads with writes, or writes with reads. Instead, keep multiple versions of each row simultaneously.

### How PostgreSQL Implements MVCC: xmin, xmax, Visibility Rules

Every heap tuple (row) in PostgreSQL carries two hidden system columns:

```
Tuple structure in heap:

+------------------------------------------+
| t_xmin  (4 bytes) -- transaction that    |
|                      INSERTED this tuple |
| t_xmax  (4 bytes) -- transaction that    |
|                      DELETED/UPDATED it  |
|                      (0 if still live)   |
| t_ctid  (6 bytes) -- current tuple ID    |
|                      (self if not updated|
|                      else points to new) |
| t_infomask (2 bytes) -- status flags     |
+------------------------------------------+
| Null bitmap (optional)                   |
+------------------------------------------+
| User data (columns)                      |
+------------------------------------------+
```

**Visibility rule** for a tuple to be visible to transaction T:

```
A tuple is visible to transaction T if:
  - t_xmin is committed AND t_xmin < T.snapshot.xmax
  - AND t_xmin not in T.snapshot.xip (in-progress list)
  - AND (t_xmax is 0 OR t_xmax is not committed OR t_xmax >= T.snapshot.xmax)
```

In plain English: you see rows that were inserted by committed transactions that started before your snapshot, and that have not been deleted by a committed transaction in your snapshot window.

### Seeing MVCC in Action

The following example demonstrates MVCC visibility in two concurrent sessions. Session 1 starts a transaction, then session 2 updates a row and commits. When session 1 reads the same row, it still sees the old version because the update committed after session 1's snapshot was taken.

```sql
-- Session 1: begin a long-running read transaction
BEGIN;
SELECT txid_current(); -- e.g., returns 500

-- Session 2: update a row concurrently
BEGIN;
UPDATE orders SET status = 'shipped' WHERE id = 1;
COMMIT; -- transaction 501

-- Back in Session 1: what do we see?
SELECT status FROM orders WHERE id = 1;
-- Returns: 'pending' (the OLD version)
-- Because t_xmin of the new tuple is 501, which is > our snapshot

COMMIT; -- end session 1

-- Now a new session sees:
SELECT status FROM orders WHERE id = 1;
-- Returns: 'shipped' (the NEW version)
```

### Inspecting xmin/xmax Directly

PostgreSQL exposes the MVCC system columns `xmin`, `xmax`, and `ctid` in every table. You can SELECT these columns directly to observe how updates create new tuple versions and mark old ones for cleanup.

```sql
-- See the hidden MVCC columns
SELECT xmin, xmax, ctid, id, status
FROM orders
WHERE id = 1;

--  xmin | xmax | ctid  | id | status
-- ------+------+-------+----+--------
--   500 |  501 | (0,1) |  1 | pending   <- old version (dead)
--   501 |    0 | (0,2) |  1 | shipped   <- new version (live)

-- After UPDATE, both versions exist. VACUUM will remove the dead tuple.
```

### Transaction Snapshots and Isolation Levels

A **snapshot** in PostgreSQL is a triple `(xmin, xmax, xip)`:
- `xmin`: lowest active transaction ID when snapshot was taken
- `xmax`: highest transaction ID at snapshot time (exclusive)
- `xip`: list of in-progress transaction IDs at snapshot time

```sql
-- See current transaction snapshot
SELECT txid_current_snapshot();
-- Returns: 498:502:499,500
-- Meaning: xmin=498, xmax=502, in-progress=[499,500]
-- Transactions 498,499,500,501 may or may not be visible depending on commit status
```

**When snapshots are taken per isolation level**:

| Isolation Level | Snapshot taken at |
|---|---|
| READ COMMITTED | Each statement (new snapshot per query) |
| REPEATABLE READ | Transaction start (same snapshot for all queries) |
| SERIALIZABLE | Transaction start + conflict tracking |

### MVCC and Vacuum: Cleaning Up Dead Tuples

Every UPDATE in PostgreSQL creates a **new version** of the row and marks the old version with `t_xmax`. The old version is **dead** but still occupies space until `VACUUM` removes it.

```
Table heap pages after 5 updates to the same row:

Page 0:
+---------------------------+
| Tuple: (xmin=100, xmax=101) id=1, status='new'        | <- DEAD
| Tuple: (xmin=101, xmax=102) id=1, status='processing' | <- DEAD
| Tuple: (xmin=102, xmax=103) id=1, status='shipped'    | <- DEAD
| Tuple: (xmin=103, xmax=104) id=1, status='delivered'  | <- DEAD
| Tuple: (xmin=104, xmax=0)   id=1, status='closed'     | <- LIVE
+---------------------------+

After VACUUM:
+---------------------------+
| Tuple: (xmin=104, xmax=0) id=1, status='closed'       | <- LIVE
| [free space]                                           |
| [free space]                                           |
| [free space]                                           |
| [free space]                                           |
+---------------------------+
```

VACUUM reclaims dead tuple space but does **not** return pages to the OS by default. `VACUUM FULL` rewrites the table compactly but takes an exclusive lock, avoid in production.

> **Senior track**: PostgreSQL's MVCC keeps old versions inline in the heap (no separate undo log). Oracle and MySQL InnoDB take the opposite design: the live row is always current, and old versions are reconstructed from the undo log on demand. Each approach has distinct failure modes. In PostgreSQL, long-running transactions hold back the `xmin` horizon and cause heap bloat because VACUUM cannot remove dead tuples that the long txn might still need to see. In InnoDB, the same long txn causes the undo log (rollback segment) to grow unboundedly, and can eventually block new transactions when the rollback segment fills. The symptom differs but the root cause, long open transactions, is identical.

### Table Bloat from MVCC: Causes and Solutions

**Bloat** = the ratio of dead tuple space to live tuple space. Causes:
1. High UPDATE/DELETE rate with infrequent VACUUM
2. Long-running transactions that prevent VACUUM from removing dead tuples
3. Autovacuum not keeping up with write rate

```sql
-- Check table bloat (rough estimate)
SELECT
    tablename,
    n_live_tup,
    n_dead_tup,
    round(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_dead_tup DESC;

-- Check for long-running transactions blocking vacuum
SELECT
    pid,
    now() - pg_stat_activity.query_start AS duration,
    query,
    state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes'
ORDER BY duration DESC;

-- Force VACUUM on a specific table
VACUUM ANALYZE orders;

-- Full rewrite (exclusive lock, use during maintenance windows only)
VACUUM FULL orders;
```

### Autovacuum Tuning for High-Write Workloads

Default autovacuum triggers when: `n_dead_tup > autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * n_live_tup`

Default: `50 + 0.20 * n_live_tup`. For a 10M row table: triggers at 2,000,050 dead tuples. This is too slow for high-write tables.

```sql
-- Per-table autovacuum tuning for a high-write table
ALTER TABLE orders SET (
    autovacuum_vacuum_scale_factor = 0.01,   -- trigger at 1% dead tuples
    autovacuum_vacuum_threshold = 100,        -- minimum 100 dead tuples
    autovacuum_analyze_scale_factor = 0.005,  -- analyze at 0.5% changes
    autovacuum_vacuum_cost_delay = 2,         -- less throttling (ms)
    autovacuum_vacuum_cost_limit = 400        -- more work per cycle
);

-- Global autovacuum tuning (postgresql.conf)
-- autovacuum_max_workers = 5          (default: 3)
-- autovacuum_naptime = 15s            (default: 1min)
-- autovacuum_vacuum_cost_delay = 2ms  (default: 2ms since PG12)
```

### How MVCC Enables Serializable Snapshot Isolation (SSI)

PostgreSQL's `SERIALIZABLE` isolation level uses **Serializable Snapshot Isolation (SSI)**, described by Cahill et al. (2008). It detects serialization anomalies by tracking:

- **rw-anti-dependencies**: transaction T1 reads data that T2 later writes
- A **dangerous structure** is: T1 rw-> T2 rw-> T3 where T3 commits

When a dangerous structure is detected, one transaction is aborted with `ERROR: could not serialize access due to read/write dependencies among transactions`.

```go
package mvcc

import (
    "context"
    "errors"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgconn"
    "github.com/jackc/pgx/v5/pgxpool"
)

// Go pattern: retry serializable transactions
func withSerializable(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
    const maxRetries = 5

    for attempt := 0; attempt < maxRetries; attempt++ {
        tx, err := pool.BeginTx(ctx, pgx.TxOptions{
            IsoLevel: pgx.Serializable,
        })
        if err != nil {
            return err
        }

        err = fn(tx)
        if err != nil {
            tx.Rollback(ctx)
            // Check for serialization failure (SQLSTATE 40001)
            if isSerializationFailure(err) && attempt < maxRetries-1 {
                continue // retry
            }
            return err
        }

        if err := tx.Commit(ctx); err != nil {
            if isSerializationFailure(err) && attempt < maxRetries-1 {
                continue // retry
            }
            return err
        }
        return nil
    }
    return fmt.Errorf("serialization failed after %d retries", maxRetries)
}

func isSerializationFailure(err error) bool {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        return pgErr.Code == "40001" // serialization_failure
    }
    return false
}
```

### Junior to FAANG: MVCC as a Prerequisite Bridge

If you arrived at MVCC from a "transactions are ACID, use BEGIN and COMMIT" background, the mental model shift is that reads and writes do not share the same row. A reader sees a historical snapshot of a row that the writer has already replaced on disk. The prerequisite concepts are tuple identity (ctid), transaction IDs (xid as a 32-bit counter), and the idea that DELETE does not erase bytes but stamps a tombstone field.

Worked example. You are on-call at your first backend job. A reporting query started at 09:00 and has been running for 40 minutes. Writes to the same table complete quickly, but the daily vacuum job cannot reclaim any space and the table grew 3x overnight. Walk the reasoning: the reporting transaction holds a snapshot whose xmin horizon pins every dead tuple created since 09:00. Vacuum skips tuples whose xmax is newer than the oldest active snapshot. Fix the symptom by killing the long query, then fix the root cause by either running reporting against a replica or by chunking the report into short transactions.

Interview entry-point questions you should be able to answer at the L4 or E4 level:
- Why does SELECT in Postgres never block UPDATE on the same row? Because MVCC gives the reader a snapshot that points at the pre-update tuple version, so no lock is needed.
- What is the difference between UPDATE and DELETE plus INSERT inside MVCC? Almost none at the storage layer. An UPDATE writes a new tuple and stamps xmax on the old one. HOT updates are the optimization worth naming.
- What is a dead tuple? A tuple whose xmax is committed and older than every live snapshot, so no transaction can ever see it again.

### Senior at FAANG: MVCC Internals, Engine Comparisons, and Bloat Forensics

Postgres tuple header decoded. The t_infomask bits carry HEAP_XMIN_COMMITTED, HEAP_XMIN_INVALID, HEAP_XMAX_COMMITTED, HEAP_XMAX_INVALID, HEAP_HOT_UPDATED, HEAP_ONLY_TUPLE, and HEAP_XMIN_FROZEN. The commit bits are hint bits, written lazily by the first reader that consults pg_xact (formerly pg_clog). This matters because a large SELECT after a bulk load often does heavy write I/O even though it looks read-only, as it dirties pages by stamping hint bits. In a staff-level review you flag this when someone benchmarks read latency right after a restore.

cmin and cmax are command IDs inside a single transaction, stored in an overlapping union with the xvac field. They let a statement inside a transaction avoid seeing rows that it itself inserted earlier in the same transaction (the Halloween problem for UPDATEs over a scan of the same table). Most application engineers never touch these, but they explain why a self-referential UPDATE in Postgres does not loop forever.

HOT (Heap-Only Tuple) chains. When an UPDATE touches only columns that are not part of any index, Postgres can place the new tuple on the same page and link it from the old one via t_ctid without inserting into any index. The old tuple is marked HEAP_HOT_UPDATED, the new one HEAP_ONLY_TUPLE. Index scans land on the root of the chain and walk forward to the live version. HOT pruning (cheaper than VACUUM) runs on page access and reclaims intermediate dead versions. The practical senior move is to keep fillfactor at 80 or 90 for hot-update tables so HOT has room to work, and to ensure your most frequently updated columns are not indexed.

XID wraparound is the most dangerous operational risk in Postgres. xid is 32 bits and compared modulo 2^31. Once you consume 2^31 XIDs past a tuple's xmin, that tuple effectively becomes invisible or appears from the future. To prevent this, autovacuum runs an anti-wraparound vacuum that scans tables and sets HEAP_XMIN_FROZEN on tuples whose xmin is older than vacuum_freeze_min_age, so the XID no longer matters. autovacuum_freeze_max_age (default 200M) triggers a mandatory aggressive vacuum that cannot be canceled by lock conflicts in the usual way. A database that stops vacuuming (disk full, stuck autovacuum worker, or an always-idle-in-transaction backend holding the xmin horizon) approaches the freeze threshold and eventually refuses new writes with "database is not accepting commands to avoid wraparound data loss". Your runbook must monitor age(datfrozenxid) against 2^31 and alert well before 1B.

Freezing via the HEAP_XMIN_FROZEN infomask bit (Postgres 9.4+) replaces the old practice of rewriting xmin to FrozenTransactionId (2). Visibility Map pages track all-visible and all-frozen status per heap page (the all-frozen bit arrived in 9.6), so autovacuum can skip frozen pages entirely on subsequent passes. For huge append-mostly tables this is the single biggest vacuum throughput win of the last decade.

Bloat forensics beyond pg_stat_user_tables. The rough estimator in pgstattuple gives truthful numbers but scans the whole relation. For production use pgstattuple_approx for tables over 100GB. Cross-reference with pg_class.reltuples, relpages, and the average tuple length derived from pg_column_size on a sample. When n_dead_tup stays high even after manual VACUUM, suspect: (a) a long-running transaction pinning the xmin horizon, visible in pg_stat_activity.backend_xmin, (b) a replication slot with an old catalog_xmin on the primary, (c) a prepared transaction left dangling in pg_prepared_xacts, or (d) hot_standby_feedback from a replica holding back the primary's horizon. All four show up in pg_stat_database.xact_commit patterns and in the feedback loop between pg_replication_slots.xmin and pg_stat_activity.

Engine comparison at the implementation level.

- Postgres: tuple-append MVCC. New versions live in the heap. Readers never reconstruct, they follow ctid. Cost: bloat and vacuum. Benefit: readers do zero extra work, UNDO does not exist, crash recovery is WAL redo only.
- Oracle: undo-based MVCC. The row block always contains the latest committed version. Readers that need an older snapshot apply undo records from the rollback segment in reverse. Cost: ORA-01555 "snapshot too old" when undo is recycled before a long query finishes. Benefit: no heap bloat from versions, tables stay compact.
- MySQL InnoDB: hybrid. The clustered index leaf holds the latest row plus a DB_TRX_ID and DB_ROLL_PTR pointing into the undo log. Readers walk the undo chain to reconstruct snapshots. Secondary indexes do not carry trx_id, so InnoDB uses the "delete-marked then purged" pattern and a "see the primary to verify visibility" step. Cost: undo log growth under long transactions, and secondary index lookups that bounce to the clustered index for MVCC verification. Benefit: predictable table size, clustered storage locality.

The interview prompt "why does Postgres need VACUUM but MySQL does not" is wrong on both sides. MySQL needs purge (the equivalent of vacuum) to trim undo history, and the purge thread can fall behind just as autovacuum can. The difference is where the old versions live, not whether they need cleanup.

SSI implementation detail. Postgres SSI tracks predicate locks (SIREAD locks) in shared memory at the page, tuple, or relation granularity depending on scan type. The predicate lock table is a fixed-size structure sized by max_pred_locks_per_transaction. Under heavy SERIALIZABLE load with sequential scans you will see locks escalate from tuple to page to relation, which increases false-positive serialization failures. Mitigation is to ensure the hot queries use index scans (finer-grained predicate locks), and to size max_pred_locks_per_transaction based on observed pg_locks.mode = 'SIReadLock' counts during peak.

Autovacuum tuning at scale. The cost-based throttle (vacuum_cost_delay, vacuum_cost_limit) is the knob that actually governs throughput. On NVMe the default cost_delay of 2ms with cost_limit 200 caps vacuum at roughly 8 MB/s per worker, which is absurdly low for a modern SSD. Staff-level tuning raises cost_limit to 2000 or more and keeps cost_delay at 2ms or drops it to 1ms, then increases autovacuum_max_workers to match the number of concurrently vacuumable large tables. Watch for autovacuum workers spending time on anti-wraparound passes on partitioned tables where each partition triggers independently and starves the other partitions if max_workers is too low.

---
