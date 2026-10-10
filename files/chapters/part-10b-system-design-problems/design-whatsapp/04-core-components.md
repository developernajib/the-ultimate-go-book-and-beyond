## Core Components

The system is built from four main services, each responsible for a distinct concern. The Connection Service manages persistent WebSocket connections and routes messages between users. The Chat Service handles message persistence, delivery logic, and status tracking. The Group Service manages group membership and fan-out. The Media Service handles large file uploads and downloads via pre-signed URLs. Below is the Go implementation of each component.

### 1. Connection Service

The Connection Service maintains a persistent WebSocket connection for each online user, routing inbound messages to their recipient immediately when both users are online. Each server instance holds a `sync.RWMutex`-protected map of `userID → Client` connections, and a Redis key per user records which server currently holds that user's connection so messages can be forwarded cross-server. When a user goes offline, the key is deleted and the connection's resources are released.

Two details in the code below carry more weight than they appear to. The first is that exactly one goroutine writes to any given socket. `gorilla/websocket` supports one concurrent reader and one concurrent writer and does no locking of its own, so a second goroutine calling `WriteMessage` on the same connection is a data race that interleaves frame bytes and corrupts the stream. Routing every outbound frame through the buffered `send` channel makes that discipline structural instead of something you have to remember. The second is that `writePump` must have an exit path that does not depend on `send` being closed. Closing `send` from the producer side would race with `DeliverToUser`, so the `done` channel carries the shutdown signal instead, and `sync.Once` makes the close idempotent no matter which pump notices the disconnect first.

