## Late Materialization

Early materialization decodes every column for every row up front, then runs operators on full rows. Late materialization decodes only the columns needed for filtering first, computes a position list of qualifying rows, and decodes the remaining columns for those rows only. The savings can be massive when the filter is selective and the table is wide.

This is one of the canonical wins of columnar storage and one of the few techniques that vectorized engines exploit better than codegen ones.

### The C-Store Insight

The C-Store paper (Stonebraker et al., 2005) introduced late materialization formally. The idea: in a column store, decoding the full row up front loses the column store's benefit. Filter on the predicate columns first, get the positions of surviving rows, then read only the projected columns at those positions.

For `SELECT a, b, c, d, e FROM t WHERE x > 100 AND y < 50`, with selectivity 1%:

- **Early materialization** decodes all 7 columns (a, b, c, d, e, x, y) for all rows. ~7 GB read on a 100 GB table with 7 columns of equal width.
- **Late materialization** decodes x and y first (~2 GB), filters to 1% positions (~10M positions), then decodes a, b, c, d, e at those positions (~50 MB random access into 5 GB). Total: ~2.05 GB.

3.4x less I/O for this case, more for sparser predicates and wider tables.

### Position Lists

A position list is a sorted array of row indices that survived the filter. The critical question: how do you decode column values at arbitrary positions efficiently?

For uncompressed dense columns, it is trivial: `column[position]`. For RLE-encoded or dictionary-encoded columns, you need a position-aware decoder that can jump to a specific row.

```cpp
#include <cstdint>
#include <vector>

namespace lm {

struct PositionList {
    std::vector<uint32_t> positions;  // sorted ascending
};

// Decode an RLE-encoded column at given positions.
struct RleRun { int64_t value; uint32_t count; };

void DecodeRleAtPositions(const std::vector<RleRun>& runs,
                          const PositionList& positions,
                          int64_t* out) {
    size_t run_idx = 0;
    uint32_t run_start = 0;
    for (size_t i = 0; i < positions.positions.size(); ++i) {
        uint32_t target = positions.positions[i];
        while (target >= run_start + runs[run_idx].count) {
            run_start += runs[run_idx].count;
            ++run_idx;
        }
        out[i] = runs[run_idx].value;
    }
}

}  // namespace lm
```

The trick: positions are sorted, so the run pointer only moves forward. Total work is O(R + P) where R is run count and P is position count.

For dictionary-encoded columns, position decoding is also fast: `dict[indices[position]]`.

For Parquet pages with RLE/bit-packed encoding, you must decode the page from the start (the encoding is not random-access). The mitigation is page-level statistics: skip pages whose row range does not overlap the position list.

### ClickHouse PREWHERE

ClickHouse has the cleanest production implementation of late materialization. The `PREWHERE` clause separates predicates that should be evaluated before reading the rest of the columns.

```sql
SELECT name, address FROM users
PREWHERE country = 'US' AND age > 30
WHERE last_login > '2025-01-01'
```

The execution:

1. Read the `country` and `age` columns first.
2. Evaluate the PREWHERE predicate, get a position list.
3. Read `last_login` at those positions, evaluate WHERE, narrow further.
4. Read `name` and `address` at the final positions.

ClickHouse's optimizer auto-promotes predicates to PREWHERE when it can prove the savings are worth it. Manual PREWHERE is still useful for queries the optimizer does not handle well.

The implementation in ClickHouse's source: `src/Storages/MergeTree/MergeTreeRangeReader.cpp` is where the PREWHERE filter is applied during reading. The reader has a "filter" state that tracks which rows are still alive after PREWHERE, then applies that filter when reading subsequent columns.

### Vertica Style

Vertica (and its descendants like Apache Hawq) extended late materialization to multi-stage filtering. A query with multiple predicates evaluates them in order of cost, narrowing the position list at each step. The cheapest, most selective predicate goes first.

```cpp
namespace lm {

struct PredicatePlan {
    std::vector<std::function<PositionList(const PositionList&)>> stages;
};

PositionList Execute(const PredicatePlan& plan, size_t total_rows) {
    PositionList p;
    p.positions.reserve(total_rows);
    for (uint32_t i = 0; i < total_rows; ++i) p.positions.push_back(i);
    for (auto& stage : plan.stages) p = stage(p);
    return p;
}

}  // namespace lm
```

