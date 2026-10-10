## Join Algorithms

Once the optimizer has fixed the join order, each binary join needs an algorithm. The choice between hash join, sort-merge join, and nested-loop join can change query latency by 100x. This chapter is the implementation reference.

### Hash Join

The default for equi-joins on unsorted inputs. Two phases: build a hash table on one side (the smaller, called the "build side"), then probe with the other side ("probe side").

```cpp
#include <bit>
#include <cstdint>
#include <cstring>
#include <vector>

namespace hj {

struct Row { int64_t key; int64_t payload; };

class HashTable {
    struct Entry {
        int64_t key;
        uint32_t row_id;     // index into materialized rows
        uint32_t next;       // chained collision (~0u = end)
    };

    std::vector<uint32_t> buckets_;   // head pointers
    std::vector<Entry> entries_;
    std::vector<Row> rows_;
    uint64_t mask_;

public:
    void Build(const Row* in, size_t n) {
        size_t cap = std::bit_ceil(std::max<size_t>(16, n * 2));
        buckets_.assign(cap, ~0u);
        mask_ = cap - 1;
        entries_.reserve(n);
        rows_.reserve(n);
        for (size_t i = 0; i < n; ++i) {
            uint32_t row_id = static_cast<uint32_t>(rows_.size());
            rows_.push_back(in[i]);
            uint64_t h = Hash(in[i].key) & mask_;
            entries_.push_back({in[i].key, row_id, buckets_[h]});
            buckets_[h] = static_cast<uint32_t>(entries_.size() - 1);
        }
    }

    template <typename Emit>
    void Probe(const Row* in, size_t n, Emit emit) const {
        // Two-pass with prefetch.
        constexpr size_t kPF = 16;
        for (size_t i = 0; i < n; ++i) {
            if (i + kPF < n) {
                uint64_t hpf = Hash(in[i + kPF].key) & mask_;
                __builtin_prefetch(&buckets_[hpf], 0, 0);
            }
            uint64_t h = Hash(in[i].key) & mask_;
            for (uint32_t e = buckets_[h]; e != ~0u; e = entries_[e].next) {
                if (entries_[e].key == in[i].key) {
                    emit(in[i], rows_[entries_[e].row_id]);
                }
            }
        }
    }

    static uint64_t Hash(int64_t k) {
        uint64_t x = static_cast<uint64_t>(k) * 0x9E3779B97F4A7C15ULL;
        x ^= x >> 32;
        return x;
    }
};

}  // namespace hj
```

The chaining structure (entries with a `next` pointer) handles collisions cleanly. The alternative is open addressing (linear probing), which is more cache-friendly for low load factors but harder to use when the same key appears multiple times.

DuckDB uses a layout called "JoinHashTable" with a power-of-two-sized hash table and chaining. ClickHouse uses several variants depending on key type (HashJoin.cpp has 8+ specializations). Velox uses linear probing with a 64-bit fingerprint check before the full key compare.

#### Choosing the Build Side

Always build on the smaller side. The build is more expensive per row than probe, but the table size dominates memory. A 1-million-row build with a 1-billion-row probe is the right choice. The opposite blows out memory.

If sizes are unknown (no statistics), engines default to build-on-right and let the planner decide. CockroachDB's optimizer flips this based on cardinality estimates.

#### Bloom Filter on the Build Side

Building a Bloom filter on the build keys lets the probe side skip rows that cannot match. For selective joins (most probe rows do not match), this is 5x to 10x faster than the full hash probe. Spark and Hive call this "bloom filter pushdown" or "runtime filter."

```cpp
class BloomFilter {
    std::vector<uint64_t> bits_;
    uint64_t mask_;

public:
    void Init(size_t n_bits) {
        size_t words = std::bit_ceil(std::max<size_t>(64, n_bits / 64));
        bits_.assign(words, 0);
        mask_ = (words * 64) - 1;
    }

    void Insert(int64_t key) {
        uint64_t h1 = HashTable::Hash(key);
        uint64_t h2 = h1 >> 32 | h1 << 32;
        for (int i = 0; i < 4; ++i) {
            uint64_t bit = (h1 + i * h2) & mask_;
            bits_[bit / 64] |= (1ULL << (bit % 64));
        }
    }

    bool MayContain(int64_t key) const {
        uint64_t h1 = HashTable::Hash(key);
        uint64_t h2 = h1 >> 32 | h1 << 32;
        for (int i = 0; i < 4; ++i) {
            uint64_t bit = (h1 + i * h2) & mask_;
            if (!(bits_[bit / 64] & (1ULL << (bit % 64)))) return false;
        }
        return true;
    }
};
```

