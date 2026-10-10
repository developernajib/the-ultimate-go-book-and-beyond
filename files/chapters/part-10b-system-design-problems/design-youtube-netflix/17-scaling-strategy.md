## Scaling Strategy

Each component of a video streaming platform scales differently depending on whether it is CPU-bound (transcoding), I/O-bound (streaming), or memory-bound (recommendations). The table below maps each component to its scaling approach and target capacity. The key insight is that no single scaling strategy works for the entire system, you need stateless horizontal scaling for APIs, queue-depth-driven auto-scaling for workers, and pre-computation with caching for recommendations.

| Component | Scaling Strategy | Target |
|-----------|-----------------|--------|
| Upload API | Stateless, auto-scale by CPU | 500hr/min |
| Transcoding | Spot instance fleet, SQS depth | 15,000 workers |
| Video metadata DB | MySQL read replicas | 100K QPS |
| CDN | 200+ global PoPs | 208 Tbps |
| Object storage | S3 cross-region replication | Exabyte-scale |
| Recommendation | Pre-compute + Redis cache | 11,574 QPS |
| View counting | Kafka + streaming aggregation | 1B events/day |
| Search | Elasticsearch (50+ nodes) | 500M videos |

### Sharding Strategy

**Video metadata (MySQL):** Sharded by `hash(video_id) mod 256` across 256 instances, roughly 2 million videos per shard at a 500M catalog. Note the `hash`: video IDs here are UUID strings, and a UUID has no `mod`. You need a hash function to get from an opaque identifier to a shard number, and which one you pick is a decision you are stuck with, since changing it reshuffles every row. Cross-shard queries such as "all videos by uploader X" go through a lookup table keyed by `uploader_id` that maps to the relevant `video_id` values, so the application queries a few shards directly instead of scattering to all 256. Scatter-gather across 256 shards makes your p99 the slowest of 256 machines, which is a very different number from the average of 256 machines.

**Watch history (Cassandra):** Partitioned by `user_id` with `watched_at` as the clustering key, so fetching a user's recent history is a single-partition read rather than a scan.

The trap here is that a partition keyed only by `user_id` grows for the life of the account and never stops. Cassandra partitions are not meant to grow without bound: compaction and read latency both degrade as a partition widens, and a heavy user over several years builds a partition that is genuinely painful. The fix is to add a time bucket to the partition key, which the extended data model later in this chapter does. Bring this up before an interviewer does, because "partitioned by user_id" is the answer everyone gives and the wide-partition follow-up is what separates the people who have run Cassandra from the people who have read about it.

**CDN Multi-Tier:** Delivery falls through a hierarchy: browser cache, then an ISP-embedded cache (Netflix Open Connect appliances, or YouTube's edge nodes inside ISP networks), then a regional mid-tier cache, then origin object storage. With roughly 95% of requests terminating at or before the ISP tier, origin egress drops from 208 Tbps to something on the order of 10 Tbps. Look at what that ratio is really buying: the ~5% that reaches origin is the long tail, the content nobody else in that region wanted. The economics of the entire platform rest on the other 95% never leaving the ISP's building.

---
