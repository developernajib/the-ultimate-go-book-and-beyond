## Scaling Strategy

The component breakdown below shows how each layer in the metrics pipeline is sized and why. Ingest nodes are kept stateless and use UDP alongside HTTP so a single dropped packet never stalls a producer, allowing horizontal scale-out without coordination overhead. Kafka's 256 partitions, hashed by metric name, ensure that all samples for the same metric land on the same partition, which is critical for the Flink aggregation layer: a 1-minute tumbling window that collapses 1 million raw data points per second into roughly 167,000 rollup rows per second must see every sample for a given metric name on the same consumer task to produce a correct count or percentile. ClickHouse's three-shard, two-replica topology pairs LZ4 compression for fast ingest with ZSTD for cold storage, absorbing the full raw stream of 1 million rows per second (in large batches) plus the rollup writes while keeping long-term storage costs manageable.

```
Ingest: 20 servers, 50K metrics/sec each, stateless, UDP+HTTP endpoints
Kafka: 256 partitions, partition by metric name hash, 24h retention, 3 consumer groups
Stream Aggregation (Flink): 1m windows, 1M->167K rows/sec reduction, 50GB state, 30s checkpoints
ClickHouse: 3 shards x 2 replicas, 64 cores/256GB/30TB each, ~400K rows/sec per shard, LZ4+ZSTD compression
Query Cache (Redis): 30s TTL for realtime dashboards, 5min for historical, ~60% hit rate
Alert Engine: 3 instances active-active, ~3500 rules/min each, state in Redis
```

---
