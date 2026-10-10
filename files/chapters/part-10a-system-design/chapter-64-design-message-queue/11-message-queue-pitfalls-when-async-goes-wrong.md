## Message Queue Pitfalls: When Async Goes Wrong

### Pitfall 1: Consumer Lag Causing Message Expiration Before Processing

**Incident Report**: Critical order messages expired and were deleted before consumers could process them. Consumer lag built up during a deployment, and by the time processing resumed, 3 hours of messages were gone.

```go
// WRONG: Fixed retention without lag monitoring
func (q *Queue) Configure() {
    q.RetentionHours = 24  // Messages deleted after 24 hours
    // No consumer lag monitoring
}

// Consumer goes down for maintenance, comes back
// Lag: 3 million messages = 30 hours behind
// Result: 6 hours of messages deleted before processing

// CORRECT: Dynamic retention and lag alerting
type QueueMonitor struct {
    queue        *Queue
    alerter      *AlertService
    metrics      *prometheus.GaugeVec
    minRetention time.Duration
    lagThreshold time.Duration
}

func (m *QueueMonitor) MonitorConsumerLag() {
    ticker := time.NewTicker(30 * time.Second)
    for range ticker.C {
        for _, consumer := range m.queue.GetConsumers() {
            lag := m.queue.GetConsumerLag(consumer.ID)

            // Record metric
            m.metrics.WithLabelValues(consumer.ID, consumer.Topic).Set(float64(lag.Seconds()))

            // Alert if lag approaches retention
            if lag > m.queue.Retention-2*time.Hour {
                m.alerter.Critical(fmt.Sprintf(
                    "Consumer %s lag (%v) approaching retention (%v). Data loss imminent!",
                    consumer.ID, lag, m.queue.Retention))

                // Temporarily extend retention
                m.queue.ExtendRetention(consumer.Topic, lag+4*time.Hour)
            }

            // Alert if lag exceeds threshold
            if lag > m.lagThreshold {
                m.alerter.Warning(fmt.Sprintf(
                    "Consumer %s lagging by %v on topic %s",
                    consumer.ID, lag, consumer.Topic))

                // Scale up consumers if possible
                m.autoScaleConsumers(consumer.Topic)
            }
        }
    }
}

// Retention based on actual consumer lag
func (q *Queue) DynamicRetention(topic string) time.Duration {
    maxLag := q.GetMaxConsumerLag(topic)

    // Retain at least 2x the current max lag, minimum 24 hours
    retention := maxLag * 2
    if retention < q.minRetention {
        retention = q.minRetention
    }
    if retention > q.maxRetention {
        retention = q.maxRetention
    }

    return retention
}
```

### Pitfall 2: Poison Message Blocking Entire Partition

**Incident Report**: A malformed message caused the consumer to crash. Auto-restart meant the same message was processed again, causing another crash. The partition was effectively stuck for 6 hours.

```go
// WRONG: No poison message handling
func (c *Consumer) ProcessMessages() {
    for msg := range c.messages {
        err := c.handler.Process(msg)  // Crashes on malformed message
        if err != nil {
            // Doesn't commit offset, message will be reprocessed
            log.Printf("Error processing message: %v", err)
            continue
        }
        c.commitOffset(msg.Offset)
    }
}

// CORRECT: Dead letter queue and retry limits
type ResilientConsumer struct {
    consumer      *Consumer
    dlq           *Queue
    maxRetries    int
    retryTracker  map[string]int
    mu            sync.Mutex
}

func (c *ResilientConsumer) ProcessMessages() {
    for msg := range c.consumer.messages {
        msgID := c.getMessageID(msg)

        // Check retry count
        c.mu.Lock()
        retries := c.retryTracker[msgID]
        c.mu.Unlock()

        if retries >= c.maxRetries {
            // Move to dead letter queue
            c.sendToDLQ(msg, fmt.Errorf("exceeded max retries (%d)", c.maxRetries))
            c.consumer.commitOffset(msg.Offset)
            c.clearRetries(msgID)
            continue
        }

        // Process with panic recovery
        err := c.safeProcess(msg)
        if err != nil {
            c.incrementRetries(msgID)

            // Check if error is retryable
            if !isRetryableError(err) {
                c.sendToDLQ(msg, err)
                c.consumer.commitOffset(msg.Offset)
                c.clearRetries(msgID)
                continue
            }

            // Exponential backoff before retry
            backoff := time.Duration(1<<retries) * time.Second
            if backoff > 5*time.Minute {
                backoff = 5 * time.Minute
            }
            time.Sleep(backoff)
            continue
        }

        c.consumer.commitOffset(msg.Offset)
        c.clearRetries(msgID)
    }
}

func (c *ResilientConsumer) safeProcess(msg *Message) (err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("panic during processing: %v\nStack: %s", r, debug.Stack())
        }
    }()

    return c.handler.Process(msg)
}

func (c *ResilientConsumer) sendToDLQ(msg *Message, originalErr error) {
    dlqMsg := &DLQMessage{
        OriginalTopic:     msg.Topic,
        OriginalPartition: msg.Partition,
        OriginalOffset:    msg.Offset,
        Payload:           msg.Value,
        Error:             originalErr.Error(),
        FailedAt:          time.Now(),
        RetryCount:        c.retryTracker[c.getMessageID(msg)],
    }

    if err := c.dlq.Produce(dlqMsg); err != nil {
        log.Printf("Failed to send to DLQ: %v", err)
        // Store locally for later retry
        c.storeFailedDLQ(dlqMsg)
    }
}
```

