## 37I.13 Interview Questions & Answers

**Q1: How would you design a cache invalidation strategy for a product catalog?**

A: Use a combination of strategies: (1) **TTL-based**: set 5-minute TTL for product data with +/- 20% jitter - eventual consistency is acceptable for most reads, and the jitter prevents synchronized expiry. (2) **Event-driven invalidation**: when product updates in DB, publish the product ID to a Redis pub/sub channel. All app nodes subscribe and evict from their local L1 cache (Redis 6+ client-side tracking with `CLIENT TRACKING` automates this for server-assisted invalidation). (3) **Version-based key**: include a per-entity version in the cache key (`product:123:v5`), where incrementing the version invalidates every key that contained it without explicit deletes - particularly useful for composite keys like `search:...:product:123:v5`. (4) **Write-through on update**: synchronously update the cache when a product changes, so the next read is already warm and avoids thundering herd after invalidation. Short TTL bounds stale-data risk, the event bus handles immediate invalidation for critical fields (price, availability), and the version key handles derived caches.

*What FAANG expects:* A layered answer that shows you understand that cache invalidation is never one mechanism - it's a defense-in-depth strategy. The interviewer is listening for: explicit trade-off between freshness and load, the failure mode of each mechanism (pub/sub message loss, clock skew on TTLs, version counter overflow), and an opinion on which mechanism is authoritative when two disagree. Bonus points for mentioning Redis client-side caching (RESP3 push invalidations) or Kafka-based CDC as scalable alternatives to pub/sub.

*Follow-ups:*
- How do you handle a missed pub/sub message during a network partition? (Answer: TTL is the backstop. Combine with a periodic full reconciliation for critical entities.)
- The version counter is itself cached - how do you invalidate it? (Answer: store it in Redis with no TTL, bump atomically with INCR. Its cache key is derived, not versioned.)
- What if two services have different ideas of the current version? (Answer: read-your-writes consistency requires a single write path and session-sticky reads within a request, or explicit version propagation through the request context.)

---

**Q2: Explain cache stampede and how to prevent it.**

A: Cache stampede (thundering herd) happens when a popular cache key expires or is invalidated and hundreds or thousands of concurrent requests all miss at once, simultaneously querying the database and overwhelming it. Prevention strategies: (1) **Single-flight** (`golang.org/x/sync/singleflight`): deduplicate concurrent requests for the same key within a process - only one goroutine fetches, others wait and receive the shared result. (2) **Probabilistic early refresh (XFetch)**: refresh the cache stochastically before expiry, with probability rising as TTL shrinks: `P(refresh) = -delta * beta * ln(random) >= remaining_ttl`. Spreads refreshes over time so no single expiry instant triggers a herd. (3) **Distributed lock**: a cross-process equivalent of singleflight using `SET NX` in Redis - only one process refreshes, others wait and retry from cache. (4) **Stale-while-revalidate**: serve stale data immediately, refresh asynchronously - eliminates user-visible miss latency entirely. (5) **TTL jitter**: add randomness to TTLs so batch-populated keys don't all expire simultaneously.

*What FAANG expects:* That you distinguish the **hard stampede** (many workers miss at once) from the **soft stampede** (one hot key expires under load) and pick the right tool for each. Singleflight solves the in-process case, probabilistic early refresh solves the expiry case, and distributed locks handle the multi-process case. The interviewer will push on correctness: what happens if the singleflight leader panics? (The group releases and the next request retries.) What if the lock-holder dies? (TTL on the lock key is the fallback - size it to your worst-case origin latency.)

*Follow-ups:*
- Why not just use a distributed lock for everything? (Answer: the extra RTT adds tail latency even on cache hits. singleflight is free in the happy path.)
- How do you size the XFetch `beta` parameter? (Answer: higher beta = more aggressive early refresh. Tune so refresh rate stays below origin capacity under peak load.)
- How does stale-while-revalidate interact with consistency? (Answer: it extends the staleness window by one refresh cycle, so only apply it to data whose freshness SLA allows it.)

---

**Q3: When would you use write-through vs write-behind caching?**

