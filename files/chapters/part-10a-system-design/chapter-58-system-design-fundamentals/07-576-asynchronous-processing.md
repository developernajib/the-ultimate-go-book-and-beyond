## 58.6 Asynchronous Processing

### Message Queue Patterns

Message queues decouple producers from consumers temporally and spatially, allowing each to scale independently and absorb traffic bursts without cascading failures. The point-to-point (work queue) pattern ensures each message is processed by exactly one consumer, making it ideal for background job processing. The publish-subscribe pattern delivers each message to all subscribed consumers, enabling event-driven architectures where multiple downstream systems react to the same event. Selecting the right pattern depends on whether downstream consumers need the same data independently (pub/sub) or whether the work should be distributed across competing consumers (work queue).

```
1. POINT-TO-POINT (Work Queue)
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   Producer → [Queue] → Consumer                          │
│                                                          │
│   Each message processed by exactly one consumer         │
│   Use for: Background jobs, order processing             │
│                                                          │
└──────────────────────────────────────────────────────────┘

2. PUBLISH-SUBSCRIBE
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                    ┌─────────────┐                       │
│                    │ Subscriber1 │                       │
│                    └─────────────┘                       │
│   Publisher → [Topic] ─┤                                 │
│                    ┌─────────────┐                       │
│                    │ Subscriber2 │                       │
│                    └─────────────┘                       │
│                                                          │
│   Each message delivered to all subscribers              │
│   Use for: Notifications, event broadcasting             │
│                                                          │
└──────────────────────────────────────────────────────────┘

3. FAN-OUT
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                    ┌─────────────┐                       │
│                    │   Queue1    │ → Consumer1           │
│   Producer → [Exchange] ─┤                               │
│                    │   Queue2    │ → Consumer2           │
│                    └─────────────┘                       │
│                                                          │
│   Message duplicated to multiple queues                  │
│   Use for: Multi-step processing pipelines               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Background Job Processing

Moving long-running work out of the request path is the single most effective way to keep HTTP response times low and prevent thread-pool exhaustion under load. The worker pool here uses a fixed number of goroutines pulling from a shared queue, which bounds memory consumption regardless of how many jobs are enqueued, a critical property when traffic spikes. Failed jobs are retried with exponential backoff (`1 << attempts` seconds) to avoid hammering a temporarily unavailable dependency, and jobs that exhaust their retry budget are routed to a dead-letter queue so they can be inspected and reprocessed without being silently discarded.

```go
// Background job processing system
package worker

import (
    "context"
    "encoding/json"
    "log"
    "time"
)

type Job struct {
    ID        string          `json:"id"`
    Type      string          `json:"type"`
    Payload   json.RawMessage `json:"payload"`
    Priority  int             `json:"priority"`
    MaxRetries int            `json:"max_retries"`
    Attempts  int             `json:"attempts"`
    CreatedAt time.Time       `json:"created_at"`
}

type JobResult struct {
    JobID   string
    Success bool
    Error   error
}

type JobQueue interface {
    Dequeue(ctx context.Context) (Job, error)
    EnqueueDelayed(ctx context.Context, job Job, delay time.Duration) error
    MoveToDLQ(ctx context.Context, job Job) error
}

type Worker struct {
    queue     JobQueue
    handlers  map[string]JobHandler
    workers   int
    results   chan JobResult
}

type JobHandler func(context.Context, Job) error

func NewWorker(queue JobQueue, workers int) *Worker {
    return &Worker{
        queue:    queue,
        handlers: make(map[string]JobHandler),
        workers:  workers,
        results:  make(chan JobResult, 100),
    }
}

func (w *Worker) RegisterHandler(jobType string, handler JobHandler) {
    w.handlers[jobType] = handler
}

func (w *Worker) Start(ctx context.Context) {
    for i := 0; i < w.workers; i++ {
        go w.processJobs(ctx, i)
    }
}

func (w *Worker) processJobs(ctx context.Context, workerID int) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
            job, err := w.queue.Dequeue(ctx)
            if err != nil {
                time.Sleep(100 * time.Millisecond)
                continue
            }

            w.processJob(ctx, job)
        }
    }
}

func (w *Worker) processJob(ctx context.Context, job Job) {
    handler, ok := w.handlers[job.Type]
    if !ok {
        log.Printf("Unknown job type: %s", job.Type)
        return
    }

    // Add timeout
    ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
    defer cancel()

    err := handler(ctx, job)

    if err != nil {
        job.Attempts++
        if job.Attempts < job.MaxRetries {
            // Exponential backoff retry
            delay := time.Duration(1<<job.Attempts) * time.Second
            w.queue.EnqueueDelayed(ctx, job, delay)
        } else {
            // Move to dead letter queue
            w.queue.MoveToDLQ(ctx, job)
        }
    }

    w.results <- JobResult{
        JobID:   job.ID,
        Success: err == nil,
        Error:   err,
    }
}

