## Interview Questions

These are 15 deep questions from real interview loops at the CockroachDB SQL team, Snowflake compute, BigQuery Dremel, the Velox team at Meta, and the Aurora storage layer. Each is followed by what the interviewer is checking and the kind of answer that earns a "strong yes."

### 1. Walk me through what happens when a SELECT with a 5-table join hits your engine, from parser to result rows.

**What is being checked.** End-to-end systems thinking. Can you discuss the lifecycle without losing track of the layers.

**Strong answer.** Parse to AST. Bind names against the catalog. Build logical plan. Apply heuristic rewrites (predicate pushdown, projection pushdown, decorrelation, constant folding). Estimate cardinalities at every node using histograms, MCV lists, and HyperLogLog for distincts. Cost-based optimization with Cascades or DPccp for the join order. Pick physical operators and insert exchanges for distribution. Generate either compiled code (Hyper-style) or vectorized operator tree. Execute pipelines with morsel-driven parallelism. Stream results via the row protocol. Mention adaptive execution at pipeline boundaries.

### 2. Why does DuckDB use vectorization and Hyper used codegen. Which would you pick for a new engine in 2026 and why.

**What is being checked.** Engineering trade-offs, not religion.

**Strong answer.** Hyper compiles every pipeline to LLVM IR and gets peak throughput on long compute-bound queries. DuckDB uses precompiled vectorized kernels and pays no compile time. For ad-hoc analytical queries (DuckDB's target), compile time of 100 ms dominates 10 ms execution. For long ETL (Hyper's target), 100 ms compile is amortized over minutes of execution. In 2026 I would pick vectorization with hot-path codegen for expression evaluation only. Most queries do not need full pipeline codegen, but expression evaluation in filter and projection benefits from JIT. This is the Photon hybrid model.

### 3. Design the hash join operator for a system that must spill cleanly when build side is 100x memory.

**What is being checked.** Out-of-core design. Many candidates know hash join but not grace hash join.

**Strong answer.** Use partition-on-build. Partition build side by hash to N partitions on disk where N is sized so each partition fits in memory. Use upper bits of the hash for partitioning so lower bits are reused for the in-memory hash table. Probe side partitions identically. Process one partition at a time: load partition into memory, build hash table, probe with the partition's probe rows. If a partition still does not fit, recursively partition. Discuss async I/O, direct I/O, and the trade-off between partition count (more is more file descriptors and smaller writes) and depth (more is more passes). Reference DuckDB's radix-partitioned hash join.

### 4. Your optimizer picks a bad plan on a customer query. The cardinality estimate is off by 1000x. Walk me through how you debug and fix this.

**What is being checked.** Production debugging. Whether you know the failure modes.

**Strong answer.** Get EXPLAIN and EXPLAIN ANALYZE. Compare estimated vs actual rows at every node. Find the divergence point. Check whether the column has stats and if they are stale. Check whether the predicate is on a single column (histogram should work) or multiple (independence assumption likely failed). Check for correlated columns. Fix options in priority: fresh stats, multi-column statistics, hint or force the right plan, decorrelation rewrite, sample-based cardinality at runtime. Mention that 80% of bad plans in production are correlation. Explain why the optimizer's algorithm matters less than its inputs.

### 5. Implement a ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW window function efficiently.

**What is being checked.** Whether you know the sliding aggregation trick.

**Strong answer.** This is a running total. Maintain a single accumulator. For each row in order, add the value, emit. Reset on partition boundary. O(N) total. Discuss the contrast with bounded windows, which need either a sliding subtraction or a deque (for non-invertible aggregates) or a segment tree (for arbitrary aggregates). For SUM, COUNT, AVG, the inverse trick works. For MIN, MAX, monotonic deque. For percentile, segment tree.

### 6. You have a column with skewed values: one value covers 80% of rows. How do skipping indexes and join algorithms handle this.

**What is being checked.** Skew awareness, which is the difference between toy engines and production engines.

**Strong answer.** Zone maps degrade because every block has the hot value, so no block can be skipped on equality. Bloom filters still work but only on cold (rare) values. Set indexes work for low-cardinality columns. For joins, partitioned hash join is bottlenecked by the partition with the hot key. Solutions: detect with Count-Min sketch on producer side, broadcast hot keys, salt the join key with a random suffix, or split the hot partition across multiple workers. Photon has explicit skew-aware join.

### 7. Explain the difference between snapshot isolation and serializable isolation. What does an analytical query engine need.

**What is being checked.** Whether you understand isolation. Many candidates do not.

**Strong answer.** SI: every transaction sees a consistent snapshot at its start time. Reads do not block, writes do not block, no dirty reads. SI is vulnerable to write skew anomalies. Serializable: equivalent to some serial order. SSI extends SI with conflict detection to catch write skew. For an analytical query engine, snapshot isolation is what you need. The query takes a snapshot, reads consistent data, finishes. The complications: long queries hold versions and prevent GC, uncommitted writes are not visible, commit timestamp ordering. Reference Postgres, CockroachDB, Spanner.

### 8. Why is two-pass hashing (compute all hashes, then probe) faster than one-pass in the inner loop.

**What is being checked.** Cache and prefetcher knowledge.

**Strong answer.** Hash table probes are random memory accesses. Each probe touches a cache line that is unlikely to be hot. If you compute hash and probe in the same loop iteration, the CPU stalls waiting for the cache line. Two-pass: first pass computes hashes (sequential, vectorizable, cache-resident). Second pass probes with prefetch instructions issued ahead of the actual probe. The prefetcher fetches the cache lines while the loop is processing other rows. Result: 2x to 4x faster. This is core DuckDB and ClickHouse hash join design.

