## API Design

The API surface defines how clients interact with the Dropbox backend. A well-designed API makes the delta sync protocol clear to client developers and keeps the server stateless where possible. The endpoints below follow REST conventions and separate the upload flow into two phases so that block storage and metadata commits happen independently.

### REST Endpoints

The API is organized into three groups: file operations (upload, download, move, copy, delete), sync operations (cursor-based change polling and version history), and sharing operations (folder sharing and public link generation). Notice that the upload flow is a two-phase process, the client first requests upload URLs, then confirms completion, which decouples block storage from metadata commits. The download response returns pre-signed S3 URLs for each block rather than streaming the file through the API server, which keeps API servers lightweight and offloads bandwidth to S3 and CDN.

```go
package api

import "time"

// ========== File Operations ==========

// POST /api/v1/files/upload
// Request: UploadRequest (path, block_hashes[], size)
// Response: UploadResponse (missing_hashes[], upload_urls{})

// POST /api/v1/files/upload/complete
// Request: { "path": "/docs/report.pdf", "block_hashes": [...], "size": 1048576 }
// Response: FileNode (committed file metadata)

// GET /api/v1/files/download?path=/docs/report.pdf
// Response: DownloadResponse

type DownloadResponse struct {
	Path       string            `json:"path"`
	Size       int64             `json:"size"`
	Revision   int               `json:"revision"`
	BlockURLs  map[string]string `json:"block_urls"` // hash -> pre-signed S3 URL
	MimeType   string            `json:"mime_type"`
	ModifiedAt time.Time         `json:"modified_at"`
}

// DELETE /api/v1/files?path=/docs/old.pdf
// POST /api/v1/files/move
// POST /api/v1/files/copy (zero-copy: shares same blocks)

// ========== Sync Operations ==========

// POST /api/v1/sync
// Request: SyncRequest { cursor }
// Response: SyncResponse { changes[], new_cursor, has_more }
// Long-poll: holds connection up to 30s waiting for changes

// GET /api/v1/files/versions?path=/docs/report.pdf&limit=10
// POST /api/v1/files/restore { "path": "...", "revision": 3 }

// ========== Sharing ==========

// POST /api/v1/shares
type ShareRequest struct {
	FolderPath string `json:"folder_path"`
	SharedWith string `json:"shared_with"` // email or user_id
	Permission string `json:"permission"`  // view or edit
}

// POST /api/v1/shares/link
// Request: { "folder_path": "/docs", "permission": "view", "expires_in": "7d" }
// Response: { "link": "https://dropbox.example.com/s/abc123" }
```

---
