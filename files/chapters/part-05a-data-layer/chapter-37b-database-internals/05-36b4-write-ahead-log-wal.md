## 37B.4 Write-Ahead Log (WAL)

### What WAL Is and Why It Exists

The **Write-Ahead Log** is the mechanism by which PostgreSQL (and virtually every serious database) guarantees **durability** - the "D" in ACID. The rule is simple:

> A change must be recorded in the log **before** it is applied to the data file.

Without WAL, a crash between writing data to memory and flushing that data to disk results in data loss. With WAL, the database can replay the log on restart to recover any committed but unflushed changes.

```
Without WAL (DANGEROUS):

Transaction COMMIT
     |
     v
Write data to shared_buffers (RAM) --> CRASH HERE --> data lost forever
     |
     v
Dirty page flushed to data file (eventually, background)
With WAL (SAFE):

Transaction COMMIT
     |
     v
Write change record to WAL buffer (RAM)
     |
     v
fsync WAL buffer to WAL file on disk  <-- MUST COMPLETE BEFORE COMMIT RETURNS
     |
     v
Return "COMMIT" to client
     |
     v  (background, async)
Dirty page eventually flushed to data file

CRASH at any point: WAL is on disk -> replay on restart -> no data loss
```

### WAL Write Process: Log Before Applying

PostgreSQL WAL records contain:
- **LSN (Log Sequence Number)**: monotonically increasing 64-bit position in the WAL stream
- **Resource manager type**: heap (table), btree (index), transaction, sequence, etc.
- **Change payload / full-page image**: the modification to redo, plus a full copy of the page on its first change after a checkpoint (full-page writes)
- **Transaction ID** and timestamp

```
WAL record structure (simplified):

+------------------------------------------------------+
| xl_tot_len (4 bytes)  -- total record length         |
| xl_xid     (4 bytes)  -- transaction ID              |
| xl_prev    (8 bytes)  -- LSN of previous record      |
| xl_info    (1 byte)   -- flags + resource manager    |
| xl_rmid    (1 byte)   -- resource manager ID         |
| xl_crc     (4 bytes)  -- CRC checksum                |
+------------------------------------------------------+
| Record body (variable length)                        |
|   For heap insert: relation OID, block number,       |
|   offset, tuple data                                 |
+------------------------------------------------------+
```

WAL files live in `$PGDATA/pg_wal/`. Each WAL file is 16MB by default (`wal_segment_size`). Files are named by their LSN position, e.g., `000000010000000000000001`.

### WAL Replay on Crash Recovery

When PostgreSQL starts after an unclean shutdown, it enters recovery mode. The recovery process reads the last checkpoint location from `pg_control`, then replays every WAL record from that checkpoint forward. Committed transactions are restored. Uncommitted transactions are discarded because no COMMIT record exists in the WAL for them.

```
Crash Recovery Process:

1. PostgreSQL starts, detects unclean shutdown (no checkpoint completion record)

2. Reads the latest checkpoint record from pg_control file
   (checkpoint = point where all dirty pages were guaranteed written to disk)

3. Replays all WAL records from checkpoint LSN to end of WAL:
   - For each WAL record: apply the change to the corresponding data page
   - For committed transactions: their changes are restored
   - For in-progress transactions: ABORT them (no COMMIT record in WAL)

4. Database is now consistent as of the last committed transaction before crash
```

PostgreSQL uses a **redo-only** recovery model (no undo log, unlike MySQL InnoDB). Uncommitted transaction data is simply ignored during replay because it was never written to WAL with a COMMIT record.

> **Senior track**: Classical ARIES recovery (Mohan et al., 1992) has three phases: analysis, redo (repeat history including uncommitted txns), undo (roll back losers using the undo log). PostgreSQL skips undo because MVCC leaves old row versions in the heap: a "rolled back" transaction's tuples simply remain invisible (their xmin never commits) until VACUUM removes them. MySQL InnoDB and Oracle take the opposite approach: a separate undo log stores before-images, used both for MVCC snapshots and for rollback. That is why InnoDB's undo tablespace can explode under long transactions, whereas in PostgreSQL the same pressure manifests as heap bloat.

