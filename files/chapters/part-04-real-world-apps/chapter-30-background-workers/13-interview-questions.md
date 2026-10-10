## Interview Questions

### Question 1: How do you ensure exactly-once processing of jobs?

**Answer:**

Exactly-once is hard to achieve in distributed systems. Instead, we typically aim for at-least-once delivery with idempotent handlers:

```go
// Strategy 1: Idempotency keys
type IdempotentHandler struct {
    store IdempotencyStore
}

func (h *IdempotentHandler) Handle(ctx context.Context, job *Job) error {
    // Check if already processed
    result, err := h.store.Get(ctx, job.IdempotencyKey)
    if err == nil {
        // Already processed - return cached result
        return result.Error
    }

    // Process job
    err = h.actualHandler(ctx, job)

    // Store result for future duplicate checks
    h.store.Set(ctx, job.IdempotencyKey, Result{Error: err}, 24*time.Hour)

    return err
}

// Strategy 2: Transactional outbox pattern
func (s *Service) CreateOrderWithNotification(ctx context.Context, order Order) error {
    tx, _ := s.db.BeginTx(ctx, nil)

    // Insert order
    _, err := tx.ExecContext(ctx, "INSERT INTO orders ...", order)
    if err != nil {
        tx.Rollback()
        return err
    }

    // Insert job in same transaction
    job, _ := queue.NewJob("notifications", "order_created", order)
    _, err = tx.ExecContext(ctx, "INSERT INTO outbox_jobs ...", job)
    if err != nil {
        tx.Rollback()
        return err
    }

    return tx.Commit()
}

// Separate worker polls outbox and publishes to actual queue
func (w *OutboxWorker) Poll(ctx context.Context) {
    // Use SELECT FOR UPDATE SKIP LOCKED for concurrent workers
    rows, _ := w.db.QueryContext(ctx, `
        SELECT * FROM outbox_jobs
        WHERE processed = false
        FOR UPDATE SKIP LOCKED
        LIMIT 100
    `)

    for rows.Next() {
        job := scanJob(rows)
        if err := w.queue.Enqueue(ctx, job); err == nil {
            w.db.ExecContext(ctx,
                "UPDATE outbox_jobs SET processed = true WHERE id = $1",
                job.ID)
        }
    }
}
```

**What FAANG expects:** You name the impossibility first, two-generals/FLP means you cannot get exactly-once across an unreliable network, and immediately pivot to "at-least-once delivery + idempotent handlers + idempotency keys." Bonus: you mention the transactional outbox pattern for guaranteeing enqueue alongside a business write, and you note that `riverqueue/river` removes the need for an outbox in Postgres shops because enqueue is itself transactional.

**Follow-ups you should be ready for:**
- *How do you pick the idempotency key?* Derive it from the business event (order ID + event type, Stripe event ID, webhook delivery ID), never from a random UUID generated at enqueue time, because a retry must produce the same key.
- *What do you store next to the key?* `(key, result_hash, completed_at)` with a TTL long enough to cover your maximum retry window. Returning the cached result on duplicate keeps the caller's contract intact.
- *Why not just use Kafka exactly-once semantics?* Kafka EOS only covers producer-to-broker-to-consumer inside Kafka. The moment your consumer makes a side-effecting HTTP call to Stripe, you are back to at-least-once, and you still need idempotency.

### Question 2: How do you handle job prioritization?

**Answer:**

Three common approaches exist, each with different tradeoffs between simplicity, fairness, and operational complexity.

