## 37B.13 Interview Questions

### FAANG-Level Database Internals Q&A

**Q1: What is the difference between a B-tree and a B+ tree? Which does PostgreSQL use?**

A: A classical B-tree stores data payloads in every node (internal and leaf). A B+ tree stores payloads only in leaf nodes. Internal nodes are pure routing structures holding separator keys. Leaves in a B+ tree are linked in a doubly-linked list for efficient range scans. PostgreSQL, MySQL InnoDB, SQL Server, Oracle, and SQLite all use B+ tree variants because the linked leaf list lets a range scan walk from the starting leaf without re-traversing internal nodes.

What FAANG expects: be precise. Saying "PostgreSQL uses a B-tree" is the common half-right answer that costs signal. The correct phrasing is "PostgreSQL uses a B+ tree with Lehman-Yao concurrent sibling pointers."

Follow-ups:
- How does InnoDB's clustered B+ tree differ from PostgreSQL's? (InnoDB leaves hold the full row. secondary indexes store primary key values, not heap pointers.)
- What is a fill factor and why would you lower it below 100%? (Leaves headroom so subsequent inserts do not immediately trigger page splits.)
- Why do B+ tree height rarely exceed 4-5 levels in practice? (Fanout of hundreds means a billion rows fit in height 4.)

---

**Q2: Why do UUIDs perform worse than BIGSERIAL as primary keys?**

A: BIGSERIAL values are monotonically increasing, so B+ tree inserts always land on the rightmost leaf. Only one page is "hot," which fits in cache and never splits in the middle of the tree. UUIDv4 values are random, so inserts scatter across the entire index. Every insert touches a random leaf, evicting cached pages, triggering splits anywhere in the tree, and causing 2-5x more I/O at scale. Dead tuples from UPDATEs also concentrate randomly, worsening VACUUM cost.

What FAANG expects: name the fix. UUIDv7 (time-ordered UUID, RFC 9562) or ULID restores sequential locality while keeping the opacity and uniqueness benefits of UUID. This is the expected senior answer in 2026.

Follow-ups:
- Why not just use auto-increment everywhere? (Leaks row count, hotspot on insert for sharded systems, coordination cost in distributed DBs.)
- How does InnoDB handle random primary keys differently from PostgreSQL? (Clustered index means the heap itself is reordered. fragmentation is worse.)
- What is "index tree locking contention" on the rightmost leaf? (Under very high insert rate, every inserter serializes on the rightmost page latch. Some DBs use optimistic descent or leaf-only locks to mitigate.)

---

**Q3: What is WAL and how does it guarantee durability?**

A: WAL (Write-Ahead Log) is an append-only log of physical changes that must be fsynced to disk before the corresponding commit returns to the client. On crash, the database replays WAL from the last checkpoint to recover committed transactions. Sequential appends are orders of magnitude faster than random page flushes, so the log provides both durability and throughput.

What FAANG expects: mention group commit and the fsync bottleneck. Senior candidates should explain why spinning disk gives ~200 commits/sec per connection (one fsync per commit, ~5ms each), how group commit amortizes fsync across concurrent committers, and how `synchronous_commit = off` trades a bounded data-loss window for throughput.

Follow-ups:
- How does PostgreSQL's WAL differ from InnoDB's redo log plus undo log? (PostgreSQL has no undo log. MVCC leaves old tuples in the heap.)
- What is a checkpoint and why does it cause I/O spikes? (Forces all dirty pages to data files so WAL before the checkpoint can be recycled.)
- Explain ARIES recovery phases. (Analysis, redo repeating history, undo rolling back losers. PostgreSQL skips the undo phase.)

---

**Q4: Explain MVCC. How does PostgreSQL implement it?**

A: MVCC keeps multiple versions of each row so readers never block writers and writers never block readers. In PostgreSQL, every heap tuple carries `xmin` (inserting txid) and `xmax` (deleting/updating txid). A transaction sees a tuple if `xmin` is committed and inside its snapshot, and `xmax` is either zero, not committed, or outside the snapshot. UPDATEs create a new tuple and mark the old one with `xmax`, and VACUUM later reclaims dead tuples.

