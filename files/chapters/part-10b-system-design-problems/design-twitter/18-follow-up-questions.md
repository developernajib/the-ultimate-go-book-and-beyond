## Follow-up Questions

These rapid-fire follow-ups test whether you can think on your feet about edge cases and extensions. Each answer is kept intentionally brief, in an interview, aim for 30-60 seconds per follow-up. The key is showing you have a mental model of the system that lets you reason about new scenarios quickly.

**1. Celebrity thundering herd?** Staggered TTL. Probabilistic refresh. Pre-warm detection.

**2. Algorithmic timeline?** Fetch 200 candidates. ML model: engagement prediction + recency + social proof. 15-min TTL cache.

**3. Twitter Spaces?** WebRTC SFU. Discovery via timeline card.

**4. 100M+ follower graph?** Only active users (last 7 days). Partitioned Redis sets. Past the celebrity threshold these accounts are pull-on-read anyway, so this serves the graph API, not fan-out.

**5. Tweet deletion?** Soft delete DB. ZREM from Redis. Kafka event for index/notification cleanup.

**6. Polls?** Options in tweet JSON. Votes table with unique constraint. Streaming aggregation.

**7. Bot detection?** Behavioral ML classifier. CAPTCHA challenge. Report-based banning.


---
