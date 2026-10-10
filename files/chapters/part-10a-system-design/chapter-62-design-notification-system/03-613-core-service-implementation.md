## 62.3 Core Service Implementation

### Notification Service

The notification service acts as the orchestration layer that validates incoming notification requests, applies user preferences and opt-out rules, selects the appropriate delivery channel, and enqueues notifications for asynchronous processing by channel-specific workers. Persisting the notification record before enqueueing means a crash between the two steps leaves a durable record with no queued message, which a background sweeper can detect and re-enqueue. The reverse order would produce a queued message with no audit record. The service exposes a clean interface that callers use without knowing which channel will deliver the notification, keeping channel selection logic centralized and configurable.

```go
// service/notification_service.go
package service

import (
    "context"
    "errors"
    "time"
    "github.com/google/uuid"

    "yourproject/types"
)

var (
    ErrUserNotFound     = errors.New("user not found")
    ErrInvalidChannel   = errors.New("invalid notification channel")
    ErrDuplicateRequest = errors.New("duplicate notification request")
)

// NotificationService handles notification operations
type NotificationService struct {
    repo        NotificationRepository
    queue       NotificationQueue
    preferences PreferenceService
    templates   TemplateEngine
    rateLimit   RateLimiter
    dedup       DeduplicationStore
}

// Dependencies bundles injectable components for NotificationService
type Dependencies struct {
    Repository    NotificationRepository
    Queue         NotificationQueue
    Preferences   PreferenceService
    Templates     TemplateEngine
    RateLimiter   RateLimiter
    Deduplication DeduplicationStore
}

// NewNotificationService creates a new notification service
func NewNotificationService(deps Dependencies) *NotificationService {
    return &NotificationService{
        repo:        deps.Repository,
        queue:       deps.Queue,
        preferences: deps.Preferences,
        templates:   deps.Templates,
        rateLimit:   deps.RateLimiter,
        dedup:       deps.Deduplication,
    }
}

// SendRequest represents a notification send request
type SendRequest struct {
    UserID         string
    Type           string
    Channels       []types.Channel // Preferred channels, empty = all enabled
    Priority       types.Priority
    Template       string
    Data           map[string]any
    ScheduledAt    *time.Time
    IdempotencyKey string
}

// Send sends a notification
func (s *NotificationService) Send(ctx context.Context, req SendRequest) (string, error) {
    // 1. Claim the idempotency key up front. An Exists-then-Set pair
    // would be a TOCTOU race: two concurrent retries could both pass
    // the check and both send. SetNX makes claim-or-reject atomic.
    if req.IdempotencyKey != "" {
        claimed, err := s.dedup.SetNX(ctx, req.IdempotencyKey, "pending", 24*time.Hour)
        if err != nil {
            return "", err
        }
        if !claimed {
            return "", ErrDuplicateRequest
        }
    }

    // 2. Get user preferences
    prefs, err := s.preferences.GetUserPreferences(ctx, req.UserID)
    if err != nil {
        return "", err
    }

    // 3. Filter channels based on preferences
    channels := s.filterChannels(req.Channels, prefs, req.Type)
    if len(channels) == 0 {
        return "", nil // User opted out of all channels
    }

    // 4. Check rate limits
    if err := s.rateLimit.Check(ctx, req.UserID, req.Type); err != nil {
        return "", err
    }

    // 5. Create notification for each channel
    notificationID := uuid.New().String()

    for _, channel := range channels {
        notification := &types.Notification{
            ID:             notificationID + "-" + string(channel),
            UserID:         req.UserID,
            Type:           req.Type,
            Channel:        channel,
            Priority:       req.Priority,
            Template:       req.Template,
            Data:           req.Data,
            ScheduledAt:    req.ScheduledAt,
            IdempotencyKey: req.IdempotencyKey,
            CreatedAt:      time.Now(),
        }

        // Save to database
        if err := s.repo.Create(ctx, notification); err != nil {
            return "", err
        }

        // Queue for delivery
        if err := s.queue.Enqueue(ctx, notification); err != nil {
            return "", err
        }
    }

    // 6. Record the notification ID under the already-claimed key so
    // duplicate callers can be pointed at the original send
    if req.IdempotencyKey != "" {
        s.dedup.Set(ctx, req.IdempotencyKey, notificationID, 24*time.Hour)
    }

    return notificationID, nil
}

// SendBulk sends notifications to multiple users
func (s *NotificationService) SendBulk(ctx context.Context, userIDs []string, req SendRequest) ([]string, error) {
    ids := make([]string, 0, len(userIDs))

    // Process in batches
    batchSize := 100
    for i := 0; i < len(userIDs); i += batchSize {
        end := i + batchSize
        if end > len(userIDs) {
            end = len(userIDs)
        }

        batch := userIDs[i:end]
        for _, userID := range batch {
            req.UserID = userID
            id, err := s.Send(ctx, req)
            if err != nil {
                // Log error but continue
                continue
            }
            ids = append(ids, id)
        }
    }

    return ids, nil
}

func (s *NotificationService) filterChannels(requested []types.Channel, prefs *UserPreferences, notificationType string) []types.Channel {
    // Get enabled channels from preferences
    enabled := prefs.GetEnabledChannels(notificationType)

    if len(requested) == 0 {
        return enabled
    }

    // Filter requested channels by enabled ones
    filtered := make([]types.Channel, 0)
    enabledMap := make(map[types.Channel]bool)
    for _, ch := range enabled {
        enabledMap[ch] = true
    }

    for _, ch := range requested {
        if enabledMap[ch] {
            filtered = append(filtered, ch)
        }
    }

    return filtered
}

// GetStatus retrieves notification status
func (s *NotificationService) GetStatus(ctx context.Context, notificationID string) ([]*types.NotificationResult, error) {
    return s.repo.GetResults(ctx, notificationID)
}
```

