## Window Functions

Window functions compute aggregates over a frame of rows relative to each row, without collapsing the result. `SUM(x) OVER (PARTITION BY p ORDER BY t ROWS BETWEEN 5 PRECEDING AND CURRENT ROW)` produces one output per input row, summing the previous 5 plus the current. Implementing this efficiently is non-trivial.

### Frame Definitions

SQL defines three frame modes.

**ROWS**: physical row offsets. `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW` is a window of 3 physical rows.

**RANGE**: logical value ranges on the ORDER BY column. `RANGE BETWEEN INTERVAL '1 day' PRECEDING AND CURRENT ROW` includes all rows whose ORDER BY value is within 1 day before the current row.

**GROUPS**: peer groups by ORDER BY value. `GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW` includes the previous peer group plus the current.

Each frame mode has different boundary semantics. The C++ implementation must dispatch on mode and on whether each boundary is `UNBOUNDED PRECEDING`, `n PRECEDING`, `CURRENT ROW`, `n FOLLOWING`, or `UNBOUNDED FOLLOWING`.

### The Naive Algorithm

Sort by partition then by order. For each row, scan its frame, accumulate the aggregate.

```cpp
#include <algorithm>
#include <cstdint>
#include <vector>

namespace win {

struct Row { int64_t partition; int64_t order_key; int64_t value; };

void NaiveSumWindow(std::vector<Row>& rows, int frame_lo, int frame_hi,
                    std::vector<int64_t>& out) {
    std::sort(rows.begin(), rows.end(), [](auto& a, auto& b) {
        return std::tie(a.partition, a.order_key) < std::tie(b.partition, b.order_key);
    });
    out.resize(rows.size());
    for (size_t i = 0; i < rows.size(); ++i) {
        int64_t sum = 0;
        size_t lo = (i + frame_lo > 0) ? (i + frame_lo) : 0;
        size_t hi = std::min(i + frame_hi + 1, rows.size());
        // Same partition only.
        while (lo < hi && rows[lo].partition < rows[i].partition) ++lo;
        size_t hi_p = lo;
        while (hi_p < hi && rows[hi_p].partition == rows[i].partition) ++hi_p;
        for (size_t j = lo; j < hi_p; ++j) sum += rows[j].value;
        out[i] = sum;
    }
}

}  // namespace win
```

For frame size F over N rows, this is O(N * F). For unbounded frames, it is O(N^2). Production needs better.

### Sliding Window for Invertible Aggregates

For aggregates like SUM, COUNT, AVG that have an inverse, you can maintain a running sum: add the row entering the frame, subtract the row leaving. This is O(N) total.

```cpp
namespace win {

void SlidingSum(const std::vector<Row>& rows, int frame_lo, int frame_hi,
                std::vector<int64_t>& out) {
    out.resize(rows.size());
    int64_t sum = 0;
    size_t lo = 0, hi = 0;
    for (size_t i = 0; i < rows.size(); ++i) {
        // Reset on partition boundary.
        if (i > 0 && rows[i].partition != rows[i - 1].partition) {
            sum = 0; lo = i; hi = i;
        }
        size_t want_lo = (i + frame_lo > 0) ? (i + frame_lo) : 0;
        size_t want_hi = std::min(i + frame_hi + 1, rows.size());
        // Cap to partition boundary.
        while (want_hi < rows.size() && rows[want_hi].partition != rows[i].partition && want_hi > i)
            --want_hi;

        while (hi < want_hi) sum += rows[hi++].value;
        while (lo < want_lo) sum -= rows[lo++].value;
        out[i] = sum;
    }
}

}  // namespace win
```

Postgres, DuckDB, and ClickHouse use sliding aggregation for SUM, COUNT, AVG. For MIN and MAX, sliding does not work directly because subtraction is undefined. The fix is monotonic deques.

### Monotonic Deque for MIN/MAX

Maintain a deque of candidate minimums in increasing order. On entry: pop from back while the back is greater than the new value, push the new value. On exit: pop from front if the front index is the leaving row.

```cpp
#include <deque>

namespace win {

void SlidingMin(const std::vector<Row>& rows, int frame_lo, int frame_hi,
                std::vector<int64_t>& out) {
    out.resize(rows.size());
    std::deque<size_t> mins;  // indices, ascending values
    size_t lo = 0, hi = 0;
    for (size_t i = 0; i < rows.size(); ++i) {
        if (i > 0 && rows[i].partition != rows[i-1].partition) {
            mins.clear(); lo = i; hi = i;
        }
        size_t want_lo = (i + frame_lo > 0) ? (i + frame_lo) : 0;
        size_t want_hi = std::min(i + frame_hi + 1, rows.size());
        while (hi < want_hi) {
            while (!mins.empty() && rows[mins.back()].value >= rows[hi].value)
                mins.pop_back();
            mins.push_back(hi);
            ++hi;
        }
        while (!mins.empty() && mins.front() < want_lo) mins.pop_front();
        lo = want_lo;
        out[i] = rows[mins.front()].value;
    }
}

}  // namespace win
```

