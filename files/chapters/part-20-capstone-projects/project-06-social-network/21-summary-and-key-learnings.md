## Summary and Key Learnings

This social network backend demonstrates production-grade Go development with:

### Architecture Decisions

1. **Multi-Database Strategy**:
   - PostgreSQL for primary data (ACID transactions)
   - Neo4j for social graph (relationship queries)
   - Redis for caching (sub-millisecond reads)
   - Elasticsearch for full-text search
2. **Fan-Out on Write**:
   - Pre-compute feeds for fast reads
   - Hybrid approach for celebrities (>10k followers)
   - Trade storage for read performance
3. **Real-Time Communication**:
   - WebSocket for instant notifications
   - Connection pooling per user
   - Graceful fallback to polling

### Performance Optimizations

1. **Multi-Tier Caching**:
   - L1: In-memory cache (local to instance)
   - L2: Redis cache (shared across instances)
   - L3: Database (source of truth)
2. **Database Optimization**:
   - Connection pooling (100 max, 25 idle)
   - Prepared statements
   - Batch operations for fan-out
   - Indexes on frequently queried columns
3. **N+1 Query Prevention**:
   - Batch fetch users for feed hydration
   - Single query for post with author
   - Eager loading with JOINs where appropriate

### Scalability Patterns

1. **Horizontal Scaling**:
   - Stateless API servers
   - Load balancer distribution
   - Database read replicas
2. **Sharding Strategy**:
   - User table sharded by user_id hash
   - Feed table partitioned by user_id
   - Post table can remain un-sharded (time-series)