What FAANG expects: contrast PostgreSQL's in-heap MVCC with Oracle and InnoDB's undo-log MVCC. Postgres bloat vs Oracle/InnoDB undo growth are two faces of the same problem (long transactions).

Follow-ups:
- Why is `SELECT COUNT(*)` expensive in PostgreSQL? (Must check visibility of every tuple. No row-count metadata because different snapshots see different counts.)
- What is the `xmin` horizon and what holds it back? (Oldest running transaction, oldest replication slot, oldest prepared txn. VACUUM cannot remove tuples newer than the horizon.)
- How does PostgreSQL handle transaction ID wraparound? (XIDs are 32-bit. VACUUM FREEZE rewrites old xmin values to a special frozen value.)

---

**Q5: What is table bloat and how do you fix it?**

A: Bloat is dead-tuple accumulation in the heap (and dead entries in indexes) that VACUUM has not yet reclaimed. Every UPDATE creates a new tuple version and marks the old one dead. Causes: high UPDATE/DELETE rate with lagging autovacuum, long-running transactions holding back the `xmin` horizon, or a replication slot that has fallen behind. Diagnose via `pg_stat_user_tables.n_dead_tup` and the `pgstattuple` extension. Fix via `VACUUM ANALYZE` (online), per-table autovacuum tuning, `pg_repack` (online rewrite), or `VACUUM FULL` in a maintenance window.

What FAANG expects: identify long-running transactions as the root cause before touching autovacuum knobs. Senior candidates diagnose, they do not spray configuration.

Follow-ups:
- How would you find the transaction blocking VACUUM right now? (`pg_stat_activity` for long `idle in transaction`, `pg_replication_slots` for stuck subscribers.)
- Why can increasing autovacuum workers sometimes make bloat worse? (More concurrent I/O can starve foreground workload. Cost-based delay matters.)
- What is HOT (Heap-Only Tuple) update and when does it avoid index bloat? (Update stays on same page, no indexed column changed. Index entries reused.)

---

**Q6: What is the difference between `EXPLAIN` and `EXPLAIN ANALYZE`?**

A: `EXPLAIN` prints the planner's chosen plan with estimated row counts and costs, without executing the query. `EXPLAIN ANALYZE` actually runs the query and reports actual row counts, timings, and buffer statistics alongside the estimates. The gap between estimated and actual rows is the primary signal for stale statistics or bad correlation assumptions.

What FAANG expects: always request `BUFFERS` and know what the output means. `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` is the senior default. Candidates should know never to run `EXPLAIN ANALYZE` on DML outside a `BEGIN. ... ROLLBACK;` envelope.

Follow-ups:
- What does "Rows Removed by Filter: N" tell you? (Index is not selective enough. Consider partial or composite index.)
- What does a 1000x row estimate error imply? (Stale `pg_statistic`. Run `ANALYZE`, consider `default_statistics_target` or per-column stats target.)
- How do you force a plan for testing without rewriting SQL? (`SET enable_seqscan = off`, `pg_hint_plan` extension. Use sparingly.)

---

**Q7: When would you use a GIN index vs a B-tree index?**

A: Use GIN for composite values where one row contains many indexable items: JSONB keys/values (`@>`, `?`), array elements (`@>`, `&&`), and tsvector lexemes (`@@`). GIN maintains an inverted index mapping each token to a posting list of row TIDs. B-tree only supports scalar ordered comparisons. GIN is larger and updates slower but is the only viable answer for containment semantics.

What FAANG expects: mention the pending list and `jsonb_path_ops`. Senior candidates know GIN writes land in a pending list (`fastupdate = on`) that is merged lazily, and that `jsonb_path_ops` gives a smaller, faster index for `@>` but loses `?` support.

Follow-ups:
- When is an expression B-tree on `(metadata->>'source')` better than a GIN on `metadata`? (Single key queried, far smaller index.)
- What is GIN write amplification and how does it scale with array size? (Every element is a posting list update. Large arrays amplify write cost.)
- How does GIN differ from GiST for full-text search? (GIN is lossless and faster to query, slower to update. GiST is lossy summary, better for frequent updates.)