This is O(N) amortized: each row enters and leaves the deque at most once.

### Segment Tree for Arbitrary Aggregates

For aggregates that are not invertible and not amenable to monotonic structures (median, mode, percentile, custom UDF), use a segment tree. Build a tree where each node is the aggregate over a contiguous range. Querying any range is O(log N). Updates (in non-streaming windows) are also O(log N).

```cpp
namespace win {

template <typename T, typename Combine>
class SegmentTree {
    std::vector<T> tree_;
    size_t n_;
    Combine combine_;
    T identity_;

public:
    SegmentTree(const std::vector<T>& data, Combine c, T identity)
        : n_(data.size()), combine_(c), identity_(identity) {
        size_t cap = std::bit_ceil(n_);
        tree_.assign(2 * cap, identity);
        for (size_t i = 0; i < n_; ++i) tree_[cap + i] = data[i];
        for (size_t i = cap - 1; i > 0; --i)
            tree_[i] = combine_(tree_[2*i], tree_[2*i+1]);
    }

    T Query(size_t l, size_t r) const {  // [l, r)
        size_t cap = tree_.size() / 2;
        l += cap; r += cap;
        T res = identity_;
        while (l < r) {
            if (l & 1) res = combine_(res, tree_[l++]);
            if (r & 1) res = combine_(res, tree_[--r]);
            l >>= 1; r >>= 1;
        }
        return res;
    }
};

}  // namespace win
```

DuckDB uses segment trees for non-invertible window aggregates. ClickHouse has segment-tree-like structures for some aggregate functions. For ranking functions (ROW_NUMBER, RANK, DENSE_RANK), the implementation is even simpler: a counter that resets on partition boundaries.

### RANGE Frames Need Binary Search

For RANGE frames, the boundary depends on the ORDER BY value, not the row index. To find the frame, binary search the sorted partition for the first row whose order_key >= current_order_key + lo and the first whose order_key > current_order_key + hi.

```cpp
namespace win {

size_t LowerBoundInPartition(const std::vector<Row>& rows, size_t partition_start,
                             size_t partition_end, int64_t target) {
    return std::lower_bound(rows.begin() + partition_start,
                            rows.begin() + partition_end,
                            target,
                            [](const Row& r, int64_t v) { return r.order_key < v; })
           - rows.begin();
}

}  // namespace win
```

Per row, binary search is O(log P) where P is the partition size. Total O(N log P). Acceptable for most workloads.

### Partition Detection and Sort

Window functions require sorted input within each partition. The optimizer inserts a sort if necessary. If the input is already sorted (the storage is clustered or a previous sort happens to satisfy the requirement), the sort is skipped.

In a parallel engine, partitioning is done by hash on the PARTITION BY keys, then each partition's rows are sorted on its node. Spark and Photon do this. DuckDB does it on a single node with multiple threads, exchanging partitions via a hash distribution.

### Multiple Window Specs

A query can have multiple OVER clauses with different specs:

```sql
SELECT
  SUM(x) OVER (PARTITION BY a ORDER BY t),
  AVG(y) OVER (PARTITION BY b ORDER BY t)
FROM data
```

The naive plan sorts the data twice (once per partition spec) and runs two window operators. The optimizer can sometimes share sorts when the partition-and-order keys are compatible. SQL Server has aggressive sort sharing. Postgres has limited sort sharing. DuckDB shares when possible.

### Performance in Production

A vectorized window operator with sliding aggregation runs at roughly 200-500 MB/s per core for SUM-style aggregates, 100-200 MB/s for MIN/MAX (deque overhead), and 30-100 MB/s for segment-tree aggregates (cache misses on the tree). The dominant cost is usually the sort, not the window itself.

Compile-time codegen helps for hot windows: ClickHouse and DuckDB both special-case ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW (the "running sum" pattern) with a tight inline loop.

### What to Read

- Leis et al., "Efficient Processing of Window Functions in Analytical SQL Queries," VLDB 2015.
- DuckDB's `src/execution/operator/aggregate/physical_window.cpp`.
- ClickHouse's `src/Processors/Transforms/WindowTransform.cpp`.

The next chapter changes from execution to storage layout: Parquet, ORC, and MergeTree.

---
