## 37I.11 Company Case Studies

### Facebook: Memcache at Scale

Facebook's 2013 "Scaling Memcache at Facebook" paper describes running the world's largest Memcache deployment. Key insights:
- **Regional pools**: dedicated Memcache clusters per geo-region - avoids cross-DC cache reads
- **Leases**: prevents thundering herd via token-based cache fill - only one client populates on miss
- **Gutter pool**: backup pool used when primary is unavailable (avoids DB overload during Memcache failures)
- **Intra-cluster vs inter-cluster**: mcrouter routes different key ranges to different clusters to balance load
- **Cold cluster warmup**: on new cluster add, requests route to cold cluster first, warm cluster second - gradually warms cold cluster without DB pressure
- **Scale**: billions of requests/second, petabytes of cached data

### Twitter: Redis Timeline Cache

Twitter uses Redis to cache user timelines (home feeds). Key patterns:
- **List data structure**: user timeline stored as Redis List - `LPUSH` new tweets, `LRANGE` to read feed
- **Fan-out on write**: when celebrity tweets, insert tweet ID into each follower's Redis list
- **Hybrid fan-out**: for users with >100K followers, don't pre-compute - generate timeline on read by merging celebrity tweets
- **Cache warming**: on new follower, warm timeline cache immediately for good UX
- **TTL strategy**: active user timelines (accessed < 1 day) kept in Redis. Inactive timelines evicted, reconstructed from Cassandra on next access

### Cloudflare: CDN Cache at Edge

Cloudflare serves and caches traffic for roughly a fifth of all websites from 300+ edge locations. Key techniques:
- **Cache key normalization**: `example.com/page?user=1&ref=2` and `?ref=2&user=1` normalize to same cache key
- **Tiered caching**: edge → regional → origin - reduces origin load by 80% vs direct edge-to-origin
- **Stale-while-revalidate**: serve stale content immediately, refresh async - eliminates user-visible cache misses
- **Vary header handling**: cache separate copies per `Vary: Accept-Encoding` (gzip vs brotli)
- **Cache poisoning prevention**: validate `Host` header, reject control characters in URLs

### Redis Labs: Benchmark Results

Redis Labs benchmarks show Redis handles 1 million requests/second per node on commodity hardware. Key operational insights from production deployments:
- **Pipeline batching**: grouping 100 commands in one pipeline reduces network RTTs from 100 to 1 → 50x throughput improvement
- **RESP3 protocol**: RESP3 (added in Redis 6.0) enables push invalidations (client-side caching) without polling
- **Cluster vs Sentinel**: Cluster for horizontal scaling (multiple primary nodes), Sentinel for HA (single primary with automatic failover)

### Junior to FAANG: Reading Case Studies Like an Engineer

Case studies are not trivia. They are distilled postmortems. Read each one asking two questions. What was the failure mode that forced this design? What is the simpler design they started with, and why did it break at their scale? The answer to question two is almost always your starting point. Do not deploy Meta TAO on day one. Deploy a Redis cache-aside and wait for the specific pressure that justifies TAO.