---

**Q8: What is a partial index and when would you use it?**

A: A partial index covers only the rows satisfying a predicate. It is smaller, cheaper to maintain, and more selective than a full index. Classic uses: index only non-null values of a sparse column, index only `status = 'active'` in a mostly-archived table, or index only recent data in a large time-series. The query must use a predicate that the planner can prove implies the index predicate.

What FAANG expects: know that the planner uses predicate implication, not syntactic match. A query `WHERE status IN ('pending', 'processing')` can use a partial index `WHERE status != 'archived'` because the planner proves implication.

Follow-ups:
- Why does `WHERE created_at > NOW() - INTERVAL '1 day'` not use a partial index defined `WHERE created_at > '2026-01-01'`? (`NOW()` is stable but not immutable across statements for planning proofs. Use a literal.)
- What is the maintenance cost of many partial indexes? (Each INSERT evaluates every partial predicate. dozens of overlapping partials can dominate write cost.)
- When is a partial index worse than a full index? (When the predicate eliminates few rows. overhead without benefit.)

---

**Q9: What is a BRIN index and when is it appropriate?**

A: BRIN (Block Range INdex) stores min/max summaries per fixed range of heap pages. It is orders of magnitude smaller than a B-tree (kilobytes for a billion rows) but only effective when column values are physically correlated with storage order. Queries use the summary to skip non-overlapping page ranges, then re-check within the candidate ranges. Ideal for append-only time-series, IoT sensor logs, audit tables.

What FAANG expects: explicit statement that BRIN needs correlation. Inserting randomly-timestamped rows into a BRIN-indexed table degrades the index to scanning everything.

Follow-ups:
- What is `pages_per_range` and how do you tune it? (Smaller = more precise, larger index. Larger = less precise, smaller index.)
- What is a multi-minmax BRIN opclass? (PostgreSQL 14+ stores multiple min/max pairs per range to handle mild disorder.)
- How do you restore BRIN correlation on a bloated table? (CLUSTER on the indexed column, or pg_repack with order. Or partition.)

---

**Q10: Explain the difference between READ COMMITTED and REPEATABLE READ isolation levels in PostgreSQL.**

A: READ COMMITTED takes a fresh snapshot at each statement, so two SELECTs in the same transaction can see different values if another transaction commits in between (non-repeatable read). REPEATABLE READ takes one snapshot at the first statement and uses it for the whole transaction, giving consistent reads. PostgreSQL's REPEATABLE READ also prevents phantoms because snapshot isolation cannot see newly-inserted rows committed after the snapshot.

What FAANG expects: know that PostgreSQL's REPEATABLE READ is Snapshot Isolation, not the SQL-standard RR, and that SI still allows write skew, which is why SERIALIZABLE (SSI) exists.

Follow-ups:
- Give a write skew example. (Two doctors check "at least one on call" then both go off call. Both read the same snapshot, both write safely, invariant broken.)
- Why does `SELECT ... FOR UPDATE` behave differently under RC vs RR? (RC sees latest committed row and locks it. RR can get `could not serialize access` if the row was modified after the snapshot.)
- When would you use RR instead of RC? (Multi-statement read consistency, backup snapshots, reports that must see a consistent point in time.)

---

**Q11: What is replication lag and what causes it?**

A: Replication lag is the delay between commit on primary and replay on standby. Causes: network bandwidth below WAL generation rate, standby disk I/O slower than primary, long-running standby queries blocking WAL apply under `max_standby_streaming_delay`, and large transactions creating bursts of replay work. Monitor via `pg_stat_replication.replay_lag` and slot `confirmed_flush_lsn`.

What FAANG expects: name the read-your-writes problem. Applications reading from replicas after a write must either route to primary, wait for LSN catch-up, or accept stale reads as part of their SLO.

