## 64.6 Consumer Implementation

The consumer fetches message batches from assigned partitions, processes them through a handler function, and commits offsets only after successful processing to prevent message loss. The critical design decision is whether to commit offsets before or after processing: committing before processing is fast but loses messages if the handler crashes, while committing after ensures at-least-once delivery but requires handlers to be idempotent. The consumer tracks uncommitted offsets in memory and flushes them to the broker either periodically or after each batch, controlled by the `autoCommit` configuration.

```go
// consumer/consumer.go
package consumer

import (
    "context"
    "sync"
    "time"

    "yourproject/message"
)

// BrokerClient defines broker operations required by the consumer
type BrokerClient interface {
    GetPartitionCount(ctx context.Context, topic string) (int32, error)
    Fetch(ctx context.Context, topic string, partition int32, offset int64, maxRecords int) ([]*message.Message, error)
}

// Consumer consumes messages from topics
type Consumer struct {
    mu            sync.RWMutex
    client        BrokerClient
    coordinator   *Coordinator
    groupID       string
    memberID      string
    generation    int32
    config        ConsumerConfig
    assignments   []TopicPartition
    positions     map[TopicPartition]int64
    commitMu      sync.Mutex
    uncommitted   map[TopicPartition]int64
    fetchCh       chan *FetchResult
    quit          chan struct{}
    wg            sync.WaitGroup
}

// ConsumerConfig holds consumer configuration
type ConsumerConfig struct {
    GroupID            string
    SessionTimeout     time.Duration
    HeartbeatInterval  time.Duration
    MaxPollRecords     int
    MaxPollInterval    time.Duration
    AutoCommit         bool
    AutoCommitInterval time.Duration
    FetchMinBytes      int
    FetchMaxWait       time.Duration
}

// FetchResult contains fetched messages
type FetchResult struct {
    Topic     string
    Partition int32
    Messages  []*message.Message
    Error     error
}

// NewConsumer creates a new consumer
func NewConsumer(client BrokerClient, coordinator *Coordinator, config ConsumerConfig) *Consumer {
    return &Consumer{
        client:      client,
        coordinator: coordinator,
        groupID:     config.GroupID,
        config:      config,
        positions:   make(map[TopicPartition]int64),
        uncommitted: make(map[TopicPartition]int64),
        fetchCh:     make(chan *FetchResult, 100),
        quit:        make(chan struct{}),
    }
}

// Subscribe subscribes to topics
func (c *Consumer) Subscribe(ctx context.Context, topics []string) error {
    // Join group
    joinResp, err := c.coordinator.JoinGroup(ctx, &JoinGroupRequest{
        GroupID:        c.groupID,
        SessionTimeout: c.config.SessionTimeout,
        Topics:         topics,
    })
    if err != nil {
        return err
    }

    c.memberID = joinResp.MemberID
    c.generation = joinResp.Generation

    // If leader, perform assignment
    var assignments map[string][]TopicPartition
    if joinResp.LeaderID == c.memberID {
        // Get all partitions for topics
        allPartitions := make([]TopicPartition, 0)
        for _, topic := range topics {
            count, _ := c.client.GetPartitionCount(ctx, topic)
            for i := int32(0); i < count; i++ {
                allPartitions = append(allPartitions, TopicPartition{Topic: topic, Partition: i})
            }
        }

        // Assign partitions
        members := make([]string, 0, len(joinResp.Members))
        for _, m := range joinResp.Members {
            members = append(members, m.MemberID)
        }

        assignor := &RangeAssignor{}
        assignments = assignor.Assign(members, allPartitions)
    }

    // Sync group
    syncResp, err := c.coordinator.SyncGroup(ctx, &SyncGroupRequest{
        GroupID:     c.groupID,
        MemberID:    c.memberID,
        Generation:  c.generation,
        Assignments: assignments,
    })
    if err != nil {
        return err
    }

    c.mu.Lock()
    c.assignments = syncResp.Assignment
    c.mu.Unlock()

    // Initialize positions
    for _, tp := range syncResp.Assignment {
        offset, _ := c.coordinator.FetchOffset(ctx, c.groupID, tp)
        if offset < 0 {
            offset = 0 // Start from beginning
        }
        c.positions[tp] = offset
    }

    // Start background tasks
    c.wg.Add(2)
    go c.heartbeatLoop()
    go c.fetchLoop()

    if c.config.AutoCommit {
        c.wg.Add(1)
        go c.autoCommitLoop()
    }

    return nil
}

// Poll polls for new messages
func (c *Consumer) Poll(ctx context.Context, timeout time.Duration) ([]*FetchResult, error) {
    results := make([]*FetchResult, 0)
    deadline := time.After(timeout)

    for {
        select {
        case result := <-c.fetchCh:
            results = append(results, result)
            if len(results) >= c.config.MaxPollRecords {
                return results, nil
            }
        case <-deadline:
            return results, nil
        case <-ctx.Done():
            return results, ctx.Err()
        }
    }
}

// MarkProcessed records that every message in a fetched batch has been
// successfully processed, making its offset eligible for commit. Call
// this after handling a FetchResult and before Commit to preserve
// at-least-once semantics.
func (c *Consumer) MarkProcessed(result *FetchResult) {
    if len(result.Messages) == 0 {
        return
    }
    tp := TopicPartition{Topic: result.Topic, Partition: result.Partition}
    nextOffset := result.Messages[len(result.Messages)-1].Offset + 1
    c.commitMu.Lock()
    if nextOffset > c.uncommitted[tp] {
        c.uncommitted[tp] = nextOffset
    }
    c.commitMu.Unlock()
}

// Commit commits offsets for consumed messages
func (c *Consumer) Commit(ctx context.Context) error {
    c.commitMu.Lock()
    toCommit := make(map[TopicPartition]int64)
    for tp, offset := range c.uncommitted {
        toCommit[tp] = offset
    }
    c.uncommitted = make(map[TopicPartition]int64)
    c.commitMu.Unlock()

    for tp, offset := range toCommit {
        if err := c.coordinator.CommitOffset(ctx, c.groupID, tp, offset); err != nil {
            return err
        }
    }

    return nil
}

func (c *Consumer) heartbeatLoop() {
    defer c.wg.Done()

    ticker := time.NewTicker(c.config.HeartbeatInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            ctx := context.Background()
            err := c.coordinator.Heartbeat(ctx, &HeartbeatRequest{
                GroupID:    c.groupID,
                MemberID:   c.memberID,
                Generation: c.generation,
            })
            if err != nil {
                // Trigger rejoin
                return
            }
        case <-c.quit:
            return
        }
    }
}

func (c *Consumer) fetchLoop() {
    defer c.wg.Done()

    for {
        select {
        case <-c.quit:
            return
        default:
        }

        c.mu.RLock()
        assignments := c.assignments
        c.mu.RUnlock()

        for _, tp := range assignments {
            ctx := context.Background()
            position := c.positions[tp]

            messages, err := c.client.Fetch(ctx, tp.Topic, tp.Partition, position, c.config.MaxPollRecords)
            if err != nil {
                continue
            }

            if len(messages) > 0 {
                c.fetchCh <- &FetchResult{
                    Topic:     tp.Topic,
                    Partition: tp.Partition,
                    Messages:  messages,
                }

                // Advance ONLY the fetch (read-ahead) position so the
                // next Fetch returns new messages. The commit position
                // is deliberately NOT advanced here: marking these
                // offsets committable before the application has
                // processed them would make a commit-then-crash lose
                // messages (at-most-once). The application calls
                // MarkProcessed after handling a batch.
                lastOffset := messages[len(messages)-1].Offset
                c.positions[tp] = lastOffset + 1
            }
        }

        time.Sleep(c.config.FetchMaxWait)
    }
}

func (c *Consumer) autoCommitLoop() {
    defer c.wg.Done()

    ticker := time.NewTicker(c.config.AutoCommitInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            c.Commit(context.Background())
        case <-c.quit:
            return
        }
    }
}

// Close closes the consumer
func (c *Consumer) Close() error {
    close(c.quit)
    c.wg.Wait()

    // Leave group
    ctx := context.Background()
    c.coordinator.LeaveGroup(ctx, &LeaveGroupRequest{
        GroupID:  c.groupID,
        MemberID: c.memberID,
    })

    return nil
}
```

