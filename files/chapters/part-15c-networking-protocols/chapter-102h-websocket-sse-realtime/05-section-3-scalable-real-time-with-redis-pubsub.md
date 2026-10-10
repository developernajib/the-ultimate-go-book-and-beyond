## 102H.3 Scalable Real-Time with Redis Pub/Sub

### 3.1 Multi-Node WebSocket with Redis

A single WebSocket hub is limited to one process, but production systems run multiple server instances behind a load balancer. Redis pub/sub bridges the gap: when a client on Node 1 sends a message, the hub publishes it to a Redis channel so Node 2 can receive it and fan-out to its local clients. The `DistributedHub` below wraps the in-process hub with a Redis layer, filtering out messages that originated on the same node to avoid double-delivery.

```go
package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// DistributedHub extends Hub with Redis pub/sub for multi-node support.
// Architecture:
//   Node 1: WebSocket clients → local Hub → publish to Redis
//   Node 2: WebSocket clients → local Hub → subscribe from Redis → broadcast locally
// Any message sent by a client on Node 1 reaches clients on Node 2 via Redis.
type DistributedHub struct {
	*Hub
	redis    *redis.Client
	nodeID   string
	pubsub   *redis.PubSub
	channels map[string]bool // Subscribed Redis channels.
	mu       sync.RWMutex
}

// RedisMessage wraps a hub message with routing info for multi-node delivery.
type RedisMessage struct {
	SourceNode string  `json:"source_node"`
	Room       string  `json:"room"`
	Message    Message `json:"message"`
	Exclude    string  `json:"exclude,omitempty"` // Client to exclude (on source node).
}

func NewDistributedHub(cfg HubConfig, redisClient *redis.Client, nodeID string) *DistributedHub {
	return &DistributedHub{
		Hub:      NewHub(cfg),
		redis:    redisClient,
		nodeID:   nodeID,
		channels: make(map[string]bool),
	}
}

// Run starts both the local hub and the Redis subscriber.
func (dh *DistributedHub) Run(ctx context.Context) {
	// Start local hub.
	go dh.Hub.Run(ctx)

	// Subscribe to Redis messages from other nodes.
	dh.pubsub = dh.redis.Subscribe(ctx, "hub:global")
	go dh.receiveFromRedis(ctx)
}

// Broadcast sends a message to a room - locally and via Redis to other nodes.
func (dh *DistributedHub) Broadcast(room string, msg Message, exclude string) {
	// Deliver to local clients.
	dh.Hub.Broadcast(room, msg, exclude)

	// Publish to Redis for other nodes.
	redisMsg := RedisMessage{
		SourceNode: dh.nodeID,
		Room:       room,
		Message:    msg,
		Exclude:    exclude,
	}
	data, _ := json.Marshal(redisMsg)
	channel := "hub:room:" + room

	dh.redis.Publish(context.Background(), channel, data)

	// Subscribe to this room's channel if not already.
	dh.mu.Lock()
	if !dh.channels[channel] {
		dh.pubsub.Subscribe(context.Background(), channel)
		dh.channels[channel] = true
	}
	dh.mu.Unlock()
}

// receiveFromRedis processes messages published by other nodes.
func (dh *DistributedHub) receiveFromRedis(ctx context.Context) {
	ch := dh.pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case redisMsg, ok := <-ch:
			if !ok {
				return
			}
			var msg RedisMessage
			if err := json.Unmarshal([]byte(redisMsg.Payload), &msg); err != nil {
				continue
			}
			// Skip messages from this node (already delivered locally).
			if msg.SourceNode == dh.nodeID {
				continue
			}
			// Deliver to local clients in this room.
			dh.Hub.Broadcast(msg.Room, msg.Message, "")
		}
	}
}

// PresenceService tracks online users using Redis sorted sets.
// Score = last seen timestamp. Expired entries = offline users.
type PresenceService struct {
	redis  *redis.Client
	ttl    time.Duration
	prefix string
}

func NewPresenceService(redis *redis.Client, ttl time.Duration) *PresenceService {
	return &PresenceService{
		redis:  redis,
		ttl:    ttl,
		prefix: "presence:",
	}
}

// Online marks a user as online.
func (ps *PresenceService) Online(ctx context.Context, userID string) error {
	key := ps.prefix + "online"
	score := float64(time.Now().Unix())
	return ps.redis.ZAdd(ctx, key, redis.Z{Score: score, Member: userID}).Err()
}

// Offline marks a user as offline.
func (ps *PresenceService) Offline(ctx context.Context, userID string) error {
	return ps.redis.ZRem(ctx, ps.prefix+"online", userID).Err()
}

// Heartbeat updates the user's last seen timestamp.
// Call periodically (e.g., every 30 seconds) from WebSocket ping handler.
func (ps *PresenceService) Heartbeat(ctx context.Context, userID string) error {
	return ps.Online(ctx, userID)
}

// GetOnlineUsers returns users active within the last TTL.
func (ps *PresenceService) GetOnlineUsers(ctx context.Context) ([]string, error) {
	minScore := float64(time.Now().Add(-ps.ttl).Unix())
	return ps.redis.ZRangeByScore(ctx, ps.prefix+"online", &redis.ZRangeBy{
		Min: fmt.Sprintf("%f", minScore),
		Max: "+inf",
	}).Result()
}

// IsOnline checks if a user is online.
func (ps *PresenceService) IsOnline(ctx context.Context, userID string) (bool, error) {
	score, err := ps.redis.ZScore(ctx, ps.prefix+"online", userID).Result()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return time.Unix(int64(score), 0).After(time.Now().Add(-ps.ttl)), nil
}

// CleanupOffline removes expired presence entries.
func (ps *PresenceService) CleanupOffline(ctx context.Context) error {
	maxScore := fmt.Sprintf("%d", time.Now().Add(-ps.ttl).Unix())
	return ps.redis.ZRemRangeByScore(ctx, ps.prefix+"online", "0", maxScore).Err()
}
```

