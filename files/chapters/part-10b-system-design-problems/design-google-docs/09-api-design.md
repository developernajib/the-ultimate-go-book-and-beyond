## API Design

The API layer has two distinct parts: a traditional REST API for document management (create, share, list versions) and a WebSocket protocol for real-time collaborative editing. REST handles operations that happen infrequently and can tolerate higher latency, while WebSocket provides the low-latency bidirectional channel needed to stream individual keystrokes between editors. This separation keeps the system clean: CRUD operations go through REST, and real-time collaboration flows through WebSocket.

### REST and WebSocket Endpoints

The REST endpoints cover document CRUD, sharing, version history, and commenting. Each request type is defined as a Go struct with validation tags, matching the JSON wire format that clients send and receive.

```go
package api

import "time"

// POST /api/v1/documents
type CreateDocumentRequest struct {
	Title string `json:"title" validate:"max=500"`
	Template string `json:"template,omitempty"`
}

type CreateDocumentResponse struct {
	ID string `json:"id"`; Title string `json:"title"`
	OwnerID string `json:"owner_id"`; WebSocketURL string `json:"websocket_url"`
	CreatedAt time.Time `json:"created_at"`
}

// GET /api/v1/documents/{doc_id}
type GetDocumentResponse struct {
	ID string `json:"id"`; Title string `json:"title"`; Revision int `json:"revision"`
	Size int64 `json:"size"`; Collaborators []Collaborator `json:"collaborators"`
	CreatedAt time.Time `json:"created_at"`; UpdatedAt time.Time `json:"updated_at"`
}

type Collaborator struct {
	UserID string `json:"user_id"`; Name string `json:"name"`
	Role string `json:"role"`; Online bool `json:"online"`
}

// POST /api/v1/documents/{doc_id}/share
type ShareDocumentRequest struct {
	Email string `json:"email" validate:"required,email"`
	Role string `json:"role" validate:"required,oneof=editor commenter viewer"`
}

// GET /api/v1/documents/{doc_id}/versions?limit=50
type VersionListResponse struct {
	Versions []VersionInfo `json:"versions"`
}
type VersionInfo struct {
	Revision int `json:"revision"`; SavedBy string `json:"saved_by"`
	SavedAt time.Time `json:"saved_at"`; Changes int `json:"changes"`
}

// POST /api/v1/documents/{doc_id}/comments
type CreateCommentRequest struct {
	Text string `json:"text" validate:"required,max=2000"`
	AnchorStart int `json:"anchor_start"`; AnchorEnd int `json:"anchor_end"`
	ParentID string `json:"parent_id,omitempty"`
}
```

### WebSocket Protocol

The WebSocket channel carries two types of client messages: operational transforms (`op`) that represent document edits, and cursor updates (`cursor`) that broadcast each collaborator's selection position. The server responds with the initial document state on connect (`init`), acknowledgments for accepted operations (`ack`), transformed operations from other editors (`op`), relayed cursor positions (`cursor`), and presence events when collaborators join or leave (`presence`).

```go
// Client -> Server on ws://docs.example.com/ws/{doc_id}
type ClientMsg struct {
	Type string `json:"type"` // "op", "cursor", "ping"
	Op *OpPayload `json:"op,omitempty"`
	Cursor *CursorUpd `json:"cursor,omitempty"`
}
type OpPayload struct { Revision int `json:"revision"`; Ops []Op `json:"ops"` }
type CursorUpd struct { Position int `json:"position"`; SelectTo int `json:"select_to"` }

// Server -> Client
type ServerMsg struct {
	Type string `json:"type"` // "init", "op", "ack", "cursor", "presence"
	Init *InitPayload `json:"init,omitempty"`
	Op *OpBroadcast `json:"op,omitempty"`
	Ack *AckPayload `json:"ack,omitempty"`
	Cursor *CursorBroadcast `json:"cursor,omitempty"`
	Presence *PresenceUpd `json:"presence,omitempty"`
}
type InitPayload struct { Content string `json:"content"`; Revision int `json:"revision"` }
type OpBroadcast struct { UserID string `json:"user_id"`; Revision int `json:"revision"`; Ops []Op `json:"ops"` }
type AckPayload struct { Revision int `json:"revision"` }
type CursorBroadcast struct { UserID string `json:"user_id"`; Position int `json:"position"`; SelectTo int `json:"select_to"` }
type PresenceUpd struct { UserID string `json:"user_id"`; Event string `json:"event"` }
```

---