A: **Write-through**: write to DB and cache synchronously. Use when data consistency is critical (financial data, inventory counts, auth state), reads dominate writes by at least 5:1 so the extra write cost is amortized, and a cache miss would cause significant latency. Downside: write latency = DB latency + cache latency, and a cache outage degrades writes. **Write-behind**: write to cache immediately, flush to DB asynchronously. Use when write throughput is the binding constraint (analytics events, user preferences, non-critical counters) and a bounded window of durability lag is acceptable. Downside: data loss risk if the cache node fails before flush - mitigate by putting a durable buffer (Redis Streams, Kafka) between the cache and the DB rather than buffering in process memory. **Default**: neither - use cache-aside, which puts the application in control and avoids both failure modes.

*What FAANG expects:* A recommendation against write-through and write-behind for most services. The interviewer is looking for the maturity to say "cache-aside unless proven otherwise" and then explain which specific production signals would push you toward write-through (e.g., p99 read latency after invalidation exceeds SLA) or write-behind (e.g., DB write throughput is the bottleneck and cannot be scaled further). Bonus: mention that write-behind with an in-process queue is almost always wrong. The durable buffer is the architectural feature, not the cache.

*Follow-ups:*
- How do you handle a write-through cache where the DB write succeeds but the cache write fails? (Answer: log and continue. Next read repopulates from DB.)
- What's the failure recovery story for a write-behind buffer? (Answer: dead-letter queue + reconciliation job. The buffer is durable, so a crash loses nothing.)
- Could you combine write-through for critical fields and cache-aside for derived fields? (Answer: yes, this is common - mutate the authoritative entity write-through, let denormalized projections lazy-load.)

---

**Q4: How does consistent hashing help with cache clustering?**

A: Consistent hashing minimizes key remapping when cluster membership changes. With simple modulo hashing (`key % N`), changing N causes ~100% of keys to remap and invalidates the entire cache. With a consistent hash ring, only `K/N` keys remap when adding or removing one of N nodes - the rest stay on their original node. Virtual nodes (typically 150-200 per physical node) ensure even load distribution by mapping each physical node to many ring positions. Benefits: horizontal scaling without mass cache invalidation, graceful node removal, and predictable rebalance cost. Redis Cluster uses a variant (16384 fixed hash slots mapped to nodes) which is operationally simpler than a full ring but requires explicit slot migration. For Go, `buraksezer/consistent` is the production-grade library for bounded-load consistent hashing.

