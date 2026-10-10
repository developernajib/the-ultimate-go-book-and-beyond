## 83C.13 Mock Interview Session 5: Google L5 System Design - Distributed Task Scheduler

### Interviewer Briefing

**Company style:** Google. L5 System Design. The interviewer expects the candidate to drive the conversation, clarify requirements proactively, perform capacity estimation, and make principled trade-offs. Google interviewers heavily weight the candidate's ability to navigate ambiguity and reason about consistency vs. availability.

**Level:** L5 (Staff Software Engineer)

**Interview duration:** 45 minutes

**Key evaluation criteria:** Requirements gathering, capacity estimation, component design, trade-off analysis, scalability, fault tolerance, and monitoring.

### Problem Statement

*Read this to the candidate (or read it yourself and start the timer):*

> Design a distributed task scheduler that can handle 50,000 jobs per second. The system should support:
>
> - One-time tasks (execute at a specific future time)
> - Recurring tasks (cron-like scheduling with second-level granularity)
> - Priority-based execution (critical, high, normal, low)
> - Task dependencies (task B runs only after task A completes)
> - At-least-once execution guarantee
> - Dead letter queues for failed tasks
> - Real-time monitoring and alerting
>
> Assume you are building this for a large-scale platform (think Google Cloud Scheduler competitor). The system will be used by thousands of internal teams and external customers.

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| [0:00]-[2:00] | Read & Clarify | Candidate reads the problem and begins asking clarifying questions |
| [2:00]-[8:00] | Requirements & Estimation | Candidate defines functional and non-functional requirements, performs back-of-envelope math |
| [8:00]-[12:00] | High-Level Architecture | Candidate draws major components and data flow |
| [12:00]-[25:00] | Detailed Component Design | Deep dive into scheduler engine, queue management, worker fleet |
| [25:00]-[35:00] | Deep Dive on Trade-offs | Consistency model, failure handling, scaling bottlenecks |
| [35:00]-[40:00] | Monitoring & Operations | Observability, alerting, deployment strategy |
| [40:00]-[45:00] | Follow-up Questions | Interviewer probes specific design decisions |

### Interviewer Script & Candidate Response

**[0:00] Interviewer:** *"Thanks for joining. Today we'll design a distributed task scheduler. I'll read the problem statement, and then I'd love to hear you drive the design. Take a minute to read through the requirements."*

**[1:30] Candidate:** "Before I start designing, I'd like to clarify a few things. When you say 50,000 jobs per second, is that the ingestion rate - meaning 50K new jobs submitted per second - or the execution throughput?"

**[1:45] Interviewer:** *"Good question. Let's say 50K jobs submitted per second, and the system should be able to execute at roughly that same rate during peak. Some jobs may be scheduled far in the future."*

**[2:00] Candidate:** "Got it. A few more clarifying questions:
1. What's the typical job payload size? Are we storing the actual work to execute, or just metadata that points to an external system?
2. What's the maximum delay tolerance? If a job is scheduled for 2:00:00 PM, is it acceptable if it fires at 2:00:03 PM?
3. For recurring tasks, do we need catch-up execution if the system was down? For example, if a minutely cron missed 5 minutes, should it fire 5 times on recovery?
4. What's the expected retention period for completed job history?"

**[2:30] Interviewer:** *"Great questions. Jobs are metadata-only - typically under 1 KB, pointing to an RPC endpoint or message queue topic. Delay tolerance is under 5 seconds for normal priority, under 1 second for critical. Yes, catch-up is required for recurring tasks. Retain completed history for 30 days."*

**[3:00] Candidate:** "Let me do some capacity estimation:

- **Ingestion:** 50K jobs/sec × 1 KB = 50 MB/sec inbound
- **Daily volume:** 50K × 86,400 = ~4.3 billion jobs/day
- **30-day retention:** 4.3B × 30 = ~129 billion records
- **Storage:** 129B × 1 KB = ~129 TB for metadata alone
- **Recurring tasks:** If 10% are recurring with minutely frequency, that's 500K recurring definitions generating 500K triggers/minute = ~8.3K additional executions/sec
- **Total peak throughput:** ~58K executions/sec, let's design for 100K/sec with headroom

For the database, we'll need partitioning by time. For the queue, at 100K/sec we need a system like Kafka which handles millions of messages per second per cluster."

**[5:00] Interviewer:** *"Those numbers look reasonable. Go ahead with the high-level architecture."*

