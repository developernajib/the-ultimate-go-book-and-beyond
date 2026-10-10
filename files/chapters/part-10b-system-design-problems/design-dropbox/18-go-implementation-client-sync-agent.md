## Go Implementation: Client Sync Agent

The client sync agent is the desktop application component that runs continuously in the background, watching for local file changes and polling the server for remote changes. It ties together every concept discussed so far: chunking files into blocks, computing hashes, asking the server which blocks are missing, uploading only those blocks via pre-signed URLs, and then committing the new file version. On the download side, it checks its local block cache first to avoid re-downloading blocks it already has from previous file versions or shared folders.

```go
package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type UploadRequest struct {
	Path        string   `json:"path"`
	BlockHashes []string `json:"block_hashes"`
	Size        int64    `json:"size"`
}

type UploadResponse struct {
	MissingHashes []string          `json:"missing_hashes"`
	UploadURLs    map[string]string `json:"upload_urls"`
}

type SyncRequest struct {
	Cursor time.Time `json:"cursor"`
}

type SyncResponse struct {
	Changes   []FileChange `json:"changes"`
	NewCursor time.Time    `json:"new_cursor"`
}

type FileChange struct {
	Path        string
	BlockHashes []string
	Deleted     bool
}

type ServerAPI interface {
	RequestUpload(ctx context.Context, req UploadRequest) (*UploadResponse, error)
	CompleteUpload(ctx context.Context, req UploadRequest) (any, error)
	Sync(ctx context.Context, req SyncRequest) (*SyncResponse, error)
	DownloadBlock(ctx context.Context, hash string) ([]byte, error)
}

type LocalDatabase interface {
	StoreBlock(hash string, data []byte)
	GetBlock(hash string) ([]byte, bool)
	HasBlock(hash string) bool
}

// SyncAgent runs on the desktop client to detect and sync file changes
type SyncAgent struct {
	rootDir      string
	serverAPI    ServerAPI
	localDB      LocalDatabase
	lastCursor   time.Time
	blockSize    int
}

// WatchAndSync monitors local file system and syncs changes
func (a *SyncAgent) WatchAndSync(ctx context.Context) error {
	// 1. Poll server for remote changes (long-poll)
	go a.pollRemoteChanges(ctx)

	// 2. Watch local file system for changes
	go a.watchLocalChanges(ctx)

	<-ctx.Done()
	return nil
}

// syncLocalFile uploads a locally modified file
func (a *SyncAgent) syncLocalFile(ctx context.Context, path string) error {
	fullPath := filepath.Join(a.rootDir, path)

	// Open file
	f, err := os.Open(fullPath)
	if err != nil {
		return err
	}
	defer f.Close()

	// Chunk into blocks
	var hashes []string
	buf := make([]byte, a.blockSize)
	for {
		n, err := io.ReadFull(f, buf)
		if n == 0 {
			break
		}

		// Copy out of buf: it is reused next iteration, and StoreBlock keeps the slice
		chunk := make([]byte, n)
		copy(chunk, buf[:n])
		hash := sha256.Sum256(chunk)
		hashStr := hex.EncodeToString(hash[:])
		hashes = append(hashes, hashStr)

		// Store block locally for potential LAN sync
		a.localDB.StoreBlock(hashStr, chunk)

		if err == io.ErrUnexpectedEOF || err == io.EOF {
			break
		}
	}

	// Get file size
	stat, _ := os.Stat(fullPath)

	// Ask server which blocks are missing
	resp, err := a.serverAPI.RequestUpload(ctx, UploadRequest{
		Path:        path,
		BlockHashes: hashes,
		Size:        stat.Size(),
	})
	if err != nil {
		return err
	}

	// Upload only missing blocks
	for _, hash := range resp.MissingHashes {
		block, _ := a.localDB.GetBlock(hash)
		url := resp.UploadURLs[hash]
		if err := uploadToS3(ctx, url, block); err != nil {
			return fmt.Errorf("upload block %s: %w", hash[:8], err)
		}
	}

	// Commit file version
	_, err = a.serverAPI.CompleteUpload(ctx, UploadRequest{
		Path:        path,
		BlockHashes: hashes,
		Size:        stat.Size(),
	})
	return err
}

// pollRemoteChanges uses long-poll to get server changes
func (a *SyncAgent) pollRemoteChanges(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		resp, err := a.serverAPI.Sync(ctx, SyncRequest{Cursor: a.lastCursor})
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}

		for _, change := range resp.Changes {
			if change.Deleted {
				a.deleteLocal(change.Path)
			} else {
				a.downloadFile(ctx, change)
			}
		}

		a.lastCursor = resp.NewCursor
	}
}

// downloadFile downloads a remote file to local disk
func (a *SyncAgent) downloadFile(ctx context.Context, change FileChange) error {
	fullPath := filepath.Join(a.rootDir, change.Path)

	// Check which blocks we already have locally
	var missing []string
	for _, hash := range change.BlockHashes {
		if !a.localDB.HasBlock(hash) {
			missing = append(missing, hash)
		}
	}

	// Download missing blocks
	for _, hash := range missing {
		data, err := a.serverAPI.DownloadBlock(ctx, hash)
		if err != nil {
			return err
		}
		a.localDB.StoreBlock(hash, data)
	}

	// Reassemble file from blocks
	os.MkdirAll(filepath.Dir(fullPath), 0755)
	out, err := os.Create(fullPath)
	if err != nil {
		return err
	}
	defer out.Close()

	for _, hash := range change.BlockHashes {
		block, _ := a.localDB.GetBlock(hash)
		out.Write(block)
	}

	return nil
}

func (a *SyncAgent) watchLocalChanges(ctx context.Context) {
	// Watches filesystem events using OS notification APIs (inotify/FSEvents)
}

func (a *SyncAgent) deleteLocal(path string) {
	_ = os.Remove(filepath.Join(a.rootDir, path))
}

func uploadToS3(ctx context.Context, url string, data []byte) error {
	_ = ctx
	_ = url
	_ = data
	return nil
}
```

---
