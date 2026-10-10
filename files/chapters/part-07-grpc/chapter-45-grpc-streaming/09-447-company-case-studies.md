## 45.7 Company Case Studies

### How Google Cloud Uses Streaming

Google Cloud services use all three streaming patterns. Cloud Pub/Sub's `StreamingPull` is a bidirectional stream where the server delivers messages and the client sends acknowledgment IDs back. Cloud Speech-to-Text uses client streaming for audio input and server streaming for transcription results, sometimes both simultaneously for real-time interim transcriptions. The patterns below show how these services structure their stream handlers.

```go
package google

/*
GOOGLE CLOUD STREAMING PATTERNS

1. Cloud Pub/Sub:
   - Server streaming for message delivery
   - Client streaming for publishing batches
   - Bidirectional for stream pull

2. Cloud Speech-to-Text:
   - Client streaming: Send audio chunks
   - Server streaming: Receive transcription
   - Real-time transcription with interim results

3. Cloud Spanner:
   - Server streaming for large query results
   - Automatic pagination and flow control

4. Firebase Realtime Database:
   - Server streaming for data sync
   - Bidirectional for real-time updates
*/

// Google Cloud Pub/Sub style streaming pull
type PubSubStreamingPull struct {
    subscription string
    ackDeadline  time.Duration
}

func (s *PubSubStreamingPull) StreamingPull(stream pb.Subscriber_StreamingPullServer) error {
    ctx := stream.Context()

    // Receive initial request with subscription
    req, err := stream.Recv()
    if err != nil {
        return status.Error(codes.InvalidArgument, "expected initial request")
    }

    subscription := req.GetSubscription()
    if subscription == "" {
        return status.Error(codes.InvalidArgument, "subscription required")
    }

    // Start message delivery
    messages := s.subscribeToMessages(ctx, subscription)
    pendingAcks := make(map[string]time.Time)
    ackChan := make(chan string, 1000)

    // Receive acks from client
    go func() {
        for {
            req, err := stream.Recv()
            if err != nil {
                return
            }
            for _, ackID := range req.GetAckIds() {
                ackChan <- ackID
            }
        }
    }()

    // Send messages to client
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil

        case ackID := <-ackChan:
            delete(pendingAcks, ackID)

        case msg := <-messages:
            ackID := generateAckID()
            pendingAcks[ackID] = time.Now()

            if err := stream.Send(&pb.StreamingPullResponse{
                ReceivedMessages: []*pb.ReceivedMessage{{
                    AckId:   ackID,
                    Message: msg,
                }},
            }); err != nil {
                return err
            }

        case <-ticker.C:
            // Re-deliver unacked messages past deadline
            now := time.Now()
            for ackID, sentAt := range pendingAcks {
                if now.Sub(sentAt) > s.ackDeadline {
                    // Re-deliver
                    delete(pendingAcks, ackID)
                }
            }
        }
    }
}

// Google Cloud Speech streaming recognition
func (s *SpeechServer) StreamingRecognize(stream pb.Speech_StreamingRecognizeServer) error {
    ctx := stream.Context()

    // Receive config
    req, err := stream.Recv()
    if err != nil {
        return err
    }

    config := req.GetStreamingConfig()
    if config == nil {
        return status.Error(codes.InvalidArgument, "config required in first message")
    }

    // Process audio chunks
    recognizer := s.createRecognizer(config)
    defer recognizer.Close()

    // Start recognition goroutine
    results := make(chan *pb.StreamingRecognizeResponse, 10)
    go func() {
        defer close(results)
        for result := range recognizer.Results() {
            results <- result
        }
    }()

    // Receive and send concurrently
    errChan := make(chan error, 1)

    go func() {
        for {
            req, err := stream.Recv()
            if err == io.EOF {
                recognizer.CloseInput()
                return
            }
            if err != nil {
                errChan <- err
                return
            }

            if audio := req.GetAudioContent(); len(audio) > 0 {
                recognizer.WriteAudio(audio)
            }
        }
    }()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case err := <-errChan:
            return err
        case result, ok := <-results:
            if !ok {
                return nil
            }
            if err := stream.Send(result); err != nil {
                return err
            }
        }
    }
}
```

### Streaming Chat at Twitch Scale

A chat system like Twitch's handles millions of concurrent viewers on a popular stream. The key optimization at that fan-out is message batching: rather than sending each chat message as an individual gRPC `Send`, the server accumulates messages over a short window (tens of milliseconds) and sends them in a single batch. This reduces per-message overhead and allows the server to detect slow consumers early. If a client can't drain a batched send within 100ms, it gets disconnected rather than accumulating an unbounded backlog.

