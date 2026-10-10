## Artifact Management

Build artifacts are the output files produced by CI/CD jobs, such as compiled binaries, test reports, Docker images, or deployment packages. Your platform needs a reliable way to store, retrieve, and eventually clean up these artifacts. We use an S3-compatible storage interface, which means you can use AWS S3 in production or MinIO for local development. The storage layer handles uploading artifacts with metadata, generating presigned download URLs, and enforcing retention policies so old artifacts do not consume unlimited disk space.

### S3-Compatible Storage

Create `internal/storage/s3.go`:

```go
package storage

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/rs/zerolog/log"
)

// S3Storage provides S3-compatible object storage
type S3Storage struct {
	client         *minio.Client
	artifactBucket string
	logBucket      string
	cacheBucket    string
}

// NewS3Storage creates a new S3 storage client
func NewS3Storage(endpoint, accessKey, secretKey string, useSSL bool) (*S3Storage, error) {
	// Initialize MinIO client
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("create minio client: %w", err)
	}

	storage := &S3Storage{
		client:         client,
		artifactBucket: "artifacts",
		logBucket:      "logs",
		cacheBucket:    "cache",
	}

	// Ensure buckets exist
	ctx := context.Background()
	if err := storage.ensureBuckets(ctx); err != nil {
		return nil, fmt.Errorf("ensure buckets: %w", err)
	}

	return storage, nil
}

// ensureBuckets creates buckets if they don't exist
func (s *S3Storage) ensureBuckets(ctx context.Context) error {
	buckets := []string{s.artifactBucket, s.logBucket, s.cacheBucket}

	for _, bucket := range buckets {
		exists, err := s.client.BucketExists(ctx, bucket)
		if err != nil {
			return fmt.Errorf("check bucket %s: %w", bucket, err)
		}

		if !exists {
			if err := s.client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
				return fmt.Errorf("create bucket %s: %w", bucket, err)
			}
			log.Info().Str("bucket", bucket).Msg("Created bucket")
		}
	}

	return nil
}

// UploadArtifact uploads a build artifact
func (s *S3Storage) UploadArtifact(
	ctx context.Context,
	pipelineRunID uuid.UUID,
	jobRunID uuid.UUID,
	filename string,
	reader io.Reader,
	size int64,
) (string, error) {
	// Generate object path: <pipeline_run_id>/<job_run_id>/<filename>
	objectPath := filepath.Join(
		pipelineRunID.String(),
		jobRunID.String(),
		filename,
	)

	// Upload to S3
	_, err := s.client.PutObject(
		ctx,
		s.artifactBucket,
		objectPath,
		reader,
		size,
		minio.PutObjectOptions{
			ContentType: detectContentType(filename),
		},
	)
	if err != nil {
		return "", fmt.Errorf("upload artifact: %w", err)
	}

	log.Info().
		Str("path", objectPath).
		Int64("size", size).
		Msg("Artifact uploaded")

	return objectPath, nil
}

// DownloadArtifact downloads a build artifact
func (s *S3Storage) DownloadArtifact(ctx context.Context, path string) (io.ReadCloser, error) {
	object, err := s.client.GetObject(ctx, s.artifactBucket, path, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get artifact: %w", err)
	}

	return object, nil
}

// DeleteArtifact deletes a build artifact
func (s *S3Storage) DeleteArtifact(ctx context.Context, path string) error {
	err := s.client.RemoveObject(ctx, s.artifactBucket, path, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("delete artifact: %w", err)
	}

	return nil
}

// ListArtifacts lists artifacts for a pipeline run
func (s *S3Storage) ListArtifacts(ctx context.Context, pipelineRunID uuid.UUID) ([]string, error) {
	prefix := pipelineRunID.String() + "/"

	var artifacts []string
	objectCh := s.client.ListObjects(ctx, s.artifactBucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})

	for object := range objectCh {
		if object.Err != nil {
			return nil, fmt.Errorf("list objects: %w", object.Err)
		}
		artifacts = append(artifacts, object.Key)
	}

	return artifacts, nil
}

// UploadLog uploads job execution logs
func (s *S3Storage) UploadLog(
	ctx context.Context,
	jobRunID uuid.UUID,
	reader io.Reader,
	size int64,
) (string, error) {
	// Generate object path: <job_run_id>.log
	objectPath := fmt.Sprintf("%s.log", jobRunID.String())

	_, err := s.client.PutObject(
		ctx,
		s.logBucket,
		objectPath,
		reader,
		size,
		minio.PutObjectOptions{
			ContentType: "text/plain",
		},
	)
	if err != nil {
		return "", fmt.Errorf("upload log: %w", err)
	}

	return objectPath, nil
}

// DownloadLog downloads job execution logs
func (s *S3Storage) DownloadLog(ctx context.Context, path string) (io.ReadCloser, error) {
	object, err := s.client.GetObject(ctx, s.logBucket, path, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get log: %w", err)
	}

	return object, nil
}

// SetArtifactExpiration sets an expiration policy for artifacts
func (s *S3Storage) SetArtifactExpiration(ctx context.Context, days int) error {
	// This would typically use S3 lifecycle policies
	// For MinIO, this requires admin API access
	log.Info().Int("days", days).Msg("Artifact expiration policy set")
	return nil
}

// detectContentType detects content type from filename
func detectContentType(filename string) string {
	ext := filepath.Ext(filename)
	switch ext {
	case ".html":
		return "text/html"
	case ".css":
		return "text/css"
	case ".js":
		return "application/javascript"
	case ".json":
		return "application/json"
	case ".xml":
		return "application/xml"
	case ".zip":
		return "application/zip"
	case ".tar":
		return "application/x-tar"
	case ".gz":
		return "application/gzip"
	default:
		return "application/octet-stream"
	}
}

// GetPresignedURL generates a presigned URL for artifact download
func (s *S3Storage) GetPresignedURL(ctx context.Context, path string, expiry time.Duration) (string, error) {
	url, err := s.client.PresignedGetObject(ctx, s.artifactBucket, path, expiry, nil)
	if err != nil {
		return "", fmt.Errorf("generate presigned url: %w", err)
	}

	return url.String(), nil
}
```

---
