## 52E.10 Scaling Multi-Tenant Systems

### Horizontal Sharding by Tenant

When a single database cluster can no longer handle all tenants, shard by tenant. The `ShardRouter` below maps each tenant ID to a shard index using consistent hashing. New tenants are assigned to the least-loaded shard, and the mapping is persisted so subsequent requests route consistently:

```go
type ShardRouter struct {
    shards  []*pgxpool.Pool
    mapping ShardMappingStore  // tenantID → shard index
}

func (r *ShardRouter) GetShard(ctx context.Context, tenantID uuid.UUID) (*pgxpool.Pool, error) {
    shardIdx, err := r.mapping.GetShard(ctx, tenantID)
    if err != nil {
        // New tenant: assign to least-loaded shard
        shardIdx, err = r.assignNewTenantToShard(ctx, tenantID)
        if err != nil {
            return nil, err
        }
    }

    if shardIdx >= len(r.shards) {
        return nil, fmt.Errorf("invalid shard index %d", shardIdx)
    }

    return r.shards[shardIdx], nil
}

func (r *ShardRouter) assignNewTenantToShard(ctx context.Context, tenantID uuid.UUID) (int, error) {
    // Consistent hashing or least-loaded assignment
    // Consistent hashing: deterministic, no coordination needed
    // But makes rebalancing harder

    // Simple: consistent hashing by tenant UUID
    h := fnv.New32a()
    h.Write(tenantID[:])
    shardIdx := int(h.Sum32()) % len(r.shards)

    // Store the assignment
    if err := r.mapping.SetShard(ctx, tenantID, shardIdx); err != nil {
        return 0, err
    }

    return shardIdx, nil
}
```

### Tenant-Aware Auto-Scaling

Standard auto-scaling reacts to aggregate CPU or memory usage, but multi-tenant systems benefit from per-tenant load tracking. The activity scorer below records per-tenant request counts in Redis with per-minute granularity. This data feeds into routing decisions: hot tenants can be directed to dedicated capacity, and cold tenants can be consolidated:

```go
// Tenant activity score: used to decide which app server gets which tenant's traffic
type TenantActivityScorer struct {
    redis *redis.Client
}

func (s *TenantActivityScorer) RecordRequest(ctx context.Context, tenantID uuid.UUID) {
    key := fmt.Sprintf("activity:%s:%d", tenantID, time.Now().Unix()/60) // per-minute bucket
    pipe := s.redis.Pipeline()
    pipe.Incr(ctx, key)
    pipe.Expire(ctx, key, 5*time.Minute)
    pipe.Exec(ctx)
}

func (s *TenantActivityScorer) GetActiveTenantsScore(ctx context.Context) (map[string]int64, error) {
    pattern := fmt.Sprintf("activity:*:%d", time.Now().Unix()/60)
    keys, err := s.redis.Keys(ctx, pattern).Result()
    if err != nil {
        return nil, err
    }

    if len(keys) == 0 {
        return nil, nil
    }

    vals, err := s.redis.MGet(ctx, keys...).Result()
    if err != nil {
        return nil, err
    }

    scores := make(map[string]int64)
    for i, key := range keys {
        parts := strings.Split(key, ":")
        if len(parts) >= 2 && vals[i] != nil {
            tenantID := parts[1]
            score, _ := strconv.ParseInt(vals[i].(string), 10, 64)
            scores[tenantID] += score
        }
    }

    return scores, nil
}
```

### Database Sharding Strategies

**Strategy 1: Tenant-based consistent hashing**
- Assign each tenant to a shard based on hash(tenant_id) % num_shards
- Pros: Deterministic, no coordination
- Cons: Rebalancing when adding shards requires moving half the tenants

**Strategy 2: Range-based (tenant registration order)**
- Tenants 1-10000 → shard 1, 10001-20000 → shard 2
- Pros: Easy to add new shards (append a new range)
- Cons: Hot new tenants all land on the latest shard

**Strategy 3: Directory-based (mapping table)**
- Lookup table: tenant_id → shard_id
- Pros: Flexible, can move tenants between shards manually
- Cons: Lookup table becomes a single point of failure (must be highly available and cached)

The practical recommendation for most SaaS: start with a single database, implement the directory-based shard router with all tenants pointing to shard 0. When you need to scale, move large tenants to dedicated shards without changing application code.

### Junior → FAANG: Sharding Fundamentals and When to Apply Them

