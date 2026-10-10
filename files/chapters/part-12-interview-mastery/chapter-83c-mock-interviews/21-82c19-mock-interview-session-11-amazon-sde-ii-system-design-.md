## 83C.19 Mock Interview Session 11: Amazon SDE-II System Design - Notification System with LP Integration

### Interviewer Briefing

**Company style:** Amazon. SDE-II (Senior SDE). Amazon system design interviews uniquely integrate Leadership Principles into the technical discussion. The interviewer expects the candidate to naturally reference LPs when making design decisions - "Customer Obsession" when prioritizing features, "Bias for Action" when choosing pragmatic solutions, "Invent and Simplify" when proposing novel approaches. The interviewer will directly ask LP-related questions during the design.

**Level:** SDE-II (equivalent to L5 at Google)

**Interview duration:** 45 minutes

**Key evaluation criteria:** System design fundamentals, LP integration, customer-centric thinking, operational excellence, scalability.

### Problem Statement

*Read this to the candidate:*

> Design a notification system for a large e-commerce platform (like Amazon). The system should support:
>
> - Multiple channels: push notifications, email, SMS, and in-app notifications
> - User notification preferences (opt-in/opt-out per channel and per notification type)
> - Rate limiting (no more than X notifications per user per hour)
> - Priority levels (transactional > marketing > informational)
> - Template-based content with personalization (user name, order details, etc.)
> - Delivery tracking and analytics
> - Support for 500 million users, 1 billion notifications per day
>
> The system must be highly available and handle peak load during events like Prime Day (10x normal volume).

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| [0:00]-[2:00] | Read & Clarify | Candidate reads problem, asks clarifying questions |
| [2:00]-[5:00] | LP Integration: Customer Obsession | How requirements reflect customer needs |
| [5:00]-[10:00] | Capacity Estimation | Back-of-envelope math for the system |
| [10:00]-[18:00] | High-Level Architecture | Major components and data flow |
| [18:00]-[28:00] | Detailed Component Design | Deep dive into key components |
| [28:00]-[35:00] | LP Integration: Operational Excellence | Monitoring, failure handling, deployment |
| [35:00]-[40:00] | Scaling & Prime Day Scenario | 10x load handling |
| [40:00]-[45:00] | Follow-up Questions | Trade-offs and alternatives |

### Interviewer Script & Candidate Response

**[0:00] Interviewer:** *"Here's our design problem today. Take a moment to read through the requirements."*

**[1:30] Candidate:** "Before I start, a few clarifying questions:
1. For transactional notifications (order confirmations, shipping updates), what's the delivery SLA? Seconds? Minutes?
2. Is there a requirement for notification batching - grouping multiple updates into one notification?
3. Do we need to support templates in multiple languages?
4. For in-app notifications, do users need to see historical notifications (notification inbox)?
5. Should the system support scheduled notifications (send at a specific time)?"

**[2:00] Interviewer:** *"Great questions. Transactional SLA is under 30 seconds. Yes, support batching for marketing. Yes, multi-language. Yes, notification inbox with 90-day retention. And yes, support scheduling. Now, before we dive into the architecture - from a Customer Obsession perspective, which of these requirements do you think matters most to the end user?"*

**[2:30] Candidate:** "From a Customer Obsession standpoint, I'd rank them:

1. **Transactional delivery reliability** - A customer who buys something and doesn't get an order confirmation loses trust instantly. This is the highest-stakes notification. Losing a marketing email is annoying. losing an order confirmation is damaging.

2. **Preference respect** - Nothing frustrates customers more than receiving notifications they explicitly opted out of. This is worse than spam because it's a betrayal of stated preferences. Getting this wrong drives customers away.

3. **Rate limiting** - Over-notifying is the number one reason users disable notifications entirely, which then means we lose the channel for transactional messages too. Rate limiting protects the customer's attention and our communication channel simultaneously.

4. **Timeliness** - A shipping notification that arrives 2 hours after the package is meaningless. Timely delivery builds trust.

