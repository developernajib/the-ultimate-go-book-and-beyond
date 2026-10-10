## Scaling Strategy

The central challenge in scaling a stock exchange is that the matching engine is stateful and order-sensitive, you cannot simply add nodes and load-balance across them, because two orders for the same symbol must be processed in strict sequence. The solution is deterministic symbol partitioning: `hash(symbol) % node_count` routes all orders for a given ticker to exactly one goroutine on one node, eliminating cross-symbol lock contention entirely and allowing linear horizontal scaling. Be ready for the follow-up on that modulo, though. Changing `node_count` remaps almost every symbol at once, and each remapped symbol is a live order book that has to be drained, moved, and restarted somewhere else. Exchanges therefore treat the symbol-to-node map as versioned configuration changed between sessions, not as something that reshuffles while the market is open. The order gateway remains stateless and uses persistent TCP connections per broker to amortize connection overhead at high order rates. Market data is split by client type, multicast UDP for co-located HFT firms that need microsecond latency, and WebSocket via CDN for retail clients where millisecond batching is acceptable, because a single delivery mechanism cannot efficiently serve both latency profiles simultaneously.

```
Matching Engine:
  - 1 goroutine per symbol (10K goroutines), no cross-symbol contention
  - 10 nodes x 1000 symbols each = 1M orders/sec
  - Deterministic routing: hash(symbol) -> node

Order Gateway: Stateless, L4 LB, persistent TCP per broker, 1000 orders/sec/trader limit

Market Data: Multicast UDP for co-located HFT, WebSocket via CDN for retail, 10ms batch updates

WAL: NVMe SSD (<50us/write), replicated via Kafka, 10s snapshots, <30s recovery

Database: PostgreSQL partitioned by date, read replicas for reporting
```

---
