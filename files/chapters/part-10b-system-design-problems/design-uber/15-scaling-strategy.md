## Scaling Strategy

Scaling a ride-sharing platform requires different strategies for different components because each has a unique load profile. The location service is write-heavy (millions of GPS updates per second), so it uses Redis Cluster partitioned by geographic region. The matching service is CPU-heavy but stateless, so it scales horizontally by simply adding more instances. The trip database needs strong consistency for financial records, so it uses sharded PostgreSQL with careful partition keys.

| Component | Scaling | Target |
|-----------|---------|--------|
| Location | Redis Cluster by region | 1.25M writes/sec |
| Matching | Stateless | Sub-1s matching |
| Trip DB | PostgreSQL partitioned by region | 115 trips/sec avg, ~350/sec peak |
| Payment | Stripe + idempotency | 115 payments/sec avg |
| Surge | Redis per-H3-cell | Real-time pricing |
| ETA | Traffic cache + routing API | 5,787 QPS |
| WebSocket | 200 servers x 40K | 8M connections |

Note how wide that range is. Location writes at 1.25M/sec and payments at roughly 115/sec are separated by four orders of magnitude, in the same product, driven by the same users. This is the whole argument for splitting these into separate services: a design that scales them together buys payment-grade durability for GPS pings, or GPS-grade looseness for money, and both are wrong.

### Geographic Partitioning

Geographic partitioning is the most natural sharding strategy for a ride-sharing platform because rides are inherently local: a rider in Tokyo will never be matched with a driver in London. Each shard runs as a fully independent system with its own Redis instance, matching service, and surge pricing engine.

Partition by market (city or metro), not by a uniform global grid. Tiling the planet with equal-area H3 cells is a tempting mistake, and the numbers show why: resolution 4 cells average 1,770 km² apiece, so covering just the land surface takes on the order of a hundred thousand of them, and the overwhelming majority would hold no drivers and no riders ever. Demand is clustered in cities, so the shards should be too. Give each market its own shard, then split a dense market by H3 cell when it outgrows one instance, which puts capacity where the load actually is instead of spreading it evenly over the ocean.

Cross-shard coordination is needed only near boundaries, where the gateway queries both adjacent shards and picks the best result. One rule keeps this safe: a driver is owned by exactly one shard at a time, and only the owning shard may write their trip assignment. Two shards that can both claim the same driver reintroduce the double-booking race that the active-trip index exists to prevent, and no amount of gateway logic will fix it, because the two writes never meet.

---