Follow-ups:
- What is `hot_standby_feedback` and what does it trade off? (Standby tells primary its oldest snapshot, preventing VACUUM conflicts at the cost of primary bloat.)
- What is the bounded-staleness pattern in Go? (Read primary's LSN on write, wait until replica's `replay_lsn` >= that LSN before reading there.)
- How does Aurora PostgreSQL avoid WAL replay lag? (Storage-layer replication of log records, readers share the same distributed storage.)

---

**Q12: What is a replication slot and what is the danger of using one?**

A: A replication slot causes the primary to retain WAL files (and hold back the `xmin` horizon for logical slots) until the subscriber confirms consumption. This guarantees the subscriber does not miss data even if it disconnects. The danger: a dead or very lagging subscriber causes WAL to accumulate indefinitely, filling disk and eventually causing a primary outage. Logical slots additionally prevent VACUUM from cleaning dead tuples, causing catalog bloat.

What FAANG expects: mention `max_slot_wal_keep_size` (PostgreSQL 13+), which bounds retention at the cost of breaking the subscriber when exceeded, turning a silent outage into a loud and recoverable one.

Follow-ups:
- What monitoring alert would catch this before production impact? (Alert when slot lag bytes exceed some fraction of available disk.)
- Why is a physical slot safer than a logical slot? (Physical does not hold back xmin. Only WAL retention risk.)
- What happens if you drop an active slot? (Subscriber must re-snapshot or fail. Know the recovery path before dropping.)

---

**Q13: What is the LSM tree and how does it differ from a B-tree for write-heavy workloads?**

A: An LSM (Log-Structured Merge) tree buffers writes in an in-memory sorted structure (MemTable), then flushes them as immutable sorted files (SSTables). All disk writes are sequential appends, eliminating B-tree random page I/O and split cost. Reads must check the MemTable plus multiple SSTable levels, using bloom filters to skip SSTables that cannot contain the key. LSM gives 10-100x better write throughput at the cost of higher read amplification.

What FAANG expects: name the compaction strategies. Leveled (RocksDB default), size-tiered (Cassandra STCS), time-windowed (Cassandra TWCS for TTL), and Cassandra 5.0's UCS. Each trades write, read, and space amplification differently.

Follow-ups:
- What is write stalls and why does it happen? (L0 fills faster than compaction can drain. Writes throttled to let compaction catch up.)
- Why do tombstones hurt LSM read performance? (Must scan forward through SSTables until a tombstone older than GC grace is found. mass deletes create hot spots.)
- Name three databases that use LSM storage engines. (RocksDB, Cassandra, ScyllaDB, LevelDB, ClickHouse MergeTree, TiKV, CockroachDB via Pebble.)

---

**Q14: What is write amplification and how does it differ between B-trees and LSM trees?**

A: Write amplification is bytes written to storage per byte written by the application. B-tree: writing 8 bytes requires writing an 8KB page plus WAL, amplification roughly 1000x per insert if uncached. Leveled LSM: each key is rewritten as it migrates through levels. With 10x size ratio and 7 levels, worst case ~30x. Size-tiered LSM: lower write amp (~10x) but higher space amplification during compaction (old and new versions coexist).

What FAANG expects: connect write amp to SSD wear and tail latency. On NVMe, write amp determines device lifespan and when compaction spikes cause p99 read latency to blow out.

Follow-ups:
- How does MyRocks (MySQL on RocksDB) compare to InnoDB on write amp for a write-heavy OLTP workload? (MyRocks typically lower write amp and smaller on-disk footprint. Read latency higher for point lookups.)
- What is read amplification in an LSM and how do bloom filters reduce it? (Must check every level. bloom filters skip levels that definitely lack the key, cutting disk reads for missing keys to O(1).)
- What is space amplification and why does it matter? (Live plus dead bytes on disk. matters for storage cost and compaction I/O budget.)

---

**Q15: How does PostgreSQL's autovacuum work and why is it important?**

A: Autovacuum is a background process that runs VACUUM (reclaim dead tuples, update visibility map) and ANALYZE (refresh planner statistics) on tables based on dead-tuple and change thresholds. It triggers when `n_dead_tup > autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * n_live_tup` (defaults 50 + 20%). Without it: bloat grows unbounded, planner stats go stale leading to bad plans, and eventually transaction ID wraparound forces the database into single-user recovery.

