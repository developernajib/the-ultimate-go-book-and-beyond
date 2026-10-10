## Summary

Query optimizers and execution engines in C++ demand deep systems engineering rigor. Core architecture breakdown:

### The Front End

Section 2 introduced relational algebra and the logical plan tree. The visitor pattern in C++ is the right tool for plan traversal. Predicate pushdown, projection pushdown, decorrelation, and constant folding are the heuristic rewrites that every engine applies before cost-based optimization.

### The Three Execution Models

Section 3 covered Volcano (tuple-at-a-time, virtual call dominated, lost the analytical race). Section 4 covered vectorized execution (batches of 1024 to 4096, the model used by DuckDB, ClickHouse, Velox, Photon, BigQuery). Section 5 covered code generation with LLVM (Hyper, Umbra, Spark Tungsten, Photon for expressions). The right answer in 2026 is vectorized as the default with hot-path codegen for expression evaluation.

### The Optimizer

Chapters 06 to 09 covered the optimizer's core. Cardinality estimation with histograms (equi-width, equi-depth, max-diff), HyperLogLog for distinct counts, sketches (Count-Min, t-digest), and ML approaches (Naru, DeepDB, Bao). Cost models with calibrated CPU, I/O, network, and memory components. Cascades framework with memo, groups, transformation rules, implementation rules, branch-and-bound. Join ordering with DPccp for exact enumeration up to 16 tables and greedy fallbacks above.

### The Operators

Chapters 10 to 12 covered specific operators. Hash join (linear probing, prefetch, Bloom filter pushdown). Grace hash join for spilling. Sort-merge for sorted inputs. Index nested-loop for selective outer. Hash aggregation with two-phase, perfect hashing for low NDV, and adaptive radix tries for strings. Window functions with sliding aggregation, monotonic deques for MIN/MAX, and segment trees for arbitrary aggregates.

### The Storage Layer

Chapters 13 to 16 covered storage. Parquet layout (row groups, column chunks, pages, dictionary, RLE). ClickHouse MergeTree with LSM merging and skipping indexes. Compression schemes from lightweight (dictionary, RLE, bit-packing, FOR, delta-of-delta) to general-purpose (LZ4, Zstd, Snappy). Zone maps and Bloom filters for predicate skipping. Late materialization with position lists and PREWHERE.

### The Distributed Layer

Chapters 17 and 18 covered distribution. Exchange operators (singleton, hash, broadcast, range, merge). Dremel multi-level serving trees. Spanner and F1 Query architecture. Adaptive execution at runtime: spec exec for slow nodes, cardinality-driven join algorithm choice, partition coalescing, mid-query repartitioning for skew.

### The Concurrency Layer

Section 19 covered MVCC with timestamps, version chains, optimistic concurrency control, garbage collection. Hekaton, CockroachDB, Spanner, DuckDB all variations on the theme. The query engine respects snapshot timestamps in every scan.

### The Out-of-Core Layer

Section 20 covered spilling. Memory budgets, hash join spill via grace partitioning, external merge sort, hash aggregation spill, async I/O with io_uring, direct I/O. Spill-aware cost models that prefer plans avoiding spill when possible.

### The End-to-End Code

Section 21 assembled a 350-line vectorized engine that scans a custom file format, filters with a branchless predicate, hash aggregates, and sorts. Every concept in the chapter appears in the code.

### The Production References

Section 22 was the reading list. DuckDB for the textbook vectorized engine. ClickHouse for the speed champion with specialized types. Velox for the executor library shape. Calcite for the canonical Cascades implementation. Hyper, Umbra, and Photon for hybrid and codegen designs.

### The Interview Prep

Section 23 listed 6 labs that turn knowledge into a portfolio. Section 24 listed 15 deep questions from real loops.

### The Big Themes

Three themes recur across every section.

**Cache-aware data layout.** Vectors, batches, alignment, prefetching, software-managed buffers. C++ wins this layer because it gives you control over every byte. None of this works without thinking about cache lines.

**The cost of wrong cardinality.** Every cost-based decision hinges on an estimate. The estimates are wrong, sometimes by 1000x. Adaptive execution is the response: monitor reality, replan when needed. Production engines spend more engineering effort on cardinality and adaptation than on the optimizer's algorithm itself.

**Vectorization as the dominant model.** Twenty years after MonetDB/X100, vectorized execution is the default for analytical engines. Codegen survives in narrow niches. The reasons are practical: compile time, debuggability, integration with extensions, and the fact that LLVM optimization at -O2 catches 80% of the wins of full pipeline codegen anyway.

### What This Chapter Did Not Cover

Some topics that a complete query engine course would include but that did not fit:

- Full text search and inverted indexes.
- JSON and semi-structured query (Lateral, Unnest, JsonPath).
- Recursive CTEs and graph queries.
- Geospatial query operators.
- Time-series specific optimizations (continuous aggregates, retention policies).
- Stream processing operators (windowed joins, watermarks).
- ML inference inside the query engine.

Each is its own chapter and own production reference.

### Where to Go Next

If you are interviewing for a query engine role, do the labs from Section 23, walk through the questions from Section 24 with a peer, and read one of the codebases from Section 22 deeply.

If you are designing a new engine, your priority order should be: storage layout first, then vectorized execution, then optimizer, then adaptive execution. Skip distributed until single-node is great.

If you are debugging a slow query in production, the answer is almost always cardinality. Get EXPLAIN ANALYZE, find the divergence, fix the stats. Do this before touching plans, hints, or the optimizer.

### Closing

A query engine is the most performance-sensitive piece of software a database company ships. The C++ that powers DuckDB, ClickHouse, Velox, Photon, BigQuery, and Spanner is the work of teams that have measured every cache miss and counted every cycle. Joining one of those teams means doing the same.

The depth in this chapter is the floor, not the ceiling. The ceiling is set by what you build next.

---

| [◀ Chapter 155: NUMA, Cache Coherence, and Hardware-Aware C++](../chapter-155-numa-cache-coherence/00-introduction.md) | [Chapter 156: Query Optimizers and Execution Engines in C++](00-introduction.md) | [Chapter 157: Search and Ranking Systems in C++](../chapter-157-search-ranking-systems/00-introduction.md) ▶ |
