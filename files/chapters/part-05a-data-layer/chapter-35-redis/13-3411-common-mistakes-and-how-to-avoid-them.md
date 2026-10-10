## 35.11 Common Mistakes and How to Avoid Them

### Mistake 1: Not Handling Connection Errors

Redis operations return two distinct error conditions: `redis.Nil` (the key does not exist) and actual errors (network failure, timeout, auth failure). Discarding the error with `_` treats a Redis outage the same as a cache miss, silently returning empty data to the user. Always check for `redis.Nil` separately, then handle other errors as infrastructure failures that should be logged and propagated.

```go
// WRONG: Assuming connection always works
func getData(ctx context.Context, rdb *redis.Client, key string) string {
	val, _ := rdb.Get(ctx, key).Result() // Ignoring error!
	return val
}

// CORRECT: Handle all errors including redis.Nil
func getData(ctx context.Context, rdb *redis.Client, key string) (string, error) {
	val, err := rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		return "", nil // Key doesn't exist
	}
	if err != nil {
		return "", fmt.Errorf("redis error: %w", err)
	}
	return val, nil
}
```

### Mistake 2: Using Keys Command in Production

The `KEYS` command scans the entire keyspace in a single blocking operation. On a Redis instance with millions of keys, this blocks all other commands for seconds or longer - effectively freezing your application. `SCAN` iterates the keyspace incrementally in batches (100 keys at a time in this example), allowing Redis to serve other commands between iterations.

```go
// WRONG: KEYS blocks Redis for large keyspaces
func deleteAllUserKeys(ctx context.Context, rdb *redis.Client) error {
	keys, _ := rdb.Keys(ctx, "user:*").Result()
	return rdb.Del(ctx, keys...).Err()
}

// CORRECT: Use SCAN for iterative deletion
func deleteAllUserKeys(ctx context.Context, rdb *redis.Client) error {
	var cursor uint64
	for {
		keys, newCursor, err := rdb.Scan(ctx, cursor, "user:*", 100).Result()
		if err != nil {
			return err
		}

		if len(keys) > 0 {
			if err := rdb.Del(ctx, keys...).Err(); err != nil {
				return err
			}
		}

		cursor = newCursor
		if cursor == 0 {
			break
		}
	}
	return nil
}
```

### Mistake 3: Not Using Pipelining for Multiple Operations

Issuing Redis commands one at a time in a loop adds a full network round trip per command. With a typical 0.5ms round trip to Redis, setting 100 keys takes 50ms sequentially but only ~1ms with a pipeline. The pipeline buffers all commands locally, sends them in a single TCP write, and reads all responses together. Use pipelines whenever you issue more than two or three commands in sequence.

```go
// WRONG: Multiple round trips
func setMultiple(ctx context.Context, rdb *redis.Client, data map[string]string) error {
	for k, v := range data {
		if err := rdb.Set(ctx, k, v, 0).Err(); err != nil {
			return err
		}
	}
	return nil
}

// CORRECT: Use pipeline for batch operations
func setMultiple(ctx context.Context, rdb *redis.Client, data map[string]string) error {
	pipe := rdb.Pipeline()
	for k, v := range data {
		pipe.Set(ctx, k, v, 0)
	}
	_, err := pipe.Exec(ctx)
	return err
}
```

### Mistake 4: Lock Without Owner Verification

A plain `DEL` on a lock key releases the lock regardless of who holds it. If process A's lock expires due to slow processing and process B acquires it, process A's deferred `DEL` will delete process B's lock - leaving the resource unprotected. The fix uses a Lua script to atomically check that the lock value matches the caller's unique token before deleting, ensuring only the lock owner can release it.

```go
// WRONG: Any process can delete the lock
func unlock(ctx context.Context, rdb *redis.Client, key string) error {
	return rdb.Del(ctx, key).Err() // Dangerous!
}

// CORRECT: Only owner can release lock
func unlock(ctx context.Context, rdb *redis.Client, key, ownerID string) error {
	script := redis.NewScript(`
		if redis.call("get", KEYS[1]) == ARGV[1] then
			return redis.call("del", KEYS[1])
		else
			return 0
		end
	`)
	return script.Run(ctx, rdb, []string{key}, ownerID).Err()
}
```

### Mistake 5: Not Setting TTL on Cache Keys

