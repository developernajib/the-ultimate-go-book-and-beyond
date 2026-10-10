## Interview Questions

### Question 1: How would you implement exactly-once delivery semantics?

**What FAANG expects:** Honest first: exactly-once is at-least-once + idempotent consumer, or Kafka's transactional producer (exactly-once within Kafka, not across sinks). Know the scope limits: EOS works consumer-to-consumer within Kafka. For external sinks (DB, API, email), you need outbox/idempotency. Bonus for naming KIP-98 (Kafka transactions) and citing that Flink's exactly-once sink via 2PC works only with sinks that support two-phase commit (Kafka, JDBC, S3 with specific connectors).

**Answer:**

True exactly-once delivery requires coordinating atomicity between message acknowledgment and the side effects of processing, which is architecturally complex and imposes significant throughput overhead. The practical approach is to implement at-least-once delivery combined with idempotent consumers: the consumer deduplicates messages by storing processed message IDs in a persistent store and checking before processing, converting at-least-once delivery into functionally exactly-once behavior from the application's perspective. The implementation below uses a transactional database write to atomically record the processed message ID and apply the business operation, making it safe to retry without double-applying.

```go
// Exactly-once delivery with transactional processing
type ExactlyOnceProcessor struct {
    consumer     *kafka.Reader
    producer     *kafka.Writer
    db           *sql.DB
    txnIDPrefix  string
}

func (p *ExactlyOnceProcessor) ProcessWithExactlyOnce(ctx context.Context) error {
    for {
        msg, err := p.consumer.FetchMessage(ctx)
        if err != nil {
            return err
        }

        // Start database transaction
        tx, err := p.db.BeginTx(ctx, nil)
        if err != nil {
            return err
        }

        // Check if message already processed (idempotency)
        var processed bool
        err = tx.QueryRowContext(ctx,
            "SELECT EXISTS(SELECT 1 FROM processed_messages WHERE message_id = $1)",
            string(msg.Key),
        ).Scan(&processed)

        if processed {
            tx.Rollback()
            p.consumer.CommitMessages(ctx, msg) // Safe to commit
            continue
        }

        // Process message and produce output atomically
        output, err := p.processMessage(ctx, tx, msg)
        if err != nil {
            tx.Rollback()
            continue
        }

        // Record message as processed
        _, err = tx.ExecContext(ctx,
            "INSERT INTO processed_messages (message_id, processed_at) VALUES ($1, $2)",
            string(msg.Key), time.Now(),
        )
        if err != nil {
            tx.Rollback()
            continue
        }

        // Produce output message with idempotent key
        if output != nil {
            err = p.producer.WriteMessages(ctx, kafka.Message{
                Key:   []byte(fmt.Sprintf("%s-out", msg.Key)),
                Value: output,
            })
            if err != nil {
                tx.Rollback()
                continue
            }
        }

        // Commit everything together
        if err := tx.Commit(); err != nil {
            continue
        }

        // Now safe to commit consumer offset
        p.consumer.CommitMessages(ctx, msg)
    }
}

// Alternative: Use Kafka transactions for exactly-once
type KafkaTransactionalProcessor struct {
    consumer *kafka.Reader
    producer *kafka.Writer
}

func (p *KafkaTransactionalProcessor) ProcessWithTransactions(ctx context.Context) error {
    // Initialize transactional producer
    p.producer.InitTransactions(ctx)

    for {
        msg, err := p.consumer.FetchMessage(ctx)
        if err != nil {
            return err
        }

        // Begin transaction
        p.producer.BeginTransaction()

        // Process and produce
        output, err := p.process(ctx, msg)
        if err != nil {
            p.producer.AbortTransaction()
            continue
        }

        // Send output
        if output != nil {
            err = p.producer.WriteMessages(ctx, kafka.Message{
                Key:   msg.Key,
                Value: output,
            })
            if err != nil {
                p.producer.AbortTransaction()
                continue
            }
        }

        // Send consumer offsets as part of transaction
        p.producer.SendOffsetsToTransaction(ctx, map[string]kafka.TopicPartition{
            msg.Topic: {Partition: msg.Partition, Offset: msg.Offset + 1},
        }, p.consumer.Config().GroupID)

        // Commit transaction (atomically commits offsets and output)
        p.producer.CommitTransaction()
    }
}
```