```go
package twitch

/*
TWITCH STREAMING PATTERNS

1. Chat:
   - Bidirectional streaming for messages
   - Server streaming for room events
   - Handle millions of concurrent viewers

2. Extensions:
   - Server streaming for game state
   - Bidirectional for interactive overlays

3. Low Latency:
   - HTTP/2 multiplexing
   - Message batching for efficiency
*/

// Twitch-style chat room streaming
type ChatRoom struct {
    id        string
    clients   sync.Map // userID -> stream
    messages  chan *pb.ChatMessage
    maxBuffer int
}

func (r *ChatRoom) Join(userID string, stream pb.Chat_StreamServer) {
    r.clients.Store(userID, stream)

    // Send recent messages (catch-up)
    for _, msg := range r.getRecentMessages(100) {
        stream.Send(msg)
    }
}

func (r *ChatRoom) Leave(userID string) {
    r.clients.Delete(userID)
}

func (r *ChatRoom) Broadcast(msg *pb.ChatMessage) {
    // Non-blocking send to buffer
    select {
    case r.messages <- msg:
    default:
        // Buffer full - drop oldest
    }
}

func (r *ChatRoom) BroadcastLoop() {
    batch := make([]*pb.ChatMessage, 0, 10)
    ticker := time.NewTicker(50 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case msg := <-r.messages:
            batch = append(batch, msg)

            // Batch up to 10 messages or 50ms
            if len(batch) >= 10 {
                r.sendBatch(batch)
                batch = batch[:0]
            }

        case <-ticker.C:
            if len(batch) > 0 {
                r.sendBatch(batch)
                batch = batch[:0]
            }
        }
    }
}

func (r *ChatRoom) sendBatch(batch []*pb.ChatMessage) {
    msg := &pb.ChatBatch{Messages: batch}

    r.clients.Range(func(key, value any) bool {
        stream := value.(pb.Chat_StreamServer)

        // Non-blocking send with timeout
        done := make(chan error, 1)
        go func() {
            done <- stream.Send(msg)
        }()

        select {
        case err := <-done:
            if err != nil {
                // Client slow/disconnected - remove
                r.clients.Delete(key)
            }
        case <-time.After(100 * time.Millisecond):
            // Timeout - client too slow
            r.clients.Delete(key)
        }

        return true
    })
}
```

### The Discord Gateway Pattern: Event Streams with Heartbeats

Discord's public gateway protocol (WebSocket in their implementation, but the pattern maps one-to-one onto a gRPC server stream) pairs an event stream with an application-level heartbeat mechanism. After the client sends an `IDENTIFY` message, the server responds with a `READY` payload containing session state, then continuously streams guild events (messages, presence updates, typing indicators). The client must send periodic heartbeat messages. If the server doesn't receive one within the configured interval, it closes the stream. This pattern detects dead connections faster than relying solely on TCP keepalives, which matters when clients are on mobile networks with unreliable connectivity.

```go
package discord

/*
DISCORD STREAMING PATTERNS

1. Gateway:
   - Server streaming for events
   - Heartbeat mechanism
   - Resume/reconnect support

2. Voice:
   - Bidirectional for audio
   - Custom UDP for actual voice data
   - gRPC for signaling

3. Scaling:
   - Sharding across gateway servers
   - Event deduplication
   - Sequence numbers for ordering
*/

// Discord-style gateway events
type GatewayServer struct {
    sessions sync.Map // sessionID -> *Session
}

type Session struct {
    userID      string
    sessionID   string
    stream      pb.Gateway_ConnectServer
    sequence    int64
    heartbeat   time.Duration
    lastBeat    time.Time
    guilds      []string
    done        chan struct{}
}

func (g *GatewayServer) Connect(stream pb.Gateway_ConnectServer) error {
    ctx := stream.Context()

    // Wait for IDENTIFY
    msg, err := stream.Recv()
    if err != nil {
        return err
    }

    identify := msg.GetIdentify()
    if identify == nil {
        return status.Error(codes.InvalidArgument, "expected IDENTIFY")
    }

    // Validate token
    user, err := g.validateToken(identify.GetToken())
    if err != nil {
        return status.Error(codes.Unauthenticated, "invalid token")
    }

    // Create session
    session := &Session{
        userID:    user.ID,
        sessionID: generateSessionID(),
        stream:    stream,
        heartbeat: 45 * time.Second,
        lastBeat:  time.Now(),
        guilds:    user.GuildIDs,
        done:      make(chan struct{}),
    }

    g.sessions.Store(session.sessionID, session)
    defer g.sessions.Delete(session.sessionID)
    defer close(session.done)

    // Send READY
    if err := stream.Send(&pb.GatewayEvent{
        Event: &pb.GatewayEvent_Ready{
            Ready: &pb.Ready{
                SessionId:         session.sessionID,
                HeartbeatInterval: int64(session.heartbeat.Milliseconds()),
                User:              toProtoUser(user),
                Guilds:            toProtoGuilds(session.guilds),
            },
        },
    }); err != nil {
        return err
    }

    // Start event delivery
    events := g.subscribeToEvents(ctx, session.guilds)
    heartbeatTimeout := time.NewTimer(session.heartbeat + 10*time.Second)
    defer heartbeatTimeout.Stop()

    // Receive client messages (heartbeats) in a background goroutine
    clientMsgChan := make(chan *pb.GatewayMessage, 10)
    errChan := make(chan error, 1)

    go func() {
        for {
            msg, err := stream.Recv()
            if err == io.EOF {
                return
            }
            if err != nil {
                errChan <- err
                return
            }
            clientMsgChan <- msg
        }
    }()

    for {
        select {
        case <-ctx.Done():
            return nil

        case err := <-errChan:
            return err

        case <-heartbeatTimeout.C:
            // Client didn't heartbeat in time
            return status.Error(codes.DeadlineExceeded, "heartbeat timeout")

        case event := <-events:
            session.sequence++
            event.Sequence = session.sequence

            if err := stream.Send(event); err != nil {
                return err
            }

        case msg := <-clientMsgChan:
            // Handle client message
            switch msg.Event.(type) {
            case *pb.GatewayMessage_Heartbeat:
                session.lastBeat = time.Now()
                if !heartbeatTimeout.Stop() {
                    select {
                    case <-heartbeatTimeout.C:
                    default:
                    }
                }
                heartbeatTimeout.Reset(session.heartbeat + 10*time.Second)

                if err := stream.Send(&pb.GatewayEvent{
                    Event: &pb.GatewayEvent_HeartbeatAck{
                        HeartbeatAck: &pb.HeartbeatAck{},
                    },
                }); err != nil {
                    return err
                }
            }
        }
    }
}
```

