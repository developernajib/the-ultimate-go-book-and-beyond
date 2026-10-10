## Quick Reference: Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Raw Upload | S3 via presigned URL | Bypass API servers for large files |
| Transcoding | FFmpeg on EC2 Spot / Lambda | CPU-intensive, stateless, cost-optimized |
| Job Queue | SQS | At-least-once delivery, auto-retry on worker crash |
| Video Storage | S3 Intelligent-Tiering | Hot/cold separation for long-tail content |
| Manifest | HLS (.m3u8), CMAF fMP4 segments | Universal player support, one segment set serves HLS and DASH |
| CDN | CloudFront / ISP-embedded appliances | 200+ PoPs, 95%+ cache hit rate, egress dominates cost |
| Metadata DB | MySQL (sharded, Vitess) | Strong consistency for video records, horizontal scale |
| Watch History | Cassandra / Bigtable | High-write time-series, partition by user AND time bucket |
| Recommendations | Two-stage pipeline + Redis cache | Cheap candidate generation, then a ranker predicting watch time |
| View Counting | Kafka -> Flink -> MySQL | Eventually consistent, 30-second batching |
| Search | Elasticsearch | Full-text on title/description/tags |
| DRM | Widevine / FairPlay | Content encryption for premium titles |
| Analytics | Kafka -> ClickHouse | Real-time creator dashboards |

---
