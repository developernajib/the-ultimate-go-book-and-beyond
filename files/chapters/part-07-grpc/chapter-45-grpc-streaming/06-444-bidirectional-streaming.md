## 45.4 Bidirectional Streaming

### Proto Definition

Bidirectional streaming places the `stream` keyword on both the request and response types. Both sides can send messages independently. Neither needs to wait for the other. The `Chat` RPC below accepts and returns streams of `ChatMessage`, while the `Sync` RPC uses different message types for each direction to model a client pushing deltas and the server responding with resolved state.

```protobuf
// Chat service
message ChatMessage {
    string id = 1;
    string room_id = 2;
    string user_id = 3;
    string content = 4;
    google.protobuf.Timestamp timestamp = 5;
    MessageType type = 6;
}

enum MessageType {
    MESSAGE_TYPE_UNSPECIFIED = 0;
    MESSAGE_TYPE_TEXT = 1;
    MESSAGE_TYPE_JOIN = 2;
    MESSAGE_TYPE_LEAVE = 3;
    MESSAGE_TYPE_TYPING = 4;
}

// Sync service
message SyncRequest {
    string resource_type = 1;
    string resource_id = 2;
    int64 version = 3;
    bytes delta = 4;
}

message SyncResponse {
    string resource_id = 1;
    int64 version = 2;
    bytes state = 3;
    bool conflict = 4;
}

service StreamService {
    // Bidirectional - chat
    rpc Chat(stream ChatMessage) returns (stream ChatMessage);

    // Bidirectional - real-time sync
    rpc Sync(stream SyncRequest) returns (stream SyncResponse);
}
```

### Server Implementation

A bidirectional streaming handler must read and write concurrently. The `Chat` handler below spawns a goroutine for the receive loop and processes incoming messages on the main goroutine via a channel. Users join and leave rooms, and the `ChatManager` tracks which streams belong to which rooms so broadcasts reach the right recipients. The `Broadcast` method sends to each client in a separate goroutine to avoid blocking on a slow receiver.

```go
package server

import (
    "io"
    "sync"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    streamv1 "github.com/myapp/gen/stream/v1"
)

// Chat implements bidirectional streaming chat
func (s *StreamServer) Chat(stream streamv1.StreamService_ChatServer) error {
    ctx := stream.Context()

    // Get user from context (set by auth interceptor)
    user := GetUser(ctx)
    if user == nil {
        return status.Error(codes.Unauthenticated, "authentication required")
    }

    // Track user's room
    var currentRoom string
    var roomMu sync.Mutex

    // Handle incoming messages in goroutine
    errChan := make(chan error, 1)
    msgChan := make(chan *streamv1.ChatMessage, 10)

    go func() {
        for {
            msg, err := stream.Recv()
            if err == io.EOF {
                close(msgChan)
                return
            }
            if err != nil {
                errChan <- err
                return
            }
            msgChan <- msg
        }
    }()

    // Process messages and subscribe to room updates
    for {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()

        case err := <-errChan:
            return status.Errorf(codes.Internal, "receive error: %v", err)

        case msg, ok := <-msgChan:
            if !ok {
                // Client closed stream
                return nil
            }

            // Handle message
            switch msg.GetType() {
            case streamv1.MessageType_MESSAGE_TYPE_JOIN:
                roomMu.Lock()
                if currentRoom != "" {
                    s.chatManager.LeaveRoom(currentRoom, user.ID)
                }
                currentRoom = msg.GetRoomId()
                s.chatManager.JoinRoom(currentRoom, user.ID, stream)
                roomMu.Unlock()

                // Broadcast join message
                s.chatManager.Broadcast(currentRoom, &streamv1.ChatMessage{
                    Id:        generateID(),
                    RoomId:    currentRoom,
                    UserId:    user.ID,
                    Content:   user.Name + " joined the room",
                    Type:      streamv1.MessageType_MESSAGE_TYPE_JOIN,
                    Timestamp: timestamppb.Now(),
                })

            case streamv1.MessageType_MESSAGE_TYPE_LEAVE:
                roomMu.Lock()
                if currentRoom != "" {
                    s.chatManager.LeaveRoom(currentRoom, user.ID)
                    currentRoom = ""
                }
                roomMu.Unlock()

            case streamv1.MessageType_MESSAGE_TYPE_TEXT:
                roomMu.Lock()
                room := currentRoom
                roomMu.Unlock()

                if room == "" {
                    continue
                }

                // Broadcast message to room
                s.chatManager.Broadcast(room, &streamv1.ChatMessage{
                    Id:        generateID(),
                    RoomId:    room,
                    UserId:    user.ID,
                    Content:   msg.GetContent(),
                    Type:      streamv1.MessageType_MESSAGE_TYPE_TEXT,
                    Timestamp: timestamppb.Now(),
                })

            case streamv1.MessageType_MESSAGE_TYPE_TYPING:
                roomMu.Lock()
                room := currentRoom
                roomMu.Unlock()

                if room != "" {
                    // Broadcast typing indicator (except to sender)
                    s.chatManager.BroadcastExcept(room, user.ID, msg)
                }
            }
        }
    }
}

// ChatManager manages chat rooms
type ChatManager struct {
    mu    sync.RWMutex
    rooms map[string]*ChatRoom
}

type ChatRoom struct {
    mu      sync.RWMutex
    clients map[string]streamv1.StreamService_ChatServer
}

func (m *ChatManager) JoinRoom(roomID, userID string, stream streamv1.StreamService_ChatServer) {
    m.mu.Lock()
    room, ok := m.rooms[roomID]
    if !ok {
        room = &ChatRoom{
            clients: make(map[string]streamv1.StreamService_ChatServer),
        }
        m.rooms[roomID] = room
    }
    m.mu.Unlock()

    room.mu.Lock()
    room.clients[userID] = stream
    room.mu.Unlock()
}

func (m *ChatManager) LeaveRoom(roomID, userID string) {
    m.mu.RLock()
    room, ok := m.rooms[roomID]
    m.mu.RUnlock()

    if !ok {
        return
    }

    room.mu.Lock()
    delete(room.clients, userID)
    room.mu.Unlock()
}

func (m *ChatManager) Broadcast(roomID string, msg *streamv1.ChatMessage) {
    m.mu.RLock()
    room, ok := m.rooms[roomID]
    m.mu.RUnlock()

    if !ok {
        return
    }

    room.mu.RLock()
    defer room.mu.RUnlock()

    for _, stream := range room.clients {
        // Non-blocking send
        go stream.Send(msg)
    }
}

func (m *ChatManager) BroadcastExcept(roomID, excludeUserID string, msg *streamv1.ChatMessage) {
    m.mu.RLock()
    room, ok := m.rooms[roomID]
    m.mu.RUnlock()

    if !ok {
        return
    }

    room.mu.RLock()
    defer room.mu.RUnlock()

    for userID, stream := range room.clients {
        if userID != excludeUserID {
            go stream.Send(msg)
        }
    }
}
```

### Client Implementation

The bidirectional streaming client spawns two goroutines: a sender that reads from a local channel and calls `Send`, and a receiver that calls `Recv` in a loop and dispatches messages to the application. A `sync.WaitGroup` synchronizes their shutdown, and the sender calls `CloseSend` after draining its input channel to signal end-of-stream to the server.

```go
package client

import (
    "context"
    "io"
    "sync"

    streamv1 "github.com/myapp/gen/stream/v1"
)

// ChatClient handles bidirectional chat
type ChatClient struct {
    stream    streamv1.StreamService_ChatClient
    mu        sync.Mutex
    handlers  []func(*streamv1.ChatMessage)
    done      chan struct{}
}

func (c *StreamClient) NewChatClient(ctx context.Context) (*ChatClient, error) {
    stream, err := c.client.Chat(ctx)
    if err != nil {
        return nil, err
    }

    client := &ChatClient{
        stream: stream,
        done:   make(chan struct{}),
    }

    // Start receiving messages
    go client.receiveLoop()

    return client, nil
}

func (cc *ChatClient) receiveLoop() {
    defer close(cc.done)

    for {
        msg, err := cc.stream.Recv()
        if err == io.EOF {
            return
        }
        if err != nil {
            return
        }

        cc.mu.Lock()
        handlers := cc.handlers
        cc.mu.Unlock()

        for _, handler := range handlers {
            go handler(msg)
        }
    }
}

// OnMessage registers a message handler
func (cc *ChatClient) OnMessage(handler func(*streamv1.ChatMessage)) {
    cc.mu.Lock()
    cc.handlers = append(cc.handlers, handler)
    cc.mu.Unlock()
}

// JoinRoom joins a chat room
func (cc *ChatClient) JoinRoom(roomID string) error {
    return cc.stream.Send(&streamv1.ChatMessage{
        RoomId: roomID,
        Type:   streamv1.MessageType_MESSAGE_TYPE_JOIN,
    })
}

// LeaveRoom leaves current chat room
func (cc *ChatClient) LeaveRoom() error {
    return cc.stream.Send(&streamv1.ChatMessage{
        Type: streamv1.MessageType_MESSAGE_TYPE_LEAVE,
    })
}

// SendMessage sends a text message
func (cc *ChatClient) SendMessage(content string) error {
    return cc.stream.Send(&streamv1.ChatMessage{
        Content: content,
        Type:    streamv1.MessageType_MESSAGE_TYPE_TEXT,
    })
}

// SendTyping sends typing indicator
func (cc *ChatClient) SendTyping() error {
    return cc.stream.Send(&streamv1.ChatMessage{
        Type: streamv1.MessageType_MESSAGE_TYPE_TYPING,
    })
}

// Close closes the chat stream
func (cc *ChatClient) Close() error {
    err := cc.stream.CloseSend()
    <-cc.done
    return err
}

// Done returns a channel that's closed when the stream ends
func (cc *ChatClient) Done() <-chan struct{} {
    return cc.done
}
```