> **Senior track**: Under high commit load, PostgreSQL uses **group commit**: multiple backends that are ready to COMMIT coalesce into a single fsync. The `commit_delay` (microseconds) and `commit_siblings` settings control this. With NVMe storage the default zero delay is usually correct, but on higher-latency media a 10-100 microsecond delay can 5-10x throughput by amortizing fsync cost across concurrent committers.

### WAL in PostgreSQL: pg_wal Directory

You can inspect WAL state at runtime using built-in PostgreSQL functions. These queries show the current write position, how much WAL has been generated, and the checkpoint configuration that controls recovery time versus I/O overhead.

```sql
-- Current WAL LSN
SELECT pg_current_wal_lsn();

-- WAL file containing a given LSN
SELECT pg_walfile_name('0/3000060');

-- How much WAL has been generated
SELECT pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')
) AS total_wal_generated;

-- Checkpoint information
SELECT * FROM pg_control_checkpoint();

-- WAL-related configuration
SHOW wal_level;                      -- minimal, replica, or logical
SHOW synchronous_commit;             -- on, off, local, remote_write, remote_apply
SHOW checkpoint_completion_target;   -- 0.9 recommended
SHOW max_wal_size;
SHOW min_wal_size;
```

### WAL in Replication: Logical vs Physical

**Physical replication** (streaming replication):
- Streams raw WAL bytes from primary to standby
- Standby applies the same page-level changes
- Standby must be same PostgreSQL major version and architecture
- Standby is a byte-for-byte copy of primary (read-only replica)

```
Physical Replication:

Primary                         Standby
-------                         -------
WAL writer --- WAL stream ----> WAL receiver
               (binary)         WAL applier -> data files
                                (read-only replica)
```

**Logical replication** (PostgreSQL 10+):
- Streams row-level changes (INSERT/UPDATE/DELETE) decoded from WAL
- Subscriber can be different PostgreSQL version or even a different database
- Used for: selective replication, schema migration with zero downtime, CDC

```
Logical Replication:

Primary                                   Subscriber
-------                                   ----------
WAL --> logical decoding plugin  -------> logical replication worker
        (pgoutput, wal2json)              applies changes to local tables
        decodes to row changes
```

**`wal_level` setting**:
- `minimal`: minimum WAL for crash recovery only
- `replica`: WAL for physical standby replication (default since PostgreSQL 9.6)
- `logical`: WAL for logical replication (larger WAL, more overhead)

### WAL for Point-in-Time Recovery (PITR)

PITR allows restoring a database to **any moment in time**, not just the last backup:

```bash
# 1. Take base backup
pg_basebackup -h primary -D /backup/base -Ft -z -P

# 2. Archive WAL continuously (in postgresql.conf)
# archive_command = 'cp %p /archive/%f'
# archive_mode = on

# 3. Restore to a point in time:
#    - Restore base backup to new server
#    - Add to postgresql.conf:
#      restore_command = 'cp /archive/%f %p'
#      recovery_target_time = '2026-03-13 14:30:00'
#    - Start PostgreSQL -> replays WAL up to the target time
```

PITR is the foundation of database backup strategies for production systems.

### WAL Impact on Performance: fsync and sync_commit

The `fsync` call is the performance bottleneck in WAL:
- Spinning disks: ~5ms latency -> max ~200 commits/sec per connection
- NVMe SSD: ~100us latency -> max ~10,000 commits/sec per connection
- Battery-backed write cache: ~10us latency -> max ~100,000 commits/sec

**`synchronous_commit` settings**:

| Setting | Behavior | Data loss risk | Performance |
|---|---|---|---|
| `on` (default) | Wait for WAL flush to disk before ACK | None | Baseline |
| `remote_apply` | Wait for standby to apply change | None | Slowest |
| `remote_write` | Wait for standby to write (not apply) | Standby failure | Slower |
| `local` | Wait for local flush only | Standby failure | Faster |
| `off` | No wait (async commit) | Up to ~600ms of commits | Fastest |