3. **Async Processing**:
   - Feed fan-out (don't block post creation)
   - Notification sending (fire-and-forget)
   - Elasticsearch indexing (eventual consistency)

### Interview Relevance

This project covers common interview questions:

1. **"Design Twitter"**: Complete implementation
2. **"How do you handle fan-out?"**: Write vs read trade-offs
3. **"How do you scale a social network?"**: Multi-tier strategy
4. **"Real-time notifications?"**: WebSocket implementation
5. **"Search at scale?"**: Elasticsearch integration

### Production Readiness Checklist

- ✅ Structured logging (Zap)
- ✅ Metrics (Prometheus)
- ✅ Graceful shutdown
- ✅ Health checks
- ✅ Rate limiting
- ✅ CORS configuration
- ✅ JWT authentication
- ✅ Input validation
- ✅ Error handling
- ✅ Unit tests
- ✅ Integration tests
- ✅ Docker Compose
- ✅ Kubernetes manifests

### Next Steps

To take this project further:

1. Add **direct messaging** (WebSocket-based chat)
2. Implement **story/ephemeral posts** (24-hour TTL)
3. Add **video upload** with transcoding queue
4. Implement **recommendation engine** (collaborative filtering)
5. Add **abuse detection** (ML-based content moderation)
6. Implement **GraphQL API** (alternative to REST)
7. Add **gRPC services** for internal communication
8. Implement **event sourcing** for audit trail

This capstone project represents a **senior-level** understanding of distributed systems, social network architecture, and production Go development. Use it to demonstrate your expertise in interviews and as a portfolio piece.

---

## FAANG Interview Questions

**Q: How would you design the news feed for 500M daily active users?**

A: Hybrid fan-out model. For users with fewer than 10K followers, fan-out-on-write: on post, push the post ID to each follower's feed cache (Redis sorted set, ranked by recency plus affinity). For users with more than 10K followers (celebrities), fan-out-on-read: the reader's feed service queries celebrity posts at read time and merges with the pre-computed home feed. This avoids the fan-out explosion for high-follower accounts. Cap feed length at 1000 items, older posts fall off. Re-rank at read time using ML signals (engagement probability, recency decay).

**Q: How do you store and query the social graph efficiently?**

A: Adjacency list partitioned by user ID. Storage: for each user, two sorted sets in Redis (followers, following) plus an authoritative record in a graph-optimized database (TAO at Facebook, custom Cassandra schema). For friend-of-friend queries, use a Bloom filter per user listing their extended network, plus a batch job that pre-computes 2-hop neighborhoods nightly. Avoid running BFS at query time past depth 2. For graph analytics (PYMK, community detection), export to a Spark GraphX or GraphFrames cluster.

**Q: How would you implement the "People You May Know" feature?**

A: Candidate generation followed by ranking. Candidates: 2-hop friends (friend-of-friend), co-workers (same employer in profile), co-attendees (same school), contact book matches, geographic proximity. Rank candidates with a GBDT model using features like shared friend count, mutual engagement, profile similarity, and network distance. Train on accepted connection requests as positive labels, unshown-and-never-connected as negatives (careful about selection bias). Run the pipeline weekly per user, cache top 50 candidates, refresh on feed scroll.

**Q: How do you handle the "thundering herd" when a viral post explodes?**

A: Three defenses. (1) Serve the post from a CDN with short TTL (10 seconds) since content is immutable. (2) For the comment stream (mutable), use a write-through cache with request coalescing: only one origin query per cache miss. (3) Shed load: if traffic exceeds 10x baseline, serve a stale version with a visible "updating" indicator. Degrade non-essential features (PYMK sidebar, trending topics) before the primary feed. Monitor via adaptive concurrency limits (Netflix's concurrency-limits library).

**Q: How would you detect and prevent spam at scale?**

A: Multi-layered defense. (1) Rate limits per user and per IP at the edge. (2) Content classifier: a fast text model (fastText or distilled BERT) scoring each post in real time. Flag scores above threshold for review. (3) Graph-based detection: spammer accounts often form dense sub-graphs with low-reputation peers. Run Louvain community detection weekly and flag suspicious clusters. (4) Behavioral features: account age, posting frequency, link ratios, client fingerprint. Feed all signals into a risk score. Use shadow bans (content invisible to others but visible to the spammer) to avoid tipping off attackers who would iterate.

### Junior → FAANG: Bridging Social Network Fundamentals to Interview Readiness

New engineers often treat this project as a collection of independent services. The prerequisite gap is understanding why each architectural decision exists. Fan-out-on-write is not default behavior; it is a trade-off that exchanges write amplification for read latency. If you cannot articulate that trade-off with numbers (e.g., "a user with 50K followers generates 50K Redis writes per post"), interviewers will not credit you with system design depth.

First-job habit to build: whenever you implement a caching layer, write a comment or ADR explaining the invalidation strategy. "Cache with no expiry" is a bug waiting to happen. Practice the "Design Twitter" question by sketching the data flow from post creation to feed render on a whiteboard before looking at code. Entry-point interview framing: "I'd start with the fan-out problem, pick a follower threshold for hybrid mode, then work outward to storage and ranking."

### Senior @ FAANG: Governing a Social Graph Platform at Staff Level

A staff engineer inherits a social network codebase and is immediately asked: "What is the long-term tenancy model for the graph database?" That question surfaces a governance gap that is common in fast-growth products. Neo4j works for a prototype but hits operational limits at 10B+ edge scale without careful sharding. The ADR here should compare adjacency-list-in-Cassandra (proven at Facebook's TAO), dedicated graph engines (Amazon Neptune, TigerGraph), and a hybrid Redis hot-path with Postgres cold-path. The decision affects three teams: platform, data science (PYMK model training), and trust-and-safety (graph-based spam detection). A bar-raiser question at L6/L7: "How does your sharding scheme affect the accuracy of 2-hop friend-of-friend queries when the two hops land on different shards?"

Platform thinking means modeling the feed system as a product used by internal teams, not just end users. The feed service becomes an internal API with SLAs: P99 feed load under 200ms for standard users, under 500ms for celebrity merges. Maturity model framing: level 1 is a working prototype, level 2 adds monitoring and circuit breakers, level 3 adds capacity planning with load tests that simulate follower-count distributions (Zipf law applies), level 4 formalizes SLO review in incident retrospectives. Staff-level concern: the spam detection system produces shadow bans that affect revenue (shadow-banned advertisers do not reach their audience). Own the process that escalates ambiguous bans to a human review queue with a defined SLA, and build an audit log that satisfies legal discovery requirements.

---

## Navigation & Cross-References

| [Project 5: Search Engine](../project-05-search-engine/00-introduction.md) | [Part XX: Capstone Projects](../00-part-intro.md) | [Project 7: CI/CD Platform](../project-07-cicd-platform/00-introduction.md) |
| :--- | :---: | ---: |
| ◀ Previous Project | Table of Contents | Next Project ▶ |
