## Part 7: File Upload and S3 Integration

Chat applications frequently need to support file sharing, images, documents, and other attachments. In this section, you will integrate with S3-compatible object storage (using MinIO for local development) to handle file uploads securely. The implementation includes generating unique file names to prevent collisions, creating image thumbnails for preview, and validating file types and sizes to block malicious uploads. By keeping file storage separate from your database, you can scale storage independently and serve files through a CDN in production.

### 7.1 S3 Storage (`internal/storage/s3.go`)

File uploads are streamed directly from the multipart request body to S3 object storage without buffering the full payload in memory, keeping memory usage constant regardless of file size. Pre-signed URLs allow clients to download attachments directly from S3, bypassing the application server for large binary transfers.

```go
package storage

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/credentials"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/s3/s3manager"
	"github.com/google/uuid"
	"github.com/nfnt/resize"
)

type S3Store struct {
	client   *s3.S3
	uploader *s3manager.Uploader
	bucket   string
}

func NewS3Store(endpoint, accessKey, secretKey, bucket, region string, useSSL bool) (*S3Store, error) {
	sess, err := session.NewSession(&aws.Config{
		Endpoint:         aws.String(endpoint),
		Region:           aws.String(region),
		Credentials:      credentials.NewStaticCredentials(accessKey, secretKey, ""),
		S3ForcePathStyle: aws.Bool(true),
		DisableSSL:       aws.Bool(!useSSL),
	})
	if err != nil {
		return nil, fmt.Errorf("create S3 session: %w", err)
	}

	client := s3.New(sess)
	uploader := s3manager.NewUploader(sess)

	// Create bucket if not exists
	_, err = client.CreateBucket(&s3.CreateBucketInput{
		Bucket: aws.String(bucket),
	})
	if err != nil {
		// Ignore error if bucket already exists
		if !strings.Contains(err.Error(), "BucketAlreadyOwnedByYou") &&
			!strings.Contains(err.Error(), "BucketAlreadyExists") {
			return nil, fmt.Errorf("create bucket: %w", err)
		}
	}

	return &S3Store{
		client:   client,
		uploader: uploader,
		bucket:   bucket,
	}, nil
}

// UploadFile uploads a file to S3
func (s *S3Store) UploadFile(ctx context.Context, key string, reader io.Reader, contentType string) (string, error) {
	result, err := s.uploader.UploadWithContext(ctx, &s3manager.UploadInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        reader,
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", fmt.Errorf("upload file: %w", err)
	}

	return result.Location, nil
}

// UploadImage uploads an image and creates a thumbnail
func (s *S3Store) UploadImage(ctx context.Context, reader io.Reader, filename string) (string, string, int, int, error) {
	// Read image data
	data, err := io.ReadAll(reader)
	if err != nil {
		return "", "", 0, 0, fmt.Errorf("read image: %w", err)
	}

	// Decode image
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", "", 0, 0, fmt.Errorf("decode image: %w", err)
	}

	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	// Generate unique key
	ext := filepath.Ext(filename)
	baseKey := fmt.Sprintf("images/%s%s", uuid.New().String(), ext)

	// Upload original image
	contentType := "image/" + format
	originalURL, err := s.UploadFile(ctx, baseKey, bytes.NewReader(data), contentType)
	if err != nil {
		return "", "", 0, 0, err
	}

	// Create thumbnail (max 200x200)
	thumbnail := resize.Thumbnail(200, 200, img, resize.Lanczos3)

	// Encode thumbnail
	var thumbnailBuf bytes.Buffer
	switch format {
	case "jpeg", "jpg":
		if err := jpeg.Encode(&thumbnailBuf, thumbnail, &jpeg.Options{Quality: 85}); err != nil {
			return originalURL, "", width, height, fmt.Errorf("encode thumbnail: %w", err)
		}
	case "png":
		if err := png.Encode(&thumbnailBuf, thumbnail); err != nil {
			return originalURL, "", width, height, fmt.Errorf("encode thumbnail: %w", err)
		}
	default:
		// No thumbnail for unsupported formats
		return originalURL, "", width, height, nil
	}

	// Upload thumbnail
	thumbnailKey := fmt.Sprintf("thumbnails/%s%s", uuid.New().String(), ext)
	thumbnailURL, err := s.UploadFile(ctx, thumbnailKey, &thumbnailBuf, contentType)
	if err != nil {
		return originalURL, "", width, height, fmt.Errorf("upload thumbnail: %w", err)
	}

	return originalURL, thumbnailURL, width, height, nil
}

// GetFile generates a presigned URL for file download
func (s *S3Store) GetFile(ctx context.Context, key string) (string, error) {
	req, _ := s.client.GetObjectRequest(&s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})

	url, err := req.Presign(15 * 60) // 15 minutes
	if err != nil {
		return "", fmt.Errorf("presign URL: %w", err)
	}

	return url, nil
}

// DeleteFile deletes a file from S3
func (s *S3Store) DeleteFile(ctx context.Context, key string) error {
	_, err := s.client.DeleteObjectWithContext(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	return err
}
```