`synchronous_commit = off` is safe for workloads where losing ~600ms of data is acceptable (e.g., logging, analytics). **Never use it for financial transactions**.

### Go Application Implications: Bulk Inserts and Write Batching

Every individual `INSERT` in its own transaction triggers a separate `fsync` of the WAL. With spinning disks at ~5ms per fsync, that caps you at roughly 200 inserts per second per connection. Batching multiple inserts into a single transaction amortizes the fsync cost: 1,000 rows in one transaction means one fsync instead of 1,000. The `COPY` protocol goes further by using a compact binary WAL format that generates less WAL volume per row than individual `INSERT` statements.

```go
package wal

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// BulkInsertWithCopy is the most WAL-efficient bulk load method.
// COPY generates less WAL than individual INSERTs because it uses
// a bulk WAL record format.
func BulkInsertWithCopy(ctx context.Context, pool *pgxpool.Pool, rows [][]any) error {
    _, err := pool.CopyFrom(
        ctx,
        pgx.Identifier{"events"},
        []string{"user_id", "event_type", "payload", "occurred_at"},
        pgx.CopyFromRows(rows),
    )
    return err
}

// BatchedInsert reduces fsync calls per row.
// 1000 rows in one transaction = 1 fsync.
// 1000 individual transactions = 1000 fsyncs.
func BatchedInsert(ctx context.Context, pool *pgxpool.Pool, events []Event) error {
    const batchSize = 1000

    for i := 0; i < len(events); i += batchSize {
        end := min(i+batchSize, len(events))

        if err := insertBatch(ctx, pool, events[i:end]); err != nil {
            return fmt.Errorf("batch %d: %w", i/batchSize, err)
        }
    }
    return nil
}

type Event struct {
    UserID     int64
    EventType  string
    Payload    []byte
    OccurredAt time.Time
}

func insertBatch(ctx context.Context, pool *pgxpool.Pool, events []Event) error {
    tx, err := pool.Begin(ctx)
    if err != nil {
        return err
    }
    defer tx.Rollback(ctx)

    b := &pgx.Batch{}
    for _, e := range events {
        b.Queue(
            "INSERT INTO events (user_id, event_type, payload, occurred_at) VALUES ($1, $2, $3, $4)",
            e.UserID, e.EventType, e.Payload, e.OccurredAt,
        )
    }

    results := tx.SendBatch(ctx, b)
    for range events {
        if _, err := results.Exec(); err != nil {
            results.Close()
            return err
        }
    }
    results.Close()

    return tx.Commit(ctx)
}
```

### Junior to FAANG: Worked Examples and Interview Entry Point

The durability contract is where most junior engineers lose points in interviews, and the fix is to rehearse a single crisp paragraph until it is automatic. The paragraph: "A transaction is durable once its commit WAL record is fsynced to disk. Postgres guarantees this by writing the WAL record to the WAL buffer during the transaction, and on COMMIT it forces a flush with fsync before returning success to the client. If the server crashes, recovery replays WAL from the last checkpoint's redo pointer forward, which reconstructs any modifications that were in shared buffers but not yet written to the data files at crash time. Transactions without a COMMIT record in WAL are treated as aborted." Any competent interviewer who hears that paragraph will move on to the next question. Any candidate who cannot produce it loses the round.

A concrete worked example to make fsync cost real. A naive ingestion service does `for _, row := range rows { db.Exec("INSERT ...") }` with one statement per transaction. Each statement commits, which forces a WAL fsync, which on NVMe costs roughly 100 microseconds. At 10000 rows that is one second of pure fsync wall time. Wrap the loop in a single transaction and the same 10000 rows commit with one fsync, a hundredfold speedup. Use `COPY FROM STDIN` and you also compress the WAL volume (COPY emits a single multi-row WAL record rather than one per row), cutting another factor of 3 to 5 out of the physical write cost. This three-line change is one of the most common performance wins junior engineers deliver in their first year, and it is entirely explainable by the WAL mechanics in this section.

