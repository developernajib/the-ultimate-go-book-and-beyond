## Cardinality Estimation

Every cost-based optimizer is a search over plan space scored by a cost model. The cost model takes cardinality estimates as input. If the estimates are wrong, the optimizer makes wrong choices and the engine runs a bad plan. Industry data (the "How Good Are Query Optimizers, Really?" paper, VLDB 2015) shows that cardinality errors of 1000x are common on real workloads, and these errors are the dominant cause of bad plans. Cardinality is the hardest unsolved problem in query optimization.

This chapter covers the toolkit: histograms, sketches, sampling, and the recent ML approaches.

### What We Are Estimating

Three quantities matter to the optimizer:

1. **Selectivity** of a predicate `p` on a column or table, the fraction of rows that satisfy `p`.
2. **Distinct values** (NDV) of a column or expression, used for grouping and join cardinality.
3. **Join cardinality**, the row count after joining two tables on a predicate.

Each has its own techniques. We will build them in order.

### Equi-Width Histograms

The simplest histogram divides the value range into N equal-width buckets and counts rows per bucket. For an integer column with min 0 and max 1000 and 10 buckets, bucket 3 covers [300, 400) and stores its count.

```cpp
#include <algorithm>
#include <cstdint>
#include <vector>

class EquiWidthHistogram {
    int64_t min_, max_;
    size_t num_buckets_;
    std::vector<uint64_t> counts_;
    double width_;

public:
    EquiWidthHistogram(int64_t lo, int64_t hi, size_t n)
        : min_(lo), max_(hi), num_buckets_(n), counts_(n, 0),
          width_(double(hi - lo) / double(n)) {}

    void Build(const int64_t* values, size_t n) {
        for (size_t i = 0; i < n; ++i) {
            size_t b = static_cast<size_t>(double(values[i] - min_) / width_);
            if (b >= num_buckets_) b = num_buckets_ - 1;
            counts_[b]++;
        }
    }

    // Estimate count(col < threshold).
    double EstimateLess(int64_t threshold) const {
        if (threshold <= min_) return 0.0;
        if (threshold >= max_) return TotalCount();
        double pos = double(threshold - min_) / width_;
        size_t full_buckets = static_cast<size_t>(pos);
        double frac = pos - double(full_buckets);
        double total = 0.0;
        for (size_t i = 0; i < full_buckets; ++i) total += counts_[i];
        if (full_buckets < num_buckets_) total += frac * counts_[full_buckets];
        return total;
    }

    uint64_t TotalCount() const {
        uint64_t s = 0;
        for (auto c : counts_) s += c;
        return s;
    }
};
```

Equi-width is fast to build and cheap in storage. It collapses on skew: if 99% of rows fall in one bucket, the bucket-internal estimate (uniform distribution within a bucket) is nearly meaningless.

### Equi-Depth Histograms

Equi-depth fixes skew. Each bucket holds approximately the same row count, and bucket boundaries adjust to the data. Postgres, MySQL, and Oracle all use equi-depth as their default.

```cpp
class EquiDepthHistogram {
    std::vector<int64_t> boundaries_;  // size = num_buckets + 1
    uint64_t rows_per_bucket_;

public:
    void Build(std::vector<int64_t>& values, size_t num_buckets) {
        std::sort(values.begin(), values.end());
        boundaries_.resize(num_buckets + 1);
        rows_per_bucket_ = values.size() / num_buckets;
        for (size_t i = 0; i <= num_buckets; ++i) {
            size_t idx = std::min(i * rows_per_bucket_, values.size() - 1);
            boundaries_[i] = values[idx];
        }
    }

    double EstimateLess(int64_t threshold) const {
        if (threshold <= boundaries_.front()) return 0.0;
        if (threshold >= boundaries_.back()) return rows_per_bucket_ * (boundaries_.size() - 1);

        // Binary search for the bucket containing threshold.
        auto it = std::upper_bound(boundaries_.begin(), boundaries_.end(), threshold);
        size_t bucket = std::distance(boundaries_.begin(), it) - 1;
        double bucket_lo = double(boundaries_[bucket]);
        double bucket_hi = double(boundaries_[bucket + 1]);
        double frac = (double(threshold) - bucket_lo) / (bucket_hi - bucket_lo);
        return double(bucket) * rows_per_bucket_ + frac * rows_per_bucket_;
    }
};
```

