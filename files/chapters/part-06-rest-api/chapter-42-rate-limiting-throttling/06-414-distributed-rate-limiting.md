## 42.4 Distributed Rate Limiting

### Redis-Based Rate Limiter

`RedisRateLimiter` coordinates rate state across multiple server instances by using Redis as the single source of truth, solving the problem where in-process limiters count requests independently per pod. Each check updates an atomic Redis counter with a TTL equal to the window duration so keys expire automatically when no longer needed.

The sliding window log approach stores every request timestamp in a sorted set (ZSET). On each check, `ZREMRANGEBYSCORE` prunes entries older than the window, `ZCARD` counts what remains, and `ZADD` inserts the new timestamp if under the limit. Wrapping the three commands in a Lua `EVAL` makes the check-and-write atomic so two Go instances cannot both see `count < limit` and both admit their request. The token bucket variant uses a hash with `tokens` and `last_refill` fields, again inside Lua so the refill computation and the consume decrement cannot interleave.

> **Senior track**: In Redis Cluster, all keys touched by one `EVAL` must hash to the same slot. Single-key limiters are unaffected. If you ever need multi-key scripts, use curly-brace hash tags (`{user:42}:tokens`) to force colocation. For sub-second TTLs you must use `PEXPIRE` (milliseconds), because `EXPIRE` takes whole seconds and any window under a second rounds to 0 or 1. `EXPIRE` also rejects a non-integer argument outright, which is a live trap explored below.

```go
// ... imports omitted for brevity (context, fmt, time,
// github.com/google/uuid, github.com/redis/go-redis/v9)

// RedisRateLimiter implements distributed rate limiting with Redis
type RedisRateLimiter struct {
    client *redis.Client
    rate   int
    window time.Duration
    prefix string
}

func NewRedisRateLimiter(client *redis.Client, rate int, window time.Duration) *RedisRateLimiter {
    return &RedisRateLimiter{
        client: client,
        rate:   rate,
        window: window,
        prefix: "ratelimit:",
    }
}

// Sliding window counter using Redis
func (r *RedisRateLimiter) Allow(ctx context.Context, key string) (bool, int, time.Time) {
    now := time.Now()
    windowKey := r.prefix + key

    // Lua script for atomic sliding window operation
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])

        -- Remove old entries
        redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

        -- Count current entries
        local count = redis.call('ZCARD', key)

        if count < limit then
            -- Add new entry. ARGV[4] is a caller-provided unique member
            -- (UUID or hostname+nanos) so concurrent requests in the same
            -- millisecond do not collide in the ZSET.
            redis.call('ZADD', key, now, ARGV[4])
            redis.call('PEXPIRE', key, window)
            return {1, limit - count - 1}
        else
            return {0, 0}
        end
    `)

    member := fmt.Sprintf("%d-%s", now.UnixNano(), uuid.NewString())
    result, err := script.Run(ctx, r.client, []string{windowKey},
        now.UnixMilli(),
        r.window.Milliseconds(),
        r.rate,
        member,
    ).Slice()

    if err != nil {
        // Fail open to avoid self-inflicted outage when Redis is unavailable.
        // A conservative production implementation falls through to a
        // local in-process limiter with half the global rate so abuse is
        // still bounded during the Redis outage (see Mistake 1).
        return true, r.rate, now.Add(r.window)
    }

    allowed := result[0].(int64) == 1
    remaining := int(result[1].(int64))
    resetAt := now.Add(r.window)

    return allowed, remaining, resetAt
}

// Token bucket using Redis
type RedisTokenBucket struct {
    client     *redis.Client
    rate       float64 // tokens per second
    bucketSize int
    prefix     string
}

func NewRedisTokenBucket(client *redis.Client, rate float64, bucketSize int) *RedisTokenBucket {
    return &RedisTokenBucket{
        client:     client,
        rate:       rate,
        bucketSize: bucketSize,
        prefix:     "tokenbucket:",
    }
}

