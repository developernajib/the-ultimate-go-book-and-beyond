## Performance Testing Checklist

Before going to production, you need to verify that every critical path meets its latency and throughput targets under realistic load. The checklist below defines specific, measurable targets for each component. Run these benchmarks with production-like data volumes and concurrency levels, a test with 100 tweets in the database will not reveal the performance characteristics you will see with 100 billion.

| Test | Target | Method |
|------|--------|--------|
| Tweet write throughput | > 20K/sec sustained | Load test MySQL shards |
| Timeline read latency P99 | < 50ms | Benchmark Redis ZREVRANGEBYSCORE |
| Fan-out completion time | < 5 seconds for 1M followers | Benchmark Kafka + Redis pipeline |
| Search indexing lag | < 30 seconds | Measure Kafka to ES pipeline |
| Trending computation | < 5 seconds refresh | Benchmark Redis aggregation |
| Snowflake ID generation | 4,096/ms/node (hard ceiling from 12 sequence bits) | Benchmark under contention |
| Tweet hydration (20 tweets) | < 20ms | Benchmark batch cache + DB |
| Rate limit check | < 1ms | Benchmark the sliding-window Lua script |
| Celebrity cache hit rate | > 90% | Monitor cache miss ratio |
| Elasticsearch query P99 | < 100ms (hot index) | Load test with real queries |

---