Equi-depth handles skew well at bucket boundaries but still assumes uniformity within a bucket. A heavily skewed bucket (one mode) gives bad estimates for predicates inside it.

### Max-Diff Histograms

Max-diff (Poosala et al., 1996) chooses bucket boundaries at the points of largest frequency change, capturing the actual distribution shape. The algorithm: sort distinct values, compute the absolute difference between consecutive frequencies, place bucket boundaries at the top N-1 differences.

```cpp
class MaxDiffHistogram {
    struct Bucket {
        int64_t lo, hi;
        uint64_t count;
        uint32_t ndv;
    };
    std::vector<Bucket> buckets_;

public:
    void Build(const std::vector<std::pair<int64_t, uint64_t>>& freq, size_t n) {
        if (freq.size() <= n) {
            buckets_.reserve(freq.size());
            for (auto& [v, c] : freq) buckets_.push_back({v, v, c, 1});
            return;
        }
        // Compute frequency differences between adjacent distinct values.
        std::vector<std::pair<double, size_t>> diffs;
        for (size_t i = 1; i < freq.size(); ++i) {
            diffs.emplace_back(std::abs(double(freq[i].second) - double(freq[i-1].second)), i);
        }
        std::partial_sort(diffs.begin(), diffs.begin() + (n - 1), diffs.end(),
                          std::greater<>{});
        std::vector<size_t> boundaries(n - 1);
        for (size_t i = 0; i < n - 1; ++i) boundaries[i] = diffs[i].second;
        std::sort(boundaries.begin(), boundaries.end());

        size_t lo = 0;
        for (size_t b : boundaries) {
            buckets_.push_back(MakeBucket(freq, lo, b));
            lo = b;
        }
        buckets_.push_back(MakeBucket(freq, lo, freq.size()));
    }

private:
    static Bucket MakeBucket(const std::vector<std::pair<int64_t, uint64_t>>& f,
                             size_t lo, size_t hi) {
        Bucket b{f[lo].first, f[hi-1].first, 0, uint32_t(hi - lo)};
        for (size_t i = lo; i < hi; ++i) b.count += f[i].second;
        return b;
    }
};
```

Max-diff captures heavy hitters cleanly. Most production systems combine equi-depth (for the bulk distribution) with explicit MCV (most-common-values) lists for the top K values. Postgres calls these `pg_statistic.most_common_vals` and `most_common_freqs`.

### HyperLogLog for Distinct Counts

NDV (number of distinct values) appears in `COUNT(DISTINCT)`, in group-by cardinality, and in join cardinality formulas. Computing NDV exactly requires hashing every value into a set. HyperLogLog (Flajolet et al., 2007) estimates NDV with constant memory and 1% to 2% standard error.

The idea: hash each value to a uniform 64-bit integer, count the leading zeros of the hash, and track the maximum leading-zero count per bucket. The number of distinct values is approximately `m * 2^max_lz`, where m is the number of buckets.

```cpp
#include <bit>
#include <cmath>
#include <cstdint>

class HyperLogLog {
    static constexpr int kPrecision = 14;        // 16384 registers
    static constexpr int kRegisters = 1 << kPrecision;
    static constexpr uint64_t kMask = kRegisters - 1;

    uint8_t registers_[kRegisters] = {};

    static uint64_t Hash(uint64_t x) {
        x ^= x >> 33; x *= 0xff51afd7ed558ccdULL;
        x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ULL;
        x ^= x >> 33;
        return x;
    }

public:
    void Add(uint64_t value) {
        uint64_t h = Hash(value);
        uint32_t bucket = h & kMask;
        uint64_t w = h >> kPrecision;
        uint8_t lz = w ? std::countl_zero(w) - kPrecision + 1
                       : 64 - kPrecision + 1;
        if (lz > registers_[bucket]) registers_[bucket] = lz;
    }

    double Estimate() const {
        double alpha = 0.7213 / (1.0 + 1.079 / kRegisters);
        double sum = 0.0;
        int zero_count = 0;
        for (int i = 0; i < kRegisters; ++i) {
            sum += std::ldexp(1.0, -registers_[i]);
            if (registers_[i] == 0) ++zero_count;
        }
        double e = alpha * kRegisters * kRegisters / sum;
        // Linear counting correction for small cardinalities.
        if (e <= 2.5 * kRegisters && zero_count > 0) {
            return kRegisters * std::log(double(kRegisters) / zero_count);
        }
        return e;
    }

    void Merge(const HyperLogLog& other) {
        for (int i = 0; i < kRegisters; ++i) {
            if (other.registers_[i] > registers_[i])
                registers_[i] = other.registers_[i];
        }
    }
};
```