I'd design the system to guarantee these in priority order - even if it means marketing notifications are occasionally delayed or batched more aggressively."

**[5:00] Interviewer:** *"I like that prioritization. Go ahead with capacity estimation."*

**[5:30] Candidate:** "Let me estimate:

- **Daily volume:** 1 billion notifications/day
- **Per second (average):** 1B / 86,400 ≈ ~11,600 notifications/sec
- **Peak (Prime Day 10x):** ~116,000 notifications/sec
- **Spike within peak:** Prime Day has lightning deals that trigger bursts. Estimate 5x peak = ~580,000 notifications/sec for 30-second windows

**Storage:**
- Notification record: ~500 bytes (ID, user ID, type, channel, status, template ID, personalization data, timestamps)
- Daily: 1B × 500B = ~500 GB/day
- 90-day retention: ~45 TB
- User preferences: 500M users × 200 bytes = ~100 GB (fits in memory with Redis)

**Channel breakdown (estimated):**
- Push: 40% = 400M/day (via APNS and FCM)
- Email: 30% = 300M/day (via SES/SendGrid)
- SMS: 5% = 50M/day (via SNS/Twilio)
- In-app: 25% = 250M/day (stored for inbox)

**Key constraint:** APNS and FCM have rate limits and batch APIs. We need to batch push notifications (1000 per APNS request). Email providers also have sending limits per second."

**[8:00] Interviewer:** *"Good numbers. Walk me through the architecture."*

**[8:30] Candidate:** "Here's the high-level architecture:

```
[Event Sources] → [Notification Service API] → [Kafka: notification-events]
                                                        ↓
                                               [Priority Router]
                                              ↙     ↓      ↓     ↘
                                      [Critical] [High] [Normal] [Low]
                                      (SQS FIFO) (SQS) (SQS)   (SQS)
                                              ↘     ↓      ↓     ↙
                                          [Preference & Rate Limit Filter]
                                                        ↓
                                               [Template Engine]
                                                        ↓
                                              [Channel Dispatcher]
                                           ↙    ↙       ↘      ↘
                                      [Push] [Email]  [SMS]  [In-App]
                                      Worker  Worker  Worker  Worker
                                         ↓      ↓       ↓       ↓
                                      [APNS]  [SES]  [Twilio] [DynamoDB]
                                      [FCM]
                                              ↘     ↓      ↓     ↙
                                          [Delivery Tracker (Kafka)]
                                                        ↓
                                              [Analytics Pipeline]
```

**Components:**

**1. Notification Service API (Go)**
- gRPC and REST endpoints for submitting notifications
- Validates request, generates notification ID (ULID)
- Publishes to Kafka `notification-events` topic
- Returns immediately (async processing)

