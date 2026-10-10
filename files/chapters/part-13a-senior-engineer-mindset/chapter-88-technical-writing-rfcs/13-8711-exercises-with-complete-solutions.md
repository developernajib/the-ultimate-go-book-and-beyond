## Exercises

### Exercise 1: Write an RFC for Database Migration

**Scenario**: Your team currently uses MongoDB for a social media application's user data (profiles, connections, activity). You want to propose migrating to PostgreSQL for better consistency guarantees and relational queries. Write a complete RFC.

**Complete Solution**:

````markdown
# RFC-2025-003: Migrate User Data from MongoDB to PostgreSQL

**Status**: Draft
**Author**: [Your Name]
**Created**: 2025-01-15
**Last Updated**: 2025-01-15
**Reviewers**: @database-team, @backend-team, @sre-team

---

## Executive Summary

We propose migrating 50M user records from MongoDB to PostgreSQL over 8 weeks
to eliminate data consistency issues that cause 15+ support tickets weekly
and enable relational queries that currently require complex application logic.

---

## Motivation

### Current Problems

1. **Data Consistency Issues**: MongoDB's eventual consistency causes 15-20
   support tickets weekly where users see stale connection data. Users report
   "I accepted the friend request but they're not showing up."

2. **Complex Application Logic**: Fetching a user's connections with mutual
   friends requires 4 separate queries and application-side joins. This code
   is bug-prone and slow (p99: 450ms).

3. **Schema Drift**: Without enforced schemas, we have 12 different "shapes"
   of user documents accumulated over 3 years. New features require handling
   all variants.

### What Happens If We Do Nothing

- Support tickets will grow as user base grows
- Feature development velocity will decrease (20% of backend time is
  schema handling)
- Data quality will continue degrading

### Why Now

- We have a natural migration window: Q2 user growth initiative paused
- Team has PostgreSQL expertise from recent payment system work
- MongoDB license renewal in Q3 ($180K annual)

---

## Proposal

### Overview

Migrate user data to PostgreSQL using a dual-write strategy over 8 weeks:
- Week 1-2: Set up PostgreSQL schema, deploy dual-write
- Week 3-4: Backfill historical data, validate consistency
- Week 5-6: Switch reads to PostgreSQL, monitor
- Week 7-8: Remove MongoDB writes, decommission

### Detailed Design

#### Schema Design

The relational model enforces data integrity through foreign key constraints and unique indexes that MongoDB's document store could not guarantee at the database level. Composite indexes on `connections` are designed specifically for the two most common query patterns (listing a user's connections by status and retrieving all pending requests addressed to a user) to avoid full-table scans at scale.

```sql
-- Core tables
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    bio TEXT,
    avatar_url VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES users(id),
    addressee_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (requester_id, addressee_id)
);

CREATE INDEX idx_connections_addressee ON connections(addressee_id, status);
CREATE INDEX idx_connections_status ON connections(status) WHERE status = 'pending';

-- Mutual friends can now be a SQL query instead of application logic
```

#### Migration Architecture

A dual-write proxy sits between the API servers and both databases, allowing MongoDB to remain the authoritative source of truth during the early phases while PostgreSQL catches up through backfill. This arrangement means a PostgreSQL write failure during Phase 1 is non-fatal. It is logged and reconciled later, keeping user-facing availability unaffected throughout the migration window.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   API        │     │   Dual-Write │     │   MongoDB    │
│   Server     │────▶│   Proxy      │────▶│   (Primary)  │
│              │     │              │     │              │
└──────────────┘     │              │     └──────────────┘
                     │              │
                     │              │     ┌──────────────┐
                     │              │────▶│  PostgreSQL  │
                     │              │     │  (Secondary) │
                     └──────────────┘     └──────────────┘

