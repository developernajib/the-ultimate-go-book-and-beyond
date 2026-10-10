## Background Worker Pitfalls: When Jobs Go Rogue

### The Silent Job Loss Disaster

**The Incident**: A fintech company's payment reconciliation system used a popular Go job queue library. After a deploy, they noticed their nightly reconciliation wasn't running. Investigation revealed that 47,000 jobs had been sitting unprocessed for 3 days. The queue consumer had panicked on startup due to a config change, but the process kept running because the panic was in a goroutine. No alerts fired because the "jobs processed" metric was simply zero - indistinguishable from "no jobs to process."

```go
// WRONG: Panic in goroutine silently kills worker
func (w *Worker) Start(ctx context.Context) {
    for i := 0; i < w.concurrency; i++ {
        go func() {
            for job := range w.jobs {
                w.process(job) // If this panics, goroutine dies silently
            }
        }()
    }
}

// CORRECT: Recover panics, track worker health
func (w *Worker) Start(ctx context.Context) {
    for i := 0; i < w.concurrency; i++ {
        workerID := i
        go func() {
            defer func() {
                if r := recover(); r != nil {
                    w.metrics.WorkerPanic(workerID, r)
                    // Restart worker after panic
                    go w.startWorker(ctx, workerID)
                }
            }()
            w.startWorker(ctx, workerID)
        }()
    }

    // Health check goroutine
    go w.monitorWorkerHealth(ctx)
}

func (w *Worker) monitorWorkerHealth(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            activeWorkers := atomic.LoadInt32(&w.activeWorkers)
            if activeWorkers < int32(w.concurrency) {
                w.metrics.WorkerDeficit(w.concurrency - int(activeWorkers))
                // Alert on sustained worker deficit
            }
        }
    }
}
```

### The Thundering Herd on Restart

**The Incident**: An e-commerce platform's order processing workers crashed. When they restarted, all 50 workers simultaneously grabbed jobs from the queue. The database connection pool was exhausted in milliseconds, the payment API rate-limited them, and the workers started failing jobs that then went back to the queue - creating a feedback loop that took down the entire checkout system for 2 hours.

```go
// WRONG: All workers start at full speed
func (w *Worker) Start(ctx context.Context) {
    for i := 0; i < w.workerCount; i++ {
        go w.processJobs(ctx)
    }
}

// CORRECT: Staggered startup with backpressure
func (w *Worker) Start(ctx context.Context) error {
    // Start workers gradually
    startupDelay := 5 * time.Second
    workersPerBatch := 5

    for i := 0; i < w.workerCount; i++ {
        workerID := i
        go w.processJobs(ctx, workerID)

        // Stagger startup
        if (i+1) % workersPerBatch == 0 {
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(startupDelay):
            }

            // Check system health before starting more
            if !w.healthChecker.IsHealthy() {
                log.Warn("system unhealthy, pausing worker startup")
                if err := w.waitForHealthy(ctx); err != nil {
                    return err
                }
            }
        }
    }

    return nil
}

func (w *Worker) processJobs(ctx context.Context, workerID int) {
    // Initial delay based on worker ID to spread load
    jitter := time.Duration(workerID*100) * time.Millisecond
    time.Sleep(jitter)

    backoff := &ExponentialBackoff{
        Initial: 100 * time.Millisecond,
        Max:     30 * time.Second,
        Factor:  2,
    }

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        job, err := w.queue.Dequeue(ctx)
        if err != nil {
            backoff.Wait(ctx)
            continue
        }

        backoff.Reset()
        w.executeJob(ctx, job)
    }
}
```

### The Visibility Timeout Trap

**The Incident**: A video transcoding service used SQS with a 5-minute visibility timeout. Some videos took 30+ minutes to transcode. The job would become visible again while still processing, get picked up by another worker, and both workers would upload their output - sometimes overwriting each other. Customers received corrupted videos, and AWS bills tripled from duplicate transcoding.

