## Zone Maps and Skipping Indexes

The fastest scan is the one you do not run. A query with a selective predicate should skip blocks of data that cannot match. Zone maps, Bloom filters, and other skipping indexes are the structures that let the storage layer answer "is there any row in this block matching predicate P" without reading the block.

### Zone Maps

A zone map stores `(min, max, null_count)` per block. For a predicate `WHERE x > 100`, the optimizer skips any block whose max <= 100. For `WHERE x BETWEEN 50 AND 75`, skip blocks whose max < 50 or min > 75.

Zone maps cost almost nothing in storage (24 bytes per block of typically 1 MB to 128 MB) and can eliminate 90%+ of blocks for selective queries on sorted data.

```cpp
#include <cstdint>
#include <vector>
#include <limits>

namespace zm {

struct ZoneMap {
    int64_t min_v = std::numeric_limits<int64_t>::max();
    int64_t max_v = std::numeric_limits<int64_t>::min();
    uint32_t null_count = 0;
    uint32_t total_count = 0;

    void Update(int64_t v, bool is_null) {
        ++total_count;
        if (is_null) { ++null_count; return; }
        if (v < min_v) min_v = v;
        if (v > max_v) max_v = v;
    }

    bool MayMatchEqual(int64_t v) const {
        return total_count > null_count && v >= min_v && v <= max_v;
    }
    bool MayMatchRange(int64_t lo, int64_t hi) const {
        return total_count > null_count && hi >= min_v && lo <= max_v;
    }
    bool MayMatchGreater(int64_t v) const {
        return total_count > null_count && max_v > v;
    }
};

}  // namespace zm
```

Zone maps work best on sorted or clustered data. For randomly distributed data, every block's range covers most of the column, and zone maps eliminate few blocks. The optimizer should still build zone maps (they are cheap) but expect lower benefit.

Parquet stores per-row-group statistics in the footer. Page indexes (introduced in Parquet 2.6) store per-page min/max for finer skipping. ClickHouse's MergeTree stores granule-level statistics in its `primary.idx` and per-column min/max files.

### Bloom Filters

Zone maps fail on equality predicates over unsorted data. `WHERE country = 'CL'` on a country column not sorted by country gives every block a min "AD" and max "ZW," and no block can be skipped.

A Bloom filter on the column's distinct values lets you skip blocks where the value is provably absent. False positives are possible, false negatives are not.

```cpp
#include <bit>
#include <vector>

namespace zm {

class BloomFilter {
    std::vector<uint64_t> bits_;
    uint64_t mask_;
    int hash_count_;

public:
    BloomFilter(size_t expected_n, double fp_rate = 0.01) {
        double bits_per_key = -std::log(fp_rate) / (std::log(2.0) * std::log(2.0));
        size_t total = std::bit_ceil(size_t(expected_n * bits_per_key));
        bits_.assign(total / 64, 0);
        mask_ = total - 1;
        hash_count_ = int(bits_per_key * std::log(2.0)) + 1;
    }

    void Insert(uint64_t hash) {
        uint64_t h2 = hash >> 32 | hash << 32;
        for (int i = 0; i < hash_count_; ++i) {
            uint64_t b = (hash + i * h2) & mask_;
            bits_[b / 64] |= (1ULL << (b % 64));
        }
    }

    bool MayContain(uint64_t hash) const {
        uint64_t h2 = hash >> 32 | hash << 32;
        for (int i = 0; i < hash_count_; ++i) {
            uint64_t b = (hash + i * h2) & mask_;
            if (!(bits_[b / 64] & (1ULL << (b % 64)))) return false;
        }
        return true;
    }
};

}  // namespace zm
```

Production engines use **block Bloom filters** (Putze et al., 2007). Instead of N bits scattered randomly, all N bits for one value land in the same 256-bit or 512-bit block. This keeps the Bloom probe in a single cache line.

Parquet has Bloom filter support (Parquet 1.10+). It is optional per column and the writer chooses whether to include it. Apache Iceberg can mandate Bloom filters via table properties. ClickHouse has `bloom_filter` skipping indexes per column.

### Bloom Filter Trade-offs

Bloom filters cost real storage. At 0.01 false positive rate, a Bloom filter is around 10 bits per distinct value. For a column with 10M distinct values, that is 12.5 MB of filter per block group. If your blocks are 128 MB, the filter overhead is ~10%.

Use Bloom filters when:

- The column is queried with equality predicates.
- The column is high cardinality (low cardinality is better served by dictionary + zone map).
- The query selectivity is low enough that block skipping pays for the filter probe.

ClickHouse offers three variants per column:

- `bloom_filter`: standard Bloom filter on values.
- `ngrambf_v1`: Bloom filter on n-grams of string values, supports `LIKE` predicates.
- `tokenbf_v1`: Bloom filter on token-split strings, supports `hasToken` and full-text-like predicates.

### ClickHouse Set Indexes

A `set` skipping index stores the set of all distinct values in each granule. For low-cardinality columns, this is small and exact (no false positives).

```sql
CREATE TABLE t (
    a UInt64,
    INDEX a_set a TYPE set(1024) GRANULARITY 4
) ENGINE = MergeTree();
```

The set index stores up to 1024 distinct values per 4 granules (32K rows by default). If a granule has more than 1024 distinct values, the index for that granule is dropped (becomes "no information"). The optimizer checks the set, if absent or value not in set, skip.

This is more selective than a Bloom filter for low NDV but does not scale to high cardinality.

### Min-Max as Skipping Index

ClickHouse also supports `minmax` as an explicit secondary skipping index. This is the same as a zone map, but at finer granularity than the primary key. Useful when you want skipping on a column that is not part of the primary key.

```sql
CREATE TABLE t (
    a UInt64,
    INDEX a_mm a TYPE minmax GRANULARITY 4
) ENGINE = MergeTree();
```

### Index Condition Pushdown

The storage engine evaluates the predicate against the indexes and skips blocks. This is "index pushdown" or "predicate pushdown to storage."

The optimizer must split the predicate into:

- Conditions that the indexes can evaluate (pushed to storage).
- Conditions that need full row evaluation (kept in the operator).

```cpp
// Sketch of a pushdown analyzer.
namespace zm {

struct ScanPlan {
    std::vector<std::unique_ptr<Expression>> pushed_to_storage;
    std::vector<std::unique_ptr<Expression>> residual;
};

ScanPlan AnalyzePushdown(const std::vector<std::unique_ptr<Expression>>& conjuncts,
                         const TableMeta& table) {
    ScanPlan plan;
    for (auto& c : conjuncts) {
        if (CanEvaluateOnIndexes(*c, table)) {
            plan.pushed_to_storage.push_back(std::move(c->Clone()));
        } else {
            plan.residual.push_back(std::move(c->Clone()));
        }
    }
    return plan;
}

}  // namespace zm
```

Conditions on the primary key, or on indexed columns with skipping indexes, are pushed. Conditions involving non-indexed columns or complex expressions stay in the operator.

DuckDB pushes equality and range filters into Parquet readers via the Apache Arrow filter API. ClickHouse pushes through the `KeyCondition` analyzer. CockroachDB pushes through SQL-to-KV constraint solving.

### Bitmap Indexes

A bitmap index stores, per distinct value, a bitmap indicating which rows have that value. For a column `gender` with 2 distinct values over 1B rows, two 1B-bit bitmaps (125 MB each) cover the whole column. Bitmap operations (AND, OR) execute predicate combinations cheaply.

Bitmap indexes shine on low-cardinality columns with frequent multi-column equality queries. Decision support warehouses (Vertica, Greenplum) use them heavily. Modern columnar engines (DuckDB, ClickHouse) deemphasize them in favor of zone maps + Bloom filters because bitmap indexes cost more to maintain on update-heavy tables.

Roaring Bitmaps (Lemire et al., 2016) is the modern format. Used in Apache Druid, Pinot, Lucene, and Elasticsearch.

### Skipping Index Granularity

The granularity (rows per index entry) is a tuning parameter:

- Coarse (1M rows per entry): low storage cost, less skipping precision.
- Fine (1K rows per entry): high storage cost, precise skipping.

ClickHouse's default index granularity is 8192 rows. Parquet row groups are typically 1M to 100M rows, page indexes are finer (10K to 100K rows).

The right value depends on workload selectivity. For very selective queries (1 in 100M), fine granularity helps. For broad queries, coarse is enough.

### Practical Tips

1. **Always build zone maps.** They are nearly free and help on any sorted-ish column.
2. **Add Bloom filters to high-cardinality equality-queried columns.** Test the false positive rate against your workload.
3. **Use set indexes for low-cardinality columns** that are not part of the primary key.
4. **Verify skipping is happening.** ClickHouse's `EXPLAIN` shows granule pruning. Spark's `EXPLAIN ANALYZE` shows row group skipping.
5. **Order data by frequently filtered columns.** Storage layout matters more than secondary indexes.

### What to Read

- ClickHouse documentation on data skipping indexes.
- Apache Parquet column index specification.
- Lemire et al., "Roaring bitmaps: Implementation of an optimized software library," 2016.
- Putze et al., "Cache-, Hash- and Space-Efficient Bloom Filters," 2007.

The next chapter takes the skipping idea further: late materialization.

---