Phase 1: Writes to both, reads from MongoDB
Phase 2: Writes to both, reads from PostgreSQL
Phase 3: Writes to PostgreSQL only
```

#### Dual-Write Implementation

The `DualWriter` uses a `primary` flag to switch write ordering between phases: during Phase 1 MongoDB receives the write first and PostgreSQL is best-effort, while in Phase 2 the roles reverse and MongoDB writes are fire-and-forget goroutines. Logging secondary failures without returning an error to the caller ensures that transient PostgreSQL issues during migration cannot degrade the user experience.

```go
// DualWriter writes to both databases during migration
type DualWriter struct {
    mongo    *mongo.Collection
    postgres *sql.DB
    primary  string // "mongo" or "postgres"
}

func (dw *DualWriter) CreateUser(ctx context.Context, user *User) error {
    // Write to primary first
    var primaryErr, secondaryErr error

    if dw.primary == "mongo" {
        primaryErr = dw.writeToMongo(ctx, user)
        if primaryErr == nil {
            secondaryErr = dw.writeToPostgres(ctx, user)
            if secondaryErr != nil {
                // Log but don't fail - secondary is best-effort during migration
                log.Warn("postgres write failed, will catch up via backfill",
                    "user_id", user.ID,
                    "error", secondaryErr)
            }
        }
    } else {
        primaryErr = dw.writeToPostgres(ctx, user)
        if primaryErr == nil {
            // MongoDB write is fire-and-forget during cutover
            go dw.writeToMongo(ctx, user)
        }
    }

    return primaryErr
}
```

#### Backfill Strategy

Historical documents are migrated in batches of 1,000 to limit memory pressure and reduce the number of round trips to PostgreSQL. Documents that fail the `normalizeMongoDoc` transformation (due to schema drift or missing fields accumulated over years) are routed to a manual review queue rather than aborting the entire backfill, so the migration can complete and edge cases can be resolved separately.

```go
// Backfill migrates historical data in batches
func (m *Migrator) Backfill(ctx context.Context) error {
    cursor, err := m.mongo.Find(ctx, bson.M{})
    if err != nil {
        return err
    }
    defer cursor.Close(ctx)

    batch := make([]*User, 0, 1000)
    for cursor.Next(ctx) {
        var doc bson.M
        if err := cursor.Decode(&doc); err != nil {
            return err
        }

        user, err := m.normalizeMongoDoc(doc) // Handle schema variants
        if err != nil {
            m.logFailedDoc(doc, err) // Manual review queue
            continue
        }

        batch = append(batch, user)
        if len(batch) >= 1000 {
            if err := m.insertBatch(ctx, batch); err != nil {
                return err
            }
            batch = batch[:0]
        }
    }

    return m.insertBatch(ctx, batch)
}
```

### Validation Strategy

Rather than comparing every record (which would be prohibitively slow at scale), the checker draws a random sample and computes a mismatch rate, flagging the migration as unsafe only if inconsistencies exceed a 0.1% threshold. Every mismatch is individually logged with both the MongoDB and PostgreSQL representations, giving engineers a concrete audit trail to diagnose and replay any records that diverged during the dual-write window.

```go
// ConsistencyChecker validates data matches between stores
type ConsistencyChecker struct {
    mongo    *mongo.Collection
    postgres *sql.DB
}

