## Presence System

Presence systems track which users are currently online and relay status changes to their connections in real time, requiring a combination of WebSocket state management and distributed cache coordination. `PresenceService` stores each user's online status as a Redis key with a 30-second TTL so that a client disconnect, whether graceful or due to a network failure, causes the key to expire automatically, avoiding stale "online" states that would otherwise require explicit cleanup on every connection close path.

```go
package presence

import (
    "context"
    "time"

    "github.com/redis/go-redis/v9"
)

type PresenceService struct {
    redis *redis.Client
    ttl   time.Duration
}

func NewPresenceService(redis *redis.Client) *PresenceService {
    return &PresenceService{
        redis: redis,
        ttl:   30 * time.Second,
    }
}

// SetOnline marks user as online with TTL
func (p *PresenceService) SetOnline(ctx context.Context, userID string) error {
    key := "presence:" + userID
    return p.redis.SetEx(ctx, key, "online", p.ttl).Err()
}

// Heartbeat extends presence TTL (called periodically)
func (p *PresenceService) Heartbeat(ctx context.Context, userID string) error {
    key := "presence:" + userID
    return p.redis.Expire(ctx, key, p.ttl).Err()
}

// SetOffline removes presence (on disconnect)
func (p *PresenceService) SetOffline(ctx context.Context, userID string) error {
    key := "presence:" + userID
    return p.redis.Del(ctx, key).Err()
}

// GetPresence returns online status for multiple users
func (p *PresenceService) GetPresence(ctx context.Context, userIDs []string) (map[string]bool, error) {
    if len(userIDs) == 0 {
        return nil, nil
    }

    keys := make([]string, len(userIDs))
    for i, id := range userIDs {
        keys[i] = "presence:" + id
    }

    result := make(map[string]bool)
    values, err := p.redis.MGet(ctx, keys...).Result()
    if err != nil {
        return nil, err
    }

    for i, val := range values {
        result[userIDs[i]] = val != nil
    }

    return result, nil
}
```


### Junior → FAANG: Presence System Design Basics

A presence system tracks which users are currently online. The simplest implementation: clients send a heartbeat every 30 seconds. The server marks the user as online if a heartbeat arrived in the last 60 seconds. The presence state is stored in a low-latency key-value store (Redis) rather than the primary database. The challenge at scale: with millions of users, the presence store receives millions of heartbeats per minute, and presence queries (who is online among my friends) must be fast enough for real-time display.

### Senior @ FAANG: Presence System Scalability, Fan-Out, and Privacy

At the senior level, the presence system has two expensive operations: the write path (processing heartbeats from millions of connected users) and the read path (computing the online status of a user's entire contact list for rendering). The write path is tractable with a partitioned Redis cluster, but the read path is challenging: for a user with 500 friends, computing presence requires 500 key lookups, which is acceptable if all lookups go to the same Redis shard but expensive if they scatter across 50 shards. The optimization is fan-out on write for presence changes: when a user goes online or offline, push the presence change to all their connected friends rather than polling per-friend at read time. This shifts load from the read path to the write path and inverts the scaling model. At the staff level, presence interacts with privacy: some users do not want to broadcast their online status. The system must support presence visibility controls at the per-user level, and the fan-out logic must respect these settings without becoming a privacy violation vector (inferring online status indirectly from message delivery receipts). This is an ADR decision with security implications that must be reviewed by a privacy team.
