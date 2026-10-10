## Exercises with Complete Solutions

### Exercise 1: Build a Multi-Channel Notification Service

Implement a notification service that supports email, SMS, and push with:
- Provider failover
- Rate limiting per user
- Delivery tracking

**Solution:**

The solution below wires together all the components from this chapter: a channel router that dispatches to email, SMS, and push providers, a per-user rate limiter to prevent notification spam, and a delivery tracker that records attempts and outcomes. Start by sketching the interface contracts for each provider before writing the concrete implementations, then compose them in the `NotificationService.Send` method.

```go
// Complete multi-channel notification service
package notification

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type Channel string

const (
    ChannelEmail Channel = "email"
    ChannelSMS   Channel = "sms"
    ChannelPush  Channel = "push"
)

type Notification struct {
    ID       string
    UserID   string
    Channel  Channel
    Subject  string
    Body     string
    Priority int
    Data     map[string]any
}

type DeliveryResult struct {
    NotificationID string
    Channel        Channel
    Status         string
    Provider       string
    DeliveredAt    time.Time
    Error          string
}

type Provider interface {
    Name() string
    Send(ctx context.Context, n *Notification) error
    Channel() Channel
}

type NotificationService struct {
    providers   map[Channel][]Provider
    rateLimiter *RateLimiter
    tracker     *DeliveryTracker
    health      *HealthChecker
    mu          sync.RWMutex
}

func NewNotificationService() *NotificationService {
    return &NotificationService{
        providers:   make(map[Channel][]Provider),
        rateLimiter: NewRateLimiter(),
        tracker:     NewDeliveryTracker(),
        health:      NewHealthChecker(),
    }
}

func (s *NotificationService) RegisterProvider(p Provider) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.providers[p.Channel()] = append(s.providers[p.Channel()], p)
}

func (s *NotificationService) Send(ctx context.Context, n *Notification) (*DeliveryResult, error) {
    // Check rate limit
    if err := s.rateLimiter.Check(ctx, n.UserID, n.Channel); err != nil {
        return nil, fmt.Errorf("rate limited: %w", err)
    }

    // Get providers for channel
    s.mu.RLock()
    providers := s.providers[n.Channel]
    s.mu.RUnlock()

    if len(providers) == 0 {
        return nil, fmt.Errorf("no providers for channel %s", n.Channel)
    }

    // Try providers with failover
    var lastErr error
    for _, provider := range providers {
        if !s.health.IsHealthy(provider.Name()) {
            continue
        }

        start := time.Now()
        err := provider.Send(ctx, n)

        if err == nil {
            result := &DeliveryResult{
                NotificationID: n.ID,
                Channel:        n.Channel,
                Status:         "delivered",
                Provider:       provider.Name(),
                DeliveredAt:    time.Now(),
            }

            s.tracker.Record(ctx, result)
            s.rateLimiter.Increment(ctx, n.UserID, n.Channel)

            return result, nil
        }

        lastErr = err
        s.health.RecordFailure(provider.Name())

        // Record failed attempt
        s.tracker.Record(ctx, &DeliveryResult{
            NotificationID: n.ID,
            Channel:        n.Channel,
            Status:         "failed",
            Provider:       provider.Name(),
            Error:          err.Error(),
        })
    }

    return nil, fmt.Errorf("all providers failed: %w", lastErr)
}

// RateLimiter implements sliding window rate limiting
type RateLimiter struct {
    limits map[Channel]int
    window time.Duration
    counts sync.Map
}

func NewRateLimiter() *RateLimiter {
    return &RateLimiter{
        limits: map[Channel]int{
            ChannelEmail: 10,
            ChannelSMS:   5,
            ChannelPush:  50,
        },
        window: time.Hour,
    }
}

// Check verifies the quota. Note: Check and Increment are separate so
// that only successful sends consume quota, which leaves a small race
// where concurrent sends for one user can all pass Check before any
// Increment lands. Production code reserves atomically and refunds on
// failure (see the Lua limiter in 62.7 for the atomic form).
func (r *RateLimiter) Check(ctx context.Context, userID string, ch Channel) error {
    key := fmt.Sprintf("%s:%s", userID, ch)

    val, _ := r.counts.LoadOrStore(key, &rateLimitEntry{
        count:    0,
        windowAt: time.Now(),
    })

    entry := val.(*rateLimitEntry)
    entry.mu.Lock()
    defer entry.mu.Unlock()

    // Reset window if expired
    if time.Since(entry.windowAt) > r.window {
        entry.count = 0
        entry.windowAt = time.Now()
    }

    if entry.count >= r.limits[ch] {
        return fmt.Errorf("limit %d exceeded for %s", r.limits[ch], ch)
    }

    return nil
}

func (r *RateLimiter) Increment(ctx context.Context, userID string, ch Channel) {
    key := fmt.Sprintf("%s:%s", userID, ch)
    if val, ok := r.counts.Load(key); ok {
        entry := val.(*rateLimitEntry)
        entry.mu.Lock()
        entry.count++
        entry.mu.Unlock()
    }
}

type rateLimitEntry struct {
    count    int
    windowAt time.Time
    mu       sync.Mutex
}

// DeliveryTracker tracks notification delivery
type DeliveryTracker struct {
    results sync.Map
}

func NewDeliveryTracker() *DeliveryTracker {
    return &DeliveryTracker{}
}

func (t *DeliveryTracker) Record(ctx context.Context, r *DeliveryResult) {
    t.results.Store(r.NotificationID, r)
}

func (t *DeliveryTracker) Get(notificationID string) *DeliveryResult {
    if val, ok := t.results.Load(notificationID); ok {
        return val.(*DeliveryResult)
    }
    return nil
}

// HealthChecker tracks provider health
type HealthChecker struct {
    failures sync.Map
    threshold int
    window    time.Duration
}

func NewHealthChecker() *HealthChecker {
    return &HealthChecker{
        threshold: 5,
        window:    time.Minute,
    }
}

func (h *HealthChecker) IsHealthy(provider string) bool {
    val, ok := h.failures.Load(provider)
    if !ok {
        return true
    }
    entry := val.(*healthEntry)

    if time.Since(entry.lastFailure) > h.window {
        h.failures.Delete(provider)
        return true
    }

    return entry.count < h.threshold
}

func (h *HealthChecker) RecordFailure(provider string) {
    val, _ := h.failures.LoadOrStore(provider, &healthEntry{})
    entry := val.(*healthEntry)
    entry.count++
    entry.lastFailure = time.Now()
}

type healthEntry struct {
    count       int
    lastFailure time.Time
}
```

### Exercise 2: Implement Notification Batching and Digest

Build a system that batches similar notifications and sends daily digests:

**Solution:**

```go
// Notification batching and digest system
package digest

import (
    "context"
    "encoding/json"
    "fmt"
    "sort"
    "sync"
    "time"
)

type NotificationDigest struct {
    batcher  *NotificationBatcher
    store    DigestStore
    sender   NotificationSender
    schedule *DigestScheduler
}

type NotificationBatcher struct {
    batches sync.Map // userID:category -> []Notification
    config  BatchConfig
}

type BatchConfig struct {
    Categories map[string]CategoryConfig
}

type CategoryConfig struct {
    MaxBatchSize    int
    MaxBatchWait    time.Duration
    DigestEnabled   bool
    DigestFrequency string // "daily", "weekly", "immediate"
}

func NewNotificationDigest(config BatchConfig) *NotificationDigest {
    d := &NotificationDigest{
        batcher: &NotificationBatcher{config: config},
        store:   NewDigestStore(),
        sender:  NewSender(),
    }

    d.schedule = NewDigestScheduler(d)
    go d.schedule.Start()

    return d
}

func (d *NotificationDigest) Add(ctx context.Context, n *Notification) error {
    category := d.categorize(n)
    config := d.batcher.config.Categories[category]

    // Immediate delivery for uncategorized or urgent
    if config.DigestFrequency == "immediate" || n.Priority == PriorityCritical {
        return d.sender.Send(ctx, n)
    }

    // Add to batch
    key := fmt.Sprintf("%s:%s", n.UserID, category)

    val, _ := d.batcher.batches.LoadOrStore(key, &userBatch{
        notifications: make([]*Notification, 0),
        createdAt:     time.Now(),
    })

    batch := val.(*userBatch)
    batch.mu.Lock()
    batch.notifications = append(batch.notifications, n)
    batchSize := len(batch.notifications)
    batchAge := time.Since(batch.createdAt)
    batch.mu.Unlock()

    // Check if batch should be flushed
    if batchSize >= config.MaxBatchSize || batchAge >= config.MaxBatchWait {
        return d.flushBatch(ctx, n.UserID, category)
    }

    // Store for digest
    if config.DigestEnabled {
        d.store.AddToDigest(ctx, n.UserID, category, n)
    }

    return nil
}

func (d *NotificationDigest) flushBatch(ctx context.Context, userID, category string) error {
    key := fmt.Sprintf("%s:%s", userID, category)

    val, ok := d.batcher.batches.LoadAndDelete(key)
    if !ok {
        return nil
    }

    batch := val.(*userBatch)
    batch.mu.Lock()
    notifications := batch.notifications
    batch.mu.Unlock()

    if len(notifications) == 0 {
        return nil
    }

    // Create batched notification
    batched := d.createBatchedNotification(userID, category, notifications)
    return d.sender.Send(ctx, batched)
}

func (d *NotificationDigest) createBatchedNotification(userID, category string, notifications []*Notification) *Notification {
    // Sort by time
    sort.Slice(notifications, func(i, j int) bool {
        return notifications[i].CreatedAt.Before(notifications[j].CreatedAt)
    })

    // Extract summaries
    summaries := make([]map[string]any, len(notifications))
    for i, n := range notifications {
        summaries[i] = map[string]any{
            "id":      n.ID,
            "subject": n.Subject,
            "time":    n.CreatedAt,
            "data":    n.Data,
        }
    }

    return &Notification{
        ID:       fmt.Sprintf("batch-%s-%d", userID, time.Now().UnixNano()),
        UserID:   userID,
        Channel:  ChannelEmail,
        Subject:  fmt.Sprintf("You have %d new %s notifications", len(notifications), category),
        Template: category + "_batch",
        Data: map[string]any{
            "count":     len(notifications),
            "category":  category,
            "summaries": summaries,
        },
    }
}

func (d *NotificationDigest) SendDailyDigest(ctx context.Context, userID string) error {
    // Get all pending digest items
    items, err := d.store.GetDigestItems(ctx, userID)
    if err != nil {
        return err
    }

    if len(items) == 0 {
        return nil
    }

    // Group by category
    byCategory := make(map[string][]*Notification)
    for _, item := range items {
        cat := d.categorize(item)
        byCategory[cat] = append(byCategory[cat], item)
    }

    // Create digest notification
    digest := &Notification{
        ID:       fmt.Sprintf("digest-%s-%s", userID, time.Now().Format("2006-01-02")),
        UserID:   userID,
        Channel:  ChannelEmail,
        Subject:  fmt.Sprintf("Your daily digest - %d notifications", len(items)),
        Template: "daily_digest",
        Data: map[string]any{
            "total":      len(items),
            "categories": d.formatDigestCategories(byCategory),
            "date":       time.Now().Format("January 2, 2006"),
        },
    }

    if err := d.sender.Send(ctx, digest); err != nil {
        return err
    }

    // Clear processed items
    return d.store.ClearDigest(ctx, userID)
}

func (d *NotificationDigest) formatDigestCategories(byCategory map[string][]*Notification) []map[string]any {
    result := make([]map[string]any, 0, len(byCategory))

    for category, items := range byCategory {
        summaries := make([]map[string]any, 0)
        for _, item := range items {
            summaries = append(summaries, map[string]any{
                "subject": item.Subject,
                "preview": truncate(item.Body, 100),
                "time":    item.CreatedAt.Format("3:04 PM"),
            })
        }

        result = append(result, map[string]any{
            "name":      category,
            "count":     len(items),
            "summaries": summaries,
        })
    }

    return result
}

func (d *NotificationDigest) categorize(n *Notification) string {
    if cat, ok := n.Data["category"].(string); ok {
        return cat
    }
    return "general"
}

type userBatch struct {
    notifications []*Notification
    createdAt     time.Time
    mu            sync.Mutex
}

// DigestScheduler runs daily digest jobs
type DigestScheduler struct {
    digest *NotificationDigest
    stopCh chan struct{}
}

func NewDigestScheduler(d *NotificationDigest) *DigestScheduler {
    return &DigestScheduler{
        digest: d,
        stopCh: make(chan struct{}),
    }
}

func (s *DigestScheduler) Start() {
    ticker := time.NewTicker(time.Hour)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            s.checkAndSendDigests()
        case <-s.stopCh:
            return
        }
    }
}

func (s *DigestScheduler) checkAndSendDigests() {
    // Get users scheduled for digest at current hour
    ctx := context.Background()
    users, _ := s.digest.store.GetUsersForDigest(ctx, time.Now().Hour())

    for _, userID := range users {
        s.digest.SendDailyDigest(ctx, userID)
    }
}

func truncate(s string, max int) string {
    runes := []rune(s) // slice runes, a byte cut can split a character
    if len(runes) <= max {
        return s
    }
    return string(runes[:max-3]) + "..."
}
```

### Junior -> FAANG: How to Approach These Exercises

Exercise 1 (multi-channel service) is the foundation. Before writing code, sketch the interface hierarchy: `Provider` interface, concrete implementations for each channel, a `HealthChecker` that wraps provider health state, and a `NotificationService` that composes them. The code in the solution follows SOLID principles because the `Provider` interface allows new channels to be added without modifying `NotificationService`. Practice explaining this interface design before writing the implementation.

Exercise 2 (batching and digest) introduces the scheduler pattern. The `DigestScheduler` runs a goroutine with a ticker and queries users scheduled for delivery at the current hour. Notice the per-user timezone calculation implied by "which users get a digest at this hour": the scheduler must compare the current UTC time against each user's configured digest time in their local timezone. This is the same timezone arithmetic from the common mistakes section, applied here.

Both exercises have test surfaces that reveal your understanding. For Exercise 1, the key test cases are: all providers fail (verify the error is returned and all providers were tried), one provider is unhealthy (verify it is skipped), and the rate limit is exceeded (verify the rate limit error is returned before any provider is tried). Naming these test cases in your answer signals production-level test thinking.

A first-job habit: before submitting any solution, verify that your implementation handles the empty case (no providers registered, no notifications to batch, no users scheduled for digest). These edge cases crash naive implementations and are the first thing reviewers check.