func (c *ConsistencyChecker) ValidateSample(ctx context.Context, sampleSize int) error {
    // Random sample of user IDs
    userIDs, err := c.getRandomUserIDs(ctx, sampleSize)
    if err != nil {
        return err
    }

    mismatches := 0
    for _, id := range userIDs {
        mongoUser, _ := c.getMongoUser(ctx, id)
        pgUser, _ := c.getPostgresUser(ctx, id)

        if !c.usersMatch(mongoUser, pgUser) {
            mismatches++
            c.logMismatch(id, mongoUser, pgUser)
        }
    }

    mismatchRate := float64(mismatches) / float64(len(userIDs))
    if mismatchRate > 0.001 { // 0.1% threshold
        return fmt.Errorf("mismatch rate too high: %.4f", mismatchRate)
    }

    return nil
}
```

---

#### Alternatives Considered

### Alternative 1: Stay with MongoDB, Add Application-Level Transactions

**Description**: Implement saga pattern for multi-document operations.

**Pros**:
- No migration risk
- Team knows MongoDB well

**Cons**:
- Doesn't solve schema drift
- Adds application complexity
- MongoDB costs remain

**Reason not chosen**: Addresses symptoms, not root cause.

### Alternative 2: Migrate to CockroachDB

**Description**: NewSQL database with PostgreSQL wire protocol.

**Pros**:
- Automatic sharding
- Global distribution

**Cons**:
- Operationally complex
- Higher cost
- Overkill for current scale

**Reason not chosen**: We don't need global distribution - PostgreSQL meets our needs.

---

#### Trade-offs and Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Data loss during migration | Low | High | Dual-write ensures no gaps - validation checks |
| Performance regression | Medium | Medium | Load test PostgreSQL schema - indexes optimized |
| Extended migration timeline | Medium | Low | Clear go/no-go criteria at each phase |
| Team unfamiliar with PostgreSQL | Low | Low | Recent payments project built PostgreSQL expertise |

---

#### Rollback Plan

**Phase 1-4 (Dual-write active)**:
- Switch primary back to MongoDB
- No data loss - both systems have all data

**Phase 5-6 (Reading from PostgreSQL)**:
- Switch reads back to MongoDB
- 30-second config change, no deployment needed

**Phase 7-8 (MongoDB decommissioned)**:
- This is the point of no return
- Maintain MongoDB backups for 30 days post-migration

---

#### Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Connection-related support tickets | 15-20/week | < 2/week |
| Mutual friends query p99 | 450ms | < 50ms |
| Data consistency checks | N/A (no checks possible) | > 99.99% |
| MongoDB license cost | $180K/year | $0 |

---

#### Timeline

| Phase | Duration | Gate Criteria |
|-------|----------|---------------|
| Phase 1: Schema + Dual-write | 2 weeks | Dual-write deployed, monitoring in place |
| Phase 2: Backfill | 2 weeks | 100% data migrated, < 0.1% mismatch rate |
| Phase 3: Read cutover | 2 weeks | p99 latency < 100ms, error rate < 0.01% |
| Phase 4: Decommission | 2 weeks | MongoDB disabled, 30-day backup retention |

---

#### Open Questions

- [ ] Should we use read replicas from day 1 or add later?
- [ ] How long do we maintain MongoDB backups post-migration?

---

#### References

- [MongoDB to PostgreSQL Migration Guide](internal-wiki-link)
- [Dual-Write Pattern Best Practices](internal-wiki-link)
- [Q4 Support Ticket Analysis](internal-wiki-link)
````

---

### Exercise 2: Write an ADR for API Versioning Decision

**Scenario**: Your team needs to decide how to version your public API. Write an ADR documenting the decision to use URL path versioning.

**Complete Solution**:

````markdown
# ADR-047: Use URL Path Versioning for Public API

**Date**: 2025-01-15
**Status**: Accepted
**Deciders**: Alice (API Lead), Bob (Platform Architect), Carol (Developer Experience)
**Technical Story**: PLAT-1234

---

## Context

We are launching a public API for external developers. We need to decide on a
versioning strategy before the first public release. Once chosen, changing
the versioning approach would break all existing integrations.

**Key requirements identified:**
- Must support breaking changes without disrupting existing clients
- Must be clear to developers which version they're using
- Must work with our existing API gateway (Kong)
- Must support gradual deprecation of old versions

**Options evaluated:**

1. **URL Path Versioning**: `/v1/users`, `/v2/users`
2. **Header Versioning**: `Accept: application/vnd.company.v1+json`
3. **Query Parameter**: `/users?version=1`
4. **No Versioning**: Semantic versioning of entire API, breaking changes = new API

---

## Decision

We will use **URL path versioning** with the format `/v{major}/resource`.

Version numbers indicate breaking changes only. Non-breaking additions
(new fields, new endpoints) do not increment the version.

Example:
```
Current: GET /v1/users
After breaking change: GET /v2/users (v1 still available)
```

---

## Rationale

### Why URL path versioning?

| Criteria | URL Path | Header | Query Param |
|----------|----------|--------|-------------|
| Visibility | High - in URL | Low - hidden | Medium |
| Cacheability | Excellent | Poor | Good |
| Browser testable | Yes | No | Yes |
| Gateway support | Native | Requires config | Native |
| Industry practice | GitHub, Stripe, Twilio | None major | Few |

**Primary reasons:**

1. **Developer Experience**: Developers immediately know which version they're
   using by looking at the URL. No hidden state in headers.

2. **Cacheability**: CDNs and proxies cache based on URL naturally. Header-based
   versioning requires `Vary` headers that complicate caching.

3. **Testability**: Developers can test API calls in a browser or curl without
   special header configuration.

4. **Industry Standard**: Stripe, GitHub, and Twilio all use URL path versioning.
   Developers expect this pattern.

### Why not header versioning?

Despite being "more RESTful," header versioning has practical drawbacks:
- Can't share API URLs in documentation or Slack
- Browser testing requires plugins
- More complex gateway routing
- No major API provider uses this as primary versioning

### Why not query parameters?

- Looks like a filter parameter, not a version
- Easy to forget, leading to implicit "latest version" behavior
- Less clean URLs in documentation

---

## Consequences

### Positive

- Clear, intuitive versioning that developers expect
- Simple API gateway routing configuration
- Cacheable at CDN layer without extra configuration
- Easy to document and share URLs
- Aligns with industry best practices (Stripe, GitHub model)

### Negative

- URL structure must include version prefix in all routes
- Some REST purists consider this "unclean"
- Multiple versions means maintaining multiple route handlers

### Neutral

- Need to decide on version lifecycle policy (separate ADR)
- Documentation must cover all supported versions
- SDK generators must handle version prefix

---

## Compliance

This decision complies with:
- API Design Guidelines (section 3.2)
- Security requirements (no version info leakage risk)
- Platform team gateway standards

---

## Related Decisions

- ADR-048: API Version Lifecycle Policy (pending)
- ADR-032: API Gateway Selection (Kong) - accepted

---

## Notes

Considered hybrid approach (path for major versions, header for minor) but
rejected due to complexity. KISS principle applies.

Implementation note: Version should be extracted early in middleware and
made available to handlers, not parsed repeatedly.

```go
// Middleware extracts version from URL path
func VersionMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := extractVersion(r.URL.Path) // "v1", "v2", etc.
        ctx := context.WithValue(r.Context(), "api_version", version)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```
````

---

### Exercise 3: Transform a Bad RFC into a Good RFC

**Scenario**: You've received this draft RFC from a junior engineer. Rewrite it to follow best practices.

**Original (Bad) RFC**:

```markdown
# RFC: New Cache