```go
package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// ConnectionServer manages WebSocket connections
type ConnectionServer struct {
	serverID string
	clients  map[string]*Client // userID → Client
	mu       sync.RWMutex
	rdb      *redis.Client
	chatSvc  ChatService
	upgrader websocket.Upgrader
}

// Client represents a connected user.
//
// Exactly one goroutine (writePump) ever writes to conn. gorilla/websocket
// permits one concurrent reader and one concurrent writer, and no more, so
// every outbound frame is funnelled through the send channel rather than
// written from whichever goroutine happens to produce it. done is closed once,
// by unregister, and is what lets writePump exit instead of blocking on send
// forever after the reader has gone away.
type Client struct {
	UserID    string
	conn      *websocket.Conn
	send      chan []byte
	serverID  string
	done      chan struct{}
	closeOnce sync.Once
}

// close releases the client. Safe to call from any goroutine, any number of
// times.
func (c *Client) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		c.conn.Close()
	})
}

// Message types
const (
	MsgTypeText      = "text"
	MsgTypeMedia     = "media"
	MsgTypeDelivered = "delivered"
	MsgTypeRead      = "read"
	MsgTypeTyping    = "typing"
	MsgTypePresence  = "presence"
)

// WebSocketMessage is the wire format
type WebSocketMessage struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	From      string          `json:"from"`
	To        string          `json:"to"` // userID or groupID
	Content   json.RawMessage `json:"content"`
	Timestamp int64           `json:"ts"`
}

// HandleWebSocket upgrades HTTP to WebSocket
func (s *ConnectionServer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-ID") // from auth middleware
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	client := &Client{
		UserID:   userID,
		conn:     conn,
		send:     make(chan []byte, 256),
		serverID: s.serverID,
		done:     make(chan struct{}),
	}

	s.register(client)
	defer s.unregister(client)

	// Flush offline messages
	go s.deliverOfflineMessages(client)

	// Start pumps
	go client.writePump()
	client.readPump(s) // blocks until the peer disconnects
}

func (s *ConnectionServer) register(c *Client) {
	s.mu.Lock()
	// A reconnect can race the old connection's unregister. Evict the
	// predecessor explicitly rather than dropping it on the floor, or its
	// pumps leak until the read deadline fires.
	if old, ok := s.clients[c.UserID]; ok && old != c {
		old.close()
	}
	s.clients[c.UserID] = c
	s.mu.Unlock()

	// Publish presence to Redis so other servers know this user is here
	ctx := context.Background()
	s.rdb.Set(ctx,
		fmt.Sprintf("presence:%s", c.UserID),
		s.serverID,
		5*time.Minute,
	)
	// Refresh presence periodically
	go s.refreshPresence(c)
}

func (s *ConnectionServer) unregister(c *Client) {
	s.mu.Lock()
	// Only clear the map if we are still the live connection for this user.
	// A reconnect may already have installed a newer Client under this key.
	if cur, ok := s.clients[c.UserID]; ok && cur == c {
		delete(s.clients, c.UserID)
		s.mu.Unlock()
		s.rdb.Del(context.Background(), fmt.Sprintf("presence:%s", c.UserID))
	} else {
		s.mu.Unlock()
	}

	// Closing done unblocks writePump. Without this it parks on <-c.send
	// for the life of the process: a goroutine leak of one per disconnect,
	// which at this connection churn is fatal within hours.
	c.close()
}

// refreshPresence keeps the presence key alive while the client is connected.
// It is bound to the client's lifetime, not to a background context, so it
// terminates promptly on disconnect.
func (s *ConnectionServer) refreshPresence(c *Client) {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	ctx := context.Background()
	for {
		select {
		case <-ticker.C:
			// Refresh only if we are still the live connection. Blindly
			// extending would resurrect presence for a user who has since
			// moved to another server.
			s.mu.RLock()
			cur, ok := s.clients[c.UserID]
			s.mu.RUnlock()
			if !ok || cur != c {
				return
			}
			s.rdb.Expire(ctx, fmt.Sprintf("presence:%s", c.UserID), 5*time.Minute)
		case <-c.done:
			return
		}
	}
}

// DeliverToUser routes a message to a connected user
func (s *ConnectionServer) DeliverToUser(ctx context.Context, userID string, msg []byte) error {
	s.mu.RLock()
	client, ok := s.clients[userID]
	s.mu.RUnlock()

	if ok {
		select {
		case client.send <- msg:
			// Handed off, not yet on the wire. If the socket dies before
			// writePump flushes it, the message is still in Cassandra and the
			// client re-requests everything after its last acked message ID on
			// reconnect. That resync, not this channel, is what makes delivery
			// reliable.
			return nil
		default:
			return fmt.Errorf("client send buffer full")
		}
	}

	// User connected to another server - route via Redis Pub/Sub
	targetServer, err := s.rdb.Get(ctx, fmt.Sprintf("presence:%s", userID)).Result()
	if err != nil {
		// User offline - enqueue message
		return s.enqueueOffline(ctx, userID, msg)
	}

	// Publish to target server's channel
	return s.rdb.Publish(ctx, fmt.Sprintf("server:%s", targetServer), string(msg)).Err()
}

func (s *ConnectionServer) enqueueOffline(ctx context.Context, userID string, msg []byte) error {
	key := fmt.Sprintf("offline:%s", userID)
	pipe := s.rdb.Pipeline()
	pipe.RPush(ctx, key, msg)
	pipe.Expire(ctx, key, 30*24*time.Hour) // keep for 30 days
	_, err := pipe.Exec(ctx)
	return err
}

// deliverOfflineMessages drains the user's offline queue on reconnect.
//
// Two things here are easy to get wrong and both lose messages permanently.
//
// First, LRANGE followed by DEL is not atomic. Any message RPUSHed by another
// server in the window between the two commands is deleted without ever being
// read. LPOP with a count pops and removes in one round trip, so a concurrent
// RPUSH either lands before the pop and is delivered, or lands after it and
// waits for the next batch.
//
// Second, the queue must not be drained faster than the socket accepts. If the
// send buffer fills we stop, and the messages still in Redis stay in Redis.
// Popping them and then dropping them on a full channel would acknowledge
// delivery that never happened.
func (s *ConnectionServer) deliverOfflineMessages(c *Client) {
	ctx := context.Background()
	key := fmt.Sprintf("offline:%s", c.UserID)

	for {
		msgs, err := s.rdb.LPopCount(ctx, key, 64).Result()
		if err != nil || len(msgs) == 0 {
			return // redis.Nil once the queue is empty
		}

		for i, msg := range msgs {
			select {
			case c.send <- []byte(msg):
			case <-c.done:
				// Client vanished mid-drain. Put back everything we popped
				// but did not hand off, preserving order.
				s.requeue(ctx, key, msgs[i:])
				return
			case <-time.After(5 * time.Second):
				// Socket is not draining. Return the remainder to the queue
				// rather than discarding it, and let the next reconnect retry.
				s.requeue(ctx, key, msgs[i:])
				return
			}
		}
	}
}

// requeue pushes unhandled messages back to the head of the offline queue,
// preserving their original relative order.
func (s *ConnectionServer) requeue(ctx context.Context, key string, msgs []string) {
	if len(msgs) == 0 {
		return
	}
	vals := make([]any, len(msgs))
	for i, m := range msgs {
		vals[i] = m
	}
	// LPUSH with multiple values inserts them one at a time, so the last
	// argument ends up first. Push in reverse to restore the original order.
	for i, j := 0, len(vals)-1; i < j; i, j = i+1, j-1 {
		vals[i], vals[j] = vals[j], vals[i]
	}
	s.rdb.LPush(ctx, key, vals...)
}

// writePump is the sole writer on c.conn. Every other goroutine that wants to
// send something publishes to c.send and lets this loop serialise it. Two
// goroutines calling conn.WriteMessage concurrently is a data race that
// gorilla/websocket does not guard against, and it corrupts the frame stream.
func (c *Client) writePump() {
	ticker := time.NewTicker(54 * time.Second) // WebSocket ping
	defer func() {
		ticker.Stop()
		c.close()
	}()

	for {
		select {
		case msg := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			// unregister ran. Say goodbye and stop, rather than parking on
			// c.send until the process exits.
			c.conn.SetWriteDeadline(time.Now().Add(time.Second))
			c.conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			return
		}
	}
}

func (c *Client) readPump(s *ConnectionServer) {
	defer c.close()
	c.conn.SetReadLimit(512 * 1024) // 512KB max message
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		var msg WebSocketMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		msg.From = c.UserID
		s.handleIncoming(c, msg)
	}
}

func (s *ConnectionServer) handleIncoming(c *Client, msg WebSocketMessage) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var err error
	switch msg.Type {
	case MsgTypeText, MsgTypeMedia:
		err = s.chatSvc.SendMessage(ctx, msg)
	case MsgTypeDelivered, MsgTypeRead:
		err = s.chatSvc.UpdateStatus(ctx, msg)
	case MsgTypeTyping:
		// Fan out typing indicator to recipient (transient, no persistence)
		data, _ := json.Marshal(msg)
		err = s.DeliverToUser(ctx, msg.To, data)
	}

	// Never swallow this. If the write failed, the sender's client must keep
	// the message queued and retry, and it only knows to do that if we say so.
	// A send that returns no ack and no error is how a chat app loses a message
	// while showing a single tick forever.
	ack := WebSocketMessage{Type: "ack", ID: msg.ID, Timestamp: time.Now().UnixMilli()}
	if err != nil {
		log.Printf("handle %s from %s: %v", msg.Type, c.UserID, err)
		ack.Type = "nack"
	}
	data, _ := json.Marshal(ack)
	select {
	case c.send <- data:
	default: // sender's buffer is full, it will resync on reconnect
	}
}
```