func (r *RedisTokenBucket) Allow(ctx context.Context, key string) (bool, int, time.Time) {
    script := redis.NewScript(`
        local key         = KEYS[1]
        local rate        = tonumber(ARGV[1])
        local bucket_size = tonumber(ARGV[2])
        local now         = tonumber(ARGV[3])
        local requested   = tonumber(ARGV[4])

        local bucket = redis.call('HMGET', key, 'tokens', 'last_update')
        local tokens = tonumber(bucket[1]) or bucket_size
        local last_update = tonumber(bucket[2]) or now

        -- Refill. Guard against now < last_update: clocks on different app
        -- servers are not identical, and a backwards jump would otherwise
        -- make elapsed negative and *remove* tokens.
        if now > last_update then
            local elapsed = (now - last_update) / 1000
            tokens = math.min(bucket_size, tokens + elapsed * rate)
        end

        local allowed = 0
        if tokens >= requested then
            tokens = tokens - requested
            allowed = 1
        end

        redis.call('HSET', key, 'tokens', tokens, 'last_update', now)

        -- TTL = time to refill to full, plus a second of slack. Two traps here.
        --
        -- 1. EXPIRE takes an INTEGER number of seconds. Lua has one numeric
        --    type, so bucket_size / rate produces a float, and Redis rejects
        --    a non-integral argument with "value is not an integer or out of
        --    range". It only bites when the division is not exact: rate=1,
        --    bucket=60 yields 61.0 and passes, rate=3, bucket=100 yields
        --    34.333 and blows up. So the bug hides through every round-number
        --    test you write.
        -- 2. Redis does NOT roll back a script that fails partway. The HSET
        --    above has already committed, so a failing EXPIRE leaves a key
        --    with no TTL that never expires, and the error propagates to Go
        --    where a fail-open policy allows the request. The limiter is then
        --    silently disabled AND leaking a key per user, forever.
        --
        -- math.ceil to an integer, PEXPIRE for millisecond precision.
        local refill_ms = ((bucket_size - tokens) / rate) * 1000
        redis.call('PEXPIRE', key, math.ceil(refill_ms) + 1000)

        return {allowed, math.floor(tokens), math.ceil(refill_ms)}
    `)

    now := time.Now()
    result, err := script.Run(ctx, r.client, []string{r.prefix + key},
        r.rate,
        r.bucketSize,
        now.UnixMilli(),
        1,
    ).Slice()

    if err != nil {
        // Fail open. See the failure-mode discussion below: this is a policy
        // choice that must be made explicitly, and a bare `return true` is
        // only defensible when paired with a local fallback limiter.
        return true, r.bucketSize, now
    }

    allowed := result[0].(int64) == 1
    remaining := int(result[1].(int64))
    refillMs := result[2].(int64)

    // Note the conversion: time.Duration(x) * time.Millisecond would truncate
    // x to a whole Duration first. Multiply into the unit, do not multiply a
    // converted value by a unit.
    resetAt := now.Add(time.Duration(refillMs) * time.Millisecond)

    return allowed, remaining, resetAt
}
```

That `EXPIRE` line is worth dwelling on, because it is the kind of defect that reaches production intact. Run the original against a real Redis with `rate=1, bucket_size=60` and it works. Every example in this chapter uses a rate and bucket that divide evenly, so every example passes. Change the tier to 100 requests at 3/second and the same code fails on every single call, fails open, and leaks an immortal key per user. The lesson generalises past Redis: when a value crosses a type boundary that only accepts integers, do the rounding yourself at the boundary rather than hoping the division comes out even.

### Consistent Hashing for Rate Limiting

When a single Redis instance cannot handle the throughput, rate limit state must be distributed across multiple Redis nodes. `ClusterRateLimiter` uses a consistent hash ring to route each rate limit key to the same node deterministically. This avoids the split-brain problem where two nodes each see half the requests and both allow them, and it minimizes key migration when nodes are added or removed. Each physical node gets multiple virtual positions on the ring (controlled by `replicas`) to balance the load more evenly.

The whole value of consistent hashing rests on one detail that is easy to fumble: **what you hash to place a node on the ring**. It must be a stable identity for that node, such as its address. Hashing the node's position in a slice, as in `fmt.Sprintf("node-%d-%d", i, j)`, looks equivalent and is not. Remove the first of four nodes and every surviving node's index shifts down by one, so every virtual position on the ring moves, and essentially the entire keyspace relocates. Measured over 10,000 keys with 150 virtual nodes each, removing one node of four remaps **97% of keys** when the ring is built from slice indices, against **16%** when it is built from node addresses (the theoretical target is about 25%). Hashing the index does not merely weaken consistent hashing, it converts it into plain modulo hashing with extra steps, which is the exact algorithm consistent hashing exists to replace. For a rate limiter, a full remap means every bucket is suddenly read from a node that has never seen it, so every client gets a fresh quota at the moment you are least able to absorb the traffic.

```go
// ... imports omitted for brevity (context, fmt, hash/fnv, sort, sync, time,
// github.com/redis/go-redis/v9)

