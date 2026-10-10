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
		Endpoint:         new(endpoint),
		Region:           new(region),
		Credentials:      credentials.NewStaticCredentials(accessKey, secretKey, ""),
		S3ForcePathStyle: new(true),
		DisableSSL:       new(!useSSL),
	})
	if err != nil {
		return nil, fmt.Errorf("create S3 session: %w", err)
	}

	client := s3.New(sess)
	uploader := s3manager.NewUploader(sess)

	// Create bucket if not exists
	_, err = client.CreateBucket(&s3.CreateBucketInput{
		Bucket: new(bucket),
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
		Bucket:      new(s.bucket),
		Key:         new(key),
		Body:        reader,
		ContentType: new(contentType),
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
		Bucket: new(s.bucket),
		Key:    new(key),
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
		Bucket: new(s.bucket),
		Key:    new(key),
	})
	return err
}
