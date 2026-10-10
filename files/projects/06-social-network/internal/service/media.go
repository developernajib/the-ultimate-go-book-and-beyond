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
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
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
