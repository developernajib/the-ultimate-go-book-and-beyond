## 52I.3 CDC Fundamentals

### Why Log-Based CDC Wins

Three approaches exist for capturing database changes: query-based polling, trigger-based capture, and log-based CDC. Log-based CDC reads the database's internal transaction log asynchronously, which gives it decisive advantages in latency, completeness, and database load compared to the alternatives.

> **Senior track**: Log-based CDC is at-least-once by default. Debezium 3.4 (Apache 2.0, released Dec 2025) covers Postgres, MySQL, MongoDB, SQL Server, Oracle, Db2, and Cassandra. End-to-end exactly-once requires idempotent sinks keyed by `source.lsn` (or equivalent per-engine position). "CDC gives exactly-once" is a red flag in interviews and in production post-mortems.

| Method | Latency | Captures Deletes | DB Load | Reliability |
|--------|---------|-----------------|---------|-------------|
| Query polling | Seconds-minutes | ❌ No | High (full scans) | Miss rapid changes |
| Trigger-based | Near real-time | ✅ Yes | Medium (trigger overhead) | Breaks on DDL changes |
| Log-based | Milliseconds | ✅ Yes | Minimal (async log read) | Reliable, ordered |

### PostgreSQL WAL Architecture

PostgreSQL's Write-Ahead Log is the canonical source of truth for every committed database change, making it the ideal input for change-data-capture systems. The following diagram explains how logical decoding plugins translate raw WAL records into structured change events that external consumers can subscribe to.

```
PostgreSQL Write Path:
  Client → WAL Buffer → WAL Segment Files (pg_wal/)
                    → Shared Buffers → Data Files

WAL (Write-Ahead Log):
  - Every change recorded in WAL before data files
  - WAL is an append-only sequence of records
  - LSN (Log Sequence Number): position in WAL (e.g., 0/1A3B2C0)

Logical Replication (CDC):
  - PostgreSQL decodes WAL into logical changes (INSERT/UPDATE/DELETE)
  - Uses replication slots to track consumer position
  - Replication slot prevents WAL from being deleted until consumer reads it

Plugins:
  - pgoutput: built-in, used by Debezium
  - wal2json: outputs JSON format
  - pglogical: third-party
```

### Setting Up PostgreSQL for CDC

Enabling logical replication on PostgreSQL requires setting `wal_level = logical`, creating a replication slot, and granting the CDC user the `REPLICATION` role. The following SQL and configuration steps walk through the minimum setup required before Debezium or a custom Go CDC consumer can begin receiving change events.

```sql
-- postgresql.conf
wal_level = logical          -- required for logical replication
max_replication_slots = 10   -- one slot per Debezium connector
max_wal_senders = 10         -- concurrent WAL streaming connections

-- Create replication user
CREATE USER debezium_user REPLICATION LOGIN PASSWORD 'secret';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium_user;

-- Grant schema permissions for Debezium to read publication
GRANT USAGE ON SCHEMA public TO debezium_user;

-- Create publication for the tables we want to capture
CREATE PUBLICATION dbz_publication FOR TABLE orders, customers, products;

-- Debezium will create the replication slot automatically, but you can also:
-- SELECT pg_create_logical_replication_slot('debezium', 'pgoutput');
```

### Junior -> FAANG: CDC Concepts to Cement Before the Interview

The three CDC approaches (polling, trigger-based, log-based) appear in almost every distributed systems interview where data synchronization is relevant. The comparison table in this section is the minimum you need to memorize, but you also need to be able to explain the "why" behind each row.

Query polling misses deletes because a deleted row no longer appears in any `WHERE updated_at > last_poll` result set. Trigger-based CDC adds write overhead to every INSERT, UPDATE, and DELETE in the source database. Log-based CDC reads from the WAL, which is written as a side effect of every committed transaction, so the CDC system adds no measurable load to the OLTP write path.

