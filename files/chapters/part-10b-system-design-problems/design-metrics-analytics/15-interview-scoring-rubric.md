## Interview Scoring Rubric

This rubric calibrates the depth of analysis expected at each seniority level. A metrics system interview is particularly revealing because it tests both data pipeline design (high-throughput ingestion) and query system design (interactive dashboards) in the same problem.

### L4 (Junior/Mid)
- Time-series data model with name, tags, value, and timestamp
- Kafka as a buffer between ingest and storage
- SQL-based aggregation queries (GROUP BY time bucket)
- Basic threshold alerting (if value > X, send notification)
- **Missing at this level (expected):** pre-aggregation in the stream layer, tiered retention policies, cardinality management

### L5 (Senior)
- Two-tier storage: raw 10-second data for 7 days, 1-minute aggregated data for 1 year
- Stream pre-aggregation cutting long-term write volume roughly 6x (1M raw points/sec to ~167K rollup rows/sec)
- ClickHouse as the columnar TSDB with MergeTree engine, TTL-based data expiration, and partition-by-day
- Alert deduplication using Redis state to prevent alert storms on oscillating metrics
- Query tier auto-selection: queries within 7 days hit raw table, older queries hit aggregated table
- Agent-side pre-aggregation to reduce network bandwidth from 100K hosts
- **Missing at this level (expected):** T-Digest sketches for mergeable percentiles, cardinality enforcement strategies, dashboard query parallelization

### L6 (Staff)
- T-Digest or HDR Histogram for efficient percentile computation across distributed aggregates
- Cardinality prevention (tag allow-lists, HyperLogLog estimation) and bucketing strategies for high-cardinality dimensions
- Multi-region ingestion with region-local ClickHouse clusters and cross-region query federation
- Dashboard query caching with stale-while-revalidate for auto-refreshing panels
- Agent-side disk buffering for resilience during network partitions
- Detailed trade-off analysis: InfluxDB (purpose-built TSDB with InfluxQL) vs Prometheus (pull-based, good for Kubernetes) vs ClickHouse (general-purpose columnar, best raw performance at scale)
- Custom metric types: histograms with configurable bucket boundaries, summary with pre-computed quantiles
- SLO-based alerting with error budget burn rates (fast-burn pages, slow-burn warnings)

---
