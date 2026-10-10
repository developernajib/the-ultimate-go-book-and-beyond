## Production Go Implementation: Message Retention and Cleanup

The server is a relay, not an archive: it keeps a message only long enough to deliver it. Once every intended device has it, the server copy is dead weight, and the design already reflects this in the `default_time_to_live = 2592000` on the `messages` table, which expires anything still around after 30 days without a cleanup job touching it.

Two clarifications keep this honest. Deletion is *after delivery to every device*, not after the first, because multi-device sync means a laptop that has been shut for a week still needs the backlog when it wakes up. And the TTL is the backstop rather than the mechanism: it bounds worst-case retention, while this service reclaims space sooner for the common case. Saying messages are deleted the instant they are delivered would contradict both the 30-day offline queue and multi-device sync, which are load-bearing parts of this design.

Account deletion is the harder half, and it contains a trap worth dwelling on. It is tempting to enumerate the user's conversations and delete each one. That destroys the *other* participant's messages: Alice closing her account would erase Bob's side of their chat from Bob's own history. Under GDPR that is not merely a bug, it is processing another data subject's data without any basis to. A conversation is shared, and the erasure right covers your personal data, not the record of everyone who spoke to you. The correct scope is the rows the user authored, plus their account, devices, keys, and queues. The peer's messages stay, with the departed user's identity reduced to a tombstone.

```go
package retention

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"
)

// RetentionService cleans up delivered messages and handles account deletion.
//
// This service is an optimization on top of the messages table's 30-day TTL,
// not a correctness requirement. If it stops running, storage grows until the
// TTL reclaims it. That ordering matters: the durable guarantee should never
// depend on a cron job having succeeded.
type RetentionService struct {
	msgDB   MessageStore
	mediaDB MediaStore
	groupDB GroupStore
	blobs   BlobStore
	queues  QueueStore
	keys    KeyStore
}

// CleanupDeliveredMessages removes server-side copies of messages that every
// intended device has already received.
func (s *RetentionService) CleanupDeliveredMessages(ctx context.Context, olderThan time.Duration) (int, error) {
	cutoff := time.Now().Add(-olderThan)

	delivered, err := s.msgDB.FindDelivered(ctx, cutoff)
	if err != nil {
		return 0, fmt.Errorf("find delivered: %w", err)
	}

	deleted := 0
	for _, msg := range delivered {
		// Respect cancellation: this loop can run for a long time, and a
		// shutdown should stop it rather than let it grind on.
		if err := ctx.Err(); err != nil {
			return deleted, err
		}

		// A group message is only spent once every member has it. Note this
		// check must fail closed: an error here means "we do not know", and
		// deleting on "do not know" destroys a message someone never received.
		if msg.GroupID != "" {
			allDelivered, err := s.msgDB.AllMembersDelivered(ctx, msg.ConvID, msg.ID)
			if err != nil {
				log.Printf("retention: delivery check %s: %v", msg.ID, err)
				continue
			}
			if !allDelivered {
				continue
			}
		}

		// Media first, then the row. The row is the only pointer to the blob,
		// so deleting it first orphans the object in S3 forever: it becomes
		// unreferenced, unbilled to any user, and impossible to find again.
		// Failing in this order leaves a row pointing at a missing blob, which
		// a client reports and a human can fix. Orphans are silent.
		if msg.MediaKey != "" {
			if err := s.blobs.Delete(ctx, msg.MediaKey); err != nil {
				log.Printf("retention: delete media %s: %v", msg.MediaKey, err)
				continue
			}
		}

		if err := s.msgDB.Delete(ctx, msg.ConvID, msg.ID); err != nil {
			log.Printf("retention: delete message %s: %v", msg.ID, err)
			continue
		}
		deleted++
	}

	return deleted, nil
}

// DeleteAccount erases a user's personal data (GDPR Article 17).
//
// Scope is the point. It deletes what this user authored and everything that
// identifies them. It does NOT delete conversations, because a conversation is
// shared: erasing "every conversation Alice is in" would take Bob's own
// messages with it. Bob's messages are Bob's personal data, and Alice has no
// right to erase them.
//
// Errors are collected rather than dropped. The original returned nil
// unconditionally, so a total failure to delete anything reported success to
// whatever compliance workflow called it, which is the worst possible failure
// mode for a legal obligation.
func (s *RetentionService) DeleteAccount(ctx context.Context, userID string) error {
	var errs []error

	// 1. Stop new traffic reaching the account: kill keys and devices first, so
	// nothing can open a fresh session mid-deletion.
	if err := s.keys.DeleteAllForUser(ctx, userID); err != nil {
		errs = append(errs, fmt.Errorf("delete keys: %w", err))
	}
	if err := s.queues.DeleteOfflineQueue(ctx, userID); err != nil {
		errs = append(errs, fmt.Errorf("delete offline queue: %w", err))
	}

	// 2. Leave every group. The group survives, the membership does not.
	groups, err := s.groupDB.GetUserGroups(ctx, userID)
	if err != nil {
		errs = append(errs, fmt.Errorf("get groups: %w", err))
	}
	for _, g := range groups {
		if err := s.groupDB.RemoveMember(ctx, g.ID, userID); err != nil {
			errs = append(errs, fmt.Errorf("leave group %s: %w", g.ID, err))
		}
	}

	// 3. Delete only the messages this user authored, wherever they are.
	// The peer's messages in the same conversation are untouched.
	if err := s.msgDB.DeleteMessagesBySender(ctx, userID); err != nil {
		errs = append(errs, fmt.Errorf("delete authored messages: %w", err))
	}

	// 4. Media this user uploaded.
	if err := s.mediaDB.DeleteAllForUser(ctx, userID); err != nil {
		errs = append(errs, fmt.Errorf("delete media: %w", err))
	}

	// 5. The profile last, so a retry can still find the account if any of the
	// above failed. Deleting the identity first would strand the rest with no
	// handle to resume from.
	if len(errs) == 0 {
		if err := s.msgDB.DeleteProfile(ctx, userID); err != nil {
			errs = append(errs, fmt.Errorf("delete profile: %w", err))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("account deletion incomplete for %s: %w", userID, errors.Join(errs...))
	}
	return nil
}
```

---
