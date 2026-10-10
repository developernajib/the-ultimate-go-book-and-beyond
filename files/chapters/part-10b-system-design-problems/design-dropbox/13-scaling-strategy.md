## Scaling Strategy

As the system grows to hundreds of petabytes and hundreds of millions of daily users, you need a clear strategy for scaling both storage and metadata independently. The storage tier uses S3's built-in scalability with lifecycle policies to automatically move infrequently accessed blocks to cheaper storage classes. The metadata layer uses horizontal sharding by `owner_id` so that each user's file tree lives entirely on one shard, avoiding cross-shard queries for the most common operations.

### Storage Tier Architecture

S3 lifecycle policies automatically transition blocks between storage tiers based on access patterns. This is critical for cost optimization because the majority of stored data is rarely accessed, yet must remain available. The tiering below reduces storage costs by roughly 60% compared to keeping everything in S3 Standard.

```
Hot Storage (S3 Standard):    blocks accessed in last 30 days (~20%)
Warm Storage (S3 IA):         blocks accessed 30-90 days ago (~30%)
Cold Storage (S3 Glacier):    old file versions >90 days (~50%)

Lifecycle:
  Block not accessed 30 days -> IA
  File version older than 90 days -> Glacier
  Deleted file blocks after 30 days -> GC eligible
  Block referenced by active file -> never Glacier
```

### Metadata Database Scaling

Sharding PostgreSQL by `owner_id` ensures that all metadata operations for a single user (listing files, committing versions, querying changes) hit a single shard with no cross-shard joins. The notification layer uses a Redis cluster where each node handles roughly 3 million Pub/Sub channels, keeping the per-node memory footprint manageable.

```
PostgreSQL Sharding:
  Shard key: owner_id
  64 shards, ~11M users per shard
  Each shard: ~8B file_nodes (500B files / 64), ~4TB metadata
  Partition file_nodes within each shard to keep indexes manageable
  Read replicas: 2 per shard

Notification Service:
  Redis Pub/Sub: 10-node cluster
  100M DAU -> ~30M concurrent sync connections
  Each Redis node: ~3M Pub/Sub channels
```

---
