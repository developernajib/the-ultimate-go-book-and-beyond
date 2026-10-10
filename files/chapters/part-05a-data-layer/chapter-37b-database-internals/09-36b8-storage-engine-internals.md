## 37B.8 Storage Engine Internals

### Heap Files: How PostgreSQL Stores Tables on Disk

Each PostgreSQL table is stored as a **heap file** - a collection of 8KB pages. The file is named by the table's OID (object identifier):

```bash
# Find the file for a table
SELECT pg_relation_filepath('orders');
-- Returns: base/16384/24601

# File on disk: $PGDATA/base/16384/24601
# For tables > 1GB: multiple segment files (24601, 24601.1, 24601.2, ...)
```

### Page Layout: 8KB Pages, Tuple Headers, Alignment

Every heap page follows a fixed layout. The page header tracks the WAL LSN of the last modification, pointers to the free space boundaries, and a checksum. Item pointers grow downward from the header, while tuple data grows upward from the bottom of the page. The gap between them is free space available for new tuples.

```
PostgreSQL 8KB Page Layout:

+---------------------------+  byte 0
| PageHeaderData (24 bytes) |
|  pd_lsn (8):  WAL LSN of  |
|    last change to page    |
|  pd_checksum (2)          |
|  pd_flags (2)             |
|  pd_lower (2): end of     |
|    item pointer array     |
|  pd_upper (2): start of   |
|    free space             |
|  pd_special (2): start of |
|    special space (index)  |
+---------------------------+
| Item Pointers (4B each)   |  (grow downward from pd_lower)
|  [ip_blkid, ip_posid,     |
|   ip_flags, ip_len]       |
|  ...                      |
+---------------------------+
| Free Space                |
+---------------------------+
| Tuple N (grows upward)    |  (from pd_special toward pd_upper)
| ...                       |
| Tuple 2                   |
| Tuple 1                   |
+---------------------------+  byte 8191
```

**Item pointers** (also called line pointers) form an array from the top of the page growing down. Each is 4 bytes pointing to a tuple location within the page. This indirection allows tuples to move within a page (for HOT updates) without updating indexes.

### HOT Updates (Heap-Only Tuple)

A **HOT update** avoids updating the index when only non-indexed columns change:

```
Regular UPDATE (non-HOT): must update heap AND index
  Index: [user_id=42] -> ctid (0,1)
  Heap page 0, slot 1: old tuple (xmax=200)
  Heap page 0, slot 2: new tuple (xmin=200)
  Index entry updated to point to (0,2)  <-- index write

HOT UPDATE: index still points to old tuple, chain followed in heap
  Index: [user_id=42] -> ctid (0,1)  <-- UNCHANGED
  Heap page 0, slot 1: old tuple (xmax=200, t_ctid=(0,2))
                                      ^-- points to new version
  Heap page 0, slot 2: new tuple (xmin=200)
  (index NOT updated)
```

HOT updates require that the new tuple fits on the same page as the old tuple. PostgreSQL achieves this by leaving `fillfactor` space in each page (default `fillfactor=100` for heap, set to 70-80 for frequently-updated tables).

```sql
-- Set fillfactor for a frequently-updated table to enable HOT updates
ALTER TABLE orders SET (fillfactor = 80);
VACUUM FULL orders; -- rebuild with new fillfactor
```

### TOAST: Storing Large Values

TOAST (The Oversized-Attribute Storage Technique) handles column values larger than ~2KB:

```
TOAST strategies:

PLAIN:     Never compress, never out-of-line (for short fixed-width types)
EXTENDED:  Compress first, then store out-of-line if still too large (default for TEXT)
EXTERNAL:  Store out-of-line uncompressed (fast access to substrings)
MAIN:      Compress first, keep in-line if possible

TOAST table layout:
  Main table: stores a TOAST pointer (18 bytes) instead of the large value
  TOAST table (pg_toast_<oid>): stores chunks of 2KB each

  TOAST pointer:
  +---------------------+
  | vartag (1 byte)     |  -- indicates it's a TOAST pointer
  | va_toastrelid (4)   |  -- OID of the TOAST table
  | va_valueid (4)      |  -- OID of the value in TOAST table
  | va_rawsize (4)      |  -- original size before compression
  | va_extinfo (4)      |  -- compressed size and flags
  +---------------------+
```

```sql
-- Check TOAST table for a relation
SELECT
    c.relname AS main_table,
    t.relname AS toast_table,
    pg_size_pretty(pg_relation_size(t.oid)) AS toast_size
FROM pg_class c
JOIN pg_class t ON t.oid = c.reltoastrelid
WHERE c.relname = 'documents';

-- Check TOAST strategy per column
SELECT attname, attstorage
FROM pg_attribute
WHERE attrelid = 'documents'::regclass
  AND attnum > 0;
-- attstorage: p=plain, e=extended, x=external, m=main
```