We should add caching because our API is slow. I think we should use Redis
because it's popular. We can cache the user data and it will be faster.

Implementation:
- Add Redis
- Cache stuff
- Profit

Let me know if you have questions.
```

**Complete Solution (Rewritten RFC)**:

````markdown
# RFC-2025-007: Implement Redis Caching for User Profile Endpoint

**Status**: Draft
**Author**: [Junior Engineer Name], with mentorship from [Senior Engineer]
**Created**: 2025-01-15
**Last Updated**: 2025-01-15

---

## Executive Summary

We propose adding Redis caching to the user profile endpoint (`GET /users/{id}`)
to reduce p95 latency from 340ms to <50ms and decrease database load by 60%
during peak traffic. Implementation requires 3 engineering days.

---

## Motivation

### Problem Statement

The `GET /users/{id}` endpoint has unacceptable latency that impacts user experience:

| Metric | Current | Target | Industry Benchmark |
|--------|---------|--------|--------------------|
| p50 latency | 120ms | 30ms | <50ms |
| p95 latency | 340ms | 50ms | <100ms |
| p99 latency | 890ms | 100ms | <200ms |
| DB queries/sec (peak) | 15,000 | 6,000 | N/A |

### Root Cause Analysis

1. **Every request hits the database**: No caching layer exists
2. **User profiles rarely change**: 95% of profiles unchanged in 24 hours
3. **High read:write ratio**: 50:1 (reads vastly outnumber writes)
4. **Hot spots**: Top 1% of users generate 40% of profile requests

### Impact of Inaction

- User-facing latency will increase as traffic grows
- Database costs will scale linearly with traffic
- Risk of database overload during traffic spikes

---

## Proposal

### Solution Overview

Implement a read-through cache using Redis for user profile data with:
- 15-minute TTL for normal profiles
- 5-minute TTL for frequently-updated profiles (verified users)
- Cache invalidation on profile updates

### Architecture

The request path flows through the API server, which consults Redis before touching the database, a read-through pattern that keeps the hot path sub-millisecond for cached profiles. The diagram distinguishes the two outcomes explicitly: a cache hit short-circuits the database entirely, while a cache miss triggers a synchronous database read followed by an asynchronous write-back to Redis.

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Client  │────►│  API     │────►│  Redis   │────►│ Database │
│          │     │  Server  │     │  Cache   │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                       │                │
                       │    Cache Hit   │
                       │◄───────────────│
                       │
                       │    Cache Miss: Read-through
                       │────────────────────────────►
```

