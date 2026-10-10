## Common Mistakes and How to Avoid Them

### Mistake 1: Not Handling Consumer Rebalancing

Consumer group rebalancing occurs whenever a consumer joins or leaves a group, triggering Kafka to redistribute partition ownership among the active members. Any consumer that ignores rebalance notifications continues reading from its old partition assignment after ownership has moved, causing two consumers to process the same messages simultaneously and producing duplicates. A well-behaved consumer registers a `RebalanceCallback` that commits offsets for all currently assigned partitions before the rebalance takes effect, ensuring the handoff is clean.

```go
// BAD: Ignores rebalancing, causes duplicate processing
func (c *BadConsumer) Consume(ctx context.Context) error {
    for {
        msg, err := c.reader.ReadMessage(ctx)
        if err != nil {
            return err
        }

        c.process(msg) // May process duplicates during rebalance
    }
}

// GOOD: Handle rebalancing with proper offset management
type GoodConsumer struct {
    reader         *kafka.Reader
    offsets        map[int]int64 // partition -> offset
    mu             sync.Mutex
    rebalanceHook  func(partitions []int)
}

func (c *GoodConsumer) Consume(ctx context.Context) error {
    // Set up rebalance callback
    c.reader.SetOffsetCommitCallback(func(commits []kafka.TopicPartition) {
        c.mu.Lock()
        defer c.mu.Unlock()
        for _, tp := range commits {
            c.offsets[tp.Partition] = tp.Offset
        }
    })

    for {
        msg, err := c.reader.FetchMessage(ctx)
        if err != nil {
            if err == kafka.ErrPartitionRevoked {
                // Commit offsets before partition is revoked
                c.commitOffsets(ctx)
                continue
            }
            return err
        }

        // Track offset before processing
        c.mu.Lock()
        c.offsets[msg.Partition] = msg.Offset
        c.mu.Unlock()

        // Process message
        if err := c.process(ctx, msg); err != nil {
            continue // Don't commit on failure
        }

        // Commit after successful processing
        c.reader.CommitMessages(ctx, msg)
    }
}
```

### Mistake 2: Not Implementing Idempotent Consumers

Message queues guarantee at-least-once delivery: a message may be delivered more than once due to consumer restarts, broker failover, or network timeouts. Any consumer whose handler has side effects (charging a user, sending an email, updating a counter) must be idempotent, applying the same message twice must produce the same result as applying it once. The standard approach stores a processed message ID in Redis or a database table before performing the side effect, so a duplicate delivery is detected and skipped without re-executing the operation.

```go
// BAD: Non-idempotent consumer causes duplicate effects
func (c *BadConsumer) ProcessPayment(ctx context.Context, msg *PaymentMessage) error {
    // This will charge the user multiple times if message is reprocessed!
    return c.paymentService.Charge(ctx, msg.UserID, msg.AmountCents)
}

// GOOD: Idempotent consumer with deduplication
type GoodConsumer struct {
    paymentService PaymentService
    dedup          *redis.Client
    processed      sync.Map
}

func (c *GoodConsumer) ProcessPayment(ctx context.Context, msg *PaymentMessage) error {
    // Check if already processed (distributed check)
    dedupKey := fmt.Sprintf("payment:processed:%s", msg.PaymentID)
    exists, err := c.dedup.Exists(ctx, dedupKey).Result()
    if err == nil && exists > 0 {
        return nil // Already processed
    }

    // Use database transaction with idempotency check
    tx, err := c.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Check in database too (for durability)
    var count int
    err = tx.QueryRowContext(ctx,
        "SELECT COUNT(*) FROM payments WHERE payment_id = $1",
        msg.PaymentID,
    ).Scan(&count)
    if err != nil {
        return err
    }
    if count > 0 {
        return nil // Already processed
    }

    // Process payment
    if err := c.paymentService.ChargeWithTx(ctx, tx, msg); err != nil {
        return err
    }

    // Record as processed (integer minor units for financial precision)
    _, err = tx.ExecContext(ctx,
        "INSERT INTO payments (payment_id, user_id, amount_cents, processed_at) VALUES ($1, $2, $3, $4)",
        msg.PaymentID, msg.UserID, msg.AmountCents, time.Now(),
    )
    if err != nil {
        return err
    }

    if err := tx.Commit(); err != nil {
        return err
    }

    // Set dedup key with TTL
    c.dedup.Set(ctx, dedupKey, "1", 24*time.Hour)

    return nil
}
```

### Mistake 3: Blocking the Consumer Loop