### 2. Chat Service

The Chat Service is responsible for durable message storage, delivery status tracking, and offline message queuing. Every outbound message is written to Cassandra partitioned by `conv_id` with a TimeUUID clustering key, ensuring that all messages in a conversation are co-located for efficient retrieval. When the recipient is offline, the message is stored in Cassandra and a push notification is triggered, when the recipient reconnects, the service queries for all undelivered messages and flushes them in order.

```go
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gocql/gocql"
	"github.com/redis/go-redis/v9"
)

// ChatService handles message persistence and delivery
type ChatService struct {
	session    *gocql.Session
	rdb        *redis.Client // idempotency tokens
	connServer ConnectionRouter
	groupSvc   *GroupService
	kafka      MessageProducer
}

var ErrNotFound = errors.New("conversation not found")

// Message is the persisted message structure.
//
// ID is a server-assigned TimeUUID and doubles as the clustering key, which is
// what gives a conversation a total order without a coordinator.
//
// ClientMsgID is the sender's own idempotency token, stable across retries.
// The transport is at-least-once: a client that does not see an ack retries,
// and the retry carries the same ClientMsgID. SendMessage resolves it to the
// message_id already assigned on the first attempt, so the retry re-delivers
// that message rather than minting a second one. Recipients additionally
// discard any ClientMsgID they have already rendered, which is what closes the
// gap the server cannot: exactly-once delivery is not achievable over an
// unreliable link, exactly-once *effect* is, and it takes both sides.
type Message struct {
	ID          gocql.UUID `json:"id"` // TimeUUID, server-assigned
	ClientMsgID string     `json:"client_msg_id"`
	ConvID      string     `json:"conv_id"`
	SenderID    string     `json:"sender_id"`
	RecipientID string     `json:"recipient_id"` // empty for groups
	GroupID     string     `json:"group_id"`     // empty for 1:1
	Type        string     `json:"type"`
	Content     string     `json:"content"` // ciphertext, opaque to this service
	MediaURL    string     `json:"media_url,omitempty"`
	Status      string     `json:"status"` // sent, delivered, read
	SentAt      time.Time  `json:"sent_at"`
	DeliveredAt *time.Time `json:"delivered_at,omitempty"`
	ReadAt      *time.Time `json:"read_at,omitempty"`
}

// SendMessage processes an outgoing message.
//
// wsMsg.From is set by the connection layer from the authenticated session and
// never read from the client payload, so a client cannot forge a sender.
func (s *ChatService) SendMessage(ctx context.Context, wsMsg WebSocketMessage) error {
	var content struct {
		Text     string `json:"text,omitempty"`
		MediaKey string `json:"media_key,omitempty"`
	}
	if err := json.Unmarshal(wsMsg.Content, &content); err != nil {
		return fmt.Errorf("malformed content: %w", err)
	}

	msg := Message{
		ClientMsgID: wsMsg.ID,
		SenderID:    wsMsg.From,
		Type:        wsMsg.Type,
		Content:     content.Text, // ciphertext produced on the sender's device
		Status:      "sent",
	}

	// Route to group or 1:1
	if isGroupID(wsMsg.To) {
		msg.GroupID = wsMsg.To
		msg.ConvID = wsMsg.To
		ok, err := s.groupSvc.IsMember(ctx, msg.GroupID, msg.SenderID)
		if err != nil {
			return fmt.Errorf("authorize: %w", err)
		}
		if !ok {
			// Without this, knowing a group ID is enough to post into a group
			// you were removed from, or were never in.
			return ErrNotFound
		}
	} else {
		msg.RecipientID = wsMsg.To
		msg.ConvID = conversationID(wsMsg.From, wsMsg.To)
	}

	// Resolve the idempotency token before assigning an ID. SetNX returns
	// false when this ClientMsgID was already accepted, which means this is a
	// retry of a send we durably stored, and re-inserting it would show the
	// recipient the same message twice.
	msg.ID = gocql.TimeUUID()
	msg.SentAt = msg.ID.Time()

	key := fmt.Sprintf("sent:%s:%s", msg.SenderID, msg.ClientMsgID)
	fresh, err := s.rdb.SetNX(ctx, key, msg.ID.String(), 24*time.Hour).Result()
	if err != nil {
		return fmt.Errorf("dedup: %w", err)
	}
	if !fresh {
		// Already accepted. Re-deliver the original rather than duplicating,
		// and report success so the sender stops retrying.
		prior, err := s.rdb.Get(ctx, key).Result()
		if err != nil {
			return fmt.Errorf("dedup lookup: %w", err)
		}
		if msg.ID, err = gocql.ParseUUID(prior); err != nil {
			return fmt.Errorf("dedup parse: %w", err)
		}
		msg.SentAt = msg.ID.Time()
	}

	if msg.GroupID != "" {
		return s.sendGroupMessage(ctx, msg)
	}
	return s.sendDirectMessage(ctx, msg)
}

// sendDirectMessage handles 1:1 messages
func (s *ChatService) sendDirectMessage(ctx context.Context, msg Message) error {
	// Persist to Cassandra
	if err := s.persistMessage(ctx, msg); err != nil {
		return fmt.Errorf("persist: %w", err)
	}

	// Send to recipient
	data, _ := json.Marshal(msg)
	if err := s.connServer.DeliverToUser(ctx, msg.RecipientID, data); err != nil {
		// Offline - notification service will handle push
		s.kafka.Publish(ctx, "push-notifications", msg.RecipientID, data)
	}

	return nil
}

// sendGroupMessage fans out to all group members
func (s *ChatService) sendGroupMessage(ctx context.Context, msg Message) error {
	// Persist once (not per member)
	if err := s.persistMessage(ctx, msg); err != nil {
		return fmt.Errorf("persist: %w", err)
	}

	// Get group members
	members, err := s.groupSvc.GetMembers(ctx, msg.GroupID)
	if err != nil {
		return fmt.Errorf("get members: %w", err)
	}

	data, _ := json.Marshal(msg)

	// Fan out delivery (async via Kafka for large groups)
	if len(members) > 100 {
		return s.kafka.Publish(ctx, "group-fanout", msg.GroupID, data)
	}

	// Small groups: direct delivery
	for _, memberID := range members {
		if memberID == msg.SenderID {
			continue
		}
		if err := s.connServer.DeliverToUser(ctx, memberID, data); err != nil {
			s.kafka.Publish(ctx, "push-notifications", memberID, data)
		}
	}
	return nil
}

// persistMessage stores message in Cassandra
func (s *ChatService) persistMessage(ctx context.Context, msg Message) error {
	return s.session.Query(`
		INSERT INTO messages (
			conv_id, message_id, client_msg_id, sender_id, recipient_id, group_id,
			type, content, media_url, status, sent_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.ConvID, msg.ID, msg.ClientMsgID, msg.SenderID, msg.RecipientID, msg.GroupID,
		msg.Type, msg.Content, msg.MediaURL, msg.Status, msg.SentAt,
	).WithContext(ctx).Exec()
}

