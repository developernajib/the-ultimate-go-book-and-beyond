## 83C.6 Mock System Design Interview 1: Design a URL Shortener (L4/L5)

### Interviewer Briefing

**Company style:** Generic FAANG. This is the canonical entry-level system design question. It tests whether candidates can handle requirements gathering, estimation, API design, data modeling, and basic distributed systems concepts. L4 candidates are expected to produce a working design. L5 candidates are expected to go deeper on scaling and trade-offs.

**Interview duration:** 45 minutes

### 45-Minute Timeline with Talking Points

**Minutes 0-5: Requirements Gathering**

*Interviewer says:* "Design a URL shortening service like bit.ly."

*What great candidates say:*

"Before I start designing, let me make sure I understand the requirements. For functional requirements: users can submit a long URL and get a short URL back. When someone visits the short URL, they're redirected to the original. Can users customize the short URL? Should short URLs expire? Do we need analytics - click counts, geographic data?"

*What the interviewer reveals:*
- Custom aliases: yes, optional
- Expiration: yes, default 5 years
- Analytics: basic click count only
- Read-heavy: 100:1 read-to-write ratio

**Minutes 5-10: Estimation**

*What great candidates say:*

"Let me estimate the scale. Assume 100 million new URLs per month - about 40 per second write, 4,000 per second read. Over 5 years, that's 6 billion URLs. Each record is roughly 500 bytes (short code, long URL, metadata), so 6 billion × 500B = 3TB of storage. For the short code, I need to support 6 billion unique codes. Base62 (a-z, A-Z, 0-9) with 7 characters gives 62^7 ≈ 3.5 trillion possibilities - more than enough."

**Minutes 10-20: High-Level Design**

*What great candidates say:*

"Here's my high-level architecture:

1. **API Gateway / Load Balancer** - distributes traffic across application servers
2. **Application Servers** - stateless, handle both create and redirect
3. **Database** - stores the mapping from short code to long URL
4. **Cache** - Redis/Memcached for hot URLs (read-heavy workload)
5. **ID Generation Service** - generates unique short codes

For the API:
- `POST /api/shorten` - body: `{url: string, customAlias?: string, expiresAt?: timestamp}` → returns `{shortUrl: string}`
- `GET /:shortCode` - 301/302 redirect to the original URL

For the database schema:
```
urls table:
  id          BIGINT PRIMARY KEY
  short_code  VARCHAR(10) UNIQUE INDEX
  long_url    TEXT NOT NULL
  created_at  TIMESTAMP
  expires_at  TIMESTAMP
  click_count BIGINT DEFAULT 0
```

For short code generation, I'll use a counter-based approach with base62 encoding. A dedicated counter service (backed by a distributed counter like ZooKeeper or a database sequence) issues monotonically increasing IDs. Each ID is encoded to base62. This guarantees uniqueness without collision checking."

**Minutes 20-30: Deep Dive - Scaling & Trade-offs**

*What great candidates say:*

"Let me address key scaling challenges:

**Database choice:** I'd use a relational database (PostgreSQL) for strong consistency on writes, but this could be swapped for DynamoDB/Cassandra if write volume exceeds what a single primary can handle.

**Caching strategy:** Read-through cache with Redis. Cache the short_code → long_url mapping. With 4,000 reads/second and assuming the top 20% of URLs account for 80% of traffic, we can cache the hot set in memory. A 10GB Redis instance can hold ~20 million cached mappings.

**ID generation at scale:** The counter-based approach is a single point of failure. To mitigate: pre-allocate ranges. Each app server claims a range of 10,000 IDs from the counter service. It then issues IDs from that range locally without network calls. When the range is exhausted, it claims a new one. This reduces contention and provides fault tolerance - if the counter service is briefly unavailable, servers continue issuing IDs from their current range.

**In Go, the application server** would look like:

```go
package shortener

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

type RedisClient interface {
    Get(ctx context.Context, key string) interface{ Result() (string, error) }
    Set(ctx context.Context, key string, value any, expiration time.Duration) error
}

type IDGenerator interface {
    NextID() (int64, error)
}

func base62Encode(id int64) string {
    return fmt.Sprintf("%x", id)
}

type URLShortener struct {
    db        *sql.DB
    cache     RedisClient
    idGen     IDGenerator
}

func (s *URLShortener) incrementClickCount(shortCode string) {}

func (s *URLShortener) Shorten(ctx context.Context, longURL string) (string, error) {
    id, err := s.idGen.NextID()
    if err != nil {
        return "", fmt.Errorf("generating ID: %w", err)
    }

    shortCode := base62Encode(id)

    _, err = s.db.ExecContext(ctx,
        `INSERT INTO urls (id, short_code, long_url, created_at, expires_at)
         VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '5 years')`,
        id, shortCode, longURL)
    if err != nil {
        return "", fmt.Errorf("inserting URL: %w", err)
    }

    return shortCode, nil
}

func (s *URLShortener) Redirect(ctx context.Context, shortCode string) (string, error) {
    // Check cache first
    longURL, err := s.cache.Get(ctx, shortCode).Result()
    if err == nil {
        // Async increment click count
        go s.incrementClickCount(shortCode)
        return longURL, nil
    }

    // Cache miss - query database
    var url string
    err = s.db.QueryRowContext(ctx,
        `SELECT long_url FROM urls WHERE short_code = $1 AND expires_at > NOW()`,
        shortCode).Scan(&url)
    if err != nil {
        return "", fmt.Errorf("URL not found: %w", err)
    }

    // Populate cache
    s.cache.Set(ctx, shortCode, url, 24*time.Hour)

    go s.incrementClickCount(shortCode)
    return url, nil
}
```

**301 vs 302 redirect:** 301 (permanent) lets browsers cache the redirect, reducing load. 302 (temporary) forces every request through our servers, enabling accurate analytics. I'd use 302 since we want click counting."

**Minutes 30-40: Reliability & Edge Cases**

*What great candidates say:*

"For reliability:
- **Database replication:** Primary-replica setup. Writes go to primary, reads can go to replicas (eventual consistency is fine for redirects - a few seconds of stale data is acceptable).
- **Cache failure:** If Redis goes down, fall back to database directly. Latency increases but service stays available.
- **Expiration cleanup:** A background job runs daily, deleting expired URLs in batches. Soft delete first (mark as expired), hard delete after 30 days.
- **Rate limiting:** Prevent abuse by rate-limiting create requests per IP/user (using the token bucket algorithm).
- **Collision handling for custom aliases:** Check if the custom alias exists before inserting. Use a database unique constraint as a safety net.

For monitoring in Go, I'd expose Prometheus metrics:
- `url_create_total` - counter of URLs created
- `url_redirect_total` - counter of redirects served
- `url_redirect_latency_seconds` - histogram of redirect latency
- `cache_hit_ratio` - gauge tracking cache effectiveness"

**Minutes 40-45: Q&A and Wrap-up**

*Interviewer may ask:* "What if we need to handle 10x more traffic?"

*Strong answer:* "For 40,000 reads/second: add more app server instances behind the load balancer (they're stateless). Shard the database by short_code hash - consistent hashing with virtual nodes for even distribution. Scale Redis to a cluster. The ID generation service already handles this via range pre-allocation. At 100x, I'd consider moving to a KV store like DynamoDB for the URL mapping since the access pattern is purely key-value lookup."

### Red Flags Interviewers Watch For

1. **Jumping to implementation** without clarifying requirements or estimating scale
2. **Over-engineering** - proposing Kafka, microservices, and ML for a URL shortener
3. **Ignoring estimation** - not knowing if you need 1 server or 1,000
4. **Single points of failure** - no replication, no cache, no graceful degradation
5. **Hash collision hand-waving** - saying "use MD5" without addressing collision handling
6. **No API design** - jumping to database schema without defining the interface
7. **Ignoring security** - no rate limiting, no input validation, no spam prevention
8. **Cannot reason about trade-offs** - every choice has a downside. Candidates should acknowledge them

### Sample Dialogue Transcript