### Junior -> FAANG: Extracting Patterns from Case Studies

Each case study encodes a reusable pattern. Extracting the abstract pattern from the concrete example is the skill interviewers are testing.

**Pub/Sub `StreamingPull` teaches ack-based flow control.** The server sends messages and tracks pending ack IDs. The client sends acks back through the same bidirectional stream. This is the pull model: the server continues delivering messages up to the unacked limit (the "max outstanding messages" setting). If the client is slow to ack, the server stops delivering. This pattern is applicable to any at-least-once delivery system over gRPC bidirectional streaming. The abstract lesson: use the reverse direction of a bidirectional stream for control signals (acks, nacks, flow control tokens) when you need application-level delivery guarantees beyond what HTTP/2 provides.

**Speech-to-Text teaches the config-first protocol.** The first message on the stream is always a configuration message. Subsequent messages are data. This is a common pattern for streaming RPCs where the server needs parameters before it can start processing. The alternative is to include config in a metadata header, but headers have size limits and are less typed than proto messages. For streaming RPCs with rich configuration (codec settings, language hints, feature flags), the config-first message pattern is cleaner. The abstract lesson: design the first message of a stream as a protocol header, not just another data message.

**Discord gateway teaches application-level heartbeats.** Transport keepalives detect dead connections at the TCP level. Application heartbeats detect hung connections at the application level: a connection where TCP is alive but the server is not processing (CPU-bound, garbage collecting, deadlocked). The abstract lesson: for long-lived streams where liveness detection matters, implement a heartbeat protocol at the application layer with an explicit timeout, separate from TCP keepalives.

### Senior @ FAANG: Architectural Lessons from Case Studies

**Google Pub/Sub: the ack-deadline re-delivery problem.** The `StreamingPull` implementation above tracks `pendingAcks` in memory and re-delivers messages past `ackDeadline`. This is correct at the logic level but has a subtle production failure mode: if the server process restarts, the in-memory `pendingAcks` map is lost. Unacked messages that were delivered but not acknowledged by the client are re-delivered by the next server instance only if the message broker (Pub/Sub itself) has retained them. The streaming server is a delivery proxy, not the source of truth. Design streaming servers with the assumption that their state can be lost at any time. Push durable state to a persistent store (Bigtable, Spanner) and treat the in-memory state as a cache of what the broker guarantees.

**Twitch batching: the batch-or-drop policy as an SLA.** The Twitch `sendBatch` function drops a client if `stream.Send` does not complete within 100ms. This is an explicit SLA: Twitch values liveness of the broadcast loop over individual slow client delivery. The decision to drop slow clients rather than buffer for them is an architectural policy, not a default. For a financial data feed, the policy might be the opposite: buffer for 5 seconds before disconnecting, and log every dropped message for audit. The policy must be documented in the service's SLA, communicated to client developers, and enforced consistently. Undocumented drop policies produce support tickets.

**Discord gateway: session resumption as a first-class feature.** The gateway assigns a `sessionID` and a `sequence` number to each connected client. When a client reconnects (after a network blip, a server restart, or a `GOAWAY`), it presents its `sessionID` and last `sequence` to the new server. The server replays missed events from the sequence buffer. This is not a trivial feature to add after the fact. Session state (the sequence buffer, the mapping from `sessionID` to guild subscriptions) must be stored in a shared layer (Redis, Memcached) accessible to all gateway servers. Designing session resumption into the protocol from day one avoids a painful retrofit when the system reaches the scale where reconnect storms become a real operational problem.

**Cross-case: the observability gap in all three systems.** None of the three case study implementations above include metrics instrumentation. In production, each would need: a counter for messages delivered, a counter for messages dropped or re-delivered, a histogram for per-message send latency, a gauge for active stream count, and an alert for streams with unusually high ack latency (Pub/Sub), slow consumer disconnection rate (Twitch), or heartbeat timeout rate (Discord). Adding this instrumentation after the fact requires understanding all the state machines deeply. Write the metrics instrumentation at the same time as the handler, not as a follow-up task.

---
