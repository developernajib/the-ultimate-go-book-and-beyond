## Extended Architecture: Multi-Region Deployment

A global platform like Twitter must serve users from data centers close to them to keep latency low. The multi-region architecture below routes reads to local replicas and caches in each region, while all writes funnel to a single primary region (US-East) to avoid cross-region write conflicts. Kafka MirrorMaker replicates events across regions so that each region's fan-out workers and search indexers can operate independently from a local Kafka cluster.

Name the bill this design runs up, because "single write region" sounds free and is not. A user in Singapore posting a tweet pays a round trip to Virginia, so their write is slow while everyone else's read is fast. That is usually the right trade for a read-heavy product, and it is the right trade only because reads outnumber writes here. Fan-out running in every region also means every region caches timelines for the users it serves, so the 1.28TB is per region for that region's active users rather than a single global pool. And a US-East outage costs the platform writes globally, not just locally, which is the price of dodging multi-primary conflict resolution. The alternative, partitioning users by home region with writes local to each, removes the latency and the single point of failure and hands you cross-region follow edges to reconcile instead. Neither is free. Pick the failure you would rather operate.

```
                    Global DNS (latency-based routing)
                           |
          +----------------+----------------+
          v                v                v
   +--------------+ +--------------+ +--------------+
   |  US-East     | |  EU-West     | |  AP-South    |
   |              | |              | |              |
   |  API Gateway | |  API Gateway | |  API Gateway |
   |  Tweet Svc   | |  Tweet Svc   | |  Tweet Svc   |
   |  Timeline Svc| |  Timeline Svc| |  Timeline Svc|
   |  MySQL Shards| |  MySQL RR    | |  MySQL RR    |
   |  Redis Cache | |  Redis Cache | |  Redis Cache |
   |  ES Cluster  | |  ES Cluster  | |  ES Cluster  |
   |  Kafka       | |  Kafka       | |  Kafka       |
   +--------------+ +--------------+ +--------------+
          |                |                |
          +--------+-------+-------+--------+
                   v               v
            MySQL Primary    Kafka MirrorMaker
            (US-East)        (cross-region)

Writes: routed to US-East primary MySQL (cross-region replication)
Reads: served from local Redis cache and MySQL read replicas
Search: per-region ES cluster (indexed from local Kafka)
Trending: per-region computation (regional trends)
Fan-out: runs in all regions from local Kafka consumers
```

---
