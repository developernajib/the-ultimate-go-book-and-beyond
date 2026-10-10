## 102H.17 Real-Time Architecture Patterns: CQRS, Presence & OT

### CQRS for Real-Time: Write to Kafka, Stream to WebSocket

In high-throughput systems, writes (commands) and reads (queries/streams) should be decoupled. Kafka acts as the durable event log. WebSocket servers consume and fan-out.

```go
package rtcqrs

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

// DomainEvent is a fact that has occurred in the system.
type DomainEvent struct {
	EventID   string          `json:"event_id"`
	Topic     string          `json:"topic"`
	AggregateID string        `json:"aggregate_id"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp time.Time       `json:"timestamp"`
}

// EventStream fans out Kafka events to WebSocket subscribers.
type EventStream struct {
	mu          sync.RWMutex
	subscribers map[string][]chan DomainEvent // topic → subscriber channels
	reader      *kafka.Reader
}

func NewEventStream(brokers []string, topic, groupID string) *EventStream {
	return &EventStream{
		subscribers: make(map[string][]chan DomainEvent),
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:  brokers,
			Topic:    topic,
			GroupID:  groupID,
			MinBytes: 1,
			MaxBytes: 1 << 20, // 1 MB
			MaxWait:  500 * time.Millisecond,
		}),
	}
}

// Run consumes Kafka messages and fans out to WebSocket subscribers.
func (s *EventStream) Run(ctx context.Context) {
	for {
		kafkaMsg, err := s.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("kafka fetch error: %v", err)
			continue
		}

		var event DomainEvent
		if err := json.Unmarshal(kafkaMsg.Value, &event); err != nil {
			log.Printf("event unmarshal error: %v", err)
			s.reader.CommitMessages(ctx, kafkaMsg)
			continue
		}

		s.fanOut(event)

		if err := s.reader.CommitMessages(ctx, kafkaMsg); err != nil {
			log.Printf("kafka commit error: %v", err)
		}
	}
}

func (s *EventStream) fanOut(event DomainEvent) {
	s.mu.RLock()
	// Fan out to topic-specific subscribers.
	subs := append(s.subscribers[event.Topic], s.subscribers["*"]...)
	s.mu.RUnlock()

	for _, ch := range subs {
		select {
		case ch <- event:
		default:
			log.Printf("subscriber channel full, dropping event %s", event.EventID)
		}
	}
}

// Subscribe returns a channel that receives events for the given topic.
func (s *EventStream) Subscribe(topic string) chan DomainEvent {
	ch := make(chan DomainEvent, 128)
	s.mu.Lock()
	s.subscribers[topic] = append(s.subscribers[topic], ch)
	s.mu.Unlock()
	return ch
}

// Unsubscribe removes a subscriber channel.
func (s *EventStream) Unsubscribe(topic string, ch chan DomainEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	subs := s.subscribers[topic]
	for i, sub := range subs {
		if sub == ch {
			s.subscribers[topic] = append(subs[:i], subs[i+1:]...)
			close(ch)
			return
		}
	}
}

// WriteEvent publishes a domain event to Kafka (the write side of CQRS).
func WriteEvent(ctx context.Context, writer *kafka.Writer, event DomainEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(event.AggregateID),
		Value: data,
	})
}
```

### Presence System: Online/Offline/Typing Indicators

Tracking presence at scale requires a data structure that tolerates missed heartbeats gracefully and cleans itself up without a background sweep goroutine. The `PresenceManager` below stores each room's members in a Redis sorted set keyed by `presence:room:<roomID>`, using the Unix heartbeat timestamp as the sort score. Online users are those whose score is within the last `presenceTTL` (30 seconds). Stale entries are pruned with `ZRemRangeByScore` during the read path, so no separate expiry job is needed. Rich per-user status (typing, online) is stored in a separate Redis key with an explicit TTL, which means a typing indicator automatically disappears if the client stops sending heartbeats.

```go
package presence

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	presenceTTL    = 30 * time.Second
	heartbeatEvery = 10 * time.Second
)

type Status string

const (
	StatusOnline  Status = "online"
	StatusTyping  Status = "typing"
	StatusOffline Status = "offline"
)