Setting TTL to `0` in `rdb.Set` stores the key permanently. It never expires and never frees its memory unless explicitly deleted. In a cache serving requests for many distinct keys (per-user, per-request), keys accumulate indefinitely, exhausting Redis memory until the server hits `maxmemory` and starts evicting keys unpredictably or rejecting writes. The fix passes a `ttl time.Duration` parameter and always provides a non-zero value, making the TTL an explicit contract rather than an afterthought.

```go
// WRONG: Keys without TTL can cause memory issues
func cache(ctx context.Context, rdb *redis.Client, key string, value any) error {
	data, _ := json.Marshal(value)
	return rdb.Set(ctx, key, data, 0).Err() // No TTL!
}

// CORRECT: Always set appropriate TTL
func cache(ctx context.Context, rdb *redis.Client, key string, value any, ttl time.Duration) error {
	data, _ := json.Marshal(value)
	return rdb.Set(ctx, key, data, ttl).Err()
}
```

### Junior to FAANG: Reflexes Before Reaching for Redis

Every mistake in this section has a reflex that would have prevented it. Building those reflexes is what turns a new grad into a mid-level engineer. Below is the ladder from pain to reflex.

Reflex 1: never discard the error on any Redis call. When you see `val, _ := rdb.Get(...)`, treat it as a code review block. The underscore is not a typo. It is a production incident. Redis returns four classes of error and they require four different responses. `redis.Nil` means key missing (not an error for a cache lookup). `context.DeadlineExceeded` means the caller gave up (log and propagate). `redis.ErrClosed` means the client pool is closed (reconnect or fail fast). Everything else means the connection had an infrastructure failure. Collapsing these into a single `_` discard is the most frequent root cause of silent data loss in production caching layers.

Worked example of reflex 2 (never run KEYS). A junior engineer is asked to delete all cache entries for a user who just requested GDPR erasure. They write `rdb.Keys(ctx, "user:123:*")`. During staging with 10K keys the command returns in 40 ms. In production with 50M keys it blocks the event loop for 18 seconds. Every other service using that Redis instance now has its p99 latency spike to 18 seconds. The user's deletion request succeeded. Every payment in flight during those 18 seconds failed. The correct reflex: any operation that takes O(N) over the keyspace must use SCAN with a COUNT hint, not KEYS. There are no exceptions. FAANG teams enforce this with a lint rule that rejects any use of `Keys(` outside test files.

First-job context for mistake 4 (lock without owner). Distributed locks are one of the three most common causes of production incidents with Redis. The other two are cache stampedes and bigkeys. When a lock leaks (released by the wrong owner) the symptom is usually duplicate side effects: double emails, double charges, two workers processing the same job. If you are debugging a duplicate-work bug and you are using a simple DEL to release the lock, that is your root cause. The Lua script version is the only correct implementation and it must be the default in your shared library.

Interview entry-point. An L3 or L4 interviewer asks "how would you implement a distributed lock in Redis." The junior answer describes SET with NX and EX. The mid-level answer adds the Lua release script. The senior answer volunteers that Redlock is contested (Martin Kleppmann versus Salvatore Sanfilippo debate from 2016, still unresolved) and that for strict correctness a consensus system like etcd or ZooKeeper is preferred over any Redis-only design. Knowing that the Redis community has a well-documented disagreement about this feature is how you move from "I can code it" to "I understand its failure modes."

Why did this fail reflex for mistake 5 (no TTL). When Redis OOMs and starts rejecting writes, the first thing to check is the TTL distribution. Run `redis-cli --scan --pattern '*' | head -1000` and for each key run `TTL <key>`. If more than 5 percent of keys return -1 (no TTL) in a cache workload, that is your leak. The fix is not just to add TTL to new writes. It is to run a one-time SCAN-and-EXPIRE job to backfill TTL on existing keys, ordered by last access time.

### Senior at FAANG: Mistakes as Governance Policy, Not Reminders

At staff and principal level, the mistakes above stop being things you remember to avoid. They become policies enforced by tooling, reviewed in ADRs, and tracked in on-call rotations. A mistake that can be prevented by a human is a mistake that will happen. A mistake that is prevented by tooling is a mistake that cannot happen.

