## 35.2 Basic Operations

### Strings

Redis strings are the simplest data type: each key maps to a single binary-safe value up to 512 MB. Despite the name, strings store anything - text, serialized JSON, integers, or raw bytes. The `Set`/`Get` pair handles basic storage, while `SetNX` (set-if-not-exists) is the building block for distributed locks. Atomic `Incr` and `Decr` operations make strings ideal for counters without any race condition concerns. The `MSet`/`MGet` commands batch multiple key operations into a single round trip.

```go
func stringOperations(ctx context.Context, rdb *redis.Client) {
    // Set
    err := rdb.Set(ctx, "key", "value", 0).Err()

    // Set with expiration
    err = rdb.Set(ctx, "key", "value", time.Hour).Err()

    // SetEX (set with expiration in seconds)
    err = rdb.SetEx(ctx, "key", "value", time.Hour).Err()

    // SetNX (set if not exists)
    set, err := rdb.SetNX(ctx, "key", "value", time.Hour).Result()
    // set is true if key was set

    // Get
    val, err := rdb.Get(ctx, "key").Result()
    if err == redis.Nil {
        fmt.Println("Key does not exist")
    }

    // GetDel (get and delete key)
    oldVal, err := rdb.GetDel(ctx, "key").Result()

    // Increment
    newVal, err := rdb.Incr(ctx, "counter").Result()
    newVal, err = rdb.IncrBy(ctx, "counter", 10).Result()
    floatVal, err := rdb.IncrByFloat(ctx, "float_counter", 1.5).Result()

    // Decrement
    newVal, err = rdb.Decr(ctx, "counter").Result()

    // Append
    length, err := rdb.Append(ctx, "key", " appended").Result()

    // Multiple operations
    err = rdb.MSet(ctx, "key1", "value1", "key2", "value2").Err()
    vals, err := rdb.MGet(ctx, "key1", "key2", "key3").Result()
}
```

### Hashes

Redis hashes store field-value pairs under a single key, making them a natural fit for representing objects like user profiles or configuration records. Unlike serializing an entire JSON blob into a string key, hashes let you read or update individual fields without fetching the whole object. `HSet` accepts variadic field-value pairs or a `map[string]any`, while `HGetAll` retrieves every field at once. The `go-redis` library can scan hash results directly into Go structs using `redis` struct tags, as shown in the `getUserFromHash` example below.

```go
func hashOperations(ctx context.Context, rdb *redis.Client) {
    // Set field
    err := rdb.HSet(ctx, "user:1", "name", "Alice").Err()

    // Set multiple fields
    err = rdb.HSet(ctx, "user:1",
        "name", "Alice",
        "email", "alice@example.com",
        "age", 30,
    ).Err()

    // Or using a map
    err = rdb.HSet(ctx, "user:1", map[string]any{
        "name":  "Alice",
        "email": "alice@example.com",
        "age":   30,
    }).Err()

    // Get field
    name, err := rdb.HGet(ctx, "user:1", "name").Result()

    // Get multiple fields
    vals, err := rdb.HMGet(ctx, "user:1", "name", "email").Result()

    // Get all fields
    all, err := rdb.HGetAll(ctx, "user:1").Result()
    // Returns map[string]string

    // Check if field exists
    exists, err := rdb.HExists(ctx, "user:1", "name").Result()

    // Delete fields
    deleted, err := rdb.HDel(ctx, "user:1", "email").Result()

    // Increment field
    newAge, err := rdb.HIncrBy(ctx, "user:1", "age", 1).Result()

    // Get all keys
    keys, err := rdb.HKeys(ctx, "user:1").Result()

    // Get all values
    values, err := rdb.HVals(ctx, "user:1").Result()

    // Set if not exists
    set, err := rdb.HSetNX(ctx, "user:1", "name", "Bob").Result()
}

// Scan hash into struct
type User struct {
    Name  string `redis:"name"`
    Email string `redis:"email"`
    Age   int    `redis:"age"`
}

func getUserFromHash(ctx context.Context, rdb *redis.Client, id string) (*User, error) {
    var user User
    err := rdb.HGetAll(ctx, "user:"+id).Scan(&user)
    if err != nil {
        return nil, err
    }
    return &user, nil
}
```

### Lists

Redis lists are doubly-linked lists of strings, supporting O(1) push and pop operations at both ends. `LPush`/`RPush` add elements to the head or tail, while `LPop`/`RPop` remove them. `BLPop` blocks until an element is available or the timeout expires, which makes lists a simple message queue without any external broker. `LTrim` caps the list to a fixed size - useful for keeping the most recent N items like activity feeds or log entries. `LMove` atomically transfers elements between lists, replacing the deprecated `RPopLPush`.

```go
func listOperations(ctx context.Context, rdb *redis.Client) {
    // Push to left (head)
    length, err := rdb.LPush(ctx, "mylist", "a", "b", "c").Result()

    // Push to right (tail)
    length, err = rdb.RPush(ctx, "mylist", "x", "y", "z").Result()

    // Pop from left
    val, err := rdb.LPop(ctx, "mylist").Result()

    // Pop from right
    val, err = rdb.RPop(ctx, "mylist").Result()

    // Blocking pop (wait for element)
    vals, err := rdb.BLPop(ctx, 5*time.Second, "mylist").Result()
    // Returns [key, value] or error on timeout

    // Get range (0 to -1 = all)
    all, err := rdb.LRange(ctx, "mylist", 0, -1).Result()

    // Get by index
    val, err = rdb.LIndex(ctx, "mylist", 0).Result()

    // Get length
    length, err = rdb.LLen(ctx, "mylist").Result()

    // Trim list
    err = rdb.LTrim(ctx, "mylist", 0, 99).Err() // Keep first 100

    // Remove elements
    removed, err := rdb.LRem(ctx, "mylist", 2, "value").Result()
    // Removes 2 occurrences of "value"

    // Move element between lists (LMove replaces deprecated RPopLPush since Redis 6.2)
    val, err = rdb.LMove(ctx, "source", "dest", "RIGHT", "LEFT").Result()
}
```

### Sets

Redis sets are unordered collections of unique strings. Adding a duplicate member is a no-op, which makes sets useful for tracking unique visitors, tags, or permissions without worrying about deduplication logic in application code. Set algebra operations - `SUnion`, `SInter`, and `SDiff` - run server-side and return the result in one round trip, enabling patterns like "find mutual friends" or "compute users who visited page A but not page B."

```go
func setOperations(ctx context.Context, rdb *redis.Client) {
    // Add members
    added, err := rdb.SAdd(ctx, "myset", "a", "b", "c").Result()

    // Check membership
    isMember, err := rdb.SIsMember(ctx, "myset", "a").Result()

    // Get all members
    members, err := rdb.SMembers(ctx, "myset").Result()

    // Get random members
    member, err := rdb.SRandMember(ctx, "myset").Result()
    members, err = rdb.SRandMemberN(ctx, "myset", 3).Result()

    // Remove members
    removed, err := rdb.SRem(ctx, "myset", "a").Result()

    // Pop random member
    member, err = rdb.SPop(ctx, "myset").Result()

    // Set size
    size, err := rdb.SCard(ctx, "myset").Result()

    // Set operations
    union, err := rdb.SUnion(ctx, "set1", "set2").Result()
    inter, err := rdb.SInter(ctx, "set1", "set2").Result()
    diff, err := rdb.SDiff(ctx, "set1", "set2").Result()

    // Store results
    rdb.SUnionStore(ctx, "destset", "set1", "set2")
}
```

### Sorted Sets

Sorted sets combine set uniqueness with a floating-point score attached to each member. Redis keeps members ordered by score, so rank lookups and range queries run in O(log N) time. This makes sorted sets the standard data structure for leaderboards, priority queues, and time-series indexes where you need both ordering and fast rank lookups. `ZAdd` inserts or updates scores, `ZRank`/`ZRevRank` return position, and `ZRangeByScore` retrieves members within a score window. `ZIncrBy` atomically adjusts scores, which is useful for real-time scoring systems.

```go
func sortedSetOperations(ctx context.Context, rdb *redis.Client) {
    // Add members with scores
    added, err := rdb.ZAdd(ctx, "leaderboard",
        redis.Z{Score: 100, Member: "alice"},
        redis.Z{Score: 200, Member: "bob"},
        redis.Z{Score: 150, Member: "charlie"},
    ).Result()

    // Get rank (0-based, ascending)
    rank, err := rdb.ZRank(ctx, "leaderboard", "alice").Result()

    // Get reverse rank (descending)
    rank, err = rdb.ZRevRank(ctx, "leaderboard", "alice").Result()

    // Get score
    score, err := rdb.ZScore(ctx, "leaderboard", "alice").Result()

    // Increment score
    newScore, err := rdb.ZIncrBy(ctx, "leaderboard", 10, "alice").Result()

    // Get range by rank (ascending)
    members, err := rdb.ZRange(ctx, "leaderboard", 0, 9).Result()

    // Get range by rank (descending)
    members, err = rdb.ZRevRange(ctx, "leaderboard", 0, 9).Result()

    // Get range with scores
    results, err := rdb.ZRangeWithScores(ctx, "leaderboard", 0, 9).Result()
    for _, z := range results {
        fmt.Printf("%s: %f\n", z.Member, z.Score)
    }

    // Get range by score
    members, err = rdb.ZRangeByScore(ctx, "leaderboard", &redis.ZRangeBy{
        Min: "100",
        Max: "200",
    }).Result()

    // Count in score range
    count, err := rdb.ZCount(ctx, "leaderboard", "100", "200").Result()

    // Remove members
    removed, err := rdb.ZRem(ctx, "leaderboard", "alice").Result()

    // Remove by rank range
    removed, err = rdb.ZRemRangeByRank(ctx, "leaderboard", 0, 4).Result()

    // Remove by score range
    removed, err = rdb.ZRemRangeByScore(ctx, "leaderboard", "-inf", "100").Result()
}
```

### Junior → FAANG: the basic-operations traps that fail code review

Every snippet above compiles and works. Most of them are still wrong in ways that a senior reviewer will catch in thirty seconds.

**Strings: the GET-then-SET race.** The most common junior mistake is treating `GET` and `SET` as a read-modify-write sequence. It is not atomic. If two goroutines or two pods read a counter at the same time and write it back incremented, one increment is lost. The correct pattern is `INCR`, not `GET+SET`. If the mutation is more complex, use `WATCH`/`MULTI`/`EXEC` for optimistic locking, or write a Lua script with `EVAL` for true atomicity. Interviewers ask this because the GET-then-SET bug ships to production constantly.

**Strings: the unbounded value.** `Set(ctx, "key", huge, 0)` with a 100 MB value blocks the Redis event loop for the duration of the write and the TCP transfer. Redis processes commands serially on a single thread. One slow command stalls everyone. Cap string sizes in application code (often at 1 MB) and reject anything larger with an error that names the offending key. "Redis got slow today" is almost always a bigkey story.

**Strings: the missing TTL.** `Set(ctx, "session:"+id, blob, 0)` stores a session forever. The user logs out, the session is gone logically but not physically, Redis fills up, and eventually the eviction policy starts throwing out other keys. Every string that represents a cache, a session, a rate-limit bucket, or anything else short-lived must have a TTL. `0` means no expiration and should be rare.

**Hashes: HGETALL on a 10K-field hash.** `HGETALL` returns every field in one reply. For a hash with thousands of fields this allocates a huge map on the Go side and blocks the Redis thread. Use `HSCAN` for large hashes, or restructure the data so each logical record has its own key. Redis 7.4 also added per-field TTL (`HEXPIRE`, `HPERSIST`), which lets you expire individual fields of a hash instead of maintaining a separate key per field, finally solving the session-fields problem that has existed since Redis 2.0.

**Lists: the queue that loses messages.** `LPUSH + BRPOP` looks like a queue but it has no ack semantics. If a consumer pops a message and crashes before finishing the work, the message is gone. Use a reliable queue pattern: `LMOVE source processing` to atomically move the message to a processing list, do the work, then `LREM processing` on success, and run a reaper that returns stuck messages from `processing` back to `source`. Or use Streams with consumer groups, which give you ack and pending-entry recovery built in.

**Sets: the SINTER that crosses slots.** In Redis Cluster, `SINTER set1 set2` fails with CROSSSLOT unless `set1` and `set2` hash to the same slot. Use hash tags (`{group}:set1`, `{group}:set2`) to co-locate them when the operation is required server-side. If the sets naturally live on different shards, compute the intersection client-side with two `SMEMBERS` calls and a Go loop, and accept the round-trip cost.

**Sorted sets: the leaderboard that grows without bound.** `ZADD leaderboard score user` is O(log N) but the set keeps every user ever scored. Cap it with `ZREMRANGEBYRANK leaderboard 0 -10001` to keep the top 10000, run periodically. For time-windowed leaderboards use one sorted set per window (`leaderboard:2026-04-22`) and delete old windows as whole keys, which is O(1) amortized and friendlier to eviction.

Worked example: a "recent views" list for a user. The junior writes `LPUSH views:42 product_id` and it grows forever. The FAANG answer is `LPUSH views:42 id; LTRIM views:42 0 49; EXPIRE views:42 86400` as a pipelined three-command batch, which keeps the list bounded to 50 items and self-expires after a day of inactivity. Three commands, one round trip, zero unbounded growth.

### Senior @ FAANG: the basic-operations patterns that differentiate a staff PR

Beyond avoiding the traps, staff-level Redis code applies a handful of patterns that show up in every production codebase.

**Pipelining as the default, not the optimization.** Any Go function that issues more than one Redis command in sequence should use `Pipeline()` or `TxPipeline()`. A pipeline is one TCP round trip instead of N. Measured impact: on a warm connection with 1ms RTT, 10 sequential GETs take 10ms. The same 10 GETs pipelined take ~1ms. On Redis Cluster, `rdb.Pipeline()` on the cluster client automatically routes each command to the correct shard and merges replies, but pipelines do not provide atomicity across shards. For atomic multi-key operations use hash tags and `TxPipeline`, or write a Lua script with the keys declared in `KEYS`. rueidis auto-pipelines across goroutines, which largely removes the need for explicit `Pipeline()` calls, but you still write them for clarity at logical batch boundaries.

**Lua scripts for atomicity and round-trip reduction.** When a logical operation requires multiple commands to execute atomically (check-and-set, rate limiter, deduplicated enqueue), write a Lua script. Load it once with `SCRIPT LOAD` and invoke by SHA with `EVALSHA` (go-redis `Script` type caches this for you). Lua runs inside the Redis event loop, so it is atomic with respect to other clients, but it also blocks every other client while running. Keep scripts under a millisecond of wall time, avoid unbounded loops, and avoid `redis.call` loops over large keys. Redis 7.0 added Redis Functions (`FUNCTION LOAD`) which are a registered, named alternative to ad-hoc Lua and survive FLUSHDB. Adopt them for long-lived scripts.

**Hash field TTLs (Redis 7.4, Valkey 9.0).** `HEXPIRE user:42 3600 FIELDS 2 session_token csrf_token` expires two specific fields of a hash after one hour while leaving the rest of the hash intact. Before 7.4 the workaround was one key per field plus a shared hash for stable fields, which doubled your key count and complicated ACLs. The new commands are `HEXPIRE`, `HPEXPIRE`, `HEXPIREAT`, `HPEXPIREAT`, `HTTL`, `HPTTL`, `HPERSIST`. go-redis exposes them as `HExpire`, `HPExpire`, etc. When designing new session or token schemas in 2026, default to hash with field TTLs. It is cheaper memory and cleaner code.

**Scan, never KEYS.** `KEYS pattern` is O(N) over the entire keyspace and blocks the Redis thread. It is banned at every FAANG I have seen. Use `SCAN cursor MATCH pattern COUNT 100` (or `HSCAN`, `SSCAN`, `ZSCAN` for collections) which iterates in small chunks and yields between. go-redis provides `rdb.Scan(ctx, cursor, pattern, count).Iterator()` which wraps the cursor loop. The ACL configuration for every service should explicitly disable `KEYS` to prevent a junior from rediscovering this lesson during an incident.

**Sorted set idioms beyond leaderboards.** Sorted sets with a timestamp score give you a time-ordered index. `ZADD events:user:42 <unix_ts> <event_id>` plus `ZRANGEBYSCORE events:user:42 <now-3600> +inf` gives you "all events in the last hour." This is the foundation of Discord's presence system, Twitter's timeline fanout, and most notification inboxes. `ZADD ... GT` (added in Redis 6.2) only updates the score if the new score is greater, which is the correct semantic for "last-seen" timestamps in presence systems and avoids overwriting with stale data from reordered network packets.

**Stream basics that belong in the chapter but are missing here.** `XADD stream * field value` appends an entry with a server-assigned ID. `XREADGROUP GROUP mygroup consumer1 COUNT 100 BLOCK 5000 STREAMS stream >` reads new entries for a consumer group, blocking up to 5 seconds. `XACK stream mygroup id` acknowledges delivery. `XPENDING` shows unacked entries and `XAUTOCLAIM` (Redis 6.2+) rebalances entries from dead consumers. Streams replace lists for any queue that needs durable, ack-able, multi-consumer semantics. When designing a new queueing workload in 2026, start with Streams, not lists. Lists remain correct for simple in-memory FIFOs where message loss on restart is acceptable.

**The prefix and command budget.** Every team in a mature org is given a key-prefix budget (memory, QPS, p99 latency) and a command budget (which commands are allowed, which require review). Commands that can be expensive get categorized: O(1) commands are free, O(log N) commands are cheap, O(N) commands (SMEMBERS on large sets, LRANGE 0 -1, HGETALL on large hashes, ZRANGE with large ranges) require explicit justification in code review. SLOWLOG is the enforcement mechanism. A prefix with SLOWLOG entries is auto-flagged for owner review. This governance is what keeps a shared Redis tier healthy across hundreds of engineers.

---
