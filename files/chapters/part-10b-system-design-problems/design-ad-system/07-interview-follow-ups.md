## Interview Follow-Ups

These questions probe the edge cases and failure modes that distinguish a production-quality design from a whiteboard sketch. In an interview, demonstrating awareness of these issues shows you have thought beyond the happy path.

**Q: How do you run the auction in < 100ms with 200 DSPs?**

The key is that you never actually wait for all 200 DSPs. Parallel HTTP/2 calls are sent to all registered DSPs with an 80ms timeout (leaving 20ms for winner selection, fraud checks, and response building). HTTP/2 connection pooling eliminates TCP handshake overhead, connections to each DSP are persistent and multiplexed. DSPs that historically time out are deprioritized: a circuit breaker tracks failure rates per DSP, and any DSP exceeding a 20% failure rate is suspended for 5 minutes, reducing wasted network calls. Geographic and content-category filtering further reduces the set: of 200 registered DSPs, only 5-10 typically have campaigns targeting a given impression's audience and geography. The Go implementation uses goroutines with `sync.WaitGroup` and a context timeout derived from the request's `Tmax` field, so slow DSPs are automatically abandoned when the deadline passes.

**Q: How does frequency capping work?**

Frequency capping limits how many times a specific user sees a specific ad, preventing ad fatigue and improving user experience. The system tracks impressions per user-ad-day combination in Redis using `INCR freq:{user_id}:{ad_id}:{date}` with a daily TTL. Before the targeting engine includes a campaign in its candidate set, it checks the frequency counter, if the count has reached the cap (typically 3-5 impressions per day), the campaign is excluded. This adds a single Redis read to the targeting path, which completes in under 1ms. For weekly or monthly caps, the key format changes to include the week or month, and the TTL adjusts accordingly. Redis handles 200K+ frequency check operations per second per shard, so even at 11.6M auctions/sec, a Redis cluster with 60+ shards can serve all frequency checks.

**Q: How do you handle budget exhaustion mid-auction?**

Budget deduction uses a Redis Lua script for atomic check-and-deduct: the script reads the remaining budget, compares it against the deduction amount, and only decrements if sufficient budget remains, all in a single atomic operation. If the budget is exhausted, the Lua script returns an error and the auction engine returns no-bid for that campaign. To avoid running the expensive targeting and scoring pipeline for exhausted campaigns, a `budget_exhausted` flag is set in Redis when a campaign's remaining budget drops below the minimum CPM. The targeting engine checks this flag first (a single Redis `GET`, under 0.5ms) before doing any further work. Budgets reset at midnight UTC via a cron job that iterates over all active campaigns and resets the Redis hash fields. The cron job also reconciles the Redis budget state against the authoritative PostgreSQL campaign records to catch any drift.

---
