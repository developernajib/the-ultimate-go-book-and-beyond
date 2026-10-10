## Deep Dive: Notification Service for Multi-Device Sync

The notification service is responsible for pushing real-time change events to all of a user's connected devices. It uses a combination of Redis Pub/Sub for cross-server communication and in-memory subscriber channels for locally connected devices. When a file changes, the metadata service publishes an event, and every API server that holds a long-poll connection for that user receives the message and wakes up the waiting client. The channel-based subscriber pattern below is idiomatic Go, each connected device gets its own buffered channel, and if the channel is full (slow device), the event is dropped because the device will catch up via cursor-based polling on its next sync.

```go
package notification

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// SyncNotificationService notifies all devices when files change
type SyncNotificationService struct {
	rdb         *redis.Client
	subscribers map[string][]chan ChangeEvent // userID -> device channels
	mu          sync.RWMutex
}

type ChangeEvent struct {
	UserID    string    `json:"user_id"`
	Path      string    `json:"path"`
	Action    string    `json:"action"` // modified, created, deleted, moved
	Revision  int       `json:"revision"`
	Timestamp time.Time `json:"timestamp"`
}

// PublishChange broadcasts to all connected devices
func (s *SyncNotificationService) PublishChange(ctx context.Context, event ChangeEvent) error {
	// Publish to Redis Pub/Sub for cross-server notification
	data, _ := json.Marshal(event)
	s.rdb.Publish(ctx, fmt.Sprintf("sync:%s", event.UserID), data)

	// Notify locally connected devices
	s.mu.RLock()
	defer s.mu.RUnlock()
	if channels, ok := s.subscribers[event.UserID]; ok {
		for _, ch := range channels {
			select {
			case ch <- event:
			default: // channel full, device catches up via polling
			}
		}
	}
	return nil
}

// WaitForChange blocks until a change occurs or timeout (for long-poll)
func (s *SyncNotificationService) WaitForChange(ctx context.Context, userID string, timeout time.Duration) bool {
	ch := make(chan ChangeEvent, 1)
	s.mu.Lock()
	s.subscribers[userID] = append(s.subscribers[userID], ch)
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		channels := s.subscribers[userID]
		for i, c := range channels {
			if c == ch {
				s.subscribers[userID] = append(channels[:i], channels[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
		close(ch)
	}()

	select {
	case <-ch:
		return true
	case <-time.After(timeout):
		return false
	case <-ctx.Done():
		return false
	}
}
```

---