Netflix EVCache at hundreds of millions of operations per second. EVCache (Netflix's open-sourced Memcached layer) is Memcached plus client-side replication across AZs. The failure mode it solves is that a single-AZ Memcached cluster becomes a correlated failure point during AZ outages, and a traditional Redis primary-replica has replication lag that violates read-your-writes inside the same region. EVCache writes to N replicas synchronously (typically 2 or 3 AZs) and reads from the nearest. This trades write cost for read availability and intra-region consistency. Junior takeaway: if you only have one AZ, you do not need EVCache. If you deploy multi-region active-active, you probably do.

Instagram feed cache. Instagram pre-computes feeds in Cassandra and caches hot windows in Memcached, similar to Twitter Timeline. The lesson is mixed workloads. Hot users (recent activity in last N minutes) live in Memcached with short TTL and fan-out-on-write. Cold users live in Cassandra and get reconstructed on read. The cutover point is engineered from traffic data, not guessed.

Pinterest mcrouter. Pinterest runs sharded Memcached with mcrouter, a proxy that handles consistent hashing, gutter pool failover, and prefix-based routing. Junior takeaway: mcrouter exists because clients embedding sharding logic fracture during rebalance. Push routing to a proxy tier so rebalance is a proxy config change, not a fleet-wide client deploy.

Stripe idempotency keys in Redis. Every Stripe write accepts an `Idempotency-Key` header. Stripe stores the key plus the response in Redis for 24 hours. A retry with the same key returns the cached response without re-executing the charge. Failure mode this solves: network retries double-charging customers. Junior interview signal: when asked to design a payments API, mention this pattern unprompted.

Storefront caching at commerce scale. Rendered storefront HTML is cached at the edge with soft-purge-on-write: a product update marks the cached entry stale and lets stale-while-revalidate refresh it on the next hit rather than hard-invalidating. This avoids the thundering herd on popular storefronts during Black Friday catalog updates, which is why edge platforms and commerce CDNs ship soft purge as a first-class feature.

Uber Ringpop. Uber uses Ringpop (SWIM-based membership plus consistent hashing) to route cache and state ownership across a fleet of Go services. When a node joins or leaves, only 1/N of keys rebalance. Junior takeaway: consistent hashing is not optional at scale. Modulo-sharding breaks on every deploy.

The TTL-jitter lesson. The classic stampede: a million cache entries expire in the same second because a midnight batch job wrote them all with a fixed 24-hour TTL, and the origin takes the full reload at once. Fix: TTL plus uniform random jitter in [0, 0.1 * TTL]. That one-line change eliminates the daily origin spike. Memorize this pattern. It appears in every cache interview and in countless postmortems.

Meta TAO and Discord's message cache. TAO is the social graph cache at Meta, handling on the order of a billion reads per second across objects (users, posts) and associations (likes, follows, comments), per its published paper. It is eventually consistent, geo-replicated, and write-through. Discord caches recent messages per channel with aggressive eviction because chat history is naturally time-windowed.

First-job application. When your PM asks "why not cache everything?", point to the TAO paper's consistency trade-offs. When your manager asks "why TTL jitter?", point to the midnight-stampede pattern. When your tech lead asks "why a proxy tier?", point to mcrouter. Case studies are your argument library.

### Senior at FAANG: Case Studies as Design Vocabulary

At staff level, case studies are not stories. They are a shared vocabulary that lets you compress a 30-minute design discussion into a 30-second reference. Below is the vocabulary a principal engineer uses to navigate a new cache design review.

Case study decision matrix. When a team proposes a cache architecture, map it onto the closest published reference and ask what they are doing differently and why. If the team proposes synchronous cross-AZ replication for reads, the reference is EVCache, and the question is: do you have multi-AZ read traffic patterns that justify the write amplification? If the team proposes write-through to a geo-replicated store, the reference is TAO, and the question is: is your consistency model compatible with async replication lag? If the team proposes client-side sharding, the reference is pre-mcrouter Pinterest, and the question is: how will you handle rebalance without a fleet deploy?

ADR: choosing between TAO-style, EVCache-style, and Memcached-plus-mcrouter. The decision driver is consistency. TAO-style (write-through with geo-replication) for graph data where read-your-writes within a region is required and staleness across regions is acceptable. EVCache-style (multi-AZ replication) for data where read availability trumps write cost and AZ failure must not cause a cold cache. Memcached-plus-mcrouter for data where cache is a pure performance layer and the backing store (SQL, Cassandra) is the source of truth. Record this decision, not the implementation. The implementation is downstream.

Stripe idempotency as a pattern, not a story. At staff level, you generalize: any non-idempotent write path in a distributed system needs a dedup cache keyed by a client-supplied token. This is not a Stripe-specific trick. It is a universal pattern for at-least-once delivery. The ADR for any new write API must answer: what is the dedup window, where does the token live, what is the blast radius if the dedup cache is lost? Stripe's answer is a 24-hour window in Redis. Your answer depends on your cost model. For a high-value financial write, you might persist the token in DynamoDB instead. For a low-value analytics write, you might accept duplicates.

Maturity model per case study. TAO is L5. It represents a platform-level investment with dedicated teams, custom protocols, and in-house tooling. Do not build TAO. Most companies at L2 or L3 succeed with Redis Cluster plus a consistent-hashing client library. The failure mode of over-engineering is worse than the failure mode of under-engineering, because over-engineering concentrates risk in a system no one on the current team understands.

Governance: case study citations in design docs. Every cache design doc at FAANG scale cites at least two references. "We propose EVCache-style multi-AZ replication (Netflix 2019) rather than Redis Cluster (Redis Labs) because our multi-AZ failure rate is X and our write amplification budget is Y." This forces the author to think in trade-offs instead of cargo-culting. Reviewers can push back with their own citations. "Instagram used Memcached plus Cassandra at your scale. What is specific about your workload that requires EVCache?"

Bar-raiser questions derived from case studies. Design global cache invalidation for 100 services (answer uses a TAO-style fan-out bus, not per-service polling). Debug a 99.9p latency spike caused by a cache miss storm (answer references Airbnb TTL jitter and Facebook leases). Design a rate limiter for 10M QPS (answer uses GCRA in Redis with Lua, referencing Stripe's rate-limiter blog post). If the candidate cannot map their design onto a known reference, they have not read enough production-grade case studies, which is a signal they are not yet ready for staff work.

Anti-pattern catalog drawn from case studies. Fan-out-on-write for celebrities (Twitter, do not). TTL without jitter (Airbnb, do not). Client-side sharding with modulo (pre-mcrouter Pinterest, do not). Cache without gutter pool or circuit breaker (Facebook pre-gutter, do not). Shared cache without namespace isolation (everyone who has ever had a noisy-neighbor incident, do not). A staff engineer walks into a review with this list and scans the design for matches in the first five minutes.

---
