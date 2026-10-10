## Summary

The table below maps each system component to its technology choice and the reasoning behind it. In an interview, being able to justify why you picked a specific technology for each role demonstrates depth of understanding. Notice that the choices follow a pattern: write-heavy workloads go to Cassandra, read-heavy hot data goes to Redis, large binary objects go to S3 with CDN, and asynchronous workflows go through Kafka.

| Component | Technology | Why |
|-----------|-----------|-----|
| API Gateway | Go + NGINX | Rate limiting, auth, routing |
| Post storage | Cassandra | High write throughput, per-user partitioning |
| Feed cache | Redis sorted set | Fast range queries by score |
| Media storage | S3 + CloudFront | Scalable object store + CDN |
| Video processing | FFmpeg workers | Multi-quality transcoding |
| Notifications | Kafka + FCM/APNs | Async, fan-out |
| Search | Elasticsearch | Full-text + hashtag search |
| Analytics | Kafka + ClickHouse | High-volume event streaming |

**Scale numbers to remember:**
- 115,740 feed reads/sec average → Redis sorted set cache, <20ms
- 1,160 uploads/sec → presigned S3 URLs bypass API servers
- 100:1 read-to-write ratio → CDN and caching dominate the architecture
- 1.16M Redis writes/sec from fan-out → hybrid push/pull, cap at 100K followers
- 100TB photos + 1PB video uploaded daily → S3 Intelligent-Tiering
- 95%+ CDN hit rate → origin egress reduced from 50PB to under 2.5PB/day


---
