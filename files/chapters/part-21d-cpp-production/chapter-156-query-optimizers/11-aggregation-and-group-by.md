## Aggregation and Group By

`GROUP BY` is the second most expensive operator after join. A query that aggregates 10 billion rows into 100 thousand groups must process every input row but only emits 100K. The throughput is bound by hash table probe rate, not by group count. Modern engines push this to 1-3 GB/s per core.

### The Hash Aggregation Algorithm

Walk every input row, compute the group key, look up or insert into a hash table, update the aggregate state.

```cpp
#include <cstdint>
#include <cstring>
#include <vector>
#include <bit>

namespace agg {

struct AggState { int64_t sum = 0; uint64_t count = 0; };

class HashAggregate {
    struct Slot {
        int64_t key;
        AggState state;
        bool occupied;
    };

    std::vector<Slot> slots_;
    uint64_t mask_;
    size_t count_ = 0;

public:
    void Init(size_t cap) {
        cap = std::bit_ceil(std::max<size_t>(16, cap));
        slots_.assign(cap, {0, {}, false});
        mask_ = cap - 1;
    }

    void Update(int64_t key, int64_t value) {
        uint64_t h = Hash(key) & mask_;
        // Linear probe.
        while (slots_[h].occupied) {
            if (slots_[h].key == key) {
                slots_[h].state.sum += value;
                slots_[h].state.count++;
                return;
            }
            h = (h + 1) & mask_;
        }
        slots_[h] = {key, {value, 1}, true};
        ++count_;
        // Resize at 75% load.
        if (count_ * 4 > slots_.size() * 3) Resize();
    }

    void Resize() {
        std::vector<Slot> old = std::move(slots_);
        Init(old.size() * 2);
        count_ = 0;
        for (auto& s : old) if (s.occupied) Update(s.key, s.state.sum);
    }

    static uint64_t Hash(int64_t k) {
        uint64_t x = static_cast<uint64_t>(k) * 0x9E3779B97F4A7C15ULL;
        return x ^ (x >> 32);
    }

    template <typename Emit>
    void Drain(Emit emit) {
        for (auto& s : slots_) if (s.occupied) emit(s.key, s.state);
    }
};

}  // namespace agg
```

Linear probing with power-of-two capacity is the same recipe as the hash join. The differences:

- Slots store aggregate state, not pointers to rows.
- Resize must be cheap because grows are common as group count rises.
- Emit happens once at the end, not per row.

### Vectorized Aggregation

The per-row hash table update has high per-call overhead. A vectorized version computes hashes for a batch, looks up all slots, then updates in a tight loop.

```cpp
namespace agg {

void VectorizedUpdate(HashAggregate& ht,
                      const int64_t* keys, const int64_t* values, size_t n) {
    constexpr size_t kBatch = 256;
    alignas(64) uint64_t hashes[kBatch];
    alignas(64) uint32_t slots[kBatch];

    for (size_t base = 0; base < n; base += kBatch) {
        size_t this_batch = std::min(kBatch, n - base);

        // Step 1: hash the whole batch.
        for (size_t i = 0; i < this_batch; ++i) {
            hashes[i] = HashAggregate::Hash(keys[base + i]);
        }

        // Step 2: prefetch slots.
        for (size_t i = 0; i < this_batch; ++i) {
            __builtin_prefetch(reinterpret_cast<const char*>(/* slot pointer */));
        }

        // Step 3: probe and update.
        for (size_t i = 0; i < this_batch; ++i) {
            ht.Update(keys[base + i], values[base + i]);
        }
    }
}

}  // namespace agg
```

DuckDB takes this further with "perfect hashing" for low-cardinality groups: when the group count is small (under 256 distinct values), the engine builds a direct array indexed by group ID, avoiding hashing entirely. ClickHouse has similar specializations (`AggregationMethodOneNumber`, `AggregationMethodKeysFixed`).

### Two-Phase Aggregation

When parallelism is involved, hash aggregation has two natural shapes.

**One-phase (partitioned).** Partition input by hash on group key, route each partition to a worker, each worker builds a private hash table. No final merge needed. Best when group count is large (each partition produces distinct groups).

**Two-phase (combine).** Each worker builds a partial hash table over its slice of input. A second phase merges partials. Best when group count is small (the merge is cheap and the partial tables avoid coordination).

```cpp
namespace agg {

class TwoPhaseAgg {
    std::vector<HashAggregate> partials_;
    HashAggregate final_;

public:
    void StartWorkers(size_t num_workers) {
        partials_.resize(num_workers);
        for (auto& p : partials_) p.Init(1024);
    }

    void Worker(size_t id, const int64_t* keys, const int64_t* values, size_t n) {
        VectorizedUpdate(partials_[id], keys, values, n);
    }

    void Combine() {
        final_.Init(1024);
        for (auto& p : partials_) {
            p.Drain([&](int64_t k, const AggState& s) {
                // Merge: add s into final[k].
                final_.Update(k, s.sum);
                // Real impl would also accumulate count.
            });
        }
    }
};

}  // namespace agg
```

The optimizer chooses between one-phase and two-phase based on the cardinality estimate. If estimated NDV of the group key is below sqrt(input rows), two-phase wins. Above that, partitioned wins. CockroachDB and DuckDB both implement this choice.

