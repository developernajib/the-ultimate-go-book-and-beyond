## 62.9 Notification Aggregation

Notification aggregation batches multiple related notifications into a single digest to reduce noise, for example, grouping ten individual "comment" notifications into "You have 10 new comments on your post." The aggregator collects notifications into time-windowed buckets per user per category using Redis, then flushes the aggregated notification after the window closes or when the bucket reaches a maximum size. This pattern is essential for social platforms and monitoring systems where event storms can otherwise flood users with individual notifications.

```go
// aggregation/aggregator.go
package aggregation

import (
    "context"
    "encoding/json"
    "fmt"
    "strings"
    "time"

    "github.com/redis/go-redis/v9"
    "yourproject/types"
)

// NotificationAggregator groups similar notifications
type NotificationAggregator struct {
    client        *redis.Client
    queue         NotificationQueue
    aggregateWait time.Duration
}

// AggregateKey identifies an aggregation group
type AggregateKey struct {
    UserID string
    Type   string
}

// AggregatedNotification represents grouped notifications
type AggregatedNotification struct {
    UserID string
    Type   string
    Items  []NotificationItem
    Count  int
}

type NotificationItem struct {
    Data      map[string]any
    Timestamp time.Time
}

// NewNotificationAggregator creates a new aggregator
func NewNotificationAggregator(client *redis.Client, queue NotificationQueue, wait time.Duration) *NotificationAggregator {
    agg := &NotificationAggregator{
        client:        client,
        queue:         queue,
        aggregateWait: wait,
    }

    // Start background processor
    go agg.processAggregates()

    return agg
}

// Add adds a notification to an aggregate group
func (a *NotificationAggregator) Add(ctx context.Context, notification *types.Notification) error {
    key := fmt.Sprintf("aggregate:%s:%s", notification.UserID, notification.Type)

    item := NotificationItem{
        Data:      notification.Data,
        Timestamp: notification.CreatedAt,
    }

    itemJSON, _ := json.Marshal(item)

    // Add to sorted set with timestamp as score
    pipe := a.client.Pipeline()
    pipe.ZAdd(ctx, key, redis.Z{
        Score:  float64(notification.CreatedAt.UnixMilli()),
        Member: string(itemJSON),
    })
    pipe.Expire(ctx, key, a.aggregateWait*2)
    _, err := pipe.Exec(ctx)

    return err
}

// processAggregates periodically processes and sends aggregated notifications
func (a *NotificationAggregator) processAggregates() {
    ticker := time.NewTicker(a.aggregateWait)
    defer ticker.Stop()

    for range ticker.C {
        ctx := context.Background()
        a.flushAggregates(ctx)
    }
}

func (a *NotificationAggregator) flushAggregates(ctx context.Context) {
    // Find all aggregate keys
    keys, err := a.client.Keys(ctx, "aggregate:*").Result()
    if err != nil {
        return
    }

    cutoff := time.Now().Add(-a.aggregateWait).UnixMilli()

    for _, key := range keys {
        // Get items older than cutoff
        items, err := a.client.ZRangeByScore(ctx, key, &redis.ZRangeBy{
            Min: "-inf",
            Max: fmt.Sprintf("%d", cutoff),
        }).Result()

        if err != nil || len(items) == 0 {
            continue
        }

        // Parse items
        notificationItems := make([]NotificationItem, 0, len(items))
        for _, item := range items {
            var ni NotificationItem
            if json.Unmarshal([]byte(item), &ni) == nil {
                notificationItems = append(notificationItems, ni)
            }
        }

        if len(notificationItems) == 0 {
            continue
        }

        // Extract user ID and type from key
        // key format: aggregate:userID:type
        parts := strings.Split(key, ":")
        if len(parts) < 3 {
            continue
        }

        // Create aggregated notification
        agg := &AggregatedNotification{
            UserID: parts[1],
            Type:   parts[2],
            Items:  notificationItems,
            Count:  len(notificationItems),
        }

        // Send aggregated notification
        a.sendAggregated(ctx, agg)

        // Remove processed items
        a.client.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", cutoff))
    }
}

func (a *NotificationAggregator) sendAggregated(ctx context.Context, agg *AggregatedNotification) {
    notification := &types.Notification{
        ID:       fmt.Sprintf("agg-%s-%d", agg.UserID, time.Now().UnixNano()),
        UserID:   agg.UserID,
        Type:     agg.Type + "_digest",
        Priority: types.PriorityLow,
        Template: agg.Type + "_digest",
        Data: map[string]any{
            "items": agg.Items,
            "count": agg.Count,
        },
        CreatedAt: time.Now(),
    }

    a.queue.Enqueue(ctx, notification)
}
```

