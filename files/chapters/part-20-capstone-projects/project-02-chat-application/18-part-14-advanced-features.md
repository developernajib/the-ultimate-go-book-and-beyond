## Part 14: Advanced Features

Once the core chat functionality is solid, you can layer on advanced features that differentiate a basic chat app from a production-grade one. This section covers end-to-end encryption concepts, message threading, reactions, and read receipts. These features are conceptually straightforward but involve subtle implementation details, for example, end-to-end encryption means the server stores messages it cannot read, which changes how you implement search and moderation. Understanding these trade-offs is valuable for system design interviews where you are expected to discuss the implications of architectural decisions.

### 14.1 End-to-End Encryption Concepts

While full E2E encryption is complex, here's the conceptual approach:

```go
// Conceptual E2E encryption flow
package encryption

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
)

// Client-side (JavaScript):
// 1. Generate key pair on client
// 2. Exchange public keys via server
// 3. Encrypt messages with recipient's public key
// 4. Send encrypted message to server
// 5. Server stores encrypted message (can't read it)
// 6. Recipient decrypts with private key

// Server only handles encrypted payloads
type EncryptedMessage struct {
	EncryptedContent string `json:"encrypted_content"`
	SenderPublicKey  string `json:"sender_public_key"`
}

// Example key generation (would be done on client)
func GenerateKeyPair() (*rsa.PrivateKey, *rsa.PublicKey, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, err
	}
	return privateKey, &privateKey.PublicKey, nil
}

// Example encryption (would be done on client)
func EncryptMessage(publicKey *rsa.PublicKey, message string) (string, error) {
	ciphertext, err := rsa.EncryptOAEP(
		sha256.New(),
		rand.Reader,
		publicKey,
		[]byte(message),
		nil,
	)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Note: Actual implementation would use Signal Protocol or Matrix's Olm
// for proper forward secrecy and multi-device support
```

### 14.2 Read Receipts Implementation

Read receipts track which messages each user has seen. When a client sends a read receipt, the hub updates the database and broadcasts the receipt to other channel members so their UIs can show read indicators.

```go
// internal/chat/read_receipts.go
package chat

import (
	"context"
	"time"

	"github.com/google/uuid"
)

func (h *Hub) handleReadReceipt(msg *IncomingMessage) {
	messageID, ok := msg.Data["message_id"].(string)
	if !ok {
		return
	}

	msgUUID, err := uuid.Parse(messageID)
	if err != nil {
		return
	}

	// Save read receipt to database
	if err := h.pgStore.MarkMessageAsRead(h.ctx, msgUUID, msg.UserID); err != nil {
		log.Printf("Error saving read receipt: %v", err)
		return
	}

	// Broadcast read receipt to channel members
	receiptMsg := &OutgoingMessage{
		Type: MessageTypeReadReceipt,
		Data: map[string]any{
			"message_id": msgUUID,
			"user_id":    msg.UserID,
			"read_at":    time.Now(),
		},
	}

	// Get channel ID from message
	message, err := h.pgStore.GetMessageByID(h.ctx, msgUUID)
	if err == nil {
		h.broadcastToRoom(message.ChannelID, receiptMsg, uuid.Nil)
	}
}
```

### 14.3 Message Threading

Message threading lets users reply to a specific message, creating a nested conversation. The `ThreadedMessage` struct wraps a parent message with its replies and a reply count for pagination.

```go
// Support for threaded conversations
type ThreadedMessage struct {
	*models.Message
	Replies     []*models.Message `json:"replies"`
	ReplyCount  int               `json:"reply_count"`
}

func (s *PostgresStore) GetThread(ctx context.Context, parentMessageID uuid.UUID) (*ThreadedMessage, error) {
	// Get parent message
	parent, err := s.GetMessageByID(ctx, parentMessageID)
	if err != nil {
		return nil, err
	}

	// Get replies
	query := `
		SELECT m.id, m.channel_id, m.user_id, m.content, m.message_type,
		       m.created_at, m.updated_at,
		       u.id, u.username, u.display_name, u.avatar_url
		FROM messages m
		INNER JOIN users u ON m.user_id = u.id
		WHERE m.parent_message_id = $1 AND m.deleted_at IS NULL
		ORDER BY m.created_at ASC
	`

	rows, err := s.db.QueryContext(ctx, query, parentMessageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var replies []*models.Message
	for rows.Next() {
		var msg models.Message
		var user models.PublicUser

		err := rows.Scan(
			&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.Type,
			&msg.CreatedAt, &msg.UpdatedAt,
			&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL,
		)
		if err != nil {
			return nil, err
		}

		msg.User = &user
		replies = append(replies, &msg)
	}

	return &ThreadedMessage{
		Message:    parent,
		Replies:    replies,
		ReplyCount: len(replies),
	}, nil
}
```

### Junior → FAANG: Advanced Features as Interview Scope Extensions

End-to-end encryption, message threading, and read receipts are classic "what would you add next" interview questions. Knowing the conceptual answer for each demonstrates you have thought beyond the minimum viable implementation.

For E2E encryption specifically: the server stores ciphertext it cannot decrypt. This eliminates server-side search of message content, makes moderation impossible without client-side reporting, and requires key exchange between communicating parties. The Signal Protocol (used by WhatsApp and Signal) is the industry standard. Knowing it exists and what it does (double ratchet algorithm, forward secrecy) is sufficient for an interview.

Message threading (replies with context) requires a `parent_message_id` foreign key on the message table. The display logic (showing threaded replies in a collapsed view) is a frontend concern, but the data model is the backend's responsibility. Define the data model before implementing threading.

### Senior @ FAANG: Advanced Features as Product Scope Commitments

At senior level, adding E2E encryption to a chat system is not a feature addition. It is a product scope commitment with security, compliance, and engineering implications that must be evaluated before implementation.

The key management problem in E2E encryption is the hardest part. Key generation on the client side, key backup (so users do not lose their message history when they lose their device), key distribution to new devices, and key revocation when a device is compromised are all unsolved problems in the standard Signal Protocol implementation. Each requires a design decision and user-visible behavior. At FAANG, these decisions involve the security team, the legal team, and product leadership, not just the engineering team.

Read receipts at scale (billions of reads per day) produce a write amplification problem: every message read by every recipient generates a write to record the read receipt. For a message read by 1000 users in a popular channel, that is 1000 writes per message read event. The production solution is batched read receipt writes (collect reads over a 5-second window per user per channel) and approximate read counts (stored as a Redis counter, periodically flushed to PostgreSQL). The tradeoff between accuracy and write efficiency must be documented in the ADR.

---
