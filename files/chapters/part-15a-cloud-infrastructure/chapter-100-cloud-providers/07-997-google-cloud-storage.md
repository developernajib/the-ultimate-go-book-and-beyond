## 100.7 Google Cloud Storage

Google Cloud Storage (GCS) organizes objects in buckets and exposes them through a streaming writer/reader API, `NewWriter` returns an `io.WriteCloser` that buffers and streams data to GCS, and the object is only committed when `Close` is called successfully. Signed URLs delegate time-limited access to private objects without requiring the caller to hold GCP credentials, making them suitable for pre-signed upload or download links in client-facing APIs. The `Objects` iterator with a `Prefix` filter performs a lexicographic prefix scan over object names, which is the idiomatic way to list pseudo-directory contents in a flat object namespace.

```go
package storage

import (
    "context"
    "fmt"
    "io"
    "time"

    "cloud.google.com/go/storage"
    "google.golang.org/api/iterator"
)

type GCSClient struct {
    client *storage.Client
    bucket string
}

func NewGCSClient(client *storage.Client, bucket string) *GCSClient {
    return &GCSClient{client: client, bucket: bucket}
}

// Upload object
func (c *GCSClient) Upload(ctx context.Context, objectName string, data []byte, contentType string) error {
    wc := c.client.Bucket(c.bucket).Object(objectName).NewWriter(ctx)
    wc.ContentType = contentType

    if _, err := wc.Write(data); err != nil {
        return fmt.Errorf("write: %w", err)
    }

    if err := wc.Close(); err != nil {
        return fmt.Errorf("close: %w", err)
    }

    return nil
}

// Download object
func (c *GCSClient) Download(ctx context.Context, objectName string) ([]byte, error) {
    rc, err := c.client.Bucket(c.bucket).Object(objectName).NewReader(ctx)
    if err != nil {
        return nil, fmt.Errorf("new reader: %w", err)
    }
    defer rc.Close()

    return io.ReadAll(rc)
}

// Delete object
func (c *GCSClient) Delete(ctx context.Context, objectName string) error {
    return c.client.Bucket(c.bucket).Object(objectName).Delete(ctx)
}

// Generate signed URL
func (c *GCSClient) GenerateSignedURL(objectName string, expiry time.Duration) (string, error) {
    opts := &storage.SignedURLOptions{
        Method:  "GET",
        Expires: time.Now().Add(expiry),
    }

    return c.client.Bucket(c.bucket).SignedURL(objectName, opts)
}

// List objects
func (c *GCSClient) List(ctx context.Context, prefix string) ([]string, error) {
    var names []string

    it := c.client.Bucket(c.bucket).Objects(ctx, &storage.Query{
        Prefix: prefix,
    })

    for {
        attrs, err := it.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            return nil, fmt.Errorf("iterate: %w", err)
        }
        names = append(names, attrs.Name)
    }

    return names, nil
}
```

---

### Junior → FAANG: GCS Fundamentals and the io.Writer/io.Reader Pattern

GCS's Go client exposes a streaming writer/reader interface that composes naturally with Go's `io` package. The key insight: `NewWriter` returns an `io.WriteCloser`, which means you can pipe data directly from any `io.Reader` using `io.Copy`. This composability is idiomatic Go and enables efficient streaming without buffering entire files in memory.

The object naming strategy matters for performance at scale (same reason as S3: GCS uses prefix-based load balancing). If all your objects have names starting with a timestamp or sequential ID, they will be concentrated on a small number of GCS partitions. Using content-based hashes or random prefixes distributes load.

First-job habit: always call `Close()` on the GCS writer and check its error return. The write is not committed until `Close()` returns successfully. A successful `io.Copy` followed by a failed `Close()` means the object is not durably stored in GCS. This is different from local file I/O where data is usually flushed before `Close()` fails.

### Senior @ FAANG: GCS Architecture and Multi-Region Data Management

At staff level, GCS bucket configuration is a data governance and cost optimization problem. The storage class selection (Standard, Nearline, Coldline, Archive) maps to access frequency and cost: Standard for frequently accessed data, Archive for compliance retention of data accessed at most once a year. Object lifecycle rules automate the transition between classes and the deletion of expired objects.

Multi-region and dual-region buckets provide higher durability and availability at higher cost. The design decision between single-region, dual-region, and multi-region storage depends on the access pattern (where are the readers located?), the availability requirement (can your application tolerate a regional GCP outage?), and the data residency requirement (some regulations require data to stay within a specific geographic boundary). This is a data governance decision that needs legal, compliance, and engineering alignment.

For large-scale data pipelines, GCS's composable objects (parallel uploads with separate parts combined server-side using `ComposeObjectRequest`) enable high-throughput writes without the coordination overhead of multipart upload. The correct pattern for very large uploads from Go is parallel chunk uploads followed by a compose operation, with retry logic for individual chunk failures. Implementing this pattern correctly is a non-trivial engineering problem that benefits from a shared library rather than per-service implementation.
