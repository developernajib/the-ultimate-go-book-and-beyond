## Learning Objectives

By the end of this chapter, you will be able to:

### Optimizer Theory

1. **Express a SQL query as relational algebra** and translate the algebra into a logical plan tree using a visitor-based node hierarchy in C++.
2. **Explain the trade-offs between Volcano iteration and vectorized execution** with quantitative numbers on virtual call cost, instruction cache pressure, and SIMD use.
3. **Reproduce the Hyper data-centric code generation argument** and identify when LLVM JIT pays for its compile time and when it does not.
4. **Build a memo and group structure for a Cascades-style optimizer** including transformation rules, implementation rules, and branch-and-bound pruning.
5. **Compare DPsize, DPsub, and DPccp join enumeration** and pick the right algorithm for a given query graph shape (chain, star, clique, snowflake).

### Cardinality and Cost

6. **Build equi-depth and max-diff histograms** with proper bucket sizing and explain when each beats the other on skewed data.
7. **Implement HyperLogLog in C++** with the bias-corrected estimator and use it for distinct-value cardinality on a 64-bit hash.
8. **Estimate join cardinality** under independence and under correlation, and explain why correlation is the dominant source of estimator collapse on real workloads.
9. **Calibrate a cost model** for I/O, CPU, and memory using micro-benchmarks and explain why cost constants drift across hardware generations.

### Execution Engine Internals

10. **Implement a vectorized hash join in C++** with a build phase that uses linear probing on a power-of-two-sized table and a probe phase that batches matches.
11. **Implement grace hash join with spill** when the build side exceeds memory budget, including partition fanout selection and async I/O.
12. **Implement aggregation with hash table partitioning** and explain when two-phase aggregation beats single-phase.
13. **Write a window function executor** that handles ROWS, RANGE, and GROUPS frames using a segment tree for invertible aggregates.
14. **Decode Parquet** including dictionary pages, RLE/bit-packed pages, and predicate pushdown via row group statistics.

### Compression and Storage

15. **Choose the right compression scheme** (dictionary, RLE, bit-packing, FOR, delta-of-delta, Zstd, LZ4, BtrBlocks) for a given column type and access pattern.
16. **Implement zone maps and bloom filters** for skipping indexes and explain ClickHouse's `set`, `ngrambf_v1`, and `tokenbf_v1` index types.
17. **Apply late materialization** with position lists and decode-on-demand, and explain why ClickHouse PREWHERE is the canonical implementation.

### Distributed and Adaptive Execution

18. **Insert exchange operators** to convert a single-node plan into a distributed plan, choosing between hash partitioning, broadcast, and merge.
19. **Reason about Dremel's multi-level serving tree** and the F1 query coordinator architecture.
20. **Adapt a plan at runtime** when actual cardinalities diverge from estimates, including mid-query repartitioning.

### Concurrency and Storage Integration

21. **Implement MVCC visibility logic** for snapshot isolation, including transaction IDs, commit timestamps, and version chain garbage collection.
22. **Spill hash tables and sort runs to disk** with bounded memory, async I/O, and external merge sort using replacement selection.

### End-to-End

23. **Build a minimal vectorized query engine in C++23** that reads Parquet, executes a hash aggregation, and sorts the result with vector batches of 2048 rows.
24. **Map every concept in this chapter to the corresponding code in DuckDB, ClickHouse, or Velox** so that you can read those codebases productively.

### Interview-Ready Outcomes

After completing this chapter, you should be able to walk into an L6 interview on the CockroachDB SQL team, the Snowflake execution team, the BigQuery Dremel team, the Velox team at Meta, or the Aurora storage team and answer:

- Walk me through what happens when a SELECT with a 5-table join hits your engine, from parser to result rows.
- Why does DuckDB use vectorization and Hyper used codegen. Which would you pick for a new engine in 2026 and why.
- Design the hash join operator for a system that must spill cleanly when build side is 100x memory.
- Your optimizer picks a bad plan on a customer query. The cardinality estimate is off by 1000x. Walk me through how you debug and fix this.
- Implement a ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW window function efficiently.

If you cannot answer all five at the whiteboard with running C++ code, this chapter is your study guide.

---
