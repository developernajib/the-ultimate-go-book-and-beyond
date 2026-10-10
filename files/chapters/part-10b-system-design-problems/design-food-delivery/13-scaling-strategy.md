## Scaling Strategy

### Horizontal Scaling

Each service scales independently based on its specific bottleneck. The Location Service needs the most instances because it handles 50K writes per second from driver GPS updates, while the WebSocket Tracking Service holds the most connections (roughly 250K concurrent at peak). The database layer uses a combination of PostgreSQL sharding for write distribution and read replicas for query offloading. Redis is split into separate clusters for different workloads (locations, dispatch state, caching) to prevent one workload from impacting another.

```
Service Scaling:
  Order Service:      10 instances, stateless, behind L7 load balancer
  Dispatch Service:   5 instances, each handles subset of geo regions
  Location Service:   20 instances (highest QPS: 50K writes/sec)
  Tracking WebSocket: 12 instances (~250K concurrent connections / 40K each, plus headroom)
  Restaurant Service: 5 instances

Database Scaling:
  PostgreSQL:
    - Orders DB: sharded by order_id hash (16 shards)
    - Read replicas for order history queries (3 replicas per shard)
    - Connection pooling with PgBouncer (200 connections per shard)

  Redis Cluster:
    - Driver locations: 6-node cluster, 3 masters + 3 replicas
    - Dispatch state: separate 6-node cluster
    - Cache: separate 6-node cluster
    - Total: ~18 Redis nodes

Kafka:
  - order-events: 32 partitions, 3 replicas
  - location-updates: 64 partitions (high throughput)
  - order-status-updates: 16 partitions
```

### Geographic Sharding

Food delivery is inherently local: a driver in San Francisco never delivers to a customer in New York. This makes geographic sharding a natural fit. Each metro area operates as a semi-independent unit with its own database shard, Redis cluster, and dispatch pool. This design reduces cross-region latency, simplifies scaling (add capacity per city as it grows), and provides natural fault isolation so that an outage in one city does not affect others.

```
Each city/metro area operates semi-independently:
  - Separate dispatch pools per metro
  - Driver location indexed per metro
  - Cross-metro orders rare (not supported)

Deployment:
  US-West: SF, LA, Seattle, Portland
  US-East: NYC, Boston, DC, Miami
  Each region: independent DB shard + Redis cluster

Failover:
  Primary region handles all traffic
  Secondary region: hot standby with async replication
  RTO: 2 minutes (DNS failover)
  RPO: ~5 seconds (async replication lag)
```

---
