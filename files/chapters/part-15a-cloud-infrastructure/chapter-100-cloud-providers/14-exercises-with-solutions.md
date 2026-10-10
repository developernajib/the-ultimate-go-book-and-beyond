## 100.14 Exercises with Solutions

### Exercise 1: Build a Cloud-Agnostic Storage Interface

**Problem**: Create a storage interface that works with both S3 and GCS.

```go
// Solution: Cloud-agnostic storage
package cloudstorage

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "time"

    "cloud.google.com/go/storage"
    awsconfig "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "google.golang.org/api/iterator"
)

// CloudStorage defines the interface for object storage operations
type CloudStorage interface {
    Upload(ctx context.Context, bucket, key string, data []byte, contentType string) error
    Download(ctx context.Context, bucket, key string) ([]byte, error)
    Delete(ctx context.Context, bucket, key string) error
    List(ctx context.Context, bucket, prefix string) ([]string, error)
    GeneratePresignedURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error)
}

// S3Storage implements CloudStorage for AWS S3
type S3Storage struct {
    client *s3.Client
}

func NewS3Storage(ctx context.Context, region string) (*S3Storage, error) {
    cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
    if err != nil {
        return nil, err
    }
    return &S3Storage{client: s3.NewFromConfig(cfg)}, nil
}

func (s *S3Storage) Upload(ctx context.Context, bucket, key string, data []byte, contentType string) error {
    _, err := s.client.PutObject(ctx, &s3.PutObjectInput{
        Bucket:      &bucket,
        Key:         &key,
        Body:        bytes.NewReader(data),
        ContentType: &contentType,
    })
    return err
}

func (s *S3Storage) Download(ctx context.Context, bucket, key string) ([]byte, error) {
    result, err := s.client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: &bucket,
        Key:    &key,
    })
    if err != nil {
        return nil, err
    }
    defer result.Body.Close()
    return io.ReadAll(result.Body)
}

func (s *S3Storage) Delete(ctx context.Context, bucket, key string) error {
    _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
        Bucket: &bucket,
        Key:    &key,
    })
    return err
}

func (s *S3Storage) List(ctx context.Context, bucket, prefix string) ([]string, error) {
    var keys []string
    paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
        Bucket: &bucket,
        Prefix: &prefix,
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

func (s *S3Storage) GeneratePresignedURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
    presignClient := s3.NewPresignClient(s.client)
    req, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
        Bucket: &bucket,
        Key:    &key,
    }, s3.WithPresignExpires(expiry))
    if err != nil {
        return "", err
    }
    return req.URL, nil
}

// GCSStorage implements CloudStorage for Google Cloud Storage
type GCSStorage struct {
    client *storage.Client
}

func NewGCSStorage(ctx context.Context) (*GCSStorage, error) {
    client, err := storage.NewClient(ctx)
    if err != nil {
        return nil, err
    }
    return &GCSStorage{client: client}, nil
}

func (g *GCSStorage) Upload(ctx context.Context, bucket, key string, data []byte, contentType string) error {
    wc := g.client.Bucket(bucket).Object(key).NewWriter(ctx)
    wc.ContentType = contentType
    if _, err := wc.Write(data); err != nil {
        return err
    }
    return wc.Close()
}

func (g *GCSStorage) Download(ctx context.Context, bucket, key string) ([]byte, error) {
    rc, err := g.client.Bucket(bucket).Object(key).NewReader(ctx)
    if err != nil {
        return nil, err
    }
    defer rc.Close()
    return io.ReadAll(rc)
}

func (g *GCSStorage) Delete(ctx context.Context, bucket, key string) error {
    return g.client.Bucket(bucket).Object(key).Delete(ctx)
}

func (g *GCSStorage) List(ctx context.Context, bucket, prefix string) ([]string, error) {
    var keys []string
    it := g.client.Bucket(bucket).Objects(ctx, &storage.Query{Prefix: prefix})
    for {
        attrs, err := it.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            return nil, err
        }
        keys = append(keys, attrs.Name)
    }
    return keys, nil
}

func (g *GCSStorage) GeneratePresignedURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
    return g.client.Bucket(bucket).SignedURL(key, &storage.SignedURLOptions{
        Method:  "GET",
        Expires: time.Now().Add(expiry),
    })
}

// Factory function based on provider
func NewCloudStorage(ctx context.Context, provider, region string) (CloudStorage, error) {
    switch provider {
    case "aws", "s3":
        return NewS3Storage(ctx, region)
    case "gcp", "gcs":
        return NewGCSStorage(ctx)
    default:
        return nil, fmt.Errorf("unsupported provider: %s", provider)
    }
}
```

---

### Exercise 2: Implement a Pub/Sub Message Router

**Problem**: Build a message router that routes events to different handlers based on message type.