A single-goroutine consumer that calls a slow processing function inline stalls the entire read loop for the duration of that call, causing consumer lag to grow and Kafka to eventually consider the consumer dead due to missed heartbeats. The fix is to decouple reading from processing by feeding fetched messages into a buffered channel and letting a pool of worker goroutines drain it concurrently. Each worker runs `process` under a `context.WithTimeout` to bound the worst-case stall, and only commits the offset on success so that failed messages are reprocessed after a restart.

```go
// BAD: Slow processing blocks all messages
func (c *BadConsumer) Consume(ctx context.Context) error {
    for {
        msg, _ := c.reader.ReadMessage(ctx)
        c.processSlowly(msg) // Blocks for 10 seconds each message
    }
}

// GOOD: Async processing with worker pool
type GoodConsumer struct {
    reader  *kafka.Reader
    workers int
    jobs    chan *kafka.Message
    wg      sync.WaitGroup
}

func (c *GoodConsumer) Start(ctx context.Context) {
    c.jobs = make(chan *kafka.Message, c.workers*2)

    // Start worker pool
    for i := 0; i < c.workers; i++ {
        c.wg.Add(1)
        go c.worker(ctx)
    }

    // Read messages and dispatch
    go func() {
        for {
            msg, err := c.reader.FetchMessage(ctx)
            if err != nil {
                return
            }
            c.jobs <- &msg
        }
    }()
}

func (c *GoodConsumer) worker(ctx context.Context) {
    defer c.wg.Done()

    for msg := range c.jobs {
        // Process with timeout
        processCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
        err := c.process(processCtx, msg)
        cancel()

        if err == nil {
            c.reader.CommitMessages(ctx, *msg)
        }
    }
}
```

### Mistake 4: Ignoring Message Ordering Requirements

Spawning an unbounded number of goroutines, one per message, destroys the ordering guarantee that Kafka provides within a partition, because goroutines are scheduled non-deterministically and a later order event can finish before an earlier one. The correct pattern dispatches events for the same logical entity (here, a user) to a dedicated per-entity channel consumed by a single goroutine, so all events for that entity are processed sequentially while events for different entities still proceed in parallel. New per-user workers are created on demand under a write lock and run until their channel is drained.

```go
// BAD: Parallel processing breaks ordering
func (c *BadConsumer) ProcessOrders(ctx context.Context) {
    for {
        msg, _ := c.reader.ReadMessage(ctx)
        go c.processOrder(msg) // Order events may be processed out of order!
    }
}

// GOOD: Maintain ordering per entity with partitioned workers
type OrderedConsumer struct {
    reader    *kafka.Reader
    workers   map[string]chan *OrderEvent // userID -> channel
    mu        sync.RWMutex
}

func (c *OrderedConsumer) ProcessOrders(ctx context.Context) {
    for {
        msg, err := c.reader.FetchMessage(ctx)
        if err != nil {
            return
        }

        var event OrderEvent
        json.Unmarshal(msg.Value, &event)

        // Route to per-user worker (maintains order per user)
        c.mu.RLock()
        workerCh, exists := c.workers[event.UserID]
        c.mu.RUnlock()

        if !exists {
            c.mu.Lock()
            workerCh = make(chan *OrderEvent, 100)
            c.workers[event.UserID] = workerCh
            go c.userWorker(ctx, event.UserID, workerCh)
            c.mu.Unlock()
        }

        workerCh <- &event

        c.reader.CommitMessages(ctx, msg)
    }
}

func (c *OrderedConsumer) userWorker(ctx context.Context, userID string, events <-chan *OrderEvent) {
    for event := range events {
        // Process events for this user in order
        c.processOrderEvent(ctx, event)
    }
}
```

### Mistake 5: Not Monitoring Consumer Lag

Consumer lag, the gap between the latest produced offset and the last committed offset, is the primary health signal for a message queue consumer. A growing lag indicates the consumer is falling behind and may eventually cause unbounded queue growth or data loss if messages have finite retention. Without instrumentation, this invisible backlog is only discovered after downstream systems start failing. The `GoodConsumer` polls `reader.Lag()` every ten seconds, exports the value as a Prometheus gauge, and fires an alert when the lag exceeds a configurable threshold, giving the on-call engineer actionable visibility before the situation becomes critical.