Forbidden commands policy. Every production Redis deployment at staff-level maturity enforces a forbidden command list via the `rename-command` directive in redis.conf. The canonical list: KEYS, FLUSHALL, FLUSHDB, DEBUG, CONFIG (write), SHUTDOWN, SAVE (blocking form), BGREWRITEAOF (rate-limited). Renaming them to a random string prevents accidental invocation from operator tooling and from library regressions. The ADR that governs this includes an exception process: a senior SRE may unlock a specific command for a limited window via a config-server override, with the window auto-expiring.

ACL policy (Redis 6 plus, and Valkey 8). Every application connects with its own ACL user, scoped to a key prefix glob and a command category allowlist. The default user is disabled in production. Sample ACL for a session service: `user session on >hashed-pw ~session:* +@read +@write +@connection -@dangerous`. This prevents a compromised application credential from running FLUSHDB or SCAN-ing keys outside its namespace. Any application requesting `+@all` or `~*` fails the security review. Every ACL change is an ADR.

Slowlog monitoring policy. Slowlog threshold is set to 10 ms on production instances. Every entry above 10 ms is pulled into a log aggregator with the offending command, key hash, and client IP. A query appearing more than three times in a 5-minute window triggers a page. The pattern that slowlog catches earliest is Lua scripts that accidentally iterate over a key that has grown larger than expected (bigkey in disguise). The on-call is expected to quote the slowlog entry in the triage channel within 5 minutes of the page.

Mistake taxonomy ADR. Mistakes map to governance layers:
- Layer 1 (library defaults): connection error handling, TTL required parameter, pipeline auto-batching above N operations. Fixed by the shared Go client wrapper.
- Layer 2 (CI lint rules): ban of KEYS, FLUSHALL, direct use of `redis.Client` outside the wrapper, unbounded MGET, cross-slot multi-key calls. Fixed by `go vet` custom analyzers.
- Layer 3 (runtime policy): rename-command, ACLs, maxmemory-policy per workload, slowlog threshold, bigkey scanner cron. Fixed by redis.conf and ops automation.
- Layer 4 (review gates): any new Lua script, any change to maxmemory-policy, any cluster migration, any cross-region deployment. Fixed by bar-raiser sign-off.

A mistake that keeps recurring in post-mortems is a mistake that has not yet been pushed down the layers. The staff engineer's job is to watch incident reports and decide which layer should have caught the bug. If the same mistake happens in two post-mortems in a quarter, it is automatically promoted to the next layer down.

Distributed lock policy in detail. No service may implement its own lock. The shared locker library provides `Acquire(ctx, key, ownerID, ttl) (Lock, error)` and `Lock.Release(ctx)` with the Lua-script-based owner check. Fencing tokens are returned alongside the lock so downstream stores can reject stale lock holders. Redlock is forbidden. For strong correctness requirements, the ADR mandates etcd rather than Redis. For best-effort coordination (idempotency windows, single-flight cache fills) the Redis locker is approved.

TTL governance. Every write to Redis that is not in the noeviction set must carry an explicit TTL. The library wrapper refuses writes with TTL of zero unless the caller passes a `Persistent()` option that is lint-restricted to a known allowlist of durable workloads (idempotency keys, rate limiter counters, RedLock-ish coordination). The TTL distribution is monitored with a Grafana panel showing the histogram of TTL at write time per service. Any service whose TTL histogram shifts toward infinity by more than 10 percent week over week is flagged for review.

Cache stampede policy. After the classic synchronized-TTL stampede failure mode (a batch job writes a million keys with an identical TTL and they all expire in the same second), the standard is: every cache fill adds plus or minus 10 percent jitter to the declared TTL. Every cache miss that would trigger a backend call uses single-flight coordination (one miss per key per process acquires a soft lock, other callers wait on the shared result). This is not a recommendation. It is the default implementation in the shared cache client. Services opting out document the reason in an ADR.

Bar-raiser questions you will hear about mistakes. "Show me the last production incident where KEYS was used and walk me through the post-mortem." "How does your ACL policy prevent a leaked application credential from deleting your session store." "What is your policy for Lua scripts and how do you bound their execution time." "Describe the difference between a hotkey and a bigkey, and the runbooks you have for each." "Your cache hit rate dropped from 95 percent to 70 percent in 10 minutes. What is the debug sequence." Senior candidates answer these with specific commands, specific thresholds, and specific ADR references, not hand-wavy best practices.

---
