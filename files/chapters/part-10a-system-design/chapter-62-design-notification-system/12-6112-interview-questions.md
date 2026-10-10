## Interview Questions

### Question 1: How would you ensure exactly-once delivery for critical notifications?

**What FAANG expects:** Honest framing first: strict exactly-once is impossible across independent systems (FLP + the two-generals problem). What you deliver is "effectively-once" via idempotency keys + atomic state machine on your side, *and* provider-level dedup (most email/SMS providers already de-dup by message ID). Bonus for calling out that push providers (APNs, FCM) do their own best-effort dedup and that carrier SMS routes can still double-send.

**Answer:**

Exactly-once delivery for notifications requires combining idempotency keys with atomic state transitions so that a notification is sent at most once even if the process crashes and retries. The idempotency key, typically derived from the notification ID, is stored in Redis with a short TTL. If the key already exists, the send is a no-op. A two-phase approach (mark as "sending" → attempt delivery → mark as "sent") ensures that a crash during delivery can be safely retried without re-sending to the user.

```go
// Exactly-once delivery using idempotency and two-phase commit
type ExactlyOnceDelivery struct {
    store     NotificationStore
    provider  Provider
    redis     *redis.Client
}

func (d *ExactlyOnceDelivery) Send(ctx context.Context, n *Notification) error {
    // Phase 1: Mark as "sending" with idempotency check
    lockKey := fmt.Sprintf("notif:lock:%s", n.IdempotencyKey)
    acquired, err := d.redis.SetNX(ctx, lockKey, "sending", 5*time.Minute).Result()
    if err != nil {
        return err
    }
    if !acquired {
        // Check if already completed
        status, _ := d.redis.Get(ctx, lockKey).Result()
        if status == "delivered" {
            return nil // Already sent
        }
        return ErrDeliveryInProgress
    }

    // Phase 2: Actually send
    err = d.provider.Send(ctx, n)
    if err != nil {
        d.redis.Del(ctx, lockKey) // Release lock on failure
        return err
    }

    // Phase 3: Mark as delivered (with longer TTL for dedup)
    d.redis.Set(ctx, lockKey, "delivered", 24*time.Hour)

    // Also persist to database for audit
    d.store.MarkDelivered(ctx, n.ID, time.Now())

    return nil
}
```

**Key points:**
- Use distributed locks to prevent concurrent sends
- Store idempotency keys with TTL for deduplication
- Two-phase approach: lock, send, confirm
- Persist delivery status for audit and recovery

**Follow-ups:**
- *Why is the `SETNX` lock a risk?* Redis replica promotion can lose the lock write. For billing-grade "effectively-once", use Postgres with a `UNIQUE` index on the idempotency key. Slower, but consistent through failover.
- *What happens if the provider times out mid-send?* You do not know if the provider sent or not. Policy options: retry (risks double-send), mark as unknown and alert (false "delivered" status), or dedupe via provider-side ID (best). APNs, FCM, Twilio, and Mailgun all support client-side idempotency keys now.
- *How long do you keep the idempotency record?* Longer than any reasonable retry window, typically 24-72h. Stripe keeps for 24h and rejects retries after. That is the pattern to copy.

### Question 2: Design a system to handle notification preferences at scale

**What FAANG expects:** Hierarchical preferences (global → category → channel → type), cached per-user with jittered TTL, quiet hours with timezone awareness, and an unsubscribe-as-a-right design (CAN-SPAM, GDPR, CASL). Bonus for calling out that preferences are read-heavy (every notification checks them) and write-light (user changes preferences rarely), so aggressive caching with event-driven invalidation is the right architecture.

**Answer:**

```go
// Scalable preference system with caching and inheritance
type PreferenceSystem struct {
    db       *sql.DB
    cache    *redis.ClusterClient
    defaults *DefaultPreferences
}

type PreferenceHierarchy struct {
    Global      *GlobalPrefs
    Category    map[string]*CategoryPrefs
    Channel     map[string]*ChannelPrefs
    Granular    map[string]*NotificationTypePrefs
}

func (p *PreferenceSystem) ShouldSend(ctx context.Context, userID string, n *Notification) (bool, []Channel, error) {
    prefs, err := p.getPreferences(ctx, userID)
    if err != nil {
        return false, nil, err
    }

    // Check hierarchy: Global -> Category -> Channel -> Type
    if !prefs.Global.Enabled {
        return false, nil, nil
    }

    category := p.getCategory(n.Type)
    if catPref, ok := prefs.Category[category]; ok && !catPref.Enabled {
        return false, nil, nil
    }

    // Determine which channels to use
    channels := make([]Channel, 0)
    for _, ch := range []Channel{ChannelPush, ChannelEmail, ChannelSMS} {
        if p.isChannelEnabled(prefs, ch, n.Type) {
            channels = append(channels, ch)
        }
    }

    // Check quiet hours
    if p.isInQuietHours(prefs, n.Priority) {
        if n.Priority != PriorityCritical {
            return false, nil, nil
        }
    }

    return len(channels) > 0, channels, nil
}

func (p *PreferenceSystem) getPreferences(ctx context.Context, userID string) (*PreferenceHierarchy, error) {
    // Try cache first (99% hit rate expected)
    cacheKey := fmt.Sprintf("prefs:v2:%s", userID)
    cached, err := p.cache.Get(ctx, cacheKey).Bytes()
    if err == nil {
        var prefs PreferenceHierarchy
        json.Unmarshal(cached, &prefs)
        return &prefs, nil
    }

    // Load from DB with single query using JSON aggregation
    prefs, err := p.loadFromDB(ctx, userID)
    if err != nil {
        return p.defaults.Get(), nil // Return defaults on error
    }

    // Cache with jittered TTL to prevent thundering herd
    ttl := time.Hour + time.Duration(rand.IntN(600))*time.Second
    data, _ := json.Marshal(prefs)
    p.cache.Set(ctx, cacheKey, data, ttl)

    return prefs, nil
}
```

