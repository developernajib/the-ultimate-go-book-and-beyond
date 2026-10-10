## Core Components

The collaborative editing system is built from four main components: the OT engine that resolves conflicts between simultaneous edits, the document server that manages WebSocket connections and coordinates clients, the storage layer that persists documents and their version history, and the permissions service that controls who can view or edit each document. Each component is designed to be independently scalable and testable.

### 1. Operational Transform Engine

The Operational Transform (OT) engine is the mathematical heart of collaborative editing. Each client edit is represented as a sequence of `Op` primitives, retain (advance the cursor), insert (add text), and delete (remove text), following the Quill Delta format. When two clients edit the same document simultaneously, the OT engine transforms one operation against the other so that applying both in either order always produces the same final document state. The `revision` field on each operation is the key to conflict resolution: the server transforms incoming operations against all operations applied since the client's last known revision.

```go
package ot

import (
	"fmt"
)

// Operation represents a single document edit
type Operation struct {
	DocID     string     `json:"doc_id"`
	UserID    string     `json:"user_id"`
	Revision  int        `json:"revision"` // server revision this op is based on
	Ops       []Op       `json:"ops"`
	Timestamp int64      `json:"timestamp"`
}

// Op is a single atomic operation (retain, insert, delete)
// Based on the Quill Delta format, a widely used OT operation encoding
type Op struct {
	Retain int    `json:"retain,omitempty"` // advance cursor N chars
	Insert string `json:"insert,omitempty"` // insert text at cursor
	Delete int    `json:"delete,omitempty"` // delete N chars at cursor
	Attrs  *Attrs `json:"attrs,omitempty"`  // formatting
}

// Attrs represents text formatting attributes
type Attrs struct {
	Bold      bool   `json:"bold,omitempty"`
	Italic    bool   `json:"italic,omitempty"`
	Underline bool   `json:"underline,omitempty"`
	FontSize  int    `json:"font_size,omitempty"`
	Color     string `json:"color,omitempty"`
	Link      string `json:"link,omitempty"`
}

// OTEngine manages document state and transforms concurrent operations
type OTEngine struct {
	docID    string
	revision int
	history  []Operation // ordered log of all applied operations
	content  string      // current document content (simplified; real = rich tree)
}

// Apply applies an incoming operation from a client
// Returns the transformed operation and new revision
func (e *OTEngine) Apply(incoming Operation) (Operation, int, error) {
	// Transform incoming op against all ops since the client's revision.
	// history[0] corresponds to the revision the engine was loaded at, so
	// convert the client's absolute revision into a history index first.
	base := e.revision - len(e.history)
	if incoming.Revision < base {
		return Operation{}, 0, fmt.Errorf("revision %d predates in-memory history (base %d)", incoming.Revision, base)
	}
	transformed := incoming
	for i := incoming.Revision - base; i < len(e.history); i++ {
		serverOp := e.history[i]
		var err error
		transformed.Ops, _, err = transform(transformed.Ops, serverOp.Ops)
		if err != nil {
			return Operation{}, 0, fmt.Errorf("transform error: %w", err)
		}
	}

	// Apply transformed operation to document
	e.content = applyOps(e.content, transformed.Ops)
	transformed.Revision = e.revision
	e.history = append(e.history, transformed)
	e.revision++

	return transformed, e.revision, nil
}

// transform computes transform(clientOps, serverOps) → (clientOps', serverOps')
// such that: apply(apply(doc, serverOps), clientOps') == apply(apply(doc, clientOps), serverOps')
func transform(clientOps, serverOps []Op) ([]Op, []Op, error) {
	var client1, server1 []Op
	ci, si := 0, 0

	for ci < len(clientOps) || si < len(serverOps) {
		var cop, sop *Op
		if ci < len(clientOps) {
			c := clientOps[ci]
			cop = &c
		}
		if si < len(serverOps) {
			s := serverOps[si]
			sop = &s
		}

		switch {
		// Both are retain
		case cop != nil && cop.Retain > 0 && sop != nil && sop.Retain > 0:
			minR := min(cop.Retain, sop.Retain)
			client1 = append(client1, Op{Retain: minR})
			server1 = append(server1, Op{Retain: minR})
			clientOps[ci].Retain -= minR
			serverOps[si].Retain -= minR
			if clientOps[ci].Retain == 0 {
				ci++
			}
			if serverOps[si].Retain == 0 {
				si++
			}

		// Client inserts
		case cop != nil && cop.Insert != "":
			client1 = append(client1, Op{Insert: cop.Insert, Attrs: cop.Attrs})
			server1 = append(server1, Op{Retain: len(cop.Insert)})
			ci++

		// Server inserts
		case sop != nil && sop.Insert != "":
			client1 = append(client1, Op{Retain: len(sop.Insert)})
			server1 = append(server1, Op{Insert: sop.Insert, Attrs: sop.Attrs})
			si++

		// Both delete at the same position, idempotent
		case cop != nil && cop.Delete > 0 && sop != nil && sop.Delete > 0:
			minD := min(cop.Delete, sop.Delete)
			// Both deleted the same chars, so neither needs to delete again
			clientOps[ci].Delete -= minD
			serverOps[si].Delete -= minD
			if clientOps[ci].Delete == 0 {
				ci++
			}
			if serverOps[si].Delete == 0 {
				si++
			}

		// Client deletes, server has retain
		case cop != nil && cop.Delete > 0 && sop != nil && sop.Retain > 0:
			minD := min(cop.Delete, sop.Retain)
			client1 = append(client1, Op{Delete: minD})
			clientOps[ci].Delete -= minD
			serverOps[si].Retain -= minD
			if clientOps[ci].Delete == 0 {
				ci++
			}
			if serverOps[si].Retain == 0 {
				si++
			}

		// Server deletes, client has retain
		case sop != nil && sop.Delete > 0 && cop != nil && cop.Retain > 0:
			minD := min(sop.Delete, cop.Retain)
			server1 = append(server1, Op{Delete: minD})
			serverOps[si].Delete -= minD
			clientOps[ci].Retain -= minD
			if serverOps[si].Delete == 0 {
				si++
			}
			if clientOps[ci].Retain == 0 {
				ci++
			}

		// Server ops exhausted: leftover client retain spans the untouched tail
		// (Quill Deltas omit trailing retains, so this is the common case)
		case sop == nil && cop != nil && cop.Retain > 0:
			client1 = append(client1, Op{Retain: cop.Retain})
			server1 = append(server1, Op{Retain: cop.Retain})
			ci++

		// Server ops exhausted: leftover client delete still applies
		case sop == nil && cop != nil && cop.Delete > 0:
			client1 = append(client1, Op{Delete: cop.Delete})
			ci++

		// Client ops exhausted: leftover server retain spans the untouched tail
		case cop == nil && sop != nil && sop.Retain > 0:
			client1 = append(client1, Op{Retain: sop.Retain})
			server1 = append(server1, Op{Retain: sop.Retain})
			si++

		// Client ops exhausted: leftover server delete still applies
		case cop == nil && sop != nil && sop.Delete > 0:
			server1 = append(server1, Op{Delete: sop.Delete})
			si++

		default:
			// Zero-length or malformed op, skip it
			if cop != nil {
				ci++
			}
			if sop != nil {
				si++
			}
		}
	}

	return client1, server1, nil
}

// applyOps applies a list of ops to a string document
func applyOps(doc string, ops []Op) string {
	var result []byte
	pos := 0
	for _, op := range ops {
		switch {
		case op.Retain > 0:
			end := pos + op.Retain
			if end > len(doc) {
				end = len(doc)
			}
			result = append(result, doc[pos:end]...)
			pos = end
		case op.Insert != "":
			result = append(result, op.Insert...)
		case op.Delete > 0:
			pos += op.Delete
		}
	}
	// Append remaining content
	if pos > len(doc) {
		pos = len(doc)
	}
	result = append(result, doc[pos:]...)
	return string(result)
}
```

### 2. Document Server

The Document Server manages in-memory document editing sessions and routes WebSocket messages between connected clients. Each document gets its own `DocSession` that holds the OT engine instance, the set of connected clients, and the current revision. A double-check locking pattern in `getOrLoadSession` prevents multiple goroutines from initializing the same document session simultaneously when several clients connect at the same time. Sessions are evicted from memory after a period of inactivity and reconstructed from the database on next access.

```go
package docserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// DocServer manages a set of active documents
// One DocServer instance owns a set of documents (consistent hashing)
type DocServer struct {
	docs     map[string]*DocumentSession
	mu       sync.RWMutex
	opLog    OperationLog
	docStore DocumentStore
	rdb      *redis.Client
	upgrader websocket.Upgrader
}

// DocumentSession is an in-memory document with connected clients
type DocumentSession struct {
	docID    string
	engine   *OTEngine
	clients  map[string]*DocClient // userID → client
	mu       sync.RWMutex
	lastSave time.Time
}

// DocClient represents a user's WebSocket connection to a document
type DocClient struct {
	userID string
	conn   *websocket.Conn
	send   chan []byte
}

// ServerMessage is sent from server to client
type ServerMessage struct {
	Type      string      `json:"type"` // "op", "ack", "cursor", "presence"
	Op        *Operation  `json:"op,omitempty"`
	Revision  int         `json:"revision,omitempty"`
	UserID    string      `json:"user_id,omitempty"`
	Cursor    *CursorPos  `json:"cursor,omitempty"`
}

// CursorPos tracks a user's cursor position
type CursorPos struct {
	UserID   string `json:"user_id"`
	Position int    `json:"position"`
	Color    string `json:"color"` // assigned per-user
}

// HandleDocumentWebSocket handles a user connecting to edit a document
func (s *DocServer) HandleDocumentWebSocket(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("doc_id")
	userID := r.Header.Get("X-User-ID")

	if userID == "" || !s.hasPermission(r.Context(), userID, docID, "edit") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	client := &DocClient{
		userID: userID,
		conn:   conn,
		send:   make(chan []byte, 64),
	}

	session := s.getOrLoadSession(r.Context(), docID)

	session.mu.Lock()
	session.clients[userID] = client
	session.mu.Unlock()

	// Send current document state and revision
	s.sendCurrentState(client, session)

	// Announce presence to other users
	s.broadcastPresence(session, userID, "joined")

	defer func() {
		session.mu.Lock()
		delete(session.clients, userID)
		session.mu.Unlock()
		s.broadcastPresence(session, userID, "left")
		// Safe to close now: the client is out of the map, so no
		// broadcaster can send to this channel anymore
		close(client.send)
		conn.Close()
	}()

	go client.writePump()
	s.readPump(client, session)
}

func (s *DocServer) readPump(c *DocClient, session *DocumentSession) {
	defer c.conn.Close()
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var incoming Operation
		if err := json.Unmarshal(data, &incoming); err != nil {
			continue
		}
		incoming.UserID = c.userID

		// Apply to OT engine (serialized within session)
		session.mu.Lock()
		transformed, newRevision, err := session.engine.Apply(incoming)
		session.mu.Unlock()

		if err != nil {
			continue
		}

		// Persist operation
		s.opLog.Append(context.Background(), transformed)

		// Acknowledge to sender
		ack, _ := json.Marshal(ServerMessage{
			Type:     "ack",
			Revision: newRevision,
		})
		c.send <- ack

		// Broadcast transformed op to all other clients
		opMsg, _ := json.Marshal(ServerMessage{
			Type: "op",
			Op:   &transformed,
		})
		session.mu.RLock()
		for uid, other := range session.clients {
			if uid != c.userID {
				select {
				case other.send <- opMsg:
				default:
				}
			}
		}
		session.mu.RUnlock()

		// Persist snapshot periodically
		if time.Since(session.lastSave) > 30*time.Second {
			go s.saveSnapshot(session)
		}
	}
}

func (s *DocServer) sendCurrentState(c *DocClient, session *DocumentSession) {
	session.mu.RLock()
	content := session.engine.content
	revision := session.engine.revision
	session.mu.RUnlock()

	msg, _ := json.Marshal(map[string]any{
		"type":     "init",
		"content":  content,
		"revision": revision,
	})
	c.send <- msg
}

func (s *DocServer) broadcastPresence(session *DocumentSession, userID, event string) {
	msg, _ := json.Marshal(map[string]any{
		"type":    "presence",
		"user_id": userID,
		"event":   event,
	})
	session.mu.RLock()
	for uid, c := range session.clients {
		if uid != userID {
			select {
			case c.send <- msg:
			default:
			}
		}
	}
	session.mu.RUnlock()
}

func (s *DocServer) getOrLoadSession(ctx context.Context, docID string) *DocumentSession {
	s.mu.RLock()
	if sess, ok := s.docs[docID]; ok {
		s.mu.RUnlock()
		return sess
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()

	// Double-check after acquiring write lock
	if sess, ok := s.docs[docID]; ok {
		return sess
	}

	// Load from document store
	content, revision := s.docStore.Load(ctx, docID)
	sess := &DocumentSession{
		docID:   docID,
		engine:  &OTEngine{docID: docID, revision: revision, content: content},
		clients: make(map[string]*DocClient),
	}
	s.docs[docID] = sess
	return sess
}

func (s *DocServer) saveSnapshot(session *DocumentSession) {
	session.mu.Lock()
	content := session.engine.content
	revision := session.engine.revision
	session.lastSave = time.Now()
	session.mu.Unlock()

	ctx := context.Background()
	s.docStore.Save(ctx, session.docID, content, revision)
}

// hasPermission checks the role cache maintained by the permissions
// service. A cache miss denies access here. In production the doc server
// resolves misses through the permissions service before rejecting.
func (s *DocServer) hasPermission(ctx context.Context, userID, docID, perm string) bool {
	key := fmt.Sprintf("perm:role:%s:%s", docID, userID)
	role, err := s.rdb.Get(ctx, key).Result()
	if err != nil {
		return false
	}
	switch perm {
	case "edit":
		return role == "owner" || role == "editor"
	case "comment":
		return role == "owner" || role == "editor" || role == "commenter"
	default:
		return role != ""
	}
}

func (c *DocClient) writePump() {
	defer c.conn.Close()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}
```

### 3. Document Storage and Versioning

Document storage uses a two-layer approach: PostgreSQL stores document metadata and version pointers, while S3 stores the actual document content snapshots. Snapshots are taken every 30 seconds of activity rather than on every operation to prevent write amplification, a document being edited rapidly might receive hundreds of operations per second, but only one S3 write per 30 seconds. The complete operation log is stored in PostgreSQL as the authoritative history, and any point-in-time version can be reconstructed by replaying operations from the nearest snapshot.

```go
package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DocumentStore persists documents and versions
type DocumentStore struct {
	db       *pgxpool.Pool
	s3Client *s3.Client
	bucket   string
}

// Document represents a stored document
type Document struct {
	ID          string    `json:"id"`
	OwnerID     string    `json:"owner_id"`
	Title       string    `json:"title"`
	ContentKey  string    `json:"content_key"` // S3 key for content
	Revision    int       `json:"revision"`
	Size        int64     `json:"size"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Version represents a document snapshot
type Version struct {
	DocID      string    `json:"doc_id"`
	Revision   int       `json:"revision"`
	ContentKey string    `json:"content_key"` // S3 key
	SavedAt    time.Time `json:"saved_at"`
	SavedBy    string    `json:"saved_by"`
}

// Save persists the current document state
func (s *DocumentStore) Save(ctx context.Context, docID, content string, revision int) error {
	contentKey := fmt.Sprintf("docs/%s/rev_%d.json", docID, revision)

	// Upload content to S3
	_, err := s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(contentKey),
		Body:   strings.NewReader(content),
	})
	if err != nil {
		return fmt.Errorf("s3 put: %w", err)
	}

	// Update document record
	_, err = s.db.Exec(ctx, `
		UPDATE documents
		SET content_key = $1, revision = $2, size = $3, updated_at = NOW()
		WHERE id = $4`,
		contentKey, revision, len(content), docID,
	)
	if err != nil {
		return fmt.Errorf("db update: %w", err)
	}

	// Record version
	_, err = s.db.Exec(ctx, `
		INSERT INTO document_versions (doc_id, revision, content_key, saved_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (doc_id, revision) DO NOTHING`,
		docID, revision, contentKey,
	)
	return err
}

// Load retrieves current document state
func (s *DocumentStore) Load(ctx context.Context, docID string) (string, int) {
	var contentKey string
	var revision int
	err := s.db.QueryRow(ctx,
		"SELECT content_key, revision FROM documents WHERE id = $1",
		docID,
	).Scan(&contentKey, &revision)
	if err != nil {
		return "", 0
	}

	// Fetch from S3
	result, err := s.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(contentKey),
	})
	if err != nil {
		return "", revision
	}
	defer result.Body.Close()

	var content strings.Builder
	buf := make([]byte, 32*1024)
	for {
		n, err := result.Body.Read(buf)
		if n > 0 {
			content.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}

	return content.String(), revision
}

// GetVersionHistory returns all versions for a document
func (s *DocumentStore) GetVersionHistory(ctx context.Context, docID string, limit int) ([]Version, error) {
	rows, err := s.db.Query(ctx, `
		SELECT doc_id, revision, content_key, saved_at, COALESCE(saved_by, '')
		FROM document_versions
		WHERE doc_id = $1
		ORDER BY revision DESC
		LIMIT $2`,
		docID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var versions []Version
	for rows.Next() {
		var v Version
		if err := rows.Scan(&v.DocID, &v.Revision, &v.ContentKey, &v.SavedAt, &v.SavedBy); err != nil {
			continue
		}
		versions = append(versions, v)
	}
	return versions, nil
}

// OperationLog stores the ordered operation history
type OperationLog struct {
	db *pgxpool.Pool
}

// Append stores an applied operation
func (l *OperationLog) Append(ctx context.Context, op Operation) error {
	opsJSON, _ := json.Marshal(op.Ops)
	_, err := l.db.Exec(ctx, `
		INSERT INTO operation_log (doc_id, revision, user_id, ops, applied_at)
		VALUES ($1, $2, $3, $4, NOW())`,
		op.DocID, op.Revision, op.UserID, opsJSON,
	)
	return err
}

// GetSince retrieves ops after a given revision for catch-up
func (l *OperationLog) GetSince(ctx context.Context, docID string, revision int) ([]Operation, error) {
	rows, err := l.db.Query(ctx, `
		SELECT revision, user_id, ops, applied_at
		FROM operation_log
		WHERE doc_id = $1 AND revision >= $2
		ORDER BY revision ASC`,
		docID, revision,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ops []Operation
	for rows.Next() {
		var op Operation
		var opsJSON []byte
		var appliedAt time.Time
		if err := rows.Scan(&op.Revision, &op.UserID, &opsJSON, &appliedAt); err != nil {
			continue
		}
		op.Timestamp = appliedAt.Unix()
		json.Unmarshal(opsJSON, &op.Ops)
		op.DocID = docID
		ops = append(ops, op)
	}
	return ops, nil
}
```

### 4. Permissions Service

The Permissions Service enforces four access levels, owner, editor, commenter, and viewer, and is consulted on every document operation before it is applied. Permission checks are cached in Redis with a 5-minute TTL to avoid hitting PostgreSQL on every WebSocket message from active collaborators. The cache is invalidated immediately when permissions change (for example, when an owner revokes access) to ensure that access changes take effect within seconds rather than waiting for the cache to expire.

```go
package permissions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Role string

const (
	RoleOwner     Role = "owner"
	RoleEditor    Role = "editor"
	RoleCommenter Role = "commenter"
	RoleViewer    Role = "viewer"
)

// PermissionsService manages document access control
type PermissionsService struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

// ShareDoc grants access to a document
func (s *PermissionsService) ShareDoc(ctx context.Context, docID, granterID, granteeID string, role Role) error {
	// Verify granter has owner/editor permission
	granterRole, err := s.GetRole(ctx, docID, granterID)
	if err != nil || (granterRole != RoleOwner && granterRole != RoleEditor) {
		return fmt.Errorf("insufficient permission to share")
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO doc_permissions (doc_id, user_id, role, granted_by, granted_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (doc_id, user_id) DO UPDATE SET role = $3, granted_by = $4, granted_at = NOW()`,
		docID, granteeID, string(role), granterID,
	)
	if err != nil {
		return err
	}

	// Invalidate cache (same key GetRole and the doc server read)
	s.rdb.Del(ctx, fmt.Sprintf("perm:role:%s:%s", docID, granteeID))
	return nil
}

// GetRole retrieves a user's role for a document
func (s *PermissionsService) GetRole(ctx context.Context, docID, userID string) (Role, error) {
	// Check cache
	cacheKey := fmt.Sprintf("perm:role:%s:%s", docID, userID)
	if cached, err := s.rdb.Get(ctx, cacheKey).Result(); err == nil {
		return Role(cached), nil
	}

	var role string
	err := s.db.QueryRow(ctx,
		"SELECT role FROM doc_permissions WHERE doc_id = $1 AND user_id = $2",
		docID, userID,
	).Scan(&role)
	if err != nil {
		return "", fmt.Errorf("no access")
	}

	s.rdb.Set(ctx, cacheKey, role, 5*time.Minute)
	return Role(role), nil
}

// CanEdit checks if a user can edit a document
func (s *PermissionsService) CanEdit(ctx context.Context, docID, userID string) bool {
	role, err := s.GetRole(ctx, docID, userID)
	if err != nil {
		return false
	}
	return role == RoleOwner || role == RoleEditor
}
```

---
