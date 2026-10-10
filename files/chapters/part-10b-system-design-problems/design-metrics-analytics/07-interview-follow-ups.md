## Interview Follow-Ups

These questions target the operational pain points that every production metrics system encounters. Cardinality management, percentile computation, and clock skew handling are problems that only surface at scale.

**Q: How do you handle high-cardinality tags?**

Cardinality explosion is the number one operational risk in a metrics system. Adding a `user_id` tag to a metric creates 100 million unique series (one per user), which can overwhelm both storage and query performance. The defense is multi-layered: (1) the ingest service validates tags against a per-metric allow-list, rejecting any tag not explicitly registered, (2) a cardinality estimator (using HyperLogLog) runs per metric and alerts when the distinct series count exceeds a threshold, (3) for legitimate use cases that require user-level granularity, bucketing is used, hash the user ID into 1,000 buckets, which reduces cardinality by 100,000x while preserving the ability to compute aggregate statistics. In practice, most infrastructure metrics should have no more than a few thousand distinct tag combinations (host x region x service x instance).

**Q: How do you compute P99 efficiently at query time?**

Exact percentile computation requires sorting all values in the window, which is O(n log n) and requires loading potentially millions of data points into memory. ClickHouse's `quantileTDigest(0.99)` function uses the t-digest algorithm (the plain `quantile` function uses reservoir sampling instead), which provides approximate quantiles with small rank error, most accurate at extreme quantiles like P99, while using only a fixed amount of memory (100-200 centroids regardless of input size). For the stream aggregation layer, each aggregation window can pre-compute a T-Digest sketch and store it alongside the avg/min/max/count values. T-Digest sketches are mergeable, meaning you can combine sketches from different time windows or different shards to compute percentiles over longer periods without accessing the raw data. HDR Histogram is an alternative for latency metrics where the value range is known and bounded (for example, 1ms to 60s), it provides exact percentiles within a configurable precision.

**Q: How do you handle clock skew from agents?**

Agents running on different hosts may have clocks that differ by seconds or even minutes. The ingest service accepts timestamps within a +/-30 second window of the server's current time. Timestamps outside this window are either clamped to the boundary (for slightly-out-of-range values) or rejected entirely (for clearly stale data, such as points arriving hours late). Points arriving within the acceptable window but out of order (for example, a batch of 100 metrics where the network latency varied per packet) are handled by ClickHouse's MergeTree engine, which accepts out-of-order inserts and merges them into the correct position during background compaction. This adds a small performance cost (roughly 5-10% overhead versus perfectly ordered inserts) but is far simpler than requiring agents to send data in strict timestamp order.

---
