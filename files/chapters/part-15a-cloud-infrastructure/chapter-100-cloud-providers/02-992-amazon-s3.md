## 100.2 Amazon S3

### S3 Operations

The `S3Client` wrapper uses the AWS SDK v2's `s3.Client` internally and pins a bucket name at construction time, keeping call sites free of repeated bucket string literals. Presigned URLs are generated entirely in-process without making an S3 API call, allowing your backend to delegate upload and download authorization to clients while the actual transfer bypasses your servers entirely. For objects larger than the single-part limit, the multipart upload path splits the stream into fixed-size chunks, tracks each part's `ETag`, and aborts the incomplete upload on any error to avoid accruing storage costs for orphaned parts.

```go
package storage

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3Client struct {
    client *s3.Client
    bucket string
}

func NewS3Client(client *s3.Client, bucket string) *S3Client {
    return &S3Client{client: client, bucket: bucket}
}

// Upload file to S3
func (c *S3Client) Upload(ctx context.Context, key string, data []byte, contentType string) error {
    _, err := c.client.PutObject(ctx, &s3.PutObjectInput{
        Bucket:      aws.String(c.bucket),
        Key:         aws.String(key),
        Body:        bytes.NewReader(data),
        ContentType: aws.String(contentType),
    })
    return err
}

// Download file from S3
func (c *S3Client) Download(ctx context.Context, key string) ([]byte, error) {
    result, err := c.client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: aws.String(c.bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return nil, err
    }
    defer result.Body.Close()

    return io.ReadAll(result.Body)
}

// Delete file from S3
func (c *S3Client) Delete(ctx context.Context, key string) error {
    _, err := c.client.DeleteObject(ctx, &s3.DeleteObjectInput{
        Bucket: aws.String(c.bucket),
        Key:    aws.String(key),
    })
    return err
}

// List objects with prefix
func (c *S3Client) List(ctx context.Context, prefix string) ([]string, error) {
    var keys []string
    paginator := s3.NewListObjectsV2Paginator(c.client, &s3.ListObjectsV2Input{
        Bucket: aws.String(c.bucket),
        Prefix: aws.String(prefix),
    })

    for paginator.HasMorePages() {
        page, err := paginator.NextPage(ctx)
        if err != nil {
            return nil, err
        }
        for _, obj := range page.Contents {
            keys = append(keys, *obj.Key)
        }
    }

    return keys, nil
}

// Generate presigned URL for uploads
func (c *S3Client) GetPresignedUploadURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
    presignClient := s3.NewPresignClient(c.client)

    presignedReq, err := presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
        Bucket: aws.String(c.bucket),
        Key:    aws.String(key),
    }, s3.WithPresignExpires(expiry))
    if err != nil {
        return "", err
    }

    return presignedReq.URL, nil
}

// Generate presigned URL for downloads
func (c *S3Client) GetPresignedDownloadURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
    presignClient := s3.NewPresignClient(c.client)

    presignedReq, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
        Bucket: aws.String(c.bucket),
        Key:    aws.String(key),
    }, s3.WithPresignExpires(expiry))
    if err != nil {
        return "", err
    }

    return presignedReq.URL, nil
}

// Multipart upload for large files
func (c *S3Client) MultipartUpload(ctx context.Context, key string, data io.Reader, partSize int64) error {
    // Create multipart upload
    createResp, err := c.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
        Bucket: aws.String(c.bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return fmt.Errorf("create multipart upload: %w", err)
    }

    uploadID := createResp.UploadId
    var completedParts []types.CompletedPart
    partNumber := int32(1)

    buf := make([]byte, partSize)
    for {
        n, err := io.ReadFull(data, buf)
        if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
            // Abort upload on error
            c.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
                Bucket:   aws.String(c.bucket),
                Key:      aws.String(key),
                UploadId: uploadID,
            })
            return fmt.Errorf("read data: %w", err)
        }
        if n == 0 {
            break
        }

        // Upload part
        uploadResp, err := c.client.UploadPart(ctx, &s3.UploadPartInput{
            Bucket:     aws.String(c.bucket),
            Key:        aws.String(key),
            PartNumber: aws.Int32(partNumber),
            UploadId:   uploadID,
            Body:       bytes.NewReader(buf[:n]),
        })
        if err != nil {
            c.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
                Bucket:   aws.String(c.bucket),
                Key:      aws.String(key),
                UploadId: uploadID,
            })
            return fmt.Errorf("upload part %d: %w", partNumber, err)
        }

        completedParts = append(completedParts, types.CompletedPart{
            ETag:       uploadResp.ETag,
            PartNumber: aws.Int32(partNumber),
        })
        partNumber++

        if err == io.EOF || err == io.ErrUnexpectedEOF {
            break
        }
    }

    // Complete multipart upload
    _, err = c.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
        Bucket:   aws.String(c.bucket),
        Key:      aws.String(key),
        UploadId: uploadID,
        MultipartUpload: &types.CompletedMultipartUpload{
            Parts: completedParts,
        },
    })
    if err != nil {
        return fmt.Errorf("complete multipart upload: %w", err)
    }

    return nil
}
```

---

### Junior → FAANG: S3 as an Object Store, Not a Filesystem

The most common junior misconception about S3 is treating it as a hierarchical filesystem. S3 is a flat key-value store where "directories" are just key prefixes. This matters for performance: S3's throughput scales with key prefix diversity. If all your keys start with the same prefix (like a date prefix `2024-01-01/`), all traffic hits the same S3 partition and you will be throttled. Using UUIDs or hashes as key prefixes distributes traffic across S3's partitioning infrastructure.

The consistency model (strong read-after-write consistency for new objects, strong consistency for overwrites and deletes since December 2020) means that an S3 object is immediately readable after a successful PutObject call. This is significantly better than the eventual consistency model of older versions, and code that was written with eventual consistency workarounds can sometimes be simplified.

First-job habit: always use server-side encryption for S3 objects containing user data. AWS KMS-based encryption (SSE-KMS) provides audit logging of every encryption key usage and is the right default for any sensitive data. SSE-S3 (AWS-managed keys) is acceptable for non-sensitive data.

### Senior @ FAANG: S3 Architecture for High-Scale Storage Workloads

At staff level, S3 is the foundation of many data architectures: data lakes, artifact storage, log archives, static asset delivery, and backup systems. Each use case has different performance, cost, and access pattern requirements that need to be matched to the right S3 configuration.

The storage class selection decision is a cost optimization lever with significant impact at scale. S3 Standard (immediate access, highest cost), S3 Standard-IA (infrequent access, lower cost with retrieval fee), S3 Glacier (archive, very low cost with high retrieval latency and cost) and S3 Intelligent-Tiering (automatic class selection based on access patterns) each have appropriate use cases. Implementing lifecycle policies that automatically transition objects through storage classes as they age is a standard cost optimization for any high-volume S3 usage.

The S3 performance architecture for read-heavy workloads involves CloudFront as the CDN layer, with appropriate cache-control headers on the S3 objects to maximize cache hit rate and reduce S3 request volume. For write-heavy workloads, S3 Transfer Acceleration (uses CloudFront's edge network for upload) can reduce latency for geographically distributed uploaders. The S3 Express One Zone storage class provides significantly lower latency for latency-sensitive workloads at the cost of availability (single AZ). The staff engineer's role is to evaluate these options against the specific workload's requirements and make a documented recommendation.
