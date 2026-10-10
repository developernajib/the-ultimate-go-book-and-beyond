## Production Pitfalls: Real-Time Chat Disasters

Real-time chat systems fail in ways that are unique to their always-connected, high-throughput nature. The pitfalls in this section are drawn from real production incidents at chat companies, where seemingly minor oversights caused major outages or data corruption. Each pitfall shows the dangerous anti-pattern first, explains why it fails under real-world conditions, and then provides the correct solution. Studying these failure modes now will help you avoid costly mistakes when you build and operate your own real-time systems.

### Pitfall 1: The Message Ordering Nightmare

**Real Incident Report**: A chat app showed messages in different orders for different users. Messages sent at nearly the same time appeared jumbled, causing confusion and missed context in critical conversations.

**The Anti-Pattern**:
```go
// DANGEROUS: Using server receive time for ordering
func (h *Hub) HandleMessage(msg *Message) {
    msg.Timestamp = time.Now() // Server receive time varies!
    h.broadcast <- msg
}
```

**The Better Approach**:
```go
type MessageOrderer struct {
    sequencer *Sequencer
    clock     *HybridLogicalClock
}

type HybridLogicalClock struct {
    mu       sync.Mutex
    lastTime int64
    counter  uint32
}

func (c *HybridLogicalClock) Now() int64 {
    c.mu.Lock()
    defer c.mu.Unlock()

    physicalTime := time.Now().UnixNano()

    if physicalTime > c.lastTime {
        c.lastTime = physicalTime
        c.counter = 0
    } else {
        c.counter++
    }

    // Combine physical time with counter
    return (c.lastTime & 0x7FFFFFFFFFFFFF00) | int64(c.counter&0xFF)
}

type Sequencer struct {
    roomSequences sync.Map // roomID -> *atomic.Int64
}

func (s *Sequencer) NextSequence(roomID string) int64 {
    seq, _ := s.roomSequences.LoadOrStore(roomID, &atomic.Int64{})
    return seq.(*atomic.Int64).Add(1)
}

func (o *MessageOrderer) AssignOrder(msg *Message) {
    // Use HLC for cross-server ordering
    msg.HLCTimestamp = o.clock.Now()

    // Use per-room sequence for total ordering within room
    msg.Sequence = o.sequencer.NextSequence(msg.RoomID)

    // Client-provided timestamp for display purposes
    if msg.ClientTimestamp == 0 {
        msg.ClientTimestamp = time.Now().UnixMilli()
    }
}

// Client-side: Sort by sequence, not timestamp
func sortMessages(messages []Message) {
    sort.Slice(messages, func(i, j int) bool {
        if messages[i].RoomID != messages[j].RoomID {
            return messages[i].RoomID < messages[j].RoomID
        }
        return messages[i].Sequence < messages[j].Sequence
    })
}
```

**Key Insight**: Use per-room sequence numbers for total ordering. HLC timestamps help with cross-server consistency. Never rely solely on wall clock time.

---

### Pitfall 2: The Presence State Drift

**Real Incident Report**: Users appeared "online" for hours after closing their browsers. The presence system didn't detect disconnections properly, leading to frustrating "message not delivered" errors.

**The Anti-Pattern**:
```go
// DANGEROUS: Only tracking connect/disconnect events
func (h *Hub) HandleConnect(userID string) {
    h.presence[userID] = true
}

func (h *Hub) HandleDisconnect(userID string) {
    delete(h.presence, userID) // What if this never fires?
}
```

