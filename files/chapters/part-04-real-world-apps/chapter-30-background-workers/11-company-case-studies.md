## Company Case Studies

### Uber: Cadence/Temporal for Complex Workflows

Uber developed Cadence (now Temporal) for orchestrating complex, long-running workflows:

```go
// Uber's approach: Durable workflow execution
// Temporal allows workflows to survive restarts, failures, and scale horizontally

// Workflow definition
func OrderWorkflow(ctx workflow.Context, order Order) error {
    options := workflow.ActivityOptions{
        StartToCloseTimeout: 10 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{
            MaximumAttempts: 3,
        },
    }
    ctx = workflow.WithActivityOptions(ctx, options)

    // Step 1: Validate order
    var validated bool
    err := workflow.ExecuteActivity(ctx, ValidateOrderActivity, order).Get(ctx, &validated)
    if err != nil || !validated {
        return err
    }

    // Step 2: Reserve inventory (can take hours for backorder)
    var reserved bool
    err = workflow.ExecuteActivity(ctx, ReserveInventoryActivity, order).Get(ctx, &reserved)
    if err != nil {
        // Compensate
        workflow.ExecuteActivity(ctx, CancelOrderActivity, order)
        return err
    }

    // Step 3: Process payment
    var paymentID string
    err = workflow.ExecuteActivity(ctx, ProcessPaymentActivity, order).Get(ctx, &paymentID)
    if err != nil {
        // Compensate: release inventory
        workflow.ExecuteActivity(ctx, ReleaseInventoryActivity, order)
        return err
    }

    // Step 4: Fulfill order
    return workflow.ExecuteActivity(ctx, FulfillOrderActivity, order).Get(ctx, nil)
}

// Activity implementation with retries handled by Temporal
func ProcessPaymentActivity(ctx context.Context, order Order) (string, error) {
    // Temporal automatically retries on failure
    // State is persisted - workflow continues from last successful step
    paymentID, err := paymentService.Charge(ctx, order.PaymentMethod, order.TotalCents)
    if err != nil {
        return "", err // Temporal will retry based on RetryPolicy
    }
    return paymentID, nil
}
```

**Key Patterns from Uber:**
- **Workflow as code**: Complex business logic expressed as regular Go functions
- **Automatic state persistence**: No need to manually checkpoint
- **Built-in retries**: Configurable retry policies per activity
- **Saga pattern support**: Easy compensation/rollback logic

### Stripe: Webhook Processing at Scale

Stripe processes billions of webhooks with strict reliability requirements:

```go
// Stripe's webhook delivery approach
type WebhookDeliveryService struct {
    queue       Queue
    rateLimiter *RateLimiter
    metrics     *Metrics
}

// Deduplication using idempotency keys
func (s *WebhookDeliveryService) EnqueueWebhook(ctx context.Context, event Event) error {
    // Deduplicate by event ID
    exists, err := s.checkDelivered(ctx, event.ID)
    if err != nil {
        return err
    }
    if exists {
        return nil // Already delivered/queued
    }

    // Create job with exponential backoff retry config
    job, err := queue.NewJob("webhooks", "webhook_delivery",
        WebhookPayload{
            EventID:    event.ID,
            EventType:  event.Type,
            Data:       event.Data,
            Endpoint:   event.Endpoint,
            SigningKey: event.SigningKey,
        },
        queue.WithMaxAttempts(8),  // Stripe retries up to 8 times
    )
    if err != nil {
        return err
    }

    return s.queue.Enqueue(ctx, job)
}

// Delivery with configurable retry delays (like Stripe's schedule)
func (s *WebhookDeliveryService) DeliverWebhook(ctx context.Context, job *queue.Job) error {
    var payload WebhookPayload
    json.Unmarshal(job.Payload, &payload)

    // Apply rate limiting per endpoint
    if !s.rateLimiter.Allow(payload.Endpoint) {
        // Re-queue with delay
        return &RetryableError{
            Delay: time.Minute,
            Err:   errors.New("rate limited"),
        }
    }

    // Build request with signature
    signature := computeWebhookSignature(payload.SigningKey, payload.Data)

    req, _ := http.NewRequestWithContext(ctx, "POST", payload.Endpoint,
        bytes.NewReader(payload.Data))
    req.Header.Set("Stripe-Signature", signature)
    req.Header.Set("Content-Type", "application/json")

    // Execute with timeout
    client := &http.Client{Timeout: 30 * time.Second}
    resp, err := client.Do(req)
    if err != nil {
        s.metrics.RecordDeliveryFailed(payload.Endpoint)
        return err
    }
    defer resp.Body.Close()

    // Check response
    if resp.StatusCode >= 200 && resp.StatusCode < 300 {
        s.metrics.RecordDeliverySuccess(payload.Endpoint)
        return nil
    }

    // Non-2xx is retriable
    return fmt.Errorf("webhook returned status %d", resp.StatusCode)
}
```