The interview entry point for WAL is "what is the difference between `synchronous_commit = on`, `remote_write`, and `remote_apply`". The answer framework: `on` waits for the local WAL fsync, `remote_write` also waits for the standby to have received and written to its OS buffer cache (not yet fsynced), `remote_apply` waits for the standby to have applied the change to its data files so a read on the standby can see the commit. The tradeoff axis is commit latency versus the RPO and read-your-writes behavior of replicas. A candidate who can articulate that tradeoff and pick a setting for a given workload (financial transactions want remote_apply, analytics ingestion tolerates off) clears the bar on the replication portion of any Postgres interview.

### Senior at FAANG: WAL Design at Depth

At staff level WAL is the single most important operational subsystem in a Postgres fleet, and the material that distinguishes senior from junior engineers here is specific and concrete. Start with `wal_level`. The three values `minimal`, `replica`, and `logical` each add WAL content required by an additional use case, and each increases WAL volume. `minimal` logs only what crash recovery needs. `replica` (the default since 9.6) adds enough information for physical streaming replication and PITR. `logical` adds row-level decoded information for logical replication and CDC consumers, typically a 1.5x to 2x WAL volume increase. The default is correct for most fleets. The mistake senior engineers stop is teams enabling `logical` for a single downstream CDC consumer and taking a permanent 40 percent WAL volume hit across the entire fleet. The correct architecture is to use `wal_level = logical` only on sources that actually publish logical replication, and to split fleets if necessary to isolate that cost.

Group commit is the single most important throughput optimization for high-concurrency WAL workloads. When many transactions arrive concurrently, Postgres lets the first committer open the fsync window and piggybacks all other in-flight commits onto the same fsync call. The `commit_delay` knob (microseconds) adds a small wait before fsync to give more transactions a chance to coalesce, and `commit_siblings` is the threshold number of active transactions at which the delay engages. On NVMe the default zero delay is usually correct because fsync itself is fast enough that additional waiting does not help. On block storage with a 2 to 5 millisecond fsync floor (AWS EBS gp3 without provisioned IOPS, for example), a 50 to 200 microsecond `commit_delay` with `commit_siblings = 5` can triple commit throughput under load. A staff engineer tuning Postgres for cloud block storage should always measure commit throughput at the p50 and p99 with varying `commit_delay` and pick the knee of the curve. This is not in any default config file and it is left money on the table at most companies.

Checkpointing is where WAL mechanics turn into I/O patterns on the data file. A checkpoint writes all dirty shared buffer pages to the data file and records a new redo pointer in `pg_control`. Between checkpoints, WAL accumulates records describing modifications that may not yet be reflected in the data file. The frequency and smoothness of checkpointing is controlled by `checkpoint_timeout` (wall clock, default 5 minutes), `max_wal_size` (triggers a checkpoint when WAL volume exceeds this since the last checkpoint, default 1 GB, typically bumped to 16 to 64 GB on large fleets), and `checkpoint_completion_target` (fraction of the interval to spread the write I/O across, default 0.9). Getting these wrong produces the classic checkpoint I/O storm: `max_wal_size` too small forces checkpoints too often, and `checkpoint_completion_target` too low bunches the writes into a short period that saturates the disk and spikes p99 latency. Tune `max_wal_size` so checkpoints are triggered by the timeout, not by WAL volume, and keep `checkpoint_completion_target` at 0.9 so the I/O spreads evenly across the interval. A staff engineer owns the dashboard that correlates `pg_stat_bgwriter.checkpoint_write_time` with application-visible latency and catches misconfiguration before the on-call rotation does.

