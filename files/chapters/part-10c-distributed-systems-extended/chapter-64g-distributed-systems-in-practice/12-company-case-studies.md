## Company Case Studies

### Amazon - Dynamo Paper Lessons (2007, applied today)

Amazon's Dynamo paper (2007) established the foundational techniques for AP distributed databases:

**Core techniques still used today:**
- **Consistent hashing**: distributes data across nodes without full reshuffling on node add/remove
- **Quorum reads/writes (R+W>N)**: N=3, W=2, R=2 - any write requiring 2 of 3 nodes + any read from 2 of 3 guarantees seeing the latest write
- **Vector clocks**: track causality for conflict detection (though DynamoDB moved to "last-writer-wins" for simplicity)
- **Anti-entropy via Merkle trees**: efficient background synchronization between replicas

**Go application**: When building AP systems in Go, implement similar techniques:
```go
package casestudies

import (
    "hash/fnv"
    "sort"
    "sync"
)

type VNode struct {
    Hash uint32
    Node string
}

func hash(s string) uint32 {
    h := fnv.New32a()
    h.Write([]byte(s))
    return h.Sum32()
}

// Simplified consistent hashing ring
type HashRing struct {
    nodes    []VNode     // Virtual nodes (for even distribution)
    nodeMap  map[uint32]string
    mu       sync.RWMutex
}

func (r *HashRing) GetNode(key string) string {
    h := hash(key)
    r.mu.RLock()
    defer r.mu.RUnlock()
    // Binary search for first virtual node >= h
    idx := sort.Search(len(r.nodes), func(i int) bool {
        return r.nodes[i].Hash >= h
    })
    if idx == len(r.nodes) {
        idx = 0 // Wrap around
    }
    return r.nodeMap[r.nodes[idx].Hash]
}
```

### Google - Spanner: Globally Consistent CP at Scale

Google Spanner provides global strong consistency - a remarkable engineering achievement.

**How it achieves global linearizability:**
1. **TrueTime API**: atomic clocks + GPS in every data center → `time.Now()` returns an interval `[earliest, latest]` within 7ms
2. **Commit wait**: transactions commit only after the TrueTime interval has passed - ensures no future transaction can have an earlier timestamp
3. **Paxos groups**: each shard is replicated across 5 data centers using Paxos

**Go lesson**: Global CP is achievable but expensive. For most systems, per-region CP with cross-region eventual consistency is the right trade-off. CockroachDB brings Spanner-inspired consistency to open-source Go deployments.

### Cloudflare - Distributed Systems at the Edge

Cloudflare operates 300+ PoPs worldwide, each running Go services for DNS, CDN, WAF, and DDoS mitigation.

**Key distributed systems challenges:**
1. **Edge cache consistency**: content invalidation must propagate to 300+ PoPs within seconds
2. **Anycast routing**: same IP announced from 300+ locations - BGP picks the "closest" PoP for each user
3. **Distributed rate limiting**: counting requests across multiple PoPs for rate limit enforcement

**Go implementation for distributed rate limiting:**
```go
package casestudies

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// Sliding window rate limiter using Redis at each PoP
// Plus approximate global count via background sync
type DistributedRateLimiter struct {
    local  *redis.Client  // Local PoP Redis
    global *redis.Client  // Central Redis (sync every N seconds)
    quota  int64
    window time.Duration
}

func (r *DistributedRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    // Local check: fast path, using local PoP count
    localCount, err := r.local.ZCard(ctx, key).Result()
    if err != nil {
        return false, err
    }

    // Use 80% of quota locally - leave 20% headroom for other PoPs
    localLimit := r.quota * 80 / 100
    if localCount >= localLimit {
        return false, nil // Fast fail
    }

    // Increment local counter
    now := time.Now().UnixMilli()
    windowStart := now - r.window.Milliseconds()
    pipe := r.local.Pipeline()
    pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: now})
    pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", windowStart))
    pipe.Expire(ctx, key, r.window*2)
    _, err = pipe.Exec(ctx)
    return err == nil, err
}
```

### Junior → FAANG: Company Case Studies as Interview Vocabulary

FAANG system design interviews frequently reference the systems described in this section. Knowing that Amazon Dynamo uses consistent hashing with virtual nodes, that Google Spanner uses TrueTime + Paxos for global linearizability, and that Cloudflare uses anycast with per-PoP Redis for distributed rate limiting provides concrete vocabulary that makes your answers specific rather than generic.

For interviews: when asked "how would you design a globally distributed rate limiter?", the Cloudflare pattern (local PoP count using 80% of quota, background sync for global count) is a production-validated answer. Be able to explain the trade-off: local counting is fast but allows slight over-counting across PoPs, while global counting is accurate but adds latency. Which you choose depends on whether the rate limit is for security (accuracy critical) or for fairness (approximate is acceptable).

For the Dynamo paper: the five techniques (consistent hashing, quorum reads/writes, vector clocks, anti-entropy via Merkle trees, gossip for membership) appear repeatedly in distributed systems interviews. Know each one well enough to describe the problem it solves and its basic mechanism.

First-job habit: read the original Dynamo paper (2007, available free online). It is dense but the techniques are so foundational that understanding them from the source provides significant advantage in both interviews and production system design discussions.

### Senior @ FAANG: Applying Company-Scale Lessons to Internal Platform Design

The three case studies in this section represent different positions on the consistency/availability/scale spectrum. Extracting the design principles, rather than the specific implementations, is what makes these cases useful at the platform level.

**Dynamo's tunable consistency as a platform API.** The quorum parameter (R+W>N) is a user-facing API that allows applications to select their consistency level per operation. This design philosophy, giving applications a knob rather than a fixed system behavior, is applicable to internal platform design. Staff engineers building shared data infrastructure at FAANG face the same question: do we provide a single consistency mode (simpler for application teams, less flexible) or a per-operation consistency API (more complex but enables applications to optimize critical and non-critical paths separately)? The Dynamo answer is the latter. The cost is that application teams must understand the consistency model. The benefit is that critical paths (checkout) can use quorum reads while non-critical paths (product catalog) use single-replica reads.

**Spanner's TrueTime and the cost of global consistency.** Google's investment in TrueTime (GPS + atomic clocks in every data center) is a capital investment measured in tens of millions of dollars, justified by the correctness requirement for globally consistent financial transactions. The lesson for staff engineers is that global consistency is not free, and the cost must be justified by the business requirement. The practical question is: does this system require cross-region linearizability, or is per-region strong consistency with cross-region eventual consistency sufficient? The answer determines whether the system needs Spanner (or CockroachDB as the open-source equivalent) or whether it can use a less expensive consistency model for cross-region replication.

**Cloudflare's edge architecture and the headroom principle.** The 80/20 split in the Cloudflare rate limiter (use 80% of quota locally, leave 20% headroom for other PoPs) illustrates the headroom principle: in distributed systems where coordination is expensive, reserve capacity headroom to absorb the inconsistency introduced by the lack of real-time coordination. This principle applies broadly. A distributed cache that allows each local node to use 80% of its quota with periodic global sync will never exceed 100% of the global quota by more than 20%, which is an acceptable overcount for most rate limiting use cases. Staff engineers apply this principle when designing distributed quota management, distributed counters, and distributed capacity reservation systems.

---
