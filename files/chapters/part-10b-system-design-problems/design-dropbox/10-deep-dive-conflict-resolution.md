## Deep Dive: Conflict Resolution

Conflict resolution is one of the trickiest parts of a file sync system. When two devices edit the same file while one or both are offline, the server must detect the divergence and handle it gracefully. The approach here uses revision numbers as an optimistic concurrency control mechanism: each client remembers the revision it started from, and if the server's current revision has moved forward by the time the client commits, a conflict is detected. Rather than silently overwriting data, the system saves the conflicting version as a separate "conflicted copy" file and notifies the user.

```go
package conflict

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// FileNode represents the minimal file record needed for revision checks
type FileNode struct {
	Revision int
}

// MetadataService defines metadata operations needed for conflict resolution
type MetadataService interface {
	GetFile(ctx context.Context, ownerID, path string) (*FileNode, error)
	CommitFile(ctx context.Context, ownerID, path string, blockHashes []string, size int64) (*FileNode, error)
}

// NotificationService sends conflict alerts to client devices
type NotificationService interface {
	NotifyConflict(ctx context.Context, ownerID, originalPath, conflictPath string)
}

// ConflictResolver handles concurrent edits to the same file
type ConflictResolver struct {
	metadataSvc MetadataService
	notifier    NotificationService
}

type ConflictType int

const (
	NoConflict         ConflictType = iota
	EditEditConflict                // two devices edited same file
	DeleteEditConflict              // one deleted, another edited
)

// ResolveOnCommit checks for conflicts when committing
func (r *ConflictResolver) ResolveOnCommit(
	ctx context.Context,
	ownerID, path string,
	baseRevision int,
	newBlockHashes []string,
	size int64,
) (ConflictType, string, error) {
	current, err := r.metadataSvc.GetFile(ctx, ownerID, path)
	if err != nil {
		return DeleteEditConflict, "", fmt.Errorf("file not found on server")
	}

	// No conflict if revisions match
	if current.Revision == baseRevision {
		return NoConflict, path, nil
	}

	// Conflict: save as conflicted copy
	ext := filepath.Ext(path)
	baseName := strings.TrimSuffix(path, ext)
	conflictPath := fmt.Sprintf("%s (conflicted copy %s)%s",
		baseName, time.Now().Format("2006-01-02"), ext)

	_, err = r.metadataSvc.CommitFile(ctx, ownerID, conflictPath, newBlockHashes, size)
	if err != nil {
		return EditEditConflict, "", err
	}

	r.notifier.NotifyConflict(ctx, ownerID, path, conflictPath)
	return EditEditConflict, conflictPath, nil
}

// Folder-level operations use additive merge, so no conflicts are possible:
// - Two devices create same subfolder -> idempotent
// - Two devices add different files -> both kept
// - One deletes folder, other adds file -> file restored
// - Only file CONTENT edits can conflict
```

---