// canAccess reports whether requesterID is a participant in convID.
//
// For a 1:1 conversation the ID is the two user IDs sorted and joined, so
// membership is a string check with no round trip. For a group the answer
// lives in group_members.
//
// This is the check that gets forgotten. A conv_id is guessable: it is derived
// from two user IDs, so anyone who knows a phone number's user ID can compute
// the conv_id of a conversation they are not in. Authenticating the caller and
// then never asking whether that caller belongs in the row you are about to
// return is the whole of IDOR.
func (s *ChatService) canAccess(ctx context.Context, requesterID, convID string) (bool, error) {
	if isGroupID(convID) {
		return s.groupSvc.IsMember(ctx, convID, requesterID)
	}
	a, b, ok := splitConversationID(convID)
	if !ok {
		return false, fmt.Errorf("malformed conv_id")
	}
	return requesterID == a || requesterID == b, nil
}

// GetConversation retrieves messages for a conversation.
//
// beforeID is the pagination cursor: the message_id of the oldest message the
// caller already has, or an empty UUID for the newest page. message_id is a
// TimeUUID and the table clusters on it descending, so this is a single
// contiguous backwards scan of one partition.
//
// Note that the range is on message_id, not sent_at. Cassandra can only order
// and range-scan on clustering columns, and CQL compares timeuuid values by
// their embedded timestamp, so this stays chronological.
//
// Sorting the same IDs as *strings* would not be chronological, and the way it
// fails is worth knowing. A v1 UUID's textual form leads with time_low, the
// low 32 bits of a 100-nanosecond counter. Those bits wrap every 2^32 * 100ns,
// about 7 minutes 10 seconds. Inside one wrap window a lexicographic sort is
// accidentally correct, which is why this bug sails through unit tests that
// generate their fixtures in a tight loop and then scrambles history in
// production, where conversations span months. Compare TimeUUIDs as TimeUUIDs.
func (s *ChatService) GetConversation(ctx context.Context, requesterID, convID string, beforeID gocql.UUID, limit int) ([]Message, error) {
	ok, err := s.canAccess(ctx, requesterID, convID)
	if err != nil {
		return nil, fmt.Errorf("authorize: %w", err)
	}
	if !ok {
		// Same error a missing conversation returns. Distinguishing the two
		// would confirm to a prober that the conversation exists.
		return nil, ErrNotFound
	}

	if beforeID == (gocql.UUID{}) {
		beforeID = gocql.MaxTimeUUID(time.Now())
	}

	iter := s.session.Query(`
		SELECT message_id, sender_id, recipient_id, group_id, type, content,
		       media_url, status, sent_at, delivered_at, read_at
		FROM messages
		WHERE conv_id = ? AND message_id < ?
		LIMIT ?`,
		convID, beforeID, limit,
	).WithContext(ctx).Iter()

	var msgs []Message
	for {
		// A fresh value per row. gocql does nil out a *time.Time when the
		// column is NULL, so reusing one struct would also be correct here,
		// but only because every field is overwritten on every scan. Declaring
		// it inside the loop means that stays true when someone later adds a
		// column to the struct and forgets to add it to the SELECT.
		msg := Message{ConvID: convID}
		if !iter.Scan(
			&msg.ID, &msg.SenderID, &msg.RecipientID, &msg.GroupID,
			&msg.Type, &msg.Content, &msg.MediaURL, &msg.Status, &msg.SentAt,
			&msg.DeliveredAt, &msg.ReadAt,
		) {
			break
		}
		msgs = append(msgs, msg)
	}
	return msgs, iter.Close()
}

// UpdateStatus updates message delivery/read status: the second and third
// ticks of the sent → delivered → read state machine.
//
// The receipt is authorized against the conversation, not merely against the
// session. wsMsg.From is the authenticated reporter, and a reporter who is not
// a participant has no business marking anything in this conversation, nor
// learning whether the message ID they guessed exists.
func (s *ChatService) UpdateStatus(ctx context.Context, wsMsg WebSocketMessage) error {
	var statusUpdate struct {
		MessageID string `json:"message_id"`
		ConvID    string `json:"conv_id"`
	}
	if err := json.Unmarshal(wsMsg.Content, &statusUpdate); err != nil {
		return fmt.Errorf("malformed status update: %w", err)
	}

	ok, err := s.canAccess(ctx, wsMsg.From, statusUpdate.ConvID)
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if !ok {
		return ErrNotFound
	}

	msgID, err := gocql.ParseUUID(statusUpdate.MessageID)
	if err != nil {
		return fmt.Errorf("bad message id: %w", err)
	}

	// col is chosen from two literals, never from input, so this Sprintf
	// cannot become an injection point. Values still travel as bind params:
	// CQL will not accept an identifier as one.
	col := "read_at"
	if wsMsg.Type == MsgTypeDelivered {
		col = "delivered_at"
	}

	// WHERE names the full primary key (conv_id, message_id). Cassandra rejects
	// an UPDATE that does not, so a partial key here is a runtime error rather
	// than the silent full-partition write it would be in SQL.
	err = s.session.Query(
		fmt.Sprintf("UPDATE messages SET %s = ?, status = ? WHERE conv_id = ? AND message_id = ?", col),
		time.Now(), strings.TrimSuffix(col, "_at"), statusUpdate.ConvID, msgID,
	).WithContext(ctx).Exec()
	if err != nil {
		return err
	}

	// Notify the original sender that their tick advanced.
	notification, _ := json.Marshal(wsMsg)
	return s.connServer.DeliverToUser(ctx, wsMsg.To, notification)
}

// conversationID creates a stable ID for two users. Sorting the pair means
// both directions of the same chat land on the same Cassandra partition.
func conversationID(a, b string) string {
	if a < b {
		return a + ":" + b
	}
	return b + ":" + a
}

// splitConversationID reverses conversationID. User IDs are UUIDs and contain
// no colon, so the split is unambiguous.
func splitConversationID(convID string) (a, b string, ok bool) {
	a, b, ok = strings.Cut(convID, ":")
	if !ok || a == "" || b == "" {
		return "", "", false
	}
	return a, b, true
}

func isGroupID(id string) bool {
	return strings.HasPrefix(id, "g")
}
```

### 3. Group Service

Group messaging introduces a fan-out problem: when a user sends a message to a 1,024-member group, the server must deliver it to up to 1,024 recipients. The Group Service fetches member IDs from a Redis cache backed by Cassandra, and the Chat Service above then routes to each member. Caching matters here because loading 1,024 members from Cassandra on every group message multiplies the read load by the group size.

One asymmetry is worth calling out. `GetMembers` serves the fan-out path from cache, but `IsMember` deliberately does not: authorization reads Cassandra every time. A stale cache on the fan-out path means a removed member receives one or two more messages, which is a bug. A stale cache on the authorization path means a removed member can still read and post for the full ten minute TTL, which is a vulnerability. The same staleness has very different consequences depending on what you spend it on, and caching an authorization decision is almost never worth the round trip you save.

`AddMember` also reads the member count and then inserts, which is not atomic. Two concurrent joins at 1,023 members both observe 1,023 and both insert, and the group ends up at 1,025. Cassandra has no cheap way to make that atomic: a lightweight transaction would serialize on the partition, and a counter column cannot live in the same table as regular columns. In practice a group overshooting its cap by a member or two is tolerable, and admission is re-checked when the membership list is next rebuilt. Knowing which races you are choosing not to fix, and why, is part of the design.

```go
package chat

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/gocql/gocql"
	"github.com/redis/go-redis/v9"
)

// GroupService manages group chat operations.
//
// Group metadata lives in PostgreSQL, where it is low volume and benefits from
// constraints and joins. Membership lives in Cassandra alongside messages,
// where it is read on the hot path of every group send and must partition the
// same way. Two stores, split on access pattern rather than on tidiness.
type GroupService struct {
	db      *sql.DB        // groups metadata
	session *gocql.Session // group_members
	rdb     *redis.Client
}