```go
// Option 1: Priority queues with different poll frequencies
type PriorityQueueManager struct {
    highPriority   Queue
    normalPriority Queue
    lowPriority    Queue
}

func (m *PriorityQueueManager) Dequeue(ctx context.Context) (*Job, error) {
    // Always check high priority first
    if job, _ := m.highPriority.Dequeue(ctx, 1); job != nil {
        return job, nil
    }

    // Check normal priority
    if job, _ := m.normalPriority.Dequeue(ctx, 1); job != nil {
        return job, nil
    }

    // Finally low priority
    return m.lowPriority.Dequeue(ctx, 1)
}

// Option 2: Weighted polling
func (w *Worker) pollWithWeights(ctx context.Context) *Job {
    // 60% chance to poll high, 30% normal, 10% low
    r := rand.Float64()

    switch {
    case r < 0.6:
        return w.highQueue.Dequeue(ctx)
    case r < 0.9:
        return w.normalQueue.Dequeue(ctx)
    default:
        return w.lowQueue.Dequeue(ctx)
    }
}

// Option 3: Database with priority column
func (q *PostgresQueue) Dequeue(ctx context.Context) (*Job, error) {
    // ORDER BY priority DESC gives higher priority jobs first
    return q.db.QueryRow(`
        UPDATE jobs
        SET status = 'running', locked_until = $1
        WHERE id = (
            SELECT id FROM jobs
            WHERE status = 'pending' AND scheduled_at <= NOW()
            ORDER BY priority DESC, scheduled_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING *
    `, time.Now().Add(5*time.Minute)).Scan(&job)
}
```

**What FAANG expects:** Strict priority queues (Option 1) starve low-priority work during a sustained high-priority burst, you flag that explicitly. Weighted polling (Option 2) avoids starvation but wastes dequeue attempts on empty queues. A single-table `ORDER BY priority DESC, scheduled_at ASC` with `SKIP LOCKED` (Option 3) is usually the right default until you outgrow one Postgres instance.

**Follow-ups you should be ready for:**
- *How do you guarantee fairness across tenants inside the same priority band?* Add a secondary `ORDER BY` on a per-tenant round-robin token, or shard queues per tenant.
- *What happens at queue depth of 10 million?* The partial index `WHERE status = 'pending'` stops being enough. You need table partitioning by status or by day, or you move hot paths to a dedicated Redis/asynq queue.

### Question 3: How do you scale workers horizontally?

**Answer:**

Horizontal scaling requires that no single worker holds exclusive state. Four techniques enable this: lock-free concurrent dequeue, atomic queue operations, queue sharding for throughput, and auto-scaling based on queue depth.

```go
// Key principles for horizontal scaling:

// 1. Use FOR UPDATE SKIP LOCKED for database queues
query := `
    SELECT * FROM jobs
    WHERE status = 'pending'
    FOR UPDATE SKIP LOCKED  -- Other workers skip locked rows
    LIMIT 10
`

// 2. Use Redis BRPOPLPUSH for atomic dequeue
func (q *RedisQueue) Dequeue(ctx context.Context) (*Job, error) {
    // Atomic: removes from pending, adds to processing
    // Multiple workers can call this safely
    result, err := q.redis.BRPopLPush(ctx,
        "queue:pending",
        "queue:processing",
        timeout,
    ).Result()
    return parseJob(result), err
}

// 3. Partition queues for high throughput
type ShardedQueue struct {
    shards []*Queue
}

func (q *ShardedQueue) Enqueue(ctx context.Context, job *Job) error {
    // Partition by job ID or customer ID
    shard := hashToShard(job.ID, len(q.shards))
    return q.shards[shard].Enqueue(ctx, job)
}

// Each worker processes a subset of shards
func (w *Worker) Start(assignedShards []int) {
    for _, shard := range assignedShards {
        go w.processQueue(w.shardedQueue.shards[shard])
    }
}

// 4. Auto-scaling based on queue depth
type AutoScaler struct {
    k8sClient kubernetes.Interface
}

func (a *AutoScaler) Monitor(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    for range ticker.C {
        depth, _ := a.queue.Len(ctx)
        currentWorkers := a.getReplicaCount()

        desiredWorkers := calculateDesiredWorkers(depth, currentWorkers)
        if desiredWorkers != currentWorkers {
            a.scaleDeployment(desiredWorkers)
        }
    }
}
```

**What FAANG expects:** Scaling is not about adding more workers, it is about making sure adding workers actually increases throughput. You lead with `SKIP LOCKED` (or Redis `BRPOPLPUSH`) so workers do not fight for the same row. You mention that a single Postgres write leader caps you somewhere around 5-20k jobs/sec regardless of how many workers you add, and you prescribe sharding (by tenant, by job type) before that cap. You also mention HPA-style autoscaling driven by queue depth rather than CPU.

**Follow-ups you should be ready for:**
- *What signal drives autoscaling, queue depth or oldest-job age?* Oldest-job age is better, it directly measures SLA impact. Queue depth alone can be misleading (100 fast jobs vs 100 slow jobs).
- *How do you avoid thundering herd when 50 new workers come online?* Add random jitter to the first poll. Use `BLPOP` with a long timeout so workers spread out naturally.
- *What is your bottleneck at 100k jobs/sec?* Usually the queue store, you shard Postgres, move to asynq/Redis Cluster, or switch to Kafka with partition-per-consumer semantics.

### Question 4: What's the difference between pull and push-based queues?

**Answer:**

In a pull model, workers poll the queue on a timer and control their own consumption rate. In a push model, the queue delivers messages to workers as they arrive, giving lower latency but requiring the worker to handle backpressure. Most production systems use one or the other, but a hybrid approach can combine both for different job types.

```go
// PULL-based (workers poll for jobs)
// Used by: SQS, Redis queues, database polling
type PullWorker struct {
    queue Queue
}

func (w *PullWorker) Run(ctx context.Context) {
    ticker := time.NewTicker(time.Second)
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Worker actively fetches jobs
            job, err := w.queue.Dequeue(ctx)
            if err != nil || job == nil {
                continue
            }
            w.process(ctx, job)
        }
    }
}

// Pros: Simple, workers control rate, easy to scale
// Cons: Polling overhead, latency (up to poll interval)

// PUSH-based (queue sends jobs to workers)
// Used by: Kafka, RabbitMQ, NATS
type PushWorker struct {
    subscriber Subscriber
}

func (w *PushWorker) Run(ctx context.Context) {
    // Subscribe to messages - queue pushes to us
    messages := w.subscriber.Subscribe(ctx, "jobs")

    for msg := range messages {
        w.process(ctx, msg)
        msg.Ack() // Acknowledge after processing
    }
}

// Pros: Lower latency, no polling overhead
// Cons: Need to handle backpressure, more complex

// Hybrid approach
func (w *HybridWorker) Run(ctx context.Context) {
    // Use push for immediate jobs
    go w.subscribeToPush(ctx)

    // Use pull for scheduled/delayed jobs
    go w.pollForScheduled(ctx)
}
```

**What FAANG expects:** You separate the *transport* (pull vs push) from the *delivery guarantee* (at-most-once vs at-least-once). SQS is pull + at-least-once. Kafka is pull-but-looks-pushed with configurable semantics. You also mention that "push" systems like RabbitMQ still need consumer-side prefetch limits, otherwise one slow consumer accumulates an unbounded in-memory backlog.

**Follow-ups you should be ready for:**
- *How does backpressure work in a push model?* Prefetch / QoS limits, flow-control credits (AMQP), or consumer-side bounded channels.
- *Why does Kafka feel like push but is technically pull?* Consumers long-poll the broker. This is how Kafka delivers push-like latency while keeping the broker stateless about consumer progress.

### Question 5: How do you handle poison messages (jobs that always fail)?

**Answer:**

A poison message is a job that fails on every attempt, typically due to invalid data or a permanent upstream error. The strategy is to cap retries, move the job to a dead letter queue with full diagnostic context, alert operators, and distinguish permanent errors (skip straight to DLQ) from transient ones (keep retrying).

```go
// Poison message handling strategy
type PoisonMessageHandler struct {
    maxAttempts   int
    dlq           DeadLetterQueue
    alerting      AlertService
}

func (h *PoisonMessageHandler) Process(ctx context.Context, job *Job) error {
    // Track consecutive failures
    if job.Attempts >= h.maxAttempts {
        // Move to dead letter queue
        dlJob := &DeadLetterJob{
            OriginalJob:  job,
            FailureCount: job.Attempts,
            LastError:    job.LastError,
            MovedAt:      time.Now(),
        }

        if err := h.dlq.Add(ctx, dlJob); err != nil {
            return err
        }

        // Alert operators
        h.alerting.SendAlert(Alert{
            Severity: "warning",
            Message:  fmt.Sprintf("Job %s moved to DLQ after %d failures",
                job.ID, job.Attempts),
            Details:  map[string]any{
                "job_type":   job.Type,
                "last_error": job.LastError,
            },
        })

        return nil // Job handled (moved to DLQ)
    }

    // Try to process
    err := h.actualProcess(ctx, job)
    if err != nil {
        // Check if error is permanent (no point retrying)
        if isPermanentError(err) {
            job.Attempts = h.maxAttempts // Skip to DLQ
        }
        return err
    }

    return nil
}

func isPermanentError(err error) bool {
    // Examples of permanent errors (don't retry):
    // - Validation errors
    // - Business rule violations
    // - Missing required data
    var validationErr *ValidationError
    var notFoundErr *NotFoundError

    return errors.As(err, &validationErr) ||
           errors.As(err, &notFoundErr) ||
           strings.Contains(err.Error(), "invalid")
}

// Admin API to inspect and replay DLQ
type DLQAdmin struct {
    dlq   DeadLetterQueue
    queue Queue
}

func (a *DLQAdmin) ListDeadLetters(ctx context.Context) ([]*DeadLetterJob, error) {
    return a.dlq.List(ctx, 100, 0)
}

func (a *DLQAdmin) Replay(ctx context.Context, id string) error {
    dlJob, err := a.dlq.Get(ctx, id)
    if err != nil {
        return err
    }

    // Reset attempts and re-enqueue
    dlJob.OriginalJob.Attempts = 0
    dlJob.OriginalJob.Status = StatusPending

    if err := a.queue.Enqueue(ctx, dlJob.OriginalJob); err != nil {
        return err
    }

    return a.dlq.Delete(ctx, id)
}
```

**What FAANG expects:** You distinguish **transient** errors (retry with exponential backoff + jitter) from **permanent** errors (skip retries, go straight to DLQ). You alert on DLQ *rate of change*, not absolute size, a DLQ with 10k old items is a noisy dashboard. A DLQ gaining 50 items per minute is an incident. You mention that replaying a DLQ blindly after a long outage can double-apply side effects and must be gated on idempotency keys.

**Follow-ups you should be ready for:**
- *How long do you keep DLQ items?* 14-30 days is typical. Long enough for a human to investigate, short enough that storage costs stay bounded.
- *What goes in the DLQ record beyond the payload?* Full attempt history (timestamps, error messages, stack traces, worker ID, trace ID) so you can correlate with logs/traces without replaying.
- *How do you test poison-message handling?* Chaos-inject a handler that always returns a specific permanent error. Verify the job reaches the DLQ within `max_attempts` and that the alerting path fires.

### Question 6: When would you choose Temporal over a job queue?

**Answer:**

A job queue (asynq, river, SQS) is the right abstraction when each unit of work is short, independent, and either succeeds or fails atomically. You reach for **Temporal** (or Cadence, its predecessor still used inside Uber) when the "job" is actually a multi-step business process that must survive process restarts, worker crashes, and long waits, and where writing the retry/compensation logic by hand would dominate the implementation.

The defining feature of Temporal is **durable execution**: your workflow is plain Go code, but the SDK intercepts every call to an `activity` (the side-effecting step) and every `workflow.Sleep`, `workflow.NewTimer`, or `workflow.Select`, and persists the result to a history log. If the worker process dies mid-workflow, Temporal schedules the workflow on another worker, *replays* the history deterministically up to the last recorded point, and resumes from there, your code looks sequential but is implicitly checkpointed at every await.

```go
// A Temporal workflow for a 7-day customer onboarding flow.
// Survives worker restarts, deployments, and week-long human delays.
func OnboardingWorkflow(ctx workflow.Context, userID string) error {
    ao := workflow.ActivityOptions{
        StartToCloseTimeout: time.Minute,
        RetryPolicy: &temporal.RetryPolicy{
            InitialInterval:    time.Second,
            BackoffCoefficient: 2.0,
            MaximumAttempts:    5,
        },
    }
    ctx = workflow.WithActivityOptions(ctx, ao)

    if err := workflow.ExecuteActivity(ctx, SendWelcomeEmail, userID).Get(ctx, nil); err != nil {
        return err
    }

    // Sleep for 3 days. The worker can restart, redeploy, and scale down to zero
    // during this sleep, Temporal guarantees the workflow wakes up on schedule.
    _ = workflow.Sleep(ctx, 3*24*time.Hour)

    if err := workflow.ExecuteActivity(ctx, SendDay3Tips, userID).Get(ctx, nil); err != nil {
        // Compensation, undo work done earlier in the workflow.
        _ = workflow.ExecuteActivity(ctx, RevokeTrialCredits, userID).Get(ctx, nil)
        return err
    }

    return nil
}
```

**When Temporal wins:**
- Multi-step workflows with compensation (SAGA pattern): book flight, book hotel, charge card, if any step fails, undo the earlier ones.
- Long timers (days, weeks, months): subscription trial expiry, delayed reminders, dunning flows.
- Human-in-the-loop steps: wait up to 7 days for a manager's approval signal, then continue.
- Anything where you catch yourself building a state-machine table in Postgres with `next_step` and `scheduled_for` columns. That is Temporal, reinvented badly.

**When a plain queue wins:**
- Jobs that complete in seconds and have no branching.
- You do not want to operate a Temporal cluster (it is a real distributed system, Cassandra/Postgres + Elasticsearch + history/matching services).
- Latency-sensitive fire-and-forget work (Temporal adds per-activity persistence overhead).

**What FAANG expects:** You know the difference between a queue (transport for work) and a durable-execution engine (a runtime for stateful workflows). You can point to at least one real workflow where Temporal's replay model removes ~1000 lines of hand-written state-machine code. You can also list the trade-offs honestly, Temporal is operationally non-trivial and is overkill for 80% of background jobs.

**Follow-ups you should be ready for:**
- *Why must workflow code be deterministic?* Because replay, if the code takes a different branch during replay than during the original run (e.g. reads `time.Now()` or a random UUID), history diverges and the workflow fails. All non-determinism must go through `workflow.Now()`, `workflow.SideEffect`, or activities.
- *How do you version a workflow that is already running in production?* `workflow.GetVersion`, branches on the recorded version so in-flight workflows keep replaying correctly under the old logic while new workflows pick up the new logic.
- *Why not just use a cron + database state machine?* You can, for small cases. Temporal's payoff is that it gives you signals, queries, child workflows, cancellation, heartbeats, and a maintained UI for free. rebuilding those on cron + Postgres is a multi-quarter project.

### Junior to FAANG: how to use this question bank

These are L4 to L5 questions. At L3 (new-grad), you will likely get a subset, and the bar is "you know the vocabulary". At L4, you need to code the answer on a whiteboard or REPL in 20 minutes. At L5, you need to lead the design conversation and propose trade-offs.

Study plan for a junior.

1. Read each question. Attempt an answer without reading the provided solution. Write it out. Then compare.
2. For each gap, read the linked chapter section. Do not memorize the solution verbatim.
3. Re-attempt the same question a week later. Answer should be in your own words.
4. Add follow-up questions you hit, and practice the follow-ups.

Common junior interview failure modes on these questions.

- Answering "exactly-once" with "just use Kafka EOS". Wrong. EOS is transport-only.
- Answering "poison pill" without mentioning DLQ alerting on rate, not absolute size.
- Answering "backpressure" with "add more workers". Wrong. Backpressure is upstream-facing.
- Answering "Temporal versus queue" without knowing replay determinism.
- Answering "scaling" with "auto-scale on CPU". Wrong. Auto-scale on oldest-message-age.

Entry-point preparation.

- Make sure you have written, with your own hands, a Postgres-backed queue with `SKIP LOCKED`, a Redis delayed queue, and a cron scheduler with a distributed lock. If you have not, you will stumble on the "code this in 20 minutes" portion.
- Run an incident simulation with a friend. They simulate "the DLQ is growing at 100/min". You walk through triage.

### Senior at FAANG: what the interviewer is actually probing at L5/L6

At staff level, these questions are launching pads for deeper discussion. The interviewer is not grading you on the coded answer. They are grading on how you lead the architecture conversation, identify trade-offs, and articulate what a platform owner would build.

**Signal the interviewer is looking for on question 1 (exactly-once).** L4 candidates say "idempotency keys". L5 candidates add "outbox pattern plus idempotent handler" and name Stripe's idempotency-key model. L6 candidates discuss the platform contract, who issues the key, where it is stored, TTL, what the key scope is (per-operation versus per-job), and how the SDK enforces it uniformly across teams.

**Signal on question 2 (prioritization).** L4 says "priority column". L5 says "strict priority starves low tier, weighted fair queueing is the fix, tenant-aware fairness is the next step". L6 discusses the platform decision to implement fairness at the dispatcher layer, quotas per tenant, credit-based admission control, and how they would roll it out to 50 teams with varying priority needs without breaking them.

**Signal on question 3 (horizontal scale).** L4 says "more workers, SKIP LOCKED". L5 adds "sharding by tenant, auto-scale on oldest-message-age". L6 discusses the scaling limits of each backend, sharding strategy, cross-region considerations, cost per scaling tier, and when to switch technologies (Postgres to Kafka, Redis to managed, etc.).

**Signal on question 4 (pull versus push).** L4 recites pros and cons. L5 separates transport from delivery semantics, mentions prefetch, credit flow control. L6 discusses why at scale no one uses push-push (broker-driven flow control is a single point of back-pressure), why Kafka long-poll is the de facto standard, and how Temporal's task matching service is a push-like-pull hybrid.

**Signal on question 5 (poison).** L4 says DLQ plus max_attempts. L5 adds permanent-versus-transient classification, rate-based alerting, replay guardrails. L6 discusses DLQ-as-product, triage SLA, RBAC for replay, schema versioning of DLQ entries, archeology tools for 6-month-old DLQ payloads.

**Signal on question 6 (Temporal).** L4 names Temporal and says "durable execution". L5 discusses when to use Temporal versus a queue, with concrete examples. L6 discusses the trade-off matrix, operational cost of Temporal cluster, when to use Temporal Cloud versus self-host, how to drive org-wide adoption, and migration patterns from legacy state machines.

**Meta-signal.** At L6, the interviewer wants to hear ADR thinking. "Here is the decision context, here are the alternatives, here is what I picked and why, here are the consequences I accept". If you only speak in code, you signal L4. If you speak in trade-offs and multi-year plans, you signal L6.

**Interview trap question pattern.** "Here is a system that sends 100M emails a day with retries, and we have a problem where 0.1% are delivered twice. Debug it." The wrong move is to jump to code. The right move is. "What does 'delivered twice' mean, duplicate enqueue, duplicate dequeue, or duplicate provider call. What is the idempotency key at the provider level (if the email provider exposes one, otherwise you dedup before the send call). Where is it set. Where might it be overwritten during retry. Do we have a trace we can pull for one duplicated delivery. What is the SLO cost of 0.1% duplication and is this worth blocking a release. I would ask for one pair of duplicated emails and trace them." The senior interviewer listens for the investigation plan more than the answer.

**System design companion question.** "Design Instagram's background worker platform serving 500 teams". Expected answer arc. Tiered queues (Kafka for fan-out, Postgres+river for transactional, Redis+asynq for simple). Centralized scheduler (etcd-backed). Platform SDK with uniform middleware. DLQ product with triage UI. Autoscaling via KEDA on lag-seconds. Cost attribution per team. Multi-year roadmap. Organizational structure (platform team, SRE, DLQ tooling). The interviewer is looking for breadth plus concrete specifics on at least two subsystems.

**Behavioral questions bundled with technical.** "Tell me about a queue incident". The story structure is, situation, action, result, reflection. Example, "Uber-style retro. We had a Redis cluster OOM, jobs evicted, 40k duplicate notifications. Action was shed-load playbook, switch to no-eviction policy, add idempotency middleware, publish platform change. Result, zero duplicate notifications in the following quarter. Reflection, we treated Redis as durable without validating eviction policy, we now have a platform audit for eviction policy on all queue Redis."

---
