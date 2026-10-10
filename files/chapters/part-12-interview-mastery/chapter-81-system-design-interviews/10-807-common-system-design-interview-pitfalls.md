## 81.9 Common System Design Interview Pitfalls

### Pitfall 1: Diving Into Details Without High-Level Design

**Real Incident**: A candidate designing "URL shortener" at Google spent 20 minutes discussing database schema and indexing strategies before drawing a single architecture box. The interviewer had to interrupt and ask for the big picture, but time was already short.

**The Wrong Approach:**
- "First, let me design the database table with columns..."
- Start with implementation details
- Focus on one component without context

**The Right Approach:**
```
Order of discussion (45-minute interview):

1. Requirements (5 min)
   - Functional: What should the system do?
   - Non-functional: Scale, latency, availability targets

2. Capacity estimation (5 min)
   - QPS, storage, bandwidth calculations
   - Sets the scale for architecture decisions

3. High-level design (10 min)
   - Draw boxes: clients, services, databases
   - Show data flow between components

4. Deep dive (20 min)
   - NOW discuss database schema
   - NOW discuss specific algorithms
   - Interviewer often guides which area

5. Wrap-up (5 min)
   - Discuss trade-offs
   - Mention monitoring, failure scenarios
```

### Pitfall 2: Not Quantifying Scale with Numbers

**Real Incident**: A Meta candidate designed "Facebook Messenger" but couldn't answer "How many messages per second?" When pressed, they guessed wildly off numbers. The interviewer noted they should have done back-of-envelope math.

**The Wrong Approach:**
- "It's a lot of data, so we need distributed storage"
- Vague terms: "high throughput", "massive scale"
- Skip numbers because "math is hard in interviews"

**The Right Approach:**
```
Back-of-envelope calculation template:

URL Shortener Example:
- 500M new URLs/month
- Read:Write = 100:1
- 500M writes/month ≈ 200 writes/sec
- 200 × 100 = 20,000 reads/sec

Storage:
- Average URL: 100 bytes
- Metadata: 500 bytes per entry
- 500M × 600 bytes = 300GB/month
- 5-year retention: 18TB

"Based on these numbers, we need:
- Database that handles 20K reads/sec
- Storage capacity ~20TB
- This influences our architecture choices..."
```

### Pitfall 3: Single Point of Failure Blind Spot

**Real Incident**: An Amazon candidate designed a notification system with one Redis instance as the message queue. When asked "What if Redis dies?", they had no answer. L6 candidates are expected to think about failures proactively.

**The Wrong Approach:**
```
User → Single API Server → Single Database
       ↓
    Single Cache
```

**The Right Approach:**
```
For every component, ask: "What if this fails?"

User → Load Balancer (with standby)
       ↓
    API Servers (3+ replicas behind LB)
       ↓
    Redis Cluster (primary + replicas)
       ↓
    Database (leader + followers, cross-region)

"I've designed for failure at each layer:
- API servers: Multiple instances, stateless, any can handle requests
- Cache: Redis cluster with automatic failover
- Database: Primary-secondary replication, async to avoid latency hit
- Cross-region backup for disaster recovery"
```

### Pitfall 4: Ignoring Trade-offs

**Real Incident**: A Stripe candidate confidently said "We'll use Cassandra" without explaining why. When the interviewer asked "Why not PostgreSQL?", they couldn't articulate the trade-offs. Senior candidates must justify choices.

**The Wrong Approach:**
- "We'll use microservices" (Why?)
- "Let's add Redis for caching" (What's the cache invalidation strategy?)
- Stating decisions without trade-off analysis

**The Right Approach:**
```
For every design decision, state the trade-off:

"For the URL mappings database, I'm choosing Cassandra over PostgreSQL:

Cassandra pros:
- Linear scalability for writes (we have 200 writes/sec growing)
- No single point of failure
- Optimized for our access pattern (write once, read many by key)

PostgreSQL would be simpler but:
- Scaling writes requires sharding complexity
- We don't need ACID transactions for URL lookups

Trade-off: We sacrifice consistency (eventual consistency is fine here)
for availability and partition tolerance."
```

### Pitfall 5: Forgetting Caching Strategy Details

**Real Incident**: A LinkedIn candidate added "Cache" to their diagram but couldn't explain cache invalidation when the interviewer probed. Caching without invalidation strategy shows shallow understanding.

**The Wrong Approach:**
```
"We'll add cache here for performance"
(No details on what, when, or how)
```

**The Right Approach:**
```
Cache strategy should include:

1. What to cache
   - Hot data: frequently accessed URLs
   - Not: rarely accessed or one-time data

2. Cache policy
   - LRU eviction (most accessed stays)
   - TTL: 24 hours (URLs don't change)

3. Invalidation strategy
   - Write-through: Update cache when DB updates
   - Or cache-aside: Let cache expire, reload from DB

4. Cache misses
   - Fallback to database
   - Background refresh for popular keys

5. Cold start / cache stampede
   - Warm cache on deployment
   - Use mutex/singleflight to prevent thundering herd

"For URL shortener, I'm using cache-aside with 24h TTL
because URLs are immutable. No invalidation needed."
```

### Interview Pitfalls Quick Reference

| Pitfall | Interviewer's Reaction | Better Approach |
|---------|------------------------|-----------------|
| Details first | "Can you zoom out?" | Start with boxes, then drill down |
| No numbers | "How many QPS?" | Always do capacity estimation |
| No failure thinking | "What if X fails?" | Discuss redundancy for each component |
| Unjustified choices | "Why this database?" | State pros, cons, trade-offs |
| Surface-level caching | "How do you invalidate?" | Discuss policy, TTL, stampede prevention |
| No data flow | "How does data get here?" | Draw arrows, explain the journey |

---

### Junior → FAANG: Pitfall Prevention in System Design Is Process-Driven

System design pitfalls are almost all process failures, not knowledge failures. Diving into details without a high-level design is a process failure (skipping a step). Not discussing trade-offs is a process failure (omitting a required element). Not managing time is a process failure (ignoring the clock). These are fixable with deliberate habits rather than additional knowledge.

Build a pre-session checklist: before each mock design session, remind yourself: I will spend the first five minutes on requirements, I will state trade-offs for every major component I choose, I will draw data flow arrows for each connection I add, and I will check the clock at the 20-minute mark. After three to five sessions with this checklist, the habits become automatic.

Common junior pitfall that is easy to miss: no data flow. Many candidates draw boxes and connections but do not explain what data flows through each connection and in which direction. This makes the design hard to follow and suggests you have not fully thought through the data model. Practice annotating every arrow in your diagrams with "this carries [data] from [source] to [destination]."

### Senior @ FAANG: Senior-Level Pitfalls Are About Judgment, Not Process

The pitfall table in this section correctly identifies the anti-patterns. For senior candidates, the pitfalls that most commonly cause L5/L6 misses are the judgment-level ones: surface-level caching (proposing a cache without addressing invalidation), unjustified choices (picking a database because you know it, not because it fits), and no failure handling (a design that assumes all services are always available).

The "no failure handling" pitfall is particularly critical at senior level. A senior design must address: what happens when each external dependency is unavailable, how the system degrades gracefully under partial failure, and what the recovery procedure is when components restart. Designs without failure handling are not production-ready, and a bar-raiser interviewer will identify this immediately.

Governance application: senior engineers who participate in design reviews at FAANG use this pitfall list (or a version of it) as part of their review rubric. If you can describe how you systematically evaluate designs for these pitfalls during peer reviews, you are demonstrating both technical depth and organizational contribution, which is exactly what L6 behavioral rounds assess.
