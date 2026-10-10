package models

import (
	"time"

	"github.com/google/uuid"
)

type Message struct {
	ID              uuid.UUID   `json:"id" db:"id"`
	ChannelID       uuid.UUID   `json:"channel_id" db:"channel_id"`
	UserID          uuid.UUID   `json:"user_id" db:"user_id"`
	Content         string      `json:"content" db:"content"`
	Type            MessageType `json:"type" db:"message_type"`
	Metadata        JSONB       `json:"metadata,omitempty" db:"metadata"`
	ParentMessageID *uuid.UUID  `json:"parent_message_id,omitempty" db:"parent_message_id"`
	CreatedAt       time.Time   `json:"created_at" db:"created_at"`
	UpdatedAt       time.Time   `json:"updated_at" db:"updated_at"`
	DeletedAt       *time.Time  `json:"deleted_at,omitempty" db:"deleted_at"`

	// Joined fields (not in DB)
	User        *PublicUser   `json:"user,omitempty" db:"-"`
	Reactions   []*Reaction   `json:"reactions,omitempty" db:"-"`
	Attachments []*Attachment `json:"attachments,omitempty" db:"-"`
}

type MessageType string

const (
	MessageTypeText   MessageType = "text"
	MessageTypeFile   MessageType = "file"
	MessageTypeImage  MessageType = "image"
	MessageTypeSystem MessageType = "system"
)

type JSONB map[string]any

type Reaction struct {
	ID        uuid.UUID `json:"id" db:"id"`
	MessageID uuid.UUID `json:"message_id" db:"message_id"`
	UserID    uuid.UUID `json:"user_id" db:"user_id"`
	Emoji     string    `json:"emoji" db:"emoji"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

type Attachment struct {
	ID           uuid.UUID `json:"id" db:"id"`
	MessageID    uuid.UUID `json:"message_id" db:"message_id"`
	Filename     string    `json:"filename" db:"filename"`
	FileSize     int64     `json:"file_size" db:"file_size"`
	MimeType     string    `json:"mime_type" db:"mime_type"`
	StorageKey   string    `json:"storage_key" db:"storage_key"`
	ThumbnailKey string    `json:"thumbnail_key,omitempty" db:"thumbnail_key"`
	Width        *int      `json:"width,omitempty" db:"width"`
	Height       *int      `json:"height,omitempty" db:"height"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
}

type SendMessageRequest struct {
	ChannelID       uuid.UUID   `json:"channel_id" validate:"required"`
	Content         string      `json:"content" validate:"required,min=1,max=4000"`
	Type            MessageType `json:"type" validate:"omitempty,oneof=text file image"`
	ParentMessageID *uuid.UUID  `json:"parent_message_id"`
}

type MessageListRequest struct {
	ChannelID uuid.UUID  `json:"channel_id" validate:"required"`
	Before    *uuid.UUID `json:"before"`
	After     *uuid.UUID `json:"after"`
	Limit     int        `json:"limit" validate:"min=1,max=100"`
}

type MessageSearchRequest struct {
	Query     string     `json:"query" validate:"required,min=1"`
	ChannelID *uuid.UUID `json:"channel_id"`
	Limit     int        `json:"limit" validate:"min=1,max=100"`
	Offset    int        `json:"offset" validate:"min=0"`
}
