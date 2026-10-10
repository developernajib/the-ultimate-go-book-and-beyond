## 35.10 Company Case Studies

### How Twitter Uses Redis for Timelines

Twitter's home timeline uses a "fan-out on write" pattern: when a user tweets, the tweet ID is pushed into the Redis sorted set for each follower's timeline, scored by timestamp. This trades write amplification for fast reads - loading a timeline is a single `ZRevRange` call instead of a complex join across the social graph. For users with very large follower counts (celebrities), Twitter skips the fan-out and merges their tweets at read time to avoid writing to millions of sorted sets on every post.

```go
// Twitter-style fan-out on write for timelines
type TimelineService struct {
	rdb *redis.Client
}

func (t *TimelineService) AddTweet(ctx context.Context, tweet *Tweet) error {
	// Get follower IDs (stored separately)
	followerIDs, err := t.getFollowerIDs(ctx, tweet.AuthorID)
	if err != nil {
		return err
	}

	// Fan out to follower timelines using pipeline
	pipe := t.rdb.Pipeline()

	// Add to author's own timeline
	pipe.ZAdd(ctx, "timeline:"+tweet.AuthorID, redis.Z{
		Score:  float64(tweet.CreatedAt.UnixMilli()),
		Member: tweet.ID,
	})
	pipe.ZRemRangeByRank(ctx, "timeline:"+tweet.AuthorID, 0, -801) // Keep 800 tweets

	// Fan out to followers (for users with < 1000 followers)
	if len(followerIDs) < 1000 {
		for _, followerID := range followerIDs {
			pipe.ZAdd(ctx, "timeline:"+followerID, redis.Z{
				Score:  float64(tweet.CreatedAt.UnixMilli()),
				Member: tweet.ID,
			})
			pipe.ZRemRangeByRank(ctx, "timeline:"+followerID, 0, -801)
		}
	}

	_, err = pipe.Exec(ctx)
	return err
}

func (t *TimelineService) GetTimeline(ctx context.Context, userID string, page int) ([]string, error) {
	start := int64((page - 1) * 20)
	end := start + 19

	// Get tweet IDs from user's timeline
	tweetIDs, err := t.rdb.ZRevRange(ctx, "timeline:"+userID, start, end).Result()
	if err != nil {
		return nil, err
	}

	return tweetIDs, nil
}
```

### Presence Tracking at Chat Scale

A chat platform tracks millions of concurrent users' online/offline status. (Discord itself famously built its presence service on Elixir, but the Redis-based design below is the standard shape for Go stacks solving the same problem.) Each user's presence is stored as a JSON string with a 5-minute TTL that acts as a heartbeat - if the client stops refreshing, the key expires and the user appears offline automatically. The `online_users` set provides a fast membership check for rendering user lists, and presence changes are broadcast via `Publish` so that all connected gateway servers can push updates to WebSocket clients in real time.

```go
// Discord-style presence system
type PresenceService struct {
	rdb *redis.Client
}

type PresenceStatus struct {
	UserID    string    `json:"user_id"`
	Status    string    `json:"status"` // online, idle, dnd, offline
	Activity  string    `json:"activity,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (p *PresenceService) UpdatePresence(ctx context.Context, presence *PresenceStatus) error {
	pipe := p.rdb.Pipeline()

	// Store presence data
	data, _ := json.Marshal(presence)
	pipe.Set(ctx, "presence:"+presence.UserID, data, 5*time.Minute)

	// Add to online users set (if online)
	if presence.Status != "offline" {
		pipe.SAdd(ctx, "online_users", presence.UserID)
	} else {
		pipe.SRem(ctx, "online_users", presence.UserID)
	}

	// Publish presence update for real-time notifications
	pipe.Publish(ctx, "presence_updates", data)

	_, err := pipe.Exec(ctx)
	return err
}

func (p *PresenceService) GetPresence(ctx context.Context, userID string) (*PresenceStatus, error) {
	data, err := p.rdb.Get(ctx, "presence:"+userID).Bytes()
	if err == redis.Nil {
		return &PresenceStatus{UserID: userID, Status: "offline"}, nil
	}
	if err != nil {
		return nil, err
	}

	var presence PresenceStatus
	json.Unmarshal(data, &presence)
	return &presence, nil
}

func (p *PresenceService) GetBulkPresence(ctx context.Context, userIDs []string) (map[string]*PresenceStatus, error) {
	pipe := p.rdb.Pipeline()
	cmds := make([]*redis.StringCmd, len(userIDs))

	for i, id := range userIDs {
		cmds[i] = pipe.Get(ctx, "presence:"+id)
	}

	pipe.Exec(ctx)

	result := make(map[string]*PresenceStatus)
	for i, cmd := range cmds {
		data, err := cmd.Bytes()
		if err == redis.Nil {
			result[userIDs[i]] = &PresenceStatus{UserID: userIDs[i], Status: "offline"}
			continue
		}
		if err != nil {
			continue
		}

		var presence PresenceStatus
		json.Unmarshal(data, &presence)
		result[userIDs[i]] = &presence
	}

	return result, nil
}
```

### How Instagram Uses Redis for Counters

Instagram stores per-post engagement counters (likes, comments, shares) in Redis hashes, using `HIncrBy` for atomic increments that avoid read-modify-write races. For unique view counting, HyperLogLog (`PFAdd`/`PFCount`) provides cardinality estimates with less than 1% error using only 12 KB of memory per counter, regardless of how many unique viewers a post receives - a trade-off that makes sense when exact counts are not required but memory efficiency at scale is.

```go
// Instagram-style counter service
type CounterService struct {
	rdb *redis.Client
}