**Follow-ups:**
- *How do you handle timezone-aware quiet hours cheaply?* Store preferences as `"22:00-07:00"` + user timezone, evaluate at send time. Do not cache per-tz because the user can travel. Evaluating once per notification is cheap.
- *Can a "global enable=off" override legal/transactional notifications?* No. Security alerts, password resets, billing failures must send regardless of preferences (legal obligation). Tag those notifications as `transactional` and bypass the preference check with an audit log entry.
- *How do you publish preference changes so caches invalidate?* Postgres LISTEN/NOTIFY or a Kafka topic. Every node subscribes and drops the cache key on change. Pure TTL is fine too if your TTL is short enough (5 min) and the UX can tolerate it.

### Question 3: How would you implement notification aggregation for social apps?

**What FAANG expects:** Windowed aggregation in Redis sorted sets, bucketed by (user, type, target). Minimum threshold for aggregation, maximum window duration, and graceful fallback to individual messages under the threshold. Bonus for describing "digest" semantics (hourly/daily rollups for low-priority notifications) vs real-time aggregation, and for noting that aggregation benefits user retention (fewer push notifications = higher engagement).

**Answer:**

```go
// Smart notification aggregation like "John and 5 others liked your post"
type SmartAggregator struct {
    redis     *redis.Client
    templates *TemplateEngine
    config    AggregationConfig
}

type AggregationConfig struct {
    WindowDuration time.Duration
    MaxItems       int
    MinItems       int // Don't aggregate fewer than this
}

type AggregatedData struct {
    Type       string
    TargetID   string // e.g., post ID
    Actors     []Actor
    Count      int
    FirstAt    time.Time
    LastAt     time.Time
}

func (a *SmartAggregator) AddAndMaybeAggregate(ctx context.Context, userID string, n *Notification) (*Notification, error) {
    // Create aggregation key based on type and target
    aggKey := fmt.Sprintf("agg:%s:%s:%s", userID, n.Type, n.Data["target_id"])

    // Add to aggregation window
    actor := Actor{
        ID:   n.Data["actor_id"].(string),
        Name: n.Data["actor_name"].(string),
    }
    actorJSON, _ := json.Marshal(actor)

    pipe := a.redis.Pipeline()
    pipe.ZAdd(ctx, aggKey, redis.Z{
        Score:  float64(time.Now().UnixMilli()),
        Member: string(actorJSON),
    })
    pipe.Expire(ctx, aggKey, a.config.WindowDuration)
    countCmd := pipe.ZCard(ctx, aggKey)
    pipe.Exec(ctx)

    count := countCmd.Val()

    // Not enough to aggregate yet
    if count < int64(a.config.MinItems) {
        return n, nil // Send individual notification
    }

    // Get all actors for aggregated message
    actors, _ := a.redis.ZRange(ctx, aggKey, 0, int64(a.config.MaxItems)-1).Result()

    actorList := make([]Actor, 0, len(actors))
    for _, a := range actors {
        var actor Actor
        json.Unmarshal([]byte(a), &actor)
        actorList = append(actorList, actor)
    }

    // Create aggregated notification
    aggNotification := &Notification{
        ID:       fmt.Sprintf("agg-%s", n.ID),
        UserID:   userID,
        Type:     n.Type + "_aggregated",
        Template: n.Type + "_aggregated",
        Data: map[string]any{
            "actors":    actorList,
            "count":     count,
            "target_id": n.Data["target_id"],
            "preview":   a.formatPreview(actorList, int(count)),
        },
    }

    // Clear aggregation window
    a.redis.Del(ctx, aggKey)

    return aggNotification, nil
}

func (a *SmartAggregator) formatPreview(actors []Actor, total int) string {
    if len(actors) == 1 {
        return actors[0].Name
    }
    if len(actors) == 2 {
        return fmt.Sprintf("%s and %s", actors[0].Name, actors[1].Name)
    }
    others := total - 1
    return fmt.Sprintf("%s and %d others", actors[0].Name, others)
}
```

