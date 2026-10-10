## Summary

This chapter walked through designing a URL shortener that handles 100 million new URLs per month at a 100:1 read-to-write ratio:

- **ID generation trade-offs**: Counter-based IDs are simple but predictable. Snowflake-style IDs eliminate coordination overhead across distributed nodes. Hash-based IDs enable deduplication but require collision handling
- **Base62 encoding**: A 7-character code provides 3.5 trillion unique addresses, enough for decades of growth at any realistic scale
- **Database design**: Separated URL metadata from click events with time-based partitioning on the analytics table, enabling independent scaling and retention policies
- **Multi-layer caching**: Cache-aside with Redis absorbs the redirect read path, while `singleflight` prevents cache stampedes on hot URLs
- **Asynchronous analytics**: Channel-buffered click events batched to Kafka keep the redirect path under 5ms regardless of analytics load
- **Horizontal scaling**: Consistent-hash sharding and read replicas let the system grow by adding nodes without reshuffling the full dataset

The key architectural insight: the extreme read-to-write asymmetry means optimizing the redirect path is the highest-value investment. Every millisecond added to redirects multiplies across billions of requests per month.

### Junior → FAANG: Consolidating the Chapter into Interview-Ready Knowledge

After working through this chapter, you should be able to reproduce the core design decisions and their rationale without looking at notes. Here is a consolidation framework for interview preparation.

**The three-minute whiteboard version.** Client sends a long URL to the API server. The server generates a unique short ID (Snowflake for distributed, Redis counter for single-node), encodes it as 7-character Base62, stores the mapping in PostgreSQL, and pre-warms Redis. On redirect, the server checks Redis first (cache-aside), returns the long URL on a hit, queries PostgreSQL on a miss, and publishes a click event to Kafka asynchronously (non-blocking). That is the entire system. Every other detail is elaboration.

**The five key numbers to remember.** 62^7 = 3.5 trillion unique codes, 100:1 read-to-write ratio, 20% URL working set absorbs 80% of traffic, a 0-10 minute TTL jitter range to prevent synchronized expiry, 100K channel buffer for click events before dropping. These numbers anchor the capacity estimates and cache sizing decisions.

**The two failure modes that come up in every interview.** Cache stampede (a viral URL expires and 100K requests simultaneously query the database): mitigate with singleflight and TTL jitter. Phishing bypass (attacker submits a URL that resolves to a private IP or a known malicious domain): mitigate with DNS resolution check at write time and Safe Browsing API integration. Know both failure modes and both mitigations without hesitation.

---

### Senior @ FAANG: The URL Shortener as a Reference Architecture

At L6/L7, the URL shortener chapter is not just about URL shorteners. It is a reference architecture for a class of systems: high-read, low-write, key-value lookup services with asynchronous side effects and strict latency requirements on the read path. The patterns apply to feature flag systems, session stores, permission caches, and any system where the lookup path is orders of magnitude more frequent than the write path.

**The architectural invariants of this class of system.** Read path must never block on analytics. Write path must be durable before returning success. Cache is a performance hint, not an authoritative store. ID generation must be correct under clock drift and process restart. Expiration must be enforced at the cache layer to avoid serving stale data after TTL. These invariants are not unique to URL shorteners. They apply to any key-value lookup service with ephemeral values. When you encounter a new system with similar characteristics, apply the same design template.

**The operational maturity ladder for this class of system.** Stage 1: single PostgreSQL instance, no cache. Handles up to 1K reads per second. Stage 2: Redis cache, read replicas. Handles up to 100K reads per second. Stage 3: CDN edge caching, connection pooling, singleflight. Handles up to 1M reads per second. Stage 4: database sharding, multi-region deployment, probabilistic counters at the edge. Handles 10M+ reads per second. Know where your current system is on this ladder and what the migration to the next stage requires. This maturity model is the framework for capacity planning conversations with your manager and your infrastructure team.

**The governance artifacts that distinguish a production service from a project.** A production URL shortener at FAANG scale has: an API versioning policy documented in the developer portal, a data retention and GDPR compliance policy reviewed by legal, a schema migration runbook reviewed by the database team, a capacity review cadence agreed with the infrastructure team, a post-mortem template for the two most likely incident types (ID collision, cache stampede), and a security review covering SSRF and phishing bypass vectors. These artifacts make the service maintainable by a team over years, not just by the original author over months. Producing them is what L6+ engineers are hired to do.