A Bloom filter at 8 bits per key has around 2% false positive rate. ClickHouse uses split block Bloom filters (better cache behavior). Photon uses a similar block-based design.

### Grace Hash Join

When the build side does not fit in memory, hash join must spill. Grace hash join (Kitsuregawa et al., 1983) partitions both sides by hash to disk, then performs an in-memory hash join per partition.

```cpp
#include <fstream>

namespace hj {

class GraceHashJoin {
    static constexpr size_t kPartitions = 64;  // power of two
    std::vector<std::ofstream> build_files_;
    std::vector<std::ofstream> probe_files_;
    std::vector<size_t> build_partition_size_;
    std::vector<size_t> probe_partition_size_;

public:
    void Build(const Row* in, size_t n) {
        OpenFiles();
        for (size_t i = 0; i < n; ++i) {
            uint64_t h = HashTable::Hash(in[i].key);
            uint32_t p = (h >> 32) & (kPartitions - 1);  // upper bits
            build_files_[p].write(reinterpret_cast<const char*>(&in[i]), sizeof(Row));
            build_partition_size_[p]++;
        }
        for (auto& f : build_files_) f.flush();
    }

    void Probe(const Row* in, size_t n) {
        for (size_t i = 0; i < n; ++i) {
            uint64_t h = HashTable::Hash(in[i].key);
            uint32_t p = (h >> 32) & (kPartitions - 1);
            probe_files_[p].write(reinterpret_cast<const char*>(&in[i]), sizeof(Row));
            probe_partition_size_[p]++;
        }
        for (auto& f : probe_files_) f.flush();
    }

    template <typename Emit>
    void Finish(Emit emit) {
        for (size_t p = 0; p < kPartitions; ++p) {
            auto build_rows = ReadFile("build_p" + std::to_string(p));
            auto probe_rows = ReadFile("probe_p" + std::to_string(p));
            HashTable ht;
            ht.Build(build_rows.data(), build_rows.size());
            ht.Probe(probe_rows.data(), probe_rows.size(), emit);
        }
    }

private:
    void OpenFiles() {
        build_files_.resize(kPartitions);
        probe_files_.resize(kPartitions);
        build_partition_size_.assign(kPartitions, 0);
        probe_partition_size_.assign(kPartitions, 0);
        for (size_t i = 0; i < kPartitions; ++i) {
            build_files_[i].open("build_p" + std::to_string(i), std::ios::binary);
            probe_files_[i].open("probe_p" + std::to_string(i), std::ios::binary);
        }
    }
    std::vector<Row> ReadFile(const std::string& name);
};

}  // namespace hj
```

Two implementation details to get right:

**Use upper bits of the hash for partitioning.** The lower bits are used by the in-memory hash table. Reusing them would create skew (every key in partition 5 hashes to the same low bits inside the partition's table).

**Recursive partitioning.** If a single partition still does not fit in memory, recursively partition it with a different hash. Hyper and DuckDB do this.

DuckDB's "radix-partitioned hash join" is a variant where partitioning happens in cache-resident batches, never touching disk unless memory pressure triggers it. This gives single-pass behavior in the common case and fallback to grace when needed. The DuckDB paper (Mueller et al., "Radix-Partitioned Hash Join with Software-Managed Buffers," SIGMOD 2018) is the reference.

### Sort-Merge Join

If both inputs are already sorted on the join key (because of an index, a sorted column store, or a prior sort), sort-merge join is faster than hash join. It also handles range conditions, which hash join cannot.

```cpp
#include <algorithm>

namespace hj {

template <typename Emit>
void SortMergeJoin(const Row* a, size_t na, const Row* b, size_t nb, Emit emit) {
    size_t i = 0, j = 0;
    while (i < na && j < nb) {
        if (a[i].key < b[j].key) { ++i; }
        else if (a[i].key > b[j].key) { ++j; }
        else {
            // Equal range. Emit cross product.
            size_t i_end = i;
            while (i_end < na && a[i_end].key == a[i].key) ++i_end;
            size_t j_end = j;
            while (j_end < nb && b[j_end].key == b[j].key) ++j_end;
            for (size_t ii = i; ii < i_end; ++ii)
                for (size_t jj = j; jj < j_end; ++jj)
                    emit(a[ii], b[jj]);
            i = i_end; j = j_end;
        }
    }
}

}  // namespace hj
```

If the inputs are not sorted, the cost is two sorts plus a merge. Two N log N sorts can exceed an N+M hash join even with build-side memory pressure. Sort-merge wins when sorts can be avoided (sorted input from a clustered index or a previous order-preserving operator).

CockroachDB picks sort-merge for joins where one side is the result of an indexed range scan. Postgres picks it when both sides have indexes on the join key. Snowflake rarely picks it (its columnar storage is sorted differently for each clustering key).

### Index Nested-Loop Join

When the inner side has an index on the join key, you can probe the index for each outer row.

```cpp
namespace hj {

template <typename Index, typename Emit>
void IndexNLJoin(const Row* outer, size_t n_outer, const Index& idx, Emit emit) {
    for (size_t i = 0; i < n_outer; ++i) {
        idx.RangeScan(outer[i].key, outer[i].key, [&](const Row& inner) {
            emit(outer[i], inner);
        });
    }
}

}  // namespace hj
```

This is the right choice when the outer is small (a filtered driving table) and the inner is large with an index. OLTP systems use it constantly. OLAP rarely needs it because table scans of columnar storage are faster than millions of random index probes.

The crossover with hash join is around 1% of the inner table. Below that, index nested-loop wins. Above that, hash join wins.

### Broadcast vs Partitioned (Distributed Joins)

In a distributed system, a join needs both sides to be co-located by key.

**Broadcast join.** The smaller side is broadcast to every node. The larger side stays partitioned. Cost: small_side_bytes * num_nodes. Best when small side is small.

**Partitioned join (shuffle).** Both sides are repartitioned by hash on the join key. Cost: both sides shuffled across the network.

**Co-located join.** Both sides are already partitioned by the join key (because of table layout). Cost: zero shuffle. Best, but rarely available.

The threshold for broadcast vs partitioned is workload-dependent. Spark defaults to broadcasting tables under 10 MB. BigQuery's threshold is around 100 MB per node. Snowflake adapts at runtime.

### Semi-Join and Anti-Join

`SELECT * FROM r WHERE EXISTS (SELECT 1 FROM s WHERE s.k = r.k)` is a semi-join. The optimizer decorrelates it.

A semi-join hash table only needs the keys (no payload). Probe stops on the first match.

```cpp
namespace hj {

template <typename Emit>
void SemiJoinHash(const Row* outer, size_t n_outer, const HashTable& ht, Emit emit) {
    for (size_t i = 0; i < n_outer; ++i) {
        bool any = false;
        ht.Probe(&outer[i], 1, [&](const Row&, const Row&) { any = true; });
        if (any) emit(outer[i]);
    }
}

}  // namespace hj
```

Anti-join is the negation: emit outer rows with no match. Used for `NOT IN` and `NOT EXISTS` after decorrelation.

For NULL semantics in NOT IN, you must check whether the inner side has any NULLs (in which case NOT IN returns unknown for all outer rows). This is the source of many subtle SQL bugs.

### Skew Handling

A few hot keys in the join can ruin parallel performance. If 80% of probe rows match one build key, that key's partition is the bottleneck.

Strategies:

**Detect at build time.** Use Count-Min sketch on build keys, identify hot keys, replicate them across all probe partitions.

**Salt the keys.** For known hot keys, append a random salt 0..K-1 to both sides, multiplying the build by K but balancing load.

**Adaptive at runtime.** Detect that one partition is slower, repartition mid-query. Spark adaptive query execution does this.

Photon (Databricks) has an explicit skew-aware hash join that splits hot-key partitions across multiple workers.

### What to Use When

| Scenario | Algorithm |
|---|---|
| Equi-join, both unsorted, build fits in memory | Hash join |
| Equi-join, both unsorted, build does not fit | Grace hash join |
| Equi-join, both sorted | Sort-merge join |
| Range or theta join | Sort-merge or nested-loop |
| Outer is small, inner has index on join key | Index nested-loop |
| Distributed, small side is small | Broadcast hash join |
| Distributed, both large | Partitioned (shuffle) hash join |
| EXISTS / IN | Semi-join (hash) |
| NOT EXISTS / NOT IN | Anti-join (hash) with NULL handling |

The next chapter covers the other major operator family: aggregation.

---
