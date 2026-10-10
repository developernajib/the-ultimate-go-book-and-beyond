## 35.12 Interview Questions

### Question 1: What are the differences between Redis Pub/Sub and Streams?

**Answer**:

| Feature | Pub/Sub | Streams |
|---------|---------|---------|
| Persistence | No (fire and forget) | Yes (stored until deleted) |
| Consumer Groups | No | Yes |
| Message Replay | No | Yes (by ID) |
| Acknowledgment | No | Yes (XACK) |
| Use Case | Real-time broadcast | Job queues, event sourcing |

Pub/Sub delivers only to clients connected at publish time. Messages that miss a subscriber are lost. Streams are durable append-only logs addressable by ID, support consumer groups for horizontal scaling, and track a pending-entries list (PEL) so an unacked message can be reclaimed by another consumer after an idle timeout.

**What FAANG expects:** candidates to recognize that Pub/Sub is the wrong default for anything resembling a work queue or event log, and to explain the at-least-once delivery guarantee Streams provide via `XACK` + PEL + `XCLAIM`. Bonus points for contrasting Streams with Kafka (Kafka scales partitions across brokers. A single Redis stream lives on one shard unless you shard manually by key).

**Follow-ups:**
- How do you bound memory for a never-ending stream? (`XADD ... MAXLEN ~ N` for approximate trimming, or `MINID` for time-based trimming.)
- If a consumer crashes mid-processing, how do you recover its unacked messages? (Scan `XPENDING`, then `XCLAIM` with a `MinIdle` threshold.)
- When would you still pick Pub/Sub? (Cache invalidation fan-out, WebSocket presence broadcast, where missing a message is acceptable and persistence cost is not.)

### Question 2: How would you implement a distributed rate limiter?

**Answer**: Use token bucket or sliding window with Lua scripts for atomic check-and-update:

```go
// Lua script ensures atomicity
script := redis.NewScript(`
	local tokens = redis.call('get', KEYS[1])
	if tokens and tonumber(tokens) < 1 then
		return 0
	end
	redis.call('decr', KEYS[1])
	return 1
`)
```

Three canonical algorithms:
- **Fixed window** - one `INCR` per request, TTL to the window end. Simple, cheap, but allows 2x burst at the window boundary.
- **Sliding window (ZSET)** - store each request timestamp in a sorted set, trim entries older than the window, count with `ZCARD`. Accurate, but O(N) memory per active key.
- **Token bucket (Lua)** - hash with `tokens` and `last_refill`, where a Lua script refills on each call based on elapsed time and atomically decrements. Allows controlled bursts up to bucket capacity while enforcing long-run average rate.

**What FAANG expects:** understanding why the operation must be atomic (two goroutines reading the same count and both passing the check is the classic bug), why Lua is the idiomatic Redis solution, and when to use sliding-window-log vs token-bucket based on memory and burst semantics.

