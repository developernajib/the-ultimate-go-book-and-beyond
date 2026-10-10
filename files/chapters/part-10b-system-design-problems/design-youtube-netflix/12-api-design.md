## API Design

A well-defined API is the contract between your frontend clients and backend services. In an interview, sketching out the key endpoints shows that you can translate high-level architecture into concrete, implementable interfaces. The API design below separates the public-facing REST layer (used by clients) from the internal gRPC layer (used for service-to-service calls), which is a common pattern in production systems at this scale.

### REST Endpoints

These REST endpoints define the public-facing API that clients (mobile apps, web browsers, smart TVs) use to interact with the platform. Each endpoint follows standard REST conventions with clear request/response types and input validation tags. The API covers the full user journey: uploading a video, watching it with adaptive streaming, tracking progress for resume, browsing recommendations, searching, and commenting.

```go
package api

import "time"

// POST /api/v1/videos/upload/initiate
type InitiateUploadRequest struct {
	Title         string   `json:"title" validate:"required,max=100"`
	Description   string   `json:"description" validate:"max=5000"`
	Tags          []string `json:"tags" validate:"max=30"`
	Category      string   `json:"category" validate:"required"`
	Visibility    string   `json:"visibility" validate:"required,oneof=public unlisted private"`
	ContentType   string   `json:"content_type" validate:"required"`
	FileSizeBytes int64    `json:"file_size_bytes" validate:"required,min=1"`
}

// InitiateUploadResponse returns either a single PUT URL (small files) or a
// multipart upload ID with one presigned URL per part. Exactly one of UploadURL
// and PartURLs is populated, and the client picks its path from that.
type InitiateUploadResponse struct {
	VideoID   string    `json:"video_id"`
	UploadURL string    `json:"upload_url,omitempty"`
	UploadID  string    `json:"upload_id,omitempty"`
	PartURLs  []string  `json:"part_urls,omitempty"`
	PartSize  int64     `json:"part_size,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
}

// POST /api/v1/videos/upload/{video_id}/complete
// The parts are required on the multipart path: S3 will not assemble the object
// without the full list of part numbers and ETags, and until it does, the key
// does not exist for the transcoder to read.
type CompleteUploadRequest struct {
	VideoID  string          `json:"video_id" validate:"required"`
	UploadID string          `json:"upload_id,omitempty"`
	Parts    []CompletedPart `json:"parts,omitempty" validate:"dive"`
}

type CompletedPart struct {
	PartNumber int32  `json:"part_number" validate:"required,min=1"`
	ETag       string `json:"etag" validate:"required"`
}

// GET /api/v1/videos/{video_id}
type GetVideoResponse struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Description  string   `json:"description"`
	UploaderID   string   `json:"uploader_id"`
	UploaderName string   `json:"uploader_name"`
	ManifestURL  string   `json:"manifest_url"`
	ThumbnailURL string   `json:"thumbnail_url"`
	DurationSecs int      `json:"duration_secs"`
	ViewCount    int64    `json:"view_count"`
	LikeCount    int64    `json:"like_count"`
	DislikeCount int64    `json:"dislike_count"`
	CommentCount int64    `json:"comment_count"`
	Category     string   `json:"category"`
	Tags         []string `json:"tags"`
	// Pointer, because published_at is NULL for anything still uploading,
	// processing, or failed. Scanning that NULL into a time.Time fails outright
	// on a nullable column, and defaulting it to the zero value quietly tells
	// every client the video was published in year 1.
	PublishedAt *time.Time `json:"published_at"`
	// Only the rungs that actually exist in object storage right now. This list
	// is built from the variant rows the transcoder wrote, never from the static
	// ladder, because a fast-path publish exposes 240p and 360p minutes before
	// the rest and a client offered a rung that is not there yet gets a 404.
	Qualities []string `json:"qualities"`
}

// GET /api/v1/videos/{video_id}/stream
// Authorization rides in prefix-scoped signed cookies, not in a token appended
// to the manifest URL. A query-string token on the manifest is dropped when the
// player resolves the playlist's relative variant URIs, so it would protect
// nothing below the master playlist.
type StreamResponse struct {
	SessionID   string            `json:"session_id"`
	ManifestURL string            `json:"manifest_url"`
	CDNCookies  map[string]string `json:"cdn_cookies"`
	ResumeAt    float64           `json:"resume_at"`
	ExpiresAt   time.Time         `json:"expires_at"`
}

// POST /api/v1/videos/{video_id}/progress
type ProgressRequest struct {
	VideoID      string  `json:"video_id"`
	PositionSec  float64 `json:"position_sec"`
	Quality      string  `json:"quality"`
	BufferHealth float64 `json:"buffer_health"`
}

// GET /api/v1/recommendations?page=1&size=20
type RecommendationResponse struct {
	Videos  []VideoSummary `json:"videos"`
	HasMore bool           `json:"has_more"`
}

type VideoSummary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	ThumbnailURL string `json:"thumbnail_url"`
	DurationSecs int    `json:"duration_secs"`
	ViewCount    int64  `json:"view_count"`
	UploaderName string `json:"uploader_name"`
}

// GET /api/v1/search?q=golang+tutorial&sort=relevance&page=1
type SearchResponse struct {
	Query  string         `json:"query"`
	Total  int64          `json:"total"`
	Videos []VideoSummary `json:"videos"`
}

// POST /api/v1/videos/{video_id}/comments
type CreateCommentRequest struct {
	Text     string `json:"text" validate:"required,max=10000"`
	ParentID string `json:"parent_id,omitempty"`
}

type Comment struct {
	ID         string    `json:"id"`
	UserID     string    `json:"user_id"`
	UserName   string    `json:"user_name"`
	Text       string    `json:"text"`
	LikeCount  int64     `json:"like_count"`
	ReplyCount int64     `json:"reply_count"`
	CreatedAt  time.Time `json:"created_at"`
}
```

### gRPC Service Definitions (Internal)

While the public API uses REST for broad client compatibility, internal service-to-service communication uses gRPC. The gains are protobuf's compact binary encoding, a generated and enforced schema on both sides, and long-lived multiplexed HTTP/2 connections that avoid per-call setup. The honest framing is that most of this is available to a well-run REST service over HTTP/2 as well, and the decisive advantage internally is the typed contract and code generation, not raw wire speed. The reason REST stays on the public edge is equally practical: browsers, smart TVs, and third-party clients all speak it without a toolchain.

Note `GetBatch` alongside `GetVideo`. The batch variant is not a convenience, it is what keeps the recommendation path from issuing 500 sequential lookups per request.

```protobuf
service VideoService {
  rpc GetVideo(GetVideoReq) returns (VideoInfo);
  rpc GetBatch(GetBatchReq) returns (VideoBatch);
  rpc UpdateViewCount(ViewCountReq) returns (Empty);
}

service TranscodeService {
  rpc SubmitJob(TranscodeJobReq) returns (TranscodeJobResp);
  rpc GetJobStatus(JobStatusReq) returns (JobStatus);
  rpc CancelJob(CancelJobReq) returns (Empty);
}

service RecommendationService {
  rpc GetCandidates(CandidateReq) returns (CandidateResp);
  rpc RankCandidates(RankReq) returns (RankedList);
  rpc RecordImpression(ImpressionReq) returns (Empty);
}
```

---
