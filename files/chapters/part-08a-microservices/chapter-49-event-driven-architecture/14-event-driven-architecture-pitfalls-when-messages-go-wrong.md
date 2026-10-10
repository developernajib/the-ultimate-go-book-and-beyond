## 49.12 Event-Driven Architecture Pitfalls: When Messages Go Wrong

### Pitfall 1: The Event Ordering Illusion

**Incident Report**: An e-commerce system processed order events asynchronously. Due to Kafka partition assignment, `OrderPaid` sometimes arrived before `OrderCreated`. The payment processor tried to mark a non-existent order as paid, silently failing. Customers were charged but orders weren't fulfilled.

```go
// WRONG: Assuming event order matches business order
func (h *PaymentHandler) HandleEvent(event Event) error {
    switch e := event.(type) {
    case *OrderPaidEvent:
        // BUG: Order might not exist yet if OrderCreated is delayed
        return h.orderRepo.MarkAsPaid(e.OrderID)
    }
    return nil
}

// CORRECT: Idempotent handling with state checking
func (h *PaymentHandler) HandleEvent(ctx context.Context, event Event) error {
    switch e := event.(type) {
    case *OrderPaidEvent:
        return h.handleOrderPaid(ctx, e)
    }
    return nil
}

func (h *PaymentHandler) handleOrderPaid(ctx context.Context, e *OrderPaidEvent) error {
    // Retry with backoff if order doesn't exist yet
    var lastErr error
    for attempt := 0; attempt < 5; attempt++ {
        order, err := h.orderRepo.Get(ctx, e.OrderID)
        if err == ErrNotFound {
            // Order not created yet - wait and retry
            lastErr = err
            backoff := time.Duration(attempt+1) * 500 * time.Millisecond
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(backoff):
                continue
            }
        }
        if err != nil {
            return fmt.Errorf("get order: %w", err)
        }

        // Idempotent: check if already paid
        if order.Status == OrderStatusPaid {
            return nil  // Already processed
        }

        return h.orderRepo.MarkAsPaid(ctx, e.OrderID)
    }

    // After retries, send to DLQ for manual investigation
    return fmt.Errorf("order %s not found after retries: %w", e.OrderID, lastErr)
}

// BETTER: Use event versioning to track causality
type Event struct {
    ID            string    `json:"id"`
    Type          string    `json:"type"`
    AggregateID   string    `json:"aggregate_id"`
    CausationID   string    `json:"causation_id"`   // ID of event that caused this
    CorrelationID string    `json:"correlation_id"` // ID of original request
    Version       int64     `json:"version"`        // Aggregate version
    Timestamp     time.Time `json:"timestamp"`
    Data          any       `json:"data"`
}

func (h *Handler) HandleEvent(ctx context.Context, event Event) error {
    // Check if we've processed events that should come after this
    lastProcessed, err := h.getLastProcessedVersion(ctx, event.AggregateID)
    if err != nil {
        return err
    }

    if event.Version <= lastProcessed {
        // Already processed (or processed a later event)
        return nil
    }

    if event.Version > lastProcessed+1 {
        // Gap in events - something is out of order
        // Requeue or wait for missing events
        return ErrEventGap
    }

    return h.processEvent(ctx, event)
}
```

### Pitfall 2: The Infinite Retry Loop

**Incident Report**: A consumer failed to process a malformed event. With infinite retries enabled, it kept retrying the same message, blocking the partition. 50,000 events backed up behind one poison pill. The processing lag grew for 3 hours before anyone noticed.

```go
// WRONG: Infinite retry without bounds
func (c *Consumer) processMessage(msg *sarama.ConsumerMessage) {
    for {
        err := c.handler.Handle(msg)
        if err == nil {
            return
        }
        log.Printf("Error processing message, retrying: %v", err)
        time.Sleep(time.Second)
        // Never gives up - blocks partition forever
    }
}

// CORRECT: Bounded retries with dead letter queue
type RetryConfig struct {
    MaxRetries     int
    InitialBackoff time.Duration
    MaxBackoff     time.Duration
    Multiplier     float64
}

func (c *Consumer) processMessage(ctx context.Context, msg *sarama.ConsumerMessage) error {
    var lastErr error
    backoff := c.config.InitialBackoff

    for attempt := 0; attempt <= c.config.MaxRetries; attempt++ {
        err := c.handler.Handle(ctx, msg)
        if err == nil {
            return nil
        }

        lastErr = err

        // Check if error is retryable
        if !isRetryable(err) {
            // Non-retryable error - send to DLQ immediately
            return c.sendToDLQ(ctx, msg, err, "non_retryable")
        }

        if attempt == c.config.MaxRetries {
            break
        }

        // Exponential backoff with jitter
        jitter := time.Duration(rand.Float64() * float64(backoff) * 0.3)
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(backoff + jitter):
        }

        backoff = time.Duration(float64(backoff) * c.config.Multiplier)
        if backoff > c.config.MaxBackoff {
            backoff = c.config.MaxBackoff
        }
    }

    // Max retries exceeded - send to DLQ
    return c.sendToDLQ(ctx, msg, lastErr, "max_retries_exceeded")
}

func isRetryable(err error) bool {
    // Non-retryable errors
    var parseErr *json.SyntaxError
    var validationErr *ValidationError

    if errors.As(err, &parseErr) {
        return false  // Can't fix malformed JSON
    }
    if errors.As(err, &validationErr) {
        return false  // Can't fix invalid data
    }

    // Network/transient errors are retryable
    return true
}

func (c *Consumer) sendToDLQ(ctx context.Context, msg *sarama.ConsumerMessage, err error, reason string) error {
    dlqMessage := &DLQMessage{
        OriginalTopic:     msg.Topic,
        OriginalPartition: msg.Partition,
        OriginalOffset:    msg.Offset,
        OriginalKey:       msg.Key,
        OriginalValue:     msg.Value,
        Error:             err.Error(),
        Reason:            reason,
        FailedAt:          time.Now(),
        RetryCount:        c.config.MaxRetries,
    }

    payload, _ := json.Marshal(dlqMessage)
    _, _, err = c.dlqProducer.SendMessage(&sarama.ProducerMessage{
        Topic: msg.Topic + ".dlq",
        Key:   sarama.ByteEncoder(msg.Key),
        Value: sarama.ByteEncoder(payload),
    })

    c.metrics.DLQMessages.Inc()
    return err
}
```

### Pitfall 3: The Consumer Group Rebalance Thunderstorm

**Incident Report**: Kubernetes scaled a Kafka consumer from 3 to 10 pods during traffic spike. Each new pod joining triggered a rebalance. Seven rebalances in 2 minutes caused all consumers to stop processing, making the lag worse. Auto-scaling made the problem exponentially worse.

```go
// WRONG: Default consumer settings with aggressive scaling
func createConsumer() sarama.ConsumerGroup {
    config := sarama.NewConfig()
    // Default settings cause frequent rebalances
    return newConsumerGroup(config)
}

// Kubernetes HPA scales aggressively
// apiVersion: autoscaling/v2
// spec:
//   minReplicas: 1
//   maxReplicas: 20
//   metrics:
//   - type: External
//     external:
//       metric:
//         name: kafka_lag
//       target:
//         type: Value
//         value: 1000  // Scale up on 1000 messages lag

// CORRECT: Optimized consumer config with controlled scaling
func createConsumer() sarama.ConsumerGroup {
    config := sarama.NewConfig()

    // Longer session timeout reduces false rebalances
    config.Consumer.Group.Session.Timeout = 30 * time.Second

    // Longer heartbeat allows more time during rebalances
    config.Consumer.Group.Heartbeat.Interval = 10 * time.Second

    // Use cooperative rebalancing (Kafka 2.4+)
    config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
        sarama.NewBalanceStrategySticky(),  // Minimize partition movement
    }

    // Increase max poll interval for slow processing
    config.Consumer.Group.Rebalance.Timeout = 60 * time.Second

    return newConsumerGroup(config)
}

// Kubernetes: Scale more conservatively
// apiVersion: autoscaling/v2
// spec:
//   minReplicas: 3
//   maxReplicas: 10
//   behavior:
//     scaleUp:
//       stabilizationWindowSeconds: 300  # Wait 5 min before scaling up
//       policies:
//       - type: Pods
//         value: 1          # Add only 1 pod at a time
//         periodSeconds: 60 # Wait 1 min between scale ups
//     scaleDown:
//       stabilizationWindowSeconds: 600  # Wait 10 min before scaling down
//   metrics:
//   - type: External
//     external:
//       metric:
//         name: kafka_lag
//       target:
//         type: AverageValue
//         averageValue: 5000  # Higher threshold
```

### Pitfall 4: The Event Schema Breaking Change Explosion

**Incident Report**: A producer changed an event field from `amount: int` to `amount: float64`. Consumers expecting integers failed to parse new events. Rolling back the producer didn't help - corrupted events were already in Kafka. 100,000 events were stuck until manual intervention.

```go
// WRONG: Changing field types without versioning
// v1: {"order_id": "123", "amount": 100}
// v2: {"order_id": "123", "amount": 99.99}

type OrderEvent struct {
    OrderID string  `json:"order_id"`
    Amount  float64 `json:"amount"`  // Changed from int - breaks consumers!
}

// CORRECT: Event versioning with schema evolution
type EventEnvelope struct {
    Version   int             `json:"version"`
    Type      string          `json:"type"`
    Timestamp time.Time       `json:"timestamp"`
    Data      json.RawMessage `json:"data"`
}

// Version 1
type OrderEventV1 struct {
    OrderID string `json:"order_id"`
    Amount  int    `json:"amount"`
}

// Version 2 - new field, old field deprecated but still present
type OrderEventV2 struct {
    OrderID     string  `json:"order_id"`
    Amount      int     `json:"amount"`       // Keep for backwards compatibility
    AmountCents int64   `json:"amount_cents"` // New precise field
}

func (c *Consumer) handleOrderEvent(envelope EventEnvelope) error {
    switch envelope.Version {
    case 1:
        var v1 OrderEventV1
        if err := json.Unmarshal(envelope.Data, &v1); err != nil {
            return err
        }
        return c.processOrderV1(v1)

    case 2:
        var v2 OrderEventV2
        if err := json.Unmarshal(envelope.Data, &v2); err != nil {
            return err
        }
        return c.processOrderV2(v2)

    default:
        // Unknown version - don't fail, log and skip
        log.Printf("Unknown event version %d, skipping", envelope.Version)
        return nil
    }
}

// Use schema registry for production
type SchemaRegistry struct {
    client *srclient.SchemaRegistryClient
}

func (r *SchemaRegistry) ValidateAndSerialize(subject string, event any) ([]byte, error) {
    schema, err := r.client.GetLatestSchema(subject)
    if err != nil {
        return nil, fmt.Errorf("get schema: %w", err)
    }

    // Avro/Protobuf validation ensures compatibility
    return schema.Codec().BinaryFromNative(nil, event)
}

func (r *SchemaRegistry) DeserializeWithEvolution(subject string, data []byte) (any, int, error) {
    // Schema registry handles version compatibility automatically
    schemaID := binary.BigEndian.Uint32(data[1:5])
    schema, err := r.client.GetSchema(int(schemaID))
    if err != nil {
        return nil, 0, fmt.Errorf("get schema: %w", err)
    }

    native, _, err := schema.Codec().NativeFromBinary(data[5:])
    return native, schema.Version(), err
}
```

### Pitfall 5: The Exactly-Once Delusion

**Incident Report**: A payment service claimed "exactly-once" processing using Kafka transactions. But the transaction only covered Kafka - the downstream database update wasn't atomic. Network timeout between Kafka commit and database write caused duplicate payments when messages were redelivered.

```go
// WRONG: "Exactly-once" only covers Kafka, not external systems
func (c *Consumer) processPayment(msg *sarama.ConsumerMessage) error {
    var event PaymentEvent
    json.Unmarshal(msg.Value, &event)

    // Kafka transaction started by consumer framework
    // But this database call is OUTSIDE the transaction!
    err := c.db.ChargeCustomer(event.CustomerID, event.Amount)
    if err != nil {
        return err  // Will be retried - potential double charge!
    }

    // Kafka offset committed in transaction
    // If this succeeds but DB already charged, we're fine
    // If Kafka commit fails after DB charged, message redelivered = double charge!
    return nil
}

// CORRECT: Idempotency keys for external operations
func (c *Consumer) processPayment(ctx context.Context, msg *sarama.ConsumerMessage) error {
    var event PaymentEvent
    if err := json.Unmarshal(msg.Value, &event); err != nil {
        return err
    }

    // Generate deterministic idempotency key from event
    idempotencyKey := fmt.Sprintf("payment-%s-%s", event.OrderID, event.PaymentID)

    // Check if already processed
    exists, err := c.db.CheckIdempotencyKey(ctx, idempotencyKey)
    if err != nil {
        return fmt.Errorf("check idempotency: %w", err)
    }
    if exists {
        log.Printf("Payment %s already processed, skipping", event.PaymentID)
        return nil  // Idempotent - safe to ack
    }

    // Use database transaction for atomicity
    tx, err := c.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Record idempotency key FIRST
    err = tx.ExecContext(ctx, `
        INSERT INTO idempotency_keys (key, created_at)
        VALUES ($1, $2)
        ON CONFLICT (key) DO NOTHING
    `, idempotencyKey, time.Now())
    if err != nil {
        return fmt.Errorf("record idempotency: %w", err)
    }

    // Process payment
    err = c.chargeCustomerInTx(ctx, tx, event)
    if err != nil {
        return fmt.Errorf("charge customer: %w", err)
    }

    // Record processing result
    err = tx.ExecContext(ctx, `
        UPDATE idempotency_keys
        SET processed_at = $1, result = $2
        WHERE key = $3
    `, time.Now(), "success", idempotencyKey)
    if err != nil {
        return fmt.Errorf("update idempotency: %w", err)
    }

    // Commit transaction - if this fails, entire operation is rolled back
    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit: %w", err)
    }

    return nil
}
```

### Pitfall 6: The Event Replay Without Idempotency

**Incident Report**: Team needed to rebuild a projection after a bug fix. They replayed 2 million events from the event store. But the projection logic sent notification emails on certain events. Users received 50,000 duplicate emails, causing massive support tickets and unsubscribes.

```go
// WRONG: Side effects during replay
func (p *Projector) HandleOrderCreated(event OrderCreatedEvent) error {
    // Update projection
    p.db.InsertOrder(event.OrderID, event.CustomerID, event.Total)

    // Send notification - also triggered on replay!
    p.emailer.SendOrderConfirmation(event.CustomerID, event.OrderID)

    return nil
}

// CORRECT: Separate projection from side effects
type EventContext struct {
    IsReplay      bool
    CorrelationID string
    Timestamp     time.Time
}

func (p *Projector) HandleOrderCreated(ctx EventContext, event OrderCreatedEvent) error {
    // Projection update is always safe and idempotent
    err := p.db.UpsertOrder(event.OrderID, event.CustomerID, event.Total)
    if err != nil {
        return err
    }

    // Side effects only on live processing, not replay
    if !ctx.IsReplay {
        p.sideEffects.Enqueue(SideEffect{
            Type:      "email",
            EventID:   event.ID,
            Action:    "send_order_confirmation",
            Recipient: event.CustomerID,
            Data:      map[string]any{"order_id": event.OrderID},
        })
    }

    return nil
}

// Side effect processor with its own idempotency
func (s *SideEffectProcessor) Process(effect SideEffect) error {
    // Check if side effect already executed
    executed, err := s.db.IsSideEffectExecuted(effect.EventID, effect.Type)
    if err != nil {
        return err
    }
    if executed {
        return nil  // Idempotent
    }

    // Execute side effect
    switch effect.Action {
    case "send_order_confirmation":
        if err := s.emailer.Send(effect.Recipient, effect.Data); err != nil {
            return err
        }
    }

    // Mark as executed
    return s.db.MarkSideEffectExecuted(effect.EventID, effect.Type)
}
```

### Quick Reference: Event-Driven Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Ordering illusion | Out-of-order processing | Retry with backoff, event versioning |
| Infinite retry loop | Partition blocked, growing lag | Bounded retries with DLQ |
| Rebalance storms | Processing stops during scaling | Cooperative rebalancing, conservative scaling |
| Schema breaking change | Consumers fail to parse | Version envelope, schema registry |
| Exactly-once delusion | Duplicate side effects | Idempotency keys in database transactions |
| Replay side effects | Duplicate emails/notifications | Separate projections from side effects |

### Junior → FAANG: Building a Pitfall Radar Before Your First Production Incident

The six pitfalls in this section are ordered roughly by frequency of occurrence in production, not by severity. The infinite retry loop (pitfall 2) is the most immediately visible: it shows up as a stuck consumer and growing lag within minutes of the poison pill arriving. The ordering illusion (pitfall 1) can go undetected for weeks because the incorrect state (a non-existent order marked as paid) looks valid from the outside.

**Build a checklist.** Before shipping any event handler to production, verify five things. First, is there a maximum retry limit with a DLQ destination for exceeded retries? Second, is there a deduplication check keyed on event ID before processing? Third, are all side effects (emails, external API calls, database writes) idempotent, or is there an idempotency key for each? Fourth, does the handler gracefully handle events that arrive in an unexpected order (via retry with backoff, as in pitfall 1's fix)? Fifth, is the handler tested with a replay scenario where the same events are processed twice, and does it produce the same outcome?

**Rebalance storms are a scaling anti-pattern.** The Kubernetes HPA example in pitfall 3 shows aggressive scale-up (add pods on lag growth). The correct counter-intuitive response to a rebalance storm is to slow down scaling: adding more pods makes more rebalances happen, which makes the processing pause longer, which causes more lag, which triggers more scale-up. Use a stabilization window in HPA to prevent runaway scaling. Set `scaleUp.stabilizationWindowSeconds` to at least 300 seconds and `scaleUp.policies` to add one pod at a time.

**Replay side effects is the most dangerous pitfall.** The incident in pitfall 6 (50,000 duplicate emails) is particularly damaging because it directly affects end users and is very difficult to recall. Build the `IsReplay` flag into your event processing context from day one, before you ever run a replay. Adding it retroactively after a production incident is too late.

### Senior @ FAANG: Systematic Prevention at the Platform Level

Each pitfall in this section represents a class of failure that should be prevented at the platform level, not the individual service level.

**Pitfall 1 (ordering illusion):** The platform should document the ordering guarantee for each topic in the event catalog, including the partition key and the ordering scope (per-user, per-order, per-account). Services that need stronger ordering guarantees should request a dedicated topic rather than sharing a topic with weaker guarantees. The causation/correlation ID pattern should be a platform-standard field on every event, enabling consumers to reconstruct causal order even when message arrival order is non-deterministic.

**Pitfall 2 (infinite retry):** The platform should provide a standard retry middleware with configurable max retries, exponential backoff with jitter, non-retryable error classification, and automatic DLQ routing. The middleware should expose Prometheus counters for retry count per event type and DLQ routing rate, with alerts on sustained DLQ routing that indicate a systemic consumer bug rather than transient failures.

**Pitfall 3 (rebalance storms):** The platform should set cooperative rebalancing (incremental cooperative rebalancing strategy) as the default for all consumer groups deployed through the platform's service template. HPA scaling policies for Kafka consumers should be standardized with a minimum stabilization window and a maximum scale-up rate. These defaults prevent the thunderstorm before any individual team hits it.

**Pitfall 4 (schema breaking changes):** As discussed elsewhere, schema registry enforcement in CI is the correct prevention. Additionally, the platform should run a weekly automated schema compatibility report that lists all topics where consumers are reading a schema version that is more than one major version behind the producer. This gives teams visibility into consumer schema drift before it causes an incident.

**Pitfall 5 (exactly-once delusion):** The platform should provide a standard idempotency decorator for external API calls (payment processors, email providers, SMS gateways) that automatically generates deterministic idempotency keys from event IDs and records outcomes in a shared idempotency store. This ensures that any external call made from an event handler is idempotent, even if the team does not implement idempotency explicitly.

**Pitfall 6 (replay side effects):** The platform should provide a replay-safe event processing context that is automatically set to `IsReplay = true` when events are delivered through the projection rebuild tooling. The platform should also lint event handler code to flag any external call (email, SMS, payment) made without checking `IsReplay`, surfacing the risk before a team rebuilds a projection and accidentally sends thousands of duplicate notifications.

---