### Implementation

The `UserCache` struct holds both a Redis client and a `UserRepository` interface, keeping it decoupled from any specific database driver and trivially mockable in tests. Cache write-back on a miss is done in a detached goroutine so that a slow Redis write never adds latency to the caller. Verified users receive the shorter 5-minute TTL because their profiles change more frequently and stale data is more likely to cause visible inconsistencies.

```go
package cache

import (
    "context"
    "encoding/json"
    "time"

    "github.com/redis/go-redis/v9"
)

type UserCache struct {
    redis    *redis.Client
    db       UserRepository
    ttl      time.Duration
    hotTTL   time.Duration
}

func NewUserCache(redis *redis.Client, db UserRepository) *UserCache {
    return &UserCache{
        redis:  redis,
        db:     db,
        ttl:    15 * time.Minute,
        hotTTL: 5 * time.Minute,
    }
}

// GetUser implements read-through caching
func (c *UserCache) GetUser(ctx context.Context, userID string) (*User, error) {
    // Try cache first
    key := fmt.Sprintf("user:%s", userID)
    cached, err := c.redis.Get(ctx, key).Bytes()

    if err == nil {
        var user User
        if json.Unmarshal(cached, &user) == nil {
            return &user, nil
        }
    }

    // Cache miss: fetch from database
    user, err := c.db.GetUser(ctx, userID)
    if err != nil {
        return nil, err
    }

    // Write to cache (fire and forget)
    go c.cacheUser(context.Background(), user)

    return user, nil
}

func (c *UserCache) cacheUser(ctx context.Context, user *User) {
    key := fmt.Sprintf("user:%s", user.ID)
    data, err := json.Marshal(user)
    if err != nil {
        return
    }

    ttl := c.ttl
    if user.IsVerified {
        ttl = c.hotTTL // Verified users update more frequently
    }

    c.redis.Set(ctx, key, data, ttl)
}

// InvalidateUser removes user from cache on update
func (c *UserCache) InvalidateUser(ctx context.Context, userID string) error {
    key := fmt.Sprintf("user:%s", userID)
    return c.redis.Del(ctx, key).Err()
}
```

### Cache Invalidation Strategy

On every profile update, the service deletes the corresponding Redis key immediately after the database write succeeds, preventing stale data from being served for the remainder of its TTL. The invalidation failure is deliberately treated as non-fatal. A warning is logged but the update still returns success, since the cache will self-heal once the TTL expires naturally.

```go
// UpdateUser updates database and invalidates cache
func (s *UserService) UpdateUser(ctx context.Context, user *User) error {
    // Update database
    if err := s.db.UpdateUser(ctx, user); err != nil {
        return err
    }

    // Invalidate cache (best effort)
    if err := s.cache.InvalidateUser(ctx, user.ID); err != nil {
        // Log but don't fail - cache will expire naturally
        log.Warn("cache invalidation failed", "user_id", user.ID, "error", err)
    }

    return nil
}
```

---

#### Alternatives Considered

### Alternative 1: CDN Caching (Cloudflare/Fastly)

**Description**: Cache responses at the edge.

**Pros**:
- No infrastructure to manage
- Global distribution

