## Scaling Strategy

Scaling a search engine to 100K queries per second requires horizontal scaling at every layer. Each component uses a different strategy depending on its workload characteristics: crawlers scale by adding more workers, the index scales by adding more shards, and query processing scales by replicating the scatter-gather coordinators behind a load balancer. The table below summarizes the approach and target capacity for each component.

| Component | Scaling Strategy | Target |
|-----------|-----------------|--------|
| Crawlers | 50K distributed workers | 41K pages/sec |
| URL Frontier | Redis sorted set | 50B URLs |
| Index Shards | 1000+ machines | 1PB index |
| Query Processing | Scatter-gather | 100K QPS |
| PageRank | Pregel-style computation | 50B nodes |
| Autocomplete | Distributed trie | Sub-50ms |
| Delta Index | Per-region hot index | 1B pages/day |

Document-based sharding (not term-based): each shard holds all documents for its partition, every query fans out to all shards.

---
