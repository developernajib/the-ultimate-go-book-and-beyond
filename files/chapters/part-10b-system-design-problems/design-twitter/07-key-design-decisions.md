## Key Design Decisions

Every system design involves trade-offs, and interviewers want to see that you understand the "why" behind each choice. The decisions below explain what was chosen, the reasoning, and the downside you accept. Being able to articulate trade-offs clearly is what separates a strong system design answer from a mediocre one.

### Decision 1: Hybrid Fan-Out Model (Push + Pull)

**Choice:** Fan-out on write for regular users, pull-on-read for celebrities (>100K followers).

**Why:** With 200 average followers, fan-out writes are manageable (1.16M/sec). But a celebrity with 10M followers posting 10 tweets/day = 100M Redis writes/day just for one user. The hybrid model pushes only to "regular" users' timelines, celebrity tweets are pulled at read time and merged.

**Trade-off:** Timeline reads for users following many celebrities require additional fan-in queries at read time. Mitigation: cache celebrity timelines separately per celebrity (not per fan) - shared across all followers.

---

### Decision 2: Snowflake IDs for Tweets

**Choice:** Custom 64-bit IDs encoding timestamp + datacenter + sequence.

**Why:** Auto-increment IDs create a write hotspot on one DB shard. UUIDs are not time-sortable (no range scans). Snowflake IDs are time-ordered → used as score in Redis sorted sets (no separate score needed), range queries on tweets by time, and cursor-based pagination without OFFSET.

**Trade-off:** Clock skew across nodes can generate out-of-order IDs. Mitigation: synchronize NTP, refuse to generate IDs if clock goes backwards (block until safe).

---

### Decision 3: Redis Sorted Set for Timelines (vs. DB Queries)

**Choice:** Pre-computed timelines in Redis sorted set, tweet IDs as both score and member.

**Why:** 800M timeline reads/day at 9,259/sec. Serving each from DB would require sharding + complex joins. Redis sorted sets support O(log N) writes and O(log N + M) range reads - fetching 20 tweet IDs from a 800-item timeline in <2ms.

**Trade-off:** Redis stores 1.28TB of timeline data, and RAM at that scale is not cheap. On-demand ElastiCache memory-optimized nodes run about $12 per GB per month, so 1.28TB needs roughly 13 `cache.r7g.4xlarge` primaries at about $16K/month, and closer to $33K/month once every shard has a replica. Reserved instances cut that by roughly half. That is real money, and it is still the right trade: serving 800M reads/day from sharded MySQL would cost far more in database fleet than it saves in RAM. Note this budget also assumes the 8-bytes-per-entry arithmetic from the capacity section, which counts the tweet IDs and nothing else. A Redis sorted set entry carries skiplist and hash-table overhead on top, so size the cluster with headroom and measure with `MEMORY USAGE` against a real key rather than trusting the back-of-envelope figure. TTL eviction for inactive users (no activity in 7 days) bounds memory.

---

### Decision 4: Two-Index Search (Hot + Archive)

**Choice:** Elasticsearch with two indices: `tweets-hot` (last 7 days, in-memory) and monthly archive indices (disk).

**Why:** 95% of searches query recent tweets. Keeping the hot index small enough to fit in RAM enables sub-50ms P99 search. Historical search can tolerate higher latency.

**Trade-off:** Index alias management adds operational complexity. Tweets older than 7 days are not instantly searchable after indexing - they're promoted from hot to archive via daily reindex job.

---

### Decision 5: Per-Minute Redis Buckets for Trending

**Choice:** Each hashtag's per-minute count in a Redis sorted set `trending:{unix_minute}`. Sliding window aggregates last 60 minutes.

**Why:** Redis `ZINCRBY` is atomic - concurrent hashtag increments are safe. Per-minute buckets allow exact sliding window without log-based aggregation overhead.

Be precise about what the z-score actually buys you, because it is easy to claim too much. The z-score here compares a hashtag against the population of *other* hashtags in the same window, so it measures volume relative to the field. It does not measure surprise, and on its own it would rank #love and #news at the top every single minute, exactly the outcome you were trying to avoid. That is why the implementation adds a velocity term: the last five minutes of a tag against its own hour, which is what actually separates a breakout from a perennial. A stronger version compares each tag against its own historical baseline for this hour of this weekday, so #fridayfeeling does not trend every Friday.

**Trade-off:** 60 Redis ZRANGEWITHSCORES commands per trending refresh. With 50K unique hashtags per window, each command returns 50K entries - significant data. Optimization: limit each bucket to top 10K by count, accept minor accuracy loss.

---

### Decision 6: Separate Like Counter vs. Exact Count

**Choice:** Likes table stores each like event, `like_count` denormalized counter in tweets table.

**Why:** Exact real-time like count from `SELECT COUNT(*) FROM likes WHERE tweet_id=?` won't scale - viral tweets get millions of likes. Denormalized counter is `O(1)` to read, updated asynchronously via Kafka consumer. Eventual consistency: counter may lag by 1-5 seconds.

**Trade-off:** Counter can drift from actual likes table under failures. Periodic reconciliation job (nightly) resets `like_count` from actual count for discrepancies >1%.

---
