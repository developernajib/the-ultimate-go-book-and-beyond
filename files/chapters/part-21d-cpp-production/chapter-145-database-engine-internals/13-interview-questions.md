## Interview Questions

### Q1: What are the trade-offs between a B+ tree and an LSM tree for a write-heavy workload?

**B+ tree**: Updates modify pages in place. A random-key workload causes random disk writes, each write may touch a different page, requiring a read-modify-write cycle. Write amplification is typically 2-4× (WAL write + data page write). Random write throughput on a spinning disk is terrible. On SSDs it is better but still causes wear. Point reads are fast (O(log_B N)), range scans are fast (leaf chain walk).

**LSM tree**: All writes are sequential appends to the WAL and memtable. Flush and compaction are also sequential writes. This is extremely fast on both spinning disks and SSDs. Write amplification is higher in total (10-30×) due to compaction, but the I/O pattern is sequential rather than random. The cost is read amplification: a point read may need to check multiple levels and SST files. Bloom filters reduce this cost but do not eliminate it.

**When to choose B+ tree**: OLTP workloads with frequent reads, point lookups, and moderate writes. PostgreSQL, MySQL for transactional workloads.

**When to choose LSM tree**: Write-heavy workloads, time-series data, event logging, mobile storage (flash-friendly sequential writes). RocksDB, Cassandra, HBase for write-intensive workloads.

---

### Q2: Explain WAL and the ARIES recovery algorithm. What are the three passes?

A WAL (Write-Ahead Log) guarantees durability by requiring that every log record describing a data modification be flushed to disk before the corresponding data page is modified. If the system crashes, the WAL provides enough information to reconstruct the committed state.

**ARIES** (Algorithm for Recovery and Isolation Exploiting Semantics) performs recovery in three passes:

**Analysis pass**: Scans the WAL forward from the last checkpoint. Reconstructs two tables: the "dirty page table" (which pages were modified after the last checkpoint and may not be on disk) and the "active transaction table" (which transactions were in progress at crash time).

**Redo pass**: Starts from the oldest LSN in the dirty page table and replays every logged operation. Even operations that may already be on disk are replayed, this is safe because each operation checks the page's current LSN and skips if the page is already up to date. After this pass, the database is in exactly the state it was at the moment of crash.

**Undo pass**: Walks the WAL backwards. For every transaction in the active transaction table (meaning it never committed), applies the inverse operation. Each undo step writes a Compensation Log Record (CLR) so that if the system crashes again during undo, the already-undone steps are not repeated.

The key insight: RIES never modifies the WAL during recovery, it only appends CLRs, making recovery idempotent.

---

### Q3: How does MVCC implement isolation levels? What is the difference between Read Committed and Repeatable Read?

MVCC keeps multiple versions of each row. Each version has a timestamp (or transaction ID) marking when it was created and when it was deleted.

**Read Committed**: The visibility snapshot is taken at the start of each SQL statement within the transaction. Two reads of the same row within one transaction may see different versions if a concurrent transaction committed between the two reads. This is called a "non-repeatable read."

**Repeatable Read**: The visibility snapshot is taken once at the start of the transaction and held for the entire transaction. Concurrent commits are not visible. The same row always returns the same version within one transaction. Phantom reads are still possible under strict MVCC (a range query may see new rows inserted by concurrent transactions at some isolation levels) but PostgreSQL prevents phantoms even at Repeatable Read using snapshot isolation.

**Serializable**: Adds conflict detection (via SSI or 2PL) to catch dangerous read/write cycles between concurrent transactions. Transactions that would produce a non-serializable execution are aborted.

---

### Q4: Why does a buffer pool use LRU-K instead of plain LRU?

Plain LRU evicts the page that was least recently accessed. This works well for workloads with temporal locality, recently accessed pages are likely to be accessed again.

It fails for sequential scans. A full table scan accesses every page in the database exactly once, in order. With plain LRU, this scan evicts the entire working set of every other concurrent query, pages that were being accessed frequently, replacing them with pages that will never be accessed again (after the scan passes them).

LRU-K evicts the page whose K-th most recent access is oldest. A page accessed only once during a sequential scan has `K-th access = infinity distance` and is evicted before pages that have been accessed K or more times. This protects the hot working set from sequential scan pollution.

InnoDB uses a similar mechanism with a "young" (frequently accessed, LRU head) and "old" (recently added, LRU tail) sub-list. A page that is accessed within a short window of being loaded stays in "old". Only pages accessed after a cooldown period are promoted to "young".

---

### Q5: What is the difference between the Volcano model and vectorized execution? When does vectorized win?

**Volcano (iterator) model**: Each operator implements `Next()` which returns one tuple. The query tree is pulled tuple-by-tuple from the root. Advantages: simple, composable, low memory footprint. Disadvantage: every tuple requires a virtual function dispatch through each operator in the chain. For a 10-operator plan processing 100M rows, that is 1 billion virtual calls. The per-call overhead (branch misprediction, cache miss for vtable lookup) dominates actual computation for simple operations.

**Vectorized execution**: `Next()` returns a batch of 1024 tuples. Operators process arrays with tight inner loops, which the compiler auto-vectorizes to SIMD instructions. One virtual dispatch per 1024 tuples instead of 1. The inner loop fits in the instruction cache. Memory access is sequential (columnar).

**When vectorized wins**: Analytical queries (OLAP) scanning millions of rows with simple per-row operations, aggregations, column arithmetic, filter. DuckDB reports 10-100× speedups over Volcano for TPC-H queries.

**When Volcano is fine**: OLTP queries returning 1-100 rows. The overhead of 10 virtual calls is negligible when you return 3 rows. PostgreSQL uses Volcano and is excellent for OLTP.

---

### Q6: When would you choose a hash index over a B+ tree index?

Choose a hash index for **equality lookups on high-cardinality columns** where range scans are never needed:

- `WHERE user_id = $1` (point lookup on UUID or integer primary key)
- `WHERE session_token = $1` (equality check on random-looking string)

A hash index provides O(1) average lookup vs. O(log N) for B+ tree, and O(1) insert vs. O(log N). For very high-cardinality columns with 100% equality queries, hash indexes are measurably faster.

Choose a B+ tree when:
- Range queries exist (`WHERE price BETWEEN 10 AND 50`)
- Sorted output is needed (`ORDER BY` without a sort step)
- Prefix scans are needed (`WHERE name LIKE 'Smit%'`)
- The column is used in `JOIN` conditions that benefit from merge join

In PostgreSQL, hash indexes were historically not WAL-logged (unsafe for crash recovery before PostgreSQL 10) and saw limited adoption. They are now fully WAL-logged and safe. In practice, B+ tree is almost always the default because the 2-3× read latency difference rarely matters and the loss of range scan capability often hurts.

---

### Q7: Define write amplification. What are three ways to reduce it in an LSM tree?

**Write amplification (WA)** is the ratio of bytes written to disk to bytes written by the application. If you write 1 GB of data and the storage engine writes 30 GB to disk (due to compaction), WA = 30.

WA causes SSD wear (each NAND cell has a finite write cycle count) and consumes disk I/O bandwidth that could otherwise serve reads.

**Three ways to reduce write amplification**:

1. **Tiered compaction instead of leveled**: Tiered compaction (also called STCS in Cassandra) merges whole tiers at once rather than one SST at a time. Write amplification drops from ~30× to ~5×, at the cost of higher space amplification and potentially slower reads.

2. **Increase level size multiplier**: In leveled compaction, each level is `level_multiplier` times the size of the previous (default = 10). Increasing to 20 means each key is compacted fewer times to reach the final level. WA decreases. Space amplification and read amplification increase slightly.

3. **Key-value separation (WiscKey design)**: Store large values in a separate append-only value log. The LSM tree only indexes `key → (value_log_offset, size)`. Compaction only rewrites keys (which are small), not values. For large values (>256 bytes), WA drops dramatically. Badger uses this approach.

---

### Q8: Explain how PostgreSQL implements MVCC with heap tuples. What is table bloat?

PostgreSQL stores all versions of a row in the heap (the main table file). Each tuple has two fields:

- `xmin`: the transaction ID that inserted this version
- `xmax`: the transaction ID that deleted (or updated) this version, 0 means the tuple is live

When a row is updated, PostgreSQL does not modify the existing tuple. Instead, it writes a new tuple version to the heap page and sets `xmax` on the old tuple to the current transaction ID. Both versions coexist on disk.

When a row is deleted, only `xmax` is set. The actual bytes remain on disk.

**VACUUM** is the process that reclaims dead tuple space. It scans heap pages and removes tuples where `xmax` was committed by a transaction older than any currently active transaction's snapshot. It then marks those bytes as reusable free space in the page's free space map.

**Table bloat** occurs when VACUUM cannot reclaim dead tuples fast enough, either because autovacuum is misconfigured, a long-running transaction holds back the oldest snapshot (preventing VACUUM from declaring old tuples dead), or the insert/update/delete rate simply outpaces autovacuum. The table file grows continuously. Queries that scan the table must read all the dead tuple pages, slowing down sequential scans. The fix is `VACUUM (FULL)` (rewrites the table compactly) or resolving the long-running transaction.

---

### Q9: What is the purpose of a Compensation Log Record (CLR) in ARIES, and why does it make recovery idempotent?

When ARIES performs the UNDO pass during recovery, it reverses uncommitted transactions by applying their inverse operations. After each inverse operation, it writes a **Compensation Log Record (CLR)** to the WAL. A CLR records:
- Which operation was undone
- The LSN of the next log record to undo for this transaction (the `undo_next_lsn` pointer, which skips over CLRs that were already written)

If the system crashes again during the UNDO pass, ARIES must recover again. On the second recovery run:

- The Analysis pass finds the same uncommitted transactions.
- The Redo pass replays everything, including the CLRs written during the aborted first undo pass, this re-applies the already-undone operations to the correct state.
- The Undo pass uses `undo_next_lsn` to skip over operations already covered by CLRs, avoiding double-undoing.

The result is idempotent recovery: no matter how many times the system crashes during recovery, the final state is always the same correct committed-transaction state. This property is critical because the recovery process itself must be crash-safe.

---