type UserPresence struct {
	UserID    string    `json:"user_id"`
	Status    Status    `json:"status"`
	RoomID    string    `json:"room_id"`
	UpdatedAt time.Time `json:"updated_at"`
}

// PresenceManager uses Redis sorted sets to track online users per room.
// Key: presence:room:<roomID> - sorted set with score = Unix timestamp.
// Members are UserIDs. TTL is enforced by pruning stale entries on read.
type PresenceManager struct {
	rdb *redis.Client
}

func NewPresenceManager(rdb *redis.Client) *PresenceManager {
	return &PresenceManager{rdb: rdb}
}

func roomKey(roomID string) string {
	return fmt.Sprintf("presence:room:%s", roomID)
}

func userStatusKey(userID, roomID string) string {
	return fmt.Sprintf("presence:status:%s:%s", roomID, userID)
}

// Heartbeat updates a user's presence timestamp. Call every heartbeatEvery seconds.
func (pm *PresenceManager) Heartbeat(ctx context.Context, userID, roomID string, status Status) error {
	now := float64(time.Now().Unix())
	pipe := pm.rdb.Pipeline()

	// Update sorted set score (timestamp = last heartbeat).
	pipe.ZAdd(ctx, roomKey(roomID), redis.Z{Score: now, Member: userID})
	pipe.Expire(ctx, roomKey(roomID), presenceTTL*4)

	// Store rich status (typing, etc.) with TTL.
	p := UserPresence{UserID: userID, Status: status, RoomID: roomID, UpdatedAt: time.Now()}
	data, _ := json.Marshal(p)
	pipe.Set(ctx, userStatusKey(userID, roomID), data, presenceTTL)

	_, err := pipe.Exec(ctx)
	return err
}

// Leave removes a user from the presence set immediately.
func (pm *PresenceManager) Leave(ctx context.Context, userID, roomID string) error {
	pipe := pm.rdb.Pipeline()
	pipe.ZRem(ctx, roomKey(roomID), userID)
	pipe.Del(ctx, userStatusKey(userID, roomID))
	_, err := pipe.Exec(ctx)
	return err
}

// OnlineUsers returns all users whose heartbeat is within presenceTTL.
func (pm *PresenceManager) OnlineUsers(ctx context.Context, roomID string) ([]UserPresence, error) {
	minScore := float64(time.Now().Add(-presenceTTL).Unix())

	// Remove stale entries first.
	pm.rdb.ZRemRangeByScore(ctx, roomKey(roomID), "-inf", fmt.Sprintf("%f", minScore))

	userIDs, err := pm.rdb.ZRevRangeByScore(ctx, roomKey(roomID), &redis.ZRangeBy{
		Min: fmt.Sprintf("%f", minScore),
		Max: "+inf",
	}).Result()
	if err != nil {
		return nil, err
	}

	var presences []UserPresence
	for _, uid := range userIDs {
		raw, err := pm.rdb.Get(ctx, userStatusKey(uid, roomID)).Bytes()
		if err != nil {
			continue
		}
		var p UserPresence
		if err := json.Unmarshal(raw, &p); err == nil {
			presences = append(presences, p)
		}
	}
	return presences, nil
}

// SetTyping marks a user as typing (with short TTL - auto-expires if they stop).
func (pm *PresenceManager) SetTyping(ctx context.Context, userID, roomID string) error {
	return pm.Heartbeat(ctx, userID, roomID, StatusTyping)
}

// RunHeartbeatLoop keeps a user's presence alive while connected.
func (pm *PresenceManager) RunHeartbeatLoop(ctx context.Context, userID, roomID string) {
	ticker := time.NewTicker(heartbeatEvery)
	defer ticker.Stop()
	// Set initial presence.
	pm.Heartbeat(ctx, userID, roomID, StatusOnline)
	for {
		select {
		case <-ctx.Done():
			pm.Leave(context.Background(), userID, roomID)
			return
		case <-ticker.C:
			pm.Heartbeat(ctx, userID, roomID, StatusOnline)
		}
	}
}
```

### Operational Transform for Collaborative Editing

OT ensures that concurrent edits from multiple users converge to the same document state. Here is a basic string-based OT implementation in Go:

```go
package ot

import "fmt"

// OpType is the kind of edit operation.
type OpType int

const (
	OpInsert OpType = iota
	OpDelete
	OpRetain
)

