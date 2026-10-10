## 102H.5 WebSocket Scaling Patterns & Connection Recovery

### 5.1 Connection State Recovery

Network interruptions are inevitable in production, so a WebSocket client must be able to reconnect automatically and resume from where it left off. The `ReconnectableClient` below implements exponential backoff between reconnect attempts and exposes a `MessageBuffer` that retains recent messages by ID, when the client reconnects, it can request all messages it missed since its last received ID rather than starting with a cold state.

```go
package recovery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ReconnectableClient is a WebSocket client with automatic reconnection.
type ReconnectableClient struct {
	url         string
	headers     http.Header
	onMessage   func([]byte)
	onConnect   func()
	onDisconnect func(error)

	conn       *websocket.Conn
	done       chan struct{}
	send       chan []byte
	lastMsgID  string // For resuming from the last seen message.

	// Reconnection config.
	minBackoff time.Duration
	maxBackoff time.Duration
}

// ClientConfig holds client configuration.
type ClientConfig struct {
	URL          string
	Headers      http.Header
	OnMessage    func([]byte)
	OnConnect    func()
	OnDisconnect func(error)
	MinBackoff   time.Duration
	MaxBackoff   time.Duration
}

func NewReconnectableClient(cfg ClientConfig) *ReconnectableClient {
	return &ReconnectableClient{
		url:          cfg.URL,
		headers:      cfg.Headers,
		onMessage:    cfg.OnMessage,
		onConnect:    cfg.OnConnect,
		onDisconnect: cfg.OnDisconnect,
		done:         make(chan struct{}),
		send:         make(chan []byte, 256),
		minBackoff:   cfg.MinBackoff,
		maxBackoff:   cfg.MaxBackoff,
	}
}

// Connect starts the client with automatic reconnection.
func (c *ReconnectableClient) Connect(ctx context.Context) {
	backoff := c.minBackoff
	go func() {
		for {
			err := c.connectAndRun(ctx)
			if err == nil || ctx.Err() != nil {
				return
			}

			if c.onDisconnect != nil {
				c.onDisconnect(err)
			}

			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
				backoff *= 2
				if backoff > c.maxBackoff {
					backoff = c.maxBackoff
				}
			}
		}
	}()
}

func (c *ReconnectableClient) connectAndRun(ctx context.Context) error {
	dialer := websocket.DefaultDialer
	conn, _, err := dialer.DialContext(ctx, c.url, c.headers)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	c.conn = conn
	defer conn.Close()

	if c.onConnect != nil {
		c.onConnect()
	}

	// Read loop.
	readErr := make(chan error, 1)
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			if c.onMessage != nil {
				c.onMessage(msg)
			}
		}
	}()

	// Write loop.
	for {
		select {
		case <-ctx.Done():
			conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			return nil
		case err := <-readErr:
			return err
		case msg := <-c.send:
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return err
			}
		}
	}
}

// Send queues a message for sending.
func (c *ReconnectableClient) Send(msg []byte) bool {
	select {
	case c.send <- msg:
		return true
	default:
		return false
	}
}

// MessageBuffer provides replay capability for missed messages during reconnection.
type MessageBuffer struct {
	mu       sync.Mutex
	messages []BufferedMessage
	maxSize  int
}

// BufferedMessage is a message with an ID for deduplication.
type BufferedMessage struct {
	ID        string
	Data      json.RawMessage
	Timestamp time.Time
	TTL       time.Duration
}

func NewMessageBuffer(maxSize int) *MessageBuffer {
	return &MessageBuffer{
		messages: make([]BufferedMessage, 0, maxSize),
		maxSize:  maxSize,
	}
}

// Append adds a message to the buffer.
func (b *MessageBuffer) Append(msg BufferedMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.messages) >= b.maxSize {
		// Remove oldest message.
		b.messages = b.messages[1:]
	}
	b.messages = append(b.messages, msg)
}

// Since returns all messages after the given message ID.
// Used for reconnection: client sends its last seen message ID.
func (b *MessageBuffer) Since(lastID string) []BufferedMessage {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Find the position of lastID.
	startIdx := 0
	for i, msg := range b.messages {
		if msg.ID == lastID {
			startIdx = i + 1
			break
		}
	}

	// Filter expired messages.
	now := time.Now()
	result := make([]BufferedMessage, 0)
	for _, msg := range b.messages[startIdx:] {
		if msg.TTL == 0 || now.Before(msg.Timestamp.Add(msg.TTL)) {
			result = append(result, msg)
		}
	}
	return result
}

// avoid imports
var _ = sync.Mutex{}
var _ = json.RawMessage{}
```

### Junior → FAANG: Connection State Recovery as the Missing Piece in Most Implementations

Most WebSocket tutorial implementations handle connect and disconnect correctly but ignore the reconnect case. When a client reconnects after a network disruption, it typically starts with a blank state. If the server has no record of what the client last received, the client may display stale data or miss important events. The connection state recovery pattern (storing the last event ID per client and replaying on reconnect) is what separates a toy implementation from a production one.

The first-job habit: always ask "what does the client see when it reconnects?" for any real-time feature you implement. If the answer is "a blank page while it waits for the next event," consider adding a snapshot endpoint or a replay buffer. This question surfaces missing requirements that are easy to address during initial implementation and expensive to add retroactively.

Interview entry point: describe reconnection state recovery as a three-part contract. The server assigns a monotonically increasing ID to every event. The client stores the last received ID in local state. On reconnect, the client sends the last ID and the server replays events from that point.

### Senior @ FAANG: Scaling Patterns and the Connection Routing Tier

At FAANG scale, WebSocket scaling involves three distinct tiers: the connection tier (holds goroutines and channels for active connections), the routing tier (maps user IDs to connection server instances), and the message tier (delivers messages to the routing tier). The scaling patterns in this section focus on the connection tier, but the routing tier is often the harder engineering problem.

Routing tier options range in complexity and operational cost. Consistent hashing: user X always connects to connection server hash(X) % N. Simple, but adding or removing servers re-routes a large fraction of connections. Redis-based registry: each connection server registers its connected user IDs in Redis on connect and deregisters on disconnect. A message sender looks up which server holds the target user and sends to that server's internal API. Gossip protocol: connection servers exchange their client lists and route messages directly to peers. Used in systems where Redis availability is a concern.

The L6 concern with the routing tier: what happens when a connection server fails? Clients on that server lose their connections and reconnect. The routing tier must detect the failure (stale entries in Redis), handle the re-registration of those clients to new servers, and not drop messages in-flight. The window between failure detection and reconnection completion is where messages are most likely to be lost. Designing the routing tier's failure mode explicitly, with documented delivery semantics during failure recovery, is the staff-level deliverable.


---
