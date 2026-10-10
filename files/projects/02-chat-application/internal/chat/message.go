package chat

import (
	"context"

	"github.com/example/chat-application/internal/models"
	"github.com/google/uuid"
)

// IncomingMessage represents a message from a client
type IncomingMessage struct {
	Type     MessageTypeEnum `json:"type"`
	Data     map[string]any  `json:"data"`
	UserID   uuid.UUID       `json:"-"` // Set by server
	ClientID uuid.UUID       `json:"-"` // Set by server
}

// OutgoingMessage represents a message to a client
type OutgoingMessage struct {
	Type MessageTypeEnum `json:"type"`
	Data any             `json:"data"`
}

// BroadcastMessage represents a message to broadcast to a room
type BroadcastMessage struct {
	RoomID  uuid.UUID       `json:"room_id"`
	Message *models.Message `json:"message"`
}

// MessageTypeEnum represents message types
type MessageTypeEnum string

const (
	// Client -> Server
	MessageTypeJoinRoom    MessageTypeEnum = "join_room"
	MessageTypeLeaveRoom   MessageTypeEnum = "leave_room"
	MessageTypeChatMessage MessageTypeEnum = "chat_message"
	MessageTypeTyping      MessageTypeEnum = "typing"
	MessageTypeReaction    MessageTypeEnum = "reaction"
	MessageTypeReadReceipt MessageTypeEnum = "read_receipt"

	// Server -> Client
	MessageTypeConnected  MessageTypeEnum = "connected"
	MessageTypeJoinedRoom MessageTypeEnum = "joined_room"
	MessageTypeLeftRoom   MessageTypeEnum = "left_room"
	MessageTypeNewMessage MessageTypeEnum = "new_message"
	MessageTypeUserJoined MessageTypeEnum = "user_joined"
	MessageTypeUserLeft   MessageTypeEnum = "user_left"
	MessageTypeError      MessageTypeEnum = "error"
)

// MessageHandler interface for saving/retrieving messages
type MessageHandler interface {
	SaveMessage(ctx context.Context, userID, channelID uuid.UUID, content string) (*models.Message, error)
	GetMessages(ctx context.Context, channelID uuid.UUID, limit int, before *uuid.UUID) ([]*models.Message, error)
	DeleteMessage(ctx context.Context, messageID, userID uuid.UUID) error
	AddReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error
	RemoveReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error
}

// PresenceService interface for managing user presence
type PresenceService interface {
	SetOnline(ctx context.Context, userID uuid.UUID) error
	SetOffline(ctx context.Context, userID uuid.UUID) error
	SetTyping(ctx context.Context, userID, channelID uuid.UUID, isTyping bool) error
	GetOnlineUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error)
	GetTypingUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error)
}
