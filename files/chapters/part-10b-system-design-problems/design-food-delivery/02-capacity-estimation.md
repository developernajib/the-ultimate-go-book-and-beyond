## Capacity Estimation

Before diving into architecture, you need to understand the scale you are designing for. Capacity estimation helps you choose the right databases, determine how many service instances to run, and identify which components will face the heaviest load. The numbers below drive every downstream decision, from Redis cluster sizing to Kafka partition counts.

```
Orders/day:         1M → 12/sec avg, 50/sec peak (dinner rush: 6-9 PM)
Restaurants:        500K active partners
Drivers online:     200K at peak
Location updates:   200K drivers × 1 update/4sec = 50K writes/sec
Customer tracking:  50/sec × ~40 min lifespan = ~120K in-flight orders at peak
                    × 2 parties = ~250K WebSocket conns
Order value avg:    $35 → $35M GMV/day
```

The location update rate (50K writes per second) is the highest-throughput workload in the system and determines Redis cluster sizing. A single Redis node handles approximately 100K operations per second, so a 6-node cluster with 3 masters provides sufficient headroom. The WebSocket connection count comes from Little's law: 50 orders per second at peak times a roughly 40-minute order lifespan gives about 120K in-flight orders, and with both the customer and the driver connected that is roughly 250K concurrent connections. At 40K connections per server, about 8 instances carry the load, provision 12 for failure headroom.

The order rate at peak (50/sec) is modest compared to the location service, which means PostgreSQL can handle order writes with a well-indexed single instance during the current scale. However, sharding by order_id hash (16 shards) is necessary once daily order volume exceeds 5M, because the order history table grows linearly and index scan times degrade.

The search QPS is the other bottleneck to consider. With 25M DAU browsing restaurants, assume 10 searches per session and 30% of users active during the dinner peak. That is approximately 75M searches concentrated in 3 hours, or roughly 7,000 searches per second. Redis GEO handles this comfortably, but Elasticsearch is needed for full-text search with cuisine and rating filters.

---
