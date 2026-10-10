## 35.8 Pipelining and Transactions

### Pipelining

By default, every Redis command incurs a full network round-trip: the client sends a request, waits for the server's response, then sends the next request. Pipelining batches multiple commands into a single write to Redis and reads all responses at once, reducing latency proportional to the number of commands. This matters when issuing dozens of operations in a hot path. The go-redis `Pipeline()` type queues commands locally and flushes them together on `Exec`, while individual command results remain accessible through their returned `*Cmd` handles after execution.

```go
func pipelineExample(ctx context.Context, rdb *redis.Client) error {
    pipe := rdb.Pipeline()

    // Queue commands
    incr := pipe.Incr(ctx, "counter")
    get := pipe.Get(ctx, "key")
    pipe.Set(ctx, "newkey", "newvalue", 0)

    // Execute all
    _, err := pipe.Exec(ctx)
    if err != nil {
        return err
    }

    // Get results
    counterVal := incr.Val()
    keyVal, _ := get.Result()

    fmt.Printf("Counter: %d, Key: %s\n", counterVal, keyVal)
    return nil
}
```

### Transactions (MULTI/EXEC)

Redis transactions via `MULTI/EXEC` guarantee that a queued set of commands executes atomically, so no other client can interleave commands between them. The challenge in concurrent systems is that the value you read before opening the transaction may have changed by the time you write. `WATCH` solves this by aborting the transaction if any watched key is modified by another client between the `WATCH` call and `EXEC`. In go-redis, `Watch` combines optimistic locking with a retry loop pattern: if the transaction fails due to a concurrent write, the function returns `redis.TxFailedErr` and the caller can retry.

**Atomicity is not isolation.** Redis `MULTI/EXEC` guarantees that commands run as a single uninterrupted block, but unlike a SQL transaction there is no rollback: if a command fails with a runtime error (e.g., `INCR` on a string value), earlier queued commands still take effect. Treat `MULTI/EXEC` as "ordered batch with no interleavers", not as a SQL-style ACID transaction. For read-modify-write that needs rollback semantics, prefer a Lua script or a Redis Function.

**Lua scripts vs Redis Functions.** `EVAL`/`EVALSHA` runs ad-hoc Lua scripts that Redis loads into its script cache on first use. In Redis 7.0+ (and Valkey 7.2+), **Redis Functions** replace the ad-hoc script model for admin-managed code: functions are loaded with `FUNCTION LOAD`, persisted in the RDB/AOF, replicated to replicas, and invoked by name with `FCALL`. For application-level atomic operations (token bucket, counters) `EVAL` is still the norm because it co-locates the script with the Go code that runs it. For operator-defined server-side logic that should live with the data rather than the application, Functions are the newer, replication-safe primitive.

```go
func transactionExample(ctx context.Context, rdb *redis.Client) error {
    // Watch key for changes
    err := rdb.Watch(ctx, func(tx *redis.Tx) error {
        // Get current value
        val, err := tx.Get(ctx, "key").Int()
        if err != nil && err != redis.Nil {
            return err
        }

        // Only proceed if value is what we expect
        if val != 10 {
            return errors.New("value changed")
        }

        // Execute transaction
        _, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
            pipe.Set(ctx, "key", val+1, 0)
            pipe.Set(ctx, "other_key", "value", 0)
            return nil
        })
        return err
    }, "key")

    return err
}
```

### Junior to FAANG: why pipelining matters and how to think about MULTI

The core fact is latency dominance. A Redis command is a few microseconds on the server, but a round trip across a VPC is 300 microseconds to 2 milliseconds. If you run 100 sequential `GET` calls you pay 100 round trips. Pipeline them and you pay one round trip plus the server work. Your latency drops 50x. This is not an optimization you apply after profiling, it is the default way to do bulk work in Redis. Any time you are about to write a `for` loop that calls Redis, ask whether you can pipeline.

Worked example. You load a user profile and it requires five lookups: the user hash, the follower count, the following count, the notification count, the feature flag set. Without pipelining: 5 round trips, say 5 ms. With pipelining: 1 round trip, 1 ms. At 10k requests per second this is 40 ms of saved blocking time per user, visible in your p99.

Two things that confuse juniors. First, pipelining is not a transaction. The commands in a pipeline can be interleaved with commands from other clients. If you `INCR` and then `GET` in the same pipeline, another client can modify the value between them. Second, `MULTI/EXEC` is not a SQL transaction. There is no rollback. A runtime error in command 3 does not undo commands 1 and 2. The guarantee is "no other client interleaves" not "all or none."

Interview entry point. "You have 1000 user IDs and need their follower counts." Wrong: loop and call `HGET` 1000 times. Right: one pipeline with 1000 `HGET` calls. Better: use `MGET` or a single Lua script if the keys share a pattern. Even better if in cluster mode: group keys by slot using hash tags and pipeline per slot, because cross-slot pipelines are rejected. Naming the cluster caveat separates candidates who have run Redis from candidates who have only read about it.

### Senior at FAANG: cost model, optimistic concurrency, Lua versus Functions

Cost model. A pipeline is almost free on the Redis side and almost free on the wire (TCP batches anyway). The cost on the client is memory to hold buffered replies. Pipelines of a few thousand commands are routine. Pipelines of a million commands are a memory bomb, flush in chunks of ten thousand. On a cluster, go-redis `ClusterPipeline` splits your commands by slot and runs one pipeline per node, the user experience looks like one pipeline. You still cannot issue a single atomic `MULTI/EXEC` across slots because each `MULTI/EXEC` runs on one node.

`WATCH` and optimistic concurrency. The pattern is read, compute, compare-and-swap. `WATCH key` marks the key, subsequent reads see the current value, `MULTI` enters queue mode, `EXEC` fails with nil if any watched key changed since `WATCH`. The go-redis `Watch` helper wraps the retry loop. Three rules. One: keep the critical section short, the longer you hold `WATCH` the more likely a conflict. Two: the retry count must be bounded, under contention the loop can spin forever. Three: if you find yourself watching many keys, you are simulating a transactional database and you should reach for one. Postgres is cheaper than fighting `WATCH` at scale.

Lua versus MULTI/EXEC. Lua is the better primitive for anything more complex than "run N commands atomically with no branching." Lua gives you conditionals, loops, and return values. MULTI/EXEC gives you a static ordered batch. Prefer Lua. The one remaining use for MULTI/EXEC is when you need `WATCH` semantics, Lua has no `WATCH` equivalent (scripts are atomic by being single-threaded, they do not need optimistic concurrency). If you do not need `WATCH`, use a script.

`EVAL` versus `EVALSHA`. `EVAL` ships the script text on every call. `EVALSHA` refers to the script by its SHA-1 after a prior `SCRIPT LOAD`. In production call `EVALSHA` first and fall back to `EVAL` on `NOSCRIPT` error (the script was evicted or the server restarted). go-redis `NewScript` encapsulates this pattern. The savings are real: on a busy service with a 1 KB script, `EVALSHA` saves 1 KB of bandwidth per call.

Redis Functions (7.0+). Functions are loaded once with `FUNCTION LOAD` and persist in RDB and AOF, replicate to replicas, survive restarts, and are invoked by name with `FCALL` or `FCALL_RO`. They solve the "every new client re-loads the same script" problem and make server-side logic administerable like schema. The debate in 2026 is whether to migrate application Lua to Functions. My take: Functions are right when the logic is owned by the data platform team (a `fcall user_login ...` that every service calls), Lua scripts are right when the logic is owned by the service that calls them (a token bucket that lives with its one caller). Owning a Function is like owning a stored procedure, you need schema governance, migration tooling, and a deploy story. Do not move to Functions unless you have that infrastructure.

Script atomicity and cluster. A script is atomic within its slot. All keys the script touches must hash to the same slot or the cluster rejects the call. Use hash tags (`{user:42}:profile`, `{user:42}:feed`) to co-locate keys you will script over. Plan this at schema time, retrofitting hash tags into a running cluster is painful.

Blocking inside scripts. Lua scripts block the whole server. A script that takes 50 ms starves every other client for 50 ms. The rule is hundreds of microseconds at most. Long loops, large `SORT`, or `KEYS` inside a script are bugs waiting to page you. Enforce in code review: reject scripts with unbounded iteration or O(N) collection operations.

Pipelining with transactions inside. `TxPipeline` wraps the pipeline in `MULTI/EXEC`. All commands run atomically, no interleavers, single ack. Useful when you have a small static batch that must be atomic. Beyond that, move to Lua.

Staff ADR. The ADR for a new server-side script states: (1) why the logic must run server-side (atomicity, round trip reduction, data locality), (2) the complexity bound (microseconds, bounded iteration), (3) key co-location plan for cluster, (4) Lua versus Function decision with owning team, (5) the test plan (scripts are code, they need unit tests that load them into a real Redis), (6) the deploy plan for Functions, the cache-warm plan for Lua `EVALSHA`. Reviewers block on (5) most often. Unit-tested scripts are the minimum bar at a staff level.

---
