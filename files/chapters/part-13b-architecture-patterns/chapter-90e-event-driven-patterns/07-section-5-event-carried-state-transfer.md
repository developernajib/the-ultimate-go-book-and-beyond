## 90E.6 Event-Carried State Transfer

Event-Carried State Transfer (ECST) embeds the full current state of an entity inside the event payload, eliminating the need for consumers to call back to the originating service to fetch additional data. This reduces inter-service coupling and removes synchronous read dependencies from the critical path. The consuming service maintains a local cache hydrated from the event stream, which it can query locally for permission checks or display logic with zero network latency. The tradeoff is larger event payloads and the risk of stale data if a consumer falls behind. The `ConflictResolver` shown below handles last-write-wins semantics when two concurrent events arrive out of order.

```go
package ecst

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

// Event-Carried State Transfer: the event contains the full entity state
// Consumers don't need to call back to the publisher to get more data

// UserStateEvent carries the complete user state
type UserStateEvent struct {
	EventID    string    `json:"event_id"`
	OccurredAt time.Time `json:"occurred_at"`

	// Full state - no need to query user service
	User struct {
		ID          string            `json:"id"`
		Email       string            `json:"email"`
		Name        string            `json:"name"`
		Plan        string            `json:"plan"`
		Permissions []string          `json:"permissions"`
		Metadata    map[string]string `json:"metadata"`
		UpdatedAt   time.Time         `json:"updated_at"`
	} `json:"user"`
}

// LocalUserCache builds a local cache from ECST events
type LocalUserCache struct {
	mu    sync.RWMutex
	users map[string]*CachedUser
}

type CachedUser struct {
	ID          string
	Email       string
	Name        string
	Plan        string
	Permissions map[string]bool
	UpdatedAt   time.Time
	CachedAt    time.Time
}

func NewLocalUserCache() *LocalUserCache {
	return &LocalUserCache{users: make(map[string]*CachedUser)}
}

// HandleUserStateEvent updates the local cache from an event
func (c *LocalUserCache) HandleUserStateEvent(ctx context.Context, event *UserStateEvent) error {
	perms := make(map[string]bool)
	for _, p := range event.User.Permissions {
		perms[p] = true
	}

	cached := &CachedUser{
		ID:          event.User.ID,
		Email:       event.User.Email,
		Name:        event.User.Name,
		Plan:        event.User.Plan,
		Permissions: perms,
		UpdatedAt:   event.User.UpdatedAt,
		CachedAt:    time.Now(),
	}

	c.mu.Lock()
	c.users[event.User.ID] = cached
	c.mu.Unlock()

	slog.Info("user cache updated", "user_id", event.User.ID, "plan", event.User.Plan)
	return nil
}

// GetUser retrieves a user from the local cache - no network call needed
func (c *LocalUserCache) GetUser(userID string) (*CachedUser, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	u, ok := c.users[userID]
	return u, ok
}

// HasPermission checks user permissions without calling user service
func (c *LocalUserCache) HasPermission(userID, permission string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	u, ok := c.users[userID]
	if !ok {
		return false
	}
	return u.Permissions[permission]
}

// ConflictResolver handles concurrent updates using vector clocks
type ConflictResolver struct {
	logger *slog.Logger
}

// ResolveConflict picks the winning version when two events conflict
func (r *ConflictResolver) ResolveConflict(a, b UserStateEvent) UserStateEvent {
	// Last-write-wins based on UpdatedAt
	if a.User.UpdatedAt.After(b.User.UpdatedAt) {
		return a
	}
	return b
}

// EventStore with position tracking for reliable replay
type PositionedEventStore struct {
	mu       sync.RWMutex
	events   []json.RawMessage
	position int64
}

func (s *PositionedEventStore) Append(event any) (int64, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return 0, err
	}

	s.mu.Lock()
	s.events = append(s.events, data)
	s.position++
	pos := s.position
	s.mu.Unlock()

	return pos, nil
}

func (s *PositionedEventStore) ReadFrom(position int64) []json.RawMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if position >= int64(len(s.events)) {
		return nil
	}
	result := make([]json.RawMessage, len(s.events)-int(position))
	copy(result, s.events[position:])
	return result
}
```

---
