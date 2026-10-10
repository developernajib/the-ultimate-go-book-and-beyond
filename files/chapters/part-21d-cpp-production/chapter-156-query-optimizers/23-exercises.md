## Exercises

Six labs that take this chapter from reading to building. Each is a self-contained project. Doing all six will take a senior engineer 3-6 weeks of focused evening work and will leave you with a portfolio that maps directly to interview signal.

### Lab 1: Build a Vectorized Filter Pipeline

**Goal.** Implement a vectorized scan + filter + projection pipeline in C++ that processes 100 GB of synthetic data faster than 5 seconds on a single core.

**Specification.**

1. Generate 100 GB of synthetic data: 10 columns of int64, 1 billion rows. Write in the simple file format from chapter 21 (header + dense column data).
2. Implement a vectorized executor with batch size 2048:
 - Scan operator that reads chunks via memory-mapped file or pread.
 - Filter operator with branchless inner loops.
 - Projection operator that copies selected columns.
3. Run query: `SELECT col0, col5 FROM t WHERE col2 > 1000 AND col7 < 5000`.
4. Measure throughput. Compare against `wc -l` on uncompressed CSV with the same data.

**Acceptance.**

- Throughput at least 2 GB/s of input bytes per core.
- Implementation under 500 lines of C++ excluding tests.
- Unit tests covering predicate edge cases.
- Benchmark output showing batch-size sensitivity (try 256, 1024, 2048, 8192).

**Stretch goals.**

- Add NULL handling with validity bitmaps.
- Add multi-threading with morsel-driven parallelism (work stealing pool).
- Compare branchless vs branchy predicate evaluation. Plot the crossover.

### Lab 2: Implement HyperLogLog with Merge

**Goal.** Build a production-quality HLL implementation that can be merged across distributed shards.

**Specification.**

1. Implement HLL with configurable precision (8 to 16 registers).
2. Include bias correction and small-cardinality linear counting.
3. Implement merge of two HLL sketches (element-wise max of registers).
4. Implement serialize and deserialize (binary format that survives endianness).
5. Benchmark on synthetic data: cardinalities from 100 to 1 billion.
6. Plot estimated error vs actual error.

**Acceptance.**

- Standard error within 1.04 / sqrt(m) for cardinalities above 10K.
- Linear counting works correctly for cardinalities below `2.5 * m`.
- Merge produces the correct estimate across two non-overlapping streams.
- Serialization round-trips on a different architecture (test with QEMU on aarch64 if you are on x86, or vice versa).

**Stretch goals.**

- Implement HyperLogLog++ improvements (sparse representation for low cardinality).
- Compare your implementation's accuracy and speed against ClickHouse's `uniqHLL12` and DuckDB's `approx_count_distinct`.
- Add a mode that switches between HLL and exact set when cardinality is small.

### Lab 3: External Merge Sort

**Goal.** Implement an external merge sort that handles datasets 10x larger than memory.

**Specification.**

1. Sort 10 GB of int64 with a 1 GB memory budget.
2. Phase 1: Read input in 1 GB chunks, sort in memory, write sorted runs to disk.
3. Phase 2: K-way merge using a min-heap.
4. Use async I/O (io_uring on Linux, equivalent elsewhere) so I/O overlaps with sort and merge.
5. Benchmark against `sort -n` on the same input.

**Acceptance.**

- Throughput at least 200 MB/s end-to-end on a single NVMe SSD.
- Memory usage stays within budget (verify with `getrusage`).
- Correctness checked by comparing sample of output to `sort -n`.

**Stretch goals.**

- Implement replacement selection for longer initial runs.
- Multi-pass merge when run count exceeds open file descriptor limit.
- Compare with parallel sort using multiple threads on the in-memory phase.

### Lab 4: Cardinality Estimator with Histograms

**Goal.** Build a cardinality estimator and validate it against real data.

**Specification.**

