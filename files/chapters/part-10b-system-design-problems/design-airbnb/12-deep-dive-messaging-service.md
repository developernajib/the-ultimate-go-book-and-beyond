## Deep Dive: Messaging Service

Real-time messaging between hosts and guests is essential for pre-booking questions and coordination during stays. This service persists all messages in PostgreSQL for durability and delivers them in real time via WebSocket connections when the recipient is online, falling back to push notifications when they are offline. A critical trust-and-safety feature is PII detection, the service blocks messages containing phone numbers or email addresses before a booking is confirmed, which prevents users from circumventing the platform to avoid service fees.

```go
package messaging

import (
	"context"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

type NotificationService interface {
	SendPush(ctx context.Context, recipientID, title, body string)
}

type Conversation struct {
	HostID              string
	GuestID             string
	HasConfirmedBooking bool
}

// MessagingService handles host-guest communication
type MessagingService struct {
	db       *pgxpool.Pool
	wsConns  map[string]*websocket.Conn // production code guards this with a sync.RWMutex
	notifier NotificationService
}

type Message struct {
	ID             string     `json:"id"`
	ConversationID string     `json:"conversation_id"`
	SenderID       string     `json:"sender_id"`
	Content        string     `json:"content"`
	ReadAt         *time.Time `json:"read_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

// SendMessage delivers a message and notifies the recipient
func (s *MessagingService) SendMessage(ctx context.Context, conversationID, senderID, content string) (*Message, error) {
	conv, err := s.getConversation(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	if senderID != conv.HostID && senderID != conv.GuestID {
		return nil, fmt.Errorf("unauthorized")
	}

	// Block PII sharing (phone, email) until a booking is confirmed
	if !conv.HasConfirmedBooking && containsPII(content) {
		return nil, fmt.Errorf("sharing personal contact info not allowed before booking")
	}

	msg := &Message{
		ID:             generateID(),
		ConversationID: conversationID,
		SenderID:       senderID,
		Content:        content,
		CreatedAt:      time.Now(),
	}
	s.saveMessage(ctx, msg)

	// Real-time delivery via WebSocket or push notification
	recipientID := conv.HostID
	if senderID == conv.HostID {
		recipientID = conv.GuestID
	}

	if ws, ok := s.wsConns[recipientID]; ok {
		ws.WriteJSON(msg)
	} else {
		s.notifier.SendPush(ctx, recipientID, "New message", truncate(content, 50))
	}

	return msg, nil
}

func (s *MessagingService) getConversation(ctx context.Context, conversationID string) (*Conversation, error) {
	return &Conversation{HostID: "host-1", GuestID: "guest-1", HasConfirmedBooking: true}, nil
}

func (s *MessagingService) saveMessage(ctx context.Context, msg *Message) error {
	return nil
}

func containsPII(content string) bool {
	return false
}

func generateID() string {
	return "msg-1"
}

func truncate(s string, maxLen int) string {
	if len(s) > maxLen {
		return s[:maxLen] + "..."
	}
	return s
}
```

---
