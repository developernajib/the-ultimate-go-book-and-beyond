## Go Implementation: Resumable Upload Manager

The resumable upload manager tracks the progress of multi-block file uploads so that interrupted transfers can continue from where they left off rather than starting over. This is essential for large files on unreliable connections, a 1GB file has 250 blocks, and losing the connection after uploading 200 of them should not waste that work. The manager maintains in-memory upload sessions that track which blocks have been successfully uploaded, provides progress information for the client UI, and can refresh expired pre-signed URLs for the remaining blocks without re-uploading anything.

```go
package upload

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// BlockService defines block URL generation
type BlockService interface {
	GetPresignedUploadURL(ctx context.Context, hash string) (string, error)
}

// ResumableUploadManager tracks multi-block upload progress
// Enables resume after network interruption
type ResumableUploadManager struct {
	uploads map[string]*UploadSession
	mu      sync.RWMutex
}

type UploadSession struct {
	ID              string
	UserID          string
	Path            string
	TotalBlocks     int
	UploadedBlocks  map[string]bool // hash -> uploaded
	MissingBlocks   []string
	PresignedURLs   map[string]string
	StartedAt       time.Time
	LastActivityAt  time.Time
	ExpiresAt       time.Time
}

// StartUpload initializes an upload session
func (m *ResumableUploadManager) StartUpload(ctx context.Context, userID, path string, blockHashes []string, missingHashes []string, urls map[string]string) *UploadSession {
	// Count unique hashes: a file with repeated content (e.g. zero-filled
	// regions) has duplicate blocks that share one hash and one upload
	unique := make(map[string]bool)
	for _, h := range blockHashes {
		unique[h] = true
	}

	session := &UploadSession{
		ID:             generateID(),
		UserID:         userID,
		Path:           path,
		TotalBlocks:    len(unique),
		UploadedBlocks: make(map[string]bool),
		MissingBlocks:  missingHashes,
		PresignedURLs:  urls,
		StartedAt:      time.Now(),
		LastActivityAt: time.Now(),
		ExpiresAt:      time.Now().Add(1 * time.Hour),
	}

	// Mark blocks that already exist on server as uploaded
	for h := range unique {
		isMissing := false
		for _, mh := range missingHashes {
			if h == mh {
				isMissing = true
				break
			}
		}
		if !isMissing {
			session.UploadedBlocks[h] = true
		}
	}

	m.mu.Lock()
	m.uploads[session.ID] = session
	m.mu.Unlock()

	return session
}

// MarkBlockUploaded records that a block was successfully uploaded
func (m *ResumableUploadManager) MarkBlockUploaded(sessionID, blockHash string) (allDone bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.uploads[sessionID]
	if !ok {
		return false
	}

	session.UploadedBlocks[blockHash] = true
	session.LastActivityAt = time.Now()

	return len(session.UploadedBlocks) == session.TotalBlocks
}

// GetProgress returns upload progress for UI display
func (m *ResumableUploadManager) GetProgress(sessionID string) (uploaded, total int, remaining []string) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	session, ok := m.uploads[sessionID]
	if !ok {
		return 0, 0, nil
	}

	for _, h := range session.MissingBlocks {
		if !session.UploadedBlocks[h] {
			remaining = append(remaining, h)
		}
	}

	return len(session.UploadedBlocks), session.TotalBlocks, remaining
}

// RefreshPresignedURLs regenerates expired URLs for remaining blocks
func (m *ResumableUploadManager) RefreshPresignedURLs(ctx context.Context, sessionID string, blockSvc BlockService) (map[string]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.uploads[sessionID]
	if !ok {
		return nil, fmt.Errorf("session not found")
	}

	newURLs := make(map[string]string)
	for _, hash := range session.MissingBlocks {
		if !session.UploadedBlocks[hash] {
			url, err := blockSvc.GetPresignedUploadURL(ctx, hash)
			if err != nil {
				continue
			}
			newURLs[hash] = url
			session.PresignedURLs[hash] = url
		}
	}

	session.ExpiresAt = time.Now().Add(1 * time.Hour)
	return newURLs, nil
}

// CleanupExpired removes abandoned upload sessions
func (m *ResumableUploadManager) CleanupExpired() int {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	removed := 0
	for id, session := range m.uploads {
		if now.After(session.ExpiresAt) {
			delete(m.uploads, id)
			removed++
		}
	}
	return removed
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
```

---
