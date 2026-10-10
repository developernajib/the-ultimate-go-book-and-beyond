## Common Mistakes

### Mistake 1: Not Handling Worker Shutdown Gracefully

Calling `os.Exit` immediately on a signal kills workers mid-job, leaving jobs in an ambiguous state. Use context cancellation to signal workers, then wait for in-flight jobs to drain before exiting.

**Wrong:**
```go
func (w *Worker) Run() {
    for {
        job := w.queue.Dequeue()
        w.process(job) // What if shutdown happens here?
    }
}

func main() {
    w := NewWorker()
    go w.Run()

    <-sigChan
    os.Exit(0) // Worker is killed mid-job!
}
```

**Correct:**
```go
func (w *Worker) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            w.logger.Info("worker shutting down")
            return
        default:
        }

        job := w.queue.Dequeue(ctx)
        if job == nil {
            continue
        }

        // Process with context - allows cancellation
        w.process(ctx, job)
    }
}

func main() {
    ctx, cancel := context.WithCancel(context.Background())

    w := NewWorker()
    go w.Run(ctx)

    <-sigChan
    cancel() // Signal shutdown

    // Wait for in-flight jobs with timeout
    shutdownCtx, _ := context.WithTimeout(context.Background(), 30*time.Second)
    w.Wait(shutdownCtx)
}
```

### Mistake 2: Losing Jobs on Dequeue

If you remove a job from the queue before processing it, a worker crash means the job is permanently lost. Instead, move jobs to a "processing" list and only delete them after successful completion.

**Wrong:**
```go
// Job is removed from queue before processing
func (q *Queue) Dequeue() *Job {
    return q.redis.LPop("jobs") // Job is gone if worker crashes!
}
```

**Correct:**
```go
// Move job to processing queue, only delete after completion
func (q *Queue) Dequeue(ctx context.Context) (*Job, error) {
    // Atomically move from pending to processing
    result, err := q.redis.BRPopLPush(ctx, "jobs:pending", "jobs:processing", timeout).Result()
    if err != nil {
        return nil, err
    }
    return parseJob(result), nil
}

func (q *Queue) Complete(ctx context.Context, job *Job) error {
    // Remove from processing queue only after successful completion
    return q.redis.LRem(ctx, "jobs:processing", 1, job.ID).Err()
}

// Background goroutine to recover stuck jobs
func (q *Queue) RecoverStuckJobs(ctx context.Context) {
    ticker := time.NewTicker(time.Minute)
    for range ticker.C {
        // Move jobs back from processing to pending if they've been there too long
        stuckJobs, _ := q.redis.LRange(ctx, "jobs:processing", 0, -1).Result()
        for _, jobData := range stuckJobs {
            job := parseJob(jobData)
            if time.Since(job.StartedAt) > 5*time.Minute {
                // Return to pending queue
                q.redis.LRem(ctx, "jobs:processing", 1, jobData)
                q.redis.RPush(ctx, "jobs:pending", jobData)
            }
        }
    }
}
```

### Mistake 3: No Backpressure on Job Submission

Accepting unlimited job submissions lets producers overwhelm workers, growing queue depth until the system runs out of memory or disk. Check queue depth before accepting new jobs and return HTTP 429 with a `Retry-After` header when the queue is full.

**Wrong:**
```go
func (api *API) EnqueueJob(w http.ResponseWriter, r *http.Request) {
    // Accepts unlimited jobs - can overwhelm workers
    job := parseJob(r)
    queue.Enqueue(job)
    w.WriteHeader(http.StatusAccepted)
}
```

**Correct:**
```go
func (api *API) EnqueueJob(w http.ResponseWriter, r *http.Request) {
    job := parseJob(r)

    // Check queue depth
    depth, _ := api.queue.Len(r.Context())
    if depth > 10000 {
        // Return 429 to indicate backpressure
        w.Header().Set("Retry-After", "60")
        http.Error(w, "Queue is full, try again later", http.StatusTooManyRequests)
        return
    }

    // Check if this is a duplicate (idempotency)
    exists, _ := api.dedup.Exists(r.Context(), job.IdempotencyKey)
    if exists {
        // Return cached result
        w.WriteHeader(http.StatusAccepted)
        return
    }

    if err := api.queue.Enqueue(r.Context(), job); err != nil {
        http.Error(w, "Failed to enqueue", http.StatusInternalServerError)
        return
    }

    api.dedup.Set(r.Context(), job.IdempotencyKey, 24*time.Hour)
    w.WriteHeader(http.StatusAccepted)
}
```

### Mistake 4: Not Using Distributed Locks for Cron Jobs

When multiple worker instances each run their own cron scheduler, every instance fires the same job at the same time. Use a distributed lock (Redis `SET NX` or PostgreSQL advisory locks) so that only one instance runs each scheduled job.

