## Scaling Strategy

### Serving Architecture at 100K QPS

At 100K QPS, the critical insight is that short prefixes (one or two characters) are queried orders of magnitude more often than long ones, making them ideal CDN cache targets. Each origin server holds a full in-memory trie so any server can answer any request without cross-node coordination, and the trie is swapped atomically via a pointer update to avoid read locks during the rebuild cycle. The layered latency budget, CDN edge, load balancer, trie lookup, and Redis fallback, ensures the end-to-end P99 stays under 50ms even on cache misses.

```
Request Flow:
  Client types "go" -> HTTP GET /suggestions?prefix=go
  DNS -> Anycast to nearest PoP
  CDN edge: check cache (60% hit rate for short prefixes)
  Cache miss -> Load balancer -> Autocomplete server

Server Fleet:
  20 servers (5K QPS each)
  Each: in-memory trie (~15GB RAM) + Redis connection
  Stateless: any server handles any request

Trie Deployment:
  Rebuilt every 5 minutes from Redis frequency data
  Loaded in background, swapped atomically (pointer swap)
  Zero-downtime updates
  Rollback: keep previous trie in memory

Latency Budget:
  Network (client -> CDN): 20ms
  CDN -> origin: 10ms (cache miss)
  Server processing: 5ms (trie lookup)
  Redis (cache miss): 2ms
  Total P99: < 50ms
```

### Data Pipeline

The data pipeline decouples search event ingestion from trie construction by routing all events through Kafka first. Flink consumes from Kafka in parallel streaming windows, 5-minute windows for stable frequency aggregation and 1-minute windows for trending detection, and writes the results back to Redis sorted sets, which the trie builder then reads to rank suggestions. This separation means the serving tier is never blocked on aggregation work, and the pipeline can be reprocessed from Kafka's committed log if a Flink job fails mid-window.

```
Search events flow:
  Search Service -> Kafka ("search-events", 100K msg/sec)
    |
    +-- Flink: aggregate frequencies (5-min windows) -> Redis
    +-- Flink: trending detection (1-min windows) -> Redis
    +-- Flink: user history update -> Redis

Trie rebuild (every 5 min):
  1. Read top 50M terms from Redis sorted set
  2. Build new in-memory trie
  3. Precompute top-K for prefixes up to length 3
  4. Cache deeper prefixes in Redis
  5. Swap live trie pointer
```

---