Database sharding is a common system design interview topic, but most junior candidates apply it too early or choose the wrong sharding key. The content in this section gives you the framework to reason about sharding timing and strategy.

Common junior gaps:

- Proposing sharding as the first response to scale problems. Sharding adds significant operational complexity. The correct sequence: optimize queries, add read replicas, upgrade hardware, then shard as a last resort when the primary write path cannot scale vertically.
- Not understanding why consistent hashing makes rebalancing hard. When you add a new shard to a consistent hash ring, you must move tenants from their current shard to the new one. Moving a tenant with millions of rows requires a live migration with dual-write, not a simple hash re-computation.
- Confusing stateless auto-scaling (adding more application pods) with stateful scaling (sharding a database). Application pods scale horizontally without coordination. Database shards require explicit routing configuration and data movement.

Worked example for interviews: "Your SaaS has 100,000 tenants and a single PostgreSQL primary is hitting CPU limits. Walk me through your scaling approach."

Answer: start with the vertical and horizontal read options. Add a read replica and route read-heavy queries (reports, analytics) to the replica. If write throughput is the bottleneck, evaluate sharding. Choose directory-based sharding (mapping table tenant_id to shard_id) because it allows manual tenant movement between shards without changing application code. Implement the `ShardRouter` with a mapping cached in Redis. Initially, all tenants map to shard 0 (the existing database). Add shard 1 and move large tenants to it manually, one at a time, using the dual-write migration pattern.

First-job habits:

- Before any sharding proposal, measure actual write throughput versus the database primary's maximum. Many scale problems are read-dominated and are solved by read replicas, not sharding.
- When you do implement sharding, instrument the `ShardRouter` with a metric for shard distribution. Skewed distribution (one shard with 80% of tenants) is a correctness problem in the shard assignment algorithm.

### Senior @ FAANG: Shard Rebalancing, Hot Tenant Isolation, and Control Plane Design

At staff level, sharding is a platform capability, not a one-time engineering task. The design must support ongoing rebalancing, hot tenant isolation, and observability of shard health.

**Live tenant migration between shards:**

The directory-based shard router enables live tenant migration. The process mirrors the pool-to-schema migration pattern:

1. Mark the tenant as `migrating` in the shard mapping.
2. Start dual-writing to both the source shard and the target shard for all new writes.
3. Backfill historical data from source to target in batches.
4. Run verification: row counts, checksums, consistency check for recent writes.
5. Atomic cutover: update the shard mapping to point to the target shard. The router immediately routes new queries to the target.
6. After a verification window (24-72 hours), delete the tenant's data from the source shard.

The dual-write must be atomic with the original write: both shards are updated in the same application-level operation, not via async replication. If they diverge, the migration is unsafe to complete.

**Hot tenant isolation:**

Some tenants generate disproportionate load regardless of rate limiting. The `TenantActivityScorer` in this section provides the signal. The platform response for a consistently hot tenant:

- Migrate them from the shared shard to a dedicated shard (or dedicated database for silo-tier tenants).
- Pin their traffic to specific application instances using consistent hashing at the load balancer.
- Apply per-tenant `work_mem` and `maintenance_work_mem` settings in PostgreSQL to limit query memory consumption.
- If they are on the pool tier, escalate the conversation to a plan upgrade or a dedicated capacity contract.

**Control plane for shard management:**

At staff level, shard management is a control plane problem. The data plane (application serving traffic) must be decoupled from the control plane (decisions about shard assignment, migration, and rebalancing). The control plane is a separate service that:

- Stores the canonical shard mapping in PostgreSQL (source of truth).
- Publishes mapping changes to Redis pub/sub so data plane instances update their cached routes.
- Exposes an admin API for triggering tenant migrations and viewing shard health.
- Runs the rebalancing algorithm: identifies over-loaded shards, selects candidate tenants for migration based on size and activity, and triggers migration jobs.

The data plane reads the shard mapping from a Redis cache with a short TTL (ten seconds). The control plane updates the mapping atomically and publishes an invalidation event. The data plane reflects the change within the TTL window.

**Capacity planning at shard granularity:**

A staff engineer owning the database platform tracks capacity at the shard level: write IOPS, connection count, storage growth rate, and query duration percentiles per shard. Alerts fire when any shard approaches 70% of its capacity ceiling, triggering a rebalancing cycle before the shard becomes a bottleneck. This proactive posture, capacity-based triggers rather than incident-based reactions, is the operational maturity expected at L6 and above.

---
