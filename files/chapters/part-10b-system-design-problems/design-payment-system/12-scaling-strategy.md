## Scaling Strategy

Scaling a payment system requires careful planning because you cannot tolerate data loss or inconsistency. The strategy below outlines how each component scales independently. Stateless API servers scale horizontally behind a load balancer, while PostgreSQL uses synchronous replication for zero data loss and monthly partitioning for manageable table sizes. Redis handles the high-throughput, low-latency workloads like idempotency checks and fraud velocity counters, and the ML-based fraud service runs on dedicated GPU instances to meet its strict latency budget.

```
Payment Service: 20 stateless instances, 250 TPS each = 5K TPS peak
PostgreSQL: Primary + sync replica (zero data loss), partitioned by month, PgBouncer pooling
Redis Cluster: 6 nodes, idempotency cache (~100M keys in the 24h TTL
               window, ~500B each = ~60GB, ~10GB/node), fraud velocity counters
Fraud ML: gRPC service on GPU cluster, <50ms P99, weekly retraining
Settlement: Nightly batch per processor, reconcile ledger vs processor statements
```

Check the Redis sizing rather than inheriting it, because it is the number most often wrong by an order of magnitude. The cache holds one entry per transaction for the length of the TTL, so at 100M transactions a day and a 24-hour TTL the steady-state population is roughly a full day of transactions, about 100M keys, not the few million people tend to guess. At the ~500 bytes of a serialized transaction that is ~60GB, which is why this is a 6-node cluster rather than a single instance. Note what a wrong estimate here would actually cause: undersize the cluster and Redis begins evicting under memory pressure, evicted keys read as cache misses, and a cache miss on this path means a retry gets processed as a new payment. The `UNIQUE` constraint in PostgreSQL still catches it, which is exactly why that constraint carries the guarantee rather than Redis.

---
