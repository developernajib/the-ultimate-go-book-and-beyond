## Cost Model Design

A cost-based optimizer scores plans by combining cardinality estimates with per-operator cost formulas, then picks the lowest-cost plan. The cost model is the function from `(plan, stats)` to a scalar. Get it wrong and the optimizer prefers fast-but-wrong plans, slow-but-correct cardinality estimates lose their value.

This chapter covers the components of a real cost model and how to calibrate it.

### What a Cost Represents

Two philosophies compete.

**Time-based cost.** The cost is an estimated wall-clock time in milliseconds. Postgres (since the early days) and Snowflake (internally) use this. Pro: comparable across queries, exposable to users. Con: depends sensitively on hardware, hard to keep calibrated.

**Abstract cost units.** The cost is a unit-less number whose only meaning is comparative. Oracle and DB2 historically used this. Pro: stable across hardware. Con: incomparable across queries, harder to validate.

Modern engines (DuckDB, ClickHouse, CockroachDB, Velox via Presto) use time-based costs. The unit is conventionally microseconds or "row equivalents." We will use microseconds.

### The Four Components

Production cost models combine four resource costs.

```cpp
struct OperatorCost {
    double cpu_us = 0.0;     // CPU microseconds
    double io_us = 0.0;      // disk/SSD microseconds
    double net_us = 0.0;     // network microseconds (distributed)
    double mem_bytes = 0.0;  // peak memory footprint

    double Total() const { return cpu_us + io_us + net_us; }
};
```

**CPU cost.** Per-row work in operators. Constants we have measured on a 2024-era x86 server (Intel Sapphire Rapids, single core):

```cpp
constexpr double kCpuPerRowScan       = 0.005;   // 5 ns / row, sequential scan with no decode
constexpr double kCpuPerRowFilter     = 0.010;   // 10 ns / row, simple predicate
constexpr double kCpuPerRowHash       = 0.020;   // 20 ns / row, build hash key
constexpr double kCpuPerRowProbe      = 0.030;   // 30 ns / row, hash probe with prefetch
constexpr double kCpuPerRowSortCompare = 0.050;  // 50 ns / row pair, sort comparison
constexpr double kCpuPerRowAgg        = 0.040;   // 40 ns / row, hash agg update
```

**I/O cost.** Per-byte cost for reading from storage. Constants:

```cpp
constexpr double kIoPerByteSeqHdd = 0.10e-3;     // 100 MB/s sequential HDD
constexpr double kIoPerByteSeqSsd = 0.001e-3;    // 1 GB/s sequential NVMe
constexpr double kIoPerByteRand   = 0.05;        // 50 us / 4KB random read on NVMe
constexpr double kIoPerByteCache  = 0.0001e-3;   // 10 GB/s page cache hit
```

I/O cost is the dominant cost on cold queries. The ratio of sequential to random I/O on NVMe is around 50x, on HDD 200x. The optimizer must respect this when choosing index nested-loop vs hash join.

**Network cost.** Per-byte cost for inter-node data transfer. Constants:

```cpp
constexpr double kNetPerByteIntraDc = 0.01e-3;   // 100 MB/s effective per shard
constexpr double kNetPerByteCrossDc = 0.5e-3;    // 2 MB/s after latency amortization
constexpr double kNetSetupUs        = 100.0;     // 100 us per RPC setup
```

**Memory cost.** Most engines do not include memory in the cost scalar but track it as a constraint. The optimizer rejects plans whose peak memory exceeds budget. DuckDB tracks memory separately and falls back to spilling rather than rejecting. Snowflake bills memory as a separate cost dimension.

### Costing Specific Operators

Let R be the input row count, b the average row bytes.

**Sequential scan.**
```
cpu = R * kCpuPerRowScan
io  = R * b * kIoPerByteSeqSsd
```

**Index scan** (random I/O, one page per matching row in the worst case).
```
cpu = R * kCpuPerRowProbe
io  = R * 4096 * kIoPerByteRand     // assumes 4 KB page, no prefetch
```

The optimizer uses index scan only when expected R is small. The crossover with seq scan is typically around 5% of the table on SSD, lower on HDD.

**Hash join** with build side B and probe side P.
```
cpu_build = B * kCpuPerRowHash
mem       = B * (b_build + 8)      // build row plus pointer
cpu_probe = P * kCpuPerRowProbe
out       = JoinCardinality(B, P)
```

**Sort** of N rows on K bytes.
```
cpu = N * log2(N) * kCpuPerRowSortCompare
mem = N * K
```

When mem exceeds budget, the cost includes external merge sort:
```
spill_io = N * K * 2 / kIoPerByteSeqSsd   // write + read once
```

**Hash aggregation** with N input rows and G groups.
```
cpu = N * kCpuPerRowAgg
mem = G * (key_bytes + state_bytes)
```

If mem exceeds budget, two-phase aggregation kicks in (chapter 11).

### Calibrating Constants

Cost constants must be calibrated to the hardware. A constant tuned on AVX-512 Sapphire Rapids overestimates cost on Graviton 3 by about 1.5x and underestimates on a 2018 Skylake by 0.7x. Two strategies:

**One-time benchmark on install.** Run a fixed set of microbenchmarks, derive constants, store in catalog. Postgres has `pg_test_timing` and similar tools. Run them on every node at install.

