## Common Mistakes and How to Avoid Them

### Mistake 1: Not Handling Provider Failures Gracefully

Email and SMS providers are external services with their own SLAs, rate limits, and outage windows. A notification service that depends on a single provider will drop messages whenever that provider has a degraded period, which at scale can mean millions of undelivered notifications. The solution is a multi-provider abstraction that iterates through a prioritized list of providers, skips unhealthy ones based on a health check, and falls back to the next available option before giving up.

```go
// BAD: Single provider with no fallback
type BadNotificationSender struct {
    emailProvider *SendGridClient
}

func (s *BadNotificationSender) SendEmail(ctx context.Context, n *Notification) error {
    // If SendGrid is down, all emails fail
    return s.emailProvider.Send(ctx, n)
}

// GOOD: Multi-provider with automatic failover
type GoodNotificationSender struct {
    providers []EmailProvider
    health    *HealthChecker
    mu        sync.RWMutex
}

func (s *GoodNotificationSender) SendEmail(ctx context.Context, n *Notification) error {
    s.mu.RLock()
    providers := s.providers
    s.mu.RUnlock()

    var lastErr error
    for _, provider := range providers {
        if !s.health.IsHealthy(provider.Name()) {
            continue
        }

        err := provider.Send(ctx, n)
        if err == nil {
            return nil
        }
        lastErr = err

        // Mark provider as unhealthy for circuit breaker
        s.health.RecordFailure(provider.Name())
    }

    return fmt.Errorf("all providers failed: %w", lastErr)
}
```

### Mistake 2: Ignoring Idempotency for Retries

Retry logic is essential for reliability, but without idempotency guards it turns a transient delivery failure into a duplicate notification, users receive the same email or SMS multiple times, eroding trust in the product. The solution is to derive a deterministic `IdempotencyKey` from the notification's ID, store it in Redis with a 24-hour TTL on the first successful send, and skip the send entirely if the key is already present on subsequent attempts. The retry loop also checks whether the error is retryable before sleeping, avoiding pointless retries for permanent failures like an invalid recipient address.

```go
// BAD: No idempotency - user gets duplicate notifications
func (s *BadService) SendWithRetry(ctx context.Context, n *Notification) error {
    for i := 0; i < 3; i++ {
        err := s.send(ctx, n)
        if err == nil {
            return nil
        }
        time.Sleep(time.Second * time.Duration(i+1))
    }
    return errors.New("failed after retries")
}

// GOOD: Idempotent sends with deduplication
type GoodService struct {
    sender NotificationSender
    dedup  *redis.Client
}

func (s *GoodService) SendWithRetry(ctx context.Context, n *Notification) error {
    // Claim the key atomically. An Exists check followed by a later
    // Set would let two concurrent retries both pass the check and
    // both send, SetNX makes the claim itself the gate.
    dedupKey := fmt.Sprintf("notif:sent:%s", n.IdempotencyKey)
    claimed, _ := s.dedup.SetNX(ctx, dedupKey, "1", 24*time.Hour).Result()
    if !claimed {
        return nil // Already sent or currently in flight, skip
    }

    var lastErr error
    for i := 0; i < 3; i++ {
        err := s.sender.Send(ctx, n)
        if err == nil {
            return nil
        }
        lastErr = err

        // Check if error is retryable
        if !isRetryable(err) {
            break
        }

        time.Sleep(time.Second * time.Duration(i+1))
    }

    // Every attempt failed: release the claim so a later retry is
    // not permanently blocked by a send that never happened
    s.dedup.Del(ctx, dedupKey)
    return lastErr
}
```

### Mistake 3: Not Respecting User Timezone for Scheduled Notifications

Scheduling a daily digest at 09:00 UTC delivers it at wildly inappropriate local times across time zones, 6 PM in Tokyo or 1 AM in San Francisco, quickly training users to ignore or unsubscribe from notifications. The correct approach loads the user's stored `Timezone` string via `time.LoadLocation`, computes the next 09:00 occurrence in that zone, and converts the result to UTC before enqueuing, so every user receives the notification at their local morning regardless of their geography. Falling back to UTC when the timezone string is missing or invalid prevents a hard error from blocking the scheduling of users whose profiles were created before timezone capture was added.

```go
// BAD: Sending at fixed UTC time regardless of user timezone
func (s *BadScheduler) ScheduleDailyDigest(userID string) {
    // This sends at 9 AM UTC for everyone
    // Users in Tokyo get it at 6 PM, users in SF at 1 AM!
    s.queue.Schedule(userID, "09:00 UTC")
}

// GOOD: Respect user timezone for optimal delivery
type GoodScheduler struct {
    queue    *ScheduleQueue
    userRepo UserRepository
}

func (s *GoodScheduler) ScheduleDailyDigest(ctx context.Context, userID string) error {
    user, err := s.userRepo.Get(ctx, userID)
    if err != nil {
        return err
    }

    loc, err := time.LoadLocation(user.Timezone)
    if err != nil {
        loc = time.UTC
    }

    // Calculate next 9 AM in user's timezone
    now := time.Now().In(loc)
    targetTime := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, loc)

    if targetTime.Before(now) {
        targetTime = targetTime.Add(24 * time.Hour)
    }

    return s.queue.ScheduleAt(userID, "daily_digest", targetTime.UTC())
}
```

### Mistake 4: Unbounded Notification Queues

Allocating a channel buffer of one million entries may appear to provide headroom, but under a sustained traffic spike the goroutine runtime will quietly allocate gigabytes of memory for pending `Notification` pointers until the process is OOM-killed, dropping every in-flight message. The good design uses three separate bounded channels for high, normal, and low priority traffic, and routes overflow to a disk-backed queue rather than discarding or blocking indefinitely. Critical notifications are given a blocking path that waits on context cancellation instead of overflowing, ensuring they are never silently dropped while non-critical ones are safely spooled to disk for later processing.

```go
// BAD: Unbounded queue can cause OOM
type BadQueue struct {
    notifications chan *Notification // Unbounded channel via buffer
}

func NewBadQueue() *BadQueue {
    return &BadQueue{
        notifications: make(chan *Notification, 1000000), // 1M buffer!
    }
}

// GOOD: Bounded queue with backpressure
type GoodQueue struct {
    high     chan *Notification
    normal   chan *Notification
    low      chan *Notification
    overflow *DiskQueue
    metrics  *Metrics
}

func NewGoodQueue(config QueueConfig) *GoodQueue {
    return &GoodQueue{
        high:     make(chan *Notification, config.HighBuffer),
        normal:   make(chan *Notification, config.NormalBuffer),
        low:      make(chan *Notification, config.LowBuffer),
        overflow: NewDiskQueue(config.OverflowPath),
    }
}

func (q *GoodQueue) Enqueue(ctx context.Context, n *Notification) error {
    ch := q.getChannel(n.Priority)

    select {
    case ch <- n:
        return nil
    default:
        // Channel full - apply backpressure or overflow
        if n.Priority == PriorityCritical {
            // Critical notifications wait
            select {
            case ch <- n:
                return nil
            case <-ctx.Done():
                return ctx.Err()
            }
        }

        // Non-critical overflow to disk
        q.metrics.OverflowCount.Inc()
        return q.overflow.Write(n)
    }
}
```

### Mistake 5: Not Tracking Delivery Metrics

Firing notifications in a background goroutine with no instrumentation makes it impossible to know the delivery success rate, detect provider degradation, or set meaningful SLO alerts, problems only surface when users start complaining. The instrumented sender records three Prometheus metrics per delivery: a counter labeled by channel and notification type to track volume, a histogram for send latency, and a counter for failures labeled with the error category. It also writes structured records to a `DeliveryTracker` on both success and failure, providing a queryable audit trail that supports debugging, customer support investigations, and business-level delivery reporting.

```go
// BAD: Fire and forget with no visibility
func (s *BadSender) Send(n *Notification) {
    go s.provider.Send(n) // No tracking, no metrics
}

// GOOD: Comprehensive delivery tracking
type GoodSender struct {
    provider Provider
    tracker  *DeliveryTracker
    metrics  *prometheus.Registry

    sendTotal    *prometheus.CounterVec
    sendLatency  *prometheus.HistogramVec
    sendFailures *prometheus.CounterVec
}

func (s *GoodSender) Send(ctx context.Context, n *Notification) error {
    start := time.Now()

    // Track send attempt
    s.sendTotal.WithLabelValues(string(n.Channel), n.Type).Inc()

    err := s.provider.Send(ctx, n)

    // Record latency
    duration := time.Since(start)
    s.sendLatency.WithLabelValues(string(n.Channel)).Observe(duration.Seconds())

    if err != nil {
        s.sendFailures.WithLabelValues(string(n.Channel), errorType(err)).Inc()
        s.tracker.RecordFailure(ctx, n.ID, err)
        return err
    }

    s.tracker.RecordSent(ctx, n.ID, duration)
    return nil
}
```

