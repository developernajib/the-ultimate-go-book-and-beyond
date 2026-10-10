## Exercises with Complete Solutions

### Exercise 1: Build a Complete Chat Application with WebSocket

This exercise combines the chapter's patterns (WebSocket hub, authentication, per-room broadcasting, and message persistence) into a working chat application. The solution uses a central hub goroutine for connection lifecycle management, database-backed message history, and presence tracking. You can extend it with typing indicators, read receipts, or file attachments.

```go
// Complete chat application with rooms, presence, and message history
package main

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "github.com/gorilla/websocket"
    _ "github.com/lib/pq"
)

// Message types
const (
    MsgTypeChat       = "chat"
    MsgTypeJoin       = "join"
    MsgTypeLeave      = "leave"
    MsgTypeTyping     = "typing"
    MsgTypePresence   = "presence"
    MsgTypeHistory    = "history"
    MsgTypeError      = "error"
)

// Message represents a chat message
type Message struct {
    ID        string    `json:"id"`
    Type      string    `json:"type"`
    RoomID    string    `json:"room_id"`
    UserID    string    `json:"user_id"`
    Username  string    `json:"username"`
    Content   string    `json:"content,omitempty"`
    Timestamp time.Time `json:"timestamp"`
}

// Client represents a connected user
type Client struct {
    ID       string
    UserID   string
    Username string
    Conn     *websocket.Conn
    Rooms    map[string]bool
    Send     chan []byte
    server   *ChatServer
    mu       sync.Mutex
}

// ChatServer manages the chat system
type ChatServer struct {
    db         *sql.DB
    clients    map[string]*Client // clientID -> Client
    rooms      map[string]map[string]*Client // roomID -> clientID -> Client
    register   chan *Client
    unregister chan *Client
    broadcast  chan *Message
    upgrader   websocket.Upgrader
    logger     *slog.Logger
    mu         sync.RWMutex
}

func NewChatServer(db *sql.DB, logger *slog.Logger) *ChatServer {
    return &ChatServer{
        db:         db,
        clients:    make(map[string]*Client),
        rooms:      make(map[string]map[string]*Client),
        register:   make(chan *Client),
        unregister: make(chan *Client),
        broadcast:  make(chan *Message, 256),
        upgrader: websocket.Upgrader{
            ReadBufferSize:  1024,
            WriteBufferSize: 1024,
            CheckOrigin: func(r *http.Request) bool {
                return true // Configure for production
            },
        },
        logger: logger,
    }
}

func (s *ChatServer) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return

        case client := <-s.register:
            s.handleRegister(client)

        case client := <-s.unregister:
            s.handleUnregister(client)

        case msg := <-s.broadcast:
            s.handleBroadcast(msg)
        }
    }
}

func (s *ChatServer) handleRegister(client *Client) {
    s.mu.Lock()
    s.clients[client.ID] = client
    s.mu.Unlock()

    s.logger.Info("Client connected",
        "client_id", client.ID,
        "user_id", client.UserID,
        "username", client.Username,
    )
}

func (s *ChatServer) handleUnregister(client *Client) {
    s.mu.Lock()
    defer s.mu.Unlock()

    if _, ok := s.clients[client.ID]; !ok {
        return
    }

    // Leave all rooms
    for roomID := range client.Rooms {
        if room, ok := s.rooms[roomID]; ok {
            delete(room, client.ID)

            // Notify others
            s.broadcastToRoom(roomID, &Message{
                Type:      MsgTypeLeave,
                RoomID:    roomID,
                UserID:    client.UserID,
                Username:  client.Username,
                Timestamp: time.Now(),
            })
        }
    }

    delete(s.clients, client.ID)
    close(client.Send)

    s.logger.Info("Client disconnected",
        "client_id", client.ID,
        "user_id", client.UserID,
    )
}

func (s *ChatServer) handleBroadcast(msg *Message) {
    // Save message to database
    if msg.Type == MsgTypeChat {
        s.saveMessage(msg)
    }

    s.mu.RLock()
    defer s.mu.RUnlock()

    s.broadcastToRoom(msg.RoomID, msg)
}

func (s *ChatServer) broadcastToRoom(roomID string, msg *Message) {
    data, err := json.Marshal(msg)
    if err != nil {
        return
    }

    room, ok := s.rooms[roomID]
    if !ok {
        return
    }

    for _, client := range room {
        select {
        case client.Send <- data:
        default:
            // Buffer full
        }
    }
}

func (s *ChatServer) saveMessage(msg *Message) {
    _, err := s.db.Exec(`
        INSERT INTO messages (id, room_id, user_id, content, created_at)
        VALUES ($1, $2, $3, $4, $5)
    `, msg.ID, msg.RoomID, msg.UserID, msg.Content, msg.Timestamp)

    if err != nil {
        s.logger.Error("Failed to save message", "error", err)
    }
}

func (s *ChatServer) getMessageHistory(roomID string, limit int) ([]Message, error) {
    rows, err := s.db.Query(`
        SELECT m.id, m.room_id, m.user_id, u.username, m.content, m.created_at
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.room_id = $1
        ORDER BY m.created_at DESC
        LIMIT $2
    `, roomID, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var messages []Message
    for rows.Next() {
        var m Message
        m.Type = MsgTypeChat
        rows.Scan(&m.ID, &m.RoomID, &m.UserID, &m.Username, &m.Content, &m.Timestamp)
        messages = append(messages, m)
    }

    // Reverse to get chronological order
    for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
        messages[i], messages[j] = messages[j], messages[i]
    }

    return messages, nil
}

// HandleWebSocket handles WebSocket connections
func (s *ChatServer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
    // Get user from context (set by auth middleware)
    userID := r.Context().Value("user_id").(string)
    username := r.Context().Value("username").(string)

    conn, err := s.upgrader.Upgrade(w, r, nil)
    if err != nil {
        s.logger.Error("Upgrade failed", "error", err)
        return
    }

    client := &Client{
        ID:       generateID(),
        UserID:   userID,
        Username: username,
        Conn:     conn,
        Rooms:    make(map[string]bool),
        Send:     make(chan []byte, 256),
        server:   s,
    }

    s.register <- client

    go client.writePump()
    go client.readPump()
}

func (c *Client) readPump() {
    defer func() {
        c.server.unregister <- c
        c.Conn.Close()
    }()

    c.Conn.SetReadLimit(64 * 1024)
    c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    c.Conn.SetPongHandler(func(string) error {
        c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    for {
        _, data, err := c.Conn.ReadMessage()
        if err != nil {
            break
        }

        var msg Message
        if err := json.Unmarshal(data, &msg); err != nil {
            continue
        }

        c.handleMessage(&msg)
    }
}

func (c *Client) handleMessage(msg *Message) {
    msg.UserID = c.UserID
    msg.Username = c.Username
    msg.Timestamp = time.Now()

    switch msg.Type {
    case MsgTypeJoin:
        c.joinRoom(msg.RoomID)

    case MsgTypeLeave:
        c.leaveRoom(msg.RoomID)

    case MsgTypeChat:
        if c.Rooms[msg.RoomID] {
            msg.ID = generateID()
            c.server.broadcast <- msg
        }

    case MsgTypeTyping:
        if c.Rooms[msg.RoomID] {
            c.server.broadcastToRoom(msg.RoomID, msg)
        }

    case MsgTypeHistory:
        c.sendHistory(msg.RoomID)
    }
}

func (c *Client) joinRoom(roomID string) {
    c.server.mu.Lock()
    if _, ok := c.server.rooms[roomID]; !ok {
        c.server.rooms[roomID] = make(map[string]*Client)
    }
    c.server.rooms[roomID][c.ID] = c
    c.Rooms[roomID] = true
    c.server.mu.Unlock()

    // Send join notification
    c.server.broadcastToRoom(roomID, &Message{
        Type:      MsgTypeJoin,
        RoomID:    roomID,
        UserID:    c.UserID,
        Username:  c.Username,
        Timestamp: time.Now(),
    })

    // Send presence info
    c.sendPresence(roomID)

    // Send message history
    c.sendHistory(roomID)
}

func (c *Client) leaveRoom(roomID string) {
    c.server.mu.Lock()
    if room, ok := c.server.rooms[roomID]; ok {
        delete(room, c.ID)
    }
    delete(c.Rooms, roomID)
    c.server.mu.Unlock()

    c.server.broadcastToRoom(roomID, &Message{
        Type:      MsgTypeLeave,
        RoomID:    roomID,
        UserID:    c.UserID,
        Username:  c.Username,
        Timestamp: time.Now(),
    })
}

func (c *Client) sendPresence(roomID string) {
    c.server.mu.RLock()
    room := c.server.rooms[roomID]
    users := make([]map[string]string, 0, len(room))
    for _, client := range room {
        users = append(users, map[string]string{
            "user_id":  client.UserID,
            "username": client.Username,
        })
    }
    c.server.mu.RUnlock()

    msg := Message{
        Type:    MsgTypePresence,
        RoomID:  roomID,
        Content: mustJSON(users),
    }
    data, _ := json.Marshal(msg)
    c.Send <- data
}

func (c *Client) sendHistory(roomID string) {
    messages, err := c.server.getMessageHistory(roomID, 50)
    if err != nil {
        return
    }

    msg := Message{
        Type:    MsgTypeHistory,
        RoomID:  roomID,
        Content: mustJSON(messages),
    }
    data, _ := json.Marshal(msg)
    c.Send <- data
}

func (c *Client) writePump() {
    ticker := time.NewTicker(54 * time.Second)
    defer func() {
        ticker.Stop()
        c.Conn.Close()
    }()

    for {
        select {
        case message, ok := <-c.Send:
            c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if !ok {
                c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            w, err := c.Conn.NextWriter(websocket.TextMessage)
            if err != nil {
                return
            }
            w.Write(message)
            w.Close()

        case <-ticker.C:
            c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }
}

func main() {
    logger := slog.Default()

    db, err := sql.Open("postgres", "postgres://localhost/chat?sslmode=disable")
    if err != nil {
        logger.Error("Failed to connect to database", "error", err)
        return
    }

    server := NewChatServer(db, logger)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    go server.Run(ctx)

    r := chi.NewRouter()
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    // Auth middleware would go here
    r.Get("/ws", server.HandleWebSocket)

    logger.Info("Starting chat server on :8080")
    http.ListenAndServe(":8080", r)
}

func generateID() string {
    return fmt.Sprintf("%d", time.Now().UnixNano())
}

func mustJSON(v any) string {
    data, _ := json.Marshal(v)
    return string(data)
}
```

### Junior -> FAANG: Getting the Most From This Exercise

The chat application in this exercise integrates every pattern from the chapter: WebSocket hub goroutine, room management, message persistence, presence tracking, and history delivery. The most valuable thing to do with this exercise is not to copy it but to build it from scratch and compare your implementation to this reference.

The three points where most junior implementations diverge from this reference: (1) they write to the WebSocket connection directly from `handleMessage` instead of sending to the `client.Send` channel and letting the `writePump` handle the actual write (this creates a concurrent write race because `readPump` and `writePump` both have access to the connection), (2) they do not set a read deadline in `readPump` and do not reset it in the pong handler, so stale connections are never detected, and (3) they lock the mutex directly in `broadcastToRoom` instead of calling it from within an already-locked context (the hub goroutine's `handleBroadcast` already holds the lock when it calls `broadcastToRoom`).

For interview preparation: practice explaining why the hub goroutine is the single writer to the clients and rooms maps. The interviewer will follow up by asking what happens if you remove the hub goroutine and use a mutex everywhere instead. The answer is that it works but creates lock contention between the broadcast path (which needs a read lock over potentially thousands of clients) and the register/unregister path (which needs a write lock). The hub goroutine avoids all locking on the broadcast path because it serializes operations sequentially through a channel, trading concurrency for simplicity.

### Senior @ FAANG: Extending This Exercise Toward Production Readiness

The chat application in this exercise is a solid starting point but has several gaps that separate a prototype from a production system. Each gap is a design decision that requires explicit reasoning at senior level.

**Message ordering and delivery guarantees.** The current implementation delivers messages in broadcast order within a single pod. If messages from two different users arrive at the hub simultaneously, their ordering in the `broadcast` channel depends on goroutine scheduling, not on send timestamp. For most chat applications, causal ordering (a message sent after another by the same user arrives after it) is sufficient. For collaborative applications, full ordering (every client sees messages in the same sequence regardless of sender) requires a sequence number assigned at write time using a per-room atomic counter or a database sequence column. Decide which ordering guarantee your product requires before writing the persistence layer.

**Message persistence under load.** The `saveMessage` function writes to the database synchronously inside the hub goroutine. This means a slow database write blocks all message processing for all rooms. At any meaningful message volume, this becomes the bottleneck. The correct architecture separates message delivery (hub goroutine, pure in-memory, no blocking I/O) from message persistence (a separate goroutine or worker pool that consumes from a write-ahead buffer). Messages are delivered to clients immediately and persisted asynchronously. The trade-off is that a pod crash between delivery and persistence can lose messages. Document the acceptable message loss window in the design document.

**Horizontal scaling with Redis Streams.** Add a `go run ./cmd/chat-scaled` entrypoint that wraps the `ChatServer` with a Redis Streams consumer. The hub goroutine remains unchanged. A new `RedisPublisher` goroutine reads from `server.broadcast` and writes to a Redis Stream keyed by room ID. A new `RedisConsumer` goroutine reads from the same stream starting from `XREAD COUNT 100 BLOCK 100 STREAMS room-{id} $` and dispatches messages back into the local clients for that room. This adds horizontal scaling without changing any handler code. Test it by running two instances of the server and verifying that a message sent from a client on instance A is received by a client on instance B within 200ms.

**Graceful drain on pod shutdown.** Add a `SIGTERM` handler that: (1) stops accepting new WebSocket upgrades by setting a flag checked in `HandleWebSocket`, (2) sends a `{"type":"reconnect","payload":{"delay":5000}}` message to every connected client so they reconnect to a healthy pod, (3) waits for all `readPump` and `writePump` goroutines to exit by tracking them in a `sync.WaitGroup`, and (4) flushes any pending messages in the `broadcast` channel before returning. This is the production readiness requirement that interviewers ask about when they say "how would you deploy this without dropping messages?"

---
