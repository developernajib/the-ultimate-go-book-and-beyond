## 62.7 Rate Limiting and Throttling

Notification systems must rate-limit outbound messages per user to prevent notification fatigue and comply with carrier and app store throttling policies that can blacklist senders for exceeding per-recipient send rates. The notification limiter enforces per-user, per-channel, per-time-window limits using Redis counters, rejecting notifications that would exceed the limit rather than queuing them indefinitely. Different channels require different limits: SMS carriers typically enforce 1 message per second per number, while push notification providers allow higher burst rates but will throttle or drop messages if limits are sustained.

```go
// ratelimit/notification_limiter.go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// NotificationLimiter rate limits notifications per user
type NotificationLimiter struct {
    client       *redis.Client
    limits       map[string]Limit // notification type -> limit
    defaultLimit Limit            // "default" is a keyword, not a valid field name
}

// Limit defines rate limit configuration
type Limit struct {
    Count  int64
    Window time.Duration
}

// NewNotificationLimiter creates a new notification limiter
func NewNotificationLimiter(client *redis.Client) *NotificationLimiter {
    return &NotificationLimiter{
        client: client,
        limits: map[string]Limit{
            "marketing":     {Count: 2, Window: 24 * time.Hour},
            "social":        {Count: 50, Window: time.Hour},
            "transactional": {Count: 100, Window: time.Hour},
            "security":      {Count: 1000, Window: time.Hour}, // Higher limit for security
        },
        defaultLimit: Limit{Count: 20, Window: time.Hour},
    }
}

// Check checks if notification is within rate limit
func (l *NotificationLimiter) Check(ctx context.Context, userID, notificationType string) error {
    limit, ok := l.limits[notificationType]
    if !ok {
        limit = l.defaultLimit
    }

    key := fmt.Sprintf("notification:limit:%s:%s", userID, notificationType)

    // Use sliding window counter
    now := time.Now().UnixMilli()
    windowStart := now - limit.Window.Milliseconds()

    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window_start = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local window_ms = tonumber(ARGV[4])

        -- Remove old entries
        redis.call("ZREMRANGEBYSCORE", key, "-inf", window_start)

        -- Count current entries
        local count = redis.call("ZCARD", key)

        if count >= limit then
            return 0
        end

        -- Add new entry
        redis.call("ZADD", key, now, now .. "-" .. math.random())
        redis.call("PEXPIRE", key, window_ms)

        return 1
    `)

    result, err := script.Run(ctx, l.client, []string{key}, now, windowStart, limit.Count, limit.Window.Milliseconds()).Int64()
    if err != nil {
        return err
    }

    if result == 0 {
        return fmt.Errorf("rate limit exceeded for %s notifications", notificationType)
    }

    return nil
}

// GetRemaining returns remaining quota
func (l *NotificationLimiter) GetRemaining(ctx context.Context, userID, notificationType string) (int64, error) {
    limit, ok := l.limits[notificationType]
    if !ok {
        limit = l.defaultLimit
    }

    key := fmt.Sprintf("notification:limit:%s:%s", userID, notificationType)
    windowStart := time.Now().Add(-limit.Window).UnixMilli()

    // Remove old and count
    pipe := l.client.Pipeline()
    pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", windowStart))
    countCmd := pipe.ZCard(ctx, key)
    pipe.Exec(ctx)

    count := countCmd.Val()
    remaining := limit.Count - count
    if remaining < 0 {
        remaining = 0
    }

    return remaining, nil
}
```

### Junior -> FAANG: Rate Limiting Design Choices

The sliding window counter implemented here (Redis sorted set with timestamp as score) is more accurate than a fixed window counter but also more expensive: every `Check` call executes a Lua script that removes old entries, counts current entries, and conditionally adds a new one. Understand the trade-off: fixed window (simpler, cheaper, allows up to 2x the limit at window boundaries) vs sliding window (accurate, more complex, better user experience).

The Lua script atomicity is critical. Without the script, a `ZCARD` followed by a conditional `ZADD` would have a race condition: two concurrent calls both read count=49, both pass the limit check of 50, and both add an entry, resulting in a count of 51. The atomic Lua script prevents this race.

Know which limit to apply per notification type. The implementation shows marketing at 2/day and security at 1000/hour. These numbers reflect real business decisions: marketing notifications are expensive to user experience (too many drives unsubscribes), while security notifications (MFA codes, suspicious activity alerts) must not be throttled in a way that blocks legitimate user actions.

The `GetRemaining` method is useful for building UI that shows users their notification quota. API clients can call this before sending a batch campaign to predict whether it will be throttled. This is a product feature built for free on top of the rate limit infrastructure.

### Senior @ FAANG: Rate Limiting at Platform Level and Provider Constraints

**Two layers of rate limiting**

The implementation rate-limits per user per notification type. But there is a second layer: provider-level rate limits. SendGrid imposes a global rate limit on your account (not per user), Twilio limits SMS per sending number (typically 1 message/second per long code), and APNs throttles per device per topic. A notification platform must track and respect both layers simultaneously.

Provider-level rate limiting requires a different data structure: a global rate limiter per provider, shared across all worker instances, with distributed state in Redis. When the provider rate limit is hit, the worker must back off and signal the message to be requeued with a delay, not dropped. This is a more complex flow than the per-user limiter shown above, and designing it cleanly (without coupling the worker to the rate limiter's internal state) is a senior-level design concern.

**Adaptive rate limiting based on provider health**

A static rate limit is conservative. If SendGrid is performing well above its SLA, you could send more aggressively. If it is degrading, you should send less aggressively to avoid triggering their abuse detection and getting your IP blacklisted. Adaptive rate limiting reads the provider's response latency and error rate in real time, and adjusts the per-instance send rate to stay within the provider's healthy operating range. This is the approach Uber and Airbnb describe in their notifications infrastructure posts.

**Rate limit surfacing in the API response**

When a `Check` call fails, returning `fmt.Errorf("rate limit exceeded")` is not enough for a well-designed API. The response should include: the limit that was exceeded (type, window, count), the time until the rate resets, and whether a retry after that reset time would succeed. This follows the RFC 6585 / IETF draft for rate limit response headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`). Callers with this information can implement intelligent backoff rather than polling.

**Rate limiting as an SLO protection mechanism**

At FAANG, rate limits are not just user experience features. They are SLO protection mechanisms. If a buggy deployment floods the notification service with 10M notifications in one minute (1000x normal volume), per-user rate limits prevent any single user from being spammed, but the system itself may still be overwhelmed. A platform-level circuit breaker that detects abnormal aggregate send rates (e.g., 5x the rolling 7-day average) and automatically pauses low-priority notification sending until the anomaly is investigated is a staff-level design addition. This circuit breaker has saved platforms from major incident escalations when a marketing automation system had a configuration bug.

---