**[5:30] Candidate:** "Here's the high-level architecture with five major components:

**1. API Gateway & Job Ingestion Service**
- REST/gRPC API for job submission, cancellation, and status queries
- Validates job definitions, assigns job IDs (ULIDs for time-sortability)
- Writes job metadata to PostgreSQL (partitioned by scheduled_time)
- Publishes a 'job-created' event to Kafka

**2. Scheduler Engine (Time-Based Trigger Service)**
- Multiple instances, each owning a partition of the time range (consistent hashing on job ID)
- Scans PostgreSQL for jobs whose scheduled_time is within the next execution window (e.g., 30 seconds ahead)
- Moves ready-to-execute jobs into priority-specific Kafka topics
- Uses Redis sorted sets as a near-time index for sub-second scheduling precision
- Handles recurring task expansion: when a cron job fires, immediately computes and inserts the next occurrence

**3. Priority Queue Layer (Kafka)**
- Four topic partitions per priority level: `tasks.critical`, `tasks.high`, `tasks.normal`, `tasks.low`
- Critical and high topics get more consumer instances for faster drain
- Kafka consumer groups provide automatic partition rebalancing

**4. Worker Fleet (Execution Service)**
- Stateless Go workers consuming from Kafka topics
- Each worker: picks a task, calls the target RPC endpoint, reports success/failure
- Implements circuit breakers per target endpoint
- Reports execution results back to Kafka (`task-results` topic)

**5. Result Processor & Dependency Manager**
- Consumes from `task-results` topic
- Updates job status in PostgreSQL
- For failed tasks: implements retry with exponential backoff, moves to DLQ after max retries
- For dependency chains: checks if downstream tasks are now unblocked, enqueues them"

**[8:00] Interviewer:** *"Good overview. Let's go deeper into the scheduler engine. How do you ensure exactly-once triggering at 50K jobs/sec? What happens if a scheduler instance crashes mid-scan?"*

**[8:30] Candidate:** "This is the core challenge. Let me walk through the mechanism:

The scheduler engine uses a **lease-based ownership model**:

```go
// MetricsClient abstracts Prometheus metric emission.
type MetricsClient interface {
    Counter(name string) prometheus.Counter
    Histogram(name string) prometheus.Observer
}

// SchedulerEngine manages time-partitioned job scanning
type SchedulerEngine struct {
    instanceID   string
    redisClient  *redis.Client
    db           *sql.DB
    kafkaWriter  *kafka.Writer
    leaseManager *LeaseManager
    metrics      MetricsClient
}

// LeaseManager handles distributed locking for time partitions
type LeaseManager struct {
    redisClient *redis.Client
    leaseTTL    time.Duration
    instanceID  string
}

// AcquirePartitionLease attempts to claim ownership of a time partition.
// Returns true if the lease was acquired, false if another instance holds it.
func (lm *LeaseManager) AcquirePartitionLease(ctx context.Context, partitionKey string) (bool, error) {
    // Use Redis SET NX with expiry for distributed locking
    key := fmt.Sprintf("scheduler:lease:%s", partitionKey)
    ok, err := lm.redisClient.SetNX(ctx, key, lm.instanceID, lm.leaseTTL).Result()
    if err != nil {
        return false, fmt.Errorf("acquiring lease for partition %s: %w", partitionKey, err)
    }
    return ok, nil
}

// RenewLease extends the lease TTL if this instance still owns it.
func (lm *LeaseManager) RenewLease(ctx context.Context, partitionKey string) error {
    key := fmt.Sprintf("scheduler:lease:%s", partitionKey)
    // Lua script ensures atomic check-and-extend
    script := redis.NewScript(`
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            redis.call("PEXPIRE", KEYS[1], ARGV[2])
            return 1
        end
        return 0
    `)
    result, err := script.Run(ctx, lm.redisClient, []string{key}, lm.instanceID, lm.leaseTTL.Milliseconds()).Int()
    if err != nil {
        return fmt.Errorf("renewing lease for partition %s: %w", partitionKey, err)
    }
    if result == 0 {
        return fmt.Errorf("lease lost for partition %s", partitionKey)
    }
    return nil
}
```

Time is divided into 1-second buckets. Each scheduler instance claims buckets via Redis leases. The scan process:

1. **Claim a time bucket** (e.g., `2024-01-15T10:30:45`) via Redis SET NX
2. **Query PostgreSQL** for all jobs where `scheduled_time` falls in that bucket
3. **Publish each job** to the appropriate Kafka priority topic with idempotency keys
4. **Mark the bucket as processed** in Redis with a completion flag
5. **Renew the lease** periodically while processing

If an instance crashes mid-scan, the lease expires (TTL = 30 seconds), and another instance picks up the bucket. Since Kafka producers use idempotency keys (job_id + scheduled_time), duplicate publishes are deduplicated.

```go
// Job represents a scheduled work item.
type Job struct {
    ID             string
    Payload        []byte
    Priority       string
    TargetEndpoint string
    IdempotencyKey string
}

// ScanAndDispatch processes all jobs in a given time bucket.
func (se *SchedulerEngine) ScanAndDispatch(ctx context.Context, bucket time.Time) error {
    partitionKey := bucket.Format("2006-01-02T15:04:05")

    acquired, err := se.leaseManager.AcquirePartitionLease(ctx, partitionKey)
    if err != nil {
        return fmt.Errorf("lease acquisition: %w", err)
    }
    if !acquired {
        return nil // Another instance is handling this bucket
    }

    // Start lease renewal goroutine
    renewCtx, cancelRenew := context.WithCancel(ctx)
    defer cancelRenew()
    go se.renewLeaseLoop(renewCtx, partitionKey)

    // Query jobs for this time bucket. The partition lease acquired above is
    // what provides mutual exclusion between scheduler instances: a
    // FOR UPDATE SKIP LOCKED here would be decorative, because outside a
    // transaction Postgres releases the row locks the moment the SELECT
    // returns. Idempotency keys on dispatch make redelivery safe anyway.
    rows, err := se.db.QueryContext(ctx, `
        SELECT job_id, payload, priority, target_endpoint, idempotency_key
        FROM scheduled_jobs
        WHERE scheduled_time >= $1 AND scheduled_time < $2
          AND status = 'pending'
        ORDER BY priority DESC
    `, bucket, bucket.Add(time.Second))
    if err != nil {
        return fmt.Errorf("querying jobs for bucket %s: %w", partitionKey, err)
    }
    defer rows.Close()

    var dispatched int
    for rows.Next() {
        var job Job
        if err := rows.Scan(&job.ID, &job.Payload, &job.Priority, &job.TargetEndpoint, &job.IdempotencyKey); err != nil {
            se.metrics.Counter("scan_errors_total").Inc()
            continue
        }

        topic := fmt.Sprintf("tasks.%s", job.Priority)
        msg := kafka.Message{
            Topic: topic,
            Key:   []byte(job.ID),
            Value: job.Payload,
            Headers: []kafka.Header{
                {Key: "idempotency_key", Value: []byte(job.IdempotencyKey)},
                {Key: "target_endpoint", Value: []byte(job.TargetEndpoint)},
            },
        }

        if err := se.kafkaWriter.WriteMessages(ctx, msg); err != nil {
            se.metrics.Counter("dispatch_errors_total").Inc()
            return fmt.Errorf("dispatching job %s: %w", job.ID, err)
        }
        dispatched++
    }

    se.metrics.Histogram("bucket_dispatch_count").Observe(float64(dispatched))
    return nil
}

// renewLeaseLoop continuously renews the lease until context is canceled.
func (se *SchedulerEngine) renewLeaseLoop(ctx context.Context, partitionKey string) {
    ticker := time.NewTicker(se.leaseManager.leaseTTL / 3)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := se.leaseManager.RenewLease(ctx, partitionKey); err != nil {
                log.Printf("WARN: lease renewal failed for %s: %v", partitionKey, err)
                return
            }
        }
    }
}
```

**[12:00] Interviewer:** *"I like the lease-based approach. How do you handle the dependency graph? If task B depends on task A, and task A fails, what happens?"*

**[12:30] Candidate:** "For task dependencies, I model this as a DAG (Directed Acyclic Graph):