// ClusterRateLimiter distributes rate limiting across Redis nodes
type ClusterRateLimiter struct {
    hashRing []uint32
    nodeMap  map[uint32]*redis.Client
    mu       sync.RWMutex
    replicas int
}

// node pairs a client with a stable identity for ring placement.
// The addr must be durable across restarts and independent of ordering:
// the ring is only "consistent" with respect to whatever you hash here.
type node struct {
    addr   string
    client *redis.Client
}

func NewClusterRateLimiter(nodes []node, replicas int) *ClusterRateLimiter {
    c := &ClusterRateLimiter{
        nodeMap:  make(map[uint32]*redis.Client),
        replicas: replicas,
    }
    c.buildHashRing(nodes)
    return c
}

func (c *ClusterRateLimiter) buildHashRing(nodes []node) {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.hashRing = nil
    c.nodeMap = make(map[uint32]*redis.Client)

    for _, n := range nodes {
        for j := 0; j < c.replicas; j++ {
            // Hash the node's ADDRESS, never its slice index. With the index,
            // deleting nodes[0] shifts every later node's identity and the
            // whole ring is rebuilt from scratch.
            hash := c.hash(fmt.Sprintf("%s#%d", n.addr, j))
            c.hashRing = append(c.hashRing, hash)
            c.nodeMap[hash] = n.client
        }
    }

    sort.Slice(c.hashRing, func(i, j int) bool {
        return c.hashRing[i] < c.hashRing[j]
    })
}

func (c *ClusterRateLimiter) hash(key string) uint32 {
    h := fnv.New32a()
    h.Write([]byte(key))
    return h.Sum32()
}

func (c *ClusterRateLimiter) getNode(key string) *redis.Client {
    c.mu.RLock()
    defer c.mu.RUnlock()

    if len(c.hashRing) == 0 {
        return nil
    }

    hash := c.hash(key)
    idx := sort.Search(len(c.hashRing), func(i int) bool {
        return c.hashRing[i] >= hash
    })

    if idx >= len(c.hashRing) {
        idx = 0
    }

    return c.nodeMap[c.hashRing[idx]]
}

