## Modern Query Engine References

This chapter is a reading list, not for the original literature (papers were cited in earlier chapters), but for the production code. If you want to learn how a real query engine looks in 2026, the fastest path is to read these projects with the right pointers.

### DuckDB

Repository: `https://github.com/duckdb/duckdb`. Roughly 400K lines of C++17.

DuckDB is the reference implementation for vectorized analytical engines. Single-process, embedded, MVCC, columnar. The codebase is unusually approachable: a small team writes most of it, the style is consistent, and the test coverage is excellent.

Key directories to read in order:

- `src/include/duckdb/common/types/vector.hpp` and `vector.cpp`. The Vector class with flat, constant, dictionary, and sequence representations.
- `src/execution/operator/`. Every physical operator. Start with `physical_filter.cpp` (simple), then `physical_hash_aggregate.cpp` (vectorized agg), then `physical_hash_join.cpp` (radix-partitioned hash join).
- `src/include/duckdb/execution/index/art/`. Adaptive Radix Tree implementation.
- `src/optimizer/`. The optimizer rules. Predicate pushdown, projection pushdown, join order optimization.
- `src/planner/binder/`. SQL semantic analysis and logical plan construction.
- `src/parallel/`. Morsel-driven parallel execution. The DuckDB scheduler.

Notable design decisions:

1. **Vectorization over codegen.** DuckDB chose vectors and stuck with it. The blog post "DuckDB: A Modern Embedded Analytical Database" explains why.
2. **Pipeline executor.** Operators are pull-based but coordinated by a pipeline executor that handles parallelism and morsel scheduling. See `src/parallel/pipeline.cpp`.
3. **Storage in single file.** The DuckDB file format is described in `src/storage/`. Read-mostly with WAL for writes.

### ClickHouse

Repository: `https://github.com/ClickHouse/ClickHouse`. Roughly 800K lines of C++20.

ClickHouse is the speed champion for analytical workloads with high selectivity. Aggressive SIMD, lots of specialized types (`LowCardinality`, `Sparse`, `Nullable`), and the MergeTree LSM-style storage.

Key directories:

- `src/Columns/`. Column hierarchy. `IColumn.h` is the base. Read `ColumnVector.h`, `ColumnString.h`, `ColumnLowCardinality.h`, `ColumnSparse.h`.
- `src/DataTypes/`. Type system parallel to columns.
- `src/AggregateFunctions/`. Specialized aggregate state types. The `IAggregateFunction.h` base class is small but the implementations (`AggregateFunctionSum.h`, `AggregateFunctionUniq.h`) are where the speed comes from.
- `src/Processors/`. Pipeline executor. ClickHouse moved from `IBlockInputStream` (older) to `IProcessor`-based pipelines. `Pipe.h` is the modern interface.
- `src/Storages/MergeTree/`. The MergeTree storage engine. `MergeTreeData.cpp`, `MergeTreeDataPartWide.cpp`, `KeyCondition.cpp` (predicate analysis).
- `src/Interpreters/HashJoin.cpp` and `HashJoinKeyMethods.h`. Eight-plus specializations of hash join based on key types.
- `src/Storages/MergeTree/MergeTreeIndexBloomFilter.cpp` and `MergeTreeIndexSet.cpp`. Skipping indexes.

Notable design decisions:

1. **Specialization over generality.** ClickHouse has many narrow types (`LowCardinality`, `Sparse`) and many specialized hash tables. The result is faster but the codebase is larger.
2. **CRC32 hardware hashing.** `ClickHouse::CityHash64` uses SSE 4.2 CRC32 instructions where available.
3. **MergeTree LSM.** Inserts create parts, background merges compact them. `MergeTreeData::merge` is the merge engine.
4. **PREWHERE optimization.** `MergeTreeRangeReader.cpp` shows how PREWHERE filters propagate position lists.

### Velox

Repository: `https://github.com/facebookincubator/velox`. Roughly 250K lines of C++20.

Velox is Meta's unified execution library. It is not a database. It is the C++ engine that powers Presto C++ (Prestissimo), Spark Gluten, and several internal Meta query engines.

Key directories:

- `velox/vector/`. Vector hierarchy. `BaseVector.h` and the FlatVector, ConstantVector, DictionaryVector, ArrayVector, MapVector, RowVector, LazyVector classes. Read this first.
- `velox/expression/`. Expression evaluator with peeling and CSE. `Expr.cpp` is the heart.
- `velox/exec/`. Operators. `HashTable.h`, `HashJoin.cpp`, `HashAggregation.cpp`, `Window.cpp`.
- `velox/dwio/`. Reader infrastructure for Parquet, ORC, DWRF, and Nimble. Velox can read everything.
- `velox/connectors/hive/`. The Hive (and Iceberg) connector. Where Presto-style queries hit storage.

Notable design decisions:

1. **Vector hierarchy with lazy materialization.** `LazyVector` defers decode until consumed. The expression evaluator can peel dictionary encoding through projections.
2. **Library, not database.** Velox does not have a query coordinator, parser, or storage. It is the executor library that other systems plug in.
3. **Unified hash table.** `HashTable` is used for both join build sides and aggregation. Specialized for many key shapes.