```go
// JobDependency represents an edge in the dependency DAG.
type JobDependency struct {
    JobID        string
    DependsOnID  string
    Status       string // pending, satisfied, failed
}

// DependencyManager resolves task dependencies and unblocks downstream tasks.
type DependencyManager struct {
    db          *sql.DB
    kafkaWriter *kafka.Writer
}

// OnTaskCompleted is called when a task finishes execution.
// It checks if any downstream tasks are now unblocked.
func (dm *DependencyManager) OnTaskCompleted(ctx context.Context, jobID string, success bool) error {
    tx, err := dm.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback()

    if !success {
        // Mark all transitive dependents as 'blocked'
        _, err = tx.ExecContext(ctx, `
            WITH RECURSIVE downstream AS (
                SELECT job_id FROM job_dependencies WHERE depends_on_id = $1
                UNION
                SELECT jd.job_id FROM job_dependencies jd
                JOIN downstream d ON jd.depends_on_id = d.job_id
            )
            UPDATE scheduled_jobs SET status = 'dependency_failed'
            WHERE job_id IN (SELECT job_id FROM downstream)
        `, jobID)
        if err != nil {
            return fmt.Errorf("marking downstream tasks as blocked: %w", err)
        }
        return tx.Commit()
    }

    // Mark this dependency as satisfied
    _, err = tx.ExecContext(ctx, `
        UPDATE job_dependencies SET status = 'satisfied'
        WHERE depends_on_id = $1
    `, jobID)
    if err != nil {
        return fmt.Errorf("updating dependency status: %w", err)
    }

    // Find tasks where ALL dependencies are now satisfied
    rows, err := tx.QueryContext(ctx, `
        SELECT sj.job_id, sj.payload, sj.priority, sj.target_endpoint
        FROM scheduled_jobs sj
        WHERE sj.status = 'waiting_on_dependencies'
          AND NOT EXISTS (
            SELECT 1 FROM job_dependencies jd
            WHERE jd.job_id = sj.job_id AND jd.status != 'satisfied'
          )
        FOR UPDATE SKIP LOCKED
    `)
    if err != nil {
        return fmt.Errorf("finding unblocked tasks: %w", err)
    }
    defer rows.Close()

    for rows.Next() {
        var job Job
        if err := rows.Scan(&job.ID, &job.Payload, &job.Priority, &job.TargetEndpoint); err != nil {
            continue
        }

        // Dispatch the unblocked task to Kafka
        topic := fmt.Sprintf("tasks.%s", job.Priority)
        msg := kafka.Message{
            Topic: topic,
            Key:   []byte(job.ID),
            Value: job.Payload,
        }
        if err := dm.kafkaWriter.WriteMessages(ctx, msg); err != nil {
            return fmt.Errorf("dispatching unblocked job %s: %w", job.ID, err)
        }

        // Update status to 'dispatched'
        _, err = tx.ExecContext(ctx, `
            UPDATE scheduled_jobs SET status = 'dispatched' WHERE job_id = $1
        `, job.ID)
        if err != nil {
            return fmt.Errorf("updating job status: %w", err)
        }
    }

    return tx.Commit()
}
```

When task A fails:
1. All direct and transitive dependents are marked `dependency_failed`
2. An alert is sent to the job owner
3. The owner can either retry task A (which re-evaluates the chain) or manually override the dependency

For cycle detection, we validate the DAG at job submission time:

```go
// ValidateDAG checks for cycles when adding a new dependency.
func (dm *DependencyManager) ValidateDAG(ctx context.Context, jobID, dependsOnID string) error {
    // Check if adding this edge would create a cycle
    var cycleExists bool
    err := dm.db.QueryRowContext(ctx, `
        WITH RECURSIVE ancestors AS (
            SELECT depends_on_id FROM job_dependencies WHERE job_id = $1
            UNION
            SELECT jd.depends_on_id FROM job_dependencies jd
            JOIN ancestors a ON jd.job_id = a.depends_on_id
        )
        SELECT EXISTS(SELECT 1 FROM ancestors WHERE depends_on_id = $2)
    `, dependsOnID, jobID).Scan(&cycleExists)
    if err != nil {
        return fmt.Errorf("cycle detection query: %w", err)
    }
    if cycleExists {
        return fmt.Errorf("adding dependency %s -> %s would create a cycle", jobID, dependsOnID)
    }
    return nil
}
```

**[18:00] Interviewer:** *"Let's talk about the worker fleet. How do you handle backpressure when workers can't keep up with the ingestion rate?"*

**[18:30] Candidate:** "Backpressure is handled at multiple levels:

**Level 1: Kafka Consumer Lag Monitoring**
- Each worker group exposes consumer lag metrics
- When lag exceeds threshold (e.g., >10 seconds for critical tasks), autoscaler adds worker instances
- Kubernetes HPA scales on custom Kafka lag metrics

