## Capacity Estimation

Before diving into the design, you need to understand the scale of the system. Capacity estimation drives decisions about data structures, caching layers, and infrastructure. The numbers below show that the entire trie fits comfortably in memory, but precomputed top-K results per prefix dominate storage, which is why a tiered caching strategy becomes essential.

```
QPS:                100K requests/sec
Avg query length:   5 chars → 5 prefix requests per final query
Unique terms:       50M unique search terms
Storage:
  Terms:            50M × 50 bytes avg = 2.5GB in-memory trie
  Counts:           50M × 8 bytes (int64) = 400MB
  Top-K per prefix: Cache top 10 per prefix → 50M × 10 × 30 bytes = 15GB
Response size:      10 suggestions × 50 bytes = 500 bytes
Network:            100K × 500B = 50MB/sec
```

---
