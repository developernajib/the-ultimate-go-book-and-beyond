## 64B.4 Slack Architecture

Slack delivers real-time messages to millions of concurrent users across workspaces that range from two-person channels to enterprise organizations with tens of thousands of members. The architecture must handle persistent WebSocket connections, message storage, search indexing, and presence tracking with minimal delivery latency. Slack's edge caching and real-time messaging architecture are documented in Slack Engineering publications (*Flannel: An Application-Level Edge Cache to Slack*, Slack Engineering Blog, 2017; and *Scaling Slack's Real-Time Messaging Architecture*, 2015).

### Real-Time Messaging

Slack's real-time messaging system maintains persistent WebSocket connections for each active client, routing messages through a channel-aware fan-out layer that delivers to all members currently connected to a workspace channel. The message hub uses a concurrent map of channel subscriptions to track which WebSocket connections belong to each channel, broadcasting new messages to all subscribers while handling connection lifecycle events (join/leave) without blocking message delivery. Sharding the hub by workspace ID ensures that a single busy workspace cannot starve other workspaces of broadcast capacity.

```go
// slack/messaging.go
package slack

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "encoding/json"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

// Message represents a Slack message
type Message struct {
    ID          string                 `json:"id"`
    ChannelID   string                 `json:"channel_id"`
    UserID      string                 `json:"user_id"`
    Content     string                 `json:"content"`
    ThreadID    string                 `json:"thread_id,omitempty"`
    Attachments []Attachment           `json:"attachments,omitempty"`
    Reactions   map[string][]string    `json:"reactions,omitempty"`
    Edited      bool                   `json:"edited"`
    CreatedAt   time.Time              `json:"created_at"`
    UpdatedAt   time.Time              `json:"updated_at"`
}

// Attachment represents a message attachment
type Attachment struct {
    ID       string `json:"id"`
    Type     string `json:"type"` // file, image, link
    URL      string `json:"url"`
    Name     string `json:"name"`
    Size     int64  `json:"size"`
    MimeType string `json:"mime_type"`
}

// RTMClient handles real-time messaging connections
type RTMClient struct {
    mu          sync.RWMutex
    connections map[string]map[*websocket.Conn]bool // userID -> connections
    channels    map[string]map[string]bool          // channelID -> userIDs
    writeLocks  sync.Map                            // *websocket.Conn -> *sync.Mutex
}

// writeAsync serializes writes per connection. gorilla/websocket
// permits at most ONE concurrent writer per connection, so firing a
// bare goroutine per broadcast would corrupt frames as soon as two
// broadcasts overlap. Production hubs use a per-connection outbound
// channel drained by a single writer pump, the per-connection mutex
// here is the minimal correct form.
func (r *RTMClient) writeAsync(conn *websocket.Conn, data []byte) {
    go func() {
        muI, _ := r.writeLocks.LoadOrStore(conn, &sync.Mutex{})
        mu := muI.(*sync.Mutex)
        mu.Lock()
        defer mu.Unlock()
        conn.WriteMessage(websocket.TextMessage, data)
    }()
}

// NewRTMClient creates a new RTM client
func NewRTMClient() *RTMClient {
    return &RTMClient{
        connections: make(map[string]map[*websocket.Conn]bool),
        channels:    make(map[string]map[string]bool),
    }
}

// RegisterConnection registers a new WebSocket connection
func (r *RTMClient) RegisterConnection(userID string, conn *websocket.Conn) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if r.connections[userID] == nil {
        r.connections[userID] = make(map[*websocket.Conn]bool)
    }
    r.connections[userID][conn] = true
}

// UnregisterConnection removes a WebSocket connection
func (r *RTMClient) UnregisterConnection(userID string, conn *websocket.Conn) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if conns, ok := r.connections[userID]; ok {
        delete(conns, conn)
        if len(conns) == 0 {
            delete(r.connections, userID)
        }
    }
    r.writeLocks.Delete(conn)
}

// JoinChannel adds a user to a channel
func (r *RTMClient) JoinChannel(channelID, userID string) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if r.channels[channelID] == nil {
        r.channels[channelID] = make(map[string]bool)
    }
    r.channels[channelID][userID] = true
}

// LeaveChannel removes a user from a channel
func (r *RTMClient) LeaveChannel(channelID, userID string) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if users, ok := r.channels[channelID]; ok {
        delete(users, userID)
    }
}

// BroadcastToChannel sends a message to all users in a channel
func (r *RTMClient) BroadcastToChannel(channelID string, event any) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    users, ok := r.channels[channelID]
    if !ok {
        return
    }

    data, _ := json.Marshal(event)

    for userID := range users {
        if conns, ok := r.connections[userID]; ok {
            for conn := range conns {
                r.writeAsync(conn, data)
            }
        }
    }
}

// SendToUser sends a message to a specific user
func (r *RTMClient) SendToUser(userID string, event any) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    conns, ok := r.connections[userID]
    if !ok {
        return
    }

    data, _ := json.Marshal(event)

    for conn := range conns {
        r.writeAsync(conn, data)
    }
}

func generateID() string {
    b := make([]byte, 16)
    _, _ = rand.Read(b)
    return hex.EncodeToString(b)
}

// MessageStore defines the persistence layer for Slack messages
type MessageStore interface {
    Save(ctx context.Context, msg *Message) error
    Get(ctx context.Context, msgID string) (*Message, error)
    Update(ctx context.Context, msg *Message) error
}

// SearchService indexes messages for full-text search
type SearchService interface {
    Index(ctx context.Context, msg *Message)
}

// NotificationService handles push and mention alerts
type NotificationService interface {
    NotifyMentions(ctx context.Context, msg *Message)
}

// MessageService handles message operations
type MessageService struct {
    store     MessageStore
    rtm       *RTMClient
    search    SearchService
    notifier  NotificationService
}

// NewMessageService creates a new message service
func NewMessageService(store MessageStore, rtm *RTMClient, search SearchService, notifier NotificationService) *MessageService {
    return &MessageService{
        store:    store,
        rtm:      rtm,
        search:   search,
        notifier: notifier,
    }
}

// SendMessage sends a message to a channel
func (s *MessageService) SendMessage(ctx context.Context, msg *Message) error {
    msg.ID = generateID()
    msg.CreatedAt = time.Now()
    msg.UpdatedAt = msg.CreatedAt

    // Store message
    if err := s.store.Save(ctx, msg); err != nil {
        return err
    }

    // Index for search
    go s.search.Index(ctx, msg)

    // Broadcast to channel members
    event := RTMEvent{
        Type:    "message",
        Channel: msg.ChannelID,
        Data:    msg,
    }
    s.rtm.BroadcastToChannel(msg.ChannelID, event)

    // Send notifications to mentioned users
    go s.notifier.NotifyMentions(ctx, msg)

    return nil
}

// EditMessage edits an existing message
func (s *MessageService) EditMessage(ctx context.Context, msgID, newContent string) error {
    msg, err := s.store.Get(ctx, msgID)
    if err != nil {
        return err
    }

    msg.Content = newContent
    msg.Edited = true
    msg.UpdatedAt = time.Now()

    if err := s.store.Update(ctx, msg); err != nil {
        return err
    }

    // Broadcast edit event
    event := RTMEvent{
        Type:    "message_changed",
        Channel: msg.ChannelID,
        Data:    msg,
    }
    s.rtm.BroadcastToChannel(msg.ChannelID, event)

    return nil
}

// AddReaction adds a reaction to a message
func (s *MessageService) AddReaction(ctx context.Context, msgID, userID, emoji string) error {
    msg, err := s.store.Get(ctx, msgID)
    if err != nil {
        return err
    }

    if msg.Reactions == nil {
        msg.Reactions = make(map[string][]string)
    }

    // Check if user already reacted with this emoji
    for _, uid := range msg.Reactions[emoji] {
        if uid == userID {
            return nil // Already reacted
        }
    }

    msg.Reactions[emoji] = append(msg.Reactions[emoji], userID)

    if err := s.store.Update(ctx, msg); err != nil {
        return err
    }

    // Broadcast reaction event
    event := RTMEvent{
        Type:    "reaction_added",
        Channel: msg.ChannelID,
        Data: map[string]any{
            "message_id": msgID,
            "user_id":    userID,
            "emoji":      emoji,
        },
    }
    s.rtm.BroadcastToChannel(msg.ChannelID, event)

    return nil
}

// RTMEvent represents a real-time event
type RTMEvent struct {
    Type    string      `json:"type"`
    Channel string      `json:"channel"`
    Data    any `json:"data"`
}
```