### Pitfall 3: Message Ordering Violations from Parallel Processing

**Incident Report**: Account balance calculations were wrong. Investigation revealed that deposit and withdrawal messages for the same account were processed out of order due to parallel partition processing.

```go
// WRONG: Parallel processing ignores ordering
func (c *Consumer) ProcessMessagesParallel(workers int) {
    sem := make(chan struct{}, workers)

    for msg := range c.messages {
        sem <- struct{}{}
        go func(m *Message) {
            defer func() { <-sem }()
            c.handler.Process(m)  // Account A deposit and withdrawal race!
            c.commitOffset(m.Offset)
        }(msg)
    }
}

// CORRECT: Per-key ordering with parallel processing
type OrderedParallelConsumer struct {
    consumer   *Consumer
    workers    map[string]chan *Message  // One channel per ordering key
    numWorkers int
    mu         sync.RWMutex
}

func (c *OrderedParallelConsumer) Start() {
    // Message dispatcher
    go func() {
        for msg := range c.consumer.messages {
            orderingKey := c.getOrderingKey(msg)

            c.mu.RLock()
            worker, exists := c.workers[orderingKey]
            c.mu.RUnlock()

            if !exists {
                c.mu.Lock()
                // Double-check after lock
                worker, exists = c.workers[orderingKey]
                if !exists {
                    worker = make(chan *Message, 100)
                    c.workers[orderingKey] = worker
                    go c.processWorker(orderingKey, worker)
                }
                c.mu.Unlock()
            }

            worker <- msg
        }
    }()
}

func (c *OrderedParallelConsumer) processWorker(key string, ch chan *Message) {
    lastActivity := time.Now()

    for {
        select {
        case msg := <-ch:
            c.handler.Process(msg)
            c.commitOffsetAsync(msg.Offset)
            lastActivity = time.Now()

        case <-time.After(5 * time.Minute):
            // Clean up idle workers
            if time.Since(lastActivity) > 5*time.Minute {
                c.mu.Lock()
                close(ch)
                delete(c.workers, key)
                c.mu.Unlock()
                return
            }
        }
    }
}

func (c *OrderedParallelConsumer) getOrderingKey(msg *Message) string {
    // Extract the key that requires ordering
    // e.g., account_id for financial transactions
    var payload struct {
        AccountID string `json:"account_id"`
    }
    json.Unmarshal(msg.Value, &payload)
    return payload.AccountID
}
```

### Pitfall 4: Offset Commit Before Processing Causes Data Loss

**Incident Report**: Payment confirmations were lost during processing. The consumer committed offsets immediately upon receiving messages, then crashed before completing processing. Messages were never processed.

