## Common Mistakes and How to Avoid Them

These are the most frequent errors candidates make when designing Twitter in an interview. Each mistake usually stems from not thinking through the scale implications. Review this list before your interview and make sure your design avoids every one of them.

1. **Fan-out to ALL including celebrities**, pushing a single tweet to 10M+ follower timelines creates massive write amplification. Use pull-on-read for users above 100K followers.
2. **Auto-increment IDs**, creates a single-shard write bottleneck and leaks ordering information. Use Snowflake IDs for time-ordered, globally unique identifiers.
3. **DB query per timeline read**, at 30K reads/sec, hitting MySQL for every timeline request saturates the database. Pre-compute timelines in Redis sorted sets.
4. **Trending not separated**, computing trending topics inside the tweet write path adds latency. Run trending as an asynchronous service consuming from Kafka.
5. **Ignoring fan-out cost**, not estimating 1.16M Redis writes/sec from fan-out leads to undersized infrastructure.
6. **Single ES index**, one Elasticsearch index for all tweets grows unbounded. Split into a hot index (7 days, in RAM) and monthly archives.
7. **No rate limiting**, without per-user and per-IP limits, bots and scrapers can overwhelm the system.
8. **Strong consistency for likes**, requiring exact real-time counts means `SELECT COUNT(*)` on every read. Use denormalized counters with eventual consistency.
9. **Missing DMs**, interviewers expect you to mention the DM subsystem even if you do not design it in detail.
10. **No content moderation**, ignoring toxicity detection and abuse handling signals a gap in production thinking.

---
