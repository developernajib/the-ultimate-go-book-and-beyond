## 37B.3 LSM Tree (Log-Structured Merge Tree)

### The Problem B-Trees Have with Write-Heavy Workloads

B-trees optimize for **read performance**. Every insert must:
1. Find the correct leaf page (random read if not cached)
2. Write the new entry to that page (random write)
3. Potentially split and update parent pages (more random writes)
4. Write to WAL (sequential write, but additional overhead)

Random writes to spinning disks are 100x slower than sequential writes. Even on SSDs, random write amplification (writing a full 8KB page to change 8 bytes) wastes bandwidth and wears flash cells faster.

**Write amplification** = bytes written to storage / bytes written by application.
For a B-tree insert of 8 bytes: may write 8KB (one page). Write amplification = **1000x**.

### LSM Tree: Write to MemTable, Flush to SSTables

The **Log-Structured Merge Tree** (O'Neil et al., 1996) inverts the B-tree trade-off: it optimizes for **write throughput** at the cost of read overhead.

```
LSM Tree Architecture:

Write path (sequential, fast):
Application ──► WAL (append-only log) ──► MemTable (in-memory sorted tree)
                                               │
                                    (when MemTable full, ~64MB)
                                               │
                                               ▼
                              SSTable Level 0 (immutable sorted files)
                                               │
                                    (background compaction)
                                               │
                              SSTable Level 1 (larger, sorted, non-overlapping)
                                               │
                              SSTable Level 2 (10x larger)
                                               │
                              SSTable Level 3 ...

Read path (potentially slow - must check multiple levels):
Query ──► MemTable ──► Level 0 SSTables ──► Level 1 ──► Level 2 ──► ...
```

**SSTable** (Sorted String Table): An immutable file of key-value pairs sorted by key, with a sparse index for binary search.

```
SSTable file layout:

┌──────────────────────────────────────────┐
│ Data blocks (sorted key-value pairs)     │
│   [key1:val1][key2:val2]...[keyN:valN]   │
├──────────────────────────────────────────┤
│ Index block (sparse: one entry per block)│
│   [key1:offset0][key100:offset1]...      │
├──────────────────────────────────────────┤
│ Bloom filter (probabilistic membership)  │
├──────────────────────────────────────────┤
│ Footer (offsets to index and bloom)      │
└──────────────────────────────────────────┘
```

### Compaction Strategies

Without compaction, the number of SSTables grows unboundedly, making reads increasingly expensive.

**Size-Tiered Compaction (Cassandra default):**
```
When N SSTables of similar size exist, merge them into one larger SSTable.

L0: [S1][S2][S3][S4]   (4 SSTables of ~10MB each)
         ↓ compact
L0: [S_merged]          (1 SSTable of ~40MB)

Pros:  Low write amplification (good for write-heavy)
Cons:  High space amplification (old and new versions coexist during compaction)
       Higher read amplification (more files to check)
```

**Leveled Compaction (RocksDB default, LevelDB):**
```
Each level has a size budget. Level N is 10x larger than Level N-1.
SSTables within a level are non-overlapping (sorted, partitioned by key range).
A file is compacted into the next level when the level exceeds its budget.

L0: [A-Z][A-M][N-Z]     (overlapping, just flushed from MemTable)
L1: [A-C][D-F][G-J]...  (non-overlapping, 10x budget of L0)
L2: [A-A][B-B][C-C]...  (non-overlapping, 10x budget of L1)

Pros:  Lower read amplification (binary search within level for non-overlapping)
       Lower space amplification
Cons:  Higher write amplification (a key may be rewritten many times across levels)
```

### Read Amplification vs Write Amplification vs Space Amplification

This is the **fundamental RUM conjecture** (Read, Update, Memory): you can optimize for at most two of the three.

| | B-tree | LSM (leveled) | LSM (size-tiered) |
|---|---|---|---|
| Read amplification | Low (1 to 4 page reads) | Medium (check each level) | High (check all files) |
| Write amplification | High (~10x) | High (~30x in worst case) | Low (~10x) |
| Space amplification | Low | Low | High (during compaction) |

**Write amplification formula for leveled LSM**:
Each key written to L0 gets rewritten when compacted to L1, then L1→L2, etc.
With 10x size ratio and 7 levels: worst case 10 + 10 + ... = **~30x write amplification**.

### Bloom Filters in LSM Trees

The biggest read problem with LSM trees: a key might not exist, but you must check every level to confirm it. A bloom filter solves this:

```
Bloom Filter: probabilistic data structure
- Space efficient: ~10 bits per key for 1% false positive rate
- Query: "Is key K in this SSTable?"
  → NO  → definitely not present, skip this SSTable
  → YES → probably present (1% chance of false positive), read SSTable

Without bloom filter: O(levels) disk reads for missing key
With bloom filter:    O(1) disk reads for missing key (bloom fits in memory)
```

RocksDB, Cassandra, and LevelDB all maintain per-SSTable bloom filters in memory.

> **Senior track**: Cassandra 5.0 introduced **Unified Compaction Strategy (UCS)**, which uses data density rather than size (STCS) or fixed levels (LCS) to group SSTables. For time-series with TTLs, **Time Window Compaction Strategy (TWCS)** remains the right answer: it groups SSTables by time window so that when the window expires, whole SSTables drop at once without compaction cost. RocksDB tunes the tradeoff differently: its default is leveled compaction for the bottom levels and universal (size-tiered) for L0, trading bounded read amplification for higher write amp. Know which strategy your store uses. tuning `min_threshold`, `max_threshold`, and target SSTable size changes write throughput by an order of magnitude.

### Which Databases Use LSM

| Database | Storage Engine | Notes |
|---|---|---|
| RocksDB | LSM (leveled) | Used by MyRocks (MySQL), TiKV (TiDB) - CockroachDB uses Pebble (RocksDB-inspired) |
| Apache Cassandra | LSM (size-tiered or leveled) | Wide-column, distributed |
| LevelDB | LSM (leveled) | Google, embedded |
| ClickHouse | MergeTree (LSM variant) | Columnar, analytics |
| Apache HBase | LSM (via HDFS) | On top of Hadoop |
| ScyllaDB | LSM (size-tiered) | C++ rewrite of Cassandra |
| FoundationDB | B-tree | Ordered key-value, ACID |
| PostgreSQL | B-tree (heap + WAL) | Not LSM |

### When to Choose LSM-Based DB vs B-Tree Based DB

| Choose LSM when | Choose B-tree when |
|---|---|
| Write throughput >> read throughput | Read throughput >> write throughput |
| Append-heavy workloads (time-series, logs) | Random reads dominate |
| Sequential key generation (time-based) | Complex queries with joins |
| Acceptable eventual consistency | Strong consistency required |
| High volume, commodity hardware | Transactional workloads |

### Practical Implications for Go Application Design

Whether your backing store uses B-trees or LSM trees, write batching reduces overhead. For B-tree databases like PostgreSQL, batching means fewer page splits and less WAL traffic. For LSM-based stores like RocksDB or Cassandra, batching fills the MemTable more efficiently and produces larger, better-compacted SSTables. The `BatchInserter` below collects rows in memory and flushes them using PostgreSQL's `COPY` protocol, which is significantly faster than individual `INSERT` statements.

```go
// For LSM-based stores (e.g., Cassandra, RocksDB):
// 1. Batch writes - LSM is optimized for bulk sequential writes
// 2. Avoid frequent updates to the same key (write amplification)
// 3. Use time-series or monotonically increasing keys for locality
// 4. Design read patterns to hit MemTable (recent writes) when possible

// For PostgreSQL (B-tree):
// 1. Use BIGSERIAL or ULIDs instead of random UUIDs for primary keys
// 2. Batch inserts reduce B-tree split overhead
// 3. Use COPY for bulk loads (bypasses index maintenance during load)

package lsmaware

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// BatchInserter demonstrates write batching - beneficial for both
// B-tree (fewer splits) and LSM (larger MemTable flush batches).
type BatchInserter struct {
    pool      *pgxpool.Pool
    buffer    []OrderRow
    maxBatch  int
    flushAt   time.Duration
    lastFlush time.Time
}

type OrderRow struct {
    UserID      int64
    AmountCents int64
    Status      string
    CreatedAt   time.Time
}

func NewBatchInserter(pool *pgxpool.Pool) *BatchInserter {
    return &BatchInserter{
        pool:     pool,
        buffer:   make([]OrderRow, 0, 500),
        maxBatch: 500,
        flushAt:  100 * time.Millisecond,
    }
}

func (b *BatchInserter) Add(ctx context.Context, row OrderRow) error {
    b.buffer = append(b.buffer, row)

    shouldFlush := len(b.buffer) >= b.maxBatch ||
        time.Since(b.lastFlush) >= b.flushAt

    if shouldFlush {
        return b.Flush(ctx)
    }
    return nil
}

func (b *BatchInserter) Flush(ctx context.Context) error {
    if len(b.buffer) == 0 {
        return nil
    }

    // Use COPY for maximum throughput - bypasses row-level trigger overhead
    // and reduces WAL volume compared to individual INSERTs.
    _, err := b.pool.CopyFrom(
        ctx,
        pgx.Identifier{"orders"},
        []string{"user_id", "amount_cents", "status", "created_at"},
        pgx.CopyFromRows(b.toRows()),
    )
    if err != nil {
        return err
    }

    b.buffer = b.buffer[:0]
    b.lastFlush = time.Now()
    return nil
}

func (b *BatchInserter) toRows() [][]any {
    rows := make([][]any, len(b.buffer))
    for i, r := range b.buffer {
        rows[i] = []any{r.UserID, r.AmountCents, r.Status, r.CreatedAt}
    }
    return rows
}
```

### Junior to FAANG: Prerequisite Gaps and Interview Entry Point

The prerequisite that most junior engineers lack for LSM internals is an intuitive sense of what "sequential versus random write" actually means on modern storage. On a 2026 NVMe SSD a sequential write sustains roughly 5 to 7 GB per second. Random 4 KB writes on the same device sustain a few hundred MB per second at best, and they also drive write amplification inside the drive itself as the flash controller shuffles pages to reclaim erase blocks. LSMs are designed around this asymmetry. Every write path operation is either an append to a WAL or an append to a flushed SSTable, and compaction reads whole SSTables sequentially and writes whole SSTables sequentially. B-trees, by contrast, have to modify the 8 KB page where the target key lives, which is a random 8 KB write no matter how small the logical modification was. Once you internalize the sequential-versus-random cost model the rest of LSM design is obvious.

A concrete worked example for juniors. A time-series metrics ingester writes 500000 points per second, each point about 64 bytes including timestamp and tags. That is 32 MB per second of logical write. On an LSM engine like Cassandra with size-tiered compaction and typical 10x write amplification the physical write rate is 320 MB per second, well within NVMe capacity and sustainable indefinitely. On a Postgres B-tree with random primary keys the same workload produces many more 8 KB page writes per second because every insert dirties a different leaf page, and the WAL on top of that pushes the total physical rate past 2 GB per second. Same workload, different engine, roughly 6x difference in IOPS cost. This kind of back-of-envelope is the core interview move for any "help us pick a database" system design question.

The interview entry point here is "explain how a write becomes durable in an LSM database". The staircase answer: the write is appended to the commit log (WAL), then inserted into the in-memory MemTable which is a sorted structure such as a skip list or red-black tree. When the MemTable reaches its size threshold (typically 64 MB in Cassandra or 256 MB in RocksDB) it is flushed as an immutable SSTable to L0. Reads consult the MemTable first, then L0 SSTables, then each level below, with bloom filters short-circuiting SSTables that definitely do not contain the key. Background compaction merges SSTables to keep read amplification bounded and reclaim space from tombstones and overwritten keys. Junior candidates who can narrate that path and name MemTable, SSTable, bloom filter, and compaction in the right order clear the bar.

### Senior at FAANG: LSM Internals and RocksDB Tuning at Depth

At staff level LSM knowledge is concrete tuning knobs, not abstractions. Start with compaction strategies because the choice dominates everything else. Size-tiered compaction (STCS), the Cassandra default before 5.0, triggers compaction when a level accumulates N SSTables of similar size and merges them into one larger SSTable. The write amplification is low, typically near the number of levels (around 10x for a realistic fleet), because each key is rewritten once per level promotion. The cost is space amplification. During compaction the old SSTables still exist until the new one is durable, so you need headroom equal to the largest compaction's output, which in practice means provisioning 50 percent extra disk. Read amplification is high because a single read may have to consult many overlapping SSTables, which is where bloom filters earn their budget.

Leveled compaction (LCS), the RocksDB default and the LevelDB model, enforces that SSTables within a level are disjoint by key range, so a point read in a level requires at most one SSTable read. Level 0 is the exception because it holds directly-flushed MemTables which may overlap. Each level below L0 has a size budget 10x larger than the previous, giving a write amplification of roughly level_count times the size ratio, typically 20 to 30x in practice. The payoff is bounded read amplification, since a read touches at most one SSTable per level, and much lower space amplification because overlapping versions do not coexist between levels. The wrong default is LCS for a write-heavy workload where reads are rare. The right default is STCS or universal compaction. The wrong default is STCS for a latency-sensitive read workload where tail latency matters. The right default is LCS with large bloom filters. Getting this decision right at platform scope is a core staff-level competency.

Time Window Compaction Strategy (TWCS) is the correct answer for time-series workloads with TTLs. TWCS groups SSTables by time window (typically one hour or one day) and never compacts across windows. When every row in a window expires through TTL the entire window drops without any compaction work at all, and the disk reclaims immediately. The tradeoff is that within a window you still need some compaction strategy, so TWCS is really a composition over STCS. The pathology TWCS prevents is repeated rewriting of already-old data that is about to be deleted anyway, which is the dominant write amplification cost of TTL workloads on size-tiered engines. For any event-stream or observability workload on Cassandra or Scylla, TWCS is the default choice and getting this wrong burns CPU and SSD endurance for no benefit.

Universal compaction is the RocksDB answer for write-optimized workloads that cannot tolerate the write amplification of LCS. It is structurally similar to STCS but with a strict invariant that no level's total size exceeds the sum of all smaller levels. This bounds space amplification more tightly than classic STCS while keeping write amplification close to the STCS ideal. Cassandra 5.0's Unified Compaction Strategy (UCS) is a convergent design that parameterizes between leveled and size-tiered behavior on a per-key-density basis, which is how you get a single strategy that is correct across a heterogeneous workload. At staff level you should know which of these strategies each engine you run supports and have a default per workload class documented in your platform's database design guide.

RocksDB tuning is worth specific attention because RocksDB (or a close derivative) is the storage engine behind TiKV (TiDB), MyRocks, and YugabyteDB - CockroachDB uses Pebble, its own RocksDB-inspired engine written in Go, and ScyllaDB uses an analogous architecture. The knobs that matter most in practice: `write_buffer_size` (MemTable target size, typically 64 to 256 MB, trade memory for flush frequency), `max_write_buffer_number` (how many MemTables can exist before backpressure kicks in, typically 3 to 4), `level0_file_num_compaction_trigger` (how many L0 files before compaction starts, typically 4, too low causes CPU storms and too high causes read amplification spikes), `target_file_size_base` (target SSTable size at L1, typically 64 MB, larger reduces file count but increases compaction granularity), `max_bytes_for_level_base` (L1 budget, usually 10x write_buffer_size so that the L0 to L1 compaction is well-sized), and block cache size (analogous to Postgres shared_buffers, typically a third of available RAM). Bloom filter bits per key (`bloom_bits_per_key`) defaults to 10 for a 1 percent false positive rate. For read-heavy workloads with many missing-key probes, bumping to 15 or 20 bits cuts false positive I/O at the cost of a few more GB of RAM, which is almost always worth it on tiered storage.

The RUM (Read, Update, Memory) trade-off is the canonical framework for reasoning about LSM knobs, and staff engineers should be able to sketch it on a whiteboard. Every knob trades one amplification axis for another. Increasing MemTable size reduces write amp (larger flushes, fewer L0 files) at the cost of memory and flush latency. Deeper level hierarchies reduce space amp at the cost of write amp (more rewrites). Larger bloom filters reduce read amp at the cost of memory. There is no universal good configuration, only configurations that are good for a specific workload shape. Staff-level competence is being able to profile a workload (write rate, key distribution, read ratio of hits to misses, TTL behavior) and prescribe knob values that minimize the weighted sum of the amplification costs that matter for that workload.

Tiered storage is the next frontier for LSM engines and worth understanding because it is production in 2026 for Cassandra, Scylla, and several RocksDB variants. The idea is that deeper levels (older, colder data) live on slower and cheaper storage (typically object storage like S3 with a local cache) while recent levels live on NVMe. This bends the cost curve dramatically for append-mostly workloads where the bulk of data is rarely read after a few days. The gotcha is that compaction across tiers must read from object storage and write back, which can saturate network bandwidth if compaction is not throttled. A staff engineer designing a tiered storage rollout needs a compaction bandwidth budget expressed in bytes per second and a monitoring story that alerts when compaction falls behind by more than a level, because a tiered compaction backlog that goes unfixed ends up moving hot data to cold storage and destroying read latency.

Finally, the secondary index story on LSM is genuinely different from B-trees and it is an underappreciated reason LSM databases have the schema shapes they do. In Cassandra, secondary indexes are local to each node and updated synchronously with the primary write, which works for low-cardinality lookups but degenerates badly for high-cardinality because every query must fan out to every node. In CockroachDB and TiDB, secondary indexes are themselves LSM-backed ranges with their own Raft replication, which means a write to a table with five indexes generates six consensus rounds. This is why LSM-based SQL engines work hard to minimize per-write index maintenance (INCLUDE-style covering indexes, partial indexes, and often explicit materialized views over raw tables). At staff level you should treat "how many indexes does this table have" as a first-class capacity planning question for LSM-backed SQL, in a way that is less critical for single-node Postgres where the index cost is local and amortized.

---