What FAANG expects: per-table tuning. Default 20% scale factor is catastrophic for 100M-row tables (autovacuum triggers at 20M dead tuples, far too late). Senior answer: set `autovacuum_vacuum_scale_factor = 0.01` or lower on hot tables.

Follow-ups:
- What is autovacuum cost-based delay and when do you tune it? (Throttles I/O to avoid impacting foreground. On modern SSDs, the defaults are too conservative.)
- What is aggressive vacuum (anti-wraparound) and why is it unavoidable? (Triggered when XID age exceeds `autovacuum_freeze_max_age`. It cannot be skipped even under lock pressure.)
- Why can autovacuum never finish on a table under constant UPDATE pressure? (If the UPDATE rate exceeds vacuum I/O budget, bloat grows monotonically. Fix is `pg_repack` or more aggressive tuning.)

---

**Q16: What is an index-only scan and when does it work?**

A: An index-only scan answers a query using only the index, without fetching heap pages. Requires all SELECTed and WHEREd columns to be present in the index. PostgreSQL's MVCC complicates this: visibility normally requires checking the tuple's xmin/xmax in the heap. The **visibility map** tracks pages where all tuples are committed and visible to all transactions. For those pages, the index-only scan can skip the heap fetch.

What FAANG expects: mention `INCLUDE` columns (covering indexes, PostgreSQL 11+) as the way to support index-only scans without inflating the index key order.

Follow-ups:
- Why does "Heap Fetches: N" in EXPLAIN mean your index-only scan is degraded? (N pages were not marked all-visible. Run VACUUM.)
- What is the write cost of adding an INCLUDE column? (Index grows, more bytes written per insert, but no sort order impact.)
- How does InnoDB's clustered index change the index-only-scan calculus? (Secondary indexes already carry PK values. "covering" means column is either in the key or is the PK.)

---

**Q17: What is TOAST and when does PostgreSQL use it?**

A: TOAST (The Oversized-Attribute Storage Technique) handles column values larger than approximately 2KB. PostgreSQL tries inline compression (LZ4 since PG14, previously pglz) first. If the compressed value still exceeds the page limit, it is split into 2KB chunks stored in a hidden TOAST table, with an 18-byte pointer in the main heap. Transparent to SQL, but each out-of-line read is an extra random I/O.

What FAANG expects: know that TOAST makes `SELECT *` expensive on wide JSONB or TEXT columns, and that queries not referencing the TOASTed column avoid the cost entirely.

Follow-ups:
- Why is LZ4 the default over pglz in PG14+? (Faster compress and decompress with similar ratios, lower CPU overhead.)
- How does TOAST interact with MVCC for updates? (If the TOASTed column does not change, the TOAST pointer is preserved and the chunks are not rewritten.)
- When should you store large blobs outside the database? (Frequently accessed media, when you need CDN delivery. Rule of thumb: anything >1MB belongs in object storage, with a URL or key in the database.)

---

**Q18: What is the query planner's "cost" model?**

A: PostgreSQL's planner enumerates candidate plans and assigns each a cost in arbitrary units tied to `seq_page_cost = 1.0`. Other units: `random_page_cost = 4.0` (set to 1.1 for SSDs), `cpu_tuple_cost = 0.01`, `cpu_index_tuple_cost = 0.005`, `cpu_operator_cost = 0.0025`. Row count estimates come from `pg_statistic` (populated by ANALYZE). The lowest-cost plan wins. Incorrect estimates (stale stats, column correlation, skewed distributions) cause plan regressions, which are the single most common cause of "query suddenly got slow."

What FAANG expects: know the three join algorithms and when each wins. Nested loop (small outer, indexed inner), hash join (large equi-join, fits in `work_mem`), merge join (both inputs pre-sorted).

