## 102P.6 Presence System with Redis

A presence system tracks which users are currently online and removes stale entries automatically without requiring an explicit disconnect event, which is critical because WebSocket connections can drop silently. The implementation below uses a Redis sorted set where each member's score is its last heartbeat Unix timestamp, querying the set with a minimum score of `now - TTL` returns only users who have heartbeated recently, and a background cleanup job prunes entries older than the TTL window.

```go
package presence

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// PresenceSystem tracks online users using Redis sorted sets
type PresenceSystem struct {
	rdb *redis.Client
	ttl time.Duration
}

func NewPresenceSystem(rdb *redis.Client) *PresenceSystem {
	return &PresenceSystem{
		rdb: rdb,
		ttl: 30 * time.Second,
	}
}

// PresenceInfo carries user presence data
type PresenceInfo struct {
	UserID    string    `json:"user_id"`
	RoomID    string    `json:"room_id"`
	Status    string    `json:"status"` // "online", "away", "busy"
	LastSeen  time.Time `json:"last_seen"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// Heartbeat updates a user's presence (call every ~15s from client)
func (p *PresenceSystem) Heartbeat(ctx context.Context, info PresenceInfo) error {
	key := fmt.Sprintf("presence:room:%s", info.RoomID)
	userKey := fmt.Sprintf("presence:user:%s", info.UserID)

	pipe := p.rdb.Pipeline()

	// Store presence info
	infoJSON, _ := json.Marshal(info)
	pipe.Set(ctx, userKey, string(infoJSON), p.ttl)

	// Add to room sorted set (score = Unix timestamp for TTL ordering)
	pipe.ZAdd(ctx, key, redis.Z{
		Score:  float64(time.Now().Unix()),
		Member: info.UserID,
	})
	pipe.Expire(ctx, key, p.ttl*2)

	_, err := pipe.Exec(ctx)
	return err
}

// GetOnlineUsers returns currently online users in a room
func (p *PresenceSystem) GetOnlineUsers(ctx context.Context, roomID string) ([]PresenceInfo, error) {
	key := fmt.Sprintf("presence:room:%s", roomID)

	// Get users active in the last TTL seconds
	minScore := float64(time.Now().Add(-p.ttl).Unix())
	userIDs, err := p.rdb.ZRangeByScore(ctx, key, &redis.ZRangeBy{
		Min: fmt.Sprintf("%f", minScore),
		Max: "+inf",
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("get online users: %w", err)
	}

	if len(userIDs) == 0 {
		return nil, nil
	}

	// Fetch presence info for each user
	pipe := p.rdb.Pipeline()
	cmds := make([]*redis.StringCmd, len(userIDs))
	for i, uid := range userIDs {
		cmds[i] = pipe.Get(ctx, fmt.Sprintf("presence:user:%s", uid))
	}
	_, _ = pipe.Exec(ctx)

	var users []PresenceInfo
	for _, cmd := range cmds {
		val, err := cmd.Result()
		if err != nil {
			continue
		}
		var info PresenceInfo
		if err := json.Unmarshal([]byte(val), &info); err == nil {
			users = append(users, info)
		}
	}
	return users, nil
}

// Subscribe to presence events via Redis Pub/Sub
func (p *PresenceSystem) Subscribe(ctx context.Context, roomID string) (<-chan PresenceInfo, error) {
	ch := make(chan PresenceInfo, 32)
	topic := fmt.Sprintf("presence:events:%s", roomID)

	sub := p.rdb.Subscribe(ctx, topic)
	go func() {
		defer close(ch)
		for {
			msg, err := sub.ReceiveMessage(ctx)
			if err != nil {
				return
			}
			var info PresenceInfo
			if err := json.Unmarshal([]byte(msg.Payload), &info); err == nil {
				select {
				case ch <- info:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return ch, nil
}

// PublishPresenceChange broadcasts a presence change to all servers
func (p *PresenceSystem) PublishPresenceChange(ctx context.Context, info PresenceInfo) error {
	topic := fmt.Sprintf("presence:events:%s", info.RoomID)
	data, _ := json.Marshal(info)
	return p.rdb.Publish(ctx, topic, string(data)).Err()
}
```

### Junior → FAANG: Why Redis Sorted Sets for Presence

The Redis sorted set with Unix timestamp as score is an elegant data structure for presence because the "who is online" query maps directly to a range query: `ZRANGEBYSCORE online_users (now-TTL) +inf`. Users who have not heartbeated within the TTL window are automatically excluded without a separate cleanup step for the query, though explicit cleanup is still needed to prevent unbounded growth.

The TTL choice affects user experience. A 60-second TTL means a user who closes their laptop without closing the browser tab appears online for up to 60 seconds. A 10-second TTL requires a heartbeat every 5 seconds (at Nyquist rate), which means 5 Redis writes per user per 10 seconds. For 100,000 users, that is 500,000 writes per 10 seconds. The heartbeat interval versus TTL tradeoff is a product decision with an engineering cost.

Interview entry point: describe the presence system as "sorted set in Redis with timestamp as score. Query uses ZRANGEBYSCORE with a minimum of (now - TTL). Heartbeat writes keep active users above the threshold. Background cleanup removes truly stale entries to prevent unbounded growth."

### Senior @ FAANG: Presence at Scale: Consistency, Heartbeat Amplification, and Multi-Region

At FAANG scale (millions of concurrent users), the heartbeat model creates a write amplification problem. Each user sends a heartbeat every N seconds, generating M writes per second per user. At 10 million active users with 30-second heartbeats, that is 333,000 Redis writes per second from heartbeats alone. At this scale, a single Redis instance cannot handle the write throughput, requiring either Redis Cluster sharding (presence data is sharded by user ID or room ID across multiple Redis nodes) or a tiered model (in-process presence cache with periodic Redis sync).

The multi-region presence challenge: a user connected to a server in the US West region heartbeats to a Redis in US West. A user in the US East region querying presence gets a stale response until the US West Redis replicates to US East. For most presence use cases (chat online indicators), eventual consistency with a few seconds of lag is acceptable. For financial systems where presence affects routing decisions, stronger consistency may be required.

The L6 architecture decision: centralized presence with eventual consistency, or local presence with best-effort consistency? Centralized presence is simpler to reason about but has a single point of failure and a scaling ceiling. Local presence (each region maintains its own presence state, synchronized through a gossip protocol) is more resilient but requires careful handling of network partitions where two regions have conflicting views of who is online.

---