### Senior @ FAANG: Extending These Exercises Toward Production Readiness

**Exercise 1 extensions for a production system**

The exercise solution uses `sync.Map` for the rate limiter state and `sync.Map` for delivery results. These are in-memory and do not survive process restarts. A production extension replaces both with Redis-backed implementations. The rate limiter becomes the Redis sliding window counter from Section 62.7. The delivery tracker becomes a write to the delivery tracking database from Section 62.8. The health checker's failure counts should also be persisted to Redis so that a freshly restarted worker does not treat all providers as healthy when they may be experiencing an ongoing outage.

The `RegisterProvider` method in the solution allows providers to be registered in any order. A production system needs provider priority: if both SendGrid and SES are healthy, prefer SendGrid. Implement this by sorting the provider slice by priority on registration, so the iteration order in `Send` reflects the priority order without any additional logic.

**Exercise 2 extensions: fault-tolerant digest scheduling**

The `DigestScheduler` runs a goroutine with an hourly ticker. If the process restarts at 09:01 AM, the next tick is at 10:01 AM, and all users scheduled for 09:00 AM digests are missed. A production fix uses a persistent cursor: store the last processed hour in Redis, and on startup, check if the last processed hour is behind the current hour and catch up. This is a simplified version of how Apache Airflow handles missed DAG runs.

The `batchSize` and `MaxBatchWait` parameters in `BatchConfig` are tuning knobs that require measurement to set correctly. A production system instruments the batch flush events with the actual batch sizes (as a histogram) and the queue depth at flush time. If the histogram shows most batches are flushing at `MaxBatchSize`, the limit is too low for peak load. If most batches flush on the timer rather than the size limit, the `MaxBatchWait` is too long.

**Staff-level extension: multi-tenant exercise isolation**

In a platform context, Exercise 1's `NotificationService` is a shared component used by multiple product teams. Each team has its own notification types, its own provider budgets (Team A gets 1000 emails/day, Team B gets 10000), and its own rate limits. The exercise extension is to add a `TenantID` to the notification type and rate limiter, so each tenant's limits are tracked independently. This is the foundation of a multi-tenant notification platform, and the architectural challenge is ensuring that one tenant's abuse cannot affect another tenant's delivery SLA.

---