**Continuous calibration.** Track actual operator latency from query telemetry. Periodically re-fit constants using least squares against `(cardinality, observed time)` pairs. Snowflake and BigQuery do this on the back-end.

Here is a simple calibrator that fits a linear cost model from observations:

```cpp
#include <cstddef>
#include <vector>

struct Observation { double rows; double time_us; };

// Fit time = a + b * rows by least squares.
struct LinearFit { double intercept; double slope; };

LinearFit FitLinear(const std::vector<Observation>& obs) {
    double sx = 0, sy = 0, sxy = 0, sxx = 0;
    double n = double(obs.size());
    for (auto& o : obs) {
        sx += o.rows; sy += o.time_us;
        sxy += o.rows * o.time_us;
        sxx += o.rows * o.rows;
    }
    double denom = n * sxx - sx * sx;
    double slope = (n * sxy - sx * sy) / denom;
    double intercept = (sy - slope * sx) / n;
    return {intercept, slope};
}
```

The slope becomes `kCpuPerRowFilter` (or whichever operator). The intercept is per-call setup, used for short queries.

### Cost Model Bias

Even with perfect cardinality, cost models systematically err in two directions.

**Bias toward index plans.** The cost formula assumes random I/O at the published latency. In practice, the OS page cache and the storage cache hide most random I/O. Real index scans on hot tables are 10x faster than the formula predicts. Postgres has the `effective_cache_size` parameter to compensate. CockroachDB has range-cache awareness.

**Bias against parallel plans.** The formulas treat parallelism as a linear speedup. In reality, parallel coordination, NUMA, and skew make parallel scans 0.6x to 0.9x of linear. Production optimizers add a parallelization tax (Postgres `parallel_tuple_cost`, DuckDB has internal damping).

The fix is to measure both biases on your workload and apply correction multipliers. CockroachDB documents this internally as "cost model fudge factors."

### Robust Optimization

A plan that wins by 10% in expected cost but loses by 100x in worst-case cost is a bad bet. Robust optimization tries to pick plans that are not catastrophic when cardinality estimates are wrong.

**Plan parametric optimization** (POP). Compute the optimal plan for several cardinality assumptions, pick a plan that is good across the range. Used at SAP HANA.

**Worst-case-bounded plans.** Add a regularization term: `cost(plan) + alpha * worst_case_cost(plan, error_bound)`. Bound the optimizer's exposure to estimation error.

**Adaptive execution.** Pick a plan, monitor actual cardinalities at runtime, switch plans if the estimate was wrong by more than 10x. BigQuery and Snowflake have this. We cover it in chapter 18.

### Putting It Together: A Cost Function

```cpp
struct PlanContext {
    double mem_budget_bytes;
    double parallel_factor = 1.0;  // 1.0 means single-threaded estimate
};

OperatorCost CostHashJoin(double build_rows, double build_bytes,
                          double probe_rows, double probe_bytes,
                          const PlanContext& ctx) {
    OperatorCost c;
    double mem = build_rows * (build_bytes + 8.0);
    bool spill = mem > ctx.mem_budget_bytes;

    c.cpu_us = (build_rows * kCpuPerRowHash + probe_rows * kCpuPerRowProbe)
               / ctx.parallel_factor;
    if (spill) {
        double spill_bytes = (mem - ctx.mem_budget_bytes) * 2.0;  // round trip
        c.io_us = spill_bytes * kIoPerByteSeqSsd;
    }
    c.mem_bytes = std::min(mem, ctx.mem_budget_bytes);
    return c;
}

OperatorCost CostSortMergeJoin(double l_rows, double l_bytes,
                               double r_rows, double r_bytes,
                               const PlanContext& ctx) {
    auto sort_cost = [&](double n, double b) {
        OperatorCost s;
        s.cpu_us = n * std::log2(n) * kCpuPerRowSortCompare / ctx.parallel_factor;
        s.mem_bytes = n * b;
        if (s.mem_bytes > ctx.mem_budget_bytes) {
            s.io_us = n * b * 2.0 * kIoPerByteSeqSsd;
        }
        return s;
    };
    auto sl = sort_cost(l_rows, l_bytes);
    auto sr = sort_cost(r_rows, r_bytes);
    OperatorCost merge;
    merge.cpu_us = (l_rows + r_rows) * kCpuPerRowFilter / ctx.parallel_factor;
    return {sl.cpu_us + sr.cpu_us + merge.cpu_us,
            sl.io_us + sr.io_us,
            0.0,
            std::max(sl.mem_bytes, sr.mem_bytes)};
}
```

The optimizer compares `CostHashJoin(...).Total()` to `CostSortMergeJoin(...).Total()` and picks the smaller. When inputs are pre-sorted (a sort-merge is essentially free of sort cost) the formula reflects that by passing zero sort rows.

### Lessons From Production

Three patterns recur in postmortems of "the optimizer picked a bad plan":

1. **Cost monotonicity violations.** The model says joining R then S then T costs less than R then T then S, but at scale the predicted cost should grow monotonically with intermediate result size. When it does not, search prunes good plans. Defend monotonicity in unit tests.
2. **Constant overflow.** A query with 1e15 estimated rows produces costs that overflow double. Cap inputs to the cost function at sensible bounds.
3. **Threshold cliffs.** A predicate at exactly 5% selectivity flips the plan from index to scan. Customer queries cluster around such cliffs and complain. Smooth the cost function around thresholds.

The next chapter takes the cost function and uses it to drive Cascades search.

---