func (c *ClusterRateLimiter) Allow(ctx context.Context, key string, rate int, window time.Duration) (bool, int, time.Time) {
    client := c.getNode(key)
    if client == nil {
        return true, rate, time.Now().Add(window)
    }

    limiter := NewRedisRateLimiter(client, rate, window)
    return limiter.Allow(ctx, key)
}
```

### Junior → FAANG: Understanding Distributed Rate Limiting

When you first encounter distributed rate limiting, the most common mistake is assuming your in-process limiter is good enough. On a single pod it is, but as soon as your service scales horizontally, each replica maintains its own counter. If the limit is 100 req/s and you run 5 pods, you are effectively allowing 500 req/s globally because no replica knows what the others have counted. This is the core problem Redis solves.

The sliding window log pattern using a Redis sorted set is a concrete starting point. The key insight is that `ZREMRANGEBYSCORE`, `ZCARD`, and `ZADD` must be wrapped in a Lua `EVAL` so they execute atomically on the Redis server. Without atomicity, two concurrent requests can both read `count < limit` and both be admitted, overshooting the limit by exactly the degree of concurrency.

For a first-job habit: always test your limiter with a benchmark that fires concurrent requests from multiple goroutines and asserts that exactly `limit` requests pass. Without that test, it is easy to ship a race condition that only surfaces under production load.

Interview entry point: "How would you implement a rate limiter that works across multiple application servers?" The expected progression is: in-process limiter (wrong for multi-host), shared Redis counter with INCR (non-atomic without Lua), Lua script for atomicity, then consistent hashing if a single Redis node is the bottleneck.

Common gotcha: the `member` value in a ZSET must be unique per request. A ZSET is a set, so `ZADD key <score> <member>` with a member that already exists updates that member's score rather than adding a second entry. Use a bare timestamp as the member and two requests landing in the same millisecond collapse into one entry, so `ZCARD` undercounts and the client gets free requests. The fix in the code above is a member of `<nanos>-<uuid>`, which is unique even when the score is not.

Second gotcha, and the reason for the `EXPIRE` discussion above: a Lua script is atomic, but it is **not transactional**. Redis runs the script to completion without interleaving other clients, which is what buys you the check-and-write atomicity. It does not roll back the writes already performed if a later command in the script errors. Prove this to yourself: run a script that writes a key and then calls `EXPIRE` with a float. The script returns an error, and the key is still there with no TTL. "Atomic" in Redis means "not interleaved," not "all or nothing."

### Senior @ FAANG: Distributed Rate Limiting at Platform Scale

**Architectural Decision Records**

At platform scale, the choice between Redis Cluster, a purpose-built rate limit service (like Lyft's Envoy-native ratelimit), and a gossip-based local approximation is a genuine ADR, not a configuration detail.

Redis Cluster works well when key cardinality is bounded (per-user, per-API-key) and the cluster can be sized for the read/write throughput of all Lua script executions. The slot constraint is load-bearing: every key touched by a single Lua script must share a hash slot. When your limiter needs to check both a per-user bucket and a per-tenant global quota in one atomic operation, you must co-locate both keys with a hash tag, which reduces shard diversity and creates hot-slot risk.

A dedicated rate limit sidecar (such as Envoy's external gRPC ratelimit service) decouples the rate limit logic from application deploys, enables centralized policy changes, and allows the sidecar to be scaled independently. The trade-off is an added network hop on every request, which must stay under roughly one millisecond to avoid adding visible latency at p99.

**Gossip-Based Local Approximation**

When sub-millisecond decisions are non-negotiable (edge PoP, L7 proxy), coordinate-free approximation becomes attractive. Each node maintains its own local counter and periodically gossips its count to peers. Every node then estimates the global count as the sum of all received values plus its own. The estimation error is bounded by the gossip interval multiplied by the per-node rate: if nodes gossip every 100ms and each sees at most 10 req/s, the global estimate can be off by `n_nodes * 10 * 0.1` requests. For abuse prevention this is acceptable. For billing-critical limits it is not.

**Token Cost Granularity**

Staff-level thinking treats rate limit capacity as a resource budget rather than a request counter. Assign costs to operations based on the actual resource impact: a paginated list call that returns 1,000 rows costs more than a single-resource GET, an async job dispatch costs differently from a synchronous write. This model lets you protect the system under adversarial load patterns (e.g., a bot that fires only "cheap" endpoints at high frequency) without setting all limits conservatively enough to penalize normal usage.

**Failure Mode Design**

"Fail open vs fail closed" is a false binary at senior level. The production pattern is a tiered fallback:

1. Redis responds: use the global distributed count.
2. Redis is slow (latency above threshold): use a local in-process limiter seeded with `global_limit / expected_pod_count`, which is conservative but not blocking.
3. Redis is down (circuit open): same local limiter, emit an alert, and page the on-call if the outage exceeds the SLO window.

The local rate in step 2 and 3 is intentionally lower than `1/n` of the global limit because under Redis failure you cannot distinguish between "all pods are limiting independently" and "one pod is runaway." Lower local limits provide defense in depth.

**Bar-Raiser Interview Signals**

A bar-raiser asks: "What is the worst-case over-admission factor for your distributed limiter?" The correct answer addresses the gossip/propagation delay, the number of replicas, and whether the algorithm is exact (Lua atomic) or approximate (local + periodic sync). Inability to quantify the error bound is a signal of shallow understanding.

A second probe: "How do you handle a Redis Cluster resharding event without dropping all rate limit state?" The answer involves hash-slot migration atomicity in Redis Cluster, the brief dual-read period during migration, and how the Lua script's slot assumption holds throughout.

---
