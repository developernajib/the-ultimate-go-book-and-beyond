# System Design Interview Playbook

System design interviews are not about memorizing the "right" answer. Interviewers at senior-level companies are watching how you think, what questions you ask, and whether you understand trade-offs. This chapter gives you a repeatable four-step framework and a worked example to practice with.

---

## Why Most Candidates Fail

They jump straight into drawing boxes before asking a single question. They propose a microservices architecture for a system that gets 100 requests per day. They describe how to scale read throughput when the interviewer is testing write throughput reasoning. They never ask about failure modes.

The fix is a structured framework you run every time, regardless of the problem.

---

## The Four-Step Framework

### Step 1: Clarify Requirements (5 minutes)

Do not design anything yet. Ask until you understand what you are actually building and the scale you are building for.

Questions to always ask:

**Functional requirements**
- What are the core features? (not every feature, the essential ones)
- Read-heavy or write-heavy? What ratio?
- Does the system need to be real-time (WebSocket push) or polling is acceptable?
- Are there strong consistency requirements, or is eventual consistency acceptable?

**Non-functional requirements**
- How many daily active users (DAU)?
- What is the latency SLA? (p99 under 200ms, or is 2 seconds fine?)
- What data volume will we store? (gigabytes, terabytes, petabytes)
- What availability target? (99.9% is 9 hours downtime per year, 99.99% is 53 minutes)
- Any geographic distribution requirements?

Write the answers on the whiteboard. You will refer back to them when making trade-off decisions later.

---

### Step 2: Estimate Scale (5-10 minutes)

Turn the DAU number into concrete system requirements. This tells you which components you need and how many.

**The estimation chain:**

```
DAU → RPS → Storage per day → Bandwidth
```

Work it through for a URL shortener:

- 100M DAU
- Assume 10% of users create one URL per day: 10M writes/day
- 10M / 86,400 seconds = ~115 write RPS
- Reads are 10x writes (common assumption unless told otherwise): ~1,150 read RPS
- Each URL record: 500 bytes (short URL + long URL + metadata)
- Storage per day: 10M * 500 bytes = 5 GB/day
- Five years of storage: 5 GB * 365 * 5 = ~9 TB

Now you know you need a system that handles roughly 1,200 RPS total, stores about 9 TB over five years, and reads dominate writes 10:1.

Those numbers immediately tell you:
- A single database server is enough for the write volume.
- Reads can use caching aggressively (the same popular URLs get hit constantly).
- 9 TB is large but not extreme. A single Postgres instance with SSDs handles this.

Write the numbers on the board. Round numbers are fine. The goal is an order-of-magnitude sanity check, not accounting-level precision.

---

### Step 3: Design the System

Start with the simplest correct architecture, then add components only where your scale estimates justify them.

**The starting skeleton:**

```
Client --> Load Balancer --> App Servers --> Database
```

Draw it. Then walk through a core request end-to-end. For a URL shortener: "User pastes a long URL, hits POST /shorten, app server generates a short code, stores the mapping in Postgres, returns the short URL."

Then ask yourself: where does this break at scale?

- 1,150 read RPS hitting Postgres directly. Most of those reads are for the same popular URLs. Add a Redis cache in front of the database for reads.
- What if one app server goes down? The load balancer handles it, but app servers must be stateless.
- What if the database goes down? Add a read replica. Consider if you need a primary failover (AWS RDS Multi-AZ handles this automatically).

Add components in response to specific problems, not speculatively:

```
Client --> CDN (static assets)
       --> Load Balancer --> App Servers --> Redis (read cache)
                                        --> Postgres Primary (writes)
                                        --> Postgres Replica (reads)
```

For the URL shortener, this is probably enough. Do not add Kafka, Cassandra, and a microservices mesh unless you have a reason.

---

### Step 4: Identify Bottlenecks and Trade-offs

After sketching the design, explicitly call out bottlenecks and what you would do about them. This is where senior candidates separate themselves.

**Common bottleneck patterns and solutions:**

| Bottleneck | Signal | Solution |
|---|---|---|
| DB reads slow | High read RPS, same data requested repeatedly | Cache layer (Redis), read replicas |
| DB writes slow | Write queue building up, high write latency | Message queue (async writes), sharding |
| Single service at capacity | CPU bound on one tier | Horizontal scale behind load balancer |
| Hot partition in cache | One key hit millions of times/second | Cache at multiple layers, CDN for that response |
| No failover | Any single component = downtime | Replicas, multi-AZ, health checks |

Explicitly discuss the trade-offs you made:

- "I chose eventual consistency for reads to get lower latency. Writes go to the primary, reads may see data that is a few seconds old."
- "I chose a hash-based short code generator instead of a database sequence to avoid a write bottleneck on the ID column."
- "I am not sharding Postgres here. At 115 write RPS, a single primary is nowhere near its limit. Sharding would add complexity with no benefit."

---

## What FAANG Interviewers Actually Evaluate

Breadth of knowledge matters, but it is not enough. They are watching for:

