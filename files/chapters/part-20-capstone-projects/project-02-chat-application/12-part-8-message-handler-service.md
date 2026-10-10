## Part 8: Message Handler Service

The message handler service acts as a bridge between the real-time WebSocket layer and the persistent storage layer. When a user sends a message through a WebSocket, the hub delegates to this service to save the message to PostgreSQL, update any relevant metadata, and trigger side effects like notifications. Isolating this logic into its own service keeps the WebSocket hub focused on connection management and makes the message processing pipeline easier to test and extend with features like message validation or content filtering.

### 8.1 Message Handler Implementation (`internal/chat/message_handler.go`)
The message handler service processes inbound messages from WebSocket connections, persists them to the database, and fans them out to all room subscribers. Decoupling persistence from broadcast allows the system to acknowledge message delivery to the sender while background workers handle fan-out asynchronously.

```go
package chat

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/yourusername/gochat/internal/models"
	"github.com/yourusername/gochat/internal/storage"
)

type messageHandler struct {
	pgStore *storage.PostgresStore
}

func NewMessageHandler(pgStore *storage.PostgresStore) MessageHandler {
	return &messageHandler{
		pgStore: pgStore,
	}
}

func (h *messageHandler) SaveMessage(ctx context.Context, userID, channelID uuid.UUID, content string) (*models.Message, error) {
	// Validate user is in channel
	isMember, err := h.pgStore.IsUserInChannel(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("check channel membership: %w", err)
	}
	if !isMember {
		return nil, fmt.Errorf("user not in channel")
	}

	// Create message
	message, err := h.pgStore.CreateMessage(ctx, userID, channelID, content, models.MessageTypeText)
	if err != nil {
		return nil, fmt.Errorf("create message: %w", err)
	}

	return message, nil
}

func (h *messageHandler) GetMessages(ctx context.Context, channelID uuid.UUID, limit int, before *uuid.UUID) ([]*models.Message, error) {
	return h.pgStore.GetMessages(ctx, channelID, limit, before)
}

func (h *messageHandler) DeleteMessage(ctx context.Context, messageID, userID uuid.UUID) error {
	// In a real implementation, check if user owns the message
	// For now, soft delete by updating deleted_at
	return nil
}

func (h *messageHandler) AddReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	return h.pgStore.AddReaction(ctx, messageID, userID, emoji)
}

func (h *messageHandler) RemoveReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	return h.pgStore.RemoveReaction(ctx, messageID, userID, emoji)
}
```

### 8.2 Presence Service Implementation (`internal/chat/presence.go`)

The presence service tracks which users are online by maintaining heartbeat timestamps in Redis. It exposes methods for marking a user as online, checking presence status, and listing all online members of a channel.

```go
package chat

import (
	"context"

	"github.com/google/uuid"
	"github.com/yourusername/gochat/internal/storage"
)

type presenceService struct {
	redisStore *storage.RedisStore
}

func NewPresenceService(redisStore *storage.RedisStore) PresenceService {
	return &presenceService{
		redisStore: redisStore,
	}
}

func (s *presenceService) SetOnline(ctx context.Context, userID uuid.UUID) error {
	return s.redisStore.SetOnline(ctx, userID)
}

func (s *presenceService) SetOffline(ctx context.Context, userID uuid.UUID) error {
	return s.redisStore.SetOffline(ctx, userID)
}

func (s *presenceService) SetTyping(ctx context.Context, userID, channelID uuid.UUID, isTyping bool) error {
	return s.redisStore.SetTyping(ctx, userID, channelID, isTyping)
}

func (s *presenceService) GetOnlineUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	return s.redisStore.GetOnlineUsers(ctx, channelID)
}

func (s *presenceService) GetTypingUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	return s.redisStore.GetTypingUsers(ctx, channelID)
}
```

### Junior → FAANG: Service Layer as a Separation of Concerns

The message handler service is a clean example of the service layer pattern: it orchestrates interactions between the WebSocket hub (transport) and the storage layer (persistence) without either layer knowing about the other. This separation is a first-job habit worth internalizing.

For interviews, describing this layered architecture shows you understand how to keep concerns separated as a codebase grows. A common mistake in early-career code is to put database calls directly inside WebSocket handler functions, creating tight coupling that makes testing and future changes difficult.

The "persist then broadcast" ordering in message delivery is a deliberate choice. Persisting first means that if the broadcast fails (because a client disconnected), the message is still in the database and can be retrieved on reconnect. Reversing the order (broadcast then persist) creates a window where a message is visible to recipients but not yet durable.

### Senior @ FAANG: Message Handler as a Consistency Boundary

At senior level, the message handler service is the place where consistency guarantees are made. Persisting a message to PostgreSQL and publishing to Redis Pub/Sub are two operations. If persistence succeeds but the pub/sub publish fails, the message is durable but not delivered in real time. If the publish succeeds but persistence fails, the message is delivered in real time but lost on reconnect.

The correct mitigation is transactional outbox: write the message to PostgreSQL in the same transaction as an outbox entry. A separate poller reads unprocessed outbox entries and publishes them to Redis. When the publish is confirmed, the outbox entry is marked as processed. This guarantees that every persisted message is eventually published, with no possibility of a publish without a corresponding persistence. The tradeoff is latency: the message is not delivered until the outbox poller runs, typically 100-500ms after the write.

Content filtering (detecting and blocking prohibited content) belongs in the message handler, not in the WebSocket hub or the storage layer. The message handler is the natural integration point for safety services: validate the message content against a moderation API, block if flagged, and store moderation decisions alongside the message for audit. The ADR must define the behavior when the moderation service is unavailable (fail open and deliver, or fail closed and block). That decision has product, legal, and safety implications.

---
