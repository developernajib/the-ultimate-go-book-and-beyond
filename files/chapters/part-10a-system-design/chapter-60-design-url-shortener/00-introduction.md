# Chapter 60: Design URL Shortener

*"The details are not the details. They make the design."* - Charles Eames

A URL shortener looks deceptively simple on the surface: take a long URL, return a short one, redirect when visited. Yet behind that simplicity lies a rich set of engineering decisions that expose nearly every dimension of scalable system design. Should you generate IDs deterministically with a hash or sequentially with a distributed counter? How do you prevent Bloom filter false positives from poisoning your collision-detection logic? What happens when your redirect endpoint needs to serve 100,000 requests per second while your analytics pipeline writes every click to a time-series store without becoming the bottleneck?

Services like Bitly, TinyURL, and t.co (Twitter's shortener) operate at scales that force these questions into sharp relief. Bitly processes over 10 billion clicks per month, meaning its redirect path must be read-optimized to sub-millisecond latency while its write path handles millions of new links daily. The asymmetry between reads and writes - redirects vastly outnumber link creations - is the defining constraint that shapes every architectural decision: caching strategies, database choice, the use of CDN edge nodes, and how analytics can be made asynchronous to keep the hot redirect path lean.

In Go, implementing a URL shortener from scratch is an excellent exercise because it forces you to confront real-world concerns: Base62 encoding for human-readable tokens, consistent hashing to distribute load across cache shards, atomic counter increments using Redis `INCR` for collision-free ID generation, and Bloom filters to detect malicious or already-used URLs in constant time. This chapter walks you through building each layer - encoding, storage, redirect service, analytics fan-out, and rate limiting - with production-quality Go code and clear reasoning for every design choice.

**What you'll learn in this chapter:**

- Implementing Base62 encoding to convert numeric IDs into compact, URL-safe short tokens
- Comparing hash-based versus counter-based ID generation and the collision trade-offs of each
- Using Bloom filters in Go to efficiently detect duplicate or disallowed URLs before database lookup
- Designing a multi-tier caching strategy - in-process LRU plus Redis - for the read-heavy redirect path
- Building an asynchronous analytics pipeline using channels and batched writes to avoid redirect latency spikes
- Applying rate limiting per API key to prevent abuse of the link-creation endpoint
- Designing the data model for custom aliases, expiry, and per-link access statistics
- Scaling the system horizontally with a stateless redirect service behind a load balancer

**Why this matters at scale:**

Bitly's redirect infrastructure must maintain sub-5ms p99 latency globally, achieved through aggressive edge caching and a read-path that never touches the primary database for hot links. Twitter's t.co shortener wraps every URL shared on the platform for security scanning and analytics, handling billions of daily redirects - the redirect service is intentionally designed to be a thin, stateless proxy with all heavy logic offloaded asynchronously. LinkedIn's link shortener team published post-mortems on Bloom filter tuning that revealed how a misconfigured false-positive rate caused a 3% surge in unnecessary database reads during peak traffic, a reminder that even probabilistic data structures require careful capacity planning.

**Prerequisites:** Chapters 1-59. Familiarity with Redis basics. Understanding of HTTP redirects (301 vs 302) and REST API design.

---

### Junior → FAANG: Navigating Your First URL Shortener Design

If you have never designed a URL shortener before, the first trap is treating it as a trivial CRUD service. Interviewers at FAANG-tier companies use this problem precisely because its surface simplicity hides genuine distributed systems complexity. The following checklist closes the most common prerequisite gaps.

**Understand what makes the read path special.** A URL shortener is read-heavy by a factor of 100:1 or more. That asymmetry means the redirect endpoint lives on a completely different performance budget than the create endpoint. Caching is not optional, it is the primary architectural decision. Know the difference between write-through (cache populated on write), cache-aside (cache populated on first read miss), and read-through (cache acts as transparent proxy). The chapter uses cache-aside because it gives explicit control over error handling when Redis is unavailable.

**Know your redirect codes.** Use 302 (Found, temporary) not 301 (Moved Permanently). Browsers cache 301 responses forever. If you return 301 and later need to update or expire a URL, clients who already visited will keep redirecting to the old destination forever with no way to fix it.

**Get the Base62 math right.** Interviewers often ask why 7 characters. Walk through 62^7 = 3.5 trillion. At 100 million URLs per month, that is 35,000 months of headroom, well over a human lifetime. Knowing this number and being able to derive it on a whiteboard signals solid preparation.

**Entry-level interview framing.** When asked "design a URL shortener," start by asking clarifying questions: expected scale (reads/writes per second), retention period, whether custom aliases are needed, and whether analytics is in scope. Stating these questions before drawing a single box demonstrates the structured thinking FAANG interviewers look for. Then outline the three main components: ID generation, storage, and the redirect service. Only add caching and analytics after the happy path is clear.

**First-job habits to build now.** Always validate input URLs before storing them. A shortener that accepts `javascript:alert(1)` or `http://169.254.169.254` (cloud metadata endpoint) is a security vulnerability, not a product. Validate scheme (http/https only), parse the host, and run a blocklist check. This is not an advanced topic: it is table stakes for production code.

---

### Senior @ FAANG: Platform Thinking and Bar-Raiser Signals for URL Shortener Systems

A bar-raiser interview at L6/L7 expects you to treat the URL shortener not as a standalone service but as a platform component with downstream consumers, operational dependencies, and long-horizon architectural decisions. The following covers the dimensions that separate senior answers from mid-level ones.

**ADR: 301 vs 302 is a governance decision, not just a technical one.** The choice of redirect code has contractual implications. 302 ensures the service retains control of every redirect and can revoke, update, or redirect-chain URLs after the fact, which matters for compliance (GDPR right-to-erasure), content moderation, and abuse response. Document this as an Architecture Decision Record with the reasoning, alternatives considered (301 for CDN-cacheability), and the decision rationale. At L6+, you are expected to produce written decisions that survive team turnover.

**ID generation: distributed systems correctness above all else.** The Snowflake approach (41-bit timestamp, 10-bit node ID, 12-bit sequence) is the right choice for distributed generation, but it has a subtle failure mode: if the clock on a node drifts backward (NTP adjustment, VM migration), you can generate duplicate IDs. Production Snowflake implementations detect backward clock drift and either panic, wait for the clock to catch up, or switch to a fallback. Document your clock-skew tolerance and test it explicitly. LinkedIn's open-sourced Snowflake replacement (Ambry) added sequence overflow handling as a production necessity, not a theoretical concern.

**Caching strategy as a maturity model.** Junior engineers add Redis. Senior engineers define a caching maturity model with four levels: (1) in-process LRU for the 80/20 hot set, (2) Redis for shared state across replicas, (3) CDN edge caching for geographically distributed redirect serving, (4) probabilistic early refresh (XFetch algorithm) to prevent thundering-herd on TTL expiry of viral URLs. Each level has a different failure mode and operational cost. At staff level, you articulate which level is appropriate for which traffic profile and write the runbook for cache invalidation under each scenario.

**Analytics pipeline: event sourcing as the right primitive.** The chapter uses Kafka as an event bus, which is correct. At platform scale, the key insight is that click events should be treated as an immutable append-only log, not as database rows to increment. This means the analytics store (ClickHouse, Apache Druid, BigQuery) can be rebuilt from the Kafka log if the analytics schema changes, without re-instrumenting the redirect service. Document the event schema as a contract with a major version, include a `schema_version` field in every event, and establish a deprecation process before changing field names. This is platform thinking: the redirect service does not know who consumes its click events, and that contract must be stable.

**Governance: link revocation and GDPR.** At FAANG scale, you will receive legal requests to revoke short URLs pointing to content that violates policy or contains personal data subject to a deletion request. The architecture must support near-real-time revocation (Redis `DEL` propagated to all cache tiers via pub/sub invalidation) and audit-logged revocations (who requested, which URL, when, what policy reason). The soft-delete pattern in the chapter is the right start, but it must be augmented with a revocation audit trail and a cache invalidation fanout mechanism. This is an operational requirement that becomes apparent only when you have actually run a shortener at scale.

**Scaling the write path under sustained load.** The chapter's sharding strategy uses FNV hash over the short ID. At L7, you must address shard rebalancing: when you add a shard, consistent hashing (as mentioned) remaps only 1/n of keys, but you still need to migrate those keys' click counters and URL records. Implement the range-based ID generator with enough bits in the node ID field (10 bits = 1024 nodes) to accommodate growth without counter resets. Write the operational playbook: how do you add a shard without a maintenance window? The answer involves dual-write to old and new shards during a migration window, verified by a background reconciler.

**Bar-raiser signals.** A bar-raiser at L6/L7 is listening for: proactive identification of failure modes not mentioned in the prompt (clock skew, cache stampede, GDPR revocation), explicit trade-off articulation (why sliding window over fixed window for analytics deduplication), and platform-level reasoning (the analytics pipeline as an event-sourcing system, not just a queue). They are also listening for what you do not say: a senior engineer who proposes 301 redirects without acknowledging the caching implications, or who shards without a rebalancing plan, signals incomplete production experience.