The optimizer orders stages by `cost(stage) / selectivity(stage)`. Cheap, selective predicates go first. Expensive, non-selective predicates go last.

### Predicate Evaluation on Encoded Columns

For dictionary-encoded columns, late materialization combines beautifully with predicate evaluation on the encoded representation. Instead of decoding strings and comparing, find the dictionary indices that satisfy the predicate, then filter the index column.

```cpp
namespace lm {

struct DictColumn {
    std::vector<std::string> dict;
    std::vector<uint32_t> indices;
};

PositionList FilterEqual(const DictColumn& col, const std::string& target) {
    // Find target in dict.
    int32_t target_idx = -1;
    for (size_t i = 0; i < col.dict.size(); ++i) {
        if (col.dict[i] == target) { target_idx = static_cast<int32_t>(i); break; }
    }
    PositionList out;
    if (target_idx < 0) return out;
    for (uint32_t i = 0; i < col.indices.size(); ++i) {
        if (col.indices[i] == uint32_t(target_idx)) out.positions.push_back(i);
    }
    return out;
}

}  // namespace lm
```

A single string compare against the dictionary, then integer compares for the rest. 10x to 100x faster than comparing strings per row.

Velox does this for `LowCardinality` columns. ClickHouse does it for `LowCardinality(String)`. Photon does it for short strings.

### When Late Materialization Hurts

Late materialization is not always faster.

**Selective enough to materialize early.** If the position list is dense (say 50% selectivity), the position-aware decoder may be slower than just decoding everything densely. The break-even is workload-specific but typically around 10-20% selectivity.

**Random access patterns hurt.** Reading 1% of rows at scattered positions involves many random I/O operations on cold data. The aggregate I/O may exceed sequential I/O of the full column. Modern storage (NVMe with prefetching) reduces this gap.

**Compression schemes that resist random access.** Pure LZ4-compressed columns must be decompressed in full. Late materialization with random access requires decompressing whole pages anyway.

The optimizer must estimate selectivity well to decide. Bad estimates lead to wrong materialization choices. This is yet another place where cardinality estimation matters.

### Decode-on-Demand

A stronger version of late materialization: never materialize a column eagerly. Operators that consume a column trigger its decode only when they need values. Velox's `LazyVector` is this design.

```cpp
namespace lm {

class LazyVector {
    std::function<std::vector<int64_t>(const PositionList&)> decoder_;
    PositionList positions_;
    mutable std::vector<int64_t> materialized_;
    mutable bool ready_ = false;

public:
    LazyVector(std::function<std::vector<int64_t>(const PositionList&)> d,
               PositionList p) : decoder_(std::move(d)), positions_(std::move(p)) {}

    const std::vector<int64_t>& Materialize() const {
        if (!ready_) {
            materialized_ = decoder_(positions_);
            ready_ = true;
        }
        return materialized_;
    }
};

}  // namespace lm
```

When a join probe operator wants the join key, it materializes only that. When the projection operator wants a column for output, it materializes only that. Columns that turn out not to be needed (because of an upstream filter or limit) are never decoded.

Velox uses this aggressively. The result is a 2x speedup on TPC-H queries with wide select lists where most columns are filtered away.

### Position Encoding for Joins

A hash join in late-materialization style emits `(left_position, right_position)` pairs instead of full materialized rows. The downstream operators then materialize only the columns needed.

```cpp
namespace lm {

struct JoinPosition { uint32_t left_pos; uint32_t right_pos; };

}  // namespace lm
```

This is "operator-at-a-time" applied to materialization decisions. DuckDB uses this internally for join chains: a 5-table join produces position lists threaded through the joins, and final projection materializes the required columns from each table at the surviving positions.

### Summary of the Late Materialization Toolkit

1. **Position lists** as the data structure that flows between operators.
2. **Position-aware decoders** for compressed columns.
3. **Predicate evaluation on dictionary indexes** for low-cardinality columns.
4. **Stage ordering by cost/selectivity** in the optimizer.
5. **Lazy vectors** to defer decode until consumed.
6. **PREWHERE syntax** as user-controllable hint for predicate ordering.

The break-even with early materialization is around 10% selectivity for typical workloads. Below that, late wins decisively. Above, the position-list bookkeeping overhead can outweigh savings.

The next chapter scales up from single-node to distributed query execution.

---
