## Production Go Implementation: Real-Time Cursor Broadcasting

Seeing other users' cursors in real time is one of the most recognizable features of Google Docs. The cursor manager is intentionally lightweight and ephemeral: cursor positions are never persisted to the database because they change with every keystroke and have no value after a session ends. Each user is assigned a unique color from a predefined palette so their cursor and selection highlights are visually distinct. Stale cursors (from users who disconnected without a clean close) are automatically filtered out after 30 seconds of inactivity.

```go
package cursor

import (
	"encoding/json"
	"sync"
	"time"
)

// CursorManager handles real-time cursor position broadcasting
// Cursors are ephemeral, never persisted to the database
type CursorManager struct {
	mu      sync.RWMutex
	cursors map[string]*UserCursor // userID -> cursor state
	colors  []string
	nextColor int
}

type UserCursor struct {
	UserID   string `json:"user_id"`
	Name     string `json:"name"`
	Color    string `json:"color"`
	Position int    `json:"position"`
	SelectTo int    `json:"select_to"` // -1 if no selection
	LastSeen time.Time `json:"-"`
}

func NewCursorManager() *CursorManager {
	return &CursorManager{
		cursors: make(map[string]*UserCursor),
		colors: []string{
			"#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
			"#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
			"#BB8FCE", "#85C1E9", "#F0B27A", "#82E0AA",
		},
	}
}

// UpdateCursor records a user's cursor position
func (m *CursorManager) UpdateCursor(userID, name string, position, selectTo int) {
	m.mu.Lock()
	defer m.mu.Unlock()

	cursor, ok := m.cursors[userID]
	if !ok {
		cursor = &UserCursor{
			UserID: userID,
			Name:   name,
			Color:  m.colors[m.nextColor%len(m.colors)],
		}
		m.nextColor++
		m.cursors[userID] = cursor
	}

	cursor.Position = position
	cursor.SelectTo = selectTo
	cursor.LastSeen = time.Now()
}

// RemoveCursor removes a user's cursor when they disconnect
func (m *CursorManager) RemoveCursor(userID string) {
	m.mu.Lock()
	delete(m.cursors, userID)
	m.mu.Unlock()
}

// GetAllCursors returns all active cursors for broadcasting
func (m *CursorManager) GetAllCursors() []UserCursor {
	m.mu.RLock()
	defer m.mu.RUnlock()

	cursors := make([]UserCursor, 0, len(m.cursors))
	for _, c := range m.cursors {
		// Skip stale cursors (user might have disconnected without cleanup)
		if time.Since(c.LastSeen) > 30*time.Second {
			continue
		}
		cursors = append(cursors, *c)
	}
	return cursors
}

// BroadcastCursorUpdate sends one user's cursor change to all other users
func (m *CursorManager) BroadcastCursorUpdate(userID string, clients map[string]*DocClient) {
	// Copy the cursor value while holding the lock: marshaling the
	// shared pointer after unlock would race with UpdateCursor
	m.mu.RLock()
	cursor, ok := m.cursors[userID]
	var snapshot UserCursor
	if ok { snapshot = *cursor }
	m.mu.RUnlock()
	if !ok { return }

	data, _ := json.Marshal(map[string]any{
		"type":   "cursor",
		"cursor": snapshot,
	})

	for uid, client := range clients {
		if uid != userID {
			select {
			case client.send <- data:
			default:
			}
		}
	}
}
```

---