**Level 2: Admission Control at the API Gateway**
- Rate limiting per tenant using token bucket algorithm in Redis
- When system-wide queue depth exceeds capacity, return HTTP 429 with Retry-After header
- Shed low-priority traffic first: critical and high tasks are always admitted

**Level 3: Worker-Level Circuit Breakers**

```go
// Task represents a unit of work dispatched to a worker.
type Task struct {
    ID             string
    TargetEndpoint string
    Payload        []byte
    Priority       string
    RetryCount     int
}

// Worker processes tasks from Kafka and executes them against target endpoints.
type Worker struct {
    consumer       *kafka.Reader
    circuitBreaker map[string]*CircuitBreaker
    mu             sync.RWMutex
    metrics        *prometheus.Registry
    resultWriter   *kafka.Writer
}

// CircuitBreaker tracks failure rates per target endpoint.
type CircuitBreaker struct {
    endpoint     string
    failures     int64
    successes    int64
    state        string // closed, open, half-open
    lastFailure  time.Time
    openDuration time.Duration
}

// Execute runs a single task with circuit breaker protection.
func (w *Worker) Execute(ctx context.Context, task *Task) error {
    cb := w.getOrCreateBreaker(task.TargetEndpoint)

    if cb.state == "open" {
        if time.Since(cb.lastFailure) < cb.openDuration {
            // Requeue with delay
            w.requeueWithDelay(ctx, task, cb.openDuration)
            return fmt.Errorf("circuit open for endpoint %s", task.TargetEndpoint)
        }
        cb.state = "half-open"
    }

    // Execute the task with timeout
    execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    result, err := w.callEndpoint(execCtx, task)
    if err != nil {
        atomic.AddInt64(&cb.failures, 1)
        if cb.failures > 5 && float64(cb.failures)/float64(cb.failures+cb.successes) > 0.5 {
            cb.state = "open"
            cb.lastFailure = time.Now()
            cb.openDuration = min(cb.openDuration*2, 5*time.Minute)
        }
        return w.handleFailure(ctx, task, err)
    }

    atomic.AddInt64(&cb.successes, 1)
    if cb.state == "half-open" {
        cb.state = "closed"
        cb.failures = 0
        cb.openDuration = 5 * time.Second
    }

    return w.reportSuccess(ctx, task, result)
}

// handleFailure implements retry with exponential backoff and DLQ routing.
func (w *Worker) handleFailure(ctx context.Context, task *Task, execErr error) error {
    task.RetryCount++

    maxRetries := map[string]int{
        "critical": 10,
        "high":     5,
        "normal":   3,
        "low":      1,
    }

    if task.RetryCount >= maxRetries[task.Priority] {
        // Move to Dead Letter Queue
        dlqMsg := kafka.Message{
            Topic: "tasks.dlq",
            Key:   []byte(task.ID),
            Value: task.Payload,
            Headers: []kafka.Header{
                {Key: "original_topic", Value: []byte(fmt.Sprintf("tasks.%s", task.Priority))},
                {Key: "failure_reason", Value: []byte(execErr.Error())},
                {Key: "retry_count", Value: []byte(fmt.Sprintf("%d", task.RetryCount))},
            },
        }
        return w.resultWriter.WriteMessages(ctx, dlqMsg)
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
    delay := time.Duration(1<<uint(task.RetryCount-1)) * time.Second
    w.requeueWithDelay(ctx, task, delay)
    return nil
}
```

**Level 4: Priority-Based Preemption**
- Critical tasks can preempt normal/low workers
- Workers maintain a small local priority queue (size 10)
- If a critical task arrives and all workers are busy with low-priority tasks, the lowest-priority in-progress task is paused and requeued"

**[25:00] Interviewer:** *"What's your data model for PostgreSQL, and how do you handle the 129 TB storage requirement?"*

**[25:30] Candidate:** "The PostgreSQL schema uses time-based partitioning:

```sql
-- Main jobs table, partitioned by scheduled_time
CREATE TABLE scheduled_jobs (
    job_id          TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    payload         JSONB NOT NULL,
    priority        TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
    target_endpoint TEXT NOT NULL,
    scheduled_time  TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT UNIQUE NOT NULL,
    retry_count     INT DEFAULT 0,
    max_retries     INT DEFAULT 3,
    cron_expression TEXT,
    parent_job_id   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (scheduled_time);

-- Create daily partitions (automated via pg_partman)
CREATE TABLE scheduled_jobs_2024_01_15 PARTITION OF scheduled_jobs
    FOR VALUES FROM ('2024-01-15') TO ('2024-01-16');

-- Indexes for the scheduler engine's hot path
CREATE INDEX idx_jobs_pending_time ON scheduled_jobs (scheduled_time, priority)
    WHERE status = 'pending';
CREATE INDEX idx_jobs_tenant ON scheduled_jobs (tenant_id, created_at DESC);
CREATE INDEX idx_jobs_status ON scheduled_jobs (status) WHERE status IN ('pending', 'dispatched', 'running');

-- Dependencies table
CREATE TABLE job_dependencies (
    job_id       TEXT NOT NULL REFERENCES scheduled_jobs(job_id),
    depends_on_id TEXT NOT NULL REFERENCES scheduled_jobs(job_id),
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, depends_on_id)
);

-- Execution history (for monitoring and debugging)
CREATE TABLE job_executions (
    execution_id    TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL,
    worker_id       TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,
    status          TEXT NOT NULL,
    error_message   TEXT,
    duration_ms     INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (started_at);
```

For the 129 TB problem:
1. **Active data in PostgreSQL:** Only pending/running jobs (typically < 1 hour of data) - roughly 50K/sec × 3600s × 1KB = ~180 GB
2. **Recent history in PostgreSQL:** Last 7 days of completed jobs for quick lookups - ~3 TB
3. **Cold storage:** Jobs older than 7 days are archived to object storage (S3/GCS) via a background archival service, with a metadata index in PostgreSQL pointing to the archive location
4. **30-day queryable history:** Use a columnar store like ClickHouse for analytics queries on historical data

This tiered storage approach keeps PostgreSQL lean (~3 TB) while maintaining 30-day queryability."

**[30:00] Interviewer:** *"How would you monitor this system? What alerts would you set up?"*

**[30:30] Candidate:** "Monitoring follows the USE (Utilization, Saturation, Errors) and RED (Rate, Errors, Duration) methodologies:

**Key Metrics:**
- `scheduler.jobs.submitted_rate` - Jobs submitted per second, by priority
- `scheduler.jobs.executed_rate` - Jobs executed per second
- `scheduler.jobs.latency_p99` - Time from scheduled_time to actual execution
- `scheduler.jobs.failure_rate` - Failed executions / total executions
- `scheduler.kafka.consumer_lag` - Per topic, per consumer group
- `scheduler.workers.utilization` - Active workers / total workers
- `scheduler.dlq.depth` - Dead letter queue size
- `scheduler.dependencies.blocked_count` - Tasks waiting on failed dependencies

**Critical Alerts:**
1. `scheduler.jobs.latency_p99 > 5s` for critical priority (page on-call)
2. `scheduler.kafka.consumer_lag > 60s` for any priority (page on-call)
3. `scheduler.dlq.depth` increasing by >100/minute (notify team)
4. `scheduler.workers.utilization > 0.9` for >5 minutes (autoscale trigger)
5. Any scheduler engine instance lease renewal failure (potential scheduling gap)

**Dashboards:**
- Real-time: Job throughput, execution latency heatmap, error rates
- Operational: Worker fleet status, Kafka partition health, PostgreSQL query latency
- Business: Per-tenant usage, SLA compliance (% of jobs executed within tolerance)"

**[35:00] Interviewer:** *"What if you needed to support exactly-once execution instead of at-least-once? How would the design change?"*

**[35:30] Candidate:** "Exactly-once is fundamentally harder and more expensive. The changes:

1. **Idempotency at the worker level:** Each worker must check a distributed deduplication store (Redis SET NX with the job's idempotency key) before executing. If the key exists, skip execution.

2. **Two-phase execution protocol:**
 - Phase 1: Worker claims the job (Redis SET NX with TTL)
 - Phase 2: Worker executes and reports result
 - If the worker crashes between phases, the TTL expires and another worker can claim it - but we need the target endpoint to also be idempotent

3. **Kafka exactly-once semantics:** Enable `enable.idempotence=true` and use transactional producers. This ensures each message is written exactly once to Kafka, but the consumer side still needs deduplication.

4. **The honest answer:** True exactly-once across the network boundary (our scheduler → target endpoint) is impossible without the target endpoint cooperating. We can guarantee exactly-once within our system (Kafka + PostgreSQL), but the endpoint must implement idempotency keys. Our API contract should require target endpoints to be idempotent and provide an idempotency key mechanism.

The cost: ~30% throughput reduction due to the distributed locking overhead, and the system is only as exactly-once as the weakest link (the target endpoint)."

**[40:00] Interviewer:** *"Good. One last question: how would you roll out a schema migration on the scheduled_jobs table with zero downtime?"*

**[40:30] Candidate:** "For a zero-downtime migration on a hot table:

1. **Expand-Contract pattern:**
 - Phase 1 (Expand): Add new columns with defaults, no NOT NULL constraints yet
 - Phase 2 (Dual-write): Deploy application code that writes to both old and new columns
 - Phase 3 (Backfill): Background job fills new columns for existing rows (batched, throttled)
 - Phase 4 (Verify): Confirm all rows are migrated
 - Phase 5 (Contract): Switch reads to new columns, add NOT NULL constraints, drop old columns

2. **For PostgreSQL specifically:**
 - Use `ALTER TABLE ... ADD COLUMN` with a default - this is instant in PostgreSQL 11+ (no table rewrite)
 - Never use `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` on a large table without a CHECK constraint first (the CHECK is validated without an ACCESS EXCLUSIVE lock in PG 12+)
 - Use `CREATE INDEX CONCURRENTLY` for any new indexes

3. **For partitioned tables:**
 - New partitions automatically get the new schema
 - Old partitions need `ALTER TABLE partition_name ADD COLUMN` - fast since partitions are smaller
 - The archival service handles migrating cold partitions during the next archive cycle"

### Scoring Rubric

| Dimension | 1 (Poor) | 3 (Meets Bar) | 5 (Exceptional) |
|-----------|----------|----------------|------------------|
| **Requirements & Estimation** | No clarifying questions, no estimation | Asks 2-3 questions, performs basic estimation | Thorough requirements, accurate estimation with headroom, identifies hidden requirements |
| **High-Level Design** | Missing major components, unclear data flow | All major components present, reasonable data flow | Elegant decomposition, clear separation of concerns, justifies each component |
| **Detailed Design** | Vague hand-waving, no concrete mechanisms | Concrete mechanisms for scheduling, queuing, execution | Production-grade detail with code, handles edge cases, race conditions, and failure modes |
| **Trade-off Analysis** | Cannot explain trade-offs when asked | Identifies obvious trade-offs (CAP, cost vs. latency) | Proactively raises trade-offs, quantifies impact, offers alternatives with clear reasoning |
| **Scalability & Fault Tolerance** | Single points of failure, no scaling plan | Basic horizontal scaling, identifies SPOFs | Multi-level fault tolerance, graceful degradation, tested scaling strategy |
| **Monitoring & Operations** | No mention of observability | Basic metrics and alerts | Comprehensive USE/RED metrics, tiered alerting, runbook-ready operational plan |

**Scoring thresholds:**
- **Strong Hire:** Average ≥ 4.0 across all dimensions
- **Hire:** Average ≥ 3.0, no dimension below 2
- **Lean No Hire:** Average ≥ 2.5, one or more dimensions below 2
- **No Hire:** Average < 2.5 or any dimension scored 1


### Junior → FAANG: Google L5 Distributed System Design Mock Basics

A Google L5 system design interview evaluates your ability to design a correct, scalable distributed system with reasonable technology choices. The evaluation bar at L5 includes: covering all major system components, making defensible technology selections, estimating capacity at a reasonable level of detail, and communicating your design clearly. The most common L5 gaps are incomplete coverage (missing the caching layer or the message queue) and lack of capacity reasoning that connects to design decisions.

### Senior @ FAANG: Google L5 System Design: What Separates L5 from L6 Answers

The specific signals that separate an L5 from an L6 answer in a Google system design interview: at L5, you design a correct system and justify major choices. At L6, you also drive the conversation toward the most interesting technical problems, proactively surface the hardest trade-offs before being asked, demonstrate knowledge of the failure modes at each component, and show awareness of the operational requirements (monitoring, alerting, runbooks, capacity planning). The bar-raiser signal at L6 is also the candidate's ability to challenge the requirements: 'I want to confirm that strict ordering is required, because relaxing to causal ordering significantly simplifies the design and improves throughput.' This kind of requirements negotiation, done respectfully, is a strong L6 indicator.

---