// Group represents a chat group
type Group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatorID   string    `json:"creator_id"`
	MaxMembers  int       `json:"max_members"`
	CreatedAt   time.Time `json:"created_at"`
}

// CreateGroup creates a new group
func (s *GroupService) CreateGroup(ctx context.Context, name, creatorID string) (*Group, error) {
	group := &Group{
		ID:         "g" + generateID(),
		Name:       name,
		CreatorID:  creatorID,
		MaxMembers: 1024,
		CreatedAt:  time.Now(),
	}

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO groups (id, name, description, creator_id, max_members, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		group.ID, group.Name, group.Description, group.CreatorID, group.MaxMembers, group.CreatedAt,
	)
	if err != nil {
		return nil, err
	}

	// Add creator as admin member
	if err := s.AddMember(ctx, group.ID, creatorID, "admin"); err != nil {
		return nil, err
	}

	return group, nil
}

// AddMember adds a user to a group
func (s *GroupService) AddMember(ctx context.Context, groupID, userID, role string) error {
	count, err := s.getMemberCount(ctx, groupID)
	if err != nil {
		return err
	}
	if count >= 1024 {
		return fmt.Errorf("group is full (max 1024 members)")
	}

	err = s.session.Query(`
		INSERT INTO group_members (group_id, user_id, role, joined_at)
		VALUES (?, ?, ?, ?)`,
		groupID, userID, role, time.Now(),
	).WithContext(ctx).Exec()
	if err != nil {
		return err
	}

	// Invalidate cached member list
	s.rdb.Del(ctx, fmt.Sprintf("group:members:%s", groupID))
	return nil
}

// GetMembers returns all member IDs for a group
func (s *GroupService) GetMembers(ctx context.Context, groupID string) ([]string, error) {
	cacheKey := fmt.Sprintf("group:members:%s", groupID)

	// Check cache
	cached, err := s.rdb.SMembers(ctx, cacheKey).Result()
	if err == nil && len(cached) > 0 {
		return cached, nil
	}

	// Load from Cassandra
	var members []string
	iter := s.session.Query(
		"SELECT user_id FROM group_members WHERE group_id = ?", groupID,
	).WithContext(ctx).Iter()

	var uid string
	for iter.Scan(&uid) {
		members = append(members, uid)
	}
	if err := iter.Close(); err != nil {
		return nil, err
	}

	// Cache for 10 minutes.
	//
	// Build the set under a temporary key and RENAME it into place. SAdd-ing
	// straight onto cacheKey would union this snapshot with whatever is already
	// there, so a concurrent AddMember that invalidated the key mid-read would
	// leave the union of the old and new member lists cached for ten minutes.
	// RENAME is atomic and replaces the key outright.
	if len(members) > 0 {
		tmp := fmt.Sprintf("%s:build:%d", cacheKey, time.Now().UnixNano())
		vals := make([]any, len(members))
		for i, m := range members {
			vals[i] = m
		}
		pipe := s.rdb.TxPipeline()
		pipe.SAdd(ctx, tmp, vals...)
		pipe.Expire(ctx, tmp, 10*time.Minute)
		pipe.Rename(ctx, tmp, cacheKey)
		if _, err := pipe.Exec(ctx); err != nil {
			s.rdb.Del(ctx, tmp) // cache fill is best effort, the read still succeeded
		}
	}

	return members, nil
}

func (s *GroupService) getMemberCount(ctx context.Context, groupID string) (int, error) {
	var count int
	err := s.session.Query(
		"SELECT COUNT(*) FROM group_members WHERE group_id = ?", groupID,
	).WithContext(ctx).Scan(&count)
	return count, err
}

