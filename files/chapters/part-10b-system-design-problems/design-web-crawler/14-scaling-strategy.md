## Scaling Strategy

Scaling a web crawler is fundamentally about parallelism constrained by politeness. You can add as many workers as you want, but you still cannot send more than one request per second to any single domain. The key insight is that the internet has millions of domains, so you achieve high throughput by crawling many domains in parallel, not by hammering individual domains faster.

### Horizontal Scaling

The numbers below show how the system scales from the base configuration of 200 workers up to 1,000 workers. Each layer, Kafka partitions, storage, and deduplication infrastructure, scales independently based on its specific bottleneck.

```
Worker Scaling:
  Base: 200 workers (10K pages/sec)
  Each: 50 concurrent goroutines, 50 req/sec
  Scale to 1000 workers + 5000 partitions = 50K pages/sec

Kafka: 1000 partitions (one per domain group)
  Each partition: ~10 domains in flight, ~1M queued URLs
  1000 x 10 domains x 1 req/sec = 10K pages/sec ceiling
  Consumer group handles worker join/leave

Storage:
  Raw HTML: S3 Standard (30 days), Glacier (older)
  Compressed: 10B x 20KB = 200TB
  Metadata: PostgreSQL, 16 shards by domain hash
  URL Dedup: Bloom filter 12GB + Redis ~1TB (20 nodes x 50GB)
```

**Partitions are the throughput ceiling, not workers.** This is the detail that makes the "scale to 1000 workers" line a trap. A domain lives on exactly one partition, and a partition is consumed by exactly one worker, so the number of domains in flight is set by the partition count, not the worker count. At 1000 partitions the system tops out at 10K pages/sec no matter how many workers you deploy: adding workers past 200 just gives each one fewer partitions and less to do, and past 1000 workers the extras get zero partitions and sit idle. Reaching 50K pages/sec means going to 5000 partitions *and* 1000 workers. Since Kafka can add partitions but never remove them, and repartitioning moves domains between workers, this is a number to size generously up front.

**On the Redis figure.** That store is the exact seen-set that the key design decisions section prices at 1TB for 10 billion URLs, so it costs 1TB here too, not the 160GB an earlier estimate suggested. 160GB across 10 billion keys works out to 16 bytes per key, which is the size of the hash alone with nothing left for the key string, the value, the expiry, or Redis's own per-key overhead, and those run 50 to 100 bytes per entry. The Bloom filter is what costs 12GB. The exact store behind it does not get to be cheap, which is the whole reason the Bloom filter exists.

### Politeness at Scale

Maintaining politeness while achieving 10,000 requests per second requires a two-tier rate limiting strategy. The local in-memory token bucket handles the fast path (99% of checks), while a Redis-based distributed limiter catches edge cases that occur during Kafka consumer group rebalances when domain ownership temporarily overlaps between workers.

```
Challenge: 10K req/sec total, max 1 req/sec per domain

Solution: Domain-partitioned processing
  1000 Kafka partitions, ~10 domains in flight each
  Worker enforces 1 req/sec per domain within partition

Rate Limiter:
  L1: Local token bucket per domain (in-memory, fast)
  L2: Redis-based distributed limiter (cross-worker safety)
  L1 handles 99%, L2 catches edge cases during rebalance
```

The L2 limiter is not belt-and-braces, it is the thing that makes L1 legitimate. L1 is authoritative only while exactly one worker owns a domain, and during a consumer group rebalance that invariant breaks: the old owner may still be finishing in-flight work as the new owner starts, and both hold their own L1 bucket for the same domain. For that window, only a shared counter can enforce the limit. Since rebalances are rare, L2 sees traffic in the low single-digit percent of fetches, which is exactly why paying its round trip on every fetch would be wasteful and skipping it entirely would be a politeness violation you cannot see in testing.

---
