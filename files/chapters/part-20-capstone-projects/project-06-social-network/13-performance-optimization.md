## Performance Optimization

Performance is critical for a social network because users expect instant responses when scrolling their feed or interacting with posts. The primary optimization strategy is caching: storing frequently accessed data in Redis so that the application rarely needs to query the database. Beyond caching, we also configure database connection pools to reuse connections efficiently and use distributed locks to prevent race conditions when multiple servers process the same data simultaneously. These techniques together reduce response times from hundreds of milliseconds to single-digit milliseconds for most operations.

### Redis Caching Strategy

The Redis cache layer provides a unified API for caching users, posts, and counters. It also includes a distributed lock mechanism that prevents race conditions when multiple API server instances try to update the same data simultaneously. For example, if two requests try to increment a like counter at the same time, the lock ensures only one processes at a time, preventing lost updates.

```go
// internal/cache/redis.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/redis/go-redis/v9"
    "github.com/yourname/socialnet/internal/domain"
)

type RedisCache struct {
    client *redis.Client
}

func NewRedisCache(client *redis.Client) *RedisCache {
    return &RedisCache{client: client}
}

// User caching
func (c *RedisCache) GetUser(ctx context.Context, userID uuid.UUID) (*domain.User, error) {
    key := fmt.Sprintf("user:%s", userID.String())
    data, err := c.client.Get(ctx, key).Bytes()
    if err != nil {
        return nil, err
    }

    var user domain.User
    if err := json.Unmarshal(data, &user); err != nil {
        return nil, err
    }

    return &user, nil
}

func (c *RedisCache) SetUser(ctx context.Context, user *domain.User, ttl time.Duration) error {
    key := fmt.Sprintf("user:%s", user.ID.String())
    data, err := json.Marshal(user)
    if err != nil {
        return err
    }

    return c.client.Set(ctx, key, data, ttl).Err()
}

// Post caching
func (c *RedisCache) GetPost(ctx context.Context, postID uuid.UUID) (*domain.Post, error) {
    key := fmt.Sprintf("post:%s", postID.String())
    data, err := c.client.Get(ctx, key).Bytes()
    if err != nil {
        return nil, err
    }

    var post domain.Post
    if err := json.Unmarshal(data, &post); err != nil {
        return nil, err
    }

    return &post, nil
}

func (c *RedisCache) SetPost(ctx context.Context, post *domain.Post, ttl time.Duration) error {
    key := fmt.Sprintf("post:%s", post.ID.String())
    data, err := json.Marshal(post)
    if err != nil {
        return err
    }

    return c.client.Set(ctx, key, data, ttl).Err()
}

// Counter caching (likes, followers, etc.)
func (c *RedisCache) IncrementCounter(ctx context.Context, key string, delta int64) error {
    return c.client.IncrBy(ctx, key, delta).Err()
}

func (c *RedisCache) GetCounter(ctx context.Context, key string) (int64, error) {
    return c.client.Get(ctx, key).Int64()
}

// Distributed lock for preventing race conditions
func (c *RedisCache) AcquireLock(ctx context.Context, key string, ttl time.Duration) (bool, error) {
    lockKey := fmt.Sprintf("lock:%s", key)
    return c.client.SetNX(ctx, lockKey, "1", ttl).Result()
}

func (c *RedisCache) ReleaseLock(ctx context.Context, key string) error {
    lockKey := fmt.Sprintf("lock:%s", key)
    return c.client.Del(ctx, lockKey).Err()
}
```

### Database Connection Pooling

Connection pooling reuses database connections instead of opening a new one for every query. This is critical because establishing a new PostgreSQL connection involves a TCP handshake, SSL negotiation, and authentication, which can take tens of milliseconds. The pool settings below cap the maximum number of open connections to prevent overwhelming the database, while keeping a set of idle connections ready for immediate use.

```go
// internal/database/postgres.go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

type Config struct {
    Host            string
    Port            int
    User            string
    Password        string
    Database        string
    SSLMode         string
    MaxOpenConns    int
    MaxIdleConns    int
    ConnMaxLifetime time.Duration
    ConnMaxIdleTime time.Duration
}

func NewPostgresDB(cfg Config) (*sqlx.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
        cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database, cfg.SSLMode,
    )

    db, err := sqlx.Connect("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("connect to postgres: %w", err)
    }

    // Configure connection pool
    db.SetMaxOpenConns(cfg.MaxOpenConns)       // Max 100 connections
    db.SetMaxIdleConns(cfg.MaxIdleConns)       // Keep 25 idle
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime) // Recycle after 1 hour
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime) // Close idle after 10 min

    // Verify connection
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        return nil, fmt.Errorf("ping postgres: %w", err)
    }

    return db, nil
}
```

---

### Junior → FAANG: Performance Optimization Fundamentals

The most common junior mistake is optimizing before measuring. "I made the code faster" means nothing without a before and after benchmark. Before any interview discussion of performance, anchor every claim to a measurement: what was the p95 latency before, what is it after, and how was it measured.

Build the habit of profiling first. In Go, `pprof` is built in. Run `go tool pprof` against your CPU and heap profiles before guessing where the bottleneck is. Common findings: JSON serialization is more expensive than you expect, database round trips dominate over CPU, and allocations in hot paths accumulate into GC pressure.

Prerequisite gaps to fill: understand what a database index actually is (a sorted B-tree structure that avoids full table scans), know that adding an index speeds reads but slows writes, and know that covering indexes (including all queried columns in the index) avoid heap fetches entirely.

Entry-level framing for interviews: structure your optimization answer as measure, hypothesize, change one thing, remeasure, repeat. Interviewers at FAANG specifically look for the discipline of changing one variable at a time. Candidates who make five changes and report a combined improvement demonstrate poor experimental hygiene.

### Senior @ FAANG: Performance Engineering as a Systematic Discipline

At FAANG, performance is a product quality attribute with SLOs, budgets, and governance. The L6 framing is not "how do I make this faster" but "how do I define, measure, and enforce performance contracts across the system over time."

**SLO-driven optimization.** Start with the user-facing SLO: API p99 latency under 200ms at the 99th percentile under peak load. Work backward through the call stack allocating latency budgets per layer: 20ms for the API handler, 50ms for the primary database query, 10ms for cache lookup, 30ms for downstream service calls, 90ms remaining as buffer. Every optimization effort is prioritized by how much it closes the gap to the SLO. Optimizing a component that is not on the critical path wastes engineering cycles.

**Load testing as a release gate.** Senior engineers do not deploy performance changes without load testing against a production-scale dataset. The toolchain matters: write a realistic load test using `k6` or a custom generator that reflects actual traffic distribution (reads vs. writes, query patterns, payload sizes). Run it against a staging environment with production-scale data. Compare p50, p95, p99 before and after. If the change regresses tail latency, block the release.

**Caching hierarchy design.** An ad-hoc approach to caching adds a Redis call here and an in-memory map there without considering the overall cache hierarchy. At staff level, define the hierarchy explicitly: L1 is in-process memory (bounded by instance memory, zero network round trip), L2 is a distributed cache (sub-millisecond network round trip, shared across instances), L3 is the database (10-50ms query time). Each layer has defined TTLs, eviction policies, and invalidation strategies. Document these in the service's design doc. Inconsistency between layers is the primary source of stale data bugs. The invalidation strategy is the hardest part and must be specified precisely.

**Goroutine and connection pool governance.** In Go services under high concurrency, resource exhaustion manifests as goroutine leaks or connection pool starvation rather than CPU saturation. At L6, you set explicit goroutine limits using a worker pool with a bounded semaphore channel, set explicit database connection pool sizes based on the number of database threads available, and monitor these limits as metrics. If the goroutine count grows unboundedly, you have a leak. If the connection pool wait time grows, you are undersized. Both are SLO-impacting before they become errors.

**Continuous profiling in production.** Point-in-time profiling is insufficient for distributed systems. At FAANG, teams run continuous profiling using tools like Parca or Google's Cloud Profiler, which sample CPU and memory profiles across all instances over time. This provides a statistical picture of where CPU cycles are spent across the fleet, identifies regressions introduced by specific commits, and surfaces allocation hotspots that only manifest under production traffic patterns. Adopting continuous profiling is a platform maturity decision that requires buy-in from the infrastructure team and should be documented as an engineering standard.