Follow-ups:
- What is extended statistics and when do you need them? (`CREATE STATISTICS` captures multi-column correlation. Fixes plans where WHERE filters on correlated columns are underestimated.)
- How does the planner estimate selectivity for `LIKE 'abc%'`? (Histogram-based prefix match. For `LIKE '%abc%'` it falls back to a constant, often wrong.)
- What is a "plan flip" and why is it scary? (Small change in statistics or data flips the planner from index scan to seq scan, p99 jumps from 2ms to 2 seconds.)

---

**Q19: What is PgBouncer transaction pooling and what are its limitations?**

A: PgBouncer holds a server connection only for the duration of a client transaction, returning it to the shared pool on COMMIT or ROLLBACK. Thousands of clients share a small server pool (e.g., 10k clients to 25 server connections). Limitations: session-level state becomes unsafe because the next transaction may land on a different backend. Forbidden or restricted: `SET` (session GUCs), named prepared statements (use protocol-level prepared via `describe_portal` or disable), advisory locks, `LISTEN`/`NOTIFY`, temporary tables, cursors outside transactions.

What FAANG expects: know the pool size formula. Backend connections should equal roughly `cores * 2 + spindles` (do not overprovision), because too many backends cause context-switch thrash and lock contention worse than queueing.

Follow-ups:
- How does pgx's server-side prepared statement cache interact with transaction pooling? (Bad: each new backend needs to re-prepare. Use `statement_cache_mode = describe` or disable.)
- What is session pooling vs statement pooling? (Session: one client = one backend for session lifetime. statement: returned on each statement, even more restrictive, disallows multi-statement txns.)
- When would you use pgcat instead of PgBouncer? (Native Rust rewrite with sharding, load balancing, and query routing. Improving but less battle-tested.)

---

**Q20: How would you diagnose and fix a sudden increase in query latency caused by table bloat?**

A: Investigate methodically. Step 1: identify the regression via `pg_stat_statements` (`mean_exec_time` jumped for a specific query). Step 2: `EXPLAIN (ANALYZE, BUFFERS)` and look at Rows Removed by Filter, Buffers: shared read, Heap Fetches. Step 3: `pg_stat_user_tables` for `n_dead_tup`, `n_dead_tup / n_live_tup`, `last_autovacuum`. Step 4: `pg_stat_activity` for `idle in transaction` holding the xmin horizon and `pg_replication_slots` for stuck slots. Step 5: `VACUUM ANALYZE table` immediately to confirm improvement. Step 6: per-table autovacuum tuning for durable fix. Step 7: `pg_repack` if index bloat persists.

What FAANG expects: diagnosis before action. Firing `VACUUM FULL` on production without understanding the cause is the junior failure mode.

Follow-ups:
- What monitoring would have caught this before pager? (`n_dead_tup_ratio` alert, replication slot lag alert, `idle in transaction` duration alert.)
- How does `pg_repack` work without an exclusive lock? (Trigger-captured changes replayed onto a shadow table, atomic swap at the end.)
- Why might `VACUUM ANALYZE` succeed but not reduce table size? (Reclaims space for reuse within heap pages. Does not return pages to OS. Use `VACUUM FULL` or `pg_repack` for that.)

---

**Q21: Explain Two-Phase Commit. What are its failure modes?**

A: 2PC is an atomic-commit protocol across multiple participants coordinated by one coordinator. Phase 1 (prepare): coordinator asks each participant to durably persist a "prepared" record and vote yes or no. Phase 2 (commit or abort): if all vote yes, coordinator issues commit. Otherwise abort. Failure modes: coordinator crash after phase 1 leaves participants in a prepared state holding locks indefinitely (the blocking problem). Participant crash during phase 2 recovers by reading its prepared record and asking the coordinator for the outcome. 2PC is a blocking protocol. There is no 2PC implementation that is non-blocking with a single coordinator.

What FAANG expects: explain why saga patterns replaced 2PC in microservices. Sagas trade atomicity for liveness, using compensating transactions, and are almost always the correct choice for distributed workflows.

Follow-ups:
- What is 3PC and does it actually help? (Adds "pre-commit" phase. Non-blocking under non-Byzantine failures but vulnerable to network partitions. Rarely used.)
- How does Spanner achieve distributed transactions without the classical 2PC blocking problem? (TrueTime + Paxos-replicated participants. Each participant is itself highly available.)
- What is idempotency's role in saga compensations? (Compensations may be retried. Must be idempotent to avoid double-refund type bugs.)