```go
// WRONG: Commit before processing
func (c *Consumer) ProcessMessages() {
    for msg := range c.messages {
        c.commitOffset(msg.Offset)  // Commit first
        c.handler.Process(msg)      // Crash here = message lost
    }
}

// ALSO WRONG: Auto-commit with long processing
func (c *Consumer) ProcessMessagesAutoCommit() {
    // Auto-commit every 5 seconds
    c.config.EnableAutoCommit = true
    c.config.AutoCommitInterval = 5 * time.Second

    for msg := range c.messages {
        c.handler.Process(msg)  // Takes 10 seconds
        // Auto-commit happens while processing = messages skipped on restart
    }
}

// CORRECT: At-least-once with manual commit after processing
func (c *Consumer) ProcessMessages() {
    // Disable auto-commit
    c.config.EnableAutoCommit = false

    batch := make([]*Message, 0, 100)
    commitTicker := time.NewTicker(1 * time.Second)

    for {
        select {
        case msg := <-c.messages:
            // Process first
            err := c.handler.Process(msg)
            if err != nil {
                // Handle error (retry, DLQ, etc.)
                c.handleError(msg, err)
                continue
            }

            // Add to batch for commit
            batch = append(batch, msg)

            // Commit if batch is large enough
            if len(batch) >= 100 {
                c.commitBatch(batch)
                batch = batch[:0]
            }

        case <-commitTicker.C:
            // Periodic commit for small batches
            if len(batch) > 0 {
                c.commitBatch(batch)
                batch = batch[:0]
            }
        }
    }
}

func (c *Consumer) commitBatch(batch []*Message) {
    // Find max offset per partition
    offsets := make(map[int32]int64)
    for _, msg := range batch {
        if msg.Offset > offsets[msg.Partition] {
            offsets[msg.Partition] = msg.Offset
        }
    }

    // Commit with retry
    for partition, offset := range offsets {
        for attempt := 0; attempt < 3; attempt++ {
            err := c.commitOffsetSync(partition, offset)
            if err == nil {
                break
            }
            log.Printf("Commit failed (attempt %d): %v", attempt+1, err)
            time.Sleep(time.Duration(attempt+1) * time.Second)
        }
    }
}
```

### Quick Reference: Message Queue Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Consumer lag vs retention | Messages deleted before processing | Dynamic retention, lag monitoring |
| Poison message | Partition stuck on bad message | Dead letter queue, retry limits |
| Ordering violations | Out-of-order processing | Per-key workers, partition affinity |
| Premature commit | Message loss on crash | Commit after successful processing |

### Junior -> FAANG: Reading Incident Reports as a Learning Discipline

The four incident reports in this section follow a pattern that experienced engineers recognize: a seemingly safe configuration choice (fixed retention, auto-commit, parallel processing) interacts with an unusual but plausible operational event (deployment lag, malformed message, breaking news tweet, maintenance window) to produce a failure that was not visible in testing.

The first habit to build is running these what-if scenarios on every system you design: "What happens if this consumer falls behind by 48 hours?" "What happens if this message cannot be deserialized?" "What happens if two goroutines process messages for the same account simultaneously?" If the answer is "the system fails silently," that is a production incident waiting to happen.

The dynamic retention pattern (extending retention when consumer lag approaches the retention ceiling) is worth memorizing. The standard Kafka configuration is static retention (7 days). A consumer that goes offline for 8 days will return to find its oldest uncommitted messages deleted, and there is no error, no alert, and no way to recover those messages without a separate backup. The monitoring and dynamic extension pattern converts this silent failure into a visible alert with a remediation path.

The exponential backoff for poison messages deserves a precise formula: `min(baseDelay * 2^attempt, maxDelay)`. Cap the delay to prevent unbounded wait times (5 minutes is a reasonable maximum for most consumer patterns). Add jitter (`delay * (0.5 + rand.Float64() * 0.5)`) to prevent multiple failed-partition consumers from all retrying simultaneously.

### Senior @ FAANG: Systemic Fixes Versus Local Fixes

Each incident in this section has a local fix (add the retry limit, add the DLQ route, add the per-key worker) and a systemic fix (change the platform defaults so the local fix is the default behavior for all consumers). Senior engineers operate at the systemic level.

For consumer lag vs retention: the systemic fix is a platform-level policy that automatically alerts when any consumer group's lag exceeds 50% of the topic's retention period. This alert fires for every consumer group on the cluster, regardless of whether the team owning that consumer has configured their own alerting. The platform team owns the alert. The application team owns the remediation.

For poison messages: the systemic fix is a platform-level DLQ sidecar that is automatically attached to every consumer deployment. The sidecar intercepts messages that fail after N retries, writes them to a per-topic DLQ with structured metadata (error message, stack trace, retry history, original offset), and exposes a `/dlq/replay` endpoint for selective reprocessing. Application teams get DLQ handling for free without writing any retry or DLQ code.

For ordering violations: the systemic fix is a linting rule that flags any `go func()` call inside a message processing loop in code review. The linter forces developers to justify parallel processing explicitly rather than reaching for goroutines by habit. The justification must include a statement about ordering requirements: "messages for different entities can be processed in parallel because entity state is independent" is acceptable. "Messages may be processed in parallel" without an ordering analysis is not.

For premature commit: the systemic fix is a platform-provided consumer wrapper that disables auto-commit and requires a `consumer.Commit(ctx, msg)` call after successful processing. The wrapper records every uncommitted message and alerts if a message is in-flight for more than `MaxProcessingTime`. This converts the silent failure (auto-commit before processing) into a visible contract that the application team must fulfill.

---