**Follow-ups:**
- *What is Kafka's isolation level for consumers reading transactional output?* `isolation.level=read_committed`. Default `read_uncommitted` returns aborted messages, which silently breaks EOS consumers. Production rule: every consumer of a transactional topic sets `read_committed`.
- *How expensive is Kafka EOS?* Roughly 3-5% throughput penalty and +10-20ms commit latency. Acceptable for most use cases, not acceptable for ultra-high-throughput streams where the outbox pattern wins.
- *When does the idempotency-in-DB approach fail?* When the processed-messages table grows unbounded. TTL it (drop rows older than N days), or periodic cleanup. Also watch for contention on the dedup table at high throughput, partition it by consumer group.

### Question 2: Design a dead letter queue system

**What FAANG expects:** Retriable vs permanent classification before sending to DLQ (transient errors → retry with backoff. Permanent errors → DLQ immediately). DLQ is observability, not storage: every DLQ message needs an alert or dashboard so humans notice. Bonus for naming the reprocessing tool pattern (Shopify, Stripe have internal tools to replay DLQ messages after a fix), and for recognizing that a DLQ that fills silently is worse than no DLQ.

**Answer:**

```go
// Dead letter queue implementation
type DeadLetterQueue struct {
    mainQueue    *kafka.Reader
    dlqProducer  *kafka.Writer
    maxRetries   int
    retryDelays  []time.Duration
    alerter      Alerter
}

type DLQMessage struct {
    OriginalMessage kafka.Message `json:"original"`
    Error           string        `json:"error"`
    RetryCount      int           `json:"retry_count"`
    FirstFailedAt   time.Time     `json:"first_failed_at"`
    LastFailedAt    time.Time     `json:"last_failed_at"`
    StackTrace      string        `json:"stack_trace"`
}

func NewDeadLetterQueue(mainReader *kafka.Reader, dlqWriter *kafka.Writer) *DeadLetterQueue {
    return &DeadLetterQueue{
        mainQueue:   mainReader,
        dlqProducer: dlqWriter,
        maxRetries:  3,
        retryDelays: []time.Duration{
            time.Minute,
            5 * time.Minute,
            30 * time.Minute,
        },
    }
}

func (d *DeadLetterQueue) ProcessWithDLQ(ctx context.Context, handler func(context.Context, kafka.Message) error) error {
    for {
        msg, err := d.mainQueue.FetchMessage(ctx)
        if err != nil {
            return err
        }

        // Get retry count from headers
        retryCount := d.getRetryCount(msg)

        // Process with error handling
        err = handler(ctx, msg)
        if err != nil {
            if retryCount >= d.maxRetries {
                // Send to DLQ
                d.sendToDLQ(ctx, msg, err, retryCount)
                d.mainQueue.CommitMessages(ctx, msg)
                continue
            }

            // Schedule retry
            d.scheduleRetry(ctx, msg, retryCount+1)
            d.mainQueue.CommitMessages(ctx, msg)
            continue
        }

        d.mainQueue.CommitMessages(ctx, msg)
    }
}

func (d *DeadLetterQueue) sendToDLQ(ctx context.Context, msg kafka.Message, processingErr error, retryCount int) {
    dlqMsg := DLQMessage{
        OriginalMessage: msg,
        Error:           processingErr.Error(),
        RetryCount:      retryCount,
        FirstFailedAt:   d.getFirstFailedTime(msg),
        LastFailedAt:    time.Now(),
        StackTrace:      getStackTrace(),
    }

    data, _ := json.Marshal(dlqMsg)

    d.dlqProducer.WriteMessages(ctx, kafka.Message{
        Key:   msg.Key,
        Value: data,
        Headers: []kafka.Header{
            {Key: "original_topic", Value: []byte(msg.Topic)},
            {Key: "original_partition", Value: []byte(fmt.Sprintf("%d", msg.Partition))},
        },
    })

    // Alert on DLQ
    d.alerter.Alert(ctx, AlertInfo{
        Level:   "error",
        Message: fmt.Sprintf("Message sent to DLQ after %d retries", retryCount),
        Labels: map[string]string{
            "topic":    msg.Topic,
            "key":      string(msg.Key),
            "error":    processingErr.Error(),
        },
    })
}

// DLQ reprocessor for manual intervention
type DLQReprocessor struct {
    dlqReader   *kafka.Reader
    mainWriter  *kafka.Writer
    db          *sql.DB
}

func (r *DLQReprocessor) ReprocessMessage(ctx context.Context, messageKey string) error {
    // Find message in DLQ
    msg, err := r.findInDLQ(ctx, messageKey)
    if err != nil {
        return err
    }

    var dlqMsg DLQMessage
    json.Unmarshal(msg.Value, &dlqMsg)

    // Republish to original topic
    return r.mainWriter.WriteMessages(ctx, kafka.Message{
        Topic: string(dlqMsg.OriginalMessage.Topic),
        Key:   dlqMsg.OriginalMessage.Key,
        Value: dlqMsg.OriginalMessage.Value,
        Headers: append(dlqMsg.OriginalMessage.Headers, kafka.Header{
            Key: "reprocessed_from_dlq", Value: []byte("true"),
        }),
    })
}
```