---

**Q22: What is Serializable Snapshot Isolation (SSI) in PostgreSQL?**

A: SSI (Cahill et al., 2008, shipped in PostgreSQL 9.1) implements SERIALIZABLE by layering rw-conflict tracking on top of Snapshot Isolation. Every read-write conflict (T1 reads X, T2 later writes X) is tracked. When a cycle of rw-conflicts forms that could produce a non-serializable schedule, PostgreSQL aborts one transaction with SQLSTATE 40001. Applications must catch this and retry. SSI gives true serializability without the lock contention of 2PL (Strict Two-Phase Locking).

What FAANG expects: differentiate SSI from SI. Oracle's SERIALIZABLE is SI and allows write skew. PostgreSQL SERIALIZABLE is SSI and does not. "SERIALIZABLE" is not a portable keyword across vendors.

Follow-ups:
- What is the overhead of SSI vs RC? (Per-transaction state tracking. predicate locking on read sets. Significant under high contention.)
- How does CockroachDB achieve serializability without SSI? (Deterministic timestamp ordering via clock synchronization and retries on timestamp cache conflicts.)
- Can SSI produce false-positive aborts? (Yes, the SIREAD locks are conservative. Some aborted transactions would have been serializable. Cost of the algorithm.)

### Junior to FAANG: the interview entry-point for internals

Juniors lose the database internals interview not because they cannot answer hard questions but because they answer easy ones imprecisely. "PostgreSQL uses a B-tree" is wrong. "PostgreSQL uses a B-plus tree with Lehman-Yao concurrent sibling pointers and high keys" is the signal. "MVCC means multi-version" is content-free. "MVCC means xmin and xmax on every heap tuple, visibility computed per-snapshot, dead tuples reclaimed by VACUUM, and the cost is table bloat" is the signal.

Prerequisite gap: juniors often have not internalized the physical layout. A worked prerequisite question: "Draw what happens when I `INSERT INTO users(id, name) VALUES (42, 'x')` on a table with a btree on id." Expected walk-through. (1) A new heap tuple is appended to a heap page (or a new page is allocated), with xmin set to the current transaction's XID. (2) The btree descends from the root to the leaf page that would contain 42, splitting a full page if needed. (3) A TID (block number, offset) for the new heap tuple is inserted into the leaf. (4) A WAL record is written for the heap insert and the btree insert. (5) On COMMIT, the clog bit for that XID is set to committed and the WAL up through the commit record is fsynced. A junior who cannot narrate this cannot reason about index-only scans, HOT updates, or MVCC bloat.

Entry-point ladder L3 to L4. L3: "What is an index?" Acceptable answer names B-tree, says it speeds up equality and range lookups, mentions trade-off with write cost. L4: same question, expected to distinguish btree from hash from GIN from BRIN, name partial and expression indexes, and know covering indexes with INCLUDE. First-year reflex to cultivate: when a question sounds simple, the interviewer is measuring precision, not breadth. Give the precise answer first, then offer follow-up depth.

"Why did this fail?" reflex applied to interview prep. Every answer above should be testable in a sandbox. A junior who has never run `EXPLAIN (ANALYZE, BUFFERS)` on a real 10M-row table cannot answer Q6 with any authority. Spin up a local Postgres, load 10M rows, and recreate every scenario in this section. Interviewers can hear the difference between memorized and lived.

### Senior at FAANG: interview ladder L5 to L7 for internals

At staff and principal level the interview is no longer "do you know B-trees". It is "can you design the database layer for a business and defend every decision under adversarial questioning". The ladder shape:

L5 staff. Expected to own a database tier end-to-end. Sample: "Your Postgres primary hits XID wraparound risk at 1.5 billion. Walk me through detection, mitigation, and prevention." Strong answer: monitor `pg_database.datfrozenxid` via `age(datfrozenxid)`, alert at 500M, page at 1B. Mitigation is targeted `VACUUM FREEZE` on the largest contributors identified by `SELECT relname, age(relfrozenxid) FROM pg_class ORDER BY age DESC`. Prevention is autovacuum tuning so `autovacuum_freeze_max_age` is never approached under steady state, plus killing long-running transactions and stuck replication slots that hold back the horizon.

L6 senior staff. Expected to define the platform. Sample: "Design a CDC pipeline to stream 10K Postgres tables to Snowflake with 2-minute freshness SLO." Strong answer: logical replication with `pgoutput` plugin, Debezium connectors sharded by table-hash across Kafka Connect workers, schema registry for DDL evolution, `pg_failover_slots` to preserve slots across HA failover, per-slot lag metrics in Prometheus, consumer lag alerts with escalation, Snowpipe Streaming or Snowflake Kafka connector on the sink, dead-letter queue for poison messages, table-level SLO dashboards with owner attribution, chaos tests that kill the primary and verify CDC resumes within budget.

L7 principal. Expected to make decisions that bind the company for years. Sample: "Should we move from managed Postgres to CockroachDB for the global workload?" Strong answer is not yes or no. It is a decision framework. "The question is not which is better. It is what RPO, RTO, and latency budget the business requires, what the operational cost delta is over 5 years, what the hiring market looks like for each, and what the migration risk profile is for 200 services with 4K tables." Then concrete numbers. Postgres multi-region with async DR gives 5ms local commits and 60s cross-region RPO for $X/year. Cockroach gives zero-data-loss global commits at 50-75ms per write for $Y/year plus a 12-month migration with measurable application impact. The principal answer produces a decision memo, not an opinion.

Bar-raiser questions that separate L6 from L7.

- "Diagnose a replica lag spike that appears for 15 minutes every Wednesday at 02:00 UTC and then recovers." Expected framework: correlate with cron, backups, batch jobs, vacuum cycles, `pg_basebackup`, WAL archive backlogs, network maintenance windows on the cloud provider, and AZ-level cross-traffic spikes. Principals name the "what is special about Wednesday" question first.
- "Your company has 40 Postgres instances across 12 teams, zero consistency in configuration, and incidents trace back to misconfiguration 60% of the time. Propose a 12-month platform plan." Expected: baseline audit, golden config via Terraform, centralized observability, auto-remediation for top 5 incident classes, maturity model adoption, graduated enforcement, explicit migration runbook, and an SLO-backed data-platform contract.
- "Explain how you would detect a pending XID wraparound in a fleet of 100 databases and what the automation boundary should be." Expected: Prometheus exporter for `age(datfrozenxid)`, tiered alerting, automated `VACUUM FREEZE` on non-critical environments, paging a human for Tier-1 because XID wraparound remediation under load can itself cause incidents, and an immutable audit trail for any automated action.

ADR governance for the interview floor. A staff-plus hire should be able to produce an ADR on the spot for: replication topology, backup strategy, connection pooling (PgBouncer vs pgcat vs application-level), index change review, schema migration tooling (Flyway vs sqlc vs golang-migrate vs Atlas), CDC plumbing, and observability stack. The ADR structure (Context, Decision, Consequences, Alternatives Considered, Revisit Triggers) should be muscle memory, not something to be looked up.

Maturity model for internals literacy in interview terms.

```
L3-L4: can explain mechanics of a single feature (B-tree, MVCC, WAL).
L5:    can diagnose a production incident end-to-end using internals knowledge.
L6:    can design a platform that prevents that class of incident and scales to
       the organization, with explicit SLOs and automation boundaries.
L7:    can decide between fundamentally different storage paradigms (Postgres
       vs Spanner vs DynamoDB vs LSM-based OLTP) with a defensible 5-year
       total-cost-of-ownership analysis.
```

Staff-level review lens on candidate answers. Strong senior candidates produce two things every junior misses: (1) explicit tradeoffs, never a feature pitch without its cost, and (2) the revisit trigger, "we would reconsider this if workload shape X changed or if engine Y hits GA for feature Z". If a candidate's answer has no tradeoff and no revisit trigger, they are pattern-matching, not engineering.

---