```go
// WRONG: Fixed visibility timeout, no extension
func (w *Worker) processJob(ctx context.Context, msg *sqs.Message) error {
    // 5 minute visibility timeout set at queue level
    return w.transcode(ctx, msg.Body) // May take 30+ minutes
}

// CORRECT: Heartbeat extends visibility during processing
func (w *Worker) processJob(ctx context.Context, msg *sqs.Message) error {
    // Create cancellable context for this job
    jobCtx, cancel := context.WithCancel(ctx)
    defer cancel()

    // Start heartbeat to extend visibility
    heartbeatDone := make(chan struct{})
    go func() {
        defer close(heartbeatDone)
        w.extendVisibility(jobCtx, msg)
    }()

    // Process job
    err := w.transcode(jobCtx, msg.Body)

    // Stop heartbeat
    cancel()
    <-heartbeatDone

    return err
}

func (w *Worker) extendVisibility(ctx context.Context, msg *sqs.Message) {
    // Extend before timeout expires (5 min timeout, extend every 4 min)
    ticker := time.NewTicker(4 * time.Minute)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            _, err := w.sqs.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
                QueueUrl:          &w.queueURL,
                ReceiptHandle:     msg.ReceiptHandle,
                VisibilityTimeout: 300, // Extend by 5 more minutes
            })
            if err != nil {
                // Message may have been processed by another worker
                log.Error("failed to extend visibility", "error", err)
                return
            }
            w.metrics.VisibilityExtended(msg.MessageId)
        }
    }
}
```

### The Retry Storm Amplification

**The Incident**: A notification service processed webhook deliveries. When a downstream service went down, failed jobs were retried with exponential backoff. But the retry logic had a bug: it calculated delay from the original enqueue time, not the last attempt. After the downstream recovered, 2 million webhooks that had been "backing off" all became eligible simultaneously. The retry storm took down both the worker pool and the recovered downstream service.

```go
// WRONG: Backoff calculated from original time
type Job struct {
    ID          string
    EnqueuedAt  time.Time
    Attempts    int
}

func (w *Worker) shouldProcess(job *Job) bool {
    backoff := time.Duration(math.Pow(2, float64(job.Attempts))) * time.Second
    return time.Since(job.EnqueuedAt) > backoff // BUG: Wrong reference point!
}

// CORRECT: Track last attempt, use it for backoff
type Job struct {
    ID              string
    EnqueuedAt      time.Time
    LastAttemptAt   *time.Time
    NextAttemptAt   time.Time
    Attempts        int
}

func (w *Worker) scheduleRetry(ctx context.Context, job *Job, err error) error {
    job.Attempts++
    now := time.Now()
    job.LastAttemptAt = &now

    // Calculate next attempt from NOW, not original enqueue time
    baseDelay := time.Duration(math.Pow(2, float64(job.Attempts))) * time.Second
    if baseDelay > w.maxBackoff {
        baseDelay = w.maxBackoff
    }

    // Add jitter to prevent thundering herd
    jitter := time.Duration(rand.Int64N(int64(baseDelay) / 4))
    job.NextAttemptAt = now.Add(baseDelay + jitter)

    // Don't retry forever
    if job.Attempts >= w.maxAttempts {
        return w.moveToDeadLetter(ctx, job, err)
    }

    return w.queue.ScheduleAt(ctx, job, job.NextAttemptAt)
}

func (w *Worker) dequeueWithBackoff(ctx context.Context) (*Job, error) {
    // Only fetch jobs whose NextAttemptAt has passed
    return w.db.QueryRowContext(ctx, `
        SELECT id, payload, attempts, next_attempt_at
        FROM jobs
        WHERE status = 'pending'
          AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    `).Scan(...)
}
```

### The Dead Letter Queue Black Hole

**The Incident**: A logistics company had a sophisticated DLQ system. Jobs that failed 5 times were moved to DLQ for manual inspection. Over 18 months, the DLQ grew to 12 million messages. When they finally audited it, they found 89% were a single bug (fixed 16 months ago) and 8% were from a deprecated API version. The real issue: nobody was monitoring DLQ growth, and there was no process for reviewing or purging old entries.

