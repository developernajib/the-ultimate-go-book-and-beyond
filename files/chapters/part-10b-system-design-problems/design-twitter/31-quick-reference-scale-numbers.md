## Quick Reference: Scale Numbers

Memorize these numbers before your interview. Interviewers expect you to back up your design choices with concrete throughput, latency, and storage estimates. Being able to recite these from memory shows that you understand the system at a quantitative level, not just a conceptual one.

- 5,787 tweets/sec average, 17,000/sec peak
- 1.16M Redis writes/sec from fan-out
- 1.28TB Redis memory for 200M user timelines
- 800 tweet IDs per timeline, bounded by TTL + MaxTimelineSize
- Celebrity threshold: 100K followers (switch from push to pull)
- Elasticsearch hot index: ~2TB working set (7 days of tweets), held in page cache across the hot tier, not in heap
- Search P99: under 50ms for hot index
- Snowflake ID: 41 bits timestamp + 10 bits node + 12 bits sequence
- Trending: 60-minute sliding window with per-minute Redis buckets
- Fan-out batching: 1000 Redis ZADD per pipeline call


---
