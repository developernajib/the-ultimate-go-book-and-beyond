## Summary

Internal database mechanisms that every senior and staff engineer must understand:

**B-Tree internals**: PostgreSQL uses B+ trees where leaf nodes are linked for range scans. Insertions cause splits, deletions cause merges. O(log n) search with typically 3 to 4 page reads for billion-row tables. Column order in multi-column indexes matters - the prefix rule governs usability.

**LSM trees**: Optimize writes by converting random I/O to sequential I/O via MemTable → SSTable pipeline. Compaction strategies trade write amplification for read amplification. Used by RocksDB, Cassandra, ClickHouse. Choose based on read vs write workload ratio.

**WAL**: Every committed change is first written to WAL (sequentially, synced to disk), then lazily applied to data files. On crash, WAL is replayed from the last checkpoint. The foundation for durability, replication, and PITR.

**MVCC**: Each row carries `xmin`/`xmax` transaction IDs. Readers see a consistent snapshot without blocking writers. Old versions accumulate as dead tuples - VACUUM reclaims them. Table bloat from delayed vacuum is a top cause of unexpected query slowdowns.

**Query planner**: Parses → rewrites → plans → executes. Uses statistics from `pg_stats` to estimate costs. `EXPLAIN ANALYZE` reveals actual vs estimated rows - discrepancy means stale statistics. Scan type choice (index vs bitmap vs seq) depends on selectivity and planner cost estimates.

**Index types**: B-tree for ranges and equality. GIN for multi-valued types (JSONB, arrays, FTS). GiST for geometric and exclusion. BRIN for time-series. Partial for selective subsets. Expression for computed values.

**Isolation levels**: READ COMMITTED (default, new snapshot per statement) vs REPEATABLE READ (snapshot at start) vs SERIALIZABLE (SSI - full serializability, requires retry on 40001).

**Connection pooling**: PostgreSQL connection = OS process (~5-10MB). Pool with PgBouncer transaction mode. Size: `cores * 2 + disk_spindles`. Monitor utilization and wait time.

**Replication**: Physical replication streams raw WAL bytes. Logical replication streams decoded row changes. Replication slots retain WAL - monitor lag or risk disk exhaustion.

### Junior to FAANG: what to internalize from this chapter

If you remember nothing else, remember these five. (1) Every INSERT is not just a row write, it is a WAL record, an index entry per index, and a visibility map update. Cost scales with index count. (2) MVCC means old row versions stay in the heap until VACUUM runs, so bloat is not a bug, it is the price of non-blocking reads. (3) Statistics drive plans, and stale statistics cause plan regressions that look like "the database just got slow". `ANALYZE` is not optional. (4) `EXPLAIN (ANALYZE, BUFFERS)` is your primary diagnostic tool. Read `actual rows` vs planner `rows`, `Rows Removed by Filter`, and `Buffers: shared read`. Everything else is detail. (5) Replication is not a backup. A replica with a dead subscriber slot is an outage timer.

First-job reflex checklist. Before proposing a schema change, answer: how many indexes does this add, what is the write cost, what existing query does this help, is there a partial or INCLUDE variant that is cheaper, and does the migration need `CONCURRENTLY`. Before proposing an index removal, answer: does `pg_stat_user_indexes.idx_scan` confirm disuse over at least one full business cycle. Before running any `VACUUM FULL`, `CLUSTER`, or `REINDEX` without `CONCURRENTLY` on production: do not.

Interview entry-point. A junior who can confidently narrate "INSERT -> heap tuple with xmin -> btree leaf insert -> WAL record -> fsync on commit -> visibility map stays stale until next VACUUM" has the mental model for the rest of the chapter. Lock this in before memorizing anything else.

### Senior at FAANG: the chapter as a platform blueprint

At staff and principal level, this chapter is not knowledge. It is a checklist of platform controls you owe your organization.

ADR coverage matrix. Every production Postgres tier needs an ADR for: replication topology (physical vs logical vs consensus-replicated), backup and restore (with a tested RTO), connection pooling, schema migration tooling, index review policy, observability stack (pg_stat_statements, auto_explain, pg_wait_sampling, commercial layer), CDC pipeline if applicable, vacuum and XID wraparound management, and disaster-recovery runbooks with quarterly drills.

Maturity model composite (L1 to L5 across the chapter's domains).

```
Domain              L1 Reactive        L3 Diagnostic        L5 Platformed
------------------  ------------------ -------------------- -------------------
B-tree/Index design ad-hoc             review at PR time    policy engine blocks
MVCC/VACUUM         incidents          per-table tuning     auto-tuned fleet
WAL/Durability      defaults           measured commit tail tiered durability SLO
Query planner       no capture         auto_explain on      plan regression CI
Isolation           RC everywhere      per-use-case choice  mandated SDK wrapper
Connection pooling  per-app pool       central PgBouncer    pool-as-a-service
Replication         one async standby  monitored quorum     global CDC platform
Observability       CPU dashboards     query attribution    predictive alerts
```

Staff-level review checklist to apply when any team proposes a new database-backed service. (1) Has the data model been reviewed for hot-row contention, index cost, and bloat characteristics? (2) Is the migration path tested on a production-sized replica, not a toy dataset? (3) Does the service use the mandated SDK wrapper with retries on 40001 and on connection errors? (4) Is there a dashboard for per-query latency, replication lag, slot lag, and vacuum age before launch, not after? (5) Is the on-call runbook aligned with the fleet runbook, or has this team reinvented incident response? (6) Is the backup strategy tested by restore, not by existence? (7) Is the team aware of XID wraparound and does their workload profile have a projected wraparound horizon?

Bar-raiser governance questions.

- What is the RPO and RTO for each tier, and how were they measured, not assumed?
- What is the platform's position on consensus-replicated storage (Cockroach, Yugabyte, Spanner)? An organization without a written position is making the choice by accident one service at a time.
- How is plan regression detected, attributed, and remediated? If the answer is "developers complain in Slack", the platform is at L1.
- What is the automation boundary for destructive operations? `VACUUM FULL`, `REINDEX`, `DROP SLOT`, and `pg_promote` should all have documented approval paths, not implicit trust.
- What is the data-freshness contract for downstream consumers of CDC? Without an SLO, analytics teams will make decisions on stale data without knowing it.

Revisit triggers. Every ADR in this stack should name the conditions that would force reconsideration. Examples: "revisit replication topology if cross-region write latency budget drops below 100ms", "revisit pooling layer if connection count per service exceeds 500", "revisit index governance if schema-change incidents exceed 1 per quarter". ADRs without revisit triggers become archeological artifacts instead of governance.

The senior-track lesson of this chapter, in one sentence: internals knowledge is the foundation for the platform decisions that prevent the incidents, and the hallmark of a staff-plus engineer is that the incidents this chapter warns about do not happen on their fleet, not because the team is careful but because the platform makes them structurally impossible.

---