```go
// NotificationRequest is the API contract for submitting a notification.
type NotificationRequest struct {
    UserID            string            `json:"user_id" validate:"required"`
    NotificationType  string            `json:"notification_type" validate:"required,oneof=transactional marketing informational"`
    Priority          string            `json:"priority" validate:"required,oneof=critical high normal low"`
    TemplateID        string            `json:"template_id" validate:"required"`
    Personalization   map[string]string `json:"personalization"`
    Channels          []string          `json:"channels" validate:"dive,oneof=push email sms in_app"`
    ScheduledAt       *time.Time        `json:"scheduled_at,omitempty"`
    IdempotencyKey    string            `json:"idempotency_key" validate:"required"`
}

// NotificationEvent represents the queued event published to Kafka.
type NotificationEvent struct {
    ID        string               `json:"id"`
    Request   *NotificationRequest `json:"request"`
    CreatedAt time.Time            `json:"created_at"`
    Status    string               `json:"status"`
}

// MetricsClient abstracts metric collection.
type MetricsClient interface {
    Counter(name string) prometheus.Counter
}

// NotificationService handles notification submission.
type NotificationService struct {
    kafkaWriter    *kafka.Writer
    validator      *validator.Validate
    idempotencyDB  *redis.Client
    metrics        MetricsClient
}

// Submit validates and queues a notification for processing.
func (ns *NotificationService) Submit(ctx context.Context, req *NotificationRequest) (string, error) {
    // Validate request
    if err := ns.validator.Struct(req); err != nil {
        return "", fmt.Errorf("validation error: %w", err)
    }

    // Idempotency check
    notifID := ulid.Make().String()
    ok, err := ns.idempotencyDB.SetNX(ctx,
        fmt.Sprintf("notif:idem:%s", req.IdempotencyKey),
        notifID,
        24*time.Hour,
    ).Result()
    if err != nil {
        return "", fmt.Errorf("idempotency check: %w", err)
    }
    if !ok {
        // Already submitted - return existing notification ID
        existing, _ := ns.idempotencyDB.Get(ctx,
            fmt.Sprintf("notif:idem:%s", req.IdempotencyKey),
        ).Result()
        return existing, nil
    }

    // Publish to Kafka
    event := NotificationEvent{
        ID:              notifID,
        Request:         req,
        CreatedAt:       time.Now(),
        Status:          "queued",
    }

    payload, err := json.Marshal(event)
    if err != nil {
        return "", fmt.Errorf("marshaling event: %w", err)
    }

    msg := kafka.Message{
        Topic: "notification-events",
        Key:   []byte(req.UserID),
        Value: payload,
    }

    if err := ns.kafkaWriter.WriteMessages(ctx, msg); err != nil {
        ns.metrics.Counter("submit_errors_total").Inc()
        return "", fmt.Errorf("publishing to Kafka: %w", err)
    }

    ns.metrics.Counter("notifications_submitted_total").Inc()
    return notifID, nil
}
```

**2. Priority Router**
- Consumes from `notification-events` Kafka topic
- Routes to priority-specific SQS queues
- Critical/transactional → SQS FIFO (ordering guarantee per user)
- Others → standard SQS with different visibility timeouts

**3. Preference & Rate Limit Filter**