### Table Partitioning Internals

PostgreSQL declarative partitioning (PG10+) creates a **partition hierarchy**:

```sql
-- Range partitioning by month
CREATE TABLE events (
    id         BIGSERIAL,
    user_id    BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_01 PARTITION OF events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE events_2026_02 PARTITION OF events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- Create indexes on partitions (PG11+: global partitioned indexes)
CREATE INDEX ON events (occurred_at);  -- creates index on all partitions
```

**Partition pruning**: When a query includes a condition on the partition key, the planner eliminates partitions that cannot contain matching rows:

```sql
-- Only scans events_2026_02, not all partitions
SELECT * FROM events WHERE occurred_at >= '2026-02-01' AND occurred_at < '2026-03-01';

-- Verify pruning in EXPLAIN
EXPLAIN SELECT * FROM events WHERE occurred_at = '2026-02-15';
-- Append
--   -> Index Scan on events_2026_02  <-- only one partition scanned
```

### Junior to FAANG: Storage Concepts Before You Touch Tuning Knobs

The prerequisite idea is that a table is a file, that file is a sequence of 8KB pages, and each page holds a variable number of tuples. Every read of a row reads the entire page. Every write of a row rewrites the entire page (into the buffer cache, then eventually to disk). Once you hold that picture, every performance behavior becomes predictable: narrow rows pack more per page and scan faster, wide rows waste bandwidth, and an UPDATE to a 100-byte row is never cheaper than rewriting the 8KB page that contains it.

Worked example. A new starter reports that a table with 200M rows has "strangely slow" sequential scans. The row definition has a TEXT column storing JSON blobs averaging 40KB. You compute: 200M tuples, but the heap itself only holds TOAST pointers (18 bytes each) plus a few fixed columns, so the main heap is small. The slow scan is in pg_toast_<oid>. The lesson is that toasted data lives in a separate file and a query that touches the large column pulls it back in. The cure is not an index, it is either avoiding the column in the SELECT list or moving the blob out of Postgres into object storage.

Interview entry-points:
- What is a tuple and how is it different from a row? A tuple is a physical version of a row in the heap. One row can have many tuple versions under MVCC.
- Why is UPDATE not an in-place operation? Because Postgres must keep the old version visible to concurrent snapshots, so it writes a new tuple and stamps xmax on the old one.
- What happens if a tuple is larger than 8KB? TOAST compresses it, then chunks it into 2KB pieces stored in a side table addressed by a TOAST pointer in the main heap.

### Senior at FAANG: Buffer Manager, Background Processes, and Engine Comparisons

shared_buffers vs the OS page cache. Postgres maintains a buffer pool of 8KB frames sized by shared_buffers, and the Linux kernel also caches file-backed pages in the OS page cache. A read goes: shared_buffers hit, otherwise OS cache hit (still fast, no disk I/O), otherwise disk. A write goes: dirty shared_buffers page, WAL record, then eventually the background writer or checkpointer copies the dirty page to the OS (which eventually fsyncs to disk). The practical implication is that 25 percent of RAM for shared_buffers is the conventional starting point, because the OS page cache supplements it. Pushing shared_buffers to 80 percent of RAM often hurts because (a) double buffering wastes memory, (b) the clock-sweep algorithm scales poorly on huge pools, and (c) checkpoints become longer and spikier.

Buffer replacement is a clock-sweep (an approximation of LRU that tracks usage counts). Each access increments the buffer's usage count up to 5. The clock hand sweeps buffers and decrements counts, evicting a buffer when it hits zero. Ring buffers (strategy allocation) prevent large sequential scans and VACUUM from polluting the cache by confining them to a small set of frames, typically 256KB for sequential scans and VACUUM, and 16MB for bulk writes like COPY. This is why a nightly VACUUM does not destroy your OLTP cache hit ratio.

Background processes, each a distinct process:
- bgwriter: continuously writes dirty pages ahead of the clock sweep, sized by bgwriter_lru_maxpages and bgwriter_delay. Its job is to keep usage-count-zero buffers clean so a foreground query that needs a free buffer does not synchronously write one.
- checkpointer: performs checkpoints on schedule or when WAL threshold is hit, spread across checkpoint_completion_target (default 0.9) of the checkpoint_timeout window to smooth I/O. Checkpoints fsync every dirty page touched since the previous checkpoint, which is the dominant source of periodic I/O spikes.
- walwriter: flushes WAL buffers to the WAL segment files on a schedule (wal_writer_delay, default 200ms).
- autovacuum launcher: spawns autovacuum worker processes on a schedule.
- archiver: when archive_mode is on, copies full WAL segments out via archive_command or archive_library.
- startup process: on crash recovery, replays WAL from the last checkpoint forward.
- walreceiver and walsender: streaming replication endpoints.

