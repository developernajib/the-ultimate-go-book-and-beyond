## Scaling Strategy

Scaling a Twitter-like system means handling different bottlenecks at different layers. The tweet database scales horizontally via sharding, timelines scale through Redis Cluster, and fan-out scales by adding more Kafka consumers. The table below maps each component to its scaling mechanism and the throughput target it must hit.

| Component | Scaling | Target |
|-----------|---------|--------|
| Tweet DB | MySQL sharded by user_id mod 256 | 5,787/sec |
| Timeline | Redis Cluster (1.28TB) | 30K reads/sec |
| Fan-out | Kafka consumers | 1.16M writes/sec |
| Celebrity Cache | Dedicated Redis | Shared across followers |
| Search | Elasticsearch hot+cold | Sub-50ms P99 |
| Trending | Redis per-minute buckets | Real-time z-score |
| IDs | Snowflake per DC | 4K/ms/node |

The hybrid fan-out strategy is the most critical scaling decision. Regular users with an average of 200 followers use push-based fan-out: when they tweet, the fan-out worker writes the tweet ID to each follower's Redis sorted set. This produces manageable write amplification (1.16M Redis writes/sec across the entire platform). Celebrities with more than 100,000 followers skip push entirely, their tweets are pulled at read time and merged into the timeline. Without this split, a single celebrity tweeting would trigger 10 million Redis writes, creating a burst that could overwhelm the cluster.

Each component in the table above scales independently. The tweet database shards by user_id to distribute writes evenly. The Redis timeline cluster is partitioned by user_id hash to spread memory across nodes. Kafka consumers scale horizontally by adding more workers to the consumer group, bounded by the partition count of the tweet topic: a consumer group can never run more useful workers than there are partitions, so partition for the fan-out you expect rather than the fan-out you have. Elasticsearch uses a hot/cold index split so that only the last 7 days of tweets need to stay resident in page cache for sub-50ms search.

---
