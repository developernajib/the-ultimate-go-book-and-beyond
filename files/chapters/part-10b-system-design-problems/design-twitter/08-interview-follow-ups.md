## Interview Follow-Ups

These are the most common follow-up questions interviewers ask after you present a Twitter design. Each answer is structured as a concise, direct response that demonstrates depth. Practice delivering these in under 60 seconds each, since interviewers use follow-ups to probe whether you truly understand the system or just memorized the high-level diagram.

**Q: How do you handle the "thundering herd" when a celebrity tweets?**

When a celebrity with 10M followers posts, their cached timeline expires simultaneously for all followers. Solutions: (1) **Celebrity cache**: cache the celebrity's own recent tweets separately at `celeb_tweets:{user_id}`, one entry shared across all 10M followers. TTL: 5 minutes. (2) **Probabilistic refresh**: when the remaining TTL drops under 10% of the original, refresh with 1% probability per request, which spreads the reload across the window instead of stacking it on one instant. (3) **Pre-warm**: detect celebrity posts in real time via fan-out detection and proactively refresh before the cache expires.

---

**Q: How does Twitter search work at scale?**

All tweets stream via Kafka → Search Indexer → Elasticsearch. The pipeline: (1) Kafka consumer batches 500 tweets, (2) bulk-indexes to the `tweets-hot` Elasticsearch index, (3) the hot index holds 7 days at 280GB/day, so roughly 2TB. Do not promise that an index "fits in RAM" without saying which RAM: Elasticsearch heap should stay at or under 31GB per node to keep compressed object pointers, and the thing that actually makes queries fast is the operating system page cache holding the index files. So the hot tier is sized for page cache, not heap: roughly 8 to 10 nodes with 256GB each, keeping the working set resident. For old tweets: monthly archive indices on cheaper disk-backed nodes. Search uses a `bool` query with `match` (full-text) + `term` (hashtag filter) + date range. Results sorted by `_score` (relevance) or `created_at` (recency). Target P99 <50ms for recent, <500ms for historical.

---

**Q: How do you handle Twitter API rate limiting?**

Per-application and per-user rate limits. The cheapest enforcement is a fixed window: `INCR rate:{app_id}:{user_id}:{window_minute}` + `EXPIRE 60`. Name it honestly, because it is a fixed window and not a sliding one, and the difference bites: a client that spends its whole budget in the last second of one minute and the whole budget in the first second of the next pushes 2x the limit through in two seconds. Fixed windows are fine for generous quotas and wrong for anything you are protecting. Where the boundary burst matters, use a sliding window counter that weights the previous bucket by how much of it still overlaps, or a token bucket. If count > limit → return 429 with `X-RateLimit-Remaining: 0` and `Retry-After: {seconds}`. Premium tiers: rate limits stored in API key metadata (Redis hash), checked before counter increment. DDoS protection: global rate limit per IP (separate counter) to prevent credential-stuffing.

---

**Q: How do you scale the follow graph for reads (e.g., "get all followers of user X with 50M followers")?**

Store follows in a sharded MySQL (by `following_id` for follower queries). For users with >1M followers, pre-compute and cache follower IDs in a Redis sorted set ordered by follow date, capped at 1M. Fan-out workers read from this cache rather than the DB. For the largest accounts on the platform, well past 100M followers: only materialize follower IDs for accounts likely to read the tweet (active in the last 7 days), which typically cuts the working set by an order of magnitude. Note that those accounts are past the celebrity threshold anyway, so they are served by pull-on-read and this cache exists for the graph API, not for fan-out.

---

**Q: How do you implement trending topics by region/country?**

Separate Redis key per region: `trending:{region}:{minute}`. When a tweet is created with location metadata, record hashtag in both the global bucket and regional bucket. At read time, serve regional trending based on the user's country code. For regions with low volume (<10K tweets/day), fall back to global trends. Region detection: use IP geolocation at API gateway, store in session, or use user's declared location.

---

**Q: How would you design a chronological timeline toggle (like Twitter's "Latest Tweets" mode)?**

Chronological is the simpler mode and serves directly from the Redis sorted set, since Snowflake IDs are already time-ordered. Algorithmic (ranked) timeline requires running a ranking model over candidates: fetch top 200 tweet IDs from Redis, hydrate to full tweets, apply ML model (engagement prediction), re-sort. The model inputs: user-tweet affinity (embedding similarity), recency, engagement velocity of tweet, and social proof (friends who liked it). Pre-compute ranked timeline async, serve from a separate `ranked_timeline:{user_id}` cache with 15-minute TTL.

---
