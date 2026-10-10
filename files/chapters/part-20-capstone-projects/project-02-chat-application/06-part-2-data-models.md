## Part 2: Data Models

Data models are the backbone of any chat application. They define how users, messages, channels, and memberships are represented in both your Go code and your database. In this section, you will create struct definitions that map directly to PostgreSQL tables using JSON and database tags. Each model includes timestamps and soft-delete fields to support auditing and data recovery. Pay close attention to the field tags, they control how data is serialized for API responses and how it maps to database columns.

### 2.1 User Model (`internal/models/user.go`)
The following type definitions establish the core data model for the 2.1 User Model (`internal/models/user.go`) domain. These types are the shared language between layers of the system, so their field names, nullability, and validation rules are chosen for clarity and correctness.

```go
package models

import (
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID           uuid.UUID  `json:"id" db:"id"`
	Username     string     `json:"username" db:"username"`
	Email        string     `json:"email" db:"email"`
	PasswordHash string     `json:"-" db:"password_hash"`
	DisplayName  string     `json:"display_name" db:"display_name"`
	AvatarURL    string     `json:"avatar_url" db:"avatar_url"`
	Status       UserStatus `json:"status" db:"status"`
	CustomStatus string     `json:"custom_status" db:"custom_status"`
	CreatedAt    time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at" db:"updated_at"`
	LastSeenAt   *time.Time `json:"last_seen_at" db:"last_seen_at"`
	DeletedAt    *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}

type UserStatus string

const (
	UserStatusOnline  UserStatus = "online"
	UserStatusOffline UserStatus = "offline"
	UserStatusAway    UserStatus = "away"
	UserStatusBusy    UserStatus = "busy"
)

// PublicUser returns user data safe for public consumption
type PublicUser struct {
	ID           uuid.UUID  `json:"id"`
	Username     string     `json:"username"`
	DisplayName  string     `json:"display_name"`
	AvatarURL    string     `json:"avatar_url"`
	Status       UserStatus `json:"status"`
	CustomStatus string     `json:"custom_status"`
	LastSeenAt   *time.Time `json:"last_seen_at,omitempty"`
}

func (u *User) ToPublic() *PublicUser {
	return &PublicUser{
		ID:           u.ID,
		Username:     u.Username,
		DisplayName:  u.DisplayName,
		AvatarURL:    u.AvatarURL,
		Status:       u.Status,
		CustomStatus: u.CustomStatus,
		LastSeenAt:   u.LastSeenAt,
	}
}

type CreateUserRequest struct {
	Username    string `json:"username" validate:"required,min=3,max=50"`
	Email       string `json:"email" validate:"required,email"`
	Password    string `json:"password" validate:"required,min=8"`
	DisplayName string `json:"display_name" validate:"max=100"`
}

type LoginRequest struct {
	Username string `json:"username" validate:"required"`
	Password string `json:"password" validate:"required"`
}

type LoginResponse struct {
	Token string      `json:"token"`
	User  *PublicUser `json:"user"`
}
```

### 2.2 Channel Model (`internal/models/channel.go`)

The following type definitions establish the core data model for the 2.2 Channel Model (`internal/models/channel.go`) domain. These types are the shared language between layers of the system, so their field names, nullability, and validation rules are chosen for clarity and correctness.

```go
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
	Members      []*PublicUser `json:"members"`
	UnreadCount  int           `json:"unread_count"`
	LastMessage  *Message      `json:"last_message,omitempty"`
}
```

### 2.3 Message Model (`internal/models/message.go`)

The following type definitions establish the core data model for the 2.3 Message Model (`internal/models/message.go`) domain. These types are the shared language between layers of the system, so their field names, nullability, and validation rules are chosen for clarity and correctness.

```go
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
```

### Junior → FAANG: Data Model Design as an Interview Signal

Data modeling questions in interviews are proxies for understanding relational database concepts. For a chat system, the key relationships are: users belong to channels (many-to-many), messages belong to channels (one-to-many), and messages belong to users (many-to-one). Drawing this entity-relationship diagram cleanly, with the correct cardinality annotations, in an interview shows database fluency.

UUIDs as primary keys versus sequential integers is a question interviewers raise. UUIDs avoid ID enumeration attacks (an attacker cannot guess other users' IDs by incrementing) but are larger (16 bytes versus 4-8 bytes) and make clustered index inserts less efficient because new UUIDs are random rather than sequential. UUID v7 (time-ordered UUIDs) combines the uniqueness of UUID with the sequential insert efficiency of integers. Know this tradeoff.

Soft deletes (is_deleted flag on messages) are necessary for a chat application where users can delete messages, but the system still needs to show "This message was deleted" to other participants. Design your data model with that requirement in mind from the start.

### Senior @ FAANG: Data Models as Contracts with Downstream Systems

At senior level, data models are contracts. Every field in the `Message` struct is a field that downstream systems (analytics, compliance, safety) may depend on. Adding a field is safe. Removing a field requires a deprecation process. Renaming a field requires a migration with both old and new names supported simultaneously during the transition.

The `Attachment` model for file sharing introduces a content addressing question: do you store file metadata (filename, MIME type, S3 key) in the message attachment table, or do you store a reference to an immutable content-addressed object? Content addressing (storing by hash of content) enables deduplication, simplifies cache invalidation, and makes it easier to implement CSAM scanning and content moderation. The ADR for the attachment storage model should document this choice.

Schema evolution strategy is a staff-level concern. As the product grows, the message model will need new fields (reactions, thread references, read receipts). Each addition requires a migration. Each migration has a risk of table lock on large tables. Using online schema change tools (pt-online-schema-change, gh-ost) for large table migrations, and having a rollback plan for each migration, is operational discipline that should be documented before the first migration runs in production.

---