### Junior → FAANG: Why a Single Server Is Sufficient Until It Is Not

When first building a WebSocket server, a single instance with an in-memory hub is the right starting point. It is simpler to understand, simpler to debug, and has no network round trips for message delivery. The transition to Redis pub/sub is driven by a specific operational problem: you have added a second server instance and clients connected to instance A are not receiving messages published to instance B.

The instinct to add Redis before that problem appears is premature. But recognizing when the problem has appeared and knowing the solution is essential. The operational signal is: load balancer round-robins WebSocket upgrades across N instances, broadcast to a room fails for clients on the "wrong" instance. The Redis pub/sub solution adds a fixed overhead of one Redis round trip per broadcast, which is typically 0.5 to 2 milliseconds. That overhead is acceptable for most real-time applications.

Interview entry point: describe Redis pub/sub as a fan-out layer that decouples producers (services publishing events) from consumers (WebSocket servers holding connections). Each WebSocket server instance subscribes to channels relevant to its connected clients and delivers messages locally.

### Senior @ FAANG: Redis Pub/Sub Limitations and When to Replace It

Redis pub/sub is at-most-once delivery with no persistence. If a subscriber is disconnected when a message is published, the message is lost. For most real-time use cases (cursor positions, typing indicators, ephemeral notifications), this is acceptable. For financial events, order status updates, or any event where a missed delivery causes user-visible data loss, it is not acceptable.

The architectural progression is: Redis pub/sub (at-most-once, simplest), Redis Streams with consumer groups (at-least-once, persistent, ordered per stream), NATS JetStream (at-least-once, push consumers, lower operational complexity than Kafka), Apache Kafka (at-least-once, high-throughput, complex operational model). The choice depends on the delivery guarantee required, the throughput target, and the operational complexity the team can maintain.

A Redis pub/sub cluster also has a fanout scalability limit. Publishing a message to a channel with 10,000 subscribers requires Redis to deliver the message to every subscriber connection. At very high subscriber counts or message rates, Redis becomes the bottleneck. The solution at that scale is a hierarchical fan-out: a small number of primary subscriber processes receive from Redis and fan-out locally to many connection servers, which deliver to their connected clients. This is the architecture Slack describes in their engineering blog for their Channels infrastructure. The design requires careful thinking about which tier handles message filtering (filtering by user authorization is expensive in the fan-out tier but must happen before delivery to the connection tier).

---