**Wrong:**
```go
// Each worker instance runs the cron job!
func main() {
    c := cron.New()
    c.AddFunc("0 0 * * *", dailyCleanup) // Runs on ALL instances
    c.Start()
}
```

**Correct:**
```go
func main() {
    scheduler := NewDistributedScheduler(redisClient)

    scheduler.AddJob("daily-cleanup", "0 0 * * *", func(ctx context.Context) error {
        // Only one instance will run this
        return dailyCleanup(ctx)
    })

    scheduler.Start(ctx)
}

type DistributedScheduler struct {
    redis *redis.Client
    jobs  []CronJob
}

func (s *DistributedScheduler) runJob(ctx context.Context, job CronJob) {
    // Try to acquire lock
    lockKey := fmt.Sprintf("cron:lock:%s", job.Name)
    acquired, err := s.redis.SetNX(ctx, lockKey, workerID, 5*time.Minute).Result()
    if err != nil || !acquired {
        return // Another worker got it
    }
    defer s.redis.Del(ctx, lockKey)

    // Run job
    if err := job.Handler(ctx); err != nil {
        log.Error("cron job failed", "name", job.Name, "error", err)
    }
}
```

### Mistake 5: Ignoring Job Processing Time in Timeouts

If a job runs longer than the visibility timeout, the queue makes it available again and another worker picks it up. Both workers now process the same job. Send periodic heartbeats to extend the lock while the job is still active.

**Wrong:**
```go
func (w *Worker) process(job *Job) {
    // Job takes 30 seconds but lock expires in 5 minutes
    // What if job takes 10 minutes?
    result := expensiveOperation(job)
    w.queue.Complete(job) // Lock already expired, job might be running elsewhere!
}
```

**Correct:**
```go
func (w *Worker) process(ctx context.Context, job *Job) {
    // Start heartbeat to extend lock
    heartbeatDone := make(chan struct{})
    go func() {
        ticker := time.NewTicker(30 * time.Second) // Well before 5 min lock expiry
        defer ticker.Stop()
        for {
            select {
            case <-heartbeatDone:
                return
            case <-ticker.C:
                if err := w.queue.Heartbeat(ctx, job.ID); err != nil {
                    // Lost lock - stop processing
                    log.Warn("lost job lock, stopping", "job_id", job.ID)
                    return
                }
            }
        }
    }()

    // Process job
    err := expensiveOperation(ctx, job)
    close(heartbeatDone)

    if err != nil {
        w.queue.Fail(ctx, job, err)
        return
    }
    w.queue.Complete(ctx, job)
}
```

### Junior to FAANG: the meta-mistake beneath all five

Every mistake above has the same root cause. Treating async work as if it were synchronous. The five mistakes above catch most juniors, but the sixth (and most expensive) is missed almost universally.

**Mistake 6, non-idempotent handlers.** Even with perfect shutdown, persistence, and visibility timeout, at-least-once delivery means your handler will eventually run twice for the same job. If the handler charges a card, sends an email, or calls an external API without an idempotency key, you will double-execute. The fix is not the queue. It is the handler.

```go
func (h *ChargeHandler) Handle(ctx context.Context, job *queue.Job) error {
    key := fmt.Sprintf("charge:%s", job.ID)
    // Stripe accepts Idempotency-Key header. Replay is a no-op.
    charge, err := h.stripe.Charges.New(&stripe.ChargeParams{
        Amount: stripe.Int64(job.AmountCents),
        Source: stripe.String(job.Source),
        Params: stripe.Params{
            IdempotencyKey: &key,
        },
    })
    return err
}
```

Without idempotency, no queue topology is safe. Learn this before writing your first handler.

**Mistake 7, using panic for normal errors.** A panicking handler crashes the worker unless recovered. The fix is `defer recover()` at the handler boundary. The deeper fix is, handlers return errors, not panic. Panics are for programmer bugs (nil pointer), not business failures.

**Mistake 8, retrying permanent errors.** The code in mistake 5 retries any error. If the error is "user deleted", retrying 8 times with backoff wastes compute. Classify errors and skip retries for permanent ones.

**Mistake 9, unbounded payload.** A job with a 10MB payload fills the queue with a single message. Use payload offloading (S3 pointer) above 64KB.

**Mistake 10, no per-tenant isolation.** One tenant submits 1M jobs. Your other 999 tenants starve. Add per-tenant rate limiting at enqueue.

Walkthrough of a junior's first production postmortem. The team ships a worker. In week 2, during a kube upgrade, 5% of jobs vanish. Root cause is mistake 1 (no graceful shutdown). They fix it. In week 4, the DB fails over and jobs duplicate. Root cause is mistake 5 (no heartbeat) and mistake 6 (non-idempotent handler). They fix the heartbeat but not the handler. In week 6, a Redis OOM evicts 10% of jobs. Root cause is mistake 2 equivalent (using Redis without persistence policy, not using `noeviction`). Each mistake is obvious in hindsight. The pattern is, ship, get paged, fix, repeat. Learning them upfront is cheaper.

Interview entry point. "Here is a worker that loses jobs occasionally. Walk me through hypotheses." A strong candidate lists, graceful shutdown, ack-before-side-effect, Redis eviction policy, visibility timeout tuning, handler panic without recovery. Then asks for logs to narrow down.

### Senior at FAANG: platform-level mistakes and how to prevent them

The chapter's mistakes are handler-level. Staff engineers prevent entire classes of mistakes by platform design. The following are the mistakes staff engineers encounter when reviewing other teams' queue designs, and the platform mechanisms that prevent them.

**Platform mistake 1, each team rolls its own retry policy.** Without a shared policy spec, team A retries 3 times, team B retries forever, team C has no retry. The resulting incident portfolio is unmanageable because every queue failure is investigated from scratch. Platform fix is a declarative retry policy per `(job_type, version)` stored in a registry, enforced by the SDK. Teams write YAML, not retry loops.

**Platform mistake 2, metrics are not uniform across teams.** Team A exports `jobs_processed`, team B exports `emails_sent`, team C has no metrics. Alerting rules cannot be shared. Platform fix is, the SDK emits a canonical metric set (duration histogram, outcome counter, depth gauge, age gauge) per `job_type`, labeled uniformly. Team-specific metrics are additional.

**Platform mistake 3, async work mixes tiers in the same queue.** Billing jobs and analytics jobs share a queue. When analytics floods, billing lags. Platform fix is a mandatory tier attribute per `job_type`, and separate worker pools (or separate queues) per tier. SDK refuses to register a handler without a declared tier.

**Platform mistake 4, idempotency is handler-by-handler.** Each team rediscovers idempotency keys. Some get them right, some do not. Platform fix is an idempotency middleware in the SDK. Handler declares its idempotency key source (a field in the payload). The middleware checks a shared store before invoking the handler and stores the result after.

**Platform mistake 5, outbox relay is reimplemented per service.** Every team writes their own relay. They all have slightly different failure modes. Platform fix is one outbox relay service, one library, used by all. Shared ops burden. Central alerting.

**Platform mistake 6, schedulers run in-service.** Every service embeds `robfig/cron` in their app. Duplicate runs on replicas. No central visibility. Platform fix is a centralized scheduler service with registration API. Services register schedules via API, scheduler fires them into the shared queue.

**Platform mistake 7, DLQ is per-service, not shared.** Every team has their own DLQ with their own replay tool. Consolidation into a single DLQ product gives uniform RBAC, triage SLA, and replay tooling.

**Platform mistake 8, job_type naming collisions.** Team A's `send_email` and team B's `send_email` are different. The platform registry must enforce namespaced names, typically `{team}.{service}.{type}`.

**Platform mistake 9, no job_type versioning policy.** Schema changes during deploy break in-flight jobs. Platform fix is, every `job_type` carries a version. SDK allows N-1 handler compatibility. Rolling deploys go through staged version handoff.

**Platform mistake 10, no cost attribution.** The platform runs on shared infra. One team submits 100M jobs and nobody pays. Platform fix is cost labels per `tenant` and `team`, surfaced in chargeback reports. Changes behavior when engineering is cost-accountable.

**Prevention mechanisms, in order of effectiveness.**

1. Make the right path the easy path. SDK wraps everything. Wrong path requires explicit opt-out.
2. Mandatory code review checklist per SDK change.
3. Lint rules that reject handler code without idempotency declaration, panic recovery, or typed error results.
4. Platform quarterly game-days that reproduce known failure modes.
5. Documentation published at every abstraction layer, with examples that show the wrong way marked "do not do this".
6. Onboarding for each new team, including a 1-hour walkthrough of the platform's failure modes and how to avoid them.

**Staff-level ADR, retry policy standardization.** Context. Five teams use different retry strategies. Decision. All async work uses platform retry policies declared in YAML, registered at job_type. Handler can override via `Result.Retry` field but the default is the registered policy. Consequences. Incidents become portable across teams. Policy changes roll out via config, not code deploy. Migration, 3 months to move existing queues to the standard policy.

**Incident retrospective pattern.** Every queue SEV ends with, could a platform change have prevented this class of bug. If yes, fund the platform work. If no, add a regression test or runbook entry. Do not let handler-level fixes stay at handler level. Migrate the learning into the SDK.

---