### Priority Queue with Kafka

Rather than a single Kafka topic, the queue maintains one writer and one reader per priority level, each backed by a distinct topic (e.g., `notifications-0` for critical, `notifications-3` for low). This maps priority directly onto Kafka's native consumer-group model: critical topics can be assigned more partitions and larger consumer pools, while low-priority topics use fewer resources. Setting `RequiredAcks: kafka.RequireAll` ensures every write is acknowledged by all in-sync replicas before the call returns, sacrificing a small amount of latency to guarantee that a broker failover cannot lose an enqueued notification.

```go
// queue/kafka_queue.go
package queue

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/segmentio/kafka-go"
    "yourproject/types"
)

// KafkaNotificationQueue implements priority queue using Kafka
type KafkaNotificationQueue struct {
    writers map[types.Priority]*kafka.Writer
    readers map[types.Priority]*kafka.Reader
}

// NewKafkaNotificationQueue creates a new Kafka-based queue
func NewKafkaNotificationQueue(brokers []string, topicPrefix string) *KafkaNotificationQueue {
    queue := &KafkaNotificationQueue{
        writers: make(map[types.Priority]*kafka.Writer),
        readers: make(map[types.Priority]*kafka.Reader),
    }

    // Create writer for each priority level
    priorities := []types.Priority{
        types.PriorityCritical,
        types.PriorityHigh,
        types.PriorityMedium,
        types.PriorityLow,
    }

    for _, priority := range priorities {
        topic := fmt.Sprintf("%s-%d", topicPrefix, priority)

        queue.writers[priority] = &kafka.Writer{
            Addr:         kafka.TCP(brokers...),
            Topic:        topic,
            Balancer:     &kafka.LeastBytes{},
            BatchSize:    100,
            BatchTimeout: 10 * time.Millisecond,
            RequiredAcks: kafka.RequireAll,
        }
    }

    return queue
}

// Enqueue adds a notification to the appropriate priority queue
func (q *KafkaNotificationQueue) Enqueue(ctx context.Context, notification *types.Notification) error {
    writer, ok := q.writers[notification.Priority]
    if !ok {
        writer = q.writers[types.PriorityMedium] // Default
    }

    data, err := json.Marshal(notification)
    if err != nil {
        return err
    }

    msg := kafka.Message{
        Key:   []byte(notification.UserID),
        Value: data,
        Headers: []kafka.Header{
            {Key: "channel", Value: []byte(notification.Channel)},
            {Key: "type", Value: []byte(notification.Type)},
        },
    }

    return writer.WriteMessages(ctx, msg)
}

// CreateReader creates a reader for a specific priority and channel
func (q *KafkaNotificationQueue) CreateReader(brokers []string, topicPrefix string, priority types.Priority, channel types.Channel, groupID string) *kafka.Reader {
    topic := fmt.Sprintf("%s-%d", topicPrefix, priority)

    return kafka.NewReader(kafka.ReaderConfig{
        Brokers:        brokers,
        Topic:          topic,
        GroupID:        fmt.Sprintf("%s-%s", groupID, channel),
        MinBytes:       1,
        MaxBytes:       10e6,
        MaxWait:        100 * time.Millisecond,
        CommitInterval: time.Second,
    })
}

// Close closes all writers
func (q *KafkaNotificationQueue) Close() error {
    for _, writer := range q.writers {
        writer.Close()
    }
    return nil
}
```