Checkpoint tuning at scale. max_wal_size governs how much WAL accumulates between checkpoints. If it is too small, checkpoints fire constantly and each one fsyncs a small amount. If it is too large, checkpoints fsync a huge set of dirty pages and cause I/O stalls. The sweet spot for busy OLTP is usually max_wal_size = 16GB to 64GB with checkpoint_timeout = 15min to 30min, then measure checkpoint writes via pg_stat_bgwriter.checkpoints_timed vs checkpoints_req. A high checkpoints_req count signals WAL-driven checkpoints, which means raise max_wal_size.

WAL internals. WAL records carry an LSN (Log Sequence Number, a 64-bit byte offset into the WAL stream). Each page in shared_buffers records the LSN of the most recent WAL record that modified it. Postgres enforces "flush WAL before writing the data page" (WAL-before-data invariant). Full-page writes: after every checkpoint, the first modification to a page writes a full copy of the page into WAL to protect against torn writes where the OS writes half of an 8KB page during a crash. This is why WAL volume is spiky right after a checkpoint. wal_compression (pglz or zstd in PG15+) reduces this cost significantly for workloads with repetitive data.

InnoDB buffer pool comparison. MySQL InnoDB uses a single large buffer pool (innodb_buffer_pool_size, often 70 to 80 percent of RAM) and relies much less on the OS page cache because InnoDB opens files with O_DIRECT. The pool uses a modified LRU (young and old sublists) with the "midpoint insertion" trick: new pages enter at the midpoint, and only get promoted to the young list if accessed again after innodb_old_blocks_time milliseconds. This prevents a one-off scan from polluting the hot set. The adaptive hash index builds an in-memory hash over hot B-tree pages, effectively turning some index lookups into O(1) operations. It is enabled by default but causes latch contention on write-heavy workloads, so disable with innodb_adaptive_hash_index=OFF when you see "btr_search_latch" contention in performance_schema.

InnoDB doublewrite buffer solves the torn-page problem differently than Postgres full-page writes. It writes every dirty page first to a shared doublewrite area, then fsyncs, then writes to the actual tablespace. On crash recovery InnoDB consults the doublewrite area to detect and repair torn pages. Effect: two sequential writes per dirty page vs Postgres's one-time full-page write per checkpoint cycle. Which is better depends on workload write patterns.

TOAST in depth. Compression is pglz by default, lz4 (Postgres 14+) when column ALTER SET COMPRESSION lz4. lz4 decompresses roughly 5x faster than pglz with similar compression ratio, worth setting on every new bulk-text column. default_toast_compression sets the cluster default. For columns where values exceed ~8KB (even after compression), rows are chunked into 2KB pieces stored in the TOAST table keyed by (value_oid, chunk_seq). A SELECT of the column joins against the TOAST table in physical chunk order, so retrieval is sequential I/O. The pathological case is a WHERE predicate on a TOASTed column: Postgres must de-TOAST every candidate row before evaluating. Push predicates down to non-TOAST columns, or index an expression over a prefix of the column.

HOT chain pruning. When a page is read and has dead tuples, Postgres may opportunistically prune the chain, reclaiming space without full VACUUM. This is why selecting from a high-update table sometimes does non-trivial write I/O. pg_stat_user_tables.n_tup_hot_upd divided by n_tup_upd gives the HOT ratio, and below 80 percent indicates fillfactor is too tight or an index exists on a frequently-updated column.

Partitioning pitfalls. Partition-wise joins (enable_partitionwise_join) and partition-wise aggregates (enable_partitionwise_aggregate) are off by default because they consume work_mem per partition. A 100-partition table with a 64MB work_mem setting can suddenly allocate 6.4GB for a single query. Turn these on selectively via per-session or per-role SET. Also, indexes on a partitioned parent are logically one index but physically one per partition, and the planner prunes at plan time when possible, at execution time when parameterized. Runtime pruning only works for parameterized queries in Postgres 11+, with nuances around generic plans.

Filesystem choice. XFS and ext4 are both used at scale. ZFS adds checksums, compression, and snapshot capabilities at the cost of some write amplification, so turn off double-compression when using ZFS lz4 under Postgres lz4. Never run Postgres on NFS without understanding fsync semantics (older NFS implementations silently buffer fsync). For cloud storage, EBS gp3 with provisioned IOPS is the default baseline, with io2 reserved for latency-critical writes.

---
