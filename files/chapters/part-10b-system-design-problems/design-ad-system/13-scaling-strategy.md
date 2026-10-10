## Scaling Strategy

Scaling an ad system to handle millions of auctions per second requires careful planning at every layer. The key insight is that the auction servers must be stateless so you can horizontally scale them behind a load balancer. All shared state (budgets, targeting indexes, frequency caps) lives in Redis, which is sharded across multiple nodes for both throughput and memory capacity. The event pipeline uses Kafka with many partitions to parallelize downstream processing. This section breaks down the concrete numbers for each tier.

```
Auction Servers:
  - Stateless, ~1,000 servers behind L4 LB = 11.6M auctions/sec
  - ~12K auctions/sec per server: each auction holds ~80ms of DSP fan-out,
    so ~1,000 auctions in flight × ~10 DSP goroutines each per server
  - Health: P99 < 80ms or auto-drain

Budget Service (Redis Cluster):
  - 32 shards, 32GB each, 500K ops/sec per shard = 16M ops/sec headroom
  - Lua scripts for atomic budget deduction
  - Read replicas for CanSpend() pre-filtering

Event Pipeline (Kafka):
  - 128 partitions impressions, 64 partitions clicks
  - Consumer groups: ClickHouse writer, fraud detector, billing

ClickHouse: 24-node cluster (12 shards x 2 replicas), ~500K rows/sec
  per shard with large batched inserts = ~6M rows/sec, plus Kafka
  buffering and pre-aggregation to absorb the 11.6M/sec raw peak

CDN: Creative assets via Cloudflare/Akamai, content-addressable cache keys

Multi-Region: US-East, EU-West, APAC, auction servers in all regions
```

---
