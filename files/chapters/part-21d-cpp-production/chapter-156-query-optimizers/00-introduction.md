# Chapter 156: Query Optimizers and Execution Engines in C++

> "The best query is the one you do not run. The second best is the one whose plan you proved cheap before touching a byte.", an anonymous CockroachDB SRE

A query engine is the most performance-sensitive piece of software a database vendor ever ships. Every microsecond spent in the optimizer multiplies across millions of queries per day. Every cache miss in the execution engine is paid for in customer dollars. This is why the engines that win the analytical market (DuckDB, ClickHouse, Velox, Photon, BigQuery's Capacitor, Spanner's distributed executor) are written in C++.

This chapter is for the engineer who already builds query engines and wants the depth that interviewers at the CockroachDB SQL team, the ClickHouse core team, the Snowflake execution group, the BigQuery Dremel team, or the Aurora storage layer will probe for. We will not stop at "vectorized is faster than Volcano." We will write the code, compare the layouts, and look at how Velox, DuckDB, ClickHouse, and Hyper actually solve the problem.

## Why C++ Owns This Space

Three properties of C++ make it the dominant language for analytical engines.

**Cache-conscious memory layout.** A vectorized engine processes batches of 1024 to 4096 values per operator call. Those batches must sit on a single cache line family with predictable stride. C++ gives you control over alignment, padding, and structure layout that Java cannot give without `Unsafe`, that Go cannot give at all (the runtime owns the heap), and that Rust gives but with a borrow checker that fights you when columns alias safely. The DuckDB `Vector` class is a 64-byte aligned structure with a `data_ptr_t` and a validity mask. The ClickHouse `IColumn` hierarchy is similar. Both rely on the C++ ability to put `alignas(64)` on a member and trust the allocator.

**No GC pauses.** A query that scans 100 GB cannot tolerate a stop-the-world pause. Java engines (Presto, Trino, Spark) spend a measurable fraction of their wall time in GC, and the bigger the working set, the worse it gets. Photon, the Databricks vectorized engine, was rewritten from JVM to C++ in part because the JVM allocator could not keep up with the vectorized batch churn. DuckDB, ClickHouse, and Velox never pause.

**JIT code generation.** The Hyper paper (Neumann, 2011) showed that data-centric code generation beats Volcano by 10x. Generating LLVM IR from a query plan and JIT-compiling it produces tight loops with no virtual calls, no boxing, and full register allocation. Doing this from a managed language is possible (Spark Tungsten, Postgres LLVM JIT) but the integration surface with LLVM is most natural from C++. The C++ ORC API, the C++ MCJIT API, and now LLVM ORCv2 are all first-class C++ libraries.

**Memory tightness.** A hash join build side that must fit in 32 GB cannot afford 30% overhead from object headers, GC reachability bits, or interpreter dispatch tables. C++ gives you struct-of-arrays layout where every byte is data. ClickHouse's `HashTable` template stores keys and values inline with no per-entry overhead, packed tighter than `absl::flat_hash_map`.

## The Engines That Define the Field

A senior engineer in this space should be able to compare these systems on the whiteboard.

**DuckDB** is the textbook in code form. Vectorized, MVCC, single-process, embedded. The codebase is small enough (around 400k lines) that a determined engineer can read it end to end. The pipeline executor, the radix-partitioned hash join, and the morsel-driven parallelism are all worth studying. DuckDB explicitly chose vectorization over codegen, betting that LLVM compile time hurts ad-hoc analytical queries more than it helps.

**ClickHouse** is the speed champion for selective filter and aggregation workloads. Its core is the `Block` (a vector of columns) and the `IBlockInputStream` interface (now `Pipe`). The MergeTree storage engine, the LSM-style merge, and the PREWHERE optimization are core differentiators. ClickHouse has aggressive SIMD inner loops and uses CRC32 hardware instructions for hashing.

**Velox** is Meta's unified execution engine, used by Presto C++, Prestissimo, and Spark Gluten. It is a library, not a database. Its `Vector` types (FlatVector, DictionaryVector, ConstantVector, ArrayVector, RowVector) are a teaching example of late-materialization-friendly columnar layout. Velox's expression evaluator uses peeling and CSE on dictionary-encoded inputs.

**Apache Arrow Datafusion** is Rust, but its physical operator design (vectorized, batch-based, partition-aware) is mirrored in the C++ Arrow compute kernels. The Arrow C++ acero engine is the C++ analogue, and reading both side by side teaches you what is essential and what is incidental in the design.

**BigQuery Capacitor and Dremel** define the distributed analytical model. Capacitor is the on-disk format (descendant of ColumnIO, ancestor of Parquet's deeper ideas). Dremel is the multi-level execution tree. The original Dremel paper (2010) and the F1 paper (2013) are required reading.

**Hyper** (the Neumann/Kemper system, now SAP HANA-adjacent) introduced data-centric code generation. The "Efficiently Compiling Efficient Query Plans for Modern Hardware" paper is the most cited query engine paper of the last 15 years.

**Photon** (Databricks) is a vectorized C++ engine that replaced parts of Spark's JVM execution. The Photon paper (SIGMOD 2022) is the cleanest published account of building a vectorized engine that has to coexist with a legacy interpreter.

## What This Chapter Covers

The chapter starts with the front-end (relational algebra, logical plans), walks through the two great families of execution (Volcano iterator and vectorized), then a third (codegen). Then it moves to the optimizer (cardinality, cost, Cascades, join ordering), to specific operators (joins, aggregation, windows), to storage (Parquet, compression, zone maps, late materialization), and finally to distributed execution, adaptive execution, MVCC, and out-of-core spilling.

We close with a 500-line minimal vectorized engine in modern C++ that reads Parquet, runs a hash aggregation, and sorts the result. It is not production. It is the smallest piece of code that exhibits every concept in the chapter.

## Who This Chapter Is For

If you are interviewing for a senior or staff role on a query engine team, this chapter is your reading list condensed. The interview questions section at the end is drawn from real loops at the CockroachDB SQL team, the Snowflake compute team, and the BigQuery execution team. Expect to be asked, in detail, why DuckDB chose vectorization over codegen, why ClickHouse's MergeTree differs from Parquet, and how you would design a cardinality estimator that does not collapse on a 12-way join over correlated columns.

If you are a Go engineer (CockroachDB is Go on top, C++ underneath in some integrations) reading this to bridge into the C++ side, the most important shift is the one you already know from Chapter 151: ownership, memory layout, and the absence of a runtime are not nuisances. They are the reason these engines win.

## Junior to FAANG / Senior at FAANG

A junior engineer asked to "speed up our query engine" reaches for parallelism and a profiler. A senior engineer at FAANG asks: what is the cardinality estimate the optimizer used, what was the actual row count, what was the cost ratio, and what part of the plan is dominated by the scan vs the join vs the aggregate. The senior knows that 80% of "slow query" tickets at a real database company are bad cardinality estimates, not slow operators. This chapter exists to make that intuition mechanical.

---
