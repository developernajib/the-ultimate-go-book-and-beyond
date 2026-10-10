## Common Interview Follow-Ups

These are the most frequently asked follow-up questions after presenting an Instagram/TikTok design. Each answer demonstrates depth beyond the high-level architecture. Practice delivering these in under 60 seconds each.

**Q: How do you handle the celebrity problem (Kylie Jenner with 400M followers)?**

For celebrities with more than 100,000 followers, skip fan-out on write entirely: pushing a single post to 400 million feed caches would generate 400 million Redis writes and take minutes to complete. Instead, mark accounts as "celebrity" when their follower count crosses the threshold. On feed read, the feed service merges two sources: the pre-computed push cache (containing posts from regular accounts the user follows) and a pull query for each followed celebrity's recent posts. Celebrity timelines are cached per-celebrity (not per-follower), so one Redis key serves all 400 million followers. The merge adds approximately 50ms per celebrity at read time, but the per-celebrity pulls execute in parallel, so even a user following 10-20 celebrities sees well under 200ms of added latency.

---

**Q: How do you implement the algorithmic feed?**

The ranking model scores each candidate post using multiple signals: recency (time decay function), engagement rate (likes plus comments divided by views), author relationship strength (how frequently the viewer interacts with this author via likes, comments, and profile visits), content type preference (does this user watch more videos or photos?), and topic affinity (computed from hashtag overlap between the user's liked posts and the candidate). The model is trained offline on click-through and engagement data, then deployed as a lightweight scoring function. For TikTok-style discovery feeds, the system pre-computes a pool of a few hundred high-quality candidates from trending and collaborative filtering sources, then ranks them using real-time signals (current session engagement, time of day) to serve the top N.

---

**Q: How do you handle hot content (viral post)?**

Viral posts create two problems: read amplification (millions of users fetching the same post metadata) and write amplification (millions of likes arriving per minute). For reads, use tiered caching: Redis stores the full post JSON with a 5-minute TTL, and the CDN caches media files with a 1-year TTL since media is immutable. For write amplification on likes, use a coalescing buffer: accumulate likes in a Redis counter and flush to Cassandra in batches of 1,000 (one database write per 1,000 likes instead of 1,000 individual writes). For unique viewer counting, HyperLogLog provides approximate counts with 0.81% error using only 12KB of memory per post, regardless of how many millions of viewers interact with it.

---

**Q: How do you implement Stories (24h expiry)?**

Cassandra handles storage with a per-row TTL of 86,400 seconds (24 hours), which means expired stories are automatically removed during compaction without any cleanup job. A Redis sorted set (`stories:{user_id}`) with expiry timestamps as scores enables fast retrieval of a user's active stories in chronological order. Expired entries are pruned from Redis using `ZREMRANGEBYSCORE` with the current timestamp as the threshold. CDN caches story media with `Cache-Control: max-age=86400` aligned to the expiry window. For story ordering (unviewed stories first), the viewed status is tracked client-side by storing seen story IDs locally, which avoids billions of server-side "mark as viewed" writes per day.

---

**Q: How do you implement content moderation at 100M uploads per day?**

Content moderation runs as an asynchronous pipeline stage between upload and publication. Every uploaded image or video passes through an ML-based classifier (e.g., AWS Rekognition or a custom model) that detects nudity, violence, hate speech in text overlays, and copyright violations. The classifier returns a confidence score: posts above 95% confidence are auto-rejected, posts between 70-95% are queued for human review, and posts below 70% are auto-approved. This three-tier approach ensures that human moderators review only borderline cases (roughly 2-5% of uploads). The moderation service runs as a separate SQS consumer group, decoupled from the main processing pipeline, so moderation latency does not delay thumbnail generation or transcoding.

---