Archive mode and PITR are the disaster recovery contract. With `archive_mode = on` and an `archive_command` that ships each completed 16 MB WAL segment to object storage (typically S3 with versioning and lifecycle rules), you gain the ability to restore to any point in time covered by the archive by taking a `pg_basebackup`, configuring a `restore_command` that pulls from the archive, and setting a `recovery_target_time`. The staff-level discipline here is quarterly restore drills that actually restore a production-sized base backup plus WAL to a fresh instance, measure the RTO, and validate the RPO by comparing the restored state to the source. Any company that has PITR configured but has never tested it has exactly one outage of heads-up before they find out it does not work, and the most common failure mode is `archive_command` returning success for a file that never actually landed in the bucket because of a silent retry or permissions issue. Use `pg_verifybackup` and continuous WAL archive verification (tools like `pgBackRest` or `wal-g` do this correctly and are the right choice for any production fleet larger than a single server).

MySQL redo log and binlog warrant comparison because the architecture is fundamentally different and many senior engineers who move between engines get this wrong. InnoDB writes a physical redo log (`ib_logfile`) for crash recovery which is conceptually similar to Postgres WAL. Separately, MySQL writes a logical binlog that records statements or row changes for replication and CDC. This is two logs to coordinate at commit time, and the default setting `sync_binlog = 1` with `innodb_flush_log_at_trx_commit = 1` forces two fsyncs per commit, which is why MySQL commit throughput is often half of Postgres on the same hardware without tuning. The modern answer is group commit with binary log coordination, enabled by default in recent MySQL 8.x, which coalesces both fsyncs into a single batched operation. Staff engineers who own MySQL fleets need to know the exact semantics of `sync_binlog`, `innodb_flush_log_at_trx_commit`, and `binlog_group_commit_sync_delay` and set them per workload class, not per server default.

Physical versus logical replication in Postgres is a choice with significant operational consequences at scale. Physical replication streams raw WAL and produces a byte-identical standby which is the fastest replication path and the right default for HA and read scaling. The cost is that the standby cannot be written to, cannot have different indexes, and must match the primary's major version. Logical replication decodes WAL into row-level changes via a replication slot and applies them via a subscriber process, which allows cross-version replication, selective table replication, and heterogeneous targets. The operational hazard of logical replication is the replication slot holding back WAL indefinitely if the subscriber is offline, which leads to unbounded `pg_wal` growth and eventually primary disk exhaustion. Production systems must monitor `pg_replication_slots.confirmed_flush_lsn` versus `pg_current_wal_lsn` and alert when the gap exceeds a policy threshold (typically a few GB), and must document a procedure for dropping a broken slot before the disk fills. A staff engineer who inherits a Postgres fleet without this monitoring should consider it a P1 observability gap.

Litestream deserves a mention because it is the correct answer for small-scale durability on SQLite and it generalizes the WAL archive model to a single-node use case. Litestream tails the SQLite WAL (SQLite uses its own WAL mode distinct from Postgres WAL) and continuously replicates WAL frames to object storage, providing PITR for SQLite applications without requiring a replication-capable database server. For small-scale web services where SQLite is the right choice for simplicity (and in 2026 it is the right choice for more services than most engineers assume), Litestream plus daily snapshot verification is a full production-grade durability story for a few dollars a month in storage. The staff-level insight is that the correct database for a workload is not always the biggest database, and knowing the single-node durability options in detail lets you defend simpler architectures against complexity creep.

Finally, `pg_wal` disk governance is the operational discipline that prevents the most common cause of Postgres outages in the field. WAL files accumulate for three reasons: archiving has failed (the archive_command is erroring and segments are not being removed), a replication slot is holding WAL for a lagging or disconnected subscriber, or the WAL generation rate has spiked beyond the archive's throughput. All three produce the same symptom, which is `pg_wal` growing until the data disk fills, at which point Postgres refuses new writes and becomes read-only. The staff-level discipline is a dashboard that shows WAL generation rate, archive completion rate, replication slot retention, and `pg_wal` directory size on the same graph, with alerts at 50 percent and 80 percent of the WAL-allocated disk. The runbook for the alert has three branches (archive broken, slot stuck, write volume spike) and each branch has a specific remediation. Any Postgres production fleet without this monitoring and runbook is one busy night from an avoidable outage, and getting this in place is exactly the kind of work that promotes senior engineers to staff.

---