**Follow-ups:**
- Your rate limiter is keyed by user ID. How do you avoid hot-sharding one user across a cluster? (Use the user ID in the key. Redis Cluster hashes the key, so one user's counter stays on one shard - that is the desired behavior. The concern is a celebrity-user hot shard, mitigated by per-region sub-keys or probabilistic sampling.)
- How do you handle clock skew across app servers when every server calls `time.Now().UnixMilli()` locally? (Pass `now` as an argument to the Lua script - but better, use `redis.call('TIME')` inside the script so all servers agree on Redis's clock.)
- Compare Redis-backed rate limiting to an in-process token bucket (`golang.org/x/time/rate`). (In-process is free and latency-zero but per-pod. Redis is shared and correct under horizontal scaling but adds a network hop.)

### Question 3: How does Redis handle failover with Sentinel?

**Answer**: Redis Sentinel provides:
1. **Monitoring**: Sentinel instances continuously ping master and replicas.
2. **Notification**: Alerts operators on detected failures.
3. **Automatic failover**: A quorum of Sentinels promotes a replica to master when the existing master is judged down.
4. **Configuration provider**: Clients query Sentinels to discover the current master address.

```go
// Client configuration for Sentinel
rdb := redis.NewFailoverClient(&redis.FailoverOptions{
	MasterName:    "mymaster",
	SentinelAddrs: []string{":26379", ":26380", ":26381"},
})
```

Deploy an odd number of Sentinels (3 or 5) across failure domains so a minority partition cannot trigger a split-brain promotion.

**What FAANG expects:** awareness that Sentinel gives HA but not horizontal scaling, that writes briefly stall during failover, and that during a partition you can see stale reads from the old master until it is re-synced. Strong candidates mention that Sentinel-based setups do not provide strict linearizability - recent writes that had not yet replicated to the promoted replica can be lost.

**Follow-ups:**
- What is the difference between Sentinel and Cluster? (Sentinel = HA for a single primary-replica set. Cluster = sharding across multiple primaries with gossip-based slot ownership.)
- How does Sentinel differ from managed services like ElastiCache for Valkey or Memorystore? (Managed services abstract Sentinel/Cluster behind a cluster-mode-enabled endpoint and handle failover, patching, and backups - you interact only with the cluster endpoint.)
- What happens if a Sentinel quorum is lost? (No failover can occur. The existing master continues serving until a quorum is restored.)

### Question 4: What's the cache stampede problem and how do you prevent it?

**Answer**: Cache stampede (thundering herd) occurs when a hot cache key expires and thousands of concurrent requests simultaneously miss the cache and hammer the database for the same value, often overwhelming the database.

Solutions:
1. **Single-flight lock** - only one request recomputes. Others wait and read the new value. Shown below.
2. **TTL jitter** - add 10-20% random jitter to TTLs so keys in the same class do not expire at the same instant.
3. **Probabilistic early expiration (XFetch)** - requests read the stored value plus its computed TTL, and with probability increasing as TTL approaches zero, one request refreshes the value before the hard expiry. Avoids the "everybody waits" pattern entirely.
4. **Background refresh** - a dedicated refresher updates hot keys on a schedule shorter than the TTL. The cache never technically expires under load.

```go
// Lock-based approach
func getWithLock(ctx context.Context, key string) (*Data, error) {
	data, err := cache.Get(ctx, key)
	if err == nil {
		return data, nil
	}

	lock := NewLock(rdb, "lock:"+key, 10*time.Second)
	if acquired, _ := lock.Acquire(ctx); acquired {
		defer lock.Release(ctx)
		data, err = database.Get(ctx, key)
		if err == nil {
			cache.Set(ctx, key, data, time.Hour)
		}
		return data, err
	}

	// Wait and retry
	time.Sleep(100 * time.Millisecond)
	return cache.Get(ctx, key)
}
```

**What FAANG expects:** recognize that stampede is not one bug but a family (expiration stampede, cold-start stampede, invalidation stampede), and to pick a strategy suited to the workload. Bonus: identify `golang.org/x/sync/singleflight` as the in-process variant and Redis as the cross-process variant.

**Follow-ups:**
- What if the DB lookup is slow and takes longer than the lock TTL? (Use the lock's `Extend` method to push the TTL, or use XFetch to refresh before expiry.)
- If 10k goroutines are polling the cache while the single holder recomputes, how do you avoid the polling load itself becoming the problem? (Exponential backoff, or subscribe to a "refresh-done" Pub/Sub channel instead of polling.)
- How does `singleflight.Group` compare? (Same pattern, process-local - cheaper but does not coalesce across pods. Combine with the Redis lock for cross-process dedup on top of in-process coalescing.)

### Question 5: When would you use Redis Cluster vs Sentinel?

**Answer**:

**Redis Sentinel** for:
- High availability (automatic failover) on a single logical dataset.
- Small to medium datasets that fit in one node's memory.
- Read scaling via replicas (writes still serialize through the primary).

**Redis Cluster** for:
- Horizontal scaling (data sharded across 16384 hash slots).
- Datasets larger than a single node's memory.
- Write scaling distributed across multiple primaries.

Cluster's cost: no multi-key commands unless all keys share a hash tag (`{user:42}:profile`, `{user:42}:orders`), and transactions/Lua scripts cannot span slots.

**What FAANG expects:** candidates to know that the decision is driven by working-set size and write throughput, not by HA (Cluster also provides HA via per-shard replication). Strong candidates mention the cluster mode constraints on multi-key operations and explain hash tags for co-locating keys that must be operated on together.

**Follow-ups:**
- You need a transaction across two keys and you are running in Cluster mode. How do you ensure they land on the same shard? (Use the same hash tag - `{order:123}:items` and `{order:123}:total` both hash on `order:123`.)
- Why is cluster-mode Lua limited? (The script can only touch keys in a single slot. Otherwise it returns a CROSSSLOT error. Redis enforces this because the script runs on one node and cannot atomically touch another shard.)
- What is the managed-cloud equivalent today? (ElastiCache for Valkey cluster-mode-enabled or Memorystore for Valkey - both abstract the cluster topology behind a cluster endpoint and handle shard resharding automatically.)

### Question 6: Redis vs Valkey - which should you pick in 2026?

**Answer**: Both speak the same wire protocol and the same command set (Valkey is a BSD-3-Clause fork of Redis 7.2.4 maintained by the Linux Foundation after Redis Ltd. moved the reference implementation to RSALv2/SSPL in March 2024). Choose based on:

- **License:** Valkey is BSD-3-Clause permissive. Redis 8+ is AGPLv3 / RSALv2 / SSPL (triple-licensed). If your organization forbids AGPL in product dependencies, Valkey is the safer pick.
- **Managed service:** AWS ElastiCache and Google Memorystore both offer Valkey as their default Redis-compatible service and continue investing there. Azure Cache and Redis Enterprise remain on Redis Ltd. builds.
- **Performance:** Valkey 8.x shipped measurable I/O-threading improvements. On mostly GET/SET workloads at high connection counts Valkey has shown ~15-20% higher throughput than Redis 7.4 in published benchmarks.
- **Features:** Redis Ltd. controls "Redis Stack" features (RediSearch, RedisJSON, RedisBloom, RedisTimeSeries) under their license. Valkey is building module-compatible equivalents but the ecosystem still lags upstream Redis on modules.

For a brand-new Go service in 2026, **Valkey is the default** unless you specifically need Redis Stack modules.

**What FAANG expects:** awareness that this is primarily a licensing, vendor-alignment, and ecosystem decision, not a code decision - `go-redis` and `rueidis` connect to either without modification. Strong candidates also know that AWS, Google, and Oracle all backed the fork and that the original Redis core maintainers moved to Valkey.

**Follow-ups:**
- Can you migrate a running ElastiCache for Redis cluster to ElastiCache for Valkey? (Yes - AWS ships in-place upgrade paths for most Redis OSS versions to Valkey.)
- What breaks if you point a `go-redis/v9` client at Valkey? (Nothing - the protocol is identical through Redis 7.2.)
- When would you still pick Redis Ltd.? (You need Redis Stack modules under enterprise support, or you already have an enterprise contract with Redis Ltd.)

### Question 7: Is Redlock safe for correctness-critical distributed locking?

**Answer**: Probably not. Redlock is antirez's multi-node algorithm that acquires a lock on a majority of independent Redis masters. Martin Kleppmann's critique ("How to do distributed locking", 2016) argued that Redlock assumes bounded clock drift, bounded network delay, and bounded process pauses - assumptions that fail in practice (GC pauses, NTP corrections, VM suspension), allowing two clients to simultaneously believe they hold the lock. Antirez rebutted, maintaining the assumptions are reasonable for most workloads and that fencing tokens solve the remaining correctness gap.

The pragmatic rule for Go engineers:

- For **non-correctness-critical coordination** (deduplicating a job, debouncing a webhook, serializing a cron runner): a single-node `SET NX EX` with a UUID-owner check is sufficient and simpler than Redlock.
- For **correctness-critical mutual exclusion** (uniqueness, financial transfers, single-writer invariants): do not rely on a Redis lock alone. Use the resource's own atomicity - Postgres advisory locks, database row locks, or a fencing token that the protected resource validates on every write.

**What FAANG expects:** candidates to know the Kleppmann/antirez debate exists, to articulate why a TTL-based lock cannot be safe under unbounded pauses, and to pick the simpler SET NX EX + fencing approach over Redlock when stronger guarantees are needed. The wrong answer is "use Redlock because it's the Redis-recommended algorithm."

**Follow-ups:**
- What is a fencing token? (A monotonically increasing number issued with the lock. The protected resource rejects any write carrying an older fence. Prevents zombie holders after a pause from corrupting state.)
- Why does Postgres's `pg_advisory_lock` sidestep this whole problem? (It lives in the same database that stores the protected data, so the lock and the write are in the same transactional boundary - no clock, no TTL, no separate failure domain.)
- If you must use a Redis lock, how do you detect a stale holder? (Store the fence token in Redis alongside the lock, increment it on each acquisition, and pass it into every mutation the holder performs.)

### Junior to FAANG: How to Hear an Interview Question

Interview questions about Redis are not about Redis. They are about your trade-off reasoning with Redis as the vocabulary. A junior candidate hears "how would you build a rate limiter" and starts writing Lua. A mid candidate asks three questions first. At what QPS. What burst behavior is acceptable. Is the limit per user or per IP or per endpoint. Only after the requirements are clear do you reach for code.

Signal ladder on interview questions:
- L3 (new grad): can implement the happy path, handles `redis.Nil` correctly, knows SET NX EX syntax.
- L4 (mid): picks the right data structure (sorted set versus hash versus stream), uses pipelines, understands TTL and jitter.
- L5 (senior): articulates trade-offs across multiple valid solutions, volunteers failure modes without prompting, references real incidents.
- L6 (staff): frames the question as an ADR with alternatives rejected and consequences, discusses multi-region topology, introduces governance concerns.
- L7 (principal): discusses organizational trade-offs, cost at fleet scale, migration paths from current state to proposed state, backward compatibility with existing consumers.

Worked example of reading a question the way the interviewer wants. Question: "design a session store in Redis for a web application." Bad answer: "SET userID to sessionData with a TTL." Good answer asks about session size (is it a JWT reference or a full payload), auth assumptions (do sessions need to be revocable before TTL), scale (QPS, concurrent sessions), multi-region (single write region or active-active), and durability (is losing a session on Redis failover acceptable). The first five minutes of a good answer is requirement elicitation. The actual implementation takes the last ten minutes.

First-job reflex for question follow-ups. When the interviewer pushes back with "what if X fails," do not defend the original answer. Say "good point, in that case I would change Y because Z." Interviewers test for flexibility as much as correctness. The candidate who rigidly defends their first design signals they will fight code review feedback. The candidate who adjusts gracefully signals they will collaborate.

Why did this fail as an interview reflex. If a candidate implements SET-Check-Del for a distributed lock without the Lua owner check, the interviewer writes "did not identify the race condition" on the feedback form. If asked "how does this release the right lock" and the candidate freezes, they fail. The rehearsal: before every system design interview, do the Lua owner-check script from memory. It comes up in roughly one third of Redis-related interviews.

### Senior at FAANG: Bar-Raiser Redis Questions and Signal Framework

Bar-raiser interviews go beyond the seven questions in this section. The expectation at L5 and above is that you can design a system the scale of the case studies in section 35.10, defend every choice against an adversarial interviewer, and connect each choice to a production incident you have worked.

Bar-raiser question one: design a global rate limiter for 10M QPS. The expected answer is not a single Lua script. It is a tiered architecture. Tier 1 is in-process token bucket per pod using `golang.org/x/time/rate` sized to the pod's share of the global limit, refilled once per second from a shared counter. Tier 2 is a regional Redis cluster per region holding the current token balance, updated by pods via async batch decrements. Tier 3 is a cross-region reconciler running every 10 seconds that rebalances the per-region budget based on observed consumption. The candidate must articulate why a single global Redis cluster cannot handle 10M QPS (cross-region latency plus single-shard hot key) and how the tiered design trades strictness for scale (small overshoot possible during reconciliation windows, bounded by the tier-1 budget).

Bar-raiser question two: design a real-time chat system with Redis. The expected answer combines Streams for message durability (per-channel stream with consumer groups per gateway server), Pub/Sub for real-time fanout to connected clients (fast path, best effort), sorted sets for message history pagination (scored by stream ID for cursor-based reads), and hashes for per-user unread counters. The senior signal is knowing which structure to use for which subproblem, not knowing all Redis commands. Candidate must address message ordering guarantees (per-channel total order via stream ID, cross-channel partial order), retention (XTRIM MAXLEN with per-plan limits), and backfill for reconnecting clients (replay from last-acked stream ID).

Bar-raiser question three: design a leaderboard for 1B users. The expected answer starts with "a single sorted set will not hold 1B entries at acceptable memory cost." Estimate: 1B entries at ~80 bytes each is 80 GB, plus skiplist overhead puts you at 120 to 150 GB. Fits on a large box but is operationally scary. Better design: shard by score range (top 1M in a hot sorted set, next 10M in a warm set, remainder in a cold store with lazy promotion on activity). Hot set served by Redis, cold set served by a column store. Discuss update throughput (1B users each updating once per hour is 280K updates per second, manageable on a sharded Redis), query patterns (top N, rank of user, rank range around user), and consistency (near-real-time is fine, seconds of lag acceptable). Strong candidates volunteer that Discord's ranked system and Twitter's trending use similar shard-by-activity designs.

Bar-raiser question four: debug a Redis latency spike at 99.9p. The interviewer describes a scenario. P50 is stable at 0.4 ms, p99 at 2 ms, p99.9 jumped from 5 ms to 40 ms in the last hour, p99.99 jumped from 12 ms to 200 ms. The expected debug sequence: first check slowlog for new entries above 10 ms, then redis-cli --latency-history to baseline current network round trip, then INFO stats for blocked_clients and connected_clients changes, then MEMORY USAGE on recently written keys for bigkey growth, then CLIENT LIST for long-running CLIENT PAUSE or MONITOR commands, then CPU profile via perf on the Redis process if single-threaded utilization is saturated. The candidate should mention that p99.9 spikes with stable p50 usually point to either bigkey operations or client-side pool exhaustion, not Redis itself. They should walk through the hypothesis tree, not jump to a single answer.

Bar-raiser question five: migrate from Redis Sentinel to Redis Cluster with zero downtime for a 500 GB dataset. The expected answer is a dual-write plus shadow-read ADR. Phase 1: deploy Cluster alongside Sentinel with equivalent capacity. Phase 2: application begins dual-writing to both systems, reads continue from Sentinel, a shadow reader samples 1 percent of reads from Cluster and diffs results into a log. Phase 3: after shadow reads show zero divergence for 7 days, flip read traffic to Cluster 1 percent at a time over 48 hours. Phase 4: after 30 days of stable Cluster reads, disable Sentinel writes and decommission. The candidate must address multi-key operations (audit call sites for KEYS, MGET, transactions, and either add hashtags or rewrite), Lua scripts (must be cluster-safe), pipelining (per-slot batching required in cluster mode), and client library compatibility (go-redis ClusterClient versus Client).

Signal framework for what you are actually being graded on:
- Requirements first: did you elicit context before coding.
- Failure modes: did you volunteer what breaks.
- Trade-offs: did you name what you gave up to gain what you got.
- Real incidents: did you reference a war story (yours or published).
- Governance: did you discuss how to prevent the same mistake next time.
- ADR instincts: did you frame the decision with context, consequence, alternatives rejected.
- Operational realism: did you talk about on-call, runbooks, rollout plans.

Candidates hit at L5 when they do four of seven naturally. L6 candidates hit six of seven. L7 candidates hit all seven and also reframe the question when the premise is wrong ("I would push back on why we need a global lock here before we design one").

Common bar-raiser trap questions:
- "Why not just use Redis for everything." Tests whether you can reject your own specialty when the data model is wrong.
- "Your Redis CPU is at 30 percent but p99 is bad. What is happening." Tests understanding of single-threaded event loop versus multi-thread I/O in Redis 8 and Valkey 8.
- "How would you run Redis across three regions with strong consistency." Tests whether you know that strong consistency across regions with Redis is Redis Enterprise CRDT territory and even then has edge cases (counter CRDTs sum independently, which may or may not match the semantic you want).
- "Show me a bug in this Lua script." Tests whether you know that Lua scripts run atomically and thus any non-deterministic branch (random, time without redis.call('TIME')) breaks replication.

Preparation rubric for staff-plus interviews. Spend 30 minutes on each of: cluster topology and migration strategy, three canonical failure patterns (the synchronized-TTL cache stampede, Twitter's celebrity fan-out, Stripe-style idempotency-key durability), Valkey versus Redis ADR template, Lua determinism and cluster constraints, rate limiter design at 10M QPS, leaderboard sharding, memory governance (maxmemory-policy per workload plus bigkey and hotkey detection). The interviewer will sample randomly from these topics.

---
