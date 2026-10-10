## Caching Strategy

A multi-layer caching strategy is essential for a platform serving 115K+ requests per second. Each layer serves a different purpose: the application-level in-memory cache avoids network round trips for the hottest data, Redis provides a shared distributed cache for feed lists and counters, and the CDN caches media files at edge locations worldwide. The TTL values at each layer balance freshness against load reduction. Cache invalidation is event-driven, meaning updates to posts or follows trigger targeted cache deletions rather than blanket expiration.

**L1: Application Cache (in-memory, per server).** Each API server maintains a local LRU cache for the hottest data, avoiding network round trips to Redis entirely. User profiles for the top 1,000 most-accessed users (typically celebrities and influencers whose profiles appear in millions of feeds) are cached with a 5-minute TTL. Post metadata for the top 10,000 hot posts uses a 2-minute TTL, short enough that like count updates appear within 2 minutes while eliminating millions of Redis lookups per minute.

```
L1: Application Cache (in-memory, per server)
  - User profiles: 1K most-accessed, 5min TTL
  - Post metadata: 10K hot posts, 2min TTL
```

**L2: Redis Cluster.** The distributed cache layer handles shared state that must be consistent across all API servers. Feed lists are stored as Redis sorted sets with ranking scores, allowing O(log N) insertion and O(log N + M) range reads for pagination. Like counts use a write-through pattern: every like increments both the Redis counter (for real-time display) and the Cassandra counter (for durability). Sessions use a 24-hour TTL to automatically log out inactive users. Story lists have the shortest TTL (1 minute) because new stories are posted frequently and stale story lists cause visible UI inconsistencies.

```
L2: Redis Cluster
  - Feed lists: sorted set by score, 30min TTL
  - Like counts: cached counter, write-through
  - Session data: user sessions, 24h TTL
  - Hot posts: complete JSON, 5min TTL
  - Story list: {user_id} → [story_ids], 1min TTL
```

**L3: CDN (CloudFront / Akamai).** Media files are served from 200+ edge locations worldwide. Photos and videos are immutable once uploaded (edits create new objects rather than overwriting), so they use a 1-year TTL with content-addressed URLs (the URL contains a hash of the content). This means the CDN never needs to check with the origin for freshness: if the URL matches, the content is guaranteed correct. The CDN handles over 95% of media traffic, reducing origin S3 egress from 50 petabytes per day to under 2.5 petabytes.

```
L3: CDN (CloudFront / Akamai)
  - Media files: photos, videos, thumbnails
  - TTL: photos 1yr (immutable), videos 1yr
  - Origin: S3 / GCS
```

**Cache Invalidation.** Invalidation is event-driven rather than TTL-based for user-visible consistency. When a user edits a post caption, the post service publishes an event that triggers deletion of `post:{id}` from Redis, forcing the next read to fetch from Cassandra. When a user follows someone new, the feed service asynchronously rebuilds the follower's feed cache by merging the new author's recent posts. New post creation triggers the fan-out pathway described in the Feed Generation section, which writes directly to follower feed caches rather than invalidating them.

```
Cache Invalidation:
  - Post update → delete post:{id}
  - Follow → rebuild feed:{follower_id} async
  - New post → fan-out to follower feeds (or pull on read)
```

---