```go
// BAD: No visibility into consumer health
type BadConsumer struct {
    reader *kafka.Reader
}

// GOOD: Comprehensive monitoring
type GoodConsumer struct {
    reader     *kafka.Reader
    metrics    *ConsumerMetrics
    alerter    Alerter
}

type ConsumerMetrics struct {
    messagesProcessed *prometheus.CounterVec
    processingLatency *prometheus.HistogramVec
    consumerLag       *prometheus.GaugeVec
    errors            *prometheus.CounterVec
}

func (c *GoodConsumer) monitorLag(ctx context.Context) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            lag := c.reader.Lag()

            c.metrics.consumerLag.WithLabelValues(
                c.reader.Config().Topic,
                c.reader.Config().GroupID,
            ).Set(float64(lag))

            // Alert if lag exceeds threshold
            if lag > 100000 {
                c.alerter.Alert(ctx, AlertInfo{
                    Level:   "warning",
                    Message: fmt.Sprintf("Consumer lag high: %d", lag),
                    Labels: map[string]string{
                        "topic":    c.reader.Config().Topic,
                        "group_id": c.reader.Config().GroupID,
                    },
                })
            }

        case <-ctx.Done():
            return
        }
    }
}

func (c *GoodConsumer) Process(ctx context.Context) error {
    for {
        start := time.Now()

        msg, err := c.reader.FetchMessage(ctx)
        if err != nil {
            c.metrics.errors.WithLabelValues("fetch").Inc()
            continue
        }

        if err := c.process(ctx, msg); err != nil {
            c.metrics.errors.WithLabelValues("process").Inc()
            continue
        }

        c.reader.CommitMessages(ctx, msg)

        // Record metrics
        c.metrics.messagesProcessed.WithLabelValues(string(msg.Topic)).Inc()
        c.metrics.processingLatency.WithLabelValues(string(msg.Topic)).
            Observe(time.Since(start).Seconds())
    }
}
```

---

### Junior -> FAANG: Building the Correct Mental Model for Each Mistake

These five mistakes are worth studying not just to avoid them, but to understand the system model violation each one represents.

Mistake 1 (ignoring rebalancing) violates the assumption that partition assignment is static. It is not. Treat your partition assignments as leases that can be revoked at any time, and your consumer code will naturally handle rebalances correctly.

Mistake 2 (non-idempotent consumers) violates the at-least-once delivery contract. Message queues do not guarantee at-most-once delivery without explicit configuration (`acks=0`). Every consumer that has side effects must check whether that side effect has already been applied. The deduplication key should be the message's unique ID (producer-assigned or offset-based), not a derived business key, because business keys can collide across different messages.

Mistake 3 (blocking the consumer loop) is the most common first-production incident. A consumer that processes each message synchronously can handle N messages per second where N is `1 / handler_latency`. If handler latency is 100ms, you process 10 messages per second per consumer, regardless of how many partitions you assign. The worker pool pattern decouples fetch rate from processing rate. Size the pool based on the target throughput and the expected handler latency.

Mistakes 4 and 5 compound each other. Out-of-order processing due to parallel goroutines produces incorrect state in downstream systems. Consumer lag that grows unchecked eventually causes those incorrect states to propagate further before anyone notices.

### Senior @ FAANG: Code Review Signals for Each Mistake Category

At the bar-raiser level, you are expected to catch these mistakes in code review before they reach production, and to explain the failure mode precisely.

For rebalancing: look for consumers that commit offsets inside a `defer` in the main processing function. A `defer` commit on function exit does not run when a rebalance revokes the partition mid-function. The correct pattern is a `context.WithCancel` that is canceled on rebalance, causing the processing loop to exit cleanly before committing.

For idempotency: the two-layer check (Redis for speed, database for durability) is the right pattern, but watch for the race condition between the Redis check and the database insert. A second delivery that arrives while the first is being processed can pass both checks if they run concurrently before either has committed. The fix is a distributed lock on the message ID before the dedup check, or a unique constraint on the `payment_id` column in the database that causes the second insert to fail and return "already processed."

For ordering: the per-entity worker pattern is correct but has a memory leak if workers are never garbage collected for inactive entities. The `userWorker` function in the example drains its channel, which only terminates if the channel is closed. The orchestrator must track idle workers and close their channels after a configurable inactivity period. Set the inactivity timeout at 2-5x the message rate for the busiest entity, and alert when the total worker count exceeds the expected maximum (partition count times expected concurrent entities per partition).

For lag monitoring: the threshold of 100,000 messages is not universal. For a consumer that processes 1 million messages per second, 100,000 messages is 100ms of lag, which is negligible. For a consumer that processes 1,000 messages per second, 100,000 messages is 100 seconds of lag, which is an incident. Lag thresholds should be defined in terms of time-to-process (lag / current throughput), not raw message count.