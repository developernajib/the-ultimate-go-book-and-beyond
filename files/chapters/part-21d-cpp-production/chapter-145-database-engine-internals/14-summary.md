## Key Takeaways

- **B+ trees minimize disk I/O by design.** The branching factor `ORDER` is chosen so one node equals one disk page. A B+ tree of order 578 over one billion rows has height 2, nearly every lookup is one disk read. Leaves form a doubly-linked chain for free range scans. PostgreSQL, MySQL, SQLite, and every SQL database use B+ trees as the default index.

- **LSM trees turn random writes into sequential writes.** The memtable absorbs writes in memory, the WAL guarantees durability, and background flush+compaction reorganizes data on disk. The cost is read amplification (multiple SST files may need to be checked) and write amplification (data is rewritten multiple times during compaction). Bloom filters cut read amplification dramatically by skipping SST files that cannot contain a key.

- **The WAL golden rule is non-negotiable.** A WAL record must reach disk before the corresponding data page is modified. The ARIES algorithm (Analysis → Redo → Undo) provides crash recovery that is correct even if the system crashes during recovery itself. Compensation Log Records (CLRs) make the undo pass idempotent.

- **The buffer pool is the most important tunable in a DBMS.** A fixed-size pool of page frames caches disk pages in RAM. LRU-K with K=2 prevents sequential table scans from evicting the hot working set. The pin/unpin protocol ensures pages being accessed are never evicted. Setting `shared_buffers` or `innodb_buffer_pool_size` correctly is the highest-use configuration change for database performance.

- **Volcano is simple. Vectorized is fast for analytics.** The iterator model (one tuple per `Next()` call) is elegant and composable but pays a virtual dispatch per tuple. Vectorized execution (1024 tuples per call, SIMD loops) achieves 10× better throughput for analytical workloads. JIT-compiled execution (HyPer, Umbra) eliminates all interpretation overhead for another 10× gain.

- **MVCC lets readers and writers coexist without blocking.** Every write creates a new row version. Readers see a consistent snapshot from their transaction start. Visibility is determined by comparing the tuple's `xmin`/`xmax` (or equivalent timestamp) against the reader's snapshot. The cost is dead tuple accumulation, which VACUUM (PostgreSQL) or the purge thread (InnoDB) reclaims. Long-running transactions cause table bloat by holding back the VACUUM horizon.

- **Choose index structures by query pattern, not habit.** Hash indexes win for pure equality lookups (O(1) vs. O(log N)). B+ trees win when range scans or sorted output are needed. Skip lists excel as ordered in-memory structures (LevelDB memtable). ART (Adaptive Radix Tree) is optimal for string keys with prefix queries. R-trees handle 2D/3D spatial queries.

- **The production stack is C++ at the storage layer, Go/Rust at coordination.** Memory determinism (no GC pauses during compaction), `O_DIRECT` I/O control, and SIMD-friendly tight loops make C++ the engineering choice for storage kernels. Go's goroutines and clean concurrency model make it better for distributed coordination, SQL layers, and metadata management. CockroachDB, TiDB, and YugabyteDB all follow this pattern.

- **A working KV store is ~200 lines of C++.** WAL + skip list memtable + SST flush + bloom filter is the complete core. Everything RocksDB adds on top, multi-level compaction, block compression, column families, block cache, write stall control, is optimization and production hardening, not architectural novelty.

- **CMU 15-445 and "Database Internals" (Petrov) are the canonical next steps.** The course assignments implement buffer pool, B+ tree, query executor, and lock manager in C++. The book walks through the storage layer of every major open-source database. After this chapter, both resources are immediately accessible.

---

| [◀ Chapter 144: FAANG C++ Libraries](../chapter-144-faang-cpp-libraries/00-introduction.md) | [Chapter 145: Database Engine Internals](00-introduction.md) | [Chapter 146: Compiler and Interpreter Design](../chapter-146-compiler-interpreter-design/00-introduction.md) ▶ |