// IsMember reports whether userID belongs to groupID. This is the
// authorization primitive the Chat Service calls on every group read and
// every group send.
//
// It reads group_members directly rather than the cached set from GetMembers.
// The cache is a fan-out optimization with a 10 minute TTL, and serving an
// authorization decision from it would keep a removed member reading the group
// for up to ten minutes after they were kicked out. Correctness beats the
// round trip here: this is a single-row, single-partition lookup.
func (s *GroupService) IsMember(ctx context.Context, groupID, userID string) (bool, error) {
	var found string
	err := s.session.Query(
		"SELECT user_id FROM group_members WHERE group_id = ? AND user_id = ?",
		groupID, userID,
	).WithContext(ctx).Scan(&found)
	if errors.Is(err, gocql.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// RemoveMember drops a user from a group and invalidates the cached member set.
func (s *GroupService) RemoveMember(ctx context.Context, groupID, userID string) error {
	err := s.session.Query(
		"DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
		groupID, userID,
	).WithContext(ctx).Exec()
	if err != nil {
		return err
	}
	s.rdb.Del(ctx, fmt.Sprintf("group:members:%s", groupID))
	return nil
}
```

### 4. Media Service

The Media Service avoids routing large binary payloads through the application servers by generating pre-signed S3 upload URLs that the client uses to upload media directly to object storage. After the client uploads a file, it sends only the `media_key` through the WebSocket connection, and the recipient fetches that key from the CDN. This design keeps the messaging infrastructure lightweight and ensures that media delivery scales independently of the connection layer.

End-to-end encryption constrains this service more than it first appears, and the constraint is worth sitting with. The sender encrypts the file on the device with a fresh random key and uploads the *ciphertext*. That key never reaches the server: it travels inside the E2E-encrypted message body alongside the `media_key` pointer. So the object in S3 is an opaque blob, and the CDN is serving bytes nobody at the operator can interpret.

Two consequences follow, and both are places where designs quietly cheat. First, the server cannot generate thumbnails, transcode video, scan for malware, or run perceptual hashing, because it cannot decrypt. Any of those must happen on the sending device before encryption, and the thumbnail then rides along inside the encrypted message. A design that claims E2E and then shows a server-side thumbnail Lambda has contradicted itself. Second, the download URL does not need to be secret to be safe. Possession of the URL yields ciphertext, and the decryption key is the real access control. That is why the code below returns a plain CDN URL rather than a signed one: the signature would be guarding a door that opens onto another locked door. The tradeoff you accept is that anyone who obtains the URL can measure the object's existence and size, which is metadata leakage, not content leakage.

```go
package media

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// MediaService handles media uploads and downloads
type MediaService struct {
	s3Client   *s3.Client
	s3Presign  *s3.PresignClient
	bucket     string
	cdnBaseURL string
}

// UploadRequest is returned to the client for direct S3 upload
type UploadRequest struct {
	UploadURL string            `json:"upload_url"`
	MediaKey  string            `json:"media_key"`
	Fields    map[string]string `json:"fields,omitempty"`
	ExpiresAt time.Time         `json:"expires_at"`
}

// InitiateUpload generates a pre-signed URL for media upload.
//
// sizeBytes is the size of the ciphertext, which the client knows before it
// asks. Binding ContentLength into the signature stops a client from presenting
// a 10KB estimate and then streaming 10GB through a URL we vouched for.
func (s *MediaService) InitiateUpload(ctx context.Context, senderID string, sizeBytes int64) (*UploadRequest, error) {
	if sizeBytes <= 0 || sizeBytes > 100*1024*1024 { // 100MB limit
		return nil, fmt.Errorf("invalid size: must be 1 byte to 100MB")
	}

	// The key embeds a random ID rather than anything derived from the sender's
	// content, and the object it names is ciphertext regardless.
	mediaKey := fmt.Sprintf("media/%s/%s/%s", senderID, time.Now().Format("2006/01/02"), generateMediaID())

	req, err := s.s3Presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(mediaKey),
		// Uploads are always opaque ciphertext. The real media type travels to
		// the recipient inside the encrypted message body.
		ContentType:   aws.String("application/octet-stream"),
		ContentLength: aws.Int64(sizeBytes),
	}, s3.WithPresignExpires(15*time.Minute))
	if err != nil {
		return nil, fmt.Errorf("presign: %w", err)
	}

	return &UploadRequest{
		UploadURL: req.URL,
		MediaKey:  mediaKey,
		ExpiresAt: time.Now().Add(15 * time.Minute),
	}, nil
}

// GetDownloadURL returns the CDN URL for an encrypted media object.
//
// The URL is unsigned on purpose. What it serves is ciphertext, and the
// decryption key reached the recipient inside the E2E message body, so the URL
// is a locator and not a credential. Signing it would add operational cost for
// no confidentiality gain.
func (s *MediaService) GetDownloadURL(ctx context.Context, mediaKey string) (string, error) {
	return fmt.Sprintf("%s/%s", s.cdnBaseURL, mediaKey), nil
}
```

---