```go
// PreferenceFilter checks user preferences and rate limits before delivery.
type PreferenceFilter struct {
    prefCache   *redis.Client  // User preferences cached in Redis
    prefDB      *dynamodb.Client // DynamoDB for persistent storage
    rateLimiter *RateLimiter
}

// UserPreference represents a user's notification settings.
type UserPreference struct {
    UserID            string            `json:"user_id"`
    GlobalOptOut      bool              `json:"global_opt_out"`
    ChannelPrefs      map[string]bool   `json:"channel_prefs"`       // channel → enabled
    TypePrefs         map[string]bool   `json:"type_prefs"`          // notification type → enabled
    QuietHoursStart   *int              `json:"quiet_hours_start"`   // hour in user's timezone (0-23)
    QuietHoursEnd     *int              `json:"quiet_hours_end"`
    Language          string            `json:"language"`
    Timezone          string            `json:"timezone"`
    UpdatedAt         time.Time         `json:"updated_at"`
}

// ShouldDeliver checks if a notification should be delivered based on preferences and rate limits.
func (pf *PreferenceFilter) ShouldDeliver(ctx context.Context, notif *NotificationEvent) (bool, string, error) {
    // Transactional notifications ALWAYS deliver (Customer Obsession - never block order confirmations)
    if notif.Request.NotificationType == "transactional" {
        return true, "transactional_bypass", nil
    }

    // Load user preferences (Redis cache with DynamoDB fallback)
    prefs, err := pf.loadPreferences(ctx, notif.Request.UserID)
    if err != nil {
        // Fail open for transactional, fail closed for marketing (Customer Obsession)
        if notif.Request.Priority == "critical" {
            return true, "pref_load_error_fail_open", nil
        }
        return false, "pref_load_error_fail_closed", err
    }

    // Check global opt-out
    if prefs.GlobalOptOut {
        return false, "global_opt_out", nil
    }

    // Check channel preference
    for _, channel := range notif.Request.Channels {
        if enabled, ok := prefs.ChannelPrefs[channel]; ok && !enabled {
            return false, fmt.Sprintf("channel_opted_out_%s", channel), nil
        }
    }

    // Check notification type preference
    if enabled, ok := prefs.TypePrefs[notif.Request.NotificationType]; ok && !enabled {
        return false, "type_opted_out", nil
    }

    // Check quiet hours
    if pf.isQuietHours(prefs) {
        // Queue for delivery after quiet hours end
        return false, "quiet_hours", nil
    }

    // Rate limit check
    allowed, err := pf.rateLimiter.Allow(ctx, notif.Request.UserID, notif.Request.NotificationType)
    if err != nil {
        return true, "rate_limit_error_fail_open", nil // Fail open
    }
    if !allowed {
        return false, "rate_limited", nil
    }

    return true, "approved", nil
}

func (pf *PreferenceFilter) loadPreferences(ctx context.Context, userID string) (*UserPreference, error) {
    return &UserPreference{}, nil
}

func (pf *PreferenceFilter) isQuietHours(prefs *UserPreference) bool {
    return false
}

// RateLimiter implements sliding window rate limiting per user.
type RateLimiter struct {
    redis *redis.Client
    // Limits per notification type per hour
    limits map[string]int // e.g., {"marketing": 3, "informational": 10, "transactional": 100}
}

// Allow checks if a user can receive another notification of this type.
func (rl *RateLimiter) Allow(ctx context.Context, userID, notifType string) (bool, error) {
    key := fmt.Sprintf("ratelimit:%s:%s", userID, notifType)
    limit := rl.limits[notifType]

    now := time.Now()
    windowStart := now.Add(-time.Hour)

    // Use Redis sorted set with timestamps as scores
    pipe := rl.redis.Pipeline()

    // Remove entries outside the window
    pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", windowStart.UnixNano()))

    // Count entries in the window
    countCmd := pipe.ZCard(ctx, key)

    _, err := pipe.Exec(ctx)
    if err != nil {
        return false, fmt.Errorf("rate limit check: %w", err)
    }

    if countCmd.Val() >= int64(limit) {
        return false, nil
    }

    // Add this notification to the window
    rl.redis.ZAdd(ctx, key, redis.Z{
        Score:  float64(now.UnixNano()),
        Member: fmt.Sprintf("%d", now.UnixNano()),
    })
    rl.redis.Expire(ctx, key, 2*time.Hour) // TTL > window size for safety

    return true, nil
}
```

**4. Template Engine**

```go
// TemplateEngine renders notification content with personalization.
type TemplateEngine struct {
    templates map[string]*NotificationTemplate // Loaded from DynamoDB/S3 at startup
    mu        sync.RWMutex
}

// NotificationTemplate defines a multi-channel, multi-language template.
type NotificationTemplate struct {
    ID       string
    Channels map[string]ChannelTemplate // channel → template
    Locales  map[string]LocaleStrings   // locale → translated strings
}

// LocaleStrings maps template keys to localized strings.
type LocaleStrings map[string]string

type ChannelTemplate struct {
    Subject string // For email
    Body    string // Go template syntax
    Title   string // For push notifications
}

// RenderedContent represents the generated notification text.
type RenderedContent struct {
    Subject string
    Body    string
    Title   string
}

// Render produces the final notification content for a specific channel and user.
func (te *TemplateEngine) Render(templateID, channel, locale string, data map[string]string) (*RenderedContent, error) {
    te.mu.RLock()
    tmpl, ok := te.templates[templateID]
    te.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("template %s not found", templateID)
    }

    channelTmpl, ok := tmpl.Channels[channel]
    if !ok {
        return nil, fmt.Errorf("channel %s not found in template %s", channel, templateID)
    }

    // Merge locale strings with personalization data
    mergedData := make(map[string]string)
    if locale != "" {
        if localeStrings, ok := tmpl.Locales[locale]; ok {
            for k, v := range localeStrings {
                mergedData[k] = v
            }
        }
    }
    for k, v := range data {
        mergedData[k] = v
    }

    // Render using Go's text/template
    bodyTmpl, err := template.New("body").Parse(channelTmpl.Body)
    if err != nil {
        return nil, fmt.Errorf("parsing body template: %w", err)
    }

    var buf strings.Builder
    if err := bodyTmpl.Execute(&buf, mergedData); err != nil {
        return nil, fmt.Errorf("rendering body: %w", err)
    }

    return &RenderedContent{
        Subject: channelTmpl.Subject,
        Body:    buf.String(),
        Title:   channelTmpl.Title,
    }, nil
}
```

**[18:00] Interviewer:** *"Good architecture. Let me ask an Amazon LP question: how does 'Bias for Action' apply to your design decisions here?"*

**[18:30] Candidate:** "Bias for Action shows up in several design decisions:

1. **Async processing with immediate acknowledgment:** The API returns immediately after queuing. We don't wait for delivery - this lets event sources fire-and-forget, unblocking their workflows. A synchronous design would add latency to every order placement, shipment update, and marketing trigger.

2. **Fail open for transactional, fail closed for marketing:** When the preference service is slow or down, transactional notifications proceed anyway. This is a reversible decision - we'd rather send a transactional notification to someone who opted out (and apologize) than fail to send an order confirmation. Marketing is the opposite - failing to send a marketing email has low cost, so we err on the side of not sending.

3. **Starting with SQS instead of building a custom priority queue:** SQS is a well-understood primitive that we can deploy today. A custom priority queue might be more efficient at 10x scale, but that's a decision we can make later with data. Ship the simpler solution now, optimize when we hit the limit.

4. **Template engine using Go's built-in text/template:** We could build a custom DSL or use a third-party templating engine with more features. But Go's text/template is built-in, well-tested, and handles our use cases. We can upgrade later if we need more sophisticated templating."

**[22:00] Interviewer:** *"Now let's think about failure modes. What happens when APNS is down? When your Kafka cluster has a partition failure? When a template has a bug?"*

**[22:30] Candidate:** "Let me address each:

**APNS/FCM Down:**
- Channel dispatchers implement circuit breakers (same pattern as Session 5)
- When push is down, notifications are buffered in a retry queue with exponential backoff
- For transactional notifications, we fall back to the next preferred channel (push fails → try email → try SMS)
- Channel fallback order is defined per notification type, not per user, to keep the logic manageable

**Kafka Partition Failure:**
- Kafka replication factor = 3, so single broker failure is transparent
- If an entire Kafka cluster is unavailable, the API service returns 503 and callers retry
- For transactional notifications during extended Kafka outage, we fall back to a synchronous path: API → directly invoke channel dispatchers (bypassing the queue). This is slower and less reliable, but ensures critical notifications are not lost.

```go
// ChannelDispatcher delivers notifications over an external provider channel.
type ChannelDispatcher interface {
    Send(ctx context.Context, notif *NotificationEvent) error
}

// FallbackDispatcher sends notifications synchronously when Kafka is unavailable.
type FallbackDispatcher struct {
    channelDispatchers map[string]ChannelDispatcher
    kafkaHealthy       atomic.Bool
}

func (fd *FallbackDispatcher) publishToKafka(ctx context.Context, notif *NotificationEvent) error {
    return nil
}

func (fd *FallbackDispatcher) bufferToDisk(notif *NotificationEvent) error {
    return nil
}

// Submit tries Kafka first, falls back to synchronous dispatch for critical notifications.
func (fd *FallbackDispatcher) Submit(ctx context.Context, notif *NotificationEvent) error {
    if fd.kafkaHealthy.Load() {
        return fd.publishToKafka(ctx, notif)
    }

    // Kafka is down - synchronous fallback for critical only
    if notif.Request.Priority != "critical" {
        // Buffer in local disk queue for later replay
        return fd.bufferToDisk(notif)
    }

    // Synchronous dispatch - blocks but ensures delivery
    for _, channel := range notif.Request.Channels {
        if dispatcher, ok := fd.channelDispatchers[channel]; ok {
            if err := dispatcher.Send(ctx, notif); err == nil {
                return nil // Delivered on at least one channel
            }
        }
    }

    return fmt.Errorf("all channels failed for critical notification %s", notif.ID)
}
```

