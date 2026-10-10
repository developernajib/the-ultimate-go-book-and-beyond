## Exercises

### Exercise 1: Interview Preparation Plan

**Objective**: Create a detailed preparation plan for interviewing at a specific company.

**Instructions**: Choose a target company (e.g., Google, Stripe, a startup you're interested in) and create a 4-week preparation plan covering all interview types.

**Solution**:

```markdown
# 4-Week Interview Prep Plan: Google L5 (Senior SWE)

## Week 1: Assessment and Foundation

### Day 1-2: Assessment
- [ ] Take 3 LeetCode problems (easy, medium, hard) to assess level
- [ ] Time yourself and note where you struggle
- [ ] List system design topics you're weak on
- [ ] Identify behavioral story gaps

### Day 3-5: Foundation Building
- [ ] Review data structures: arrays, hash maps, trees, graphs, heaps
- [ ] Review algorithms: BFS/DFS, binary search, two pointers
- [ ] Read "Designing Data-Intensive Applications" intro chapters
- [ ] Start behavioral story bank (aim for 5 stories by week end)

### Day 6-7: Company Research
- [ ] Read Google engineering blog (5 recent posts)
- [ ] Research Google's interview process
- [ ] Watch YouTube videos of Google interview tips
- [ ] Understand Google's leadership expectations (Googliness)

## Week 2: Coding Focus

### Daily (2 hours coding):
- [ ] 2 LeetCode problems per day (1 medium, 1 hard)
- [ ] Focus patterns: sliding window, DP, graphs, trees
- [ ] Practice explaining approach before coding
- [ ] Time limit: 30 min per problem

### Pattern Coverage:
- [ ] Monday: Arrays and strings
- [ ] Tuesday: Trees and graphs
- [ ] Wednesday: Dynamic programming
- [ ] Thursday: System design basics (URL shortener)
- [ ] Friday: Hard problems review
- [ ] Weekend: Mock coding interview (Pramp)

## Week 3: System Design Focus

### System Designs to Practice:
- [ ] Monday: URL Shortener (warm-up)
- [ ] Tuesday: Design Twitter
- [ ] Wednesday: Design YouTube
- [ ] Thursday: Design Google Search
- [ ] Friday: Design Maps/Navigation
- [ ] Weekend: Mock system design interview

### For Each Design, Cover:
- Requirements gathering
- High-level architecture
- Database schema
- API design
- Scaling considerations
- Trade-offs discussed

## Week 4: Integration and Mock Interviews

### Day 1-2: Behavioral Prep
- [ ] Finalize 8 stories covering all competencies
- [ ] Practice each story out loud (2 min max)
- [ ] Map stories to Google's Googliness questions
- [ ] Prepare questions to ask interviewers

### Day 3-4: Full Mock Interviews
- [ ] Mock coding interview (friend or service)
- [ ] Mock system design interview
- [ ] Mock behavioral interview
- [ ] Get feedback and adjust

### Day 5-6: Review and Refine
- [ ] Review weak areas from mocks
- [ ] Light coding practice (don't burn out)
- [ ] Prepare interview day logistics
- [ ] Practice interview close and follow-up

### Day 7: Rest
- [ ] Light review only
- [ ] Good sleep
- [ ] Mental preparation
- [ ] No new problems

## Weekly Time Commitment
- Coding practice: 2 hours/day
- System design: 1 hour/day (weeks 3-4)
- Behavioral prep: 30 min/day
- Company research: 30 min/day
- Total: ~4 hours/day = 28 hours/week

## Success Metrics
- Solve 80% of medium problems in 25 min
- Complete 2 system designs in 45 min each
- Tell all 8 behavioral stories under 2 min
- Score 80%+ on mock interviews
```

### Exercise 2: STAR Story Bank

**Objective**: Develop a complete set of behavioral stories using the STAR method.

**Instructions**: Write out 6 complete STAR stories covering the most common behavioral competencies.

**Solution**:

```markdown
# STAR Story Bank

## Story 1: Technical Leadership
**Question Type**: "Tell me about a time you led a technical project"

**Situation**: At my previous company, our payment processing system
was experiencing 2-second latencies during peak times, causing customer
complaints and lost transactions.

**Task**: As the senior engineer on the platform team, I was responsible
for diagnosing and fixing the performance issues. The business was losing
approximately $50K/day due to abandoned checkouts.

**Action**:
1. Implemented distributed tracing using Jaeger to identify bottlenecks
2. Discovered N+1 query problem in order service making 500+ DB calls
   per request
3. Led a design review with the team to propose batched queries +
   Redis caching
4. Implemented the solution in 2 weeks, coordinating with 3 other
   engineers
5. Set up monitoring dashboards to track latency improvements

**Result**:
- Reduced p99 latency from 2 seconds to 150ms (13x improvement)
- Decreased abandoned checkouts by 40%
- Recovered approximately $20K/day in previously lost revenue
- The caching pattern I designed was adopted by 4 other teams

---

## Story 2: Conflict Resolution
**Question Type**: "Tell me about a disagreement with a colleague"

**Situation**: Our team was building a new authentication service.
A senior colleague strongly advocated for building custom auth from
scratch, while I believed we should use Auth0.

**Task**: I needed to advocate for my position while maintaining a
productive working relationship with a respected colleague.

**Action**:
1. Scheduled a 1-on-1 to understand their concerns without an audience
2. Learned they were worried about vendor lock-in and cost
3. Created a comparison document addressing their specific concerns
   with data
4. Proposed a compromise: use Auth0 initially with abstraction layer
   enabling future migration
5. Presented jointly to the team, acknowledging valid concerns on
   both sides

**Result**:
- Team adopted Auth0 with migration abstraction layer
- Launched 6 weeks ahead of building custom
- Colleague became an advocate for the approach
- We still work well together; I was best man at his wedding

---

## Story 3: Failure and Learning
**Question Type**: "Tell me about a time you failed"

**Situation**: I was leading a database migration from MySQL to
PostgreSQL. It was my first time owning a major infrastructure project.

**Task**: Migrate 50GB of production data with minimal downtime,
targeting < 30 minutes.

**Action**:
1. Built and tested migration scripts in staging environment
2. Scheduled migration for low-traffic Sunday morning
3. Started migration - but I had underestimated data volume growth
4. Migration ran for 4 hours instead of 30 minutes
5. Customers experienced degraded service; I had to escalate

**Result**:
- Migration eventually completed, but with 4 hours of degraded service
- Customers complained; we issued credits
- I owned the failure in the postmortem

**Learning**:
- Always test with production-sized data
- Have rollback plan for every migration
- Build in buffer for unknowns (I now use 3x estimates)
- Since then, I've led 5 successful migrations with zero issues

---

## Story 4: Mentoring
**Question Type**: "Tell me about helping someone grow"

**Situation**: A junior engineer joined our team who was struggling.
She had strong potential but was overwhelmed by our complex codebase
and making frequent mistakes in code reviews.

**Task**: Help her become productive while maintaining team velocity
and quality standards.

**Action**:
1. Scheduled weekly 1-on-1s specifically for learning (separate from
   standups)
2. Created an onboarding document explaining our systems (which didn't
   exist before)
3. Assigned her smaller, well-scoped tasks with clear success criteria
4. Pair programmed on complex features instead of just reviewing her code
5. Gave specific, actionable feedback ("use this pattern because X")
   instead of vague criticism

**Result**:
- Within 3 months, she was contributing independently
- Her code review approval rate went from 40% to 90%
- She later led a major feature herself
- She was promoted to mid-level within a year
- The onboarding document I created is now standard for all new hires

---

## Story 5: Working Under Pressure
**Question Type**: "Tell me about handling a high-pressure situation"

**Situation**: Our production payment system went down during Black
Friday, our biggest sales day. We were losing approximately $100K
per hour.

**Task**: As the on-call engineer, I needed to diagnose and fix the
issue as quickly as possible.

**Action**:
1. Immediately notified stakeholders and set up war room
2. Checked metrics dashboards - saw database connections maxing out
3. Traced to a recent deployment that introduced a connection leak
4. Made quick decision to rollback rather than hotfix
5. Rollback completed in 8 minutes
6. Stayed online to monitor and ensure stability
7. Led postmortem next day to prevent recurrence

**Result**:
- Total downtime: 18 minutes
- Estimated loss: ~$30K (significant but contained)
- Postmortem led to implementing connection pool monitoring
- Implemented mandatory load testing for any DB-touching changes
- Received recognition from VP for quick response

---

## Story 6: Cross-Team Collaboration
**Question Type**: "Tell me about working across teams"

**Situation**: Our team needed to integrate with a service owned by
another team for a critical product launch. The other team had
different priorities and was resistant to making changes.

**Task**: Get the integration completed within 6 weeks to meet
product launch, despite having no direct authority over the other team.

**Action**:
1. First, I met with their tech lead to understand their constraints
   and priorities
2. Discovered they were under pressure for their own deadlines
3. Offered to write the integration code myself, tested on their end
4. Created detailed API specs to minimize back-and-forth
5. Found a way to frame the integration as helping their metrics too
6. Escalated once (transparently) when we hit a real blocker

**Result**:
- Integration completed in 5 weeks
- Launched on time with zero integration issues
- Built strong relationship with the other team's tech lead
- They came to us for help on their next project
- I was asked to lead the next cross-team initiative

---

## Usage Guide

For each story, I can adapt emphasis based on question:

| Question Focus | Stories to Use | Emphasis |
|----------------|----------------|----------|
| Leadership | 1, 4, 5 | Leading others, decision-making |
| Conflict | 2, 6 | Communication, finding common ground |
| Failure | 3 | Accountability, learning, growth |
| Technical | 1, 3, 5 | Deep technical problem-solving |
| Collaboration | 2, 4, 6 | Working with others, influence |
| Pressure | 5 | Calm under stress, quick decisions |
| Growth | 4 | Developing others, patience |
```

### Exercise 3: System Design Interview Simulation

**Objective**: Practice structuring a complete system design interview in 45 minutes.

**Problem**: Design a URL shortening service like bit.ly.

**Solution**:

```markdown
# System Design: URL Shortener (45-minute structure)

## Minutes 0-5: Requirements Clarification

### Functional Requirements (asked interviewer)
- Shorten long URLs to short links
- Redirect short links to original URLs
- Custom short codes allowed?
- Expiration for links?
- Analytics (click counts)?

### Confirmed Requirements
✓ Basic shorten + redirect
✓ Optional custom aliases
✓ Optional expiration (default: never)
✓ Basic analytics (click count)

### Non-Functional Requirements (discussed)
- Scale: 100M URLs created/month
- Read-heavy: 100:1 read/write ratio
- Availability: 99.9% uptime
- Latency: < 100ms for redirects

### Back-of-Envelope Calculations
- 100M URLs/month = ~40 URLs/second write
- 100:1 ratio = ~4000 redirects/second read
- Storage: 100M × 1KB = 100GB/month
- 5 years = 6TB total storage

## Minutes 5-15: High-Level Design

The first ten minutes of design time should produce a coarse-grained architecture that names every major component and the data flow between them, not to be perfect, but to give you and the interviewer a shared map to reason from. Starting with a load balancer → API tier → cache → database sketch forces you to make explicit choices about where reads are served (cache vs. database), which immediately surfaces the tradeoffs the rest of the discussion will revolve around. Showing this layer of thinking early signals that you design top-down and can hold a whole system in your head before diving into any single component.

```
┌─────────────────────────────────────────────────────────────┐
│ HIGH-LEVEL DESIGN │
├─────────────────────────────────────────────────────────────┤
│ │
│ ┌─────────┐ ┌──────────────┐ ┌─────────────────┐ │
│ │ Client │────▶│ Load Balancer│────▶│ API Servers │ │
│ └─────────┘ └──────────────┘ └─────────────────┘ │
│ │ │
│ ▼ │
│ ┌─────────────────────────────────────┐ │
│ │ Cache (Redis) │ │
│ └─────────────────────────────────────┘ │
│ │ │
│ ▼ │
│ ┌─────────────────────────────────────┐ │
│ │ Database (PostgreSQL) │ │
│ └─────────────────────────────────────┘ │
│ │
│ API ENDPOINTS: │
│ POST /api/shorten { url: "...", custom_alias?: "..." } │
│ GET /{short_code} → 301 Redirect │
│ GET /api/stats/{short_code} → Analytics │
│ │
└─────────────────────────────────────────────────────────────┘
```

## Minutes 15-35: Deep Dive

### Short Code Generation

**Option 1: Base62 Encoding of Counter**
```
Counter: 1, 2, 3, ...
Encode: a, b, c, ..., 9a8b7c, ...
Length: 7 chars = 62^7 = 3.5 trillion codes
Pros: Simple, sequential
Cons: Predictable, single point of failure
```

**Option 2: Hash-based (chosen)**
```
Hash = MD5(url + timestamp + random)
Short_code = base62(hash[0:7])
Check collision, regenerate if needed
Pros: Distributed generation, not predictable
Cons: Possible collisions (handle with retry)
```

### Database Schema

The schema centers on a single `urls` table because URL shortening is fundamentally a key-value lookup: the `short_code` column is the primary access path, so it carries a unique index that guarantees both correctness (no duplicate codes) and O(1) retrieval speed. A partial index on `expires_at` keeps expiration queries efficient without penalizing rows that never expire.

```

```sql
CREATE TABLE urls (
 id BIGSERIAL PRIMARY KEY,
 short_code VARCHAR(10) UNIQUE NOT NULL,
 original_url TEXT NOT NULL,
 user_id BIGINT,
 created_at TIMESTAMP DEFAULT NOW(),
 expires_at TIMESTAMP,
 click_count BIGINT DEFAULT 0
);

CREATE INDEX idx_short_code ON urls(short_code);
CREATE INDEX idx_expires_at ON urls(expires_at)
 WHERE expires_at IS NOT NULL;
```

### Caching Strategy

Because redirects are read-heavy and the original URL for a given short code almost never changes, Redis is an ideal caching layer: a 24-hour TTL keeps the working set hot while bounding memory growth. The write-through pattern ensures that a freshly created short URL is immediately available in the cache, eliminating the cold-start penalty on the first redirect.

```
Read Path (redirect):
1. Check Redis cache for short_code
2. Cache hit → return original_url
3. Cache miss → query DB, cache result, return
4. Cache TTL: 24 hours

Cache Key: "url:{short_code}" → original_url

Write-Through:
- On create, write to DB and cache simultaneously
- Ensures cache is warm for new URLs
```

### Handling 4000 reads/second

Reaching 4,000 redirects per second with low latency requires distributing load across all three layers (cache, database, and CDN) rather than relying on any single tier to absorb the traffic alone. The strategy below shows how Redis read replicas absorb the bulk of lookups, database read replicas handle cache misses, and CDN edge caching eliminates round-trips to the origin entirely for the most popular URLs.

```
Strategy:
1. Redis cluster (read replicas)
 - 1 master + 3 replicas
 - Each replica handles ~1300 req/s

2. Database optimization
 - Read replicas for DB queries
 - short_code is indexed (O(1) lookup)
 - Connection pooling

3. CDN for static redirects
 - Edge caching for popular URLs
 - Reduces load on API servers
```

### Minutes 35-45: Trade-offs and Extensions

### Trade-offs Discussed

| Decision | Trade-off |
|----------|-----------|
| Hash vs Counter | Distributed generation vs simplicity |
| PostgreSQL vs NoSQL | Consistency vs raw speed |
| Cache-aside vs Write-through | Simplicity vs consistency |
| 301 vs 302 redirect | SEO vs analytics accuracy |

### Potential Bottlenecks
1. Database writes → Solution: write-behind queue
2. Hot URLs → Solution: CDN caching at edge
3. Hash collisions → Solution: retry with salt

### Extensions (if time)
- Rate limiting per user
- URL validation (block malicious)
- Custom domains
- QR code generation
- Geographic analytics

### Monitoring
- Latency percentiles (p50, p95, p99)
- Cache hit ratio (target: > 95%)
- Database query times
- Error rates by type
```

### Junior → FAANG: Turning Exercises Into Interview Readiness

The exercises in this section are preparation tools, not demonstrations of existing knowledge. Treat them as timed simulations with the constraint that you produce output that you would actually say in an interview, not notes you would refer to. The gap between knowing an answer and delivering it under pressure is the gap these exercises are designed to close.

For behavioral exercises: record yourself on video answering each question. Watch the recording once without audio to check for nervous physical habits (looking away, touching your face, speaking too fast). Watch once with audio to check for filler words and imprecision. This is uncomfortable but it is the fastest feedback loop available for behavioral interview preparation.

For system design exercises: do them on a physical whiteboard or shared drawing tool rather than in notes. The constraint of working in a medium designed for presentation rather than thinking forces the clarity that interviewers are evaluating.

### Senior @ FAANG: Senior-Level Exercise Extensions and ADR Practice

Each exercise in this section has a senior extension: after completing the standard version, add a section that addresses organizational complexity. For a system design exercise, add a paragraph on how you would drive alignment across three teams with different priorities about the shared component you designed. For a behavioral exercise, extend the story to include the downstream effects on other teams and what governance mechanism you put in place to prevent the same issue from recurring.

This extension practice builds the answer layer that distinguishes L6 responses from L5 responses. The base answer demonstrates technical competence. The extension demonstrates organizational scope. Both are required to clear L6 at any major FAANG company, and the extension is the part most senior candidates fail to prepare.

---
```
