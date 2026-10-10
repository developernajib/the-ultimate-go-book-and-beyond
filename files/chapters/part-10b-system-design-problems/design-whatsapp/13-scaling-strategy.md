## Scaling Strategy

Scaling a messaging system to billions of users requires a different strategy for each component because they have different workload characteristics. Connection servers are stateful (each holds live WebSocket connections), so they scale by adding more servers and routing users via Redis presence lookups. The Chat Service and Media Service are stateless, so they scale horizontally behind a load balancer. Message storage in Cassandra scales by adding nodes to the cluster, which automatically redistributes data partitions.

| Component | Scaling Strategy | Target |
|-----------|-----------------|--------|
| Connection Servers | Stateful WS, 500K/server | 500M connections |
| Chat Service | Stateless, Kafka consumers | 1.16M msg/sec |
| Group Fan-out | Kafka consumer groups | 1024-member groups |
| Media Service | Presigned S3 URLs | ~10B uploads/day, 2PB/day |
| Offline Queue | Redis Cluster | 30-day retention |
| Push Notifications | Kafka workers | Millions/sec |
| Message Store | Cassandra | 100B msg/day |

### Connection Routing

The connection layer uses 1,000 servers globally, each handling up to 500,000 concurrent WebSocket connections. Redis stores a presence mapping (`presence:{user_id} → server_id`) so that any server can locate any user's connection in a single lookup. When a message must be delivered cross-server, the sending server publishes to the target server's Redis Pub/Sub channel (`server:{server_id}`), and the target server pushes the message to the local WebSocket. This avoids a centralized message broker for the hot path while keeping cross-server delivery under 10ms within a region.

### Cassandra Partitioning

Messages are partitioned by `conv_id` and clustered on `message_id DESC`, where `message_id` is a TimeUUID. Because the ID carries its own timestamp, one column serves as both the complete primary key that point updates address and the chronological sort key that history scans walk. Loading a chat history is therefore a single-partition sequential scan, which Cassandra serves in 2-5ms regardless of cluster size.

Unbounded partitions are the failure mode to watch. A busy 1,024-member group accumulates messages forever in one partition, and Cassandra's practical guidance is to keep partitions under roughly 100MB and 100,000 rows. Past that, compaction slows, repair gets painful, and a single wide partition can pin a hot spot onto one replica set that no amount of cluster growth relieves, because the partition is the unit of distribution. The standard remedy is bucketing the partition key by time, `(conv_id, month)` rather than `conv_id`, so each month is its own partition.

That is a real trade and not a free win, which is why the implementation earlier in this chapter keeps the simpler key. Bucketing makes "load the last 50 messages" potentially span two partitions when a month boundary falls inside the page, so the read path has to walk buckets backwards until it fills the page, and a conversation dormant since March costs several empty reads before it finds anything. You take that complexity when partition size demands it, not before. The 30-day TTL already bounds most conversations well under the limit, which is what makes deferring this defensible here.

---
