## Core Components

The system is built around three core services that work together to provide reliable file sync. The Block Service handles the raw file content using content-addressed storage for automatic deduplication. The Metadata Service manages the virtual file system (paths, versions, ownership). The Sync Protocol ties them together by coordinating what needs to be uploaded or downloaded between client and server.

### 1. Block Service (Delta Sync)

The Block Service is the foundation of Dropbox's storage efficiency. It splits every file into fixed-size 4MB blocks, hashes each block with SHA256, and stores them in S3 using the hash as the key. This content-addressed approach means that identical blocks across all users are stored only once, and the service can quickly determine which blocks a client already has by comparing hash lists. The concurrent fan-out pattern used in `ExistingBlocks` is a common Go technique for parallelizing I/O-bound operations while capping the concurrency level.

```go
package block

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const BlockSize = 4 * 1024 * 1024 // 4MB blocks

// BlockService handles content-addressed block storage
// Blocks are stored by their SHA256 hash, giving automatic deduplication
type BlockService struct {
	s3Client *s3.Client
	bucket   string
}

// Block is a content-addressed file chunk
type Block struct {
	Hash    string // SHA256 hex
	Size    int    // actual size (last block may be smaller)
	Content []byte // in-memory during upload only
}

// ChunkFile splits a file into blocks and returns their hashes
func ChunkFile(reader io.Reader) ([]Block, error) {
	var blocks []Block
	buf := make([]byte, BlockSize)

	for {
		n, err := io.ReadFull(reader, buf)
		if n == 0 {
			break
		}

		chunk := make([]byte, n)
		copy(chunk, buf[:n])

		hash := sha256.Sum256(chunk)
		blocks = append(blocks, Block{
			Hash:    hex.EncodeToString(hash[:]),
			Size:    n,
			Content: chunk,
		})

		if err == io.ErrUnexpectedEOF || err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return blocks, nil
}

// ExistingBlocks checks which blocks already exist in S3
// Client uses this to avoid uploading blocks that are already stored
func (s *BlockService) ExistingBlocks(ctx context.Context, hashes []string) (map[string]bool, error) {
	existing := make(map[string]bool)

	// Batch HEAD requests to S3
	type result struct {
		hash   string
		exists bool
	}
	resultCh := make(chan result, len(hashes))

	// Fan out concurrently (max 10 at a time)
	sem := make(chan struct{}, 10)
	for _, hash := range hashes {
		sem <- struct{}{}
		go func(h string) {
			defer func() { <-sem }()
			_, err := s.s3Client.HeadObject(ctx, &s3.HeadObjectInput{
				Bucket: aws.String(s.bucket),
				Key:    aws.String(blockKey(h)),
			})
			resultCh <- result{hash: h, exists: err == nil}
		}(hash)
	}

	for range hashes {
		r := <-resultCh
		existing[r.hash] = r.exists
	}

	return existing, nil
}

// UploadBlock stores a block in S3 (idempotent: same hash = same key)
func (s *BlockService) UploadBlock(ctx context.Context, block Block) error {
	_, err := s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(blockKey(block.Hash)),
		Body:          bytes.NewReader(block.Content),
		ContentLength: aws.Int64(int64(block.Size)),
		// Immutable - set long cache header
		CacheControl: aws.String("max-age=31536000, immutable"),
	})
	return err
}

// DownloadBlock retrieves a block by hash
func (s *BlockService) DownloadBlock(ctx context.Context, hash string) ([]byte, error) {
	result, err := s.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(blockKey(hash)),
	})
	if err != nil {
		return nil, fmt.Errorf("get block %s: %w", hash, err)
	}
	defer result.Body.Close()
	return io.ReadAll(result.Body)
}

// GetPresignedUploadURL generates a pre-signed URL for direct client upload
func (s *BlockService) GetPresignedUploadURL(ctx context.Context, hash string) (string, error) {
	presignClient := s3.NewPresignClient(s.s3Client)
	req, err := presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(blockKey(hash)),
	})
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func blockKey(hash string) string {
	// Shard by first 2 chars of hash to distribute across S3 prefix partitions
	return fmt.Sprintf("blocks/%s/%s/%s", hash[:2], hash[2:4], hash)
}
```

### 2. Metadata Service

The Metadata Service is the single source of truth for the virtual file system. It tracks every file and folder as a `FileNode` with path, ownership, block hash references, and revision numbers. When a file is updated, the service archives the old version into a separate `file_versions` table before updating the current record, which enables the 30-day version history feature. It also publishes change events via Redis Pub/Sub so that the notification layer can alert other connected devices immediately.

```go
package metadata

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// MetadataService manages file tree and version history
type MetadataService struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

// FileNode represents a file or folder in the virtual file system
type FileNode struct {
	ID         string    `json:"id"`
	OwnerID    string    `json:"owner_id"`
	ParentID   string    `json:"parent_id"` // empty for root
	Name       string    `json:"name"`
	Path       string    `json:"path"`       // full path for display
	Type       string    `json:"type"`       // "file" or "folder"
	Size       int64     `json:"size"`       // 0 for folders
	BlockHashes []string `json:"block_hashes"` // ordered list of block hashes
	MimeType   string    `json:"mime_type"`
	Revision   int       `json:"revision"`
	ModifiedAt time.Time `json:"modified_at"`
	CreatedAt  time.Time `json:"created_at"`
	Deleted    bool      `json:"deleted"`
}

// CommitFile records a new version of a file
func (s *MetadataService) CommitFile(ctx context.Context, ownerID, path string, blockHashes []string, size int64) (*FileNode, error) {
	// Resolve path to parent
	parentID, name, err := s.resolvePath(ctx, ownerID, path)
	if err != nil {
		return nil, fmt.Errorf("resolve path: %w", err)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Check if file exists
	var existingID string
	var existingRevision int
	tx.QueryRow(ctx,
		"SELECT id, revision FROM file_nodes WHERE owner_id = $1 AND path = $2 AND deleted = false",
		ownerID, path,
	).Scan(&existingID, &existingRevision)

	node := &FileNode{
		OwnerID:     ownerID,
		ParentID:    parentID,
		Name:        name,
		Path:        path,
		Type:        "file",
		Size:        size,
		BlockHashes: blockHashes,
		ModifiedAt:  time.Now(),
	}

	if existingID != "" {
		// New version of existing file
		node.ID = existingID
		node.Revision = existingRevision + 1
		node.CreatedAt = time.Now() // DB keeps the original created_at, this is only the response value

		// Archive old version
		_, err = tx.Exec(ctx, `
			INSERT INTO file_versions (file_id, revision, block_hashes, size, modified_at)
			SELECT id, revision, block_hashes, size, modified_at
			FROM file_nodes WHERE id = $1`,
			existingID,
		)
		if err != nil {
			return nil, fmt.Errorf("archive version: %w", err)
		}

		// Update current
		_, err = tx.Exec(ctx, `
			UPDATE file_nodes SET block_hashes = $1, size = $2, revision = $3, modified_at = NOW()
			WHERE id = $4`,
			encodeHashes(blockHashes), size, node.Revision, existingID,
		)
	} else {
		// New file
		node.ID = generateID()
		node.Revision = 1
		node.CreatedAt = time.Now()

		_, err = tx.Exec(ctx, `
			INSERT INTO file_nodes (id, owner_id, parent_id, name, path, type, size, block_hashes, revision, created_at, modified_at)
			VALUES ($1, $2, $3, $4, $5, 'file', $6, $7, 1, NOW(), NOW())`,
			node.ID, ownerID, parentID, name, path, size, encodeHashes(blockHashes),
		)
	}

	if err != nil {
		return nil, fmt.Errorf("commit file: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	// Invalidate tree cache
	s.rdb.Del(ctx, fmt.Sprintf("tree:%s", ownerID))

	// Notify sync service of change
	s.publishChange(ctx, ownerID, node)

	return node, nil
}

// GetFileTree returns all files and folders for a user
func (s *MetadataService) GetFileTree(ctx context.Context, ownerID string) ([]FileNode, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, parent_id, name, path, type, size, block_hashes, revision, modified_at, created_at
		FROM file_nodes
		WHERE owner_id = $1 AND deleted = false
		ORDER BY path`,
		ownerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var nodes []FileNode
	for rows.Next() {
		var n FileNode
		var hashesJSON string
		n.OwnerID = ownerID
		if err := rows.Scan(&n.ID, &n.ParentID, &n.Name, &n.Path, &n.Type,
			&n.Size, &hashesJSON, &n.Revision, &n.ModifiedAt, &n.CreatedAt); err != nil {
			continue
		}
		n.BlockHashes = decodeHashes(hashesJSON)
		nodes = append(nodes, n)
	}
	return nodes, nil
}

// GetChanges returns files modified after a cursor (for incremental sync)
func (s *MetadataService) GetChanges(ctx context.Context, ownerID string, cursor time.Time) ([]FileNode, time.Time, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, parent_id, name, path, type, size, block_hashes, revision, modified_at, deleted
		FROM file_nodes
		WHERE owner_id = $1 AND modified_at > $2
		ORDER BY modified_at ASC
		LIMIT 1000`,
		ownerID, cursor,
	)
	if err != nil {
		return nil, cursor, err
	}
	defer rows.Close()

	var changes []FileNode
	newCursor := cursor
	for rows.Next() {
		var n FileNode
		var hashesJSON string
		n.OwnerID = ownerID
		rows.Scan(&n.ID, &n.ParentID, &n.Name, &n.Path, &n.Type,
			&n.Size, &hashesJSON, &n.Revision, &n.ModifiedAt, &n.Deleted)
		n.BlockHashes = decodeHashes(hashesJSON)
		changes = append(changes, n)
		if n.ModifiedAt.After(newCursor) {
			newCursor = n.ModifiedAt
		}
	}
	return changes, newCursor, nil
}

// GetVersionHistory returns all versions of a file
func (s *MetadataService) GetVersionHistory(ctx context.Context, fileID string, limit int) ([]FileVersion, error) {
	rows, err := s.db.Query(ctx, `
		SELECT revision, size, modified_at
		FROM file_versions
		WHERE file_id = $1
		ORDER BY revision DESC
		LIMIT $2`,
		fileID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var versions []FileVersion
	for rows.Next() {
		var v FileVersion
		v.FileID = fileID
		rows.Scan(&v.Revision, &v.Size, &v.ModifiedAt)
		versions = append(versions, v)
	}
	return versions, nil
}

type FileVersion struct {
	FileID     string
	Revision   int
	BlockHashes []string
	Size       int64
	ModifiedAt time.Time
}

func (s *MetadataService) resolvePath(ctx context.Context, ownerID, path string) (parentID, name string, err error) {
	// Split path into parent dir and filename
	parts := splitPath(path)
	if len(parts) == 1 {
		return "root:" + ownerID, parts[0], nil
	}
	name = parts[len(parts)-1]
	parentPath := joinPath(parts[:len(parts)-1])

	var pid string
	err = s.db.QueryRow(ctx,
		"SELECT id FROM file_nodes WHERE owner_id = $1 AND path = $2 AND type = 'folder'",
		ownerID, parentPath,
	).Scan(&pid)
	if err != nil {
		return "", "", fmt.Errorf("parent folder not found: %s", parentPath)
	}
	return pid, name, nil
}

func (s *MetadataService) publishChange(ctx context.Context, ownerID string, node *FileNode) {
	// Publish to notification service via Redis Pub/Sub
	// Notification service pushes to all connected devices of this user
	s.rdb.Publish(ctx, "changes:"+ownerID, node.Path)
}

func splitPath(p string) []string {
	clean := strings.Trim(p, "/")
	if clean == "" {
		return nil
	}
	return strings.Split(clean, "/")
}

func joinPath(parts []string) string {
	return "/" + strings.Join(parts, "/")
}

func encodeHashes(hashes []string) string {
	b, _ := json.Marshal(hashes)
	return string(b)
}

func decodeHashes(data string) []string {
	var hashes []string
	_ = json.Unmarshal([]byte(data), &hashes)
	return hashes
}

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
```

### 3. Sync Protocol

The Sync Protocol is the glue between client and server. It implements a long-polling pattern where the client asks for changes since its last known cursor, and the server either returns changes immediately or holds the connection open for up to 30 seconds waiting for something to happen. This avoids the overhead of constant polling while still providing near-real-time sync. The upload flow is particularly clever: the client sends only block hashes first, the server identifies which blocks it does not already have, and the client uploads only those missing blocks directly to S3 using pre-signed URLs.

```go
package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// MetadataService defines file tree and version operations needed by sync
type MetadataService interface {
	GetChanges(ctx context.Context, ownerID string, cursor time.Time) ([]FileNode, time.Time, error)
	CommitFile(ctx context.Context, ownerID, path string, blockHashes []string, size int64) (*FileNode, error)
}

// BlockService defines block availability and storage methods
type BlockService interface {
	ExistingBlocks(ctx context.Context, hashes []string) (map[string]bool, error)
	GetPresignedUploadURL(ctx context.Context, hash string) (string, error)
}

// FileNode represents virtual file system metadata needed during sync
type FileNode struct {
	Path        string
	Revision    int
	Size        int64
	BlockHashes []string
	ModifiedAt  time.Time
	Deleted     bool
}

// SyncService handles client sync protocol
type SyncService struct {
	metadataSvc MetadataService
	blockSvc    BlockService
}

// SyncRequest from client to request changes
type SyncRequest struct {
	UserID string    `json:"user_id"`
	Cursor time.Time `json:"cursor"` // last sync time, zero for first sync
}

// SyncResponse sends changed files to client
type SyncResponse struct {
	Changes    []FileChange `json:"changes"`
	NewCursor  time.Time    `json:"new_cursor"`
	HasMore    bool         `json:"has_more"`
}

// FileChange is a single file change in the sync response
type FileChange struct {
	Path        string   `json:"path"`
	Revision    int      `json:"revision"`
	Size        int64    `json:"size"`
	BlockHashes []string `json:"block_hashes"`
	Modified    time.Time `json:"modified"`
	Deleted     bool     `json:"deleted"`
}

// HandleSync processes a sync request (long-poll if no changes)
func (s *SyncService) HandleSync(w http.ResponseWriter, r *http.Request) {
	var req SyncRequest
	json.NewDecoder(r.Body).Decode(&req)

	ctx := r.Context()
	deadline := time.Now().Add(30 * time.Second) // long-poll up to 30s

	for {
		changes, newCursor, err := s.metadataSvc.GetChanges(ctx, req.UserID, req.Cursor)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if len(changes) > 0 {
			// Return changes immediately
			fileChanges := make([]FileChange, len(changes))
			for i, c := range changes {
				fileChanges[i] = FileChange{
					Path:        c.Path,
					Revision:    c.Revision,
					Size:        c.Size,
					BlockHashes: c.BlockHashes,
					Modified:    c.ModifiedAt,
					Deleted:     c.Deleted,
				}
			}
			resp := SyncResponse{
				Changes:   fileChanges,
				NewCursor: newCursor,
				HasMore:   len(changes) == 1000,
			}
			json.NewEncoder(w).Encode(resp)
			return
		}

		// No changes - wait for notification or timeout
		if time.Now().After(deadline) {
			json.NewEncoder(w).Encode(SyncResponse{
				NewCursor: req.Cursor,
				HasMore:   false,
			})
			return
		}

		// Wait for a change notification, then loop to re-query
		// until the 30s deadline expires
		s.waitForChange(ctx, req.UserID, 5*time.Second)
	}
}

// HandleUpload processes a file upload (delta sync)
type UploadRequest struct {
	Path        string   `json:"path"`
	BlockHashes []string `json:"block_hashes"` // complete list for this file version
	Size        int64    `json:"size"`
}

type UploadResponse struct {
	// Hashes the server needs (client only uploads these)
	MissingHashes []string `json:"missing_hashes"`
	// Pre-signed URLs for each missing hash
	UploadURLs    map[string]string `json:"upload_urls"`
}

func (s *SyncService) HandleUploadRequest(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-ID")
	var req UploadRequest
	json.NewDecoder(r.Body).Decode(&req)

	ctx := r.Context()

	// Check which blocks server already has
	existing, err := s.blockSvc.ExistingBlocks(ctx, req.BlockHashes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var missing []string
	uploadURLs := make(map[string]string)

	for _, hash := range req.BlockHashes {
		if !existing[hash] {
			missing = append(missing, hash)
			// Generate pre-signed URL for direct upload to S3
			url, err := s.blockSvc.GetPresignedUploadURL(ctx, hash)
			if err == nil {
				uploadURLs[hash] = url
			}
		}
	}

	// If no missing blocks, commit immediately
	if len(missing) == 0 {
		s.commitAfterUpload(ctx, userID, req)
		json.NewEncoder(w).Encode(map[string]any{
			"status": "committed",
		})
		return
	}

	json.NewEncoder(w).Encode(UploadResponse{
		MissingHashes: missing,
		UploadURLs:    uploadURLs,
	})
}

func (s *SyncService) HandleUploadComplete(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-ID")
	var req UploadRequest
	json.NewDecoder(r.Body).Decode(&req)
	s.commitAfterUpload(r.Context(), userID, req)
	w.WriteHeader(http.StatusOK)
}

func (s *SyncService) commitAfterUpload(ctx context.Context, userID string, req UploadRequest) {
	s.metadataSvc.CommitFile(ctx, userID, req.Path, req.BlockHashes, req.Size)
}

func (s *SyncService) waitForChange(ctx context.Context, userID string, timeout time.Duration) bool {
	// Subscribe to Redis Pub/Sub channel for this user
	// Returns true if a change was published within timeout
	// Simplified - in production use proper Redis subscriber
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}
```

---
