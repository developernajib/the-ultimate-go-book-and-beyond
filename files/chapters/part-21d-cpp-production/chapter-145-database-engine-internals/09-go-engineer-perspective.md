## The Go Engineer's Perspective

Every database concept in this chapter has a Go counterpart. Some are direct ports (goleveldb), some use the same algorithm with different trade-offs (bbolt's mmap vs. a traditional buffer pool), and some are architectural decisions made consciously in favor of simplicity (etcd's WAL vs. ARIES). This section maps the terrain.

### Concept Mapping

| Database concept | C++ implementation | Go equivalent |
|---|---|---|
| B+ tree index | Custom, page-aligned nodes | `go.etcd.io/bbolt` (on-disk), `github.com/google/btree` (in-memory) |
| Buffer pool | Custom with LRU-K, pin/unpin | bbolt uses `mmap`. OS page cache does eviction |
| WAL + ARIES recovery | Custom, fsync on commit | `go.etcd.io/etcd/server/wal`. Simpler (Raft ensures only committed entries apply) |
| MVCC | PostgreSQL heap tuples with xmin/xmax | CockroachDB: `key@timestamp` in RocksDB via CGO |
| LSM tree + compaction | RocksDB, LevelDB | `github.com/syndtr/goleveldb`, `github.com/dgraph-io/badger` |
| Skip list memtable | LevelDB `SkipList<Key>`, lock-free | badger `skl.Skiplist`, lock-free with atomic CAS |
| Bloom filter | Custom with MurmurHash | `github.com/bits-and-blooms/bloom` |
| Vectorized execution | DuckDB, ClickHouse | `github.com/marcboeker/go-duckdb` (CGO), DuckDB embedded |
| Hash index | Extendible hashing | Go `map` (built-in, hash table) |
| R-tree spatial index | PostGIS, SpatiaLite | `github.com/tidwall/rtree` |

### Why C++ for Storage Engines

The reasons Go engineers encounter C++ at the storage layer are not historical, they are technical:

**No GC pauses at compaction time.** An LSM compaction reads and writes gigabytes of data. If a GC pause fires mid-compaction, write latency spikes. In Go, even with `GOGC=off`, a sufficiently large live heap accumulates enough scan work that GC pauses at inopportune times. C++ with arena allocation or explicit `free()` avoids this entirely.

**`mmap` + `O_DIRECT` control.** High-performance storage engines bypass the page cache (`O_DIRECT`) for data pages, managing their own buffer pool to get control over I/O ordering, prefetch, and write coalescing. Go does not expose `O_DIRECT` in the standard library (it is achievable via `syscall` and `unsafe` but awkward).

**SIMD in hot loops.** The vectorized filter loop (`for (int i = 0; i < count; ++i) sum += data[i]`) compiles to `vpaddd` with AVX2 when the compiler can prove alignment and no aliasing. Go's compiler does not auto-vectorize with SIMD to the same degree. The 10× gap between volcano and vectorized execution is real in C++ and harder to achieve in Go.

**Deterministic memory layout.** Aligning a B-tree node to a 4 KB page boundary requires `alignas(4096)` or `posix_memalign`. Go's memory allocator does not guarantee page alignment, making it impossible to build a B-tree where each node maps exactly to one OS page without CGO.

### Why Go for Database Coordination

The flip side is equally valid:

**Concurrency is far simpler.** CockroachDB's distributed transaction coordinator, the code that routes transactions across nodes, manages intent resolution, and coordinates multi-node MVCC reads, is thousands of goroutines interacting via channels. Rewriting this in C++ with threads and condition variables would double the bug count.

**GC is acceptable for metadata paths.** etcd is a metadata store. It handles thousands of requests per second, not millions. GC pauses of 1-5ms are invisible at this scale. The simplicity gains from not managing memory manually vastly outweigh the latency cost.

**Standard library quality.** Go's `net/http`, `crypto/tls`, `encoding/json`, and `context` package are production-grade with no external dependencies. Building an equivalent distributed system transport in C++ requires choosing from Boost.Asio, gRPC, folly::Future, and a dozen competing options.

### The Recommended Learning Path

After this chapter, the next steps for a Go engineer who wants to go deeper:

1. **CMU 15-445** (Andy Pavlo, Carnegie Mellon): The best freely available course on database internals. Assignments include implementing a buffer pool, B+ tree, query executor, and concurrency control in C++. All lecture videos are on YouTube.

2. **"Database Internals" by Alex Petrov** (O'Reilly, 2019): The single best book on storage engine design. Part I covers B-tree storage engines (SQLite, PostgreSQL). Part II covers LSM storage engines (LevelDB, RocksDB, Cassandra). Highly practical.

3. **"Designing Data-Intensive Applications" by Martin Kleppmann** (O'Reilly, 2017): The big-picture view. Storage engines, replication, distributed transactions, stream processing. The chapter on storage engines ties directly to this chapter.

4. **Read the RocksDB wiki**: `https://github.com/facebook/rocksdb/wiki`. The Architecture, Compaction, and Write Stalls pages are particularly dense with practical knowledge.

5. **Read the PostgreSQL source**: `src/backend/access/nbtree/` for B-trees, `src/backend/storage/buffer/` for the buffer pool, `src/backend/access/heap/heapam.c` for MVCC tuple access. The PostgreSQL source is the best-commented C storage engine in existence.

### Closing Thought

The distinction between "Go database" and "C++ database" is blurring. CockroachDB is Go over RocksDB (C++). TiDB is Go over TiKV (Rust). YugabyteDB is C++ using DocDB (RocksDB fork). The pattern is always the same: the storage kernel is in a systems language with manual memory control. The coordination, SQL layer, and distributed protocol are in a higher-level language. Understanding both sides of that boundary, which this chapter aimed to provide, is what separates a Go engineer who uses databases from one who builds them.

---
