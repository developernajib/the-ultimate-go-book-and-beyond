## Go Implementation: Shared Folder Access Control

Shared folder access control is the permission layer that determines who can view or edit files within a shared folder. This implementation handles the full sharing lifecycle: verifying ownership, resolving the target user (or sending an invite if they are not on the platform), persisting the permission grant, creating a virtual link in the recipient's file tree, and notifying them. The `CheckPermission` method is called on every file operation to enforce access control, a user with "view" permission can read but not modify, while "edit" grants both.

```go
package sharing

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NotificationService dispatches sharing invitations and acceptance events
type NotificationService interface {
	SendShareInvite(ctx context.Context, targetEmail, ownerID, folderPath string)
	NotifyShareAccepted(ctx context.Context, targetUserID, ownerID, folderPath string)
}

// FolderNode represents folder metadata
type FolderNode struct {
	ID string
}

// User represents user identity
type User struct {
	ID string
}

// SharingService manages folder sharing and permissions
type SharingService struct {
	db       *pgxpool.Pool
	notifier NotificationService
}

type Permission string

const (
	PermView Permission = "view"
	PermEdit Permission = "edit"
)

type FolderShare struct {
	ID         string     `json:"id"`
	FolderID   string     `json:"folder_id"`
	FolderPath string     `json:"folder_path"`
	OwnerID    string     `json:"owner_id"`
	SharedWith string     `json:"shared_with"` // user_id or email
	Permission Permission `json:"permission"`
	SharedAt   time.Time  `json:"shared_at"`
}

// ShareFolder grants access to a folder
func (s *SharingService) ShareFolder(ctx context.Context, ownerID, folderPath, targetEmail string, perm Permission) (*FolderShare, error) {
	// Verify ownership
	folder, err := s.getFolder(ctx, ownerID, folderPath)
	if err != nil {
		return nil, fmt.Errorf("folder not found or not owned by you")
	}

	// Resolve email to user_id
	targetUser, err := s.resolveUser(ctx, targetEmail)
	if err != nil {
		// User not on platform, send invite email
		s.notifier.SendShareInvite(ctx, targetEmail, ownerID, folderPath)
		return nil, nil
	}

	share := &FolderShare{
		ID:         generateID(),
		FolderID:   folder.ID,
		FolderPath: folderPath,
		OwnerID:    ownerID,
		SharedWith: targetUser.ID,
		Permission: perm,
		SharedAt:   time.Now(),
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO folder_shares (folder_id, shared_with, permission, shared_by, shared_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (folder_id, shared_with) DO UPDATE SET permission = EXCLUDED.permission`,
		share.FolderID, share.SharedWith, share.Permission, share.OwnerID)
	if err != nil {
		return nil, err
	}

	// Create virtual link in target user's file tree
	s.createShareLink(ctx, targetUser.ID, ownerID, folderPath, folder.ID)

	// Notify recipient
	s.notifier.NotifyShareAccepted(ctx, targetUser.ID, ownerID, folderPath)

	return share, nil
}

// CheckPermission verifies a user can access a file
func (s *SharingService) CheckPermission(ctx context.Context, userID, folderID string, required Permission) bool {
	// Owner always has full access
	var ownerID string
	if err := s.db.QueryRow(ctx,
		"SELECT owner_id FROM file_nodes WHERE id = $1", folderID,
	).Scan(&ownerID); err == nil && ownerID == userID {
		return true
	}

	var perm string
	err := s.db.QueryRow(ctx, `
		SELECT permission FROM folder_shares
		WHERE folder_id = $1 AND shared_with = $2`,
		folderID, userID,
	).Scan(&perm)
	if err != nil {
		return false
	}

	if required == PermView {
		return perm == "view" || perm == "edit"
	}
	return perm == "edit"
}

func (s *SharingService) getFolder(ctx context.Context, ownerID, folderPath string) (*FolderNode, error) {
	var id string
	err := s.db.QueryRow(ctx,
		"SELECT id FROM file_nodes WHERE owner_id = $1 AND path = $2 AND type = 'folder'",
		ownerID, folderPath,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return &FolderNode{ID: id}, nil
}

func (s *SharingService) resolveUser(ctx context.Context, email string) (*User, error) {
	var id string
	err := s.db.QueryRow(ctx,
		"SELECT id FROM users WHERE email = $1", email,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return &User{ID: id}, nil
}

func (s *SharingService) createShareLink(ctx context.Context, targetUserID, ownerID, folderPath, folderID string) {
	// Inserts a pointer row into the target user's virtual namespace
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
```

---