func (c *CounterService) IncrementLikeCount(ctx context.Context, postID string) (int64, error) {
	return c.rdb.HIncrBy(ctx, "post:"+postID+":counters", "likes", 1).Result()
}

func (c *CounterService) GetPostCounters(ctx context.Context, postID string) (map[string]int64, error) {
	result, err := c.rdb.HGetAll(ctx, "post:"+postID+":counters").Result()
	if err != nil {
		return nil, err
	}

	counters := make(map[string]int64)
	for k, v := range result {
		var count int64
		fmt.Sscanf(v, "%d", &count)
		counters[k] = count
	}

	return counters, nil
}

// Track unique viewers using HyperLogLog
func (c *CounterService) TrackView(ctx context.Context, postID, userID string) error {
	return c.rdb.PFAdd(ctx, "post:"+postID+":viewers", userID).Err()
}

func (c *CounterService) GetUniqueViewCount(ctx context.Context, postID string) (int64, error) {
	return c.rdb.PFCount(ctx, "post:"+postID+":viewers").Result()
}
```

### Junior to FAANG: Reading Case Studies Without Cargo Culting

First-job engineers read the Twitter timeline design and copy it blindly into their 50-user startup. That is the anti-pattern. Fan-out on write exists because Twitter reads timelines billions of times per day and writes tweets comparatively rarely. If your read to write ratio is 3 to 1, fan-out on write is strictly worse than fan-out on read. Before copying any architecture in this section, write down three numbers. Read QPS, write QPS, and p99 latency budget. Only after those numbers exist should you pick a pattern.

Worked example. You are asked to build a notification inbox for a social app with 100K daily active users. Junior instinct says "use Twitter's fan-out model." Senior instinct says "run the math." 100K DAU producing 5 notifications each reading their inbox 20 times per day gives 500K writes and 2M reads. That is a 4 to 1 read to write ratio, low enough that a simple sorted set keyed by user with notifications inserted directly is fine. No fan-out needed. No celebrity branch. The Twitter design becomes correct only once you are at tens of millions of reads per write.

Why did this fail reflex. When an Instagram-style counter under HyperLogLog shows a count that does not match the SQL source of truth, the junior reaction is "Redis is broken." The correct reaction is "HLL has a 0.81 percent standard error by design and I traded exactness for 12 KB memory." Always check whether the discrepancy is inside the algorithm's documented error bound before opening a bug.

Interview entry-point. An L3 or L4 interviewer asks "how would you store like counts for a photo app." Start with the naive answer (row in SQL with an integer column), identify the bottleneck (hot row contention on popular posts), then introduce Redis HINCRBY with a writeback job to the SQL source of truth every N seconds. That sequence shows you can reason about trade-offs instead of reaching for Redis because it is the trendy answer.

### Senior at FAANG: Case Study Governance, ADRs, and Maturity Model

Staff and principal engineers do not just read case studies. They extract the decision records that produced them and translate those ADRs to local context.

Twitter Timeline ADR, restated. Decision: fan-out on write with a read-time merge branch for accounts exceeding 1M followers. Context: 99th percentile read latency budget of 40 ms and fan-out write amplification capped by celebrity threshold. Consequence: write path now depends on Redis Cluster availability for the hot shard, requiring a dedicated failover runbook and cross-region replica. Alternatives rejected: fan-out on read across the full graph (failed the read latency budget under load), materialized views in MySQL (failed write throughput). The point of restating the ADR is that your local decision must go through the same four sections (decision, context, consequence, alternatives rejected) before the pattern is approved for production.

Stripe idempotency key Redis. Stripe stores every idempotency key for 24 hours with the serialized response body. An ADR governing a layer like this must be strict: idempotency keys have to survive Redis failover, which forces AOF with appendfsync everysec plus a replica in a different availability zone. If your idempotency layer loses keys during a failover you will double-charge customers. This is not a caching workload. It is a durability workload that happens to use Redis. Classify every workload before picking the persistence policy.

Discord plus Scylla. Discord migrated message storage from Cassandra to ScyllaDB while its presence system stays in ephemeral in-memory state (Elixir process state in their stack, Redis with TTLs in the design earlier in this section). The governance rule that generalizes from this split: never put ephemeral state (TTL less than 1 hour) in a durable store, and never put durable state (financial, audit, user-generated content) solely in Redis. Violating this rule in either direction leads to incidents. A canonical post-mortem category inside FAANGs is "durable data stored only in Redis, lost during failover."

TTL jitter ADR. A classic stampede shape: hundreds of thousands of cache keys expire in the same second because a batch job populated them all with an identical TTL. The fix: add jitter of plus or minus 10 percent to every TTL at write time. A mature ADR mandates jitter for any key written by a batch process. Production patterns like this come from real outages. When you adopt a case study, adopt the post-mortem driven constraints, not just the happy path.

Shopify rate limiter. Shopify's public API docs describe its rate limiting as a leaky bucket. Implemented on Redis, a bucket update runs as a single Lua script per request to guarantee atomicity. The governance rule that follows: any new Lua script in production requires a review gate with an explicit CPU budget, because a slow script blocks the single-threaded Redis event loop and becomes a latency amplifier.

Cross-slot governance at scale. Teams running large Redis Cluster fleets converge on the same rule: no cross-slot multi-key operations in application code, enforced with a linter or client wrapper that rejects MGET, MSET, SUNIONSTORE, and transactions spanning keys without hashtags. This is not a nice to have. Without enforcement, cross-slot ops produce runtime errors in production that stay undetected in single-instance test environments.

Netflix EVCache. Netflix built EVCache on Memcached not Redis because their workload is read-heavy, key-value only, and they needed cross-region active-active replication with eventual consistency. The reasoning reads like a model ADR: no need for sorted sets, streams, or pub-sub, so adding Redis would have introduced complexity without feature value. A senior engineer reading this understands that Redis is not always the right answer. Match the data model to the workload.

Valkey migration ADR (the post-2024 wave). After the Redis license change in 2024, AWS ElastiCache and GCP Memorystore both steer new deployments toward Valkey, and Valkey 8's multi-threaded I/O rewrite posted benchmark wins over contemporary Redis releases on cluster workloads. The ADR template a staff engineer writes today: decision to migrate to Valkey, context of license risk plus performance gains on read-heavy workloads, consequence of losing access to Redis Stack modules (RediSearch, RedisJSON, RedisBloom) which are not upstream in Valkey, alternatives rejected including staying on Redis 7.2 (license risk) or self-hosting Redis OSS 7.2.4 (operational burden). For workloads using only core data structures plus streams, Valkey is the default. For workloads using Redis Stack modules, stay on Redis Enterprise or migrate the module functionality to a sibling service (OpenSearch for search, a dedicated JSON store for documents).

Standalone to Cluster migration ADR. Going from single-instance Redis to Redis Cluster is a one-way door. Once you shard, you lose multi-key transactions across slots, MULTI/EXEC across keys without hashtags, and the ability to KEYS the whole dataset. The migration ADR must enumerate every call site that uses multi-key operations and either add hashtags to force colocation, rewrite to single-key operations, or move to Lua scripts with EVAL and hashtag-aligned keys. Skipping this audit produces production incidents within hours of the cutover.

Failover runbook contract. Every Redis deployment above L2 maturity must have a runbook with five sections. Detection (which alert fires, slowlog threshold, replica lag threshold), containment (traffic shift to read replica, circuit breaker engagement), diagnosis (MEMORY USAGE on suspected bigkeys, redis-cli --latency against primary, CLIENT LIST for connection spikes), recovery (FAILOVER command procedure, sentinel quorum check, cluster slot migration if needed), post-mortem (ADR update if a pattern failed). Runbooks that do not have all five sections fail the bar-raiser check.

Memory governance model. Each workload declares its maxmemory-policy at deployment time. Cache workloads use allkeys-lru or allkeys-lfu. Session workloads use volatile-ttl so only TTL-bearing keys are evicted. Durable workloads (idempotency, rate limiter counters) use noeviction and are monitored for OOM with a page-sev-1 alert. Mixing policies inside a single Redis instance is forbidden. If two workloads need different eviction policies, they need different Redis deployments.

Hotkey and bigkey governance. Quarterly each service on-call runs redis-cli --hotkeys and redis-cli --bigkeys against a replica and files any key exceeding 1 MB or any single key taking more than 1 percent of all GET traffic as a ticket. Hotkeys drive latency spikes because a single-threaded event loop serializes all accesses. Bigkeys drive memory exhaustion and blocking deletes (DEL on a 10 MB hash can block for tens of milliseconds). Governance is not optional at scale. It is the only reason production Redis stays alive under growth.

Maturity model for Redis deployments:
- L1: single instance, RDB snapshots, no replica, no monitoring beyond uptime. Startup baseline.
- L2: primary plus replica, Sentinel failover, latency monitoring, slowlog on.
- L3: Redis Cluster with minimum three primaries and three replicas, hashtag discipline enforced by linter, automated failover tested quarterly.
- L4: multi-region Cluster with cross-region read replicas, per-workload instance separation, bigkey/hotkey governance enforced by CI.
- L5: multi-region active-active via Redis Enterprise CRDTs (no open-source Valkey equivalent exists yet, so this tier is commercial-only), full ADR coverage, bar-raiser review on schema changes.

The maturity model is the target operating standard for a staff engineer owning a Redis fleet. Each level change requires an ADR and a dedicated readiness review.

---
