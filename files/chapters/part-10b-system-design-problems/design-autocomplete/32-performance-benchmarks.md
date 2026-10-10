## Performance Benchmarks

These benchmarks give you concrete numbers to validate your design against the latency budget. In-memory trie lookups complete in single-digit microseconds regardless of prefix length, confirming that the trie is not the bottleneck. The end-to-end numbers show that personalization adds measurable overhead due to the Redis round-trip for user history, which is why the system targets 5K QPS per server with personalization enabled versus 8K without.

```
Benchmark results on r6g.xlarge (4 vCPU, 32GB), the serving instance type:

Trie.Search (in-memory):
  Prefix length 1:  ~2us per lookup
  Prefix length 3:  ~3us per lookup
  Prefix length 6:  ~4us per lookup
  Prefix length 10: ~5us per lookup

Redis cache lookup:
  Single GET:        ~0.5ms
  Pipeline (10 GET): ~0.8ms total

End-to-end HTTP request:
  Cache hit (CDN):      ~5ms
  Cache hit (Redis):    ~8ms
  Cache miss (trie):    ~12ms
  Cache miss + personalization: ~15ms

Trie rebuild (50M terms):
  Build time:      ~45 seconds
  Memory usage:    ~15GB
  Top-K precompute (3-char prefixes): ~30 seconds

Throughput per server:
  Without personalization: 8,000 req/sec
  With personalization:    5,000 req/sec
  Bottleneck: Redis RTT for personalization
```
