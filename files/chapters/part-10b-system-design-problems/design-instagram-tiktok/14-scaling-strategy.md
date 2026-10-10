## Scaling Strategy

Scaling a global social media platform requires both horizontal scaling (more servers) and geographic distribution (servers closer to users). This section covers how to deploy the system across multiple regions and how to handle the feed generation bottleneck that emerges at hundreds of millions of users.

### Regional Deployment

A global user base requires deploying infrastructure in multiple regions to keep latency low. The CDN handles media delivery from 200+ edge locations, but API servers, databases, and caches must also be distributed. Each region operates semi-independently with its own Cassandra and Redis clusters, while data replicates across regions with eventual consistency. This means a user in Singapore gets sub-100ms API responses from the APAC region rather than 300ms+ round trips to US-East.

```
Global CDN: 200+ PoPs, media < 50ms latency
API Regions: US-East, EU-West (Frankfurt), APAC (Singapore)

Per-Region: 50 API servers, 20 Redis nodes, 12 Cassandra nodes (RF=3)
Media processing: ~1,500 spot transcode instances per region

Cross-Region:
  - Follows: replicated to all regions (eventual consistency)
  - Posts: replicated within 5 seconds
  - Feed cache: local per region
  - Media: CDN pulls from nearest S3 origin
```

### Feed Generation at Scale

The hybrid push/pull strategy described earlier becomes critical at scale. Pure fan-out on write would generate over a million Redis writes per second just for feed updates, and it completely breaks down for celebrity accounts. The hybrid model caps fan-out at 100K followers and switches to pull for larger accounts, keeping write amplification manageable while adding only ~50ms of latency per celebrity merged at read time.

```
Hybrid Strategy:

Push (fan-out on write) for users with < 100K followers:
  New post -> write to all followers' feed caches
  1,160 posts/sec x 1,000 avg followers = 1.16M Redis writes/sec

Pull (fan-in on read) for celebrities with 100K+ followers:
  Reader opens feed -> merge celebrity posts at read time
  ~50ms extra per celebrity

Merge at read time:
  1. Read pre-computed feed from Redis (push)
  2. Fetch each followed celebrity's recent posts
  3. Merge by score (recency + engagement)
  4. Return top N
```

---
