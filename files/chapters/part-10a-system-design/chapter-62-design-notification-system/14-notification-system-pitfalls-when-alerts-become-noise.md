## Notification System Pitfalls: When Alerts Become Noise

### Pitfall 1: Notification Flood During System Events

**Incident Report**: A brief database hiccup triggered 50,000 "order failed" notifications in 30 seconds. Most were false alarms as the database recovered, but users were already panicking and support was overwhelmed.

```go
// WRONG: Fire notification on every failure
func (s *OrderService) ProcessOrder(ctx context.Context, order *Order) error {
    err := s.db.CreateOrder(ctx, order)
    if err != nil {
        // Every transient failure sends notification
        s.notifier.Send(ctx, &Notification{
            UserID:  order.UserID,
            Type:    "order_failed",
            Message: "Your order could not be processed",
        })
        return err
    }
    return nil
}

// CORRECT: Debounce and aggregate failure notifications
type FailureNotificationAggregator struct {
    pending   map[string]*PendingNotification  // userID -> pending
    mu        sync.Mutex
    debounce  time.Duration
    notifier  *NotificationService
}

type PendingNotification struct {
    UserID      string
    Failures    []*FailureEvent
    FirstSeen   time.Time
    Timer       *time.Timer
}

func (a *FailureNotificationAggregator) RecordFailure(ctx context.Context, userID string, event *FailureEvent) {
    a.mu.Lock()
    defer a.mu.Unlock()

    pending, exists := a.pending[userID]
    if !exists {
        // First failure - start debounce timer
        pending = &PendingNotification{
            UserID:    userID,
            Failures:  []*FailureEvent{event},
            FirstSeen: time.Now(),
        }
        pending.Timer = time.AfterFunc(a.debounce, func() {
            a.sendAggregated(userID)
        })
        a.pending[userID] = pending
        return
    }

    // Add to existing failures
    pending.Failures = append(pending.Failures, event)

    // If too many failures, send immediately
    if len(pending.Failures) >= 5 {
        pending.Timer.Stop()
        a.sendAggregatedLocked(userID)
    }
}

func (a *FailureNotificationAggregator) sendAggregated(userID string) {
    a.mu.Lock()
    defer a.mu.Unlock()
    a.sendAggregatedLocked(userID)
}

func (a *FailureNotificationAggregator) sendAggregatedLocked(userID string) {
    pending, exists := a.pending[userID]
    if !exists || len(pending.Failures) == 0 {
        return
    }

    // If all failures were transient (recovered), skip notification
    var permanentFailures []*FailureEvent
    for _, f := range pending.Failures {
        if !f.Recovered {
            permanentFailures = append(permanentFailures, f)
        }
    }

    if len(permanentFailures) == 0 {
        delete(a.pending, userID)
        return
    }

    // Send aggregated notification
    a.notifier.Send(context.Background(), &Notification{
        UserID: userID,
        Type:   "order_failures_summary",
        Data: map[string]any{
            "failure_count": len(permanentFailures),
            "first_failure": pending.FirstSeen,
            "failures":      permanentFailures,
        },
    })

    delete(a.pending, userID)
}

// Mark failure as recovered (database came back)
func (a *FailureNotificationAggregator) RecordRecovery(userID string, orderID string) {
    a.mu.Lock()
    defer a.mu.Unlock()

    pending, exists := a.pending[userID]
    if !exists {
        return
    }

    for _, f := range pending.Failures {
        if f.OrderID == orderID {
            f.Recovered = true
        }
    }
}
```

### Pitfall 2: Push Token Staleness Causes Silent Failures

**Incident Report**: 30% of push notifications were silently failing. Investigation revealed mobile apps weren't refreshing FCM tokens, and the notification system had no mechanism to detect or handle stale tokens.

```go
// WRONG: Assume push tokens are always valid
func (s *PushService) Send(ctx context.Context, userID string, notification *Notification) error {
    token, err := s.db.GetPushToken(ctx, userID)
    if err != nil {
        return err
    }

    // Send without checking token validity
    return s.fcm.Send(ctx, &messaging.Message{
        Token: token,
        Notification: &messaging.Notification{
            Title: notification.Title,
            Body:  notification.Body,
        },
    })
    // FCM returns success even for expired tokens sometimes
}

// CORRECT: Track token health and handle failures
type PushTokenManager struct {
    db          *TokenStore
    fcm         *messaging.Client
    metrics     *PushMetrics
    retryQueue  *RetryQueue
}

func (m *PushTokenManager) Send(ctx context.Context, userID string, notification *Notification) error {
    tokens, err := m.db.GetPushTokens(ctx, userID)
    if err != nil {
        return err
    }

    var lastErr error
    successCount := 0

    for _, token := range tokens {
        // Skip tokens marked as invalid
        if token.InvalidatedAt != nil {
            continue
        }

        // Check last success time
        if token.LastSuccess != nil {
            age := time.Since(*token.LastSuccess)
            if age > 30*24*time.Hour {
                m.metrics.StaleTokenSkipped.Inc()
                continue
            }
        }

        err := m.sendToToken(ctx, token.Token, notification)
        if err != nil {
            lastErr = err
            m.handleSendError(ctx, userID, token, err)
        } else {
            successCount++
            m.db.UpdateLastSuccess(ctx, token.ID, time.Now())
        }
    }

    if successCount == 0 && lastErr != nil {
        // All tokens failed - queue for retry or fallback to other channel
        m.retryQueue.Add(ctx, &RetryableNotification{
            UserID:       userID,
            Notification: notification,
            Attempts:     1,
        })
        return lastErr
    }

    return nil
}

func (m *PushTokenManager) handleSendError(ctx context.Context, userID string, token *PushToken, err error) {
    // firebase-admin-go does not export an Error struct, error
    // classification goes through the messaging package's predicates.
    switch {
    case messaging.IsUnregistered(err) || messaging.IsInvalidArgument(err):
        // Token is invalid, mark it
        m.db.InvalidateToken(ctx, token.ID, err.Error())
        m.metrics.TokensInvalidated.Inc()

    case messaging.IsQuotaExceeded(err):
        // Rate limited, retry later
        m.metrics.QuotaExceeded.Inc()

    case messaging.IsUnavailable(err) || messaging.IsInternal(err):
        // Transient error, retry
        token.ConsecutiveFailures++
        m.db.UpdateFailureCount(ctx, token.ID, token.ConsecutiveFailures)
    }
}

// Periodic cleanup of stale tokens
func (m *PushTokenManager) CleanupStaleTokens(ctx context.Context) error {
    // Remove tokens with no success in 60 days
    cutoff := time.Now().Add(-60 * 24 * time.Hour)
    count, err := m.db.DeleteStaleTokens(ctx, cutoff)
    if err != nil {
        return err
    }
    m.metrics.TokensCleaned.Add(float64(count))
    return nil
}
```

### Pitfall 3: Email Bounce Handling Destroys Reputation

**Incident Report**: Email deliverability dropped from 98% to 60% over 3 months. The notification system kept sending to invalid addresses, accumulating bounces and damaging sender reputation.

```go
// WRONG: No bounce handling
func (s *EmailService) Send(ctx context.Context, email string, notification *Notification) error {
    return s.ses.SendEmail(ctx, &ses.SendEmailInput{
        Destination: &types.Destination{
            ToAddresses: []string{email},
        },
        // ... message content
    })
    // Bounces go to SNS but are never processed
}

// CORRECT: Full bounce management lifecycle
type EmailHealthManager struct {
    db           *EmailHealthStore
    ses          *ses.Client
    snsHandler   *SNSWebhookHandler
    suppressed   *bloom.BloomFilter  // Fast lookup for suppressed emails
}

func (m *EmailHealthManager) Send(ctx context.Context, email string, notification *Notification) error {
    // Check if email is suppressed
    if m.isEmailSuppressed(email) {
        m.metrics.SuppressedSkipped.Inc()
        return ErrEmailSuppressed
    }

    // Check email health
    health, _ := m.db.GetEmailHealth(ctx, email)
    if health != nil {
        if health.HardBounce {
            return ErrEmailHardBounced
        }
        if health.SoftBounceCount >= 3 {
            // Too many soft bounces, skip
            return ErrEmailTooManySoftBounces
        }
        if health.ComplaintAt != nil {
            // User marked as spam
            return ErrEmailComplaint
        }
    }

    // Send email
    result, err := m.ses.SendEmail(ctx, m.buildEmail(email, notification))
    if err != nil {
        return err
    }

    // Track sent
    m.db.RecordSent(ctx, email, *result.MessageId)
    return nil
}

// SNS webhook handler for bounces and complaints
func (m *EmailHealthManager) HandleBounceNotification(notification *SNSNotification) {
    for _, recipient := range notification.Bounce.BouncedRecipients {
        email := recipient.EmailAddress

        switch notification.Bounce.BounceType {
        case "Permanent":
            // Hard bounce - never send again
            m.db.MarkHardBounce(context.Background(), email)
            m.suppressed.Add([]byte(email))
            m.metrics.HardBounces.Inc()

        case "Transient":
            // Soft bounce - track but allow retry
            m.db.IncrementSoftBounce(context.Background(), email)
            m.metrics.SoftBounces.Inc()
        }
    }
}

func (m *EmailHealthManager) HandleComplaintNotification(notification *SNSNotification) {
    for _, recipient := range notification.Complaint.ComplainedRecipients {
        email := recipient.EmailAddress
        // User clicked "spam" - immediate suppression
        m.db.MarkComplaint(context.Background(), email)
        m.suppressed.Add([]byte(email))
        m.metrics.Complaints.Inc()
    }
}

func (m *EmailHealthManager) isEmailSuppressed(email string) bool {
    // Fast bloom filter check first
    if m.suppressed.Test([]byte(email)) {
        // Confirm with DB (bloom filters have false positives)
        health, _ := m.db.GetEmailHealth(context.Background(), email)
        return health != nil && (health.HardBounce || health.ComplaintAt != nil)
    }
    return false
}
```

### Pitfall 4: Quiet Hours Miscalculation Across Timezones

**Incident Report**: Users in Australia received marketing notifications at 3 AM. The quiet hours system used server timezone instead of user timezone.

```go
// WRONG: Using server time
func (s *NotificationService) shouldSend(userID string, notification *Notification) bool {
    now := time.Now()  // Server timezone!
    hour := now.Hour()

    if hour >= 22 || hour < 8 {  // "Quiet hours"
        return notification.Priority == "critical"
    }
    return true
}

// CORRECT: User-timezone aware quiet hours
type QuietHoursService struct {
    db       *UserPreferencesStore
    geoIP    *GeoIPService
    tzDB     *timezonedb.Client
}

func (s *QuietHoursService) CanSendNow(ctx context.Context, userID string, priority string) (bool, *time.Time) {
    prefs, err := s.db.GetPreferences(ctx, userID)
    if err != nil {
        // Fail open for critical, closed for marketing
        return priority == "critical", nil
    }

    // Get user's timezone
    tz := s.getUserTimezone(ctx, userID, prefs)
    if tz == nil {
        tz = time.UTC
    }

    // Convert current time to user's timezone
    userNow := time.Now().In(tz)
    userHour := userNow.Hour()
    userWeekday := userNow.Weekday()

    // Check user-defined quiet hours
    quietStart := prefs.QuietHoursStart  // e.g., 22:00
    quietEnd := prefs.QuietHoursEnd      // e.g., 08:00

    if s.isInQuietHours(userHour, quietStart, quietEnd) {
        if priority == "critical" {
            return true, nil  // Critical ignores quiet hours
        }

        // Calculate when to send
        nextSendTime := s.calculateNextSendTime(userNow, quietEnd, tz)
        return false, &nextSendTime
    }

    // Check day-of-week preferences (e.g., no marketing on weekends)
    if priority == "marketing" && !prefs.MarketingDays[userWeekday] {
        nextSendTime := s.calculateNextMarketingDay(userNow, prefs.MarketingDays, tz)
        return false, &nextSendTime
    }

    return true, nil
}

func (s *QuietHoursService) getUserTimezone(ctx context.Context, userID string, prefs *UserPreferences) *time.Location {
    // 1. User-set timezone preference (most accurate)
    if prefs.Timezone != "" {
        loc, err := time.LoadLocation(prefs.Timezone)
        if err == nil {
            return loc
        }
    }

    // 2. Infer from last known IP
    lastIP, err := s.db.GetLastIP(ctx, userID)
    if err == nil {
        tz, err := s.geoIP.GetTimezone(lastIP)
        if err == nil {
            loc, _ := time.LoadLocation(tz)
            return loc
        }
    }

    // 3. Infer from phone number country code
    if prefs.Phone != "" {
        tz := s.inferTimezoneFromPhone(prefs.Phone)
        if tz != nil {
            return tz
        }
    }

    return nil
}

func (s *QuietHoursService) isInQuietHours(hour int, start, end int) bool {
    if start <= end {
        // Same day (e.g., 08:00-18:00)
        return hour >= start && hour < end
    }
    // Spans midnight (e.g., 22:00-08:00)
    return hour >= start || hour < end
}
```

### Quick Reference: Notification System Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Notification flood | User panic, support overload | Debounce, aggregate, detect recovery |
| Stale push tokens | Silent delivery failures | Track token health, cleanup stale |
| Bounce handling | Reputation damage | Process bounces, suppress bad emails |
| Timezone bugs | 3 AM notifications | User timezone, geo-inference |

### Junior -> FAANG: Pitfall Recognition as a First-Job Skill

These four pitfalls are production incidents waiting to happen in any rapidly growing system. The ability to recognize them in a code review, before they cause an incident, is a senior engineering trait that junior candidates can develop.

Pitfall 1 (notification flood) happens when the caller sends a notification on every failure without thinking about the delivery rate from the user's perspective. The first habit to build: before writing any notification send call, ask "what is the maximum rate at which this notification can be sent to a single user?" If the answer is "it depends on how often the triggering condition occurs," you need a rate limit or a debounce.

Pitfall 2 (stale push tokens) is invisible until it is measured. A push delivery that returns "success" from the application layer but silently fails at FCM is the worst kind of failure: your metrics look fine, but users are not receiving notifications. The fix (tracking `LastSuccess` per token and invalidating tokens on FCM's `UNREGISTERED` response) must be built in from the start because retrofitting it requires a database migration.

Pitfall 3 (email bounce handling) is a deliverability concern that becomes critical at scale. At low volume (under 10K emails/day), bounce rates rarely trigger provider penalties. At high volume, a 5% hard bounce rate will cause SendGrid or SES to pause your account. Understanding the difference between hard bounces (permanent delivery failure, never retry) and soft bounces (temporary failure, retry after a delay) is a prerequisite for building a production email system.

Pitfall 4 (timezone miscalculation) produces user-visible bugs that are embarrassing and erode trust. The fix (`time.Now().In(loc)` using the user's stored timezone) is three lines of code. The prerequisite is having the timezone stored. Building the timezone capture into the user registration flow is a product decision that must be made early because retrofitting it for existing users requires an inference step (geo-IP lookup from last login, phone number country code, or explicit user prompt).

### Senior @ FAANG: Pitfalls as Architectural Signals

**Pitfall 1 reveals a missing contract between systems**

The notification flood incident is not just a bug in the order service. It reveals a missing contract: the order service should not know about notification policy (when to suppress, aggregate, or delay). That policy belongs in the notification platform. The architectural fix is the `FailureNotificationAggregator` shown in the code, but at a platform level, this aggregation logic should be part of the platform's event deduplication layer, not the order service's code. Each service that sends notifications should declare its notification types and their aggregation policy, and the platform enforces it.

**Pitfall 2 is a data lifecycle management problem**

Stale push tokens are not just a notification problem. They are a data lifecycle problem: device token records are being created (on app install or re-registration) but never deleted (on app uninstall or token rotation). The fix requires a cleanup process (`CleanupStaleTokens`) that runs periodically, but also requires that the cleanup process is idempotent (safe to run multiple times), bounded (does not scan the entire token table in one query), and auditable (logs how many tokens were cleaned). These are data management concerns that span the notification system and the user device registry.

**Pitfall 3 requires a compliance and reputation model**

Email bounce handling is not just a technical concern. It is a reputation management concern. Email providers (SendGrid, SES, Mailgun) calculate your sender reputation based on bounce rates, spam complaint rates, and engagement metrics (opens, clicks). A low reputation leads to emails going to spam or delivery being suspended. Managing sender reputation requires: suppressing hard bounces immediately, treating soft bounces with a back-off policy, monitoring complaint rates, and warming new sending IPs gradually (starting with low volume and increasing over weeks). This is an operational discipline that engineering teams at FAANG must own alongside the platform teams.

**Pitfall 4 is a symptom of not modeling user context**

The timezone bug is one instance of a general pattern: the notification system does not model user context (timezone, locale, device, presence) as a first-class concern. A system that models user context correctly would store timezone in the user profile, validate it at registration, and expose it through a `UserContext` object that every notification routing decision consults. The fixes for quiet hours (Pitfall 4 in this section), timezone-aware scheduling (Mistake 3 in Section 62.11), and presence-aware routing (Slack case study) are all instances of the same underlying architectural concern: user context must be a first-class input to the delivery decision, not a detail looked up ad-hoc in each component.

---
