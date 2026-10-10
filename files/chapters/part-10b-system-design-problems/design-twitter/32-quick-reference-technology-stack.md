## Quick Reference: Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| ID Generation | Snowflake (custom 64-bit) | Time-ordered, no DB coordination |
| Tweet Storage | MySQL (sharded by user_id) | Strong consistency for writes |
| Timeline Cache | Redis Cluster (sorted sets) | Sub-2ms reads, 1.28TB total |
| Event Bus | Kafka (256 partitions) | Decouple write path from fan-out |
| Search | Elasticsearch (hot + archive) | Full-text with sub-50ms P99 |
| Trending | Redis (per-minute buckets) | Atomic ZINCRBY, sliding window |
| Media | S3 + CDN + presigned URLs | Offload binary from API servers |
| Rate Limiting | Redis (sorted set sliding window) | Sub-1ms check per request |
| Push Notifications | FCM / APNs via Kafka consumer | Async delivery, batched for viral |