**Key Patterns from Stripe:**
- **Exponential backoff**: retry intervals stretch from minutes to hours over roughly three days
- **Event deduplication**: Prevent duplicate deliveries
- **Per-endpoint rate limiting**: Don't overwhelm merchant servers
- **Signature verification**: Cryptographic proof of authenticity

### Netflix: Conductor for Microservice Orchestration

Netflix's Conductor orchestrates microservice workflows:

```go
// Netflix Conductor-style task workers
type VideoProcessingWorker struct {
    taskClient  *conductor.TaskClient
    encoder     VideoEncoder
    storage     ObjectStorage
}

func (w *VideoProcessingWorker) Start(ctx context.Context) {
    // Poll for tasks continuously
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        // Get pending task
        task, err := w.taskClient.Poll(ctx, "video_encode", "worker-1")
        if err != nil || task == nil {
            time.Sleep(time.Second)
            continue
        }

        // Process task
        result := w.processTask(ctx, task)

        // Report result back to Conductor
        w.taskClient.UpdateTask(ctx, result)
    }
}

func (w *VideoProcessingWorker) processTask(ctx context.Context, task *conductor.Task) *conductor.TaskResult {
    result := &conductor.TaskResult{
        TaskID:    task.TaskID,
        WorkflowID: task.WorkflowID,
    }

    // Extract input
    inputURL := task.InputData["source_url"].(string)
    outputFormat := task.InputData["format"].(string)

    // Download source
    source, err := w.storage.Download(ctx, inputURL)
    if err != nil {
        result.Status = conductor.TaskFailed
        result.ReasonForIncompletion = err.Error()
        return result
    }

    // Encode video
    encoded, err := w.encoder.Encode(ctx, source, outputFormat)
    if err != nil {
        result.Status = conductor.TaskFailed
        result.ReasonForIncompletion = err.Error()
        return result
    }

    // Upload result
    outputURL, err := w.storage.Upload(ctx, encoded)
    if err != nil {
        result.Status = conductor.TaskFailed
        result.ReasonForIncompletion = err.Error()
        return result
    }

    // Success
    result.Status = conductor.TaskCompleted
    result.OutputData = map[string]any{
        "output_url": outputURL,
        "duration":   encoded.Duration,
        "size":       encoded.Size,
    }
    return result
}
```

**Key Patterns from Netflix:**
- **Workflow orchestration**: Central coordinator manages task execution
- **Language-agnostic workers**: Any service can be a worker
- **Dynamic workflows**: Workflow definitions can change without redeploying workers
- **Visibility**: Full tracing and audit log of workflow execution

### Junior to FAANG: what these examples teach versus what they omit

Case studies are highlight reels. A junior reading them learns the happy path and misses the operational reality. Three blind spots to notice.

1. **Uber/Temporal example omits workflow versioning.** Workflows are long-lived (days to months). A deploy that changes the workflow function breaks in-flight workflows because Temporal replays the history deterministically against the new code. The fix is versioned changes via `workflow.GetVersion`. Every long-running workflow at Uber has versioning blocks. The example does not show them, and a junior writing Temporal code without them will experience non-deterministic-error crashes on the first deploy.

2. **Stripe webhook example omits the outbox.** How does the event get enqueued. The snippet shows `EnqueueWebhook` but not where that is called from. In Stripe's actual architecture, every state change that generates an event goes into an outbox table in the same DB transaction as the state change, and a relay service dispatches to the webhook queue. Without outbox, enqueue failures lose events.

3. **Netflix Conductor example omits idempotency.** `processTask` downloads, encodes, uploads. If the worker crashes after upload but before `UpdateTask`, Conductor re-dispatches and a second worker re-encodes the same video. Handler must short-circuit on idempotency key (the `task.TaskID`) or upload-before-checking.

Walkthrough for a junior studying these. Read the case study, then ask. "What failure mode is not shown. What would happen if the worker crashed at line 5. At line 10. At line 15." The answer is where the production complexity lives.

Interview entry point. "Name three patterns Stripe uses for webhook delivery and one failure mode they handle that the naive version misses." A junior who names exponential backoff, signature verification, and idempotency, plus mentions the deletion-of-endpoint dead-letter, is well prepared.

### Senior at FAANG: what a staff-level architecture review adds

A staff engineer reading these case studies extracts patterns for their own company. Full comparative analysis.

