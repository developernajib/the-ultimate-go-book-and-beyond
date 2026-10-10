## Extended Capacity Planning

This section provides detailed infrastructure sizing calculations that go beyond the initial back-of-envelope estimates. These numbers help you answer the interviewer's question "how many servers do you need?" with concrete, defensible figures. Pay attention to how each component's sizing is derived from the traffic numbers established in the Capacity Estimation section. This chain of reasoning from user behavior to infrastructure requirements is exactly what interviewers want to see.

```
Instagram/TikTok scale numbers:

Storage growth:
  Photos: 50M uploads/day x 2MB avg = 100TB/day
  Videos: 50M uploads/day x 20MB avg = 1PB/day
  After transcoding (4 qualities): 4PB/day
  After 1 year: ~2EB total storage (originals + variants)
  With CDN caching: origin serves ~5% of requests

Cassandra cluster sizing:
  Posts table: 100M inserts/day = 1,160/sec
  Per-user partition: avg 500 posts per user
  Total: 500M DAU x 500 = 250B posts
  Replication factor: 3
  Cluster: 36 nodes (12 per DC, 3 DCs)
  Per node: ~21B rows incl. RF=3 replicas (~300B metadata each), ~6TB SSD

Redis cluster sizing:
  Feed cache: 300M active feeds x 20 posts x 50 bytes = 300GB
  Like counters: 1B posts x 16 bytes = 16GB
  View HLLs: 10M active posts x 12KB = 120GB
  Story sets: 100M active stories x 200 bytes = 20GB
  Total: ~500GB across 60 Redis nodes (20 per region)

API server fleet:
  300K req/sec / 2000 req/sec per server = 150 servers
  Per region: 50 servers (3 regions)
  Instance type: c6g.2xlarge (8 vCPU, 16GB)

Media processing workers:
  Video transcode: 30 seconds per video x 4 qualities = 2 min
  50M videos/day / 86,400 sec = ~580 videos/sec arriving
  At 2 min each (Little's law): ~70K concurrent transcode slots
  Using spot instances: ~4,400 c6g.4xlarge with 16 concurrent FFmpeg each
  Cost: ~$25K/day for transcoding compute at spot pricing
```
