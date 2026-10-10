## 83F.8 System Design Study Framework

System design cannot be crammed the way coding problems can. It requires building a mental model of distributed systems components and practicing the articulation of design decisions. This framework spans 6 weeks and integrates with both the 12-week and 6-month plans.

### Phase 1: Learn Components (Weeks 1-2 of system design)

**Goal:** Understand the building blocks before designing systems.

| Week | Topic | Key Concepts | Reading |
|------|-------|-------------|---------|
| 1 | **Data layer** | SQL vs NoSQL, sharding, replication, consistency models, indexing | Chapter 80, DDIA Ch 1-7 |
| 1 | **Caching** | Cache-aside, write-through, write-behind, eviction, CDN | Chapter 62, Chapter 80 |
| 2 | **Communication** | REST, gRPC, WebSockets, message queues, pub/sub | Chapter 63, Chapter 80 |
| 2 | **Scaling** | Load balancing, horizontal vs vertical, stateless services, auto-scaling | Chapter 64c, Chapter 80 |

**Component knowledge checklist:**

- [ ] Can explain when to choose SQL vs NoSQL vs NewSQL (with specific examples)
- [ ] Can describe 3 sharding strategies (range, hash, directory) with trade-offs
- [ ] Can explain CAP theorem and what it actually means in practice
- [ ] Can describe cache-aside, write-through, and write-behind with diagrams
- [ ] Can explain when to use REST vs gRPC vs WebSockets
- [ ] Can describe message queue guarantees (at-most-once, at-least-once, exactly-once)
- [ ] Can explain load balancing algorithms (round-robin, least connections, consistent hashing)
- [ ] Can perform back-of-envelope calculations (QPS, storage, bandwidth)

### Phase 2: Practice Individual Designs (Weeks 3-4)

**Goal:** Apply component knowledge to specific system designs, practicing the 45-minute structured format.

**Practice schedule (2 designs per week, 4 total):**

| Week | Design | Focus Areas | Time |
|------|--------|-------------|------|
| 3 | URL Shortener | Hash function, read-heavy optimization, caching | 45 min |
| 3 | Twitter Feed | Fanout strategy, ranking, social graph | 45 min |
| 4 | WhatsApp | WebSockets, message delivery, group messaging | 45 min |
| 4 | Uber | Geospatial indexing, real-time matching | 45 min |

**For each design, practice articulating:**

1. Requirements and scope (functional + non-functional)
2. Capacity estimation (QPS, storage, bandwidth - all with actual numbers)
3. API design (endpoints, request/response format)
4. Database schema (tables, relationships, data store choice with rationale)
5. High-level architecture (component diagram with data flow)
6. Detailed component design (key algorithms, caching strategy, data flow)
7. Scalability plan (handling 10x, 100x growth)
8. Trade-offs made and alternatives considered

### Phase 3: Under-Pressure Simulation (Weeks 5-6)

**Goal:** Practice articulating designs under realistic time pressure with an audience.

**Week 5:**
- 3 timed system design sessions (45 min each, speak aloud)
- 1 mock system design interview with peer or platform
- Review recordings, identify articulation gaps

**Week 6:**
- 2 timed sessions focusing on new designs (web crawler, rate limiter)
- 2 mock interviews (different designs each time)
- Practice handling follow-up questions ("What if you needed to scale 100x?")

### The 15 System Designs You Must Know

For each design, know the following cold: requirements, capacity estimation, database choice, core algorithm, scalability strategy, and one interesting trade-off.

| # | System | Core Challenge | Key Components |
|---|--------|---------------|----------------|
| 1 | URL Shortener | Hash collisions, read-heavy | Hash function, cache, NoSQL |
| 2 | Twitter Feed | Fanout at scale | Timeline service, fan-out, ranking |
| 3 | WhatsApp | Real-time delivery | WebSocket, message queue, E2E encryption |
| 4 | Instagram | Image storage/delivery | Object storage, CDN, feed service |
| 5 | YouTube | Video processing at scale | Transcoding pipeline, CDN, recommendation |
| 6 | Uber | Real-time geospatial | Geohash, matching, ETA calculation |
| 7 | Google Search | Indexing and ranking | Crawler, inverted index, PageRank |
| 8 | Notification System | Multi-channel delivery | Priority queue, rate limiting, templates |
| 9 | Rate Limiter | Distributed counting | Token bucket, sliding window, Redis |
| 10 | Distributed Cache | Consistency + performance | Consistent hashing, eviction, replication |
| 11 | Message Queue | Ordering + durability | Partitioning, consumer groups, ACKs |
| 12 | Web Crawler | Scale + politeness | URL frontier, dedup, robots.txt |
| 13 | Code Editor | Real-time collaboration | OT/CRDT, WebSocket, version control |
| 14 | E-Commerce | Transaction consistency | Payment processing, inventory, cart |
| 15 | Payment System | Reliability + compliance | Idempotency, ledger, reconciliation |

### Handling Follow-Up Questions

Common follow-up patterns and how to handle them:

| Follow-up Type | Example | How to Handle |
|----------------|---------|---------------|
| **Scale challenge** | "What if traffic 100x overnight?" | Discuss auto-scaling, caching tiers, database read replicas, CDN |
| **Failure mode** | "What if the database goes down?" | Discuss replication, failover, circuit breakers, graceful degradation |
| **Consistency** | "How do you handle stale data?" | Discuss consistency models, cache invalidation, eventual consistency trade-offs |
| **Cost** | "How would you reduce costs by 50%?" | Discuss tiered storage, reserved instances, caching to reduce DB load |
| **Security** | "How do you prevent abuse?" | Discuss rate limiting, authentication, input validation, audit logging |
| **Latency** | "How do you get p99 under 100ms?" | Discuss caching, connection pooling, async processing, geographic distribution |


### Junior → FAANG: System Design Study Framework Basics

The system design study framework structures your preparation for the most open-ended interview type. The three-phase approach: (1) learn the fundamental building blocks (load balancer, cache, database, message queue, CDN), (2) study 5-6 canonical system design problems deeply (URL shortener, social media feed, chat system, ride-sharing platform, video streaming), (3) practice designing novel systems by combining the building blocks under time pressure. Phase 1 and 2 build the vocabulary. Phase 3 builds the fluency.

### Senior @ FAANG: System Design Study Framework at the Senior Level: Depth Over Breadth

Senior candidates should apply the system design study framework with depth over breadth: studying 3 problems deeply (to the point where you can defend every design decision under adversarial questioning for 30 minutes) is more valuable than studying 10 problems shallowly. The depth standard at L6: you can estimate capacity from first principles, justify every major technology choice with alternatives considered and rejected, describe the failure modes of each component and the mitigation, and discuss the operational requirements (monitoring, alerting, deployment) of the complete system. Reaching this depth for 3 problems requires more time than most candidates allocate to system design, which is why it is a differentiating preparation investment.

---