**Cons**:
- Difficult to invalidate on update
- Per-user data can't be cached publicly
- Requires cache-control header management

**Reason not chosen**: User profiles are personalized - CDN caching would
require complex `Vary` headers and auth token handling.

### Alternative 2: In-Memory Application Cache

**Description**: Use Go's sync.Map or groupcache for in-process caching.

**Pros**:
- No external dependency
- Lower latency than Redis

**Cons**:
- Cache not shared across instances
- Memory pressure on application servers
- Cold cache on each deployment

**Reason not chosen**: We run 8 API instances - cache hit rate would be ~12%
with per-instance caches.

### Alternative 3: Database Query Caching (PostgreSQL)

**Description**: Enable pg_stat_statements and query result caching.

**Pros**:
- No application changes
- Automatic

**Cons**:
- Limited control over TTL
- Doesn't reduce database load
- Cache invalidation is global

**Reason not chosen**: Doesn't address the core problem of database load.

---

#### Trade-offs and Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Stale data shown to users | Medium | Low | Short TTL + invalidation on update |
| Redis unavailability | Low | Medium | Fallback to database - Redis in HA mode |
| Cache stampede | Low | Medium | Implement locking/singleflight |
| Memory exhaustion in Redis | Low | Low | Set maxmemory policy - monitor usage |

---

#### Observability

### Metrics to Add

Exposing cache behavior through Prometheus counters and histograms lets you distinguish between a slow system and a misconfigured one. A dropping hit rate signals that cache keys are expiring too aggressively or that the key-generation logic has diverged from the read path, while the latency histogram's sub-millisecond buckets reveal whether Redis round-trips are contributing to p99 degradation in the overall user-lookup path.

```go
var (
    cacheHits = prometheus.NewCounter(prometheus.CounterOpts{
        Name: "user_cache_hits_total",
    })
    cacheMisses = prometheus.NewCounter(prometheus.CounterOpts{
        Name: "user_cache_misses_total",
    })
    cacheLatency = prometheus.NewHistogram(prometheus.HistogramOpts{
        Name:    "user_cache_latency_seconds",
        Buckets: []float64{.001, .005, .01, .025, .05, .1},
    })
)
```

### Alerts

- Cache hit rate < 80% for 5 minutes
- Redis latency p99 > 10ms
- Redis memory usage > 80%

---

#### Success Criteria

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| p95 latency | 340ms | <50ms | Datadog APM |
| Cache hit rate | N/A | >85% | Prometheus |
| Database QPS (peak) | 15,000 | <6,000 | Database metrics |

---

#### Rollout Plan

1. **Day 1**: Deploy Redis (already provisioned for other use)
2. **Day 2**: Deploy cache layer behind feature flag (disabled)
3. **Day 3**: Enable for 10% of traffic, monitor metrics
4. **Day 4**: Enable for 100% if metrics look good
5. **Day 5**: Remove feature flag, update documentation

### Rollback Plan

Feature flag allows instant rollback to direct database queries. No data
migration required.

---

#### Open Questions

- [ ] Should we pre-warm cache on deployment? (Recommendation: No, let it warm naturally)
- [ ] Should verified users have different TTL? (Recommendation: Yes, 5min vs 15min)

---

#### References

- [Redis Best Practices](https://redis.io/docs/manual/patterns/)
- [Cache-Aside Pattern](https://docs.microsoft.com/en-us/azure/architecture/patterns/cache-aside)
- [Internal: Redis Cluster Setup Guide](wiki-link)
````

**Key Improvements Made**:

| Original Problem | Improvement |
|------------------|-------------|
| No problem statement | Added metrics showing current vs target |
| "It's slow" - vague | Specific latency numbers and root cause |
| No alternatives | Three alternatives with trade-off analysis |
| No implementation detail | Complete code examples |
| No success criteria | Clear metrics with targets |
| No rollout/rollback plan | Phased rollout with feature flag |
| No risks addressed | Risk table with mitigations |

---

**Next Chapter: Leading Large Refactors** - We'll cover how to plan, execute, and land large-scale code changes across a codebase.
