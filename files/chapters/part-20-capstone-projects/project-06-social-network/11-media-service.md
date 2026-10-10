## Media Service

The Media Service handles image uploads, processing, and storage for the social network. When a user uploads an image, the service generates multiple sizes (thumbnail, medium, and large) so that the frontend can load the appropriate resolution depending on the context. All files are stored in S3-compatible object storage using MinIO, which makes it easy to switch to AWS S3, Google Cloud Storage, or any other provider in production. The service also records metadata like dimensions, file size, and MIME type in PostgreSQL for later retrieval.

### Media Upload and Processing

The media service accepts binary uploads, validates MIME types and file sizes, generates thumbnails asynchronously, and stores originals in object storage. Processing transformations in a worker queue decouples upload acknowledgment from potentially slow image resizing operations.

```go
// internal/service/media.go
package service

import (
    "bytes"
    "context"
    "fmt"
    "image"
    _ "image/jpeg"
    _ "image/png"
    "io"
    "path/filepath"
    "strings"

    "github.com/disintegration/imaging"
    "github.com/google/uuid"
    "github.com/minio/minio-go/v7"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/domain/repository"
    "go.uber.org/zap"
)

type MediaService struct {
    mediaRepo  repository.MediaRepository
    minioClient *minio.Client
    bucketName string
    logger     *zap.Logger
}

func NewMediaService(
    mediaRepo repository.MediaRepository,
    minioClient *minio.Client,
    bucketName string,
    logger *zap.Logger,
) *MediaService {
    return &MediaService{
        mediaRepo:   mediaRepo,
        minioClient: minioClient,
        bucketName:  bucketName,
        logger:      logger,
    }
}

type UploadResult struct {
    OriginalURL  string
    ThumbnailURL string
    MediumURL    string
    LargeURL     string
    Width        int
    Height       int
}

func (s *MediaService) UploadImage(ctx context.Context, userID uuid.UUID, reader io.Reader, filename string) (*UploadResult, error) {
    // Read image data
    data, err := io.ReadAll(reader)
    if err != nil {
        return nil, fmt.Errorf("read image data: %w", err)
    }

    // Decode image to get dimensions
    img, format, err := image.Decode(bytes.NewReader(data))
    if err != nil {
        return nil, fmt.Errorf("decode image: %w", err)
    }

    bounds := img.Bounds()
    width := bounds.Dx()
    height := bounds.Dy()

    s.logger.Info("image decoded",
        zap.String("format", format),
        zap.Int("width", width),
        zap.Int("height", height),
    )

    // Generate unique filename
    ext := filepath.Ext(filename)
    if ext == "" {
        ext = "." + format
    }
    baseFilename := uuid.New().String()

    // Upload original
    originalKey := fmt.Sprintf("media/%s/original/%s%s", userID.String(), baseFilename, ext)
    originalURL, err := s.uploadToS3(ctx, originalKey, data, "image/"+format)
    if err != nil {
        return nil, fmt.Errorf("upload original: %w", err)
    }

    // Generate and upload thumbnail (200x200)
    thumbnail := imaging.Fit(img, 200, 200, imaging.Lanczos)
    thumbnailData, err := s.encodeImage(thumbnail, format)
    if err != nil {
        return nil, fmt.Errorf("encode thumbnail: %w", err)
    }

    thumbnailKey := fmt.Sprintf("media/%s/thumbnail/%s%s", userID.String(), baseFilename, ext)
    thumbnailURL, err := s.uploadToS3(ctx, thumbnailKey, thumbnailData, "image/"+format)
    if err != nil {
        s.logger.Error("failed to upload thumbnail", zap.Error(err))
        thumbnailURL = originalURL // Fallback to original
    }

    // Generate and upload medium size (600x600)
    medium := imaging.Fit(img, 600, 600, imaging.Lanczos)
    mediumData, err := s.encodeImage(medium, format)
    if err != nil {
        return nil, fmt.Errorf("encode medium: %w", err)
    }

    mediumKey := fmt.Sprintf("media/%s/medium/%s%s", userID.String(), baseFilename, ext)
    mediumURL, err := s.uploadToS3(ctx, mediumKey, mediumData, "image/"+format)
    if err != nil {
        s.logger.Error("failed to upload medium", zap.Error(err))
        mediumURL = originalURL
    }

    // Generate and upload large size (1200x1200)
    large := imaging.Fit(img, 1200, 1200, imaging.Lanczos)
    largeData, err := s.encodeImage(large, format)
    if err != nil {
        return nil, fmt.Errorf("encode large: %w", err)
    }

    largeKey := fmt.Sprintf("media/%s/large/%s%s", userID.String(), baseFilename, ext)
    largeURL, err := s.uploadToS3(ctx, largeKey, largeData, "image/"+format)
    if err != nil {
        s.logger.Error("failed to upload large", zap.Error(err))
        largeURL = originalURL
    }

    // Save metadata to database
    media := &domain.Media{
        ID:           uuid.New(),
        UserID:       userID,
        OriginalURL:  originalURL,
        ThumbnailURL: &thumbnailURL,
        MediumURL:    &mediumURL,
        LargeURL:     &largeURL,
        MediaType:    "image",
        MimeType:     "image/" + format,
        SizeBytes:    int64(len(data)),
        Width:        &width,
        Height:       &height,
    }

    if err := s.mediaRepo.Create(ctx, media); err != nil {
        s.logger.Error("failed to save media metadata", zap.Error(err))
        // Not critical, continue
    }

    s.logger.Info("image uploaded successfully",
        zap.String("media_id", media.ID.String()),
        zap.String("original_url", originalURL),
    )

    return &UploadResult{
        OriginalURL:  originalURL,
        ThumbnailURL: thumbnailURL,
        MediumURL:    mediumURL,
        LargeURL:     largeURL,
        Width:        width,
        Height:       height,
    }, nil
}

func (s *MediaService) uploadToS3(ctx context.Context, key string, data []byte, contentType string) (string, error) {
    reader := bytes.NewReader(data)

    _, err := s.minioClient.PutObject(
        ctx,
        s.bucketName,
        key,
        reader,
        int64(len(data)),
        minio.PutObjectOptions{
            ContentType: contentType,
        },
    )
    if err != nil {
        return "", fmt.Errorf("upload to s3: %w", err)
    }

    // Return public URL
    url := fmt.Sprintf("https://%s.s3.amazonaws.com/%s", s.bucketName, key)
    return url, nil
}

func (s *MediaService) encodeImage(img image.Image, format string) ([]byte, error) {
    var buf bytes.Buffer

    switch strings.ToLower(format) {
    case "jpeg", "jpg":
        if err := imaging.Encode(&buf, img, imaging.JPEG); err != nil {
            return nil, err
        }
    case "png":
        if err := imaging.Encode(&buf, img, imaging.PNG); err != nil {
            return nil, err
        }
    default:
        return nil, fmt.Errorf("unsupported format: %s", format)
    }

    return buf.Bytes(), nil
}
```