### Junior -> FAANG: Common Mistakes as Interview Red Flags

These five mistakes are not obscure edge cases. They are the most common reasons notification systems fail in production, and FAANG interviewers use them as diagnostics for system design maturity.

Mistake 1 (single provider) is a design smell interviewers look for when you draw your architecture. If your diagram shows a direct arrow from "Notification Service" to "SendGrid" with no fallback, expect a follow-up: "What happens during a SendGrid outage?" The correct pre-emptive move is to draw the `EmailProvider` interface with SendGrid and SES as implementations, and the health checker selecting between them.

Mistake 2 (no idempotency) is a correctness issue, not a performance issue. Interviewers distinguish candidates who know the difference between "retry" (sending the request again) and "idempotent retry" (sending the request again, safe to do because duplicates are suppressed). Always mention idempotency keys when designing any API that produces external side effects.

Mistake 3 (UTC timezone) is a product quality issue that generates customer complaints. Knowing that `time.LoadLocation` is the correct way to compute user-local time, and that the naive approach of using `time.Now()` will produce 3 AM notifications for some users, is a basic Go competency. Demonstrate it by writing the correct scheduling code during the interview.

Mistake 4 (unbounded channels) maps to a general Go best practice: always know the size of your goroutine's work queue. An unbounded channel is a potential OOM, and the Go runtime will not warn you until the process crashes. The bounded channel with an overflow path is the correct production pattern.

Mistake 5 (no metrics) is an operational maturity signal. Senior candidates include metrics as part of their design, not as something to add later. The Prometheus counter and histogram in the instrumented sender are the minimum: add at minimum total send attempts, success count, failure count by error category, and send latency histogram.

### Senior @ FAANG: Mistake Categories and Systemic Fixes

**Provider failure is a class of mistake, not an isolated bug**

Mistake 1 is not just about SendGrid being down. It is about the entire category of external dependency failures. A notification system has multiple external dependencies: the email provider, the SMS provider, the push provider, the preference database, the template database, the idempotency store, and the delivery tracking store. Each of these can fail independently. A system that fails when any one of them is unavailable is fragile by design. A resilient system uses circuit breakers on each dependency, fallback policies (degrade gracefully: skip preference check under load, fall back to default preferences), and a dead letter queue for notifications that could not be processed due to dependency failures.

**Idempotency is a system-wide contract, not a function-level feature**

Mistake 2 is symptomatic of treating idempotency as a feature of one function rather than a system-wide contract. Every API endpoint, every queue consumer, every retry loop must participate in the idempotency contract. The idempotency key must be generated by the caller (not the server) so it can be sent on the first attempt and all retries. The idempotency store (Redis or Postgres) must be the first check before any mutable operation. Documenting this as a platform contract and providing a library that enforces it is a staff-level contribution.

**Timezone handling belongs in the data model**

Mistake 3 recurs because timezone is often treated as a display concern rather than a data model concern. When the user's timezone is stored in the preference system (as shown in `UserPreferences.Timezone`), timezone-aware scheduling is mechanical. When it is not stored (or stored in a format that `time.LoadLocation` cannot parse), every scheduled feature becomes a source of bugs. The architectural fix is to make timezone a required field in the user profile, validated at registration, with a list of IANA timezone identifiers as the allowlist.

**Backpressure is the systemic fix for unbounded queues**

Mistake 4 is a symptom of not thinking about backpressure. A production notification system must define, for each queue: the maximum depth, the behavior when that depth is exceeded (block, overflow to disk, drop with a logged alert), and the alert threshold (page on-call when depth exceeds 80% of maximum). The `GoodQueue` with its overflow path to a disk queue is the right pattern. The disk queue implementation must be durable (survive process restarts) and bounded (it cannot grow infinitely either). This chain of bounded queues with defined overflow behavior is the correct production design.

**Metrics without alerting is insufficient**

Mistake 5 addresses missing metrics. But for a senior candidate, the follow-up is: "You have the metrics. What alerts do you set?" The minimum useful alert set for a notification service: delivery success rate below 95% (page), provider error rate above 1% (warn), end-to-end notification latency p99 above 5 seconds (warn for transactional, critical for OTP), and queue depth above 80% of maximum (page). These alerts must be defined, tested, and owned by the team responsible for the notification service before the service goes to production.

---