### 9. Compare Parquet and ClickHouse MergeTree as storage formats.

**What is being checked.** Storage layer knowledge.

**Strong answer.** Parquet is a portable file format. Row groups, column chunks, pages. Dictionary, RLE, bit-packed, plain encodings. Snappy or Zstd compression. Footer with metadata. Read by any engine. MergeTree is ClickHouse's storage engine, not just a file format. Tables are sorted by primary key. Per-column files. LSM-style background merging. Per-column encoding via codec stacks. Skipping indexes (set, bloom, ngrambf, tokenbf). Tightly coupled to ClickHouse executor (LowCardinality, Sparse). Trade-off: Parquet wins for portability, MergeTree wins for self-contained ClickHouse deployments.

### 10. Describe the Cascades framework. What is the memo, what is a group, how does branch-and-bound work.

**What is being checked.** Optimizer theory.

**Strong answer.** Memo is the data structure that stores all explored plans in a deduplicated graph. A group is an equivalence class of expressions producing the same logical output. Different groups have different physical properties (sort order, partitioning). Each group has expressions (operator + child group references) and winners (best physical plan per required property set). The optimizer applies transformation rules to expand groups and implementation rules to assign physical operators. Search is top-down with memoization. Branch-and-bound: optimizer carries an upper bound on the cost it cares about. Subtrees whose partial cost exceeds the bound are pruned. This is what makes Cascades tractable on large plans.

### 11. Implement HyperLogLog in C++ on the whiteboard. How does it work.

**What is being checked.** Sketches and approximate algorithms.

**Strong answer.** HLL estimates distinct count with constant memory. Hash each value to a uniform 64-bit integer. Use the lower bits to pick a bucket. Count leading zeros of the upper bits. Track the maximum leading-zero count per bucket. Estimate is roughly `m * 2^max_lz` where m is the number of buckets, with a bias correction term. Standard error 1.04 / sqrt(m). 16384 buckets gives 0.81% error, 16 KB state. Code: hash, mask, count_leading_zeros, max-update. Final: harmonic mean times alpha. Mention bias corrections for small (linear counting) and large cardinalities. Mention HLL++ for further improvements.

### 12. What is the difference between vectorized execution and code generation. What does each give up.

**What is being checked.** Execution model trade-offs.

**Strong answer.** Vectorized: precompiled operator kernels work on batches of 1000-4000 rows. Each operator has tight inner loops with SIMD. Per-batch dispatch overhead amortizes across rows. Codegen: at query time, generate a single LLVM function that inlines all operators for a pipeline. No dispatch, no batches, full register allocation across the pipeline. Trade-offs: codegen has higher peak throughput on long queries but pays JIT compile time on every query. Vectorized has lower peak but constant overhead. Vectorized is easier to debug and integrate with extensions. Codegen is hard to compose with UDFs in different languages.

### 13. Design predicate pushdown for a Parquet reader. What can be pushed and what cannot.

**What is being checked.** Storage integration.

**Strong answer.** Pushable: equality, range, IS NULL, IS NOT NULL on indexed columns (those with statistics). Use row group statistics (min, max, null count) to skip whole row groups. Use page statistics (column index in Parquet 2.6+) to skip pages. Use Bloom filters when present. Not pushable: predicates involving expressions of the column (substring, function calls), predicates involving multiple columns with no compound stats, regex on strings. Implementation: split predicates into pushable conjuncts and residual conjuncts. Push pushable to the reader (which uses statistics). Run residual on the operator output. Mention DuckDB and Spark Parquet readers as references.

### 14. The optimizer says join order A is best. At runtime, after the first join, the cardinality is 100x larger than expected. What should the engine do.

**What is being checked.** Adaptive execution.

**Strong answer.** This is a classic adaptive execution case. Options in order of cost. First, recheck the next join's algorithm choice: a planned in-memory hash join may now need to be a grace hash join because the build side is too large. Second, recheck the join algorithm side: if the previously-larger side is now small, consider broadcast. Third, consider reordering remaining joins (most aggressive). The first two are cheap and Spark AQE does them. Reordering is rare because work has been done. Mention the divergence threshold (typically 10x) above which adaptation triggers. Reference BigQuery and Photon.

### 15. You are designing a new query engine in 2026. Walk me through your top-level architecture decisions in priority order.

**What is being checked.** Synthesis. Whether you can put the whole stack together.

**Strong answer.** Storage: columnar with row groups, dictionary + RLE + bit-packing + Zstd, zone maps and Bloom filters. Either Parquet for portability or proprietary for tight executor integration. Picking based on whether you are a database or a library. Execution: vectorized with batches around 2048 rows. Add codegen for expression evaluation only. Operator interface: pull-based per-batch with optional push for codegen. Concurrency: morsel-driven parallelism, lock-free hash tables, MVCC at storage. Optimizer: Cascades framework with DPccp for join ordering up to 16 tables, greedy fallback. Cardinality with histograms + HLL + sample-based for complex predicates. Cost model with calibrated constants and adaptive recheck. Distributed (if relevant): exchange operator with credit-based flow control, hash and broadcast partitioning, speculative execution. Spilling everywhere with async I/O. Adaptive at pipeline boundaries. Reference DuckDB for vectorized, Velox for the executor library shape, Cascades for the optimizer, Photon for adaptation.

### How to Practice

Pick three of these questions. Write a 500-word answer to each without looking at notes. Time yourself: 10 minutes per question. Compare to the answer above. Identify gaps. Read the relevant chapter in this book. Try again next week.

After two weeks of practice, run mock interviews with a peer who works on a query engine. The senior bar at any FAANG database team requires you to answer at least 12 of these 15 fluently.

---