A 16384-register HLL uses 16 KB of memory and gives 0.81% standard error. ClickHouse's `uniqHLL12` and `uniq` (which switches representations adaptively) are production examples. DuckDB uses HLL for `approx_count_distinct`.

For optimizer use, HLLs are computed at table-statistics time, stored in catalog metadata, and merged across partitions when needed.

### Count-Min Sketch and t-digest

**Count-Min** estimates the frequency of any element. It is a 2D array of d rows and w columns. Each row uses an independent hash function. To increment, hash the element with each of d hashes and increment the corresponding cell. To query, hash the element and return the minimum cell value across rows.

Count-Min answers "how many times has key X appeared." It overestimates (never underestimates). Used in Cassandra, in some streaming optimizers, and in Photon for skew detection.

**t-digest** estimates quantiles in streaming data. Useful for percentile aggregates and for adaptive cost models that want to know p99 latency of an operator. The algorithm clusters values into centroids whose weight is concentrated at the tails. ClickHouse's `quantileTDigest` is a production t-digest.

### Join Cardinality

For an equi-join `R JOIN S ON R.a = S.b`, the textbook estimate is:

```
|R join S| = (|R| * |S|) / max(NDV(R.a), NDV(S.b))
```

This assumes the join keys are uniformly distributed and that every distinct value in the smaller side has matches in the larger side (containment). Both assumptions fail in practice.

For multi-column predicates the optimizer multiplies selectivities, which assumes column independence. This is the dominant source of estimation error. `WHERE city = 'NYC' AND state = 'NY'` is heavily correlated, and treating the predicates as independent gives a 50x underestimate on real data.

The fixes that production systems use:

**Multi-column statistics.** Postgres has `CREATE STATISTICS` for functional dependencies between columns. ClickHouse has explicit projections that include correlated columns.

**Sample-based estimation.** Take a random sample of the table at planning time, run the predicate on the sample, scale up. Snowflake and BigQuery do this for complex predicates.

**Sketches over multiple columns.** TabSampler, SafeBound, and other techniques learn joint distributions.

### ML-Based Cardinality

The last five years have seen serious ML approaches to cardinality.

**Naru** (Yang et al., 2019) learns an autoregressive density estimator over a table's columns. Estimates any predicate by sampling from the learned model. Accuracy is dramatically better than histograms on multi-column predicates with correlation. Cost is training time and a small inference cost per query.

**DeepDB** (Hilprecht et al., 2020) uses sum-product networks. Faster training and inference than Naru, similar accuracy.

**MSCN** (Multi-Set Convolutional Network, Kipf et al., 2019) is a neural network that takes a query plan as input and predicts cardinality directly. Trained on workload feedback.

**Bao** (Marcus et al., 2021) learns to apply or skip a fixed set of optimizer hints. Not a cardinality estimator per se but a workload-aware plan picker.

Production adoption is still limited. CockroachDB has an ML cardinality estimator in development. BigQuery uses ML for adaptive query execution but the optimizer itself remains analytic. The blocker is that ML models drift when data changes and need retraining infrastructure that databases historically do not have.

### What Goes Wrong in Practice

The taxonomy of cardinality bugs from production:

1. **Correlation blindness.** The biggest bucket. Fix with multi-column stats.
2. **Stale stats.** Histograms built last week, data has changed. Fix with auto-stats jobs and cardinality monitoring.
3. **Fan-out joins.** A 1-to-many join produces row counts the optimizer underestimates. Fix with PK/FK detection.
4. **Predicate on expression.** `WHERE substr(name, 1, 3) = 'ABC'` cannot use the histogram on `name`. Fix with expression statistics or expression indexes.
5. **NULL handling.** Histograms typically exclude NULLs, but `IS NULL` predicates need special handling.
6. **Skewed join keys.** A few hot keys dominate the join. Fix with explicit skew handling in the executor (broadcast small side, partition the rest).

The next chapter wires these estimates into a cost model.

---
