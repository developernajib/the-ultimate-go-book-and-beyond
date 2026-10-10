## 81.3 Scaling Strategies

### Horizontal vs Vertical Scaling

Understanding the trade-offs between horizontal and vertical scaling is foundational to system design interviews, where interviewers expect candidates to justify architectural choices with capacity reasoning. The following code illustrates how Go services expose the hooks, health checks, graceful shutdown, stateless request handling, that make horizontal scaling operational.

```
Vertical Scaling (Scale Up):
├── Add more CPU, RAM, disk to single server
├── Simpler architecture
├── Hardware limits (~256 cores, 12TB RAM)
├── Single point of failure
└── Use for: Databases (before sharding), small apps

Horizontal Scaling (Scale Out):
├── Add more servers
├── Linear cost scaling
├── Requires distributed architecture
├── Higher complexity
└── Use for: Web servers, stateless services
```

### Database Scaling Patterns

As data volume and query load grow, a single database instance becomes the bottleneck. The following patterns, read replicas, hash-based sharding, and consistent hashing, distribute load across multiple nodes and are the standard options interviewers expect candidates to discuss when scaling the data layer.
```go
// 1. Read Replicas
type DatabaseCluster struct {
    primary  *sql.DB
    replicas []*sql.DB
    next     uint64
}

func (c *DatabaseCluster) Read() *sql.DB {
    // Round-robin across replicas
    idx := atomic.AddUint64(&c.next, 1) % uint64(len(c.replicas))
    return c.replicas[idx]
}

func (c *DatabaseCluster) Write() *sql.DB {
    return c.primary
}

// 2. Sharding by key
type ShardedDB struct {
    shards []*sql.DB
}

func (s *ShardedDB) GetShard(userID int64) *sql.DB {
    shardIdx := userID % int64(len(s.shards))
    return s.shards[shardIdx]
}

// Consistent hashing for better distribution
type ConsistentHash struct {
    ring       []uint32      // Sorted hash values
    nodes      map[uint32]string  // hash -> node
    replicas   int           // Virtual nodes per real node
}

func (c *ConsistentHash) GetNode(key string) string {
    hash := crc32.ChecksumIEEE([]byte(key))

    // Binary search for first node >= hash
    idx := sort.Search(len(c.ring), func(i int) bool {
        return c.ring[i] >= hash
    })

    if idx == len(c.ring) {
        idx = 0  // Wrap around
    }

    return c.nodes[c.ring[idx]]
}
```

### Caching Strategies

Caching trades memory for reduced latency on repeated computations or lookups, and is one of the most impactful optimizations available. The diagram below contrasts cache-aside (application populates on miss), write-through (synchronous write to cache and DB), and write-behind (async flush) patterns, helping candidates articulate the consistency and durability trade-offs that interviewers probe in system design discussions.

```
Cache-Aside (Lazy Loading):
┌────────┐     ┌───────┐     ┌────────────┐
│ Client │────►│ Cache │     │  Database  │
└────────┘     └───────┘     └────────────┘
     │              │              │
     │   Get(key)   │              │
     │──────────────►              │
     │              │              │
     │  Cache Miss  │              │
     │◄─────────────│              │
     │              │              │
     │            Get(key)         │
     │─────────────────────────────►
     │              │              │
     │            Value            │
     │◄────────────────────────────│
     │              │              │
     │  Set(key, value, TTL)       │
     │──────────────►              │
     │              │              │

Write-Through:
- Write to cache and DB simultaneously
- Consistent but slower writes

Write-Behind (Write-Back):
- Write to cache, async write to DB
- Fast writes but risk of data loss
```

```go
// Cache-aside pattern
func (s *Service) GetUser(ctx context.Context, id int64) (*User, error) {
    // 1. Check cache
    cacheKey := fmt.Sprintf("user:%d", id)
    if cached, err := s.cache.Get(ctx, cacheKey); err == nil {
        var user User
        if err := json.Unmarshal(cached, &user); err == nil {
            return &user, nil
        }
    }

    // 2. Cache miss - query database
    user, err := s.db.GetUser(ctx, id)
    if err != nil {
        return nil, err
    }

    // 3. Populate cache
    data, _ := json.Marshal(user)
    s.cache.Set(ctx, cacheKey, data, 5*time.Minute)

    return user, nil
}

// Cache invalidation on update
func (s *Service) UpdateUser(ctx context.Context, user *User) error {
    // 1. Update database
    if err := s.db.UpdateUser(ctx, user); err != nil {
        return err
    }

    // 2. Invalidate cache
    cacheKey := fmt.Sprintf("user:%d", user.ID)
    s.cache.Delete(ctx, cacheKey)

    return nil
}
```

---

### Junior → FAANG: Scaling Strategies as the Design Vocabulary You Need

Scaling strategies are the vocabulary of system design interviews. Without knowing the difference between horizontal and vertical scaling, read replicas versus sharding, or synchronous versus asynchronous fan-out, you cannot have a productive conversation about any non-trivial system. Before your first design interview, make sure you can explain each strategy in one sentence, give an example of a real system that uses it, and identify one trade-off.

Common junior mistake: treating caching as a universal solution without reasoning about invalidation. "Just cache it" is not an answer. "Cache read results with a TTL of 60 seconds, invalidate on write, and accept the 60-second stale window because the business requirement does not need real-time consistency" is an answer.

Prerequisite to close: if you have not set up a small Redis instance and tested cache invalidation patterns locally, do it once. The 30 minutes spent experiencing cache-aside, write-through, and invalidation timing firsthand is worth more than reading about them.

### Senior @ FAANG: Scaling Strategy Selection as an Organizational Decision

At L5/L6, scaling strategy is not just a technical choice. It is an organizational one. Horizontal scaling requires stateless services, which requires session management changes, which requires coordination with other teams. Sharding requires application-level routing logic, which affects every service that touches the database. A senior candidate recognizes these organizational implications and mentions them.

The cache invalidation example from this section (Write-Through + Cache-Aside hybrid with delete-on-write) is the kind of nuanced operational pattern that distinguishes senior candidates. Be able to explain why a simple TTL-based cache fails for user profile updates (stale data window causes user-visible inconsistency), why aggressive invalidation can cause cache stampedes (thundering herd), and how to mitigate the stampede with probabilistic early expiration or request coalescing.

Maturity model for scaling at FAANG: L4 candidates know scaling vocabulary. L5 candidates can select the appropriate strategy for a given load profile. L6 candidates can design the migration path from the current architecture to the scaled architecture (gradual rollout, feature flags, canary deployments, database migration steps). L7 candidates define the scaling principles for their platform and ensure that new services are built in compliance with those principles from day one, reducing the need for scaling retrofits.