1. Implement equi-width, equi-depth, and max-diff histograms.
2. Implement HyperLogLog for distinct counts.
3. Build a small predicate evaluator that takes a column and a predicate (`<`, `<=`, `=`, `BETWEEN`) and returns an estimated row count.
4. Test against TPC-H scale 10 (or any synthetic dataset with known distributions).
5. For 50 random predicates on the `lineitem` table, compare estimated row count to actual.

**Acceptance.**

- Geometric mean error below 2x on equi-width.
- Geometric mean error below 1.5x on equi-depth.
- Geometric mean error below 1.3x on max-diff with explicit MCV list.
- HLL error within 2% on distinct counts above 1000.

**Stretch goals.**

- Add multi-column statistics (functional dependencies, correlation factor).
- Implement sample-based estimation for complex predicates.
- Plot estimator error as a function of bucket count.

### Lab 5: Mini Cascades Optimizer

**Goal.** Build a small cost-based optimizer that picks join order and join algorithm.

**Specification.**

1. Implement a Memo, Group, GroupExpr structure as in chapter 08.
2. Implement transformation rules: join commutativity and associativity.
3. Implement implementation rules: HashJoin, SortMergeJoin, NestedLoopJoin.
4. Implement a top-down search with branch-and-bound.
5. Use a simple cost model based on cardinality estimates from Lab 4.
6. Test on a 5-table join with various selectivity profiles.

**Acceptance.**

- Optimizer terminates in under 100 ms on 5-table joins.
- Picks the optimal plan for a chain query, a star query, and a clique query.
- Branch-and-bound prunes at least 50% of group expressions on each query.
- Output a textual plan tree showing chosen operators and estimated costs.

**Stretch goals.**

- Add DPccp for join enumeration when the number of tables exceeds a threshold.
- Add physical property propagation (sort order, partitioning).
- Add an Exchange enforcer for distributed plans.

### Lab 6: Parquet Reader with Predicate Pushdown

**Goal.** Implement a minimal Parquet reader in C++ with row group skipping.

**Specification.**

1. Read the Parquet footer, parse the Thrift-encoded metadata.
2. Decode dictionary pages and data pages for one column at a time.
3. Support PLAIN, DICT, and RLE/BIT_PACKED encodings for INT64.
4. Support Snappy decompression.
5. Implement row group skipping using min/max statistics.
6. Implement page-level skipping using the column index (Parquet 2.6+).
7. Read a 10 GB Parquet file with 100M rows. Apply a selective predicate (`WHERE col > 999000`). Verify that only relevant row groups are read.

**Acceptance.**

- Reader produces correct output bit-for-bit equal to Apache Arrow's reader on the same file.
- Predicate pushdown skips at least 95% of row groups for a 0.1% selective predicate.
- Throughput at least 500 MB/s of input on a single thread.

**Stretch goals.**

- Add Bloom filter support for equality predicates.
- Add async I/O so multiple row groups read in parallel.
- Add support for nested types (LIST, MAP, GROUP).
- Compare your reader's performance to DuckDB's Parquet reader on the same file.

### Submission and Review

Each lab should produce:

- Source code in a public repository with a README explaining the design.
- A benchmark script that produces reproducible numbers on the reviewer's machine.
- A short design document (1-2 pages) explaining the trade-offs you made.

If you do all six labs and write design documents, you have a portfolio that maps directly to senior interview signal. Bring the repos to interviews, walk the interviewer through one of them. The conversation you have looking at your own code is more compelling than any leetcode solution.

### Time Budget

A senior engineer working evenings:

- Lab 1: 1 week.
- Lab 2: 3-4 days.
- Lab 3: 1 week.
- Lab 4: 1 week.
- Lab 5: 1.5 weeks.
- Lab 6: 1.5 weeks.

Total: about 6 weeks of evening work. If you treat it as a Saturday-only project, plan for 3 months.

---
