// internal/storage/artifact.go
package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ArtifactStore defines the interface for artifact storage
type ArtifactStore interface {
	UploadArtifact(ctx context.Context, data []byte, path string) (uri string, hash string, err error)
	DownloadArtifact(ctx context.Context, uri string) ([]byte, error)
	DeleteArtifact(ctx context.Context, uri string) error
	GetArtifactURL(ctx context.Context, uri string, expirySeconds int) (string, error)
}

// S3ArtifactStore implements ArtifactStore using S3/MinIO
type S3ArtifactStore struct {
	client     *minio.Client
	bucketName string
	prefix     string
}

// NewS3ArtifactStore creates a new S3-compatible artifact store
func NewS3ArtifactStore(endpoint, accessKey, secretKey, bucket, prefix string, useSSL bool) (*S3ArtifactStore, error) {
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("creating S3 client: %w", err)
	}

	store := &S3ArtifactStore{
		client:     client,
		bucketName: bucket,
		prefix:     prefix,
	}

	// Ensure bucket exists
	ctx := context.Background()
	exists, err := client.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("checking bucket existence: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("creating bucket: %w", err)
		}
	}

	return store, nil
}

// UploadArtifact uploads an artifact and returns its URI and hash
func (s *S3ArtifactStore) UploadArtifact(ctx context.Context, data []byte, path string) (string, string, error) {
	// Compute hash
	hasher := sha256.New()
	hasher.Write(data)
	hash := hex.EncodeToString(hasher.Sum(nil))

	// Generate storage path
	objectName := filepath.Join(s.prefix, path)

	// Upload to S3
	reader := bytes.NewReader(data)
	_, err := s.client.PutObject(ctx, s.bucketName, objectName, reader, int64(len(data)), minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	if err != nil {
		return "", "", fmt.Errorf("uploading to S3: %w", err)
	}

	uri := fmt.Sprintf("s3://%s/%s", s.bucketName, objectName)
	return uri, hash, nil
}

// DownloadArtifact downloads an artifact by URI
func (s *S3ArtifactStore) DownloadArtifact(ctx context.Context, uri string) ([]byte, error) {
	// Parse URI (assuming s3://bucket/path format)
	objectName := extractObjectName(uri)

	object, err := s.client.GetObject(ctx, s.bucketName, objectName, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("getting object: %w", err)
	}
	defer object.Close()

	data, err := io.ReadAll(object)
	if err != nil {
		return nil, fmt.Errorf("reading object: %w", err)
	}

	return data, nil
}

// DeleteArtifact deletes an artifact by URI
func (s *S3ArtifactStore) DeleteArtifact(ctx context.Context, uri string) error {
	objectName := extractObjectName(uri)

	err := s.client.RemoveObject(ctx, s.bucketName, objectName, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("deleting object: %w", err)
	}

	return nil
}

// GetArtifactURL generates a presigned URL for artifact download
func (s *S3ArtifactStore) GetArtifactURL(ctx context.Context, uri string, expirySeconds int) (string, error) {
	objectName := extractObjectName(uri)

	url, err := s.client.PresignedGetObject(ctx, s.bucketName, objectName,
		time.Duration(expirySeconds)*time.Second, nil)
	if err != nil {
		return "", fmt.Errorf("generating presigned URL: %w", err)
	}

	return url.String(), nil
}

func extractObjectName(uri string) string {
	// Extract object name from s3://bucket/path
	parts := strings.SplitN(uri, "/", 4)
	if len(parts) == 4 {
		return parts[3]
	}
	return uri
}
