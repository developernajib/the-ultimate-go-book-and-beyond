## Summary

A well-placed cache reduces database load by 10-100x and cuts tail latency by orders of magnitude. Key caching patterns include:

- **Architecture**: L1 (in-process ristretto/v2 or otter/v2 for W-TinyLFU), L2 (Redis or Valkey), L3 (database) - each with different latency/capacity trade-offs
- **Cache-aside**: the default pattern - lazy loading, two-layer miss waterfall, async L2 population, MGet batch optimization
- **Stampede prevention**: `singleflight` deduplication, XFetch probabilistic early refresh, distributed lock, TTL jitter
- **Write patterns**: write-through (DB + cache synchronously) for consistency-critical paths, write-behind (async DB flush via durable queue) for write-throughput-critical paths - both are minority choices
- **Invalidation**: tag-based, version-based, pub/sub broadcast for L1 eviction across nodes. negative caching for not-found keys
- **Rate limiting**: sliding window with sorted sets, token bucket with Lua scripts
- **Consistent hashing**: ring with vnodes, jump hash (zero-memory, tail-grow), rendezvous/HRW (small clusters), `buraksezer/consistent` for bounded-load
- **Observability**: hit rate, eviction rate, latency percentiles via Prometheus
- **Case studies**: Facebook Memcache leases, Twitter Redis timeline, Cloudflare CDN edge caching

The fundamental principle: **cache what's expensive to compute, invalidate what's guaranteed to change, jitter every TTL, and measure the hit rate to know if it's working.**

### Junior to FAANG: Carrying the Chapter Forward

Treat this chapter as a reference card, not a one-time read. The seven common mistakes plus the four stampede classes plus the three invalidation mechanisms together cover roughly 90 percent of production cache incidents. Memorize them in that shape. When an alert fires, scan the taxonomy before touching the system. The correct fix is almost always already named in your head.

First-job habits to build. Before merging any PR that adds a cache call, verify TTL has jitter, verify error path falls through to origin, verify the key has a bounded namespace, verify metrics are emitted. Leave these four checks as a personal code-review checklist. Within six months of consistent application, your reviewers will notice.

Interview rehearsal loop. Pick one of the 8 questions from Section 37I.13 per week, write a 2-minute spoken answer, record yourself, and iterate. The goal is fluency, not novelty. A fluent answer to "design a cache" at L4 beats a novel answer at L3 every time.

Reading ladder beyond this chapter. Read the Facebook Memcache paper (2013), the Netflix EVCache blog series, the Stripe rate-limiter blog post, and the Airbnb TTL-jitter postmortem. Each is 30 to 60 minutes. Together they form the canonical reading list for a mid-level engineer specializing in caching infrastructure.

### Senior at FAANG: Carrying the Chapter Into Platform Strategy

At staff level, this chapter's content becomes the starting point for a multi-year platform roadmap. The governance, observability, and maturity frames are what transform a collection of Redis instances into a shared service with SLOs, tenants, and billing.

Three-year roadmap template. Year 1: consolidate scattered cache deployments into a single shared platform with per-namespace isolation, TTL policies, and observability. Establish the ADR process for new namespaces. Year 2: add admission control, hot-key detection, big-key protection, and tiered caching as platform primitives. Migrate teams off ad-hoc solutions. Year 3: add multi-region replication, cost attribution, self-service provisioning, and automated remediation. At this point the cache platform is a product, not a utility.

Platform SLOs to own. Availability 99.99 percent per namespace, read p99 under 2 ms intra-region, read p999 under 10 ms, hit-rate regression alert at 5 percent drop over 1 hour, eviction-rate alert at 10 percent of capacity per hour, cross-region replication lag under 500 ms p99. These are the numbers that appear on the platform team's on-call dashboard and in the quarterly business review.

Staff-level decision framework. For any new cache problem, answer in order: is the cache a performance layer or a consistency layer (different architectures), what is the staleness SLO (drives TTL and invalidation), what is the failure mode when the cache is unavailable (drives fallback design), what is the blast radius (drives isolation), what is the cost model (drives capacity planning and billing), and what is the migration path from whatever exists today. If any question is unanswered, the design is not ready for review.

Maturity model L1 to L5 for cache platforms. L1: shared Redis with no governance. L2: per-namespace TTL and observability. L3: admission control and big-key protection. L4: multi-region replication and automated remediation. L5: self-service platform with cost attribution and SLO-driven capacity planning. Most FAANG platforms reach L3 within 2 years and L4 within 4. L5 is the hallmark of a mature platform team.

Bar-raiser closing question. "If you owned the cache platform at your company for the next 3 years, what would you change first and why?" A staff-level answer names a specific failure mode observed in production, proposes a specific platform change, estimates the cost and migration timeline, and identifies the risk of the change itself. Anything vaguer is a senior-level answer.

Final principle for staff engineers. Cache design is not about Redis commands. It is about contracts: between writers and readers, between platform and tenants, between current and future engineers. Every architectural choice in this chapter encodes a contract. Make the contracts explicit, enforce them with tooling, and document them in ADRs. That is the difference between a cache that works today and a cache platform that works for the next decade.
