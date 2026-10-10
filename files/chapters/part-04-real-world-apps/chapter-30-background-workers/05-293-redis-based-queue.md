## 30.3 Redis-Based Queue

### Redis Queue

A Redis sorted set provides time-ordered job scheduling without the overhead of a full relational database. The `DelayedQueue` below scores each job by its execution timestamp, then a scheduler goroutine periodically queries for jobs whose score is at or below the current time and moves them to an immediate processing queue. This two-stage design separates scheduling from execution: the sorted set acts as a time-indexed holding area, while the immediate queue feeds workers through `BLPOP`. Visibility timeouts are handled by moving claimed jobs to a separate processing set keyed by claim timestamp, so a monitor goroutine can return stalled jobs back to the main queue.

> **When to use `hibiken/asynq` instead.** The code below is a teaching implementation. In production on Redis, `hibiken/asynq` already gives you priorities, delayed/scheduled jobs, unique jobs, retries with exponential backoff, a dead-letter queue (the "archived" set), and the Asynqmon web UI, all built on the same sorted-set primitives shown here. Roll your own only when you have a specific constraint asynq does not cover (e.g. custom visibility-timeout semantics or an unusual Redis topology).

```go
package queue

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/redis/go-redis/v9"
)

type DelayedQueue struct {
    client *redis.Client
    key    string
}

func NewDelayedQueue(client *redis.Client, key string) *DelayedQueue {
    return &DelayedQueue{
        client: client,
        key:    key,
    }
}

func (q *DelayedQueue) Schedule(ctx context.Context, payload any, executeAt time.Time) error {
    msg := Message{
        ID:      generateID(),
        Created: time.Now(),
    }

    payloadBytes, err := json.Marshal(payload)
    if err != nil {
        return err
    }
    msg.Payload = payloadBytes

    msgBytes, err := json.Marshal(msg)
    if err != nil {
        return err
    }

    return q.client.ZAdd(ctx, q.key, redis.Z{
        Score:  float64(executeAt.Unix()),
        Member: msgBytes,
    }).Err()
}

func (q *DelayedQueue) GetReady(ctx context.Context, limit int64) ([]*Message, error) {
    now := float64(time.Now().Unix())

    // Get messages with score <= now
    results, err := q.client.ZRangeByScore(ctx, q.key, &redis.ZRangeBy{
        Min:   "-inf",
        Max:   fmt.Sprintf("%f", now),
        Count: limit,
    }).Result()

    if err != nil {
        return nil, err
    }

    var messages []*Message
    for _, result := range results {
        var msg Message
        if err := json.Unmarshal([]byte(result), &msg); err != nil {
            continue
        }
        messages = append(messages, &msg)
    }

    return messages, nil
}

func (q *DelayedQueue) Remove(ctx context.Context, msg *Message) error {
    msgBytes, _ := json.Marshal(msg)
    return q.client.ZRem(ctx, q.key, msgBytes).Err()
}

// Scheduler moves ready messages to immediate queue
type Scheduler struct {
    delayed      *DelayedQueue
    immediate    *RedisQueue
    targetQueue  string
    pollInterval time.Duration
    logger       *slog.Logger
}

func (s *Scheduler) Start(ctx context.Context) {
    ticker := time.NewTicker(s.pollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            s.process(ctx)
        }
    }
}

func (s *Scheduler) process(ctx context.Context) {
    messages, err := s.delayed.GetReady(ctx, 100)
    if err != nil {
        s.logger.Error("failed to get ready messages", "error", err)
        return
    }

    for _, msg := range messages {
        // Move to immediate queue
        if err := s.immediate.Enqueue(ctx, s.targetQueue, msg.Payload); err != nil {
            s.logger.Error("failed to enqueue", "error", err)
            continue
        }

        // Remove from delayed queue
        if err := s.delayed.Remove(ctx, msg); err != nil {
            s.logger.Error("failed to remove from delayed", "error", err)
        }
    }
}
```

### Junior to FAANG: the two-step move is not atomic

The code above enqueues to `immediate`, then removes from `delayed`. If the process crashes between the two, the message appears in both. Re-run duplicates the side effect. The fix is one of two patterns.

1. **Lua script for atomic move.** Redis evaluates Lua atomically. A single `EVAL` that pops from the ZSET and pushes to the list is race-free. This is what asynq uses under the hood.

2. **Idempotent receiver.** Accept that moves may duplicate, and deduplicate at the handler layer using an idempotency key (the message ID) stored in a Redis SET with TTL equal to the max processing window.

Pattern 1 is the correct default. Pattern 2 is needed anyway because at-least-once is unavoidable across the network between Redis and the worker.

Other first-job traps.

- **`BLPOP` is durable only if Redis is durable.** Default Redis is in-memory with periodic snapshots. A crash between snapshots loses jobs. Production Redis for queues runs AOF with `appendfsync everysec` at minimum, `always` for correctness-critical work (at large throughput cost). Cluster-mode Redis with replicas is recommended for tier-1 queues.
- **Message size is capped.** Redis values grow slowly and large payloads hurt latency. Store payloads over 64KB in S3 or the DB, and put a reference in the queue.
- **No dead-letter queue in the snippet.** Failed jobs just vanish or loop. Add a separate ZSET or list for failed items with their error message.
- **Visibility timeout is mentioned but not implemented.** The production pattern is a "processing" ZSET keyed by `leased_until` timestamp, and a recovery goroutine that re-queues any entry whose score is in the past.

Walkthrough for a junior. You schedule "send reminder in 24 hours". It lands in the delayed ZSET with score `now + 86400`. The scheduler polls every second, `ZRANGEBYSCORE` returns nothing for 24 hours, then returns your job. The scheduler does the Lua move to the ready list. A worker `BLPOP`s the list, sets a "processing" entry with 5-minute lease, runs the handler, removes the processing entry on success. If the worker crashes mid-handler, the recovery goroutine sees the expired processing entry and re-queues the job.

Interview entry point. "Build delayed jobs in Redis." A candidate who says "ZSET scored by timestamp" is on track. A candidate who explicitly mentions the move-atomicity problem and cites Lua scripts or asynq is a strong signal.

### Senior at FAANG: Redis as a queue has a specific risk profile

Redis-backed queues dominate mid-tier workloads at FAANG (emails, notifications, image processing). They are simple, fast, and have mature OSS (asynq, Sidekiq in Ruby, Bull in Node). But staff engineers know the failure modes.

**Durability story.** Redis AOF with `everysec` loses up to 1 second of writes on crash. `always` fsync is correct but drops throughput by 10x to 50x. Stripe, for correctness-critical queues, does not use Redis. They use Postgres plus Kafka. Netflix uses Redis for ephemeral queues and DynamoDB or Kafka for durable ones. The rule of thumb. If a lost message costs money or causes a customer-visible bug, Redis is the wrong tier.

**Outbox pattern is mandatory.** Because Redis enqueue is not transactional with your DB write, you must use the outbox pattern for any tier-0 or tier-1 work. Insert into `outbox` in the DB transaction, a relay service polls the outbox and publishes to Redis. The relay is the availability floor. At Uber, the outbox relay is a dedicated high-availability service with its own SLO.

**Operational surface.** Redis OOMs are catastrophic. A queue backup during downstream outage can consume all memory and either `maxmemory-policy` evicts jobs (data loss) or the Redis instance stops accepting writes (producer failure). Tuning:

- `maxmemory-policy noeviction` for queues, never `allkeys-lru`.
- Monitor `used_memory` and alert on 70%.
- Monitor queue ZSET cardinality per job_type for anomalies.
- Have a "shed-load" runbook that drops tier-2 job_types first.

**Redis Cluster trade-offs.** Cluster-mode shards keys across nodes. If your queue logic touches multiple keys (e.g. ZSET for delayed plus LIST for ready plus HASH for processing), all those keys must hash to the same slot (use `{tag}` in key names). Without slot colocation, Lua scripts fail with CROSSSLOT. This is the most common migration bug when moving from single Redis to cluster.

**Redlock controversy applies.** If you use Redis-based distributed locks for exactly-once scheduling (e.g. "only one worker processes the cron tick"), you are in the middle of the Kleppmann versus Antirez debate. Kleppmann argues Redlock is not safe under partial failures and clock skew. Antirez argues it is safe under reasonable assumptions. For FAANG-scale correctness-critical work, use etcd, ZooKeeper, or Google Spanner locks instead. Use Redis locks only for opportunistic deduplication where the handler is idempotent.

**Fair scheduling is not native.** Redis queues are FIFO or sorted-set. Multi-tenant fairness requires a two-level structure. Per-tenant queues plus a global dispatcher that picks a tenant round-robin. This cannot be built with Redis primitives alone without pathological latency. At Uber's marketplace, tenant fairness is implemented in a Go dispatcher that sits in front of Redis, not inside Redis.

**Migration off Redis.** When you outgrow Redis (typically around 100k jobs per second per queue, or when durability becomes a hard requirement), the migration is painful. Patterns:

- Dual-write from producers to old and new queue. Consumers read from new, with a reconciler that verifies no job is missing.
- Pause old, drain old, cutover. Requires downtime window.
- Blue-green. Spin up new queue, direct new producers to new, keep old consumers running for tail jobs.

Staff engineers write the migration ADR six months before they need it.

**Observability contract.** Redis queue dashboards at FAANG typically have. Queue depth per priority, oldest-message-age, scheduler move rate, processing ZSET size (recovery lag), lease recovery rate, `INFO replication` lag, `INFO memory` used, eviction rate (must be zero for queues), and command latency P99. Without the eviction zero-check, you lose jobs silently during memory pressure.

**asynq versus river versus hand-rolled.** When a staff engineer picks asynq, the justification is. (1) Redis is already operated at the company. (2) Durability is soft (can tolerate up to 1s loss). (3) Throughput is under 50k per Redis shard. (4) Team wants Asynqmon UI and priorities out of the box. When they pick river, the justification is. (1) Postgres is already operated. (2) Transactional enqueue required. (3) No appetite for outbox. (4) Throughput under 10k per Postgres shard. When they roll their own, the justification is usually a custom requirement (region-pinned execution, tenant isolation, custom fairness) that neither library supports.

---
