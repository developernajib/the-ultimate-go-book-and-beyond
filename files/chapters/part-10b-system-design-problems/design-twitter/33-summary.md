## Summary

This table provides a quick-reference mapping from each system component to the technology that powers it and the reason it was chosen. Use it as a cheat sheet when rehearsing your design, and make sure you can explain the reasoning behind each technology choice if asked.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Tweet storage | MySQL (sharded by user_id) | Primary source of truth |
| Timeline cache | Redis sorted set (Snowflake score) | Pre-computed feeds, <2ms read |
| Fan-out | Kafka → worker fleet | Async write amplification |
| Celebrity tweets | Per-celebrity Redis cache | Shared across all followers |
| Trending | Redis per-minute buckets + z-score | Breakout detection |
| Search | Elasticsearch (hot + archive) | Full-text tweet search |
| ID generation | Snowflake | Time-ordered, globally unique |
| Media | S3 + CDN | Photo/video storage |
| Notifications | Kafka + FCM/APNs | @mentions, likes, retweets |
| DMs | Separate service, encrypted at rest | Service-held keys, not end-to-end |

**Scale numbers to remember:**
- 5,787 tweets/sec average → Kafka absorbs burst, sharded MySQL handles writes
- 1.16M Redis writes/sec from fan-out → Redis Cluster, pipeline batching
- 1.28TB Redis memory for timelines → bounded by TTL + MaxTimelineSize=800
- <50ms search P99 → Elasticsearch hot tier keeps a ~2TB, 7-day working set in page cache
- Celebrities (>100K followers) → pull-on-read, not pushed to 10M timelines


---
