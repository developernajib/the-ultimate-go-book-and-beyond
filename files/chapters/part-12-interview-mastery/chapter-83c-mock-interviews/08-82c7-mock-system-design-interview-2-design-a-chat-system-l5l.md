## 83C.7 Mock System Design Interview 2: Design a Chat System (L5/L6)

### Interviewer Briefing

**Company style:** Meta/Slack-style. This is a mid-to-senior level system design question that tests real-time systems thinking, message delivery guarantees, and presence management. L5 candidates should produce a working design with clear trade-offs. L6 candidates should drive the conversation, identify the hardest problems, and propose solutions for scale.

**Interview duration:** 45 minutes

### Full Interview Simulation

**Minutes 0-5: Requirements**

*Interviewer says:* "Design a chat system like WhatsApp or Slack."

*What great candidates say:*

"This is a broad problem, so let me scope it down. Core features I'd like to focus on:

1. **1:1 messaging** - two users sending messages in real-time
2. **Group messaging** - up to, say, 500 members in a group
3. **Online presence** - see who's online/offline
4. **Message delivery guarantees** - messages are never lost, delivered in order
5. **Offline support** - messages delivered when user comes back online

Features I'd explicitly defer: file/media sharing, voice/video calls, E2E encryption, message search. Sound good?"

*Interviewer:* "Yes, focus on those five."

**Minutes 5-10: Estimation**

*What great candidates say:*

"Let me estimate scale. Assume 50 million DAU, each sends 40 messages/day - that's 2 billion messages per day, about 25,000 messages per second average with 3-5x peak factor, so 75,000-125,000 messages per second at peak. Each message is roughly 200 bytes of text plus metadata - about 400 bytes total. Daily storage: 2B × 400B = 800GB per day, about 300TB per year. We need a system that can handle 100K+ writes per second with low latency."

**Minutes 10-25: High-Level Design**

```
┌──────────────────────────────────────────────────────────────────────┐
│                     CHAT SYSTEM ARCHITECTURE                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Client ←──WebSocket──→ [Gateway Server] ←──→ [Message Service]     │
│                                ↕                      ↕              │
│                          [Presence Service]    [Message Store]       │
│                                ↕                      ↕              │
│                          [Redis Cluster]       [Cassandra]           │
│                                                      ↕               │
│   Client ←──WebSocket──→ [Gateway Server] ←──→ [Notification         │
│                                                  Service]            │
│                                                      ↕               │
│                                                [Push Gateway]        │
│                                                (APNs / FCM)          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

*What great candidates say:*

"The architecture has four main components:

**1. Gateway Servers (WebSocket Layer):**
Each client maintains a persistent WebSocket connection to a gateway server. The gateway server is the entry point for all real-time communication. When a user sends a message, it goes through their WebSocket connection to their assigned gateway. The gateway routes it to the message service.

In Go, this is a natural fit - Go's goroutine model handles hundreds of thousands of concurrent WebSocket connections per server efficiently:

```go
package chat

import (
    "context"
    "net/http"
    "sync"
    "time"
)

type ChatMessage struct {
    SenderID  string
    Timestamp int64
}

type WebSocketConn interface {
    Close() error
    ReadJSON(v any) error
}

type Upgrader interface {
    Upgrade(w http.ResponseWriter, r *http.Request, responseHeader http.Header) (WebSocketConn, error)
}

type MessageServiceClient interface {
    Send(ctx context.Context, msg *ChatMessage) error
}

type PresenceServiceClient interface {
    SetOnline(ctx context.Context, userID string) error
    SetOffline(ctx context.Context, userID string) error
}

var upgrader Upgrader

func authenticateFromToken(r *http.Request) string { return "" }

type Gateway struct {
    connections sync.Map // userID -> WebSocketConn
    msgService  MessageServiceClient
    presService PresenceServiceClient
}

func (g *Gateway) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }
    defer conn.Close()

    userID := authenticateFromToken(r)
    g.connections.Store(userID, conn)
    defer g.connections.Delete(userID)

    g.presService.SetOnline(r.Context(), userID)
    defer g.presService.SetOffline(context.Background(), userID)

    for {
        var msg ChatMessage
        if err := conn.ReadJSON(&msg); err != nil {
            break
        }
        msg.SenderID = userID
        msg.Timestamp = time.Now().UnixNano()

        go g.msgService.Send(context.Background(), &msg)
    }
}
```

**2. Message Service:**
Receives messages from gateways, persists them, and routes them to recipients. For 1:1 messages, it looks up which gateway server the recipient is connected to and forwards the message. For group messages, it fans out to all group members.

The key design decision is **fan-out on write vs. fan-out on read**. For groups up to 500 members, fan-out on write is acceptable - when a message arrives, we write a copy for each group member's inbox. This is simpler and means reads are fast (just scan your inbox). For very large groups (10K+ members), we'd switch to fan-out on read to avoid write amplification.

**3. Message Store (Cassandra):**
I'm choosing Cassandra because:
- Write-optimized (LSM tree) - handles 100K+ writes/second
- Horizontally scalable - no single-master bottleneck
- Partitioned by conversation_id, clustered by timestamp - efficient range queries for loading message history

```
Table: messages
  partition_key: conversation_id (UUID)
  clustering_key: message_id (TimeUUID, sorts chronologically)
  columns: sender_id, content, content_type, created_at

Table: user_inbox
  partition_key: user_id
  clustering_key: (conversation_id, message_id)
  columns: is_read, delivered_at
```

**4. Presence Service:**
Tracks which users are online. Uses Redis with heartbeats. Each connected client sends a heartbeat every 30 seconds. Redis stores `user:{userID}:presence` with a 60-second TTL. If the heartbeat stops, the key expires and the user appears offline.

For broadcasting presence updates, I'd use a pub/sub channel per user's contact list. When User A comes online, publish to a channel that User A's contacts are subscribed to. This avoids polling."

**Minutes 25-35: Deep Dive - Message Delivery Guarantees**

*Interviewer asks:* "How do you ensure messages are never lost?"

*What great candidates say:*

"This is the hardest part of the system. Let me walk through the message lifecycle and identify failure points:

1. **Client → Gateway:** The WebSocket connection might drop mid-send. The client must implement retry with idempotency. Each message gets a client-generated UUID. The server deduplicates by UUID.

2. **Gateway → Message Service:** If the gateway crashes after receiving the message but before forwarding, the message is lost. To prevent this, the gateway ACKs the client only after the message service confirms persistence. The client retries until it receives an ACK.

3. **Message Service → Database:** Use write-ahead logging. The message service writes to a WAL (or Kafka topic) before persisting to Cassandra. If Cassandra is temporarily unavailable, the WAL provides durability. A background consumer retries failed writes.

4. **Message Service → Recipient Gateway:** If the recipient is offline, the message waits in their inbox (already persisted). When they reconnect, the gateway queries for undelivered messages. If the recipient is online but the delivery fails (their gateway crashes), the message service marks it as undelivered and retries.

5. **Delivery confirmation:** The receiving client sends a delivery ACK back through the WebSocket. The server updates the message status. The sender sees delivery confirmation (double checkmarks).

In Go, the message service flow:

```go
package chat

import (
    "context"
    "fmt"
    "log"
    "time"
)

type ChatMessage struct {
    ClientMsgID string
}

type DedupStore interface {
    Exists(ctx context.Context, id string) bool
    Set(ctx context.Context, id string, ttl time.Duration)
}

type WAL interface {
    Write(ctx context.Context, msg *ChatMessage) error
}

type MessageStore interface {
    SaveMessage(ctx context.Context, msg *ChatMessage) error
}

type MessageService struct {
    dedup DedupStore
    wal   WAL
    store MessageStore
}

func (ms *MessageService) ackToSender(ctx context.Context, msg *ChatMessage) {}
func (ms *MessageService) routeToRecipients(ctx context.Context, msg *ChatMessage) {}

