## Deep Dive: Push Notifications and Read Receipts

When a user is offline (their WebSocket is disconnected), the system needs another way to alert them about new messages. Push notifications solve this by sending a lightweight alert through Apple's APNs or Google's FCM to wake up the app on the device.

E2E encryption shapes this more than it first appears. The server cannot put the message text in the push body, because it does not have the message text. But notice that the naive fix, a body reading "New message from Alice", hands Apple or Google the sender's identity and the exact time, for every message. That is precisely the metadata E2E does not protect, and here you would be volunteering it to a third party rather than merely failing to hide it from yourself. The better pattern is to send a *contentless* push whose only job is to wake the app, and let the woken client pull the message over its own connection and decrypt it locally. Apple supports exactly this: a notification service extension can rewrite the notification on-device before it is displayed, so the user sees "Alice: see you at 8" while APNs only ever carried an opaque wakeup. The push is a doorbell, not an envelope.

```go
package notification

import (
	"context"
	"fmt"
	"log"
)

type NotificationService struct {
	apns     APNSClient
	fcm      FCMClient
	deviceDB DeviceStore
}

// SendWakeup sends a contentless push whose only purpose is to wake the app so
// it can fetch and decrypt the message itself.
//
// No title, no body, no sender name: nothing that would tell APNs or FCM who is
// talking to whom. The device shows the real content after decrypting locally.
//
// Errors are returned rather than dropped. A device whose token has been
// revoked must be pruned, or its dead token is retried forever on every message
// the user receives.
func (s *NotificationService) SendWakeup(ctx context.Context, userID string) error {
	devs, err := s.deviceDB.GetDevices(ctx, userID)
	if err != nil {
		return fmt.Errorf("get devices for %s: %w", userID, err)
	}

	var failed int
	for _, d := range devs {
		var err error
		switch d.Platform {
		case "ios":
			err = s.apns.SendSilent(ctx, d.Token)
		case "android":
			err = s.fcm.SendData(ctx, d.Token)
		default:
			continue
		}
		if err == nil {
			continue
		}
		if isInvalidToken(err) {
			// The app was uninstalled or the token rotated. Drop it.
			if delErr := s.deviceDB.RemoveDevice(ctx, userID, d.Token); delErr != nil {
				log.Printf("prune device %s: %v", d.Token, delErr)
			}
			continue
		}
		failed++
		log.Printf("push to %s (%s): %v", userID, d.Platform, err)
	}

	if failed > 0 {
		return fmt.Errorf("%d of %d pushes failed for %s", failed, len(devs), userID)
	}
	return nil
}
```

Read receipts track delivery and read timestamps per message and forward those status updates back to the original sender. The state machine is `sent → delivered → read`, the familiar one tick, two ticks, two blue ticks. It only ever moves forward: a late-arriving `delivered` must never overwrite a `read` that already landed, which is why the transitions are guarded rather than blindly applied.

```go
package receipt

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/gocql/gocql"
)

type ReceiptTracker struct {
	msgSvc MessageService
	auth   Authorizer // participant checks
	conn   ConnectionRouter
}

// StatusUpdate is what the original sender receives. The message ID is the
// point of the whole exercise: a bare "delivered" string tells a client that
// something was delivered but not which message, so it cannot move any tick.
type StatusUpdate struct {
	Type      string     `json:"type"` // "delivered" | "read"
	ConvID    string     `json:"conv_id"`
	MessageID gocql.UUID `json:"message_id"`
	At        time.Time  `json:"at"`
}

// ProcessDelivery records that reporterID's device received a message.
//
// reporterID comes from the authenticated session, never from the payload.
// Without the membership check, anyone who can guess a conv_id and a message ID
// could mark another pair's messages as delivered, and, more usefully to an
// attacker, probe which message IDs exist.
func (t *ReceiptTracker) ProcessDelivery(ctx context.Context, reporterID, convID string, msgID gocql.UUID, ts time.Time) error {
	ok, err := t.auth.IsParticipant(ctx, convID, reporterID)
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if !ok {
		return ErrNotFound
	}

	msg, err := t.msgSvc.Get(ctx, convID, msgID)
	if err != nil {
		return fmt.Errorf("load message: %w", err)
	}
	if msg.SenderID == reporterID {
		return nil // your own message, nothing to report
	}
	if err := t.msgSvc.UpdateDelivered(ctx, convID, msgID, ts); err != nil {
		return fmt.Errorf("update delivered: %w", err)
	}

	return t.notify(ctx, msg.SenderID, StatusUpdate{
		Type: "delivered", ConvID: convID, MessageID: msgID, At: ts,
	})
}

// ProcessRead marks every message the reader had not yet read and tells each
// distinct sender.
func (t *ReceiptTracker) ProcessRead(ctx context.Context, readerID, convID string) error {
	ok, err := t.auth.IsParticipant(ctx, convID, readerID)
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if !ok {
		return ErrNotFound
	}

	// One query returning the messages, not a list of IDs followed by a Get per
	// ID. In a group of 1,024 that N+1 is 1,024 round trips to mark one screen
	// of messages as read.
	msgs, err := t.msgSvc.GetUnread(ctx, convID, readerID)
	if err != nil {
		return fmt.Errorf("get unread: %w", err)
	}
	if len(msgs) == 0 {
		return nil
	}

	now := time.Now()
	ids := make([]gocql.UUID, 0, len(msgs))
	for _, m := range msgs {
		ids = append(ids, m.ID)
	}
	if err := t.msgSvc.UpdateReadBatch(ctx, convID, ids, now); err != nil {
		return fmt.Errorf("update read: %w", err)
	}

	// Collapse to one notification per sender per message. Senders is a set
	// because a group conversation has many messages from the same person.
	for _, m := range msgs {
		if m.SenderID == readerID {
			continue
		}
		if err := t.notify(ctx, m.SenderID, StatusUpdate{
			Type: "read", ConvID: convID, MessageID: m.ID, At: now,
		}); err != nil {
			// A sender being offline is normal and not a failure of this
			// operation: the receipt is already durable, and they will see it
			// when they resync.
			continue
		}
	}
	return nil
}

func (t *ReceiptTracker) notify(ctx context.Context, userID string, u StatusUpdate) error {
	data, err := json.Marshal(u)
	if err != nil {
		return err
	}
	return t.conn.DeliverToUser(ctx, userID, data)
}
```

One design note that interviewers like to probe: read receipts in large groups are a fan-out multiplier working against you. Every member reading a message generates a receipt to the sender, so one message to a 1,024-member group can produce 1,023 delivery receipts and 1,023 read receipts. The message fans out once, the receipts fan out twice more. This is why WhatsApp shows read receipts in groups only as an aggregate "read by" list rather than streaming per-member ticks in real time, and why receipts are a natural thing to batch, coalesce, or sample well before message delivery itself needs that treatment.

---