### Channel Management

Channels are the unit of subscription in Slack's real-time model: joining a channel both persists the membership in the durable store and registers the user in the in-memory RTM hub, so subsequent broadcasts reach them immediately without a database lookup on the hot path. The `InviteToChannel` method performs the critical dual write, updating the persistent member list and calling `rtm.JoinChannel`, in the same request so there is no window where a message could be broadcast to a channel before the invited user's WebSocket connection is registered to receive it. Broadcasting a `channel_created` event to the entire workspace on channel creation ensures that other clients can update their sidebar in real time without polling, a pattern Slack calls "workspace-wide events."

```go
// slack/channel.go
package slack

import (
    "context"
    "errors"
    "time"
)

var ErrAlreadyMember = errors.New("user is already a member of this channel")

// ChannelStore defines persistence for Slack channels
type ChannelStore interface {
    Save(ctx context.Context, ch *Channel) error
    Get(ctx context.Context, channelID string) (*Channel, error)
    Update(ctx context.Context, ch *Channel) error
    GetMessages(ctx context.Context, channelID string, limit int, before time.Time) ([]*Message, error)
}

// Channel represents a Slack channel
type Channel struct {
    ID          string    `json:"id"`
    WorkspaceID string    `json:"workspace_id"`
    Name        string    `json:"name"`
    Description string    `json:"description"`
    IsPrivate   bool      `json:"is_private"`
    IsArchived  bool      `json:"is_archived"`
    CreatorID   string    `json:"creator_id"`
    Members     []string  `json:"members"`
    CreatedAt   time.Time `json:"created_at"`
    UpdatedAt   time.Time `json:"updated_at"`
}

// ChannelService manages channels
type ChannelService struct {
    store ChannelStore
    rtm   *RTMClient
}

// NewChannelService creates a new channel service
func NewChannelService(store ChannelStore, rtm *RTMClient) *ChannelService {
    return &ChannelService{
        store: store,
        rtm:   rtm,
    }
}

// CreateChannel creates a new channel
func (s *ChannelService) CreateChannel(ctx context.Context, ch *Channel) error {
    ch.ID = generateID()
    ch.CreatedAt = time.Now()
    ch.UpdatedAt = ch.CreatedAt

    if err := s.store.Save(ctx, ch); err != nil {
        return err
    }

    // Add creator to channel
    s.rtm.JoinChannel(ch.ID, ch.CreatorID)

    // Notify workspace
    event := RTMEvent{
        Type: "channel_created",
        Data: ch,
    }
    s.broadcastToWorkspace(ch.WorkspaceID, event)

    return nil
}

// InviteToChannel invites a user to a channel
func (s *ChannelService) InviteToChannel(ctx context.Context, channelID, userID, inviterID string) error {
    ch, err := s.store.Get(ctx, channelID)
    if err != nil {
        return err
    }

    // Check if already a member
    for _, member := range ch.Members {
        if member == userID {
            return ErrAlreadyMember
        }
    }

    ch.Members = append(ch.Members, userID)
    ch.UpdatedAt = time.Now()

    if err := s.store.Update(ctx, ch); err != nil {
        return err
    }

    // Register for real-time updates
    s.rtm.JoinChannel(channelID, userID)

    // Notify channel
    event := RTMEvent{
        Type:    "member_joined_channel",
        Channel: channelID,
        Data: map[string]string{
            "user_id":    userID,
            "inviter_id": inviterID,
        },
    }
    s.rtm.BroadcastToChannel(channelID, event)

    return nil
}

// GetChannelHistory retrieves message history
func (s *ChannelService) GetChannelHistory(ctx context.Context, channelID string, limit int, before time.Time) ([]*Message, error) {
    return s.store.GetMessages(ctx, channelID, limit, before)
}

func (s *ChannelService) broadcastToWorkspace(workspaceID string, event RTMEvent) {
    // Would get all users in workspace and broadcast
}
```

---

### Junior -> FAANG: WebSocket Architecture as a Real-Time System Building Block

The `RTMClient` here is an in-memory hub for WebSocket connections. Understand its two responsibilities: tracking which connections belong to which user, and broadcasting messages to all connections for a given channel. These two maps implement the subscription model for real-time delivery.

The pattern of acquiring a read lock for broadcast (`BroadcastToChannel` holds `RLock` and sends to each connection in a goroutine) is correct for concurrent broadcast. The critical correctness property: you must not hold the write lock while writing to a WebSocket connection, because WebSocket writes can block and holding a write lock while blocking blocks all other readers and writers. The goroutine-per-connection write releases the read lock immediately after launching the goroutines.

The dual-write in `InviteToChannel` (update the persistent store, then call `rtm.JoinChannel`) is the pattern for keeping durable state and in-memory state synchronized. The order matters: always write to the durable store first. If the process crashes between the two writes, the invite is persisted and will be re-applied when the consumer reconnects (if you have a reconnection sync path). If you write to memory first and the process crashes before persisting, the invite is lost.

First-job habit: when designing a real-time messaging system, always ask "what happens when a client reconnects?" The client must receive all messages sent while it was disconnected. This requires either a message replay mechanism (store N seconds of messages in a buffer and replay on reconnect) or a "catch up from last sequence number" protocol. Neither is trivial to implement correctly at scale.

### Senior @ FAANG: Scaling the WebSocket Hub Across Multiple Servers

The `RTMClient` works correctly on a single server but fails across multiple servers. If a user has two devices connected to different gateway servers, and another user sends a message to a channel, only the gateway server that received the message will broadcast it, leaving the other device unnotified.

The production solution is a message bus (Redis pub/sub, Kafka, or NATS) that routes messages between gateway servers. When a gateway receives a message for channel `C`, it publishes to a Redis pub/sub channel `channel:C`. Every gateway server subscribes to `channel:C` and broadcasts to its local connections. This scales the broadcast to the full connection pool across all gateway servers without coordination between them.

The `channels` map in `RTMClient` maps channel IDs to user IDs. At Slack's scale, some enterprise channels have tens of thousands of members. Iterating over a 50,000-member channel to build the broadcast list on every message is O(n) in the channel size. The production optimization is to maintain a `channel_membership` counter per channel and use a tiered broadcast strategy: for channels under a threshold, enumerate members, and for large channels, publish to a channel-level pub/sub topic and let each gateway server check its local connection table rather than iterating the full member list.

Presence aggregation (who is online) is the hardest problem in real-time messaging at Slack's scale. Every WebSocket connect and disconnect is a presence event. With 10 million concurrent users, presence events arrive at hundreds of thousands per second. Individually publishing presence events for every connect/disconnect is not scalable. The production approach is presence batching (collect presence events over a 5-second window and publish the diff) and selective presence (only compute presence for users who are actively viewing a channel, not for all members of all channels the user belongs to).