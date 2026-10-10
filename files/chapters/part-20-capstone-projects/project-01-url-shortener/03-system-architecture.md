## System Architecture

A production URL shortener separates concerns into distinct layers: an API layer for handling requests, a caching layer for fast lookups, a database layer for durable storage, and an analytics layer for tracking usage. This separation makes each component independently testable and horizontally scalable.

### High-Level Design

```
┌──────────────┐
│    Client    │
└──────┬───────┘
       │ HTTPS
       │
┌──────▼───────────────────────────────────┐
│         Load Balancer (NGINX)            │
│    (Rate Limiting, SSL Termination)      │
└──────┬───────────────────────────────────┘
       │
       ├──────────────┬──────────────┐
       │              │              │
┌──────▼──────┐ ┌────▼──────┐ ┌────▼──────┐
│  API Server │ │  API      │ │  API      │
│     1       │ │  Server 2 │ │  Server 3 │
└──────┬──────┘ └────┬──────┘ └────┬──────┘
       │             │              │
       ├─────────────┴──────────────┘
       │
       ├──────────────┬──────────────┐
       │              │              │
┌──────▼──────┐ ┌────▼──────┐ ┌────▼──────┐
│   Redis     │ │ PostgreSQL│ │ ClickHouse│
│  (Cache)    │ │ (Primary) │ │(Analytics)│
└─────────────┘ └───────────┘ └───────────┘
```

### Components

1. **API Servers**: Stateless Go services (horizontally scalable)
2. **Redis Cluster**:
   - L1 Cache: Hot URLs (TTL: 1 hour)
   - Rate limiting counters
   - Distributed locks for collision handling
3. **PostgreSQL**:
   - URL mappings and metadata
   - User accounts and API keys
   - Configuration data
4. **ClickHouse**: Analytics time-series data (optional, can use PostgreSQL)
5. **Prometheus + Grafana**: Metrics and monitoring

### Data Flow

**URL Shortening Flow:**
```
1. Client → POST /api/v1/shorten
2. Validate URL & check rate limits
3. Generate short code (Base62)
4. Check collision (PostgreSQL)
5. Store in DB + warm cache
6. Return short URL
```

**URL Redirect Flow:**
```
1. Client → GET /:code
2. Check Redis cache (hit → redirect)
3. On miss → Query PostgreSQL
4. Update cache + redirect
5. Async: Record analytics event
```

---

### Junior → FAANG: Reading Architecture Diagrams as Interview Preparation

The architecture diagram above is exactly what you should be able to draw on a whiteboard in a system design interview. Practice drawing it from memory: start with the client, add the load balancer, then the application layer, then Redis, then PostgreSQL, then the analytics sink. Each arrow represents a protocol choice (HTTPS, TCP, binary protocol) and a latency budget.

The five-step redirect flow is your narrative for the read path. Memorize it and be able to explain what happens if step 2 (cache lookup) fails. The answer is fallthrough to step 3 (database) and then repopulation at step 4. That single sentence demonstrates you understand cache-aside pattern and graceful degradation.

Interviewers expect you to quantify the architecture. A cache hit on Redis should be sub-millisecond. A database lookup with proper indexing should be under 5ms. Know your numbers before the interview.

### Senior @ FAANG: Architecture as a Contract Between Teams

At senior level, an architecture diagram is not a description of implementation details. It is a contract between teams: the application tier commits to delivering requests to the cache at a defined rate, the cache tier commits to a hit rate SLA, the database tier commits to query latency under defined load. Every arrow on the diagram represents a negotiated interface.

The analytics pipeline deserves special attention. Making it asynchronous (step 5) correctly decouples the redirect latency from the analytics write latency, but it introduces at-least-once delivery semantics. Under failure, events may be dropped or duplicated. A senior engineer documents that tradeoff explicitly: "analytics data is best-effort, not guaranteed" is a product decision that should appear in the ADR, not just in the code comments.

At the L6 bar, interviewers push beyond the happy path. What happens when the Redis cluster loses a primary? The application tier must detect the failure, fall back to database reads, and avoid a thundering herd on the database. That scenario requires circuit breakers, jitter on retry, and monitoring that differentiates a cache miss storm from a normal traffic spike. Each of those concerns maps to a specific engineering decision that should be documented before the system goes to production.

Multi-region extensions of this architecture surface the hardest tradeoffs: where do writes land, how do cache invalidations propagate across regions, and how do you handle the window between a URL update and when all regional caches reflect the new destination? Those questions have no single right answer, but senior candidates are expected to name the tradeoffs and pick a position with justification.

---
