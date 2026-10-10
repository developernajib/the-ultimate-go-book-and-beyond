package models

import (
	"time"

	"github.com/google/uuid"
)

type Channel struct {
	ID          uuid.UUID   `json:"id" db:"id"`
	Name        string      `json:"name" db:"name"`
	Description string      `json:"description" db:"description"`
	Type        ChannelType `json:"type" db:"channel_type"`
	CreatedBy   uuid.UUID   `json:"created_by" db:"created_by"`
	CreatedAt   time.Time   `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at" db:"updated_at"`
	DeletedAt   *time.Time  `json:"deleted_at,omitempty" db:"deleted_at"`
}

type ChannelType string

const (
	ChannelTypePublic  ChannelType = "public"
	ChannelTypePrivate ChannelType = "private"
	ChannelTypeDM      ChannelType = "dm"
)

type ChannelMember struct {
	ID                   uuid.UUID  `json:"id" db:"id"`
	ChannelID            uuid.UUID  `json:"channel_id" db:"channel_id"`
	UserID               uuid.UUID  `json:"user_id" db:"user_id"`
	Role                 MemberRole `json:"role" db:"role"`
	JoinedAt             time.Time  `json:"joined_at" db:"joined_at"`
	LastReadAt           *time.Time `json:"last_read_at" db:"last_read_at"`
	NotificationsEnabled bool       `json:"notifications_enabled" db:"notifications_enabled"`
}

type MemberRole string

const (
	MemberRoleOwner  MemberRole = "owner"
	MemberRoleAdmin  MemberRole = "admin"
	MemberRoleMember MemberRole = "member"
)

type CreateChannelRequest struct {
	Name        string      `json:"name" validate:"required,min=1,max=100"`
	Description string      `json:"description" validate:"max=500"`
	Type        ChannelType `json:"type" validate:"required,oneof=public private"`
	MemberIDs   []uuid.UUID `json:"member_ids"`
}

type ChannelWithMembers struct {
	*Channel
	Members     []*PublicUser `json:"members"`
	UnreadCount int           `json:"unread_count"`
	LastMessage *Message      `json:"last_message,omitempty"`
}