### Junior → FAANG: Understanding Media Processing Pipelines

Junior candidates often conflate storing a file with serving a file. A media service is not a file system proxy. The gap shows when candidates cannot explain why you generate multiple image sizes at upload time rather than resizing on the fly per request.

The prerequisite to fill: understand object storage semantics. S3-compatible stores are not block storage. Objects are immutable once written. Overwriting an object creates a new version. This matters for image processing: if you re-process an upload to fix a bug, you write new keys rather than overwriting old ones, and you need a migration plan for existing URLs.

Common first-job mistake: storing the raw binary in your database as a BLOB. This does not scale. The database becomes the bottleneck for reads and writes. Store the object in S3, store only the metadata (key, bucket, MIME type, dimensions, size, checksum) in your relational database. Your API returns presigned URLs for direct client-to-storage reads, bypassing your application server entirely.

Entry-level interview framing: when asked to design a media upload system, always separate the upload path from the processing path. Upload writes to object storage and returns. Processing (thumbnail generation, transcoding, content moderation) happens asynchronously via a queue. This is the first thing interviewers check for at mid-level: synchronous processing is a known anti-pattern.

### Senior @ FAANG: Media Platform Architecture and Cost Governance

At platform scale, the media service is a cost center with significant infrastructure spend. The staff-level problem is not "how do I process images" but "how do I govern storage lifecycle, CDN cost, and processing throughput across all product teams."

**Storage lifecycle policy as code.** Raw uploads should not live in hot storage indefinitely. Define lifecycle tiers in an ADR: originals move to infrequent-access storage after 30 days, to archival after 180 days, and are deleted after the retention policy expires (subject to legal holds). This is not a manual operation. It is configured as bucket lifecycle rules and versioned alongside application code. Failing to define lifecycle policy early results in unbounded storage costs that become politically difficult to address retroactively when teams own content in production.

**CDN cache invalidation governance.** Serving images through a CDN requires a deliberate invalidation strategy. Immutable content (original uploads identified by content hash in the key) never needs invalidation. Mutable content (profile photos, cover images) requires cache invalidation on update. At scale, eager invalidation per user action is expensive. Consider using versioned URLs instead: include a version token in the URL so the CDN treats updated content as a new object. The governance question is who controls the CDN invalidation budget and how to prevent runaway invalidation from a buggy deployment.

**Content moderation integration.** At FAANG, user-generated media must pass content moderation before becoming publicly accessible. The architecture pattern is: upload succeeds, object is stored in a quarantine prefix, a moderation queue event fires, the moderation service scans the content and updates its status, only then does the object become accessible via the public prefix. Your application layer checks the moderation status before returning a presigned URL. This requires a state machine for media objects: pending, approved, rejected, under_review. Defining this state machine explicitly in code and in the ADR prevents product teams from accidentally serving unmoderated content.

**Processing capacity planning.** Media processing (image resizing, video transcoding) is CPU-intensive. At L6/L7, you design the processing layer as an independent horizontally scalable fleet, separate from the API tier, with its own scaling policy based on queue depth rather than CPU utilization. Queue depth is a leading indicator. CPU utilization is a lagging indicator. Define SLOs for processing latency per media type: images processed within 5 seconds, videos within 60 seconds for the first minute of content. These SLOs drive the scaling parameters and the alerting thresholds.

**Deduplication via content hash.** At scale, users frequently upload the same image (memes, brand assets, stock photos). Content-addressed storage using SHA-256 of the file content as the object key deduplicates storage cost transparently. Before writing, check if the hash key already exists. If it does, skip the write and return the existing key. This optimization can reduce storage volume significantly in social media contexts. It also creates a shared ownership problem: if two users reference the same object, who controls deletion? The answer requires a reference count and a soft-delete pattern, not hard deletion.

---