```go
// WRONG: DLQ as a write-only black hole
func (w *Worker) moveToDeadLetter(ctx context.Context, job *Job, err error) {
    w.dlq.Enqueue(ctx, &DeadLetter{
        Job:     job,
        Error:   err.Error(),
        MovedAt: time.Now(),
    })
    // That's it. Job disappears forever.
}

// CORRECT: DLQ with categorization, TTL, and alerting
func (w *Worker) moveToDeadLetter(ctx context.Context, job *Job, err error) error {
    category := w.categorizeError(err)

    dl := &DeadLetter{
        Job:       job,
        Error:     err.Error(),
        Category:  category,
        MovedAt:   time.Now(),
        ExpiresAt: time.Now().Add(30 * 24 * time.Hour), // 30-day TTL
    }

    if err := w.dlq.Enqueue(ctx, dl); err != nil {
        return err
    }

    // Track DLQ metrics by category
    w.metrics.DeadLetterAdded(category)

    // Alert on new error categories or sudden spikes
    recentCount, _ := w.dlq.CountByCategory(ctx, category, 1*time.Hour)
    if recentCount > w.alertThreshold[category] {
        w.alerter.Alert(ctx, AlertDeadLetterSpike{
            Category: category,
            Count:    recentCount,
            Sample:   dl,
        })
    }

    return nil
}

// Run periodic DLQ maintenance
func (w *Worker) dlqMaintenance(ctx context.Context) {
    // Daily: Clean expired entries
    go w.runDaily(ctx, w.dlq.PurgeExpired)

    // Weekly: Generate DLQ report
    go w.runWeekly(ctx, func(ctx context.Context) error {
        report := w.dlq.GenerateReport(ctx)
        return w.notifier.SendDLQReport(ctx, report)
    })

    // Continuous: Monitor DLQ depth
    go func() {
        ticker := time.NewTicker(5 * time.Minute)
        for range ticker.C {
            depth, _ := w.dlq.Depth(ctx)
            w.metrics.DLQDepth(depth)
        }
    }()
}

func (w *Worker) categorizeError(err error) string {
    switch {
    case errors.Is(err, ErrValidation):
        return "validation"
    case errors.Is(err, ErrRateLimit):
        return "rate_limit"
    case errors.Is(err, ErrTimeout):
        return "timeout"
    case errors.Is(err, ErrNotFound):
        return "not_found"
    case isTemporary(err):
        return "temporary"
    default:
        return "unknown"
    }
}
```

### The Job Ordering Assumption