### Junior -> FAANG: Why Aggregation Matters for User Retention

Without aggregation, a user who receives 50 "likes" on a popular post in one minute would get 50 individual push notifications, each one waking their phone. Most users will disable push notifications entirely after this experience. Aggregation is not an optimization: it is a user retention requirement.

The Redis sorted set pattern used here (timestamp as score, notification item as member) is the standard approach because it gives three operations for free: ordered insertion (ZADD), efficient range query by time (ZRANGEBYSCORE), and atomic count (ZCARD). The window-based flush is a trade-off between freshness (individual notifications feel more immediate) and noise (aggregation reduces interruptions).

Understanding the `aggregateWait` parameter: too short (under 10 seconds) and you are aggregating only bursts that happen in the same second, missing most of the noise reduction benefit. Too long (over 10 minutes) and the aggregated notification feels stale. For push notifications, 1-5 minutes is a common production value. For email digests, 1-24 hours depending on the notification type's urgency.

The `processAggregates` goroutine calling `client.Keys("aggregate:*")` is a production anti-pattern. `KEYS` is a blocking O(n) command that scans the entire keyspace. In production, use `SCAN` with a cursor to iterate incrementally. Know this distinction and call it out if you see `KEYS` in any code that runs against production Redis.

### Senior @ FAANG: Aggregation as a Product Feature with Technical Depth

**The "deferred aggregation" model**

The current implementation aggregates at collection time: as notifications arrive, they are added to a window. A more sophisticated model defers the aggregation decision to delivery time: collect all notifications individually, and at delivery time, collapse the set into an aggregate message. This model is harder to implement but enables richer aggregation rules: "aggregate by actor if there are more than 3 actors on the same target" or "always send individually if the notification is from a followed account." Instagram's notification system uses a variant of this model to produce the "John and 5 others liked your photo" format.

**Preventing the "late arrival" race**

The current flush deletes items with timestamps before the cutoff, then sends an aggregated notification. If item number 6 arrives one millisecond after the flush, it starts a new aggregation window, and the user gets two notifications: one aggregated and one individual. The Instagram-style fix is to keep the aggregation window alive after flushing by updating the key's TTL (not deleting it), tracking the "last flush count" in the Redis hash, and continuing to accumulate items. When the next notification arrives, it sees that an aggregated notification was already sent and updates the preview text via a WebSocket push to the client's live notification feed, rather than sending a new push notification.

**Aggregation and the channel-specific rules**

Aggregation rules should be channel-specific. In-app notifications can be aggregated on the client side (the client fetches a paginated list), so in-app aggregation just means grouping the API response. Push notifications are aggregated because the device interruption cost is high. Email notifications might be aggregated into a daily digest rather than a short time window. A production aggregation system must store the channel in the aggregation key and apply different window durations and flush thresholds per channel.

**Monitoring aggregation effectiveness**

The aggregation system must expose metrics to prove it is working: the ratio of individual notifications to aggregated notifications (compression ratio), the distribution of aggregation bucket sizes, and the per-user notification frequency before and after aggregation. If the compression ratio is 1.0 (no aggregation is happening), either the traffic pattern does not produce bursts (and aggregation is not needed) or the window is too short to catch bursts. If the compression ratio is 100x, users may be missing important individual notifications because they are being over-aggregated. Tuning aggregation requires these metrics, not guesswork.

---