**Uber Cadence/Temporal is the canonical choice for durable execution.** The operational story. Temporal cluster (or Temporal Cloud). Workers are stateless. History is stored in Cassandra or MySQL. Workflows can span months. Failure of a worker is transparent, another worker resumes from the last completed activity.

Gotchas staff engineers flag.

- **History size bloat.** A workflow running for years with periodic signals accumulates a huge history. Temporal charges on history size. `ContinueAsNew` resets history and starts a new run. Every long workflow must use it.
- **Non-determinism bugs.** Workflow code is replayed on recovery. Any non-determinism (map iteration, time.Now, random) breaks replay. The Temporal Go SDK provides `workflow.Now` for time and `workflow.SideEffect` for values like random numbers and UUIDs (record-once, replay-safe). Use them exclusively. Linter rules or code review catches violations.
- **Versioning is mandatory.** `workflow.GetVersion("step-3-retry-policy", 1, 2)` lets you change logic safely.
- **Activity timeouts are nested.** `StartToCloseTimeout`, `ScheduleToStartTimeout`, `ScheduleToCloseTimeout`, `HeartbeatTimeout`. Each has different failure semantics. Document per activity.
- **Task queue shape.** Workflow task queue versus activity task queue. Separate workers for each, tuned independently. Mixing them caps throughput.

**Stripe webhook delivery is the canonical at-least-once retry-with-backoff case.** Stripe retries with exponential backoff over roughly three days (on the order of eight attempts, with intervals stretching from a few minutes to several hours). After that, continued failures cause the endpoint to be disabled and the merchant is notified. At staff level, the interesting work is not the retry schedule. It is the circuit breaker. If an endpoint returns non-2xx consistently, Stripe stops sending new events (not just retries) and buffers for replay after recovery. Without this, a downed merchant receives a thundering herd on recovery. The circuit-breaker state machine per endpoint is the non-obvious engineering.

**Netflix Conductor enables dynamic orchestration.** Conductor workflows are JSON-defined, not code-defined. This is a trade-off. Pros. Non-engineers can compose workflows. Redeployment of workflow definitions is decoupled from worker deploys. Cons. JSON is hard to test, version, and evolve. Temporal chose code-as-workflow partly in reaction to this.

**Comparison matrix for staff decision making.**

- Temporal. Code-as-workflow. Strong determinism. Mature Go SDK. Saga built-in. Best for long-running business processes.
- Cadence. Temporal's predecessor at Uber. Feature-behind Temporal but still in use. Pick Temporal for new work.
- Conductor. JSON workflows. Best when non-engineers compose. Netflix, Orkes.
- Airflow. Python DAGs. Best for data pipelines (ETL), not transactional workflows.
- Step Functions. AWS-managed state machine. Best if already on AWS and workflow is bounded. Vendor lock-in.
- river, asynq, Sidekiq. Not workflow engines. Best for independent jobs under a few minutes.

**Platform decision at a mid-size FAANG.** Typical choice today is Temporal for workflows plus river or asynq for short jobs. One platform team owns Temporal. Each service team uses Temporal directly or the short-job queue. Crossing tools is allowed only when the workload genuinely fits both.

**Migration case study, Stripe from Resque to custom.** Stripe originally used Resque (Ruby). Scaling past 10M events per day required a move to a custom Ruby plus Go architecture with sharded Kafka topics and idempotency-keyed consumers. The migration took 18 months. Lessons. Migrate one job_type at a time. Keep both systems running with a feature flag. Reconcile outputs for 30 days before declaring cutover. Staff engineers running this kind of migration write an 18-month plan and negotiate head-count for it.

**Organizational patterns.** At FAANG scale, the job platform team is its own org. Typical structure.

- Platform lead, principal or staff-plus.
- SDK team, 3 to 5 engineers, owns client libraries.
- Infrastructure team, 3 to 5 engineers, owns Temporal or queue cluster operation.
- DLQ and tooling team, 2 to 3 engineers, owns replay UI and triage product.
- SRE, 1 to 2 engineers embedded.

Staff engineers influence across all four. They write the contracts, review the roadmaps, and own the ADRs that set multi-year direction.

**Retrospective template after a queue SEV-1.** Staff engineers run the post-incident. Template covers, timeline with decision points, detection delay versus detection target, root cause (technical), root cause (systemic), action items with owners and due dates, what did monitoring not show, what would have detected this earlier. Action items feed the platform backlog. After a Temporal history-bloat incident, Uber added per-workflow history-size alerting. After a Stripe endpoint flood, they added per-endpoint circuit breakers. After a Netflix Conductor workflow deploy broke in-flight workflows, they added versioning-mandatory lint rules.

---