*What FAANG expects:* That you know consistent hashing is a family, not a single algorithm. Name at least three variants and their trade-offs: classic ring with vnodes (flexible, O(log V) lookup, needs shared state), jump hash (zero memory, O(log N), but nodes can only be added at the tail), and rendezvous/HRW (no data structure, exact uniformity, O(N) per lookup - fine below ~50 nodes). The interviewer will also probe hot-spotting: what if one key becomes 50% of traffic? (Answer: consistent hashing doesn't help. You need either replication of that key across multiple nodes or a request-level L1 cache to absorb the skew.)

*Follow-ups:*
- Why does Redis Cluster use 16384 slots instead of a ring? (Answer: slots are explicit, operationally predictable, and make resharding a visible background task rather than a transparent migration.)
- How do you handle bounded load with consistent hashing? (Answer: Google's "Consistent Hashing with Bounded Loads" - if a node is over capacity, overflow to the next node on the ring.)
- What's the failure story when a node goes down mid-request? (Answer: client retries the next successor on the ring. For replicated keys, read from a replica. For single-node keys, fall back to the origin.)

---

**Q5: What is the difference between Redis Cluster and Redis Sentinel (and where does Valkey fit in)?**

A: **Redis Sentinel** monitors a primary-replica setup. On primary failure it elects a new primary. Provides HA for a single-primary deployment with one shared key space across replicas. Use when HA matters but horizontal scaling does not. **Redis Cluster** distributes data across 16384 hash slots owned by multiple primaries, each with replicas. Use when data size or write throughput exceeds a single node. Key limitation: multi-key commands must target the same slot, which is where hash tags like `{user}.profile` come in. **Valkey** is the Linux Foundation's BSD-licensed fork of Redis, created in 2024 after Redis Ltd.'s license change to RSALv2/SSPLv1. It speaks the same RESP2/RESP3 protocol, supports the same Cluster and Sentinel modes, and works transparently with `go-redis/v9`. AWS ElastiCache, GCP Memorystore, and most Linux distributions default to Valkey in 2026. Most teams start with Sentinel + vertical scaling and graduate to Cluster when working set exceeds RAM on a single node.

*What FAANG expects:* An answer that handles the licensing question as a first-class concern. The interviewer may be running a compliance-sensitive environment (SSPL is not OSI-approved, which blocks many procurement pipelines). Beyond that, they want to hear you pick Sentinel for operational simplicity when one node is enough, and Cluster when it isn't - and to understand that cross-slot transactions, MULTI/EXEC, and some Lua scripts stop working in Cluster mode without careful key tagging.

*Follow-ups:*
- How do you migrate from Sentinel to Cluster with minimal downtime? (Answer: run both, dual-write, migrate reads slot-by-slot using `MIGRATE`, decommission Sentinel.)
- What breaks when you shard multi-key commands across slots? (Answer: atomicity. Either hash-tag the keys into the same slot or switch to compensating transactions.)
- When would you pick Memcached over Redis/Valkey? (Answer: pure ephemeral LRU with no persistence and no advanced data types. Multi-threaded server scales better than Redis single-thread for simple `GET`/`SET` on huge machines.)

---

**Q6: How would you implement distributed rate limiting?**

A: Use Redis with atomic Lua scripts for accuracy. Options: (1) **Fixed window counter**: `INCR` + `EXPIRE` per `(identifier, window)` key. Simplest, but allows up to 2x burst at window boundaries. (2) **Sliding window counter**: sorted set with timestamp scores. Remove expired entries on each request, count, conditionally add. Accurate but O(log N) per request and memory scales with the window size. (3) **Token bucket**: store `{tokens, last_refill}` in a hash, refill proportionally to elapsed time, deduct on each request. Allows bursts up to capacity, predictable memory. (4) **Leaky bucket**: process at a fixed rate, reject overflow. Use Lua for atomicity - every variant must combine read, decide, and write in a single round-trip, otherwise two concurrent requests can both observe "remaining == 1" and both pass. For very high throughput (tens of thousands of requests per second per key), consider per-shard Redis nodes with consistent hashing, or an in-process pre-check that talks to Redis only for a fraction of requests.

*What FAANG expects:* A working Lua script on the whiteboard, plus an honest answer about cost. The interviewer wants to hear that you've thought about Redis as the failure domain: what happens when Redis is unreachable? (Fail open for availability or fail closed for correctness - the product decides.) They will also push on accuracy-vs-cost: sliding window is expensive if you keep every timestamp, so in practice most production systems use sliding window **log** for low-rate endpoints and sliding window **counter** (two adjacent fixed windows with weighted math) for high-rate endpoints.

*Follow-ups:*
- How do you handle clock skew between Redis and the application? (Answer: use Redis server time via `TIME` command, not the client clock. Or make the window large enough that skew doesn't matter.)
- What's your fallback when Redis is down? (Answer: per-process in-memory limiter with a higher budget. acceptable for short outages, logged as a degraded mode.)
- How do you rate-limit by user AND by endpoint AND by IP simultaneously? (Answer: three separate keys, all checked in one pipelined Lua script. Deny if any exceeds its limit.)

---

**Q7: How do you measure cache effectiveness?**

A: Key metrics: (1) **Hit rate** = `hits / (hits + misses)` per layer - target >90% for hot paths but treat the number as a symptom, not a goal. A 99% hit rate on data that shouldn't be cached is worse than a 70% hit rate on data that should. (2) **Hit latency p99** - under 1ms for Redis, under 0.1ms for in-process. (3) **Miss latency p99** - the fallback to the origin must have a bounded, acceptable latency because that's what users feel during an invalidation storm. (4) **Eviction rate** - high eviction means the cache is undersized or the working set has grown. (5) **Working-set ratio**, `used_memory / maxmemory`. When this is near 1.0, eviction is active and hit rate is brittle. (6) **Cost per request** = `(miss_rate * origin_cost) + (hit_rate * cache_cost)` - the economic justification for the cache. Track all of these in Prometheus, alert on hit-rate drops (indicates invalidation bug, deploy-time working-set shift, or a change in traffic pattern), and plot hit rate against cache size to find the point of diminishing returns.

*What FAANG expects:* That you measure both effectiveness (hit rate, latency) and cost (memory, eviction, origin load). A candidate who reports only hit rate is missing half the picture. They also want you to distinguish hit rate from **byte hit rate** (CDN context - large objects matter more than small ones) and to mention that the right alert is often on **miss rate delta** rather than absolute hit rate, because baseline hit rate varies by service.

*Follow-ups:*
- Your hit rate dropped from 95% to 80% after a deploy. How do you diagnose? (Answer: check for new keys, TTL changes, serialization changes that broke cache compatibility, and working-set growth.)
- Why might a higher hit rate be worse? (Answer: caching mutable data aggressively - you're faster but wrong more often.)
- How do you decide cache size? (Answer: measure working-set size via sampling, plot hit rate vs memory, pick the knee of the curve.)

---

**Q8: Explain cache warming strategies for a new deployment.**

A: The cold-start problem: new cache nodes start at 0% hit rate and send all traffic to the origin, which may not be provisioned for that load. Strategies: (1) **Lazy warming**: let natural traffic populate the cache. Simplest. dangerous for high-traffic services because it's a coordinated stampede in slow motion. (2) **Proactive warming**: pre-populate with the top-N most-accessed keys from analytics or query logs before routing traffic to the new node. (3) **Gradual traffic shifting**: route a small percentage first (1%, 5%, 25%, 100%), letting each stage warm before increasing. (4) **Cache transfer**: copy data from the old node/cluster directly (`MIGRATE` for Redis), avoiding the origin entirely. (5) **Tiered warming** (Facebook's approach): a new cold cluster proxies misses to a warm cluster rather than to the database. The cold cluster fills over time without the origin ever seeing the extra load. Combine techniques: a production rollout typically uses gradual traffic shifting with proactive warming of the top 10k keys.

*What FAANG expects:* That you recognize cold start as a capacity-planning problem, not a correctness problem. The interviewer wants to hear about origin protection: if your origin can handle 10k qps and your cold cache will send 100k qps through it, lazy warming is not an option. They'll probe for load-shedding fallbacks (queueing misses, returning stale data from a neighboring region, circuit-breaking with degraded responses) and for observability on the warming itself (you must know when the cache is "warm enough" to open the floodgates).

*Follow-ups:*
- How do you know the cache is warm? (Answer: hit rate crosses a threshold, e.g., 80%, or a fixed time elapses. Both are signals, not guarantees.)
- What if the top-N analytics are stale and the new traffic pattern is different? (Answer: proactive warming is a hint, not a guarantee. Always combine with gradual traffic shifting so you notice divergence early.)
- How would you warm a cache across a region failover where the origin in the failed region is unreachable? (Answer: cross-region cache replication or async snapshots - the warm cluster can't be rebuilt from an origin you can't talk to.)

### Junior to FAANG: Interview Entry Points and Signal Ladder

Cache questions appear in every backend interview loop because they test four skills at once: data structures, concurrency, distributed systems, and operational maturity. The interviewer is not grading your memory of Redis commands. They are grading your reflexes around correctness, failure modes, and trade-offs.

Signal ladder L3 to L7. L3 (new grad) shows basic knowledge: can define hit rate, can write a cache-aside loop, can identify one concurrency hazard. L4 (SWE II) picks the right pattern for a scenario: cache-aside vs write-through, TTL vs event invalidation, in-process vs shared. L5 (senior) designs the full system: invalidation, stampede prevention, size limits, metrics, failure modes. L6 (staff) designs across teams: governance, SLOs, platform abstractions, migration paths. L7 (principal) designs across organizations: multi-year roadmaps, vendor negotiation, build-vs-buy, cross-service consistency guarantees.

Worked warm-up. "Design the cache for a product page." L3 answers `cache.Get, cache.Set`. L4 mentions TTL and jitter. L5 adds singleflight, stampede protection, negative cache, metrics. L6 adds multi-region, consistent hashing, blast-radius analysis, migration plan. L7 asks "what is our consistency SLO and how does that constrain the architecture?" before answering.

Interview entry point for juniors. Memorize the seven-mistake taxonomy from the previous section. Interview prompts almost always target one of them. "Design an Instagram-feed cache" is a stampede-plus-hot-key question. "Design a rate limiter" is an atomicity-plus-failure-domain question. "Design a session cache" is a cache-as-source-of-truth trap. Identify the trap first, then answer.

First-job context. After an interview, write your own postmortem. What question did you freeze on? What pattern did you forget? Build a personal interview journal keyed by cache mistake, and rehearse the answer until it comes out in under 30 seconds. That is how you move from L3 to L4 answers.

### Senior at FAANG: Bar-Raiser Questions and Maturity Signals

At L6 and above, cache questions are bar-raiser signal tests. The interviewer is not checking whether you can recite Redis commands. They are checking whether you can carry a system through five years of scale without creating a legacy nightmare.

Bar-raiser Q1: Design global cache invalidation for 100 services sharing a cache platform. Good answer walks the ADR: an event bus (Kafka or Redis Streams) carries invalidation events, each service declares the namespaces it owns, writers publish `{namespace, key, version}` on mutation, readers subscribe per-namespace and evict from local L1 caches. Version number prevents out-of-order events. Dead-letter queue handles subscriber lag. TTL on shared Redis is the backstop for lost events. Blast radius is analyzed: what happens if the event bus lags 10 seconds? Each service declares its staleness SLO and picks a backstop TTL that enforces it. Bonus points: mention that Redis client-side caching via `CLIENT TRACKING` over RESP3 (both available since Redis 6.0) solves the L1 invalidation problem natively without a custom event bus, but requires a dedicated connection per client and does not cross regions.

Bar-raiser Q2: Debug a 99.9p latency spike caused by a cache miss storm. Good answer identifies the four stampede classes (TTL synchronization, cold start, invalidation event, hot-key loss) and walks the diagnostic tree. Pull miss-reason histogram. If `expired` spiked, check deploy timing and TTL policy, add jitter. If `absent` spiked on unknown IDs, check for scraper or enumeration attack, add negative cache plus edge rate limiter. If `evicted` spiked, check memory pressure, add L1 absorption, scale memory, or partition hot key. Note that 99.9p spikes are usually correlated events, not independent misses. The fix is admission control, not more capacity.

Bar-raiser Q3: Design a rate limiter for 10M QPS. Good answer rejects naive Redis-per-request. At 10M QPS, Redis-per-request is 10M Lua evaluations, which no single node handles. Tier the design: L1 per-process token bucket (generous limit) absorbs most traffic, periodic reconciliation with L2 Redis sharded by key, GCRA algorithm for O(1) memory per limiter, Lua script for atomicity. If the bucket is truly global and sharding is not acceptable, use a probabilistic counter (count-min sketch) with bounded error. Mention that at 10M QPS, the rate-limiter itself is a distributed system with its own SLO, not a library call.

Bar-raiser Q4: When would you reject a cache proposal outright? Good answer lists hard refusals: cache as source of truth without durable backing, no TTL policy, no key-cardinality bound, no namespace isolation, write-behind without durable buffer, cross-region synchronous cache writes on the request path. Each refusal comes with a rationale rooted in a failure mode. Bar-raisers want to see that you have opinions and can defend them.

Bar-raiser Q5: Design the migration from a shared Redis to a platform cache with per-namespace isolation. Good answer walks the staged migration: audit all current callers, register each as a namespace with declared TTL and cardinality, dual-write during transition, migrate reads slot-by-slot with canary rollout, monitor hit rate and miss reason per namespace, roll back if any namespace regresses more than 5 percent. Timeline: 6 to 12 months for 100 services. Risks: noisy-neighbor regression during dual-write, serialization drift, version skew. ADR captures the migration plan and the exit criteria.

Maturity signals the bar-raiser scans for. Does the candidate name specific algorithms (GCRA, count-min sketch, HyperLogLog, bounded-load consistent hashing) and justify their choice? Does the candidate reason about failure domains and blast radius without being prompted? Does the candidate mention observability, governance, and migration in the same answer as the algorithm? Does the candidate distinguish between "cache as performance layer" and "cache as consistency layer" and pick the right architectural stance? If any of these are missing, the candidate is still at L5, not yet L6.

Governance questions only staff engineers answer. Who owns the cache platform SLO? How do you charge tenants for cache memory? How do you prevent a runaway tenant from evicting other tenants' working sets? How do you deprecate a cache namespace when the owning team is reorganized? These are not interview questions in the textbook sense. They are the questions that determine whether a cache platform is a successful shared service or a chronic on-call source.

---