// Op is a single atomic edit.
type Op struct {
	Type   OpType
	Pos    int    // character position (for Insert/Delete)
	Text   string // inserted text (for Insert)
	Length int    // number of characters to delete/retain
}

// Document holds the current text and revision number.
type Document struct {
	Content  string
	Revision int
	History  []Op // ordered history of committed ops
}

// Apply applies an op to the document, returning the new content.
func (d *Document) Apply(op Op) error {
	switch op.Type {
	case OpInsert:
		if op.Pos < 0 || op.Pos > len(d.Content) {
			return fmt.Errorf("insert position %d out of range [0, %d]", op.Pos, len(d.Content))
		}
		d.Content = d.Content[:op.Pos] + op.Text + d.Content[op.Pos:]
	case OpDelete:
		end := op.Pos + op.Length
		if op.Pos < 0 || end > len(d.Content) {
			return fmt.Errorf("delete range [%d, %d] out of range [0, %d]", op.Pos, end, len(d.Content))
		}
		d.Content = d.Content[:op.Pos] + d.Content[end:]
	case OpRetain:
		// No-op for content - used in composition.
	}
	d.Revision++
	d.History = append(d.History, op)
	return nil
}

// Transform resolves two concurrent ops (op1 from client, op2 already committed).
// Returns op1' that can be applied after op2.
func Transform(op1, op2 Op) (Op, error) {
	switch {
	case op1.Type == OpInsert && op2.Type == OpInsert:
		// If op2 inserted before or at op1's position, shift op1 right.
		if op2.Pos <= op1.Pos {
			op1.Pos += len(op2.Text)
		}
		return op1, nil

	case op1.Type == OpInsert && op2.Type == OpDelete:
		// If op2 deleted text before op1's position, shift op1 left.
		if op2.Pos+op2.Length <= op1.Pos {
			op1.Pos -= op2.Length
		} else if op2.Pos < op1.Pos {
			op1.Pos = op2.Pos
		}
		return op1, nil

	case op1.Type == OpDelete && op2.Type == OpInsert:
		// If op2 inserted before the delete region, shift op1 right.
		if op2.Pos <= op1.Pos {
			op1.Pos += len(op2.Text)
		}
		return op1, nil

	case op1.Type == OpDelete && op2.Type == OpDelete:
		// Overlapping deletes: adjust length and position.
		if op2.Pos+op2.Length <= op1.Pos {
			op1.Pos -= op2.Length
		} else if op2.Pos >= op1.Pos+op1.Length {
			// No overlap.
		} else {
			// Partial or full overlap - shrink op1.
			overlapStart := max(op1.Pos, op2.Pos)
			overlapEnd := min(op1.Pos+op1.Length, op2.Pos+op2.Length)
			op1.Length -= overlapEnd - overlapStart
			if op2.Pos < op1.Pos {
				op1.Pos = op2.Pos
			}
		}
		return op1, nil
	}
	return op1, fmt.Errorf("unhandled op combination %v / %v", op1.Type, op2.Type)
}

// OTServer is the authoritative server that orders and transforms ops.
type OTServer struct {
	doc *Document
}

func NewOTServer(initial string) *OTServer {
	return &OTServer{doc: &Document{Content: initial}}
}

// Submit accepts an op from a client at a given revision and transforms
// it against all ops committed since that revision before applying.
func (s *OTServer) Submit(op Op, clientRevision int) (Op, error) {
	if clientRevision < 0 || clientRevision > len(s.doc.History) {
		return Op{}, fmt.Errorf("invalid revision %d (current: %d)", clientRevision, s.doc.Revision)
	}

	// Transform op against all history since the client's revision.
	var err error
	for _, committed := range s.doc.History[clientRevision:] {
		op, err = Transform(op, committed)
		if err != nil {
			return Op{}, fmt.Errorf("transform error: %w", err)
		}
	}

	if err := s.doc.Apply(op); err != nil {
		return Op{}, err
	}
	return op, nil // return transformed op to broadcast to other clients
}
```

### CRDT Introduction: Grow-Only Counter

CRDTs (Conflict-free Replicated Data Types) converge automatically without coordination. A G-Counter is the simplest CRDT: each node increments its own slot. The total is the sum.

```go
package crdt

import "sync"

