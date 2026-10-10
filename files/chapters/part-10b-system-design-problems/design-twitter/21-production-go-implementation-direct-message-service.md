## Production Go Implementation: Direct Message Service

Direct messages are a separate subsystem from the public tweet flow because they have different privacy requirements and delivery semantics. DMs must be encrypted at rest, delivered in real-time when the recipient is online, and fall back to push notifications when they are offline. The service manages conversations as first-class entities, tracking participants, last message, and unread counts so that the inbox view can be rendered without loading every message.

Everywhere else in this design an authorization slip is embarrassing. Here it is the whole product. A conversation ID is a `BIGINT`, and a read path that accepts one and returns messages is a read path that returns *anyone's* messages to whoever guesses or enumerates the number. There is no timeline cache to blame and no eventual consistency to hide behind: the check that the caller is a participant is the feature. Note that it belongs on every path that touches a conversation, including the ones that only look like metadata.

Encryption deserves the same honesty. "Encrypted at rest" in the sense below means the service encrypts the body before it reaches the database, so a leaked backup or a compromised replica yields ciphertext. It is not end-to-end encryption: the service holds the keys and can read every message. Both are defensible designs, they defend against different adversaries, and conflating them in an interview is a fast way to lose the room. Say which one you built.

```go
package dm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

var ErrNotParticipant = errors.New("caller is not a participant in this conversation")

// DMService handles encrypted direct messages
type DMService struct {
	msgDB      DMMessageStore
	convDB     DMConversationStore
	connRouter ConnectionRouter
	pushSvc    PushService
	idGen      IDGenerator
	crypto     Cipher
}

type DMConversation struct {
	ID           int64     `json:"id"`
	Participants []int64   `json:"participants"`
	LastMessage  string    `json:"last_message"`
	LastSender   int64     `json:"last_sender"`
	UnreadCount  int       `json:"unread_count"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type DirectMessage struct {
	ID        int64      `json:"id"` // Snowflake ID
	ConvID    int64      `json:"conv_id"`
	SenderID  int64      `json:"sender_id"`
	Text      string     `json:"text"`
	MediaURL  string     `json:"media_url,omitempty"`
	ReadAt    *time.Time `json:"read_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

// SendDM sends a direct message to another user.
func (s *DMService) SendDM(ctx context.Context, senderID, recipientID int64, text string) (*DirectMessage, error) {
	if senderID == recipientID {
		return nil, errors.New("cannot DM yourself")
	}
	// Consent check before anything is stored. Without it the DM inbox is an
	// unfiltered channel from every account on the platform to every other one,
	// which is a harassment vector, not a feature.
	allowed, err := s.convDB.CanMessage(ctx, senderID, recipientID)
	if err != nil {
		return nil, fmt.Errorf("check dm permission: %w", err)
	}
	if !allowed {
		return nil, errors.New("recipient does not accept messages from this account")
	}

	conv, err := s.convDB.GetOrCreate(ctx, senderID, recipientID)
	if err != nil {
		return nil, fmt.Errorf("get conversation: %w", err)
	}

	id, err := s.idGen.Next()
	if err != nil {
		return nil, fmt.Errorf("generate id: %w", err)
	}
	ciphertext, err := s.crypto.Encrypt(ctx, text)
	if err != nil {
		return nil, fmt.Errorf("encrypt dm: %w", err)
	}

	msg := &DirectMessage{
		ID:        id,
		ConvID:    conv.ID,
		SenderID:  senderID,
		Text:      ciphertext,
		CreatedAt: time.Now().UTC(),
	}
	if err := s.msgDB.Create(ctx, msg); err != nil {
		return nil, fmt.Errorf("save dm: %w", err)
	}

	// Bump last-message metadata and the recipient's unread counter together.
	// The counter has to be incremented somewhere: a field the inbox renders
	// but nothing ever writes just reads zero forever.
	if err := s.convDB.RecordSend(ctx, conv.ID, ciphertext, senderID, recipientID); err != nil {
		return nil, fmt.Errorf("update conversation: %w", err)
	}

	// Deliver the plaintext over the already-encrypted transport. The stored
	// copy stays ciphertext.
	plain := *msg
	plain.Text = text
	data, err := json.Marshal(plain)
	if err != nil {
		return nil, fmt.Errorf("marshal dm: %w", err)
	}

	// Best effort from here. The message is durable, so a delivery failure must
	// not fail the send.
	if err := s.connRouter.DeliverToUser(ctx, fmt.Sprint(recipientID), data); err != nil {
		if err := s.pushSvc.Send(ctx, recipientID, "New message", "You have a new direct message"); err != nil {
			slog.WarnContext(ctx, "push delivery failed", "recipient", recipientID, "error", err)
		}
	}

	return &plain, nil
}

// GetConversation returns paginated DM history for a caller who is allowed to
// read it. viewerID is not optional: a conversation ID is a guessable integer,
// so without this check any user can page through any conversation on the
// platform by incrementing a number.
func (s *DMService) GetConversation(ctx context.Context, viewerID, convID, beforeID int64, limit int) ([]DirectMessage, error) {
	ok, err := s.convDB.IsParticipant(ctx, convID, viewerID)
	if err != nil {
		return nil, fmt.Errorf("authorize conversation read: %w", err)
	}
	if !ok {
		// Same error whether the conversation is someone else's or does not
		// exist, so the response cannot be used to probe which IDs are real.
		return nil, ErrNotParticipant
	}

	msgs, err := s.msgDB.GetMessages(ctx, convID, beforeID, limit)
	if err != nil {
		return nil, fmt.Errorf("load messages: %w", err)
	}
	for i := range msgs {
		text, err := s.crypto.Decrypt(ctx, msgs[i].Text)
		if err != nil {
			return nil, fmt.Errorf("decrypt message %d: %w", msgs[i].ID, err)
		}
		msgs[i].Text = text
	}
	return msgs, nil
}
```

---
