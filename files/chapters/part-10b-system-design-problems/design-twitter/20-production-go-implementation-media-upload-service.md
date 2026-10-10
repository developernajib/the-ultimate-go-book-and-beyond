## Production Go Implementation: Media Upload Service

About 30% of tweets include media (photos, videos, or GIFs), so the upload pipeline must be efficient and scalable. Instead of routing media through your application servers, this service generates a presigned S3 URL that the client uploads to directly. After the upload completes, a background worker generates thumbnail and small-size variants for different device screens. This keeps your API servers free from handling large binary payloads.

A presigned URL is a delegation of your write authority to an untrusted client, so it deserves the same scrutiny as any other authorization decision. Three properties matter. Whitelist the media type instead of looking it up in a map, because a map miss returns the zero value and `SizeBytes > 0` is a check that a zero-byte upload of an unknown type passes cleanly. Bind the size limit into the presigned policy rather than trusting the number the client declared, because the client that told you "1KB" is the same client that will send 5GB. And never interpolate a client-supplied Content-Type into the signature without constraining it first.

The other theme is that a URL for an object nobody created is worse than an error. Every ignored `Resize` error below would have produced a `small_url` pointing at nothing, with the row marked `ready`.

```go
package media

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// mediaLimits is the whitelist. A type that is not a key here is rejected,
// which is not the same as looking up a limit and comparing against the zero
// value: that lets an unknown type through with a zero-byte declared size.
var mediaLimits = map[string]struct {
	maxBytes  int64
	mimeTypes map[string]bool
}{
	"image": {5 * 1024 * 1024, map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true}},
	"gif":   {15 * 1024 * 1024, map[string]bool{"image/gif": true}},
	"video": {512 * 1024 * 1024, map[string]bool{"video/mp4": true, "video/quicktime": true}},
}

// MediaUploadService handles photo/video/GIF uploads for tweets
type MediaUploadService struct {
	presigner S3Presigner
	imageProc ImageProcessor
	videoProc VideoProcessor
	mediaDB   MediaStore
	bucket    string
	cdnBase   string
}

type MediaUploadInit struct {
	MediaType string `json:"media_type"` // "image", "video", "gif"
	MimeType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
}

type MediaUploadResult struct {
	MediaID   string    `json:"media_id"`
	UploadURL string    `json:"upload_url"`
	ExpiresAt time.Time `json:"expires_at"`
}

type ProcessedMedia struct {
	MediaID     string `json:"media_id"`
	OriginalURL string `json:"original_url"`
	SmallURL    string `json:"small_url"` // 680x510
	ThumbURL    string `json:"thumb_url"` // 150x150
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	DurationMs  int    `json:"duration_ms,omitempty"` // for video/gif
}

// InitiateUpload returns a presigned URL for direct upload
func (s *MediaUploadService) InitiateUpload(ctx context.Context, userID string, req MediaUploadInit) (*MediaUploadResult, error) {
	limit, ok := mediaLimits[req.MediaType]
	if !ok {
		return nil, fmt.Errorf("unsupported media type %q", req.MediaType)
	}
	if !limit.mimeTypes[req.MimeType] {
		return nil, fmt.Errorf("mime type %q not allowed for %s", req.MimeType, req.MediaType)
	}
	if req.SizeBytes <= 0 || req.SizeBytes > limit.maxBytes {
		return nil, fmt.Errorf("size %d out of range: max %d bytes for %s", req.SizeBytes, limit.maxBytes, req.MediaType)
	}

	mediaID := uuid.NewString()
	key := fmt.Sprintf("media/%s/%s/%s", userID, time.Now().UTC().Format("2006/01/02"), mediaID)

	// The declared size is bound into the signature as a content-length-range
	// condition and the content type is pinned. S3 rejects an upload that does
	// not match, so the limit is enforced by the store rather than by the
	// client's honesty.
	uploadURL, err := s.presigner.PresignPut(ctx, PresignParams{
		Bucket:      s.bucket,
		Key:         key,
		ContentType: req.MimeType,
		MaxBytes:    limit.maxBytes,
		Expires:     15 * time.Minute,
	})
	if err != nil {
		return nil, fmt.Errorf("presign: %w", err)
	}

	// Record the pending row before handing out the URL. If this fails, the
	// client must not get a URL for an object we have no record of, because
	// nothing would ever reap it.
	if err := s.mediaDB.Create(ctx, mediaID, userID, key, req.MediaType, "pending"); err != nil {
		return nil, fmt.Errorf("record pending media: %w", err)
	}

	return &MediaUploadResult{
		MediaID:   mediaID,
		UploadURL: uploadURL,
		ExpiresAt: time.Now().Add(15 * time.Minute),
	}, nil
}

// ProcessUploadedMedia generates thumbnails and variants.
func (s *MediaUploadService) ProcessUploadedMedia(ctx context.Context, mediaID string) (*ProcessedMedia, error) {
	media, err := s.mediaDB.Get(ctx, mediaID)
	if err != nil {
		return nil, fmt.Errorf("load media %s: %w", mediaID, err)
	}

	result := &ProcessedMedia{
		MediaID:     mediaID,
		OriginalURL: fmt.Sprintf("%s/%s", s.cdnBase, media.S3Key),
	}

	switch media.Type {
	case "image":
		smallKey := media.S3Key + "_small"
		thumbKey := media.S3Key + "_thumb"
		// A failed resize must not yield a URL. Marking the row "failed" lets
		// the tweet render the original rather than a broken image.
		dims, err := s.imageProc.Resize(ctx, media.S3Key, smallKey, 680, 510)
		if err != nil {
			s.mediaDB.UpdateStatus(ctx, mediaID, "failed")
			return nil, fmt.Errorf("resize small: %w", err)
		}
		if _, err := s.imageProc.Resize(ctx, media.S3Key, thumbKey, 150, 150); err != nil {
			s.mediaDB.UpdateStatus(ctx, mediaID, "failed")
			return nil, fmt.Errorf("resize thumb: %w", err)
		}
		result.SmallURL = fmt.Sprintf("%s/%s", s.cdnBase, smallKey)
		result.ThumbURL = fmt.Sprintf("%s/%s", s.cdnBase, thumbKey)
		result.Width, result.Height = dims.Width, dims.Height

	case "video", "gif":
		thumbKey := media.S3Key + "_thumb.jpg"
		meta, err := s.videoProc.ExtractFrame(ctx, media.S3Key, thumbKey, 0) // first frame
		if err != nil {
			s.mediaDB.UpdateStatus(ctx, mediaID, "failed")
			return nil, fmt.Errorf("extract frame: %w", err)
		}
		result.ThumbURL = fmt.Sprintf("%s/%s", s.cdnBase, thumbKey)
		result.Width, result.Height = meta.Width, meta.Height
		result.DurationMs = meta.DurationMs

	default:
		// Without this, an unrecognised type falls through the switch and gets
		// marked ready with no variants and zero dimensions.
		return nil, fmt.Errorf("unsupported stored media type %q", media.Type)
	}

	if err := s.mediaDB.UpdateStatus(ctx, mediaID, "ready"); err != nil {
		return nil, fmt.Errorf("mark ready: %w", err)
	}
	return result, nil
}
```

One authorization gap is worth naming because it is invisible in this file. A media ID is just an opaque string that a client hands back when posting a tweet, so the tweet service must verify that the media row's `user_id` matches the posting user and that its status is `ready`. Without that check, anyone who learns a media ID can attach someone else's upload to their own tweet, which is a straightforward IDOR. The ownership check belongs on the attach path, not here.

---