**The Better Approach**:
```go
type PresenceManager struct {
    redis     *redis.Client
    heartbeat time.Duration
    timeout   time.Duration
}

type UserPresence struct {
    UserID     string
    Status     string // online, away, offline
    LastSeen   time.Time
    Device     string
    ServerID   string
}

func (p *PresenceManager) SetOnline(ctx context.Context, userID, serverID, device string) error {
    presence := UserPresence{
        UserID:   userID,
        Status:   "online",
        LastSeen: time.Now(),
        Device:   device,
        ServerID: serverID,
    }

    data, _ := json.Marshal(presence)

    // Set with TTL - auto-expires if heartbeat stops
    return p.redis.Set(ctx,
        fmt.Sprintf("presence:%s:%s", userID, device),
        data,
        p.timeout,
    ).Err()
}

func (p *PresenceManager) Heartbeat(ctx context.Context, userID, device string) error {
    key := fmt.Sprintf("presence:%s:%s", userID, device)

    // Refresh TTL
    return p.redis.Expire(ctx, key, p.timeout).Err()
}

func (p *PresenceManager) GetStatus(ctx context.Context, userID string) (string, error) {
    // Check all devices for this user
    pattern := fmt.Sprintf("presence:%s:*", userID)
    keys, err := p.redis.Keys(ctx, pattern).Result()
    if err != nil {
        return "offline", err
    }

    if len(keys) == 0 {
        return "offline", nil
    }

    // User is online if any device is online
    for _, key := range keys {
        data, err := p.redis.Get(ctx, key).Bytes()
        if err != nil {
            continue
        }

        var presence UserPresence
        json.Unmarshal(data, &presence)

        if presence.Status == "online" {
            return "online", nil
        }
    }

    return "away", nil
}

// Client-side heartbeat loop
func (c *ChatClient) heartbeatLoop(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := c.sendHeartbeat(); err != nil {
                log.Warn("Heartbeat failed", "error", err)
            }
        }
    }
}
```

**Key Insight**: Use TTL-based presence with heartbeats. Keys auto-expire if the client disconnects abnormally. Track per-device presence for multi-device users.

---

### Pitfall 3: The WebSocket Memory Leak

**Real Incident Report**: A chat server's memory grew continuously, eventually triggering OOM kills every few days. Investigation revealed that disconnected WebSocket connections weren't being cleaned up properly.

**The Anti-Pattern**:
```go
// DANGEROUS: No cleanup on disconnect
type Hub struct {
    clients map[*Client]bool
}

func (h *Hub) Register(client *Client) {
    h.clients[client] = true
    go client.ReadPump()
    go client.WritePump()
}

// If ReadPump/WritePump panic or connection dies without explicit close,
// the client is never removed from the map
```

**The Better Approach**:
```go
type Hub struct {
    clients    sync.Map // *Client -> struct{}
    register   chan *Client
    unregister chan *Client
}

type Client struct {
    hub        *Hub
    conn       *websocket.Conn
    send       chan []byte
    userID     string
    done       chan struct{}
    closeOnce  sync.Once
}

func (c *Client) Close() {
    c.closeOnce.Do(func() {
        close(c.done)
        c.conn.Close()
        c.hub.unregister <- c
    })
}

func (c *Client) ReadPump() {
    defer c.Close() // Always cleanup on exit

    c.conn.SetReadLimit(maxMessageSize)
    c.conn.SetReadDeadline(time.Now().Add(pongWait))
    c.conn.SetPongHandler(func(string) error {
        c.conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    for {
        _, message, err := c.conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                log.Warn("WebSocket error", "error", err)
            }
            return // Triggers deferred Close()
        }
        c.hub.broadcast <- message
    }
}

func (c *Client) WritePump() {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        c.Close() // Always cleanup on exit
    }()

    for {
        select {
        case <-c.done:
            return
        case message, ok := <-c.send:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if !ok {
                c.conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
                return
            }
        case <-ticker.C:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }
}

func (h *Hub) Run() {
    // Periodic cleanup of stale connections
    cleanupTicker := time.NewTicker(time.Minute)

    for {
        select {
        case client := <-h.register:
            h.clients.Store(client, struct{}{})
        case client := <-h.unregister:
            h.clients.Delete(client)
            close(client.send)
        case <-cleanupTicker.C:
            h.cleanupStaleConnections()
        }
    }
}

func (h *Hub) cleanupStaleConnections() {
    h.clients.Range(func(key, _ any) bool {
        client := key.(*Client)

        // Check if connection is still alive
        client.conn.SetWriteDeadline(time.Now().Add(time.Second))
        if err := client.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
            log.Info("Cleaning up stale connection", "userID", client.userID)
            client.Close()
        }

        return true
    })
}
```