```go
// Solution: Cloud Pub/Sub message router
package messaging

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"

    "cloud.google.com/go/pubsub"
)

type Message struct {
    Type      string          `json:"type"`
    ID        string          `json:"id"`
    Timestamp string          `json:"timestamp"`
    Data      json.RawMessage `json:"data"`
}

type Handler func(ctx context.Context, data json.RawMessage) error

type MessageRouter struct {
    client       *pubsub.Client
    handlers     map[string]Handler
    defaultHandler Handler
    mu           sync.RWMutex
    errorHandler func(error)
}

func NewMessageRouter(projectID string) (*MessageRouter, error) {
    ctx := context.Background()
    client, err := pubsub.NewClient(ctx, projectID)
    if err != nil {
        return nil, err
    }

    return &MessageRouter{
        client:   client,
        handlers: make(map[string]Handler),
        defaultHandler: func(ctx context.Context, data json.RawMessage) error {
            return fmt.Errorf("no handler for message type")
        },
        errorHandler: func(err error) {
            fmt.Printf("Error processing message: %v\n", err)
        },
    }, nil
}

// Register a handler for a specific message type
func (r *MessageRouter) Register(messageType string, handler Handler) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.handlers[messageType] = handler
}

// SetDefaultHandler sets the handler for unregistered message types
func (r *MessageRouter) SetDefaultHandler(handler Handler) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.defaultHandler = handler
}

// SetErrorHandler sets the error handling function
func (r *MessageRouter) SetErrorHandler(handler func(error)) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.errorHandler = handler
}

// Subscribe starts listening to a subscription and routing messages
func (r *MessageRouter) Subscribe(ctx context.Context, subscriptionID string, concurrency int) error {
    sub := r.client.Subscription(subscriptionID)
    sub.ReceiveSettings.MaxOutstandingMessages = concurrency
    sub.ReceiveSettings.NumGoroutines = concurrency

    return sub.Receive(ctx, func(ctx context.Context, msg *pubsub.Message) {
        var m Message
        if err := json.Unmarshal(msg.Data, &m); err != nil {
            r.errorHandler(fmt.Errorf("unmarshal message: %w", err))
            msg.Nack()
            return
        }

        // Get handler for this message type
        r.mu.RLock()
        handler, ok := r.handlers[m.Type]
        if !ok {
            handler = r.defaultHandler
        }
        r.mu.RUnlock()

        // Process message
        if err := handler(ctx, m.Data); err != nil {
            r.errorHandler(fmt.Errorf("handle message %s: %w", m.ID, err))
            msg.Nack()
            return
        }

        msg.Ack()
    })
}

// Publish sends a message to a topic
func (r *MessageRouter) Publish(ctx context.Context, topicID string, msg Message) (string, error) {
    topic := r.client.Topic(topicID)

    data, err := json.Marshal(msg)
    if err != nil {
        return "", fmt.Errorf("marshal message: %w", err)
    }

    result := topic.Publish(ctx, &pubsub.Message{
        Data: data,
        Attributes: map[string]string{
            "type": msg.Type,
            "id":   msg.ID,
        },
    })

    return result.Get(ctx)
}

// Example usage
func ExampleMessageRouter() {
    router, _ := NewMessageRouter("my-project")

    // Register handlers
    router.Register("user.created", func(ctx context.Context, data json.RawMessage) error {
        var user struct {
            ID    string `json:"id"`
            Email string `json:"email"`
        }
        if err := json.Unmarshal(data, &user); err != nil {
            return err
        }
        fmt.Printf("New user created: %s (%s)\n", user.ID, user.Email)
        return nil
    })

    router.Register("order.placed", func(ctx context.Context, data json.RawMessage) error {
        var order struct {
            ID          string `json:"id"`
            AmountCents int64  `json:"amount_cents"`
        }
        if err := json.Unmarshal(data, &order); err != nil {
            return err
        }
        fmt.Printf("New order: %s ($%.2f)\n", order.ID, float64(order.AmountCents)/100)
        return nil
    })

    // Start processing
    ctx := context.Background()
    router.Subscribe(ctx, "my-subscription", 10)
}
```

---

### Junior → FAANG: Cloud Exercises as Cloud Literacy Building

These exercises translate cloud service knowledge from conceptual to operational. The cloud-agnostic storage interface exercise is particularly valuable because it forces you to identify the semantic contract of an object storage service (independent of S3 or GCS-specific APIs) and implement it in Go's type system. The discipline of defining an interface before implementing it is a Go best practice that applies beyond cloud code.

Run these exercises with a real cloud account (use the free tier). The difference between code that compiles and code that actually works against the AWS or GCP API is significant. Real API interactions surface IAM permission errors, network issues, and eventual consistency behaviors that no amount of reading can prepare you for.

### Senior @ FAANG: Cloud Exercises as Architecture Validation

At staff level, the cloud-agnostic storage interface exercise reveals whether your application's architecture allows for storage backend substitution. If the answer requires rewriting significant parts of the application, the cloud dependency is too deep and creates strategic risk. If the answer requires only swapping the implementation behind a well-defined interface, the architecture is cloud-portable.

Running this analysis across your organization's services is a useful architectural audit. Services that are deeply coupled to provider-specific APIs are candidates for abstraction refactoring when the strategic cost of the coupling is identified. Services that are already behind clean abstractions provide the organizational flexibility for provider negotiation, regional migration, and disaster recovery. The staff engineer's role is to identify which services are in which category and make the case for abstraction investment where the coupling creates meaningful risk.
