## Capacity Estimation

Before diving into architecture, you need to understand the scale you are designing for. Capacity estimation translates the product requirements (1M metrics/sec, 1-year retention) into concrete numbers for storage, bandwidth, and compute. These back-of-the-envelope calculations guide every downstream decision, from how many Kafka partitions you need to how much disk your time-series database will consume. Getting these numbers wrong means either over-provisioning (wasting money) or under-provisioning (outages under load).

```
Ingest rate:        1M metrics/sec
Metric point size:  ~100 bytes (name + tags + value + timestamp)
Ingest bandwidth:   1M × 100B = 100MB/sec
Raw storage/day:    100MB/sec × 86400 = 8.6TB/day
After compression:  ~1TB/day (time-series compress 10:1)
1-year at raw res:  365TB compressed (motivates tiered retention)
Actual footprint:   ~80TB (7 days raw ≈ 7TB + 1-min rollups ≈ 70TB/year)
Hosts reporting:    100K hosts × 100 series each = 10M distinct series
                    (each series reports every 10s → 1M points/sec ✓)
Query rate:         1K dashboard queries/sec
Alert evaluations:  10K alerts × 1/min = 167 alert checks/sec
```

The 10:1 compression ratio for time-series data is achievable because consecutive readings from the same metric tend to be very similar (CPU usage changes gradually, not randomly). ClickHouse exploits this with delta encoding on timestamps (consecutive readings are usually 10 seconds apart, so storing the delta "10" instead of a full 8-byte timestamp saves significant space) and Gorilla-style compression on floating-point values (XOR encoding between consecutive values produces many leading zeros).

The 10 million distinct series figure is the "cardinality" of the system and is the primary scaling constraint for the time-series database. Each unique combination of metric name plus tags (for example, `cpu.usage{host=web-01, region=us-east, service=api}`) constitutes one series. If developers add high-cardinality tags like `user_id` or `request_id`, the series count can explode to billions, overwhelming both storage and query performance. This is why tag validation at the ingest layer is critical.

Alert evaluations at 167 checks per second may seem modest, but each check requires querying a time window of aggregated data (typically the last 5-15 minutes) and comparing the result against a threshold. With 3 instances evaluating alerts in an active-active configuration, each instance handles roughly 56 checks per second, well within the capacity of the ClickHouse query layer.

---
