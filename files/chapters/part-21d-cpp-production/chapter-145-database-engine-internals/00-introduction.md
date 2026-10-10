# Chapter 145: Database Engine Internals

> "A database is a machine for answering questions about data, the internals determine whether those answers come in milliseconds or seconds.", Adapted from Jim Gray

Every senior Go engineer eventually reaches the same inflection point. You are profiling a slow query, or designing a caching layer, or evaluating whether to use RocksDB or a custom solution. Suddenly the abstractions stop being sufficient. You need to know what actually happens inside the engine: how pages move from disk to RAM, why a range scan is fast on a B+ tree but not on a hash index, what "write amplification" means in concrete byte terms, and why PostgreSQL has a background vacuum process that mysteriously consumes I/O at 3 AM.

This chapter is not a survey. It is an implementation-first deep dive into the core data structures and algorithms that power real production databases, PostgreSQL, MySQL InnoDB, RocksDB, LevelDB, and DuckDB. Every major concept is accompanied by working C++ code that reflects the patterns you will find in those actual codebases. The code is simplified for clarity, but the architecture is authentic.

Why C++ for this chapter? Because every high-performance database storage engine is written in C++. The reason is not nostalgia, it is that storage engines require deterministic memory management (no GC pauses during compaction), fine-grained control over I/O (aligned buffers, `O_DIRECT`, `fsync` semantics), and SIMD vectorization of tight inner loops. Go is excellent for the metadata and coordination layers of databases (CockroachDB, etcd, TiKV's client proxy), but the storage kernel underneath is almost always C or C++.

What you will learn in this chapter:

- **B-tree and B+ tree**: the dominant on-disk index structure since the 1970s, still the default in PostgreSQL, MySQL, SQLite, and every SQL database. You will implement insert, search, and range scan.
- **LSM trees**: the architecture behind RocksDB, LevelDB, Cassandra, and BadgerDB. Memtable flush, SST files, bloom filters, compaction strategies, and the fundamental write-amplification trade-off.
- **Write-Ahead Log (WAL)**: the mechanism that makes databases durable. The ARIES algorithm, crash recovery, checkpointing, and group commit.
- **Buffer pool management**: how databases keep a fixed-size RAM cache of disk pages, LRU-K eviction, pin/unpin protocol, dirty page flushing.
- **Query execution**: the volcano iterator model used in PostgreSQL and the vectorized execution model used in DuckDB and ClickHouse. A full hash join implementation.
- **MVCC**: how readers and writers avoid blocking each other. Version chains, visibility rules for each isolation level, and garbage collection.
- **Index structures**: when to use a hash index vs. a B+ tree vs. a skip list vs. an ART (Adaptive Radix Tree) vs. an R-tree.
- **Building a KV store**: a production-inspired mini key-value store with WAL, skip list memtable, SST flush, and bloom filter, approximately 200 lines of real C++.

Go comparisons appear throughout. You will see how `bbolt` uses `mmap` instead of a traditional buffer pool, how `badger` implements the same LSM architecture as RocksDB, and how CockroachDB implements MVCC in Go. The goal is not to make you rewrite your Go databases in C++, it is to give you the mental model to understand what the engines beneath your code are actually doing.

After this chapter, reading the PostgreSQL source tree, the RocksDB wiki, or Andy Pavlo's CMU 15-445 lecture notes will feel familiar rather than overwhelming.

---