### Apache Arrow Acero (C++ Compute Engine)

Repository: `https://github.com/apache/arrow`. The C++ engine is in `cpp/src/arrow/acero/` and `cpp/src/arrow/compute/`.

Acero is the C++ analogue of Datafusion. It is built on Arrow's columnar format, so any Arrow-compatible system can use it. Less mature than DuckDB or Velox but architecturally clean.

Key files:

- `cpp/src/arrow/compute/exec/` (older path) or `cpp/src/arrow/acero/` (newer): operator implementations.
- `cpp/src/arrow/compute/kernels/`: vectorized kernel registry. Hundreds of typed kernels.

Notable design decisions:

1. **Kernel registry.** Every typed operation (add_int64, equal_string, etc.) is a kernel registered at startup. Dispatch is by type tags.
2. **Builds on Arrow.** Zero-copy interchange with any Arrow consumer. Real strength.

### Polars C++ Side

Polars is mostly Rust, but the storage and some kernels are in C++ via Apache Arrow C++. The Rust query engine is itself worth reading (`https://github.com/pola-rs/polars`).

Polars is interesting because it shows what a vectorized engine looks like with a different language model. Many of the same patterns (vectors, predicate pushdown, hash join) but with Rust's borrow checker shaping the API.

### Photon (Databricks)

Photon is closed source. The SIGMOD 2022 paper is the public document: "Photon: A Fast Query Engine for Lakehouse Systems."

Key takeaways from the paper:

- Vectorized C++ replacing JVM Spark for hot operators.
- Selective rewrite: not every query goes to Photon. The Catalyst optimizer chooses.
- Adaptive at runtime: vectorized vs row, broadcast vs shuffle, decided per batch.
- Spilling is fundamental: lakehouse data is large.

Read the paper if you are designing a hybrid engine where a legacy executor must coexist with a new C++ executor.

### CockroachDB SQL Layer

Repository: `https://github.com/cockroachdb/cockroach`. The SQL layer is Go, but the architecture is worth studying.

Key directories:

- `pkg/sql/opt/`. The Cascades-style optimizer. Memo, group, transformation rules.
- `pkg/sql/colexec/`. Vectorized executor. CockroachDB has both row and vectorized executors.
- `pkg/sql/colflow/`. Pipeline scheduling.

Notable design decisions:

1. **Optgen.** Rules are written in a declarative DSL (`optgen`) that generates Go code. This is one of the few production-quality rule engines that is documented.
2. **Distributed by default.** Every plan is potentially distributed. The optimizer adds exchanges for transactional consistency across ranges.
3. **MVCC at the storage layer.** The query layer respects snapshot timestamps.

### Apache Calcite

Repository: `https://github.com/apache/calcite`. Java, not C++, but the optimizer architecture is the textbook reference.

Read `core/src/main/java/org/apache/calcite/plan/volcano/`. The `VolcanoPlanner`, `RelSet`, `RelSubset` classes are the canonical Cascades implementation in production code.

Calcite is used as a planner by Apache Drill, Apache Hive, Apache Flink, and many proprietary systems. If you understand Calcite, you understand Cascades.

### Hyper / Umbra

Hyper is now part of Tableau / Salesforce. The codebase is closed source. Umbra is the academic successor at TUM, also closed source.

The papers are public:

- Neumann, "Efficiently Compiling Efficient Query Plans for Modern Hardware," VLDB 2011.
- Kohn, Leis, Neumann, "Adaptive Execution of Compiled Queries," ICDE 2018.
- Leis et al., "Morsel-Driven Parallelism: A NUMA-Aware Query Evaluation Framework for the Many-Core Age," SIGMOD 2014.

The morsel-driven parallelism paper is required reading for anyone building a multi-threaded engine. DuckDB's parallel scheduler is directly inspired by it.

### What to Read in What Order

If you have a week to learn modern query engines deeply:

1. Day 1-2: Read DuckDB's vector and operator code. Run queries, set breakpoints in `physical_hash_aggregate.cpp`.
2. Day 3: Read ClickHouse's `IColumn`, `Block`, and one operator (`HashJoin.cpp`). Compare to DuckDB.
3. Day 4: Read Velox's `BaseVector` hierarchy and `HashTable`. Note the lazy materialization pattern.
4. Day 5: Read Calcite's Volcano planner. Understand the memo, the group, the rule registry.
5. Day 6: Read the Hyper paper, the morsel paper, and the Photon paper.
6. Day 7: Pick one engine and implement a small new operator (a window function, a new aggregate). Send a PR.

Six months of doing this will get you to interview level for any C++ query engine team in 2026.

### Forums and Discussions

- DuckDB has a public Discord and a quite active discussion forum.
- ClickHouse has English and Russian Slack channels.
- Velox holds occasional public design reviews on GitHub Discussions.
- The CIDR conference (Conference on Innovative Data Systems Research) is the venue for new query engine ideas. CIDR proceedings are open access.

The next chapter compresses what you have read into 15 deep interview questions.

---