### Approximate Aggregates

Production analytical workloads often want fast approximate answers more than slow exact ones.

**APPROX_COUNT_DISTINCT** uses HyperLogLog (chapter 06). 16 KB state, 1% error.

**APPROX_PERCENTILE** uses t-digest. 1 KB state, sub-percent error on tail percentiles.

**APPROX_TOP_K** uses Misra-Gries or the Space-Saving algorithm. Constant memory per K.

```cpp
namespace agg {

class HyperLogLogAggState {
    static constexpr int kReg = 16384;
    uint8_t r[kReg] = {};
public:
    void Add(uint64_t hash) {
        uint32_t b = hash & (kReg - 1);
        uint8_t lz = static_cast<uint8_t>(std::countl_zero(hash >> 14)) + 1;
        if (lz > r[b]) r[b] = lz;
    }
    void Merge(const HyperLogLogAggState& o) {
        for (int i = 0; i < kReg; ++i) if (o.r[i] > r[i]) r[i] = o.r[i];
    }
    double Estimate() const {
        double sum = 0; int z = 0;
        for (int i = 0; i < kReg; ++i) { sum += std::ldexp(1.0, -r[i]); if (!r[i]) ++z; }
        double e = 0.7213 * kReg * kReg / sum / (1 + 1.079 / kReg);
        if (e <= 2.5 * kReg && z) return kReg * std::log(double(kReg) / z);
        return e;
    }
};

}  // namespace agg
```

ClickHouse, Druid, and Pinot expose these as first-class aggregate functions. Snowflake and BigQuery have them. DuckDB has `approx_count_distinct` and `approx_quantile`.

### Spilling Hash Tables

When the hash table grows beyond memory budget, you have to spill. The strategy:

1. Partition the input by hash (like grace hash join).
2. Aggregate each partition independently in memory.
3. If a partition still does not fit, recursively partition.

The partition function is `(hash >> 32) & (kPartitions - 1)`, leaving the lower bits for in-memory probing. DuckDB's "external aggregation" uses this exact pattern.

### ART Trie for String Group Keys

For string group keys, the hash table key compare is a memcmp that stalls the probe pipeline. The Adaptive Radix Tree (Leis et al., 2013) can outperform hash tables when keys share long prefixes.

The ART node types adapt to fanout: Node4 (up to 4 children, linear array search), Node16 (16, sorted with binary search), Node48 (48, indexed by byte), Node256 (256, direct array). Hyper, DuckDB, and several other engines use ART for string-keyed group by and indexes.

The implementation is complex (1500+ lines of C++) and outside the scope of this chapter. Read DuckDB's `src/execution/index/art/` for a production reference.

### DISTINCT and Group By

`SELECT DISTINCT a, b FROM t` is `SELECT a, b FROM t GROUP BY a, b` with no aggregates. The same hash table works. DuckDB and ClickHouse rewrite DISTINCT to GROUP BY in the optimizer.

`COUNT(DISTINCT x)` is harder. The naive plan is two-phase: outer GROUP BY, inner DISTINCT. The optimizer can transform it into:

- A single hash table with `(group_key, x)` composite keys, then count entries per group.
- Streaming with HyperLogLog per group (approximate).

The right choice depends on group cardinality.

### ROLLUP, CUBE, and GROUPING SETS

`GROUP BY ROLLUP(a, b, c)` produces results for `(a, b, c)`, `(a, b)`, `(a)`, `()`. The naive plan runs four separate aggregations. The optimizer rewrites this into a single scan with a "grouping set" expansion: for each input row, emit four (key, value) pairs with different masks.

```cpp
// Rough sketch of grouping set expansion.
namespace agg {

struct GroupingSet { uint64_t mask; };  // bit per group key

void EmitForGroupingSets(const int64_t* keys, size_t k, int64_t value,
                         const std::vector<GroupingSet>& sets,
                         HashAggregate& agg) {
    for (auto& s : sets) {
        // Compute composite key from keys and mask, update aggregate.
        int64_t composite = 0;
        for (size_t i = 0; i < k; ++i) {
            if (s.mask & (1ULL << i)) composite ^= keys[i] * (i + 1);
        }
        composite ^= s.mask;  // distinguish different sets
        agg.Update(composite, value);
    }
}

}  // namespace agg
```

Postgres and DuckDB implement ROLLUP this way. ClickHouse has `WITH ROLLUP` and `WITH CUBE`. The expansion factor is the size of the grouping set, so a 4-way ROLLUP multiplies row count by 5.

### What Production Engines Do

- **DuckDB**: vectorized hash agg with radix partitioning, ART for string keys, perfect hashing for small NDV.
- **ClickHouse**: 30+ specialized hash table classes in `src/AggregateFunctions/` and `src/Interpreters/AggregationCommon.h`. Two-phase by default.
- **Velox**: prefix-sum based vectorized agg, integrates with Velox's HashTable that backs both joins and aggregations.
- **Spark/Photon**: columnar hash agg with code generation for the inner loop, two-phase mandatory.

The next chapter covers the operator that requires more bookkeeping than any other: window functions.

---