// GCounter is a grow-only counter CRDT.
// Each node in a cluster has its own slot - merging takes the max of each slot.
type GCounter struct {
	mu     sync.RWMutex
	nodeID string
	counts map[string]int64
}

func NewGCounter(nodeID string) *GCounter {
	return &GCounter{
		nodeID: nodeID,
		counts: map[string]int64{nodeID: 0},
	}
}

func (c *GCounter) Increment(n int64) {
	c.mu.Lock()
	c.counts[c.nodeID] += n
	c.mu.Unlock()
}

func (c *GCounter) Value() int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var total int64
	for _, v := range c.counts {
		total += v
	}
	return total
}

// State returns the current vector for synchronization.
func (c *GCounter) State() map[string]int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snapshot := make(map[string]int64, len(c.counts))
	for k, v := range c.counts {
		snapshot[k] = v
	}
	return snapshot
}

// Merge combines another node's state. Takes element-wise max - always converges.
func (c *GCounter) Merge(remote map[string]int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for nodeID, v := range remote {
		if v > c.counts[nodeID] {
			c.counts[nodeID] = v
		}
	}
}

// PN-Counter (positive-negative counter) extends GCounter to support decrements.
type PNCounter struct {
	pos *GCounter
	neg *GCounter
}

func NewPNCounter(nodeID string) *PNCounter {
	return &PNCounter{
		pos: NewGCounter(nodeID),
		neg: NewGCounter(nodeID),
	}
}

func (c *PNCounter) Increment(n int64) { c.pos.Increment(n) }
func (c *PNCounter) Decrement(n int64) { c.neg.Increment(n) }
func (c *PNCounter) Value() int64      { return c.pos.Value() - c.neg.Value() }

func (c *PNCounter) Merge(posRemote, negRemote map[string]int64) {
	c.pos.Merge(posRemote)
	c.neg.Merge(negRemote)
}
```

**When to use CRDTs in real-time systems:**
- Distributed like counters (views, reactions, upvotes) - use G-Counter or PN-Counter
- Multi-master document sets (tags, labels) - use OR-Set (add-wins set)
- Last-write-wins registers (user status, cursor position) - use LWW-Register
- CRDTs avoid the coordination overhead of OT but are limited to specific data structures

### Junior → FAANG: Architecture Patterns as Building Blocks

The patterns in this section (CQRS with Kafka, CRDT data structures) are advanced architecture primitives. The entry point is to understand what problem each pattern solves before trying to implement it. CQRS with Kafka solves the problem of decoupling the write path (which must be strongly consistent and fast) from the read/push path (which must fan out to many clients). CRDTs solve the problem of concurrent writes to shared state without requiring a central coordinator.

For the interview, being able to describe CQRS in the context of real-time systems is valuable: "writes go to the command service and are durably committed to Kafka. A separate consumer group reads from Kafka and fans out to connected WebSocket clients. This decoupling means the write path is not affected by how many clients are connected, and a client spike does not backpressure into the write path."

Do not try to memorize CRDT implementation details for interviews at the junior level. Understanding that CRDTs are data structures that can be merged without conflict, and knowing two concrete examples (G-Counter for counting, LWW-Register for last-write-wins), is the appropriate depth.

### Senior @ FAANG: CQRS and CRDTs as Platform Architecture Decisions

At L6, CQRS and CRDT selection are architectural commitments with organizational consequences. CQRS with Kafka means the team must operate Kafka (or use a managed service), reason about event ordering and compaction, and design for eventual consistency in the read path. This is an appropriate investment for a high-throughput system where the write and read paths have genuinely different scaling requirements. It is over-engineered for a system with moderate load where a single database with change data capture (CDC) would suffice.

CRDT selection for collaborative editing has a correctness dimension that is easy to get wrong. The RGA (Replicated Growable Array) CRDT for text editing converges correctly under concurrent insertions and deletions, but its implementation is complex and the performance characteristics (memory per character, merge cost for large concurrent edits) must be understood before choosing it over OT. The Yjs library, which uses a variant of the YATA algorithm, is the current production standard for CRDT-based collaborative editing in web applications. Understanding why Yjs was chosen over a simpler CRDT, and what tradeoffs were made, is the kind of depth that separates L6 collaborative system design from L5.

---
