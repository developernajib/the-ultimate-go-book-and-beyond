## Deep Dive: Notification Batching

When a viral post receives thousands of likes per minute, sending an individual push notification for each one would be both annoying to the user and wasteful of system resources. The notification batcher solves this by collecting related events over a short time window and combining them into a single, readable message like "Alice, Bob, and 98 others liked your post." This pattern is used by every major social platform and dramatically reduces push notification volume while keeping users informed.

```go
package notification

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Prevents notification spam: instead of 100 "X liked your post",
// sends one "X, Y, and 98 others liked your post"
type NotificationBatcher struct {
	pending       map[string]*BatchedNotification
	mu            sync.Mutex
	flushInterval time.Duration
	pusher        PushNotificationService
}

type BatchedNotification struct {
	RecipientID string
	Type        string   // like, comment, follow
	TargetID    string   // post_id
	ActorIDs    []string
	FirstAt     time.Time
}

func NewNotificationBatcher(pusher PushNotificationService, flushInterval time.Duration) *NotificationBatcher {
	return &NotificationBatcher{
		pending:       make(map[string]*BatchedNotification),
		flushInterval: flushInterval,
		pusher:        pusher,
	}
}

func (nb *NotificationBatcher) AddEvent(recipientID, notifType, targetID, actorID string) {
	key := fmt.Sprintf("%s:%s:%s", recipientID, notifType, targetID)
	nb.mu.Lock()
	defer nb.mu.Unlock()

	if batch, exists := nb.pending[key]; exists {
		batch.ActorIDs = append(batch.ActorIDs, actorID)
	} else {
		nb.pending[key] = &BatchedNotification{
			RecipientID: recipientID,
			Type:        notifType,
			TargetID:    targetID,
			ActorIDs:    []string{actorID},
			FirstAt:     time.Now(),
		}
	}
}

// Run flushes pending batches every flushInterval until ctx is cancelled
func (nb *NotificationBatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(nb.flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			nb.flush(ctx)
		}
	}
}

// flush swaps out the pending map under the lock, then sends without
// holding it so slow pushes never block AddEvent
func (nb *NotificationBatcher) flush(ctx context.Context) {
	nb.mu.Lock()
	batches := nb.pending
	nb.pending = make(map[string]*BatchedNotification)
	nb.mu.Unlock()

	for _, batch := range batches {
		nb.sendBatched(ctx, batch)
	}
}

// sendBatched formats the message. In production the actor IDs are
// resolved to display names before formatting.
func (nb *NotificationBatcher) sendBatched(ctx context.Context, batch *BatchedNotification) {
	count := len(batch.ActorIDs)
	var msg string
	switch {
	case count == 1:
		msg = fmt.Sprintf("%s liked your post", batch.ActorIDs[0])
	case count == 2:
		msg = fmt.Sprintf("%s and %s liked your post", batch.ActorIDs[0], batch.ActorIDs[1])
	default:
		msg = fmt.Sprintf("%s, %s, and %d others liked your post",
			batch.ActorIDs[0], batch.ActorIDs[1], count-2)
	}
	nb.pusher.Send(ctx, batch.RecipientID, msg)
}
```

---