func (ms *MessageService) Send(ctx context.Context, msg *ChatMessage) error {
    // Step 1: Deduplicate
    if ms.dedup.Exists(ctx, msg.ClientMsgID) {
        return nil // Already processed
    }

    // Step 2: Persist to durable store (Kafka or WAL)
    if err := ms.wal.Write(ctx, msg); err != nil {
        return fmt.Errorf("WAL write failed: %w", err)
    }

    // Step 3: ACK to sender's gateway (sender sees single checkmark)
    ms.ackToSender(ctx, msg)

    // Step 4: Persist to Cassandra
    if err := ms.store.SaveMessage(ctx, msg); err != nil {
        // Will be retried from WAL by background consumer
        log.Printf("Cassandra write failed, will retry: %v", err)
    }

    // Step 5: Route to recipient(s)
    ms.routeToRecipients(ctx, msg)

    // Step 6: Mark as deduplicated
    ms.dedup.Set(ctx, msg.ClientMsgID, 24*time.Hour)

    return nil
}
```

**Ordering guarantee:** Within a conversation, messages must appear in order. I use Cassandra's TimeUUID as the clustering key, which provides chronological ordering. For concurrent messages from different senders, the server assigns the timestamp (not the client), ensuring a consistent total order."

**Minutes 35-42: Group Messaging & Scaling**

*Interviewer asks:* "How does group messaging work at scale?"

*What great candidates say:*

"When a message is sent to a group, the message service:

1. Persists the message once in the `messages` table (keyed by `group_conversation_id`)
2. For each online member: routes the message to their gateway server
3. For each offline member: writes to their `user_inbox` and queues a push notification

The fan-out for a 500-member group means 500 routing operations. At 25,000 messages/second, if 10% are group messages in 100-member groups, that's 250 million routing operations per second - which requires careful architecture.

I'd use a dedicated fan-out service backed by a Kafka topic. The message service publishes once to Kafka, and fan-out workers consume and distribute. This decouples the sender's latency from the fan-out cost.

For gateway server discovery (knowing which gateway a user is connected to), I'd maintain a routing table in Redis: `user:{userID}:gateway → gateway_server_id`. Gateways update this on connect/disconnect."

**Minutes 42-45: Architecture Decisions with Go Implementation Notes**

"Why Go is excellent for this system:

1. **WebSocket gateway:** Go's goroutine-per-connection model handles 500K+ concurrent connections per server. Libraries like `gorilla/websocket` or `nhooyr/websocket` are battle-tested.

2. **Message routing:** Go channels naturally model the message pipeline. Each user's outbound messages flow through a buffered channel, and a dedicated goroutine per connection drains the channel to the WebSocket.

3. **Presence heartbeats:** A simple goroutine with a `time.Ticker` per connection handles heartbeats without thread overhead.

4. **Fan-out workers:** Go's `errgroup` package manages a pool of fan-out workers elegantly, with proper error propagation and context cancellation."

### Scoring Rubric

| Rating | Criteria |
|--------|----------|
| **Strong Hire** | Drives the conversation. Scopes requirements clearly. Accurate estimation. Clean architecture with WebSocket, message service, and persistent store. Deep dive on delivery guarantees with idempotency and ordering. Discusses fan-out strategies for groups. Go implementation notes show real expertise. |
| **Hire** | Good requirements scoping. Working architecture with the key components. Discusses message persistence and delivery. May miss some edge cases in delivery guarantees. Reasonable scaling discussion. |
| **Lean Hire** | Needs prompting on requirements. Architecture works at small scale but doesn't address distribution challenges. Limited discussion of delivery guarantees. Doesn't address ordering. |
| **No Hire** | Cannot design a basic chat architecture. Doesn't understand WebSocket vs HTTP for real-time communication. No discussion of persistence or delivery guarantees. Cannot estimate scale. |


### Junior → FAANG: Chat System Design Mock Interview Basics

The chat system design mock interview evaluates your ability to design for real-time, persistent, low-latency communication. The key components to cover: the client connection layer (WebSocket or long-polling), the message routing layer, the message storage layer, and the presence system. For an L4/L5 interview, completing a correct high-level design with reasonable technology choices is the bar. The most common mistake is spending too long on the connection layer and not covering message storage and presence adequately.

### Senior @ FAANG: Chat System L5/L6 Bar: Consistency, Fan-Out, and Offline Delivery

At the L5/L6 level, the chat system interview is evaluated on the depth of the trade-off discussion. The three dimensions that separate L5 from L6 answers: message ordering guarantee (what consistency model does your design provide, and is it sufficient for the use case), fan-out strategy for group chats (how does a message in a group with 10k members get delivered to all of them without becoming a write bottleneck), and offline message delivery (how do you ensure messages sent while a user is offline are reliably delivered when they reconnect, including ordering and deduplication). The bar-raiser probes at L6 include: 'what happens if the WebSocket gateway crashes during message delivery', 'how do you handle the case where the same message is delivered twice to the client', and 'how does your design handle a user who is connected on three devices simultaneously'.

---