The WAL architecture diagram deserves time. The key insight is that the WAL is written before the data file. This means that when Debezium reads the WAL, it sees only committed, durable changes. There is no CDC event for a transaction that was started but not yet committed, and there is no CDC event for a transaction that was rolled back. This is a stronger guarantee than trigger-based CDC, where a trigger fires before commit and may see rolled-back state.

The replication slot concept is the most operationally important piece of CDC fundamentals. A slot is a cursor into the WAL. The slot guarantees that WAL segments behind the cursor are not recycled. When you see a monitoring query for `pg_replication_slots`, what you are measuring is the gap between the slot's current position and the current WAL position. If that gap grows, either the consumer is falling behind or the consumer has stopped. If it grows without bound, PostgreSQL cannot recycle WAL segments and will eventually run out of disk.

For the interview, practice explaining `wal_level = logical` as the prerequisite. The default `wal_level = replica` writes enough WAL to support physical replication but not enough to support logical decoding. `wal_level = logical` adds the before-image of updated rows to the WAL, which Debezium needs to populate the `before` field in the change event envelope.

### Senior @ FAANG: WAL-Level Decisions and Their Downstream Consequences

Setting `wal_level = logical` and creating replication slots is not a zero-cost decision. At the senior level, the question is whether you have sized the system to absorb the consequences.

**WAL amplification.** `wal_level = logical` increases WAL write volume because the database must record the before-image of updated rows for each table that has `REPLICA IDENTITY FULL` set, or at minimum the primary key values for the default identity mode. On a write-heavy OLTP database, this can increase WAL volume by 20-40%. The additional WAL must flow through the network to physical replicas, through the replication slot to Debezium, and be stored on disk until the slot advances. On an instance with 500 GB/day of write traffic, a 30% WAL amplification is 150 GB/day of additional I/O that was not in the original capacity model.

**`REPLICA IDENTITY` strategy per table.** The Debezium `before` field is populated only for tables where `REPLICA IDENTITY` is set appropriately. The default (`DEFAULT`) records only the primary key in the WAL, so `before` is null for updates unless the update touches the primary key column. `REPLICA IDENTITY FULL` records all column values, which populates `before` completely but increases WAL volume proportional to row width. `REPLICA IDENTITY USING INDEX` uses a unique index as the identity, which is a middle ground. A senior engineer decides per-table which identity mode is required based on whether downstream consumers need the full `before` state.

**Slot management as an operational process.** At scale, slots are not managed ad-hoc. The production process is: (a) slots are created by the connector provisioning system (Kafka Connect, Strimzi, or a custom controller), not by hand, (b) slot lag is monitored by a centralized observability system with alerts wired to on-call, (c) `max_slot_wal_keep_size` is configured to a value that bounds the WAL growth in case a connector stops, (d) the runbook for a stopped connector includes the explicit step of evaluating whether the slot should be dropped and restarted from a fresh snapshot versus waiting for the connector to recover, because the decision depends on how much state divergence the downstream system can tolerate.

**Choosing `pgoutput` versus other plugins.** The `pgoutput` plugin is built into PostgreSQL 10+ and requires no external installation, which is why it is the default for Debezium 2.x+. Older deployments may use `wal2json` (JSON output, simpler for debugging but higher wire overhead) or `pglogical` (supports multi-master replication, but adds complexity). For new deployments, `pgoutput` is the correct choice. For existing deployments using `wal2json`, the migration to `pgoutput` is non-trivial because the Debezium connector must be reconfigured and will re-snapshot.

**The publication table list as a governance artifact.** The `CREATE PUBLICATION` statement lists which tables are captured. Adding a table to an existing publication is an online operation in PostgreSQL 10+, but it requires coordination with Debezium: the connector must be aware that the publication has changed, or it will miss events for the new table until the connector is restarted. At platform scale, changes to the publication should go through the same change management process as schema changes: documented, reviewed, and communicated to downstream consumer teams before they take effect.

---