> **Interviewer:** "Design a URL shortening service."
>
> **Candidate:** "Great. Before I dive in, I'd like to understand the scope. Are we building something like bit.ly with public access, or an internal tool? Should users need accounts? Do we need analytics beyond basic click counts?"
>
> **Interviewer:** "Public access, no accounts required for basic shortening. Basic click count analytics."
>
> **Candidate:** "Got it. Let me also clarify the scale. How many URLs do we expect per month? And what's the read-to-write ratio?"
>
> **Interviewer:** "Assume 100 million new URLs per month and a 100:1 read-to-write ratio."
>
> **Candidate:** "Perfect. So roughly 40 writes per second and 4,000 reads per second. Over 5 years, 6 billion total URLs. Let me start with the API design..."
>
> *(Candidate draws on whiteboard/shared doc)*
>
> **Candidate:** "...and for the short code generation, I see two main approaches: hash-based and counter-based. The hash approach takes the long URL, hashes it, and takes the first N characters. The pro is simplicity. the con is collision handling. The counter approach uses a monotonically increasing counter and base62 encodes it. The pro is guaranteed uniqueness. the con is predictability - users could enumerate URLs. I'll go with the counter approach because uniqueness without collision is more important, and we can add entropy by shuffling the base62 alphabet."
>
> **Interviewer:** "What about the predictability concern? If I shorten a URL and get code 'abc123', can I guess that 'abc124' also exists?"
>
> **Candidate:** "Good point. Three mitigations: first, use a non-sequential mapping - apply a bijective function (like Knuth's multiplicative hash) to the counter before base62 encoding. This makes consecutive IDs map to very different short codes. Second, the shuffled alphabet means an attacker doesn't know our base62 encoding. Third, for sensitive use cases, we could add a random salt per URL. The trade-off is that the first approach is deterministic and reversible (we can recover the ID from the code), while the salt approach requires storing the mapping."
>
> **Interviewer:** "Good. Tell me more about the caching layer."
>
> *(Interview continues...)*

### Scoring Rubric

| Rating | Criteria |
|--------|----------|
| **Strong Hire** | Clear requirements gathering. Accurate estimation. Clean API and data model. Discusses multiple ID generation approaches with trade-offs. Comprehensive caching strategy. Addresses reliability, monitoring, and security. Can scale the design when asked. |
| **Hire** | Good requirements gathering. Reasonable estimation. Working design with database, cache, and app servers. Discusses at least one trade-off in depth. Addresses basic reliability. |
| **Lean Hire** | Needs prompting to gather requirements. Estimation is rough but in the right ballpark. Design works but misses caching or reliability. Limited trade-off discussion. |
| **No Hire** | Cannot estimate scale. Design has fundamental flaws (e.g., no database, no uniqueness guarantee). Cannot discuss trade-offs. No mention of reliability or caching. |


### Junior → FAANG: URL Shortener System Design Basics

The URL shortener is a classic entry-level system design question because it has clear requirements (shorten a URL, redirect with low latency), tractable scale (millions of URLs, billions of redirects), and several interesting design decisions (key generation strategy, storage choice, caching). The core design: a key-value store mapping short codes to long URLs, a stateless redirect service, and an optional cache layer. Key decisions: how to generate unique short codes (random with collision detection, sequential with base62 encoding, or hash-based), what to store (short code to original URL mapping, creation time, creator), and how to handle expiry.

### Senior @ FAANG: URL Shortener at the L5/L6 Bar: Scale, Analytics, and Operational Concerns

At the L5/L6 level, the URL shortener question is evaluated on the depth of the design discussion, not the completeness of the basic design. The L6-level discussion includes: read/write ratio analysis (redirects vastly outnumber writes, which means the cache hit rate drives the overall system performance), key generation at scale (a centralized incrementing counter is a single point of failure, distributed ID generation like Snowflake or Twitter's approach solves this), custom domain support (a customer wants their own domain for shortened URLs, which requires multi-tenant routing and TLS termination), and analytics (click tracking in real time, geographic distribution of clicks, time-series storage for aggregate metrics). The bar-raiser specifically probes for the cache invalidation strategy: when a URL is deleted or updated, how do you ensure cached redirects go away?

---