**Key Insight**: Use `sync.Once` for cleanup, ensure deferred cleanup in all goroutines, and implement periodic connection health checks.

---

### Pitfall 4: The Broadcast Backpressure Bomb

**Real Incident Report**: When a popular group received rapid messages, the server tried to broadcast to thousands of slow clients. The send buffer filled up, blocking the entire broadcast loop and affecting all rooms.

**The Anti-Pattern**:
```go
// DANGEROUS: Blocking broadcast
func (h *Hub) Broadcast(message []byte) {
    for client := range h.clients {
        client.send <- message // Blocks if client is slow!
    }
}
```

**The Better Approach**:
```go
type Hub struct {
    clients     sync.Map
    broadcast   chan *BroadcastMessage
    roomClients map[string]map[*Client]struct{}
    mu          sync.RWMutex
}

type BroadcastMessage struct {
    RoomID  string
    Data    []byte
    Exclude *Client
}

func (h *Hub) Broadcast(msg *BroadcastMessage) {
    h.mu.RLock()
    clients := h.roomClients[msg.RoomID]
    h.mu.RUnlock()

    // Use worker pool for parallel sends
    var wg sync.WaitGroup
    semaphore := make(chan struct{}, 100) // Limit concurrent sends

    for client := range clients {
        if client == msg.Exclude {
            continue
        }

        wg.Add(1)
        semaphore <- struct{}{}

        go func(c *Client) {
            defer func() {
                <-semaphore
                wg.Done()
            }()

            // Non-blocking send with timeout
            select {
            case c.send <- msg.Data:
                // Sent successfully
            case <-time.After(100 * time.Millisecond):
                // Client too slow, mark for disconnection
                log.Warn("Client send timeout", "userID", c.userID)
                c.slowCount++
                if c.slowCount > 5 {
                    c.Close()
                }
            }
        }(client)
    }

    wg.Wait()
}

// Alternative: Per-client buffering with overflow handling
type Client struct {
    send       chan []byte
    overflow   *ring.Buffer // Ring buffer for overflow
    dropCount  atomic.Int64
}

func (c *Client) Send(data []byte) {
    select {
    case c.send <- data:
        return
    default:
        // Channel full, try overflow
        if !c.overflow.Write(data) {
            c.dropCount.Add(1)
            // Log dropped message for monitoring
        }
    }
}
```

**Key Insight**: Never block on slow clients. Use non-blocking sends with timeouts, overflow buffers, and disconnect chronically slow clients.

---

### Pitfall 5: The Message Delivery Guarantee Gap

**Real Incident Report**: Users reported missing messages during brief network interruptions. The app showed "delivered" but messages were actually lost when the WebSocket reconnected.

**The Anti-Pattern**:
```go
// DANGEROUS: Fire and forget
func (c *Client) SendMessage(msg *Message) error {
    return c.conn.WriteJSON(msg) // What if connection drops mid-send?
}
```

**The Better Approach**:
```go
type ReliableMessaging struct {
    pendingAcks sync.Map // messageID -> *PendingMessage
    ackTimeout  time.Duration
    maxRetries  int
}

type PendingMessage struct {
    Message   *Message
    SentAt    time.Time
    Retries   int
    AckChan   chan struct{}
}

func (r *ReliableMessaging) SendWithAck(ctx context.Context, client *Client, msg *Message) error {
    msg.ID = uuid.New().String()
    msg.RequiresAck = true

    pending := &PendingMessage{
        Message: msg,
        SentAt:  time.Now(),
        AckChan: make(chan struct{}),
    }

    r.pendingAcks.Store(msg.ID, pending)
    defer r.pendingAcks.Delete(msg.ID)

    for pending.Retries < r.maxRetries {
        if err := client.conn.WriteJSON(msg); err != nil {
            return err
        }

        select {
        case <-pending.AckChan:
            return nil // Acknowledged!
        case <-time.After(r.ackTimeout):
            pending.Retries++
            log.Warn("Message ack timeout, retrying",
                "messageID", msg.ID,
                "retry", pending.Retries)
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    return ErrMaxRetriesExceeded
}

func (r *ReliableMessaging) HandleAck(messageID string) {
    if pending, ok := r.pendingAcks.Load(messageID); ok {
        close(pending.(*PendingMessage).AckChan)
    }
}

// Client-side message recovery
type ClientMessageTracker struct {
    lastReceivedSeq int64
    pending         map[int64]*Message
    mu              sync.Mutex
}

func (t *ClientMessageTracker) OnMessage(msg *Message) bool {
    t.mu.Lock()
    defer t.mu.Unlock()

    // Check for gaps
    if msg.Sequence > t.lastReceivedSeq+1 {
        // Request missing messages
        t.requestMissing(t.lastReceivedSeq+1, msg.Sequence-1)
    }

    if msg.Sequence <= t.lastReceivedSeq {
        // Duplicate, ignore
        return false
    }

    t.lastReceivedSeq = msg.Sequence
    return true
}

func (t *ClientMessageTracker) OnReconnect(lastSeq int64) {
    // Request all messages since last known sequence
    t.requestSync(lastSeq)
}
```

**Key Insight**: Implement message acknowledgment, track sequence numbers, and sync on reconnection. Use at-least-once delivery with client-side deduplication.

---

### Quick Reference: Chat Application Pitfalls

| Pitfall | Impact | Prevention |
|---------|--------|------------|
| Message ordering issues | Confused conversations | Per-room sequences, HLC |
| Presence state drift | Ghost "online" users | TTL-based with heartbeat |
| WebSocket memory leaks | OOM crashes | sync.Once cleanup, periodic health checks |
| Broadcast backpressure | Global slowdown | Non-blocking sends, timeouts |
| Lost messages | Missing conversation context | Acks, sequences, reconnect sync |

---

### Junior → FAANG: Pitfalls as Interview Proof Points

The five pitfalls in this chapter are standard interview probe areas for real-time systems roles. If you have experienced and fixed any of them in your own implementation, that experience is more valuable in an interview than memorized theory.

The message ordering pitfall is the most commonly asked. Know that client-assigned timestamps cannot be trusted (clocks differ between clients, and users can set incorrect system clocks deliberately). Server-assigned sequence numbers (generated by the server at message receipt time) are the reliable ordering primitive. Each channel has a monotonically increasing sequence counter, and the server assigns the sequence number as part of message acceptance.

The broadcast backpressure pitfall is the most impactful. One slow consumer (a client with a slow connection or an overloaded device) causing the entire Hub to slow down is a classic resource starvation bug. The fix (non-blocking channel sends with a timeout) is a specific Go pattern worth knowing by name and being able to implement from memory.

### Senior @ FAANG: Pitfall Analysis as an Incident Pattern Library

At senior level, each pitfall represents a class of incidents with a common root cause, a detection mechanism, and a mitigation pattern. Building a library of these patterns across multiple systems is how experienced engineers develop rapid incident diagnosis skills.

The message ordering problem generalizes to any system where events from multiple sources must be ordered consistently. The solution (server-assigned monotonic sequence with Lamport timestamps or vector clocks for causal ordering) applies to distributed databases, event sourcing systems, and collaborative editing engines. Knowing the generalized form of the solution makes it transferable.

The connection leak pitfall (goroutines not cleaned up when connections close) is detectable via pprof goroutine profiling. Establishing a baseline goroutine count at idle (roughly 2 goroutines per active connection plus overhead) and alerting when the actual count exceeds the expected count for the current connection count is a proactive detection mechanism. Production systems should have this alert configured and validated before launch.

Postmortem analysis for chat system incidents frequently reveals that the actual failure mode was different from what the monitoring revealed. A "high latency" alert may be caused by broadcast backpressure (a slow consumer blocking the Hub), but the symptom shows up as overall message delivery latency increasing. Tracing the causal chain from symptom (high latency) to root cause (specific slow consumer) to systemic fix (non-blocking sends) is the pattern of effective incident analysis.

---
