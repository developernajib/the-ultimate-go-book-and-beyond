## API Design

The API layer exposes REST endpoints for operations that do not require real-time delivery, such as user registration, fetching conversation history, creating groups, and initiating media uploads. Real-time messaging itself flows through WebSocket connections rather than REST. The struct definitions below show the request and response shapes for each endpoint, using Go struct tags for JSON serialization and validation.

Two shapes here are dictated by constraints established earlier, and both are places where an otherwise sensible API quietly breaks the design. The conversation list carries no message preview: the server holds ciphertext, so it cannot produce the "last message" snippet every chat UI displays. That snippet is rendered by the client from its local decrypted store, and an API that returned one would be advertising that the server can read your messages. And history pagination is keyed on a message ID rather than a timestamp, because the Cassandra table clusters on the TimeUUID `message_id`, so an opaque cursor is both the natural page boundary and one fewer chance for a client to hand us an ambiguous timestamp.

```go
package api

import "time"

// POST /api/v1/auth/register
type RegisterRequest struct {
	Phone string `json:"phone" validate:"required,e164"`
	Name  string `json:"name"  validate:"required,max=100"`

	// X3DH long-term identity key and the prekeys a sender needs to open a
	// session with this device while it is offline.
	IdentityKey           string `json:"identity_key"       validate:"required"`
	SignedPreKey          string `json:"signed_pre_key"     validate:"required"`
	SignedPreKeySignature string `json:"signed_pre_key_sig" validate:"required"`

	// A batch of one-time prekeys, consumed one per new session. The server
	// hands each out at most once and the client tops the pool back up.
	OneTimeKeys []string `json:"one_time_keys" validate:"required,min=100,dive,required"`
}

type RegisterResponse struct {
	UserID    string    `json:"user_id"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// GET /api/v1/conversations
type ConversationSummary struct {
	ConvID string `json:"conv_id"`
	Type   string `json:"type"`
	Name   string `json:"name"`

	// No last-message preview: the server cannot decrypt one. The client
	// renders it from its own local store.
	UnreadCount   int       `json:"unread_count"`
	LastMessageID string    `json:"last_message_id"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// GET /api/v1/conversations/{conv_id}/messages?before={message_id}&limit=50
//
// before is a TimeUUID cursor, not a timestamp: it matches the clustering key
// the partition is sorted by. Omit it for the newest page.
type MessageResponse struct {
	ID          string     `json:"id"` // TimeUUID
	SenderID    string     `json:"sender_id"`
	Type        string     `json:"type"`
	Content     string     `json:"content"` // base64 ciphertext, opaque here
	Status      string     `json:"status"`
	SentAt      time.Time  `json:"sent_at"`
	DeliveredAt *time.Time `json:"delivered_at,omitempty"`
	ReadAt      *time.Time `json:"read_at,omitempty"`
}

// POST /api/v1/groups
type CreateGroupRequest struct {
	Name string `json:"name" validate:"required,max=100"`
	// 1023, because the creator occupies the 1024th slot.
	Members []string `json:"members" validate:"required,min=1,max=1023,dive,required"`
}

// POST /api/v1/media/upload
type MediaUploadRequest struct {
	// Size of the ciphertext. Bound into the presigned URL so the signature
	// cannot be replayed to upload something far larger.
	SizeBytes int64 `json:"size_bytes" validate:"required,min=1,max=104857600"`
}

type MediaUploadResponse struct {
	MediaKey  string    `json:"media_key"`
	UploadURL string    `json:"upload_url"`
	ExpiresAt time.Time `json:"expires_at"`
}

// GET /api/v1/keys/{user_id}/bundle
//
// The X3DH prekey bundle. SignedPreKeySignature is not optional decoration:
// the requester verifies it against IdentityKey to prove the prekey really came
// from that identity. Without it the server could substitute its own prekey and
// transparently machine-in-the-middle the session, which is the one attack the
// whole handshake exists to prevent.
type KeyBundleResponse struct {
	IdentityKey           string `json:"identity_key"`
	SignedPreKey          string `json:"signed_pre_key"`
	SignedPreKeySignature string `json:"signed_pre_key_sig"`

	// Omitted when the device's one-time prekey pool is exhausted. X3DH is
	// designed to still work without it, at the cost of some forward secrecy
	// for the first message, so clients must handle its absence.
	OneTimeKey string `json:"one_time_key,omitempty"`
}
```

---