**The Incident**: An event sourcing system used a job queue to process domain events. The team assumed events would be processed in order. But with multiple workers dequeuing concurrently, a "UserDeleted" event occasionally processed before "UserCreated." The delete was a no-op (user didn't exist), then the create succeeded, leaving zombie users in the system. It took 6 months to notice the data inconsistency.

```go
// WRONG: Assuming job ordering in a concurrent queue
func (w *Worker) processEvent(ctx context.Context, event *Event) error {
    switch event.Type {
    case "UserCreated":
        return w.createUser(ctx, event.Data)
    case "UserDeleted":
        return w.deleteUser(ctx, event.Data) // May run before create!
    }
    return nil
}

// CORRECT: Event versioning and ordering guarantees
type Event struct {
    AggregateID string
    Version     int64 // Monotonically increasing per aggregate
    Type        string
    Data        json.RawMessage
}

func (w *Worker) processEvent(ctx context.Context, event *Event) error {
    // Use distributed lock per aggregate to ensure ordering
    lock, err := w.locker.Lock(ctx, "aggregate:"+event.AggregateID, 5*time.Minute)
    if err != nil {
        return err // Will retry
    }
    defer lock.Unlock(ctx)

    // Check if we've already processed this or a later version
    lastVersion, err := w.getLastProcessedVersion(ctx, event.AggregateID)
    if err != nil {
        return err
    }

    if event.Version <= lastVersion {
        // Already processed or out of order - skip
        log.Info("skipping already-processed event",
            "aggregate", event.AggregateID,
            "version", event.Version,
            "lastProcessed", lastVersion)
        return nil
    }

    if event.Version > lastVersion+1 {
        // Gap detected - requeue and wait for missing events
        return ErrEventGap{
            Expected: lastVersion + 1,
            Got:      event.Version,
        }
    }

    // Process in order
    if err := w.applyEvent(ctx, event); err != nil {
        return err
    }

    // Record processed version
    return w.setLastProcessedVersion(ctx, event.AggregateID, event.Version)
}
```

### Quick Reference: Background Worker Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Silent worker death | Jobs stop processing, no errors | Recover panics, health checks |
| Thundering herd | System overload on restart | Staggered startup, backpressure |
| Visibility timeout | Duplicate job processing | Heartbeat/extend visibility |
| Retry storms | Sudden spike after recovery | Backoff from last attempt, jitter |
| DLQ black hole | Ever-growing unreviewed queue | TTL, categorization, alerts |
| Ordering assumptions | Data inconsistencies | Aggregate locking, versioning |
| Memory leaks | Worker OOM over time | Bounded job data, streaming |
| Lost jobs | Jobs disappear without trace | Transactional dequeue, audit log |

### Junior to FAANG: pattern-match these incidents to your own code

Each incident in this section has the same structure. Ignored failure mode, silent compounding over weeks or months, then catastrophic surface. Juniors learn by reading these stories, but the real skill is pattern-matching them to code you are about to ship.

Checklist to run against any new worker code before merge.

1. Silent panic. Does every goroutine have `defer recover()`. Is the recovery path recorded in a metric that alerts on non-zero.
2. Thundering herd. On worker startup, is there jitter or staged start. On downstream recovery, is the retry queue paced to avoid overwhelming the downstream.
3. Visibility timeout. Is the timeout larger than P99.9 handler latency plus safety margin. Is there a heartbeat extending it during long runs.
4. Retry storm. Is backoff computed from last_attempt_at, not enqueue time. Is jitter applied. Is there a global rate limit on retries during recovery.
5. DLQ black hole. Is there alerting on DLQ arrival rate. Is there a TTL or archive policy. Does someone look at the DLQ weekly.
6. Ordering. Does the system assume FIFO where the transport does not provide it. If ordering is required, is there a per-aggregate key or single-partition consumer.
7. Memory leak. Is payload size bounded. Is buffered data streamed rather than materialized.
8. Lost jobs. Is enqueue transactional with the business write, or via outbox.

Walkthrough for your first incident response. A page fires at 2am. "Queue depth growing." Open the runbook (if one exists). First question. Is enqueue rate spiking, is dequeue rate dropping, or both. Metrics answer this in one glance. If enqueue spike, is an upstream attack or legitimate traffic. If dequeue drop, are workers healthy, are they blocked on downstream, are they OOM-killed. Evidence before action. Do not add workers until you know why dequeue dropped.

Interview entry point. "Walk me through a time you debugged a queue incident." If you do not have one, walk through one of these case studies as if it had happened to you, but label it as a thought experiment. Interviewers respect honesty.

### Senior at FAANG: systematizing the lessons from these incidents

Staff engineers do not fix incidents one-by-one. They consolidate the lessons into platform-level prevention. For each pitfall above, the platform pattern.

**Silent worker death.** Platform SDK panics elevated to structured log plus metric plus alert. No handler in prod can run without the middleware. The per-worker health endpoint returns 500 if the goroutine count drops below configured, so Kubernetes restarts the pod. No team can regress this because the SDK enforces it.

**Thundering herd on restart.** Platform provides startup jitter by default. Every worker delays a random 0 to 30 seconds on boot before first dequeue. Additionally, a global rate limiter per downstream API coordinates across all workers via a shared token bucket (typically in Redis or via envoy rate limit service). When the downstream is recovering, all workers back off in sync.

**Visibility timeout trap.** Platform SDK heartbeats automatically. Handler authors never call `extendVisibility`. The SDK spawns a lease-renewal goroutine per job. Lease duration and renewal interval are config-driven. Handlers can observe lease-lost via ctx cancellation, and are required to checkpoint or abort.

**Retry storm amplification.** Platform SDK implements decorrelated jitter (AWS recommended) and always computes delay from `last_attempt_at`. Handler-level retry policies are declarative, so a bug in one handler's retry math is impossible. Additionally, the platform implements a global rate-limit on the retry path specifically. When 1M jobs become eligible simultaneously, the dispatcher paces them at a configured rate (e.g. 10k/s) so downstream is protected.

**DLQ black hole.** Platform DLQ product implements triage SLA, arrival rate alerts, and forced aging (items past 90 days are auto-archived to cold storage). Teams have a weekly DLQ digest in their on-call email. Un-triaged items past SLA open a ticket automatically.

**Ordering assumption.** Platform supports two delivery modes. Default is at-least-once unordered, where handlers must be idempotent and order-insensitive. Ordered mode pins `(aggregate_id)` to a single consumer via consistent-hash partitioning, with idempotency still required for retries. Teams must declare mode at registration time. No "oh, I assumed order" surprises.

**Memory leak.** Platform enforces max payload size (typically 64KB) at enqueue. Larger payloads must use S3 pointer. SDK streams payload from S3 to handler as io.Reader, so handlers cannot accidentally materialize.

**Lost jobs.** Platform provides transactional enqueue via the SDK. Producers call `EnqueueInTx(tx, job)` inside their business transaction. The SDK uses outbox for non-Postgres-backed queues or direct insert for Postgres-backed. Dual-write lossy patterns are impossible.

**Staff-level incident retrospective template.**

1. Impact (users affected, duration, severity tier).
2. Timeline with decision points and time-to-detect, time-to-mitigate, time-to-resolve.
3. Root cause, technical.
4. Root cause, systemic (why did the technical cause slip through).
5. What alerts fired, what should have fired, what was missing.
6. Action items. Each has, owner, due date, priority, and whether it is a handler fix or platform fix.
7. Prevention. What platform change would make this class of bug impossible.

The prevention section is where staff engineers earn their level. Handler fixes help one team. Platform fixes help every team.

**Incident command pattern.** Large-scale queue SEVs have a specific incident command pattern.

- Incident commander. Coordinates, not technical debugger.
- Ops lead. Runs queue and infra commands.
- Communications lead. Updates status page, liaises with customer success.
- Subject-matter expert. Usually the on-call who owns the misbehaving job_type.

The platform team provides on-call SME support for queue platform issues. The owning team provides SME for specific job_types. Clear escalation path prevents the common failure where "queue team" and "product team" each assume the other owns the fix.

**Year-over-year trend analysis.** Every year, the platform team categorizes all queue SEVs into these pitfall buckets. If 40% are "thundering herd", the next year's roadmap prioritizes global rate limiting. If 30% are DLQ neglect, prioritize triage SLA tooling. Data-driven roadmap, not opinion-driven.

**ADR template, adopting uniform retry policy.** Status, accepted. Context, 5 teams had retry-storm incidents in 2025. Each had hand-rolled retry. Decision, mandatory SDK retry policy with decorrelated jitter. Override allowed only via versioned policy registration. Consequences, handler authors cannot regress. Incident correlation across teams becomes possible.

**War game scenarios.** Annually, chaos-engineer these pitfalls.

- Inject a 30-minute downstream outage. Measure retry storm magnitude on recovery. Adjust pacing.
- Kill all workers simultaneously. Measure restart behavior. Verify staged restart prevents herd.
- Inject payload that always panics. Verify DLQ routing within max_attempts plus lease window.
- Inject a slow handler that exceeds visibility timeout. Verify heartbeat renewal or detection of lease loss.

Teams that pass the war game get a gold star. Teams that fail get a remediation ticket. This is the muscle that prevents repeat incidents.

---