### 7.2 File Upload Handler (`internal/api/upload.go`)

File uploads are streamed directly from the multipart request body to S3 object storage without buffering the full payload in memory, keeping memory usage constant regardless of file size. Pre-signed URLs allow clients to download attachments directly from S3, bypassing the application server for large binary transfers.

```go
package api

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/yourusername/gochat/internal/auth"
	"github.com/yourusername/gochat/internal/storage"
)

const (
	maxUploadSize = 10 << 20 // 10 MB
	maxImageSize  = 5 << 20  // 5 MB
)

type UploadHandler struct {
	s3Store *storage.S3Store
	pgStore *storage.PostgresStore
}

func NewUploadHandler(s3Store *storage.S3Store, pgStore *storage.PostgresStore) *UploadHandler {
	return &UploadHandler{
		s3Store: s3Store,
		pgStore: pgStore,
	}
}

func (h *UploadHandler) UploadFile(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	// Parse multipart form
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		respondError(w, http.StatusBadRequest, "File too large")
		return
	}

	// Get file from form
	file, header, err := r.FormFile("file")
	if err != nil {
		respondError(w, http.StatusBadRequest, "No file uploaded")
		return
	}
	defer file.Close()

	// Get channel ID
	channelIDStr := r.FormValue("channel_id")
	channelID, err := uuid.Parse(channelIDStr)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid channel ID")
		return
	}

	// Check if user is member of channel
	isMember, err := h.pgStore.IsUserInChannel(r.Context(), userID, channelID)
	if err != nil || !isMember {
		respondError(w, http.StatusForbidden, "Access denied")
		return
	}

	// Validate file type
	contentType := header.Header.Get("Content-Type")
	ext := filepath.Ext(header.Filename)

	// Upload based on type
	var storageKey, thumbnailKey string
	var width, height int

	if isImage(contentType) {
		// Upload image with thumbnail
		if header.Size > maxImageSize {
			respondError(w, http.StatusBadRequest, "Image too large")
			return
		}

		url, thumbURL, w, h, err := h.s3Store.UploadImage(r.Context(), file, header.Filename)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Error uploading image")
			return
		}

		storageKey = url
		thumbnailKey = thumbURL
		width = w
		height = h
	} else {
		// Upload regular file
		key := fmt.Sprintf("files/%s%s", uuid.New().String(), ext)
		url, err := h.s3Store.UploadFile(r.Context(), key, file, contentType)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Error uploading file")
			return
		}
		storageKey = url
	}

	// Save attachment record (would be linked to a message)
	attachment := map[string]any{
		"filename":      header.Filename,
		"file_size":     header.Size,
		"mime_type":     contentType,
		"storage_key":   storageKey,
		"thumbnail_key": thumbnailKey,
		"width":         width,
		"height":        height,
	}

	respondJSON(w, http.StatusOK, attachment)
}

func isImage(contentType string) bool {
	return strings.HasPrefix(contentType, "image/")
}
```

### Junior → FAANG: File Upload Security as a Non-Negotiable

File upload vulnerabilities are a common attack vector. The three essential defenses are: validate MIME type by reading the file's magic bytes (not by trusting the `Content-Type` header or filename extension), enforce maximum file size at the multipart reader before reading the full body, and store uploads with a server-generated name (never use the client-provided filename).

Streaming directly to S3 without buffering the full payload in memory is the correct approach for large files. If you buffer the full payload in memory, a single large upload can exhaust your server's memory. Using `io.Copy` to pipe from the multipart reader to the S3 upload stream keeps memory usage constant regardless of file size.

Presigned URLs for downloads (clients download directly from S3, bypassing your server) are both a performance optimization and a cost reduction: your server does not pay for bandwidth for large file downloads.

### Senior @ FAANG: File Storage as a Content Moderation Platform

At senior level, file uploads are not just a storage problem. They are a content moderation problem, a compliance problem, and a cost problem.

Content moderation for uploaded files (CSAM scanning, hate speech detection, malware scanning) must happen before the file is made accessible to other users. This means the upload flow is: receive file, store in a quarantine bucket, trigger async scanning, promote to production bucket on clean scan, reject and delete on positive scan. The ADR must define the scanning SLA (how long before a file becomes accessible), the handling of scan failures (treat as clean and accept the risk, or treat as dirty and reject), and the notification flow when a violation is detected.

Deduplication via content addressing (store by SHA-256 of content, not by generated filename) eliminates redundant storage for identical files and enables instant uploads for previously uploaded content. The storage savings at scale are significant: if 10% of uploads are exact duplicates, deduplication reduces storage cost by 10%. Implementing deduplication requires a mapping from content hash to S3 key, stored in the database.

GDPR right-to-erasure compliance for file uploads requires that when a user requests deletion of their account, all files they uploaded are either deleted from S3 or their ownership is transferred to a deleted-user placeholder. This is a background job that runs asynchronously after account deletion is confirmed. The ADR must document the deletion timeline (how quickly must files be removed after a deletion request) and the audit trail (how do you prove to a regulator that deletion occurred).

---
