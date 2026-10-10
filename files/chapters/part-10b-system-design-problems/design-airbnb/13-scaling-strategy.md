## Scaling Strategy

### Database Scaling

As the platform grows, a single database instance cannot handle the load from 7 million listings and millions of daily queries. This section outlines how each storage layer is horizontally scaled. PostgreSQL is sharded by primary key hash to distribute write load evenly, with read replicas handling the query volume. Elasticsearch uses its native sharding and replication for search, with Change Data Capture (CDC) keeping the search index in sync with the source-of-truth database. Redis is clustered for both availability caching and the atomic booking-hold operations that require `SETNX` guarantees.

```
PostgreSQL Sharding:
  Listings DB: sharded by listing_id hash (8 shards)
    - Each shard: ~875K listings
    - Read replicas: 3 per shard

  Bookings DB: sharded by booking_id hash (4 shards)
    - Each shard: ~250K bookings/day

Elasticsearch:
  Listings index: 10 shards, 2 replicas
  CDC via Debezium -> Kafka -> ES indexer
  Latency: ~5 seconds from DB write to searchable

Redis:
  Availability cache: 6-node cluster
  Booking holds: same cluster (SETNX atomicity)
  Session store: separate 4-node cluster

CDN:
  Listing photos: CloudFront, ~50M images
  TTL: 1 year (immutable, versioned by URL)
```

### Request Flow Optimization

Understanding the end-to-end request flow helps you identify where latency hides and where caching has the most impact. The search path is optimized for speed, a CDN absorbs 40% of repeat queries, Elasticsearch handles the geo-filtering, and Redis caches listing details with an 80% hit rate, bringing P99 latency to around 200ms. The booking path prioritizes correctness over speed, it involves a Redis hold, a Stripe authorization call (the slowest step at roughly one second), and a PostgreSQL write, resulting in about 2 seconds P99 end-to-end.

```
Search Query Path (8,680 QPS):
  1. CDN: cache popular searches for 30s (absorbs 40%)
  2. Elasticsearch: geo + filter query
  3. Availability check: batch PostgreSQL query
  4. Listing details: Redis cache (80% hit rate)
  5. Response: ~200ms P99

Booking Path (11.5/sec):
  1. Availability hold: Redis SETNX
  2. Price calculation: in-memory
  3. Payment authorization: Stripe (~1s)
  4. Availability confirm: PostgreSQL INSERT
  5. Response: ~2s P99
```

---