**Template Bug (Rendering Error):**
- Template rendering errors are caught per-notification and logged
- The notification is not dropped - it's sent with a safe fallback text: 'You have a new notification from [app_name]. Visit [url] for details.'
- Template errors trigger a PagerDuty alert if the error rate exceeds 1% of rendering attempts
- Templates are version-controlled and tested in a staging environment before deployment
- Template rollback takes < 1 minute (Redis cache invalidation + DynamoDB version pointer update)"

**[28:00] Interviewer:** *"How would you implement 'Operational Excellence' in this system - what does day-2 operations look like?"*

**[28:30] Candidate:** "Operational Excellence for a notification system means:

**Monitoring Dashboards:**
- Real-time: Notifications submitted/sec, delivered/sec, failed/sec - by channel and type
- Delivery latency: p50, p95, p99 from submission to delivery confirmation - by channel
- Preference filter: rejection rate by reason (opt-out, rate limit, quiet hours)
- Channel health: APNS/FCM/SES/Twilio response codes and latencies
- Queue depth: SQS queue sizes per priority level

**Alerting Rules:**
1. Delivery rate drops >20% from expected baseline (potential systemic issue)
2. Transactional notification latency p99 > 30 seconds (SLA breach)
3. Any channel error rate > 5% for 5 minutes (channel degradation)
4. Rate limiting rejecting > 50% of marketing notifications (misconfigured campaigns)
5. Queue depth growing faster than drain rate for > 10 minutes (capacity issue)

**Operational Runbooks:**
- Channel degradation: Automatic failover to backup channel, manual escalation to provider
- Queue backup: Auto-scaling worker fleet, manual capacity injection for sustained load
- Template error: Immediate rollback, incident review, template testing requirement

**Deployment:**
- Canary deployments: New version handles 5% of traffic for 30 minutes, auto-rollback on error rate increase
- Feature flags: New notification types, channels, and preference options are gated behind flags
- Load testing: Weekly replay of peak-day traffic against staging environment

**Cost Optimization (Frugality LP):**
- SMS is 10x more expensive than email and 100x more than push
- Route marketing notifications to cheapest available channel (push > email > SMS)
- Batch email sends to reduce SES API calls
- Archive notification history to S3 Glacier after 30 days, delete after 90 days"

**[35:00] Interviewer:** *"Prime Day is next week. You need to handle 10x normal load. What's your plan?"*

**[35:30] Candidate:** "Prime Day preparation:

**1. Pre-scaling (1 week before):**
- Scale all worker fleets to 10x baseline
- Pre-warm Kafka by adding partitions (can't be reversed, so choose carefully)
- Increase SQS visibility timeout for low-priority queues (avoid premature reprocessing)
- Pre-load all templates into Redis (avoid DynamoDB reads during peak)
- Verify APNS/FCM/SES rate limit quotas with providers - request temporary limit increases

**2. Traffic Shaping During Peak:**
- Marketing notifications are delayed during the first 2 hours of Prime Day (Customer Obsession - don't drown customers in marketing when they're actively shopping)
- Transactional notifications get dedicated worker capacity (reserved, not shared)
- Implement progressive rate limiting: if system load exceeds 80%, start throttling informational notifications. At 90%, throttle marketing. Never throttle transactional

**3. Real-Time Monitoring:**
- War room with dashboards showing all key metrics
- Pre-defined escalation paths: if transactional latency > 10s, page on-call immediately
- Pre-staged rollback plan for every component

**4. Post-Peak:**
- Drain marketing notification backlog over 4-6 hours after peak
- Generate delivery report for business stakeholders
- Conduct retrospective on any issues encountered"

**[40:00] Interviewer:** *"One more question: how would you handle a notification type that we haven't thought of yet - say, real-time auction bid notifications that need sub-second delivery?"*

**[40:30] Candidate:** "This is where 'Invent and Simplify' comes in. Sub-second delivery can't go through the full queue pipeline. I'd add a fast path:

- New priority level: 'real-time' - bypasses SQS entirely
- Kafka → dedicated real-time consumer group → WebSocket push to connected clients
- For clients not connected via WebSocket, fall back to standard push notification path
- The preference and rate limit checks happen in-line (not as separate service hops) using a local cache of preferences

The architecture should be extensible for new channel types and priority levels without redesigning the core pipeline. This is why I used Kafka as the central backbone - adding a new consumer group for a new delivery path is a deployment, not an architecture change."

### Scoring Rubric

| Dimension | 1 (Poor) | 3 (Meets Bar) | 5 (Exceptional) |
|-----------|----------|----------------|------------------|
| **Customer Obsession** | No mention of user impact, treats notifications as a technical problem | Considers user preferences and delivery reliability | Prioritizes requirements by customer impact, designs fail-open/fail-closed based on customer harm |
| **Architecture** | Missing major components, unclear data flow | All components present, reasonable flow | Elegant design with clear separation, extensibility, and justification for each choice |
| **Scalability** | Cannot handle 10x load, no scaling strategy | Basic horizontal scaling plan | Multi-level scaling strategy, traffic shaping, progressive degradation |
| **Fault Tolerance** | Single points of failure, no fallback | Basic retry and circuit breakers | Channel fallback, synchronous emergency path, graceful degradation hierarchy |
| **LP Integration** | Cannot connect design decisions to LPs | References LPs when asked | Naturally weaves LPs into design narrative - Customer Obsession, Bias for Action, Operational Excellence, Frugality |
| **Operational Excellence** | No mention of monitoring or operations | Basic metrics and alerting | Comprehensive observability, runbooks, canary deployments, cost optimization |
| **Communication** | Disorganized, hard to follow | Clear structure, reasonable flow | Drives the conversation, proactive about trade-offs, concise and focused |

**Scoring thresholds:**
- **Strong Hire:** Average ≥ 4.0, strong LP integration throughout
- **Hire:** Average ≥ 3.0, references LPs when prompted
- **Lean No Hire:** Average ≥ 2.5, weak LP integration
- **No Hire:** Average < 2.5 or cannot integrate LPs into design


### Junior → FAANG: Amazon SDE-II System Design Mock Basics

Amazon SDE-II system design interviews evaluate your ability to design reliable, scalable services that serve customers well. Amazon's evaluation lens connects every design decision to customer impact: why does this design choice result in a better experience for the customer? The SDE-II bar includes a complete high-level design, reasonable technology choices with brief justifications, and awareness of the failure modes that affect customer availability. Know Amazon's core infrastructure: DynamoDB (key-value and document database), S3 (object storage), SQS (message queue), SNS (pub-sub), and Lambda (serverless compute).

### Senior @ FAANG: Amazon SDE-III System Design: Operational Excellence and LP Integration

At the SDE-III level, Amazon system design interviews integrate the Leadership Principles into the technical discussion. Specifically: 'Dive Deep' means you should be able to go from high-level architecture to implementation details of any component on request. 'Ownership' means you should identify the operational requirements of your design (monitoring, alerting, runbook, on-call rotation) as part of the design itself, not as an afterthought. 'Invent and Simplify' means you should proactively identify unnecessary complexity in your design and simplify it. Bar-raisers at Amazon specifically probe for operational readiness: 'how would you detect that this service is degraded before customers call', 'what is the recovery procedure if this database fails over', and 'how do you verify that your retry logic does not create a thundering herd on recovery'. Answering these questions fluently signals genuine ownership of the system you are designing.

---