### Junior -> FAANG: Service Layer Habits That Distinguish Production Code

The `Send` method's six-step sequence (dedup check, get preferences, filter channels, rate limit check, create notifications, mark idempotency key) is the production pattern for safe notification dispatch. Each step has a reason, and knowing the reason is what separates a candidate who copy-pasted a pattern from one who designed it.

Step 1 (idempotency claim) happens before any side effects, and it must be an atomic claim (SetNX), not a check followed by a later set. A separate Exists-then-Set leaves two gaps: concurrent retries can both pass the check, and a crash between creating the record and marking the key lets the next retry create a duplicate. Claiming the key first closes both.

Step 2 (preferences before channels) matters for user trust. If the user opted out of email entirely, creating a notification record and then filtering it feels backwards. Better to know at the start whether any channels are viable.

The `SendBulk` method's batch-of-100 pattern is a first-job habit: never iterate over an unbounded slice without chunking. A bulk campaign to 10 million users without chunking will consume unbounded memory holding all 10M user IDs in a single goroutine.

The `RequiredAcks: kafka.RequireAll` setting in the Kafka writer is a deliberate reliability choice. Know the trade-off: `RequireAll` waits for all in-sync replicas to acknowledge before returning, giving stronger durability at the cost of higher tail latency. For critical notifications, this is the correct default.

### Senior @ FAANG: Service Contracts, Error Taxonomies, and Kafka Producer Design

The three error types defined at the top of the service (`ErrUserNotFound`, `ErrInvalidChannel`, `ErrDuplicateRequest`) form the beginning of an error taxonomy. A production notification service needs a richer taxonomy because callers need to distinguish between errors they should retry (transient queue failure), errors they should log and ignore (user opted out), and errors they should surface to the user (invalid phone number format). Mixing these into a single error type forces callers to parse error strings, which is brittle.

At the senior level, the service contract includes retry guidance. The `ErrDuplicateRequest` response should come with a `Retry-After` header (in an HTTP context) or an explicit `RetryPolicy` in the returned error, signaling that the caller should not retry because the notification is already in-flight. Missing this guidance leads product teams to implement their own retry loops that hammer the idempotency store.

**Kafka producer configuration trade-offs**

`BatchSize: 100` and `BatchTimeout: 10ms` are the parameters that determine write throughput vs latency. A larger batch means higher throughput but potentially up to 10ms of additional latency before a critical notification hits the queue. For the critical priority topic, consider a batch size of 1 and a 0ms timeout (effectively synchronous writes), and reserve the batching configuration for low-priority topics where throughput matters more than latency.

The `LeastBytes` balancer distributes messages to the partition with the fewest bytes in-flight. For notification workloads where all messages are roughly the same size, `RoundRobin` is a simpler alternative. `LeastBytes` is better when message sizes vary significantly, as it prevents hot partitions from forming due to large payloads.

**The `filterChannels` method is where compliance lives**

At a bar-raiser level, the reviewer asks: "What happens if `GetEnabledChannels` returns an empty list because the preference store is temporarily unavailable?" The current implementation falls back to an empty list (user opted out of all channels). For transactional notifications like password resets, this is wrong: a preference store failure should not prevent a user from resetting their password. The correct behavior is to distinguish between "preference store says no channels enabled" (honor user preference) and "preference store is unavailable" (fall back to default channels for transactional types, fail-closed for marketing types). This nuance is a staff-level design concern.

---