**Follow-ups:**
- *What is a good window size?* Push: 2-5 minutes (user expects near-real-time). Email: 15-60 minutes. In-app inbox: aggregate on read, not on arrival.
- *How do you avoid the "late arrival" bug where a 6th actor arrives after flushing 5?* Keep the window key alive with a longer TTL than the flush interval, track the "sent count" in the aggregate, and continue merging into the same delivered notification (update the preview text on the client via WebSocket/SSE).
- *Digest vs real-time aggregation, when do you pick digest?* Low-salience notifications (mentions on a wiki, weekly summary). Real-time aggregation is for high-salience but bursty events (likes on a viral post).

### Junior -> FAANG: Interview Preparation Patterns for Notification Questions

These three questions represent the full range of notification system interview depth. Prepare by being able to answer each question at two levels: the "what" (the mechanism) and the "why" (the trade-off that makes this mechanism the right choice).

For exactly-once delivery: the key prerequisite gap for most junior candidates is not knowing that strict exactly-once is impossible across independent systems. Once you know this, the interview answer becomes much cleaner: "We can achieve effectively-once by combining idempotency on our side with provider-side deduplication. Here is how each piece works." This framing preemptively addresses the interviewer's follow-up and shows distributed systems maturity.

For preference system scaling: the prerequisite gap is understanding why preferences are read-heavy and write-light. Once you know this, the correct architecture (aggressive caching, event-driven invalidation on writes) follows logically. Junior candidates who have not thought about the read/write ratio design a preference service that reads from the database on every notification, which would add 10-50ms of latency to every delivery and would not scale.

For aggregation: the prerequisite gap is the "window" concept. Understanding that aggregation requires a time window with a configurable width, a flush mechanism, and a threshold between "send individually" and "aggregate" is the foundation. Candidates who understand this can then reason about the Redis sorted set as the natural data structure for the window, and can discuss the flush trigger (time-based vs count-based vs both).

### Senior @ FAANG: Bar-Raiser Signals in Notification System Interviews

**Signal 1: Distinguishing delivery guarantee levels unprompted**

A bar-raiser candidate opens the exactly-once answer by distinguishing at-most-once (fire and forget), at-least-once (retry without idempotency), and effectively-once (retry with idempotency). They then explain why strict exactly-once is provably impossible (FLP impossibility theorem, two generals problem), and pivot to the practical solution. This framing shows theoretical depth combined with pragmatic engineering judgment.

**Signal 2: Proposing the database-backed idempotency store for billing-grade deduplication**

Most candidates use Redis for idempotency (as shown in the code sample). A bar-raiser candidate knows when Redis is insufficient: Redis replica promotion can lose a `SETNX` result during failover, meaning the idempotency key is lost and the next retry would re-send. For billing-grade notifications (payment confirmation, subscription renewal), the idempotency store must be backed by a database with a `UNIQUE` constraint on the idempotency key, providing ACID durability guarantees. The candidate makes this distinction without being prompted.

**Signal 3: Naming the GDPR and CAN-SPAM implications for preference design**

The preference system follow-up question about "can global enable=off override legal notifications?" is a trap for candidates who treat all notifications uniformly. The bar-raiser answer names the legal categories: password resets, payment receipts, and account security alerts are transactional and must send regardless of marketing preferences. CAN-SPAM requires a functioning unsubscribe mechanism for commercial messages. GDPR's right to erasure does not apply to legitimate transactional communication. Knowing this taxonomy and proposing a `NotificationCategory` enum that drives bypass logic is the staff-level answer.

**Signal 4: Proposing digest vs real-time aggregation based on notification salience**

The aggregation question's bar-raiser answer distinguishes two aggregation models: real-time windowed aggregation (for high-salience bursty events like social interactions) and periodic digest delivery (for low-salience events like weekly summaries). The follow-up is: "How do you decide which model to use for a given notification type?" The answer involves user engagement data: if users open and act on individual notifications, keep them individual. If open rates drop as frequency increases, switch to aggregation. This data-driven framing shows product thinking combined with engineering depth, which is the combination FAANG looks for at L6+.

**Signal 5: Asking the right clarifying questions before designing**

Before answering any of the three questions above, a bar-raiser candidate asks clarifying questions: "What is the expected volume and failure rate?" (for exactly-once), "How many users and how often do preferences change?" (for preferences), "What is the expected burst size and acceptable notification frequency?" (for aggregation). These questions shape the design. A candidate who designs without constraints is solving a generic problem, not the actual problem. Interviewers reward clarifying questions as a signal of production experience.

---