### Junior -> FAANG: Bidirectional Streaming First-Job Habits

Bidirectional streaming is the most complex pattern because both sides are simultaneously sender and receiver. Two bugs are almost guaranteed in a first implementation.

**The blocking-send deadlock.** The most common mistake: calling `stream.Recv()` and `stream.Send()` sequentially in the same goroutine. If the server is waiting for the client to send before it sends back, and the client is waiting for the server to send before it sends next, both sides block indefinitely. The fix is always the same: separate goroutines for send and receive, communicating via channels. The `ChatClient.receiveLoop` goroutine in this section demonstrates the pattern on the client side. The server's `Chat` handler demonstrates it on the server side.

**Not closing the send side.** When the client is done sending messages, it must call `stream.CloseSend()`. Without this, the server's `Recv` loop keeps waiting for more messages and never gets `io.EOF`. The server handler blocks forever, holding the stream open and wasting a goroutine. In the `ChatClient.Close()` method above, `stream.CloseSend()` is called and then `<-cc.done` waits for the receive loop to drain. This two-step shutdown is the correct pattern.

For interviews, be ready to draw the goroutine diagram for a bidirectional stream: two goroutines on the client (one calling `Send`, one calling `Recv`), two on the server (same), and the channels connecting them to the application logic. Interviewers look for awareness of the shutdown ordering: the send goroutine closes after its input channel drains, the receive goroutine closes after `io.EOF` or error, and the handler returns only after both goroutines signal completion.

### Senior @ FAANG: Bidirectional Streaming Production Concerns

**Head-of-line blocking within a stream.** A bidirectional stream's messages are delivered in order within each direction. If one large message is being serialized and sent, smaller higher-priority messages in the same direction are blocked behind it. For latency-sensitive protocols (gaming, real-time control), design the message schema so that large payloads (game state snapshots) and small control messages (input commands) use separate streams or separate fields with different priorities. Consider multiplexing multiple logical channels over a single bidirectional stream using a `channel_id` field, and process lower-latency channels first in the dispatch logic.

**Fan-out correctness and thread safety.** The naive `ChatManager.Broadcast` method above spawns a goroutine per client to call `stream.Send`. While this prevents a slow client from blocking the caller, it creates two severe production defects: (1) `stream.Send` is **not thread-safe** in grpc-go - invoking `Send` concurrently from multiple goroutines on the same stream corrupts frames and triggers runtime panics; and (2) concurrent goroutines can deliver messages out of order. Protect against this by serializing sends per-client: each client has a dedicated send goroutine and a bounded channel (`chan *streamv1.ChatMessage`), and the broadcast loop enqueues into that channel. The client's send loop drains the channel sequentially, guaranteeing both thread safety and FIFO delivery per client.

**Memory accounting for chat rooms.** The `ChatManager` keeps `map[string]stream` per room in memory. Each open stream holds a goroutine, a flow control budget, and pending message buffers. A viral room with 100,000 concurrent users holds 100,000 goroutines on that server. This is not sustainable on a single process. The production architecture shards rooms across multiple gateway servers using consistent hashing on room ID, with a pub/sub bus (Redis, Kafka) for cross-shard message delivery. The `ChatManager` becomes a local shard manager. Staff engineers design the sharding scheme, the cross-shard delivery guarantees, and the rebalancing protocol when a gateway server is added or removed.

**Observability for bidirectional streams.** Standard gRPC metrics (request count, error count, duration) are insufficient for bidirectional streams. Add per-stream message counters (messages sent, messages received), per-stream byte counters, and per-room active user count. Track the send queue depth per client to detect slow consumers before they trigger backpressure or disconnection. Alert when the 95th percentile send queue depth exceeds 50% of capacity. This gives operations visibility into approaching capacity limits before users experience degradation.

---