1. **Requirement gathering.** Did you ask the right questions before designing?
2. **Proportional complexity.** Is your design as simple as the scale requires, or did you over-engineer?
3. **Trade-off reasoning.** Can you articulate what you gave up with each decision?
4. **Failure mode awareness.** Did you consider what happens when each component fails?
5. **Communication.** Can you explain the system clearly to someone who has not seen it before?

They are not looking for a memorized design. Two candidates who arrive at different correct designs for the same problem will both pass if they can explain their reasoning.

---

## Mistakes That Eliminate Candidates

**Jumping to design without clarifying.** If you start drawing boxes within 60 seconds, you will almost certainly design for the wrong constraints.

**Over-engineering.** Proposing Cassandra, Kafka, multiple microservices, and a distributed cache for a system that could fit on two servers with a Postgres database makes you look like someone who pattern-matches without thinking.

**Ignoring failure modes.** If your design has one database with no replica and no failover, the interviewer will ask what happens when it crashes. "It goes down" is not an acceptable answer at senior level.

**Never finishing.** Spending 40 of 45 minutes on the first two steps leaves no time to show depth. Practice pacing.

**Not knowing your numbers.** Memorize these: 1M seconds is ~12 days, 1 GB is ~1B bytes, an in-process cache read is sub-microsecond, a Redis read is under 1ms within the same datacenter, an indexed database query is 1-10ms, and a cross-region round trip is 50-150ms.

---

## Worked Example: Design a URL Shortener

### Step 1: Clarify

- Core feature: create a short URL from a long URL, redirect short URL to long URL.
- Read-to-write ratio: 100:1 (reads dominate heavily).
- No real-time requirement.
- Strong consistency: a URL must resolve immediately after creation.
- DAU: 100M. Latency SLA: redirect under 100ms p99.

### Step 2: Estimate

- 10M URL creations per day = 115 write RPS
- 1B redirects per day = 11,600 read RPS
- Storage per URL: ~500 bytes
- 10M URLs/day * 500 bytes = 5 GB/day
- Five years: ~9 TB

### Step 3: Design

**Short code generation in Go:**

```go
const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func generateCode() string {
    b := make([]byte, 7)
    for i := range b {
        b[i] = charset[rand.IntN(len(charset))]
    }
    return string(b) // 62^7 = ~3.5 trillion unique codes
}
```

**Redirect handler with Redis cache:**

```go
func redirectHandler(rdb *redis.Client, db *sql.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        code := r.PathValue("code")
        ctx := r.Context()

        // Check cache first
        longURL, err := rdb.Get(ctx, "url:"+code).Result()
        if err == nil {
            http.Redirect(w, r, longURL, http.StatusMovedPermanently)
            return
        }

        // Cache miss: query database
        row := db.QueryRowContext(ctx, "SELECT long_url FROM urls WHERE code = $1", code)
        if err := row.Scan(&longURL); err != nil {
            http.NotFound(w, r)
            return
        }

        // Populate cache with a long TTL (URLs rarely change)
        rdb.Set(ctx, "url:"+code, longURL, 24*time.Hour)
        http.Redirect(w, r, longURL, http.StatusMovedPermanently)
    }
}
```

**Architecture:**

```
Client
  --> CDN (caches 301 redirects at edge)
  --> Load Balancer (nginx or AWS ALB)
  --> App Servers (stateless Go binaries, horizontally scaled)
       --> Redis (cache for url: lookups, TTL 24h)
       --> Postgres Primary (writes: create URL)
       --> Postgres Replica (reads: resolve URL on cache miss)
```

### Step 4: Bottlenecks

- 11,600 read RPS. Redis handles ~100k RPS per node. One Redis instance is fine. Add a replica for failover.
- Popular URLs (viral links) hit the same cache key millions of times. CDN-level caching of 301 redirects at the edge removes this load entirely from the origin.
- The code generator uses random strings. Collision probability is negligible at 7 characters from 62 symbols (3.5 trillion possibilities). Check for collision on insert with a unique constraint and retry on conflict.
- Single point of failure: Postgres primary. Use AWS RDS Multi-AZ for automatic failover.

**Trade-off called out:** 301 redirects are cached by browsers and CDNs permanently. This means if you delete or update a short URL, clients who cached the redirect will not see the change. Use 302 for mutable URLs if that matters to the product.

---

## Quick Reference: Clarifying Questions Cheat Sheet

| Category | Questions |
|---|---|
| Scale | DAU, peak RPS, data volume, growth rate |
| Consistency | Can reads be slightly stale? Must writes be immediately visible? |
| Latency | p99 target in milliseconds? Real-time or async acceptable? |
| Availability | Acceptable downtime? Geographic distribution required? |
| Features | What are the two or three core features? What is out of scope? |

Practice this framework on three different problems (chat system, news feed, ride-sharing dispatch) before your interview. The framework is the same, the components differ.

**Watch:** [System Design Course](https://www.youtube.com/watch?v=C842vFY5kRo)