**Follow-ups:**
- *How do you classify retriable vs permanent errors?* Retriable: timeouts, 5xx, rate limits, connection errors. Permanent: 4xx (except 429), schema violations, business-rule failures. Wrap errors with a custom sentinel so the handler can decide without string matching.
- *What is the right retry backoff for a poisoned message?* Exponential with jitter (`2^n + rand` seconds). Cap at ~5 retries for most services. Anything beyond 5 is usually a permanent error pretending to be transient.
- *Should DLQ retention be infinite?* No, 7-14 days is typical. Longer and you accumulate stale bugs. shorter and you lose context before humans can triage. Alert on DLQ size growth rate, not just age.

### Question 3: How would you implement message prioritization?

**What FAANG expects:** Two patterns: separate topics per priority (Kafka's native recommendation) vs header-based priority with application-level dispatch. Kafka has no native priority because ordering and priority conflict. Bonus for knowing RabbitMQ *does* support `x-max-priority` queues natively (0-10 priorities, with performance cost), and for calling out the starvation risk in strict priority (low-priority messages never processed) plus the fix (weighted round-robin with guaranteed low-priority allocation).

**Answer:**

```go
// Priority queue implementation
type PriorityMessageQueue struct {
    highPriority   *kafka.Reader
    normalPriority *kafka.Reader
    lowPriority    *kafka.Reader
    processor      MessageProcessor
    ratios         PriorityRatios
}

type PriorityRatios struct {
    High   int // e.g., 5 - process 5 high priority messages
    Normal int // e.g., 3 - then 3 normal
    Low    int // e.g., 1 - then 1 low
}

func (q *PriorityMessageQueue) Process(ctx context.Context) error {
    for {
        // Process high priority messages
        for i := 0; i < q.ratios.High; i++ {
            if !q.processOne(ctx, q.highPriority) {
                break
            }
        }

        // Process normal priority messages
        for i := 0; i < q.ratios.Normal; i++ {
            if !q.processOne(ctx, q.normalPriority) {
                break
            }
        }

        // Process low priority messages
        for i := 0; i < q.ratios.Low; i++ {
            if !q.processOne(ctx, q.lowPriority) {
                break
            }
        }
    }
}

func (q *PriorityMessageQueue) processOne(ctx context.Context, reader *kafka.Reader) bool {
    // Non-blocking read with short timeout
    readCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    msg, err := reader.FetchMessage(readCtx)
    if err != nil {
        return false // No message available
    }

    if err := q.processor.Process(ctx, msg); err == nil {
        reader.CommitMessages(ctx, msg)
    }

    return true
}

// Alternative: Single topic with priority header
type HeaderBasedPriorityQueue struct {
    reader     *kafka.Reader
    highQueue  chan kafka.Message
    normalQueue chan kafka.Message
    lowQueue   chan kafka.Message
}

func (q *HeaderBasedPriorityQueue) Start(ctx context.Context) {
    // Reader goroutine
    go func() {
        for {
            msg, err := q.reader.FetchMessage(ctx)
            if err != nil {
                return
            }

            priority := q.getPriority(msg)
            switch priority {
            case "high":
                q.highQueue <- msg
            case "normal":
                q.normalQueue <- msg
            default:
                q.lowQueue <- msg
            }
        }
    }()

    // Processor goroutine with priority selection
    go func() {
        for {
            select {
            case msg := <-q.highQueue:
                q.process(ctx, msg)
            default:
                select {
                case msg := <-q.highQueue:
                    q.process(ctx, msg)
                case msg := <-q.normalQueue:
                    q.process(ctx, msg)
                default:
                    select {
                    case msg := <-q.highQueue:
                        q.process(ctx, msg)
                    case msg := <-q.normalQueue:
                        q.process(ctx, msg)
                    case msg := <-q.lowQueue:
                        q.process(ctx, msg)
                    case <-ctx.Done():
                        return
                    }
                }
            }
        }
    }()
}
```

**Follow-ups:**
- *What starves out under strict priority?* Low-priority messages when high-priority is continuously available. Fix with weighted round-robin (5:3:1 as shown) or with aging (low-priority messages get promoted after a time threshold).
- *RabbitMQ priority queues, what is the cost?* Internal sorting per priority level, bounded to the declared `x-max-priority`. Setting 255 levels kills performance. Keep it to 3-10. And a priority queue loses the ability to use some optimizations like lazy queues.
- *Priority across Kafka consumers, is it ever possible without multiple topics?* Only via application-level drain-and-reorder, which breaks Kafka's partition ordering guarantee. Separate topics are the clean answer. Use the "many consumers one priority" pattern rather than "one consumer many priorities".

---

### Junior -> FAANG: Answering Queue Interview Questions Without Overcomplicating

Message queue interview questions are almost always about trade-offs, not implementations. For each of the three questions in this section, the interviewer is testing whether you know the cost of the solution you propose, not just whether you know a solution exists.

For exactly-once: the correct junior answer is "at-least-once delivery with an idempotent consumer." Explain the deduplication key, the database check, and why this is functionally equivalent to exactly-once from the application's perspective. Kafka transactions are worth mentioning if you are asked to go deeper, but lead with the simpler approach.

For dead-letter queues: the correct junior answer addresses the two missing pieces that most candidates skip. First, how do you distinguish retriable errors from permanent ones? Second, who monitors the DLQ? A DLQ that fills silently is worse than no DLQ because it creates the false impression that the system is healthy. Mention that DLQ depth should be a dashboard metric with an alert.

For message prioritization: the correct junior answer for Kafka is separate topics per priority level with a weighted round-robin consumer. Mention that Kafka has no native priority because ordering and priority are in fundamental tension. If the interviewer mentions RabbitMQ, note that it does support `x-max-priority` natively, but with performance cost proportional to the number of priority levels declared.

### Senior @ FAANG: The Depth Behind Each Follow-Up Question

The follow-up questions in this section reveal what senior interviewers actually care about, and they differ significantly from what the question surface suggests.

For exactly-once, the real question is: "Do you understand the boundaries of the EOS guarantee?" Kafka EOS (KIP-98) guarantees exactly-once delivery within a Kafka-to-Kafka pipeline. The moment you write to a database, call an HTTP endpoint, or send an email, you are outside the guarantee and need application-level idempotency. Candidates who conflate "Kafka EOS" with "end-to-end exactly-once" are operating with an incorrect mental model that will cause production incidents.

The dedup table growth problem is a real operational concern. At 1 million messages per second, a dedup table that retains records for 24 hours holds 86 billion rows. This is not manageable in a standard relational database. The correct senior answer involves partitioning the dedup table by time bucket (hourly), dropping expired partitions rather than deleting rows (which avoids table bloat from tombstones), and using an appropriate data store (Redis with TTL, Bloom filter for approximate dedup, or Cassandra with TTL columns).

For DLQ design, the reprocessing story is as important as the routing story. A DLQ without a replay tool is a dead end: messages accumulate but cannot be re-injected without manual intervention. The senior answer includes a replay service with controls: filter by error type (replay only messages that failed with a `503 Service Unavailable`), rate limit the replay (do not replay 1 million messages at once), and track replay success metrics separately from normal processing metrics so you can verify the fix worked.

For priority, the starvation question reveals whether you have thought about fairness. Strict priority scheduling starves lower-priority messages when high-priority messages are continuously available. The weighted round-robin (5:3:1) ensures low-priority messages make progress even under high load. The aging mechanism (promoting low-priority messages after they have waited N minutes) is the safety valve that prevents permanent starvation. Both mechanisms together give you bounded worst-case latency for every priority level, which is the property you need to make SLA commitments.