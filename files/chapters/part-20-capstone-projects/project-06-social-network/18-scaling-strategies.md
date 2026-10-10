## Scaling Strategies

As your social network grows from thousands to millions of users, a single server will no longer be sufficient. Scaling strategies determine how you distribute load across multiple servers and databases to maintain fast response times. The most important principle is to keep your API servers stateless so you can add more instances behind a load balancer without any code changes. For the database layer, read replicas handle read-heavy workloads, and sharding splits data across multiple database servers when a single server runs out of storage or throughput capacity.

### Horizontal Scaling

1. **API Servers**: Deploy multiple instances behind a load balancer
2. **Database Read Replicas**: Use PostgreSQL streaming replication
3. **Redis Cluster**: Shard cache across multiple Redis nodes
4. **Elasticsearch Cluster**: Distribute search index across nodes

### Database Sharding

When a single PostgreSQL instance can no longer handle the load, database sharding distributes data across multiple database servers. Each shard holds a subset of the data, determined by hashing the user ID. The application routes queries to the correct shard based on this hash, which spreads both read and write load evenly across all shards. The trade-off is that cross-shard queries become more complex, so the sharding key must be chosen carefully to minimize the need for such queries.

```go
// Shard users by user_id hash
func getUserShard(userID uuid.UUID) int {
    hash := crc32.ChecksumIEEE([]byte(userID.String()))
    return int(hash % NUM_SHARDS)
}

// Route queries to appropriate shard
func (s *ShardedUserRepository) GetByID(ctx context.Context, userID uuid.UUID) (*domain.User, error) {
    shard := getUserShard(userID)
    db := s.shards[shard]

    // Query from correct shard
    var user domain.User
    err := db.GetContext(ctx, &user, "SELECT * FROM users WHERE id = $1", userID)
    return &user, err
}
```

### Caching Layers

A multi-tier caching strategy dramatically reduces database load by serving repeated reads from progressively faster storage. L1 is an in-process memory cache (using `sync.Map` or a library like `ristretto`) that answers requests in microseconds but is limited to a single instance and lost on restart. L2 is a shared Redis cache that all API server instances can read and write, providing millisecond-latency access to user profiles, computed feeds, and post metadata. Only on a complete cache miss does a request fall through to the database, where the result is stored in both Redis and memory before being returned.

```
┌──────────────────────────────────────────────┐
│         Application Server                   │
│                                              │
│  ┌────────────┐  ┌────────────┐              │
│  │ L1: Memory │─►│ L2: Redis  │─► Database   │
│  │   Cache    │  │   Cache    │              │
│  └────────────┘  └────────────┘              │
└──────────────────────────────────────────────┘

L1: In-memory (milliseconds)
L2: Redis (single-digit milliseconds)
L3: Database (tens of milliseconds)
```

### Junior → FAANG: Understanding Scaling Concepts

Junior candidates often confuse vertical scaling (bigger machine) with horizontal scaling (more machines). The foundational distinction: vertical scaling has a ceiling and requires downtime - horizontal scaling is nearly unlimited but requires stateless services. Stateless means the service holds no per-request state in memory between requests - all state lives in a shared external store.

The first prerequisite to understand: why sessions break horizontal scaling. If user A's session token is stored in memory on pod 1, and their next request routes to pod 2, pod 2 cannot find the session. The fix is external session storage (Redis). Know this pattern cold before interviews.

Entry-level interview framing: when asked "how would you scale this," first ask about the bottleneck. Is it CPU, memory, network I/O, or database throughput? Each bottleneck has a different scaling strategy. CPU-bound: horizontal scale the compute tier. Database I/O-bound: add read replicas and caching. Network-bound: add CDN and edge caching. Do not jump to "add more servers" before identifying the actual constraint.

### Senior @ FAANG: Scaling Architecture Decisions and Cost Governance

At FAANG, scaling decisions have direct infrastructure cost implications measured in millions of dollars per year. The L6 framing is: how do we scale to meet demand without overspending, and how do we architect the system to scale the most expensive components independently.

**Caching hierarchy as a scaling multiplier.** A three-tier cache hierarchy (L1 in-process, L2 distributed Redis, L3 database) can reduce database load by 90%+ for read-heavy social feeds. The staff-level design question is cache coherence: when a user edits a post, how do you invalidate or update the cached version across all three layers consistently. Write-through caching updates the cache on every write - cache-aside invalidates on write and repopulates on next read. For social content, cache-aside with short TTLs (10-60 seconds) is usually appropriate because stale content for a few seconds is acceptable and invalidation complexity is high.

**Database sharding strategy and evolution.** A single PostgreSQL instance will not scale to billions of rows per table. The architectural evolution is: start with vertical scaling and read replicas, move to functional decomposition (split tables into separate databases per service), and finally shard by user ID or content ID when a single service's data exceeds the capacity of one server. The sharding key choice is irreversible without a full rewrite. Document it in an ADR with explicit reasoning about query patterns that drove the choice. At FAANG, the typical anti-pattern is sharding by timestamp, which creates hot shards when recent data receives all writes.

**Autoscaling policy governance.** Kubernetes HPA (Horizontal Pod Autoscaler) scales on CPU or custom metrics. For social network services, CPU is a lagging indicator. A better scaling signal is request queue depth (for async workers) or in-flight request count (for HTTP services). Define scaling policies per service class in a shared platform configuration: web-facing services scale aggressively on latency, background workers scale on queue depth with a maximum that prevents overwhelming downstream databases. The platform team owns these scaling templates - product teams customize only their specific thresholds.