---

### Junior -> FAANG: The Consumer Loop and Offset Discipline

The consumer implementation here separates three concerns that juniors often collapse into a single loop: fetching messages, processing messages, and committing offsets. Keeping them separate is not just clean code, it is the structural prerequisite for at-least-once delivery.

The `fetchLoop` advances only the in-memory read-ahead position so the next fetch returns new messages. The commit position is separate: the application calls `MarkProcessed` after handling a batch, which records the offset in `uncommitted`, and `Commit` flushes `uncommitted` to the durable offset store. Advancing the commit position at fetch time instead would be a bug: a commit that fires before the handler runs would lose messages on crash (at-most-once). With MarkProcessed after processing, a crash between processing and commit re-delivers those messages on restart (at-least-once), which is why the handler must be idempotent.

The `heartbeatLoop` is as important as the fetch loop. If the heartbeat stops (because the processing loop is blocked on a slow handler), the coordinator considers the consumer dead and triggers a rebalance. During a rebalance, the partitions owned by this consumer are reassigned, potentially causing duplicate processing while both the old and new consumer process the same messages. The `MaxPollInterval` configuration exists specifically for this: if the time between two `Poll` calls exceeds this value, the consumer sends a synthetic "leave group" and forces a rebalance, which is at least a controlled failure rather than a timeout-based one.

### Senior @ FAANG: Consumer Group Observability and Lag-Driven Autoscaling

Consumer lag is the primary operational signal for a message queue consumer. A lag of zero means the consumer is keeping up. A growing lag means it is falling behind. A lag that exceeds the retention window means messages are being deleted before they are processed, which is silent data loss.

The architecture decision at the platform level is who owns the lag alerting: the team that owns the consumer, or a central platform observability service? The argument for centralized alerting is that teams may not configure their own alerts correctly (or at all), and a DLQ that fills silently is discovered only after downstream systems fail. The argument for per-team ownership is that lag thresholds are domain-specific: a lag of 1 million messages is catastrophic for a payment processor but acceptable for a batch analytics consumer.

A mature platform provides both: a default lag alert (warn at 100K, critical at 1M) that teams can override, and a central dashboard that shows lag for every consumer group in the cluster. The platform team is paged when total cluster lag exceeds a configurable threshold, because that indicates a broker-level problem rather than a consumer-level problem.

Lag-driven autoscaling is the advanced pattern: a horizontal pod autoscaler (HPA) in Kubernetes can scale the number of consumer replicas based on the `consumer_lag` Prometheus metric exported from each consumer. The scaling formula is `desired_replicas = current_lag / target_lag_per_replica`. This gives you elastic throughput that responds to real demand rather than CPU or memory heuristics, which are poor proxies for message queue consumer throughput.