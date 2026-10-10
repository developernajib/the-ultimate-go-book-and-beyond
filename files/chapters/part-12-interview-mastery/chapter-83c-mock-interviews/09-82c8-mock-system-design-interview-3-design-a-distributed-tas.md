## 83C.8 Mock System Design Interview 3: Design a Distributed Task Queue (L6/Staff)

### Interviewer Briefing

**Company style:** Infrastructure/platform team interview. This is a Staff-level question that tests deep distributed systems knowledge. The candidate must navigate consistency vs. availability trade-offs, exactly-once processing semantics, and failure recovery. This is not about drawing boxes - it's about understanding the hard problems and making principled decisions.

**Level:** L6 (Staff Engineer) / Principal Engineer

**Interview duration:** 45 minutes

### Full Interview Simulation

**Minutes 0-5: Problem Statement & Scoping**

*Interviewer says:* "Design a distributed task queue - something like Celery, Sidekiq, or Amazon SQS."

*What great candidates say:*

"A distributed task queue is a system where producers submit tasks and consumers process them asynchronously. Let me define the core semantics I'll target:

1. **At-least-once delivery** - every task is processed at least once (I'll discuss exactly-once as an extension)
2. **Ordering** - FIFO within a single queue, but no ordering guarantees across queues
3. **Visibility timeout** - when a consumer takes a task, it becomes invisible to other consumers for a configurable period. If the consumer doesn't ACK within that time, the task becomes visible again.
4. **Dead letter queue** - tasks that fail repeatedly are moved to a DLQ for investigation
5. **Delay queues** - tasks can be scheduled for future execution
6. **Multiple queues with priority** - different queues for different priorities

Scale target: 100,000 tasks enqueued per second, 100,000 tasks dequeued per second, 1 billion tasks per day, median task size 1KB, maximum 256KB."

**Minutes 5-10: API Design**

```go
package queue

import (
    "context"
    "time"
)

// Producer API
type TaskQueue interface {
    // Enqueue adds a task to the specified queue.
    // Returns a unique task ID.
    Enqueue(ctx context.Context, queue string, task *Task) (string, error)

    // EnqueueDelayed adds a task that becomes visible after the delay.
    EnqueueDelayed(ctx context.Context, queue string, task *Task, delay time.Duration) (string, error)
}

// Consumer API
type TaskConsumer interface {
    // Receive retrieves up to maxMessages tasks from the queue.
    // Tasks become invisible for visibilityTimeout duration.
    Receive(ctx context.Context, queue string, maxMessages int, visibilityTimeout time.Duration) ([]*Task, error)

    // Ack acknowledges successful processing. The task is deleted.
    Ack(ctx context.Context, taskID string) error

    // Nack signals processing failure. The task becomes visible immediately
    // (or is moved to DLQ if max retries exceeded).
    Nack(ctx context.Context, taskID string) error

    // ExtendVisibility extends the visibility timeout for a task
    // currently being processed.
    ExtendVisibility(ctx context.Context, taskID string, extension time.Duration) error
}

type Task struct {
    ID          string
    Queue       string
    Payload     []byte
    Priority    int
    MaxRetries  int
    RetryCount  int
    CreatedAt   time.Time
    VisibleAt   time.Time // For delayed tasks
}
```

**Minutes 10-25: Architecture**

```
┌────────────────────────────────────────────────────────────────────┐
│                DISTRIBUTED TASK QUEUE ARCHITECTURE                 │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Producers ──→ [API Gateway / Load Balancer]                       │
│                         ↓                                          │
│                [Queue Service (Stateless)]                         │
│                    ↓            ↓                                  │
│            [Metadata DB]   [Task Storage]                          │
│            (PostgreSQL)    (Partitioned Log)                       │
│                                 ↓                                  │
│                [Dispatcher / Scheduler]                            │
│                    ↓            ↓                                  │
│             [Consumer A]  [Consumer B]  ...                        │
│                                                                    │
│  Supporting services:                                              │
│  ├── Visibility Timer Service (manages timeout expiry)             │
│  ├── DLQ Manager (routes failed tasks)                             │
│  └── Delay Scheduler (surfaces delayed tasks when due)             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

*What great candidates say:*

"Let me walk through the key architectural decisions:

**Storage layer - Partitioned Log vs. Traditional Queue:**

I'll use a partitioned, append-only log (similar to Kafka's design) as the primary storage. Each queue maps to a topic, partitioned by a hash of the task ID. This gives us:
- High write throughput (append-only)
- Durability (replicated across nodes)
- Natural ordering within a partition
- Ability to replay (useful for debugging)

However, unlike Kafka where consumers track their own offset, we need visibility timeout semantics. So we add a metadata layer.

**Metadata layer - Task State Machine:**

Each task transitions through states:

```
PENDING → INVISIBLE → ACKED (deleted)
    ↓         ↓
    └─────→ VISIBLE (retry)
              ↓
           DLQ (max retries exceeded)
```

The metadata layer (PostgreSQL with partitioning by queue) tracks:
- Task state
- Visibility timeout expiry
- Retry count
- Assigned consumer

**Visibility timeout implementation:**

When a consumer calls `Receive`, the queue service:
1. Queries for tasks where `state = PENDING` and `visible_at <= NOW()`
2. Atomically updates them to `state = INVISIBLE` and sets `invisible_until = NOW() + timeout`
3. Returns the tasks to the consumer

A background **Visibility Timer Service** scans for tasks where `invisible_until < NOW()` and `state = INVISIBLE`, and transitions them back to `PENDING`. This handles consumer crashes.

The critical concern here is **double-delivery during the visibility scan**. If the timer service and a consumer both operate on the same task simultaneously, we could deliver it twice. I handle this with optimistic concurrency - each state transition includes a version check:

```go
package queue

import (
    "context"
    "database/sql"
    "time"
)

var pq struct {
    Array func(any) any
}

type Task struct {
    ID      string
    Payload []byte
}

type QueueService struct {
    db *sql.DB
}

func (qs *QueueService) Receive(ctx context.Context, queue string, maxMessages int, timeout time.Duration) ([]*Task, error) {
    tx, err := qs.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    rows, err := tx.QueryContext(ctx, `
        SELECT id, payload, version FROM tasks
        WHERE queue = $1 AND state = 'PENDING' AND visible_at <= NOW()
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
        queue, maxMessages)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var tasks []*Task
    var ids []string
    for rows.Next() {
        var t Task
        var version int
        rows.Scan(&t.ID, &t.Payload, &version)
        tasks = append(tasks, &t)
        ids = append(ids, t.ID)
    }

    if len(ids) == 0 {
        return nil, nil
    }

    _, err = tx.ExecContext(ctx, `
        UPDATE tasks SET
            state = 'INVISIBLE',
            invisible_until = NOW() + $1::interval,
            version = version + 1
        WHERE id = ANY($2)`,
        timeout.String(), pq.Array(ids))
    if err != nil {
        return nil, err
    }

    return tasks, tx.Commit()
}
```

The `FOR UPDATE SKIP LOCKED` is crucial - it prevents multiple consumers from receiving the same task and avoids blocking on locked rows."

**Minutes 25-35: Deep Dive - Consistency, Availability Trade-offs**

*Interviewer asks:* "What happens when a database partition goes down? How do you handle the trade-off between consistency and availability?"

*What great candidates say:*

"This is the core tension in a distributed task queue. Let me analyze the failure modes:

**Scenario 1: Metadata DB (PostgreSQL) primary goes down.**

If we're using synchronous replication, the system blocks writes until a replica is promoted - this takes 10-30 seconds with automated failover. During this window, `Enqueue` and `Receive` calls fail. Producers must buffer locally or return errors to callers.

If we use asynchronous replication, failover is faster but we might lose the last few seconds of writes. This means some enqueued tasks might be lost, or some ACKs might be lost (causing re-delivery).

My recommendation: **synchronous replication with a fast failover mechanism** (like Patroni for PostgreSQL). The brief unavailability during failover is acceptable for a task queue - producers can retry - and data loss in a queue system is unacceptable because tasks represent work commitments (payments to process, emails to send, etc.).

**Scenario 2: A consumer processing a task crashes.**

The visibility timeout handles this automatically. After the timeout expires, the Visibility Timer Service makes the task visible again. Another consumer picks it up. This means tasks must be **idempotent** - processing the same task twice should produce the same result.

For non-idempotent operations, consumers should implement the **outbox pattern**: perform the business logic and write a completion record to a local database in a single transaction. Before processing, check the completion record. This provides exactly-once semantics at the application layer.

**Scenario 3: The Visibility Timer Service itself crashes.**

This is less critical than it appears. If the timer service is down, invisible tasks with expired timeouts remain invisible until the service recovers. No task is lost - they're just delayed. I'd run multiple timer service instances with leader election (using a distributed lock in Redis or etcd) for availability.

**Exactly-once delivery:**

True exactly-once delivery is impossible in a distributed system (proven by the Two Generals' Problem). What we can provide is **exactly-once processing**, which is an application-layer concern. The queue provides at-least-once delivery, and consumers use idempotency keys to ensure the business effect happens once. In Go:

```go
package queue

import (
    "context"
    "fmt"
)

type CompletionStore interface {
    Exists(ctx context.Context, id string) (bool, error)
    Record(ctx context.Context, id string, result any) error
}

type BusinessLogic interface {
    Execute(ctx context.Context, payload []byte) (any, error)
}

type Task struct {
    ID      string
    Payload []byte
}

type TaskConsumer interface {
    Ack(ctx context.Context, taskID string) error
    Nack(ctx context.Context, taskID string) error
}

type Worker struct {
    completionStore CompletionStore
    businessLogic   BusinessLogic
    queue           TaskConsumer
}

func (w *Worker) ProcessTask(ctx context.Context, task *Task) error {
    // Check if already processed (idempotency)
    processed, err := w.completionStore.Exists(ctx, task.ID)
    if err != nil {
        return fmt.Errorf("checking completion: %w", err)
    }
    if processed {
        // Already done, just ACK
        return w.queue.Ack(ctx, task.ID)
    }

    // Process the task
    result, err := w.businessLogic.Execute(ctx, task.Payload)
    if err != nil {
        return w.queue.Nack(ctx, task.ID)
    }

    // Record completion and ACK atomically
    // (or as close to atomic as possible)
    if err := w.completionStore.Record(ctx, task.ID, result); err != nil {
        // Completion recorded but ACK failed means task will be
        // redelivered - idempotency check catches it next time
        return fmt.Errorf("recording completion: %w", err)
    }

    return w.queue.Ack(ctx, task.ID)
}
```

**Minutes 35-42: Delay Queues & Priority**

*What great candidates say:*

"For **delay queues**, I use the `visible_at` timestamp on the task. When `EnqueueDelayed` is called, the task is stored with `visible_at = NOW() + delay`. The `Receive` query already filters on `visible_at <= NOW()`, so delayed tasks are naturally hidden until they're due.

For efficiently handling large numbers of delayed tasks, I'd add a **Delay Scheduler** that maintains a sorted set in Redis (`ZADD delay_queue score=visible_at member=task_id`). A goroutine polls `ZRANGEBYSCORE` every 100ms to find tasks whose `visible_at` has arrived and transitions them to PENDING state:

```go
package queue

import (
    "context"
    "fmt"
    "log"
    "time"

    redis "github.com/redis/go-redis/v9"
)

type DelayScheduler struct {
    redis *redis.Client
}

func (ds *DelayScheduler) makeVisible(ctx context.Context, taskID string) error {
    return nil
}

func (ds *DelayScheduler) Run(ctx context.Context) error {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            now := float64(time.Now().UnixMilli())
            taskIDs, err := ds.redis.ZRangeByScore(ctx, "delay_queue", &redis.ZRangeBy{
                Min: "-inf",
                Max: fmt.Sprintf("%f", now),
            }).Result()
            if err != nil {
                continue
            }

            for _, taskID := range taskIDs {
                if err := ds.makeVisible(ctx, taskID); err != nil {
                    log.Printf("Failed to surface delayed task %s: %v", taskID, err)
                    continue
                }
                ds.redis.ZRem(ctx, "delay_queue", taskID)
            }
        }
    }
}
```

For **priority queues**, I support multiple named queues. Consumers can subscribe to multiple queues with a priority order. The `Receive` method tries higher-priority queues first:

```go
package queue

import (
    "context"
    "time"
)

type Task struct {
    ID string
}

type TaskConsumer interface {
    Receive(ctx context.Context, queue string, maxMessages int, visibilityTimeout time.Duration) ([]*Task, error)
}

type PriorityWorker struct {
    consumer TaskConsumer
}

func (w *PriorityWorker) Poll(ctx context.Context) (*Task, error) {
    queues := []string{"critical", "high", "normal", "low"}
    for _, queue := range queues {
        tasks, err := w.consumer.Receive(ctx, queue, 1, 30*time.Second)
        if err != nil {
            return nil, err
        }
        if len(tasks) > 0 {
            return tasks[0], nil
        }
    }
    return nil, nil // No tasks available
}
```

**Minutes 42-45: Monitoring & Operational Concerns**

Key metrics to monitor:
- **Queue depth** per queue (tasks in PENDING state) - alert if growing
- **Processing latency** (time from enqueue to ACK)
- **Visibility timeout expiry rate** - high rate means consumers are too slow or crashing
- **DLQ growth rate** - poisoned messages or persistent failures
- **Consumer lag** - time between newest message and oldest unprocessed message"

### Scoring Rubric

| Rating | Criteria |
|--------|----------|
| **Strong Hire** | Drives the entire conversation. Defines clear API and semantics. Architecture handles visibility timeouts, retries, DLQ, delays. Deep understanding of consistency trade-offs. Discusses exactly-once processing correctly (application-layer idempotency). Go code is production-quality. Addresses monitoring and operational concerns. |
| **Hire** | Good API design. Working architecture with visibility timeouts and retries. Understands at-least-once vs. exactly-once distinction. Some discussion of failure modes. Reasonable Go implementation. |
| **Lean Hire** | Gets the basic queue mechanics right but struggles with distributed systems concerns. Doesn't address visibility timeouts deeply. Limited failure mode analysis. |
| **No Hire** | Cannot design a basic producer-consumer system. Doesn't understand delivery guarantees. No consideration of failures or retries. |


### Junior → FAANG: Distributed Task Scheduler Design Basics

A distributed task scheduler allows tasks to be submitted, scheduled, and executed across multiple worker nodes. Key requirements: task submission API, scheduling (by time, by priority, or by dependency), reliable execution (at-least-once or exactly-once semantics), and failure handling (retry on worker failure). The core components: a task queue (backed by a durable message queue like Kafka or SQS), a scheduler service (assigns tasks to workers based on scheduling rules), worker nodes, and a task state store (tracks task status, retry count, and result). Common mistake: designing for at-most-once execution (losing tasks on worker failure) rather than at-least-once execution.

### Senior @ FAANG: Distributed Task Scheduler at the L5/L6 Bar: Exactly-Once and Scheduling Semantics

At the L5/L6 level, the task scheduler discussion is evaluated on the correctness of the execution semantics and the scheduling guarantees. The exactly-once execution problem in a distributed system is hard: at-least-once is achievable with durable queues and idempotent tasks. Exactly-once requires a two-phase commit protocol or a transactional outbox pattern, which adds significant complexity. Bar-raisers ask: 'if a worker picks up a task, processes it for 30 minutes, and then crashes before marking it complete, what happens?'. The correct answer describes the heartbeat mechanism (workers send periodic heartbeats, the scheduler requeues tasks whose workers go silent), the visibility timeout on the queue (the task message becomes invisible to other workers for the duration of the expected processing time), and the idempotency key requirement for retried tasks. Staff-level discussion includes the priority inversion problem in multi-priority task queues, the starvation risk for low-priority tasks, and the back-pressure mechanism when workers are overwhelmed.

---