// Results exposes job outcomes. The caller must drain this channel,
// otherwise workers block once the 100-slot buffer fills.
func (w *Worker) Results() <-chan JobResult {
    return w.results
}
```

### Junior → FAANG: Async Processing Fundamentals for Interviews

Asynchronous processing is tested in almost every FAANG system design interview, usually through a follow-up question: "how would you handle this if the operation takes too long for a synchronous response?" The expected answer structure is: move the work to a background queue, return an accepted response immediately, and use a status endpoint or callback for the caller to learn when the work is done.

The most common prerequisite gap is not knowing the difference between at-least-once delivery and exactly-once processing. Message queues in practice guarantee at-least-once delivery, meaning a message can be delivered more than once (especially after a consumer crash or network timeout). Your application must be designed to handle duplicate messages correctly. The term for this is idempotency: processing the same message twice produces the same result as processing it once. In an interview, when you propose a message queue, follow it immediately with "and my consumer would be idempotent, using the message ID as a deduplication key."

Dead-letter queues are another concept interviewers probe. Know what they are (a queue where messages go after exhausting their retry budget), why they matter (without them, failed messages are silently dropped), and what you do with them in practice (monitor the DLQ depth, alert when it grows, have a reprocessing script ready). A candidate who mentions DLQs without being prompted demonstrates production experience.

Backpressure is an advanced but important concept. If a producer can enqueue messages faster than consumers can process them, the queue will grow unboundedly, eventually causing memory exhaustion or extremely high processing latency. In Go, a buffered channel is the simplest backpressure mechanism: if the buffer is full, the producer blocks. For distributed queues, backpressure means monitoring queue depth and throttling or shedding inbound load before the queue becomes too large to drain in a reasonable time.

### Senior @ FAANG: Async Platform Engineering and Delivery Guarantees

At staff level, asynchronous processing is not just a pattern you apply in a single service. It is a platform capability that affects every team that needs background processing, event fan-out, or service decoupling.

**Delivery guarantee tiers as organizational standards.** Different workloads require different delivery guarantees, and these should be documented at the platform level, not decided per service.
- At-least-once with idempotent consumers: appropriate for most background jobs. Email notifications, analytics events, audit logs.
- Effectively-exactly-once via idempotency keys: appropriate for financial operations, inventory reservation, any operation with a direct monetary or inventory impact. The implementation is at-least-once delivery plus a unique idempotency key stored in the database that prevents duplicate processing.
- Ordered delivery within a partition: required for event sourcing, change data capture, and any case where the order of operations matters. This constrains your queue choice (Kafka partitions guarantee order, SQS standard queues do not).

At L6, you define which tier each data type in your domain requires and document it in an ADR. At L7, you own the queue infrastructure that makes each tier available to other teams.

**Consumer group design and throughput modeling.** The throughput of an async processing pipeline is determined by the slowest stage. If each job takes 100ms and you have 10 goroutines per pod, one pod processes 100 jobs per second. If you need to process 10,000 jobs per second, you need 100 pods or jobs that take 10ms. This arithmetic should be done explicitly before any async pipeline is deployed to production, with safety headroom for burst traffic. At the staff level, you build the tooling that makes this arithmetic visible: queue depth dashboards, consumer throughput metrics, and an alert when queue depth exceeds a threshold that would take more than N minutes to drain at current throughput.

**Dead-letter queue governance.** A DLQ is not a passive garbage bin. It is an active reliability signal. At Netflix and Amazon, DLQ depth is monitored as a service health metric, and alerts fire when depth exceeds a configurable threshold. The operational question is not just "is there a DLQ?" but "who owns it, who is paged when it grows, what is the reprocessing runbook, and how do you distinguish a bug that should be fixed from a transient failure that should be retried?" At L6, you write the runbook. At L7, you define the organization-wide standard for DLQ ownership and escalation paths.

**Saga pattern and compensating transactions.** Long-running multi-step operations (order creation that spans inventory reservation, payment authorization, and order record creation) cannot use a database transaction across multiple services. The saga pattern sequences steps through choreography (each step publishes an event that triggers the next) or orchestration (a central saga orchestrator calls each step). Both require compensating transactions for rollback. At the staff level, you evaluate which variant is appropriate per use case, document the failure modes for each step and its compensating action, and build the monitoring that makes partial saga failures visible (a saga stuck in "payment_authorized" state for more than 5 minutes indicates that the subsequent step failed without triggering compensation).

---
