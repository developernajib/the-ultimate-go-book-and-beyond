## 100.10 Company Case Studies: Cloud Provider Usage

### Google: GCP-Native Go Services

Google Cloud is the natural home for Go services, given Go's origins at Google, and GCP's SDK design reflects this affinity with context-first APIs, automatic Application Default Credentials detection, and first-class Cloud Run support. GCP-native Go services benefit from Workload Identity Federation, which eliminates the need for service account key files by binding Kubernetes service accounts directly to GCP IAM roles. The pattern below demonstrates the canonical initialization sequence for a Go service running on Cloud Run with access to Cloud Storage, Pub/Sub, and Cloud Spanner.

```go
// Google Cloud-native Go service pattern
package main

import (
    "context"
    "log"
    "net/http"
    "os"

    "cloud.google.com/go/compute/metadata"
    "cloud.google.com/go/errorreporting"
    "cloud.google.com/go/logging"
    "cloud.google.com/go/profiler"
    "cloud.google.com/go/pubsub"
    "contrib.go.opencensus.io/exporter/stackdriver"
    "go.opencensus.io/trace"
)

func main() {
    ctx := context.Background()
    projectID := mustGetProjectID()

    // Initialize Cloud Profiler (continuous profiling)
    if err := profiler.Start(profiler.Config{
        Service:        "my-service",
        ServiceVersion: os.Getenv("K_REVISION"),
        ProjectID:      projectID,
    }); err != nil {
        log.Printf("Failed to start profiler: %v", err)
    }

    // Initialize Error Reporting
    errorClient, err := errorreporting.NewClient(ctx, projectID, errorreporting.Config{
        ServiceName:    "my-service",
        ServiceVersion: os.Getenv("K_REVISION"),
    })
    if err != nil {
        log.Fatalf("Failed to create error client: %v", err)
    }
    defer errorClient.Close()

    // Initialize Cloud Logging
    loggingClient, err := logging.NewClient(ctx, projectID)
    if err != nil {
        log.Fatalf("Failed to create logging client: %v", err)
    }
    defer loggingClient.Close()
    logger := loggingClient.Logger("my-service")

    // Initialize Cloud Trace
    exporter, err := stackdriver.NewExporter(stackdriver.Options{
        ProjectID: projectID,
    })
    if err != nil {
        log.Fatalf("Failed to create Stackdriver exporter: %v", err)
    }
    trace.RegisterExporter(exporter)
    trace.ApplyConfig(trace.Config{DefaultSampler: trace.ProbabilitySampler(0.1)})

    // Initialize Pub/Sub for event-driven architecture
    pubsubClient, err := pubsub.NewClient(ctx, projectID)
    if err != nil {
        log.Fatalf("Failed to create Pub/Sub client: %v", err)
    }
    defer pubsubClient.Close()

    // Start server
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        _, span := trace.StartSpan(r.Context(), "handleRequest")
        defer span.End()

        logger.Log(logging.Entry{
            Severity: logging.Info,
            Payload:  "Request received",
            Trace:    span.SpanContext().TraceID.String(),
        })

        w.Write([]byte("Hello from GCP!"))
    })

    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }
    log.Printf("Listening on port %s", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}

func mustGetProjectID() string {
    if id := os.Getenv("GOOGLE_CLOUD_PROJECT"); id != "" {
        return id
    }
    if metadata.OnGCE() {
        id, _ := metadata.ProjectID()
        return id
    }
    log.Fatal("GOOGLE_CLOUD_PROJECT not set")
    return ""
}
```

**Google Cloud Patterns for Go**:
- Cloud Run for serverless Go
- Cloud Profiler for production profiling
- Integrated logging, tracing, and error reporting
- Pub/Sub for event-driven architectures

### Uber: Multi-Cloud with AWS Primary

Uber runs primarily on AWS with Go services:

```go
// Uber-style AWS service with circuit breakers
package main

import (
    "context"
    "log"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/sqs"
    "github.com/sony/gobreaker"
)

type AWSServices struct {
    dynamoDB   *dynamodb.Client
    sqs        *sqs.Client
    breakers   map[string]*gobreaker.CircuitBreaker
}

func NewAWSServices(ctx context.Context) (*AWSServices, error) {
    cfg, err := config.LoadDefaultConfig(ctx,
        config.WithRegion("us-west-2"),
        config.WithRetryMaxAttempts(3),
    )
    if err != nil {
        return nil, err
    }

    // Create circuit breakers for each service
    cbSettings := gobreaker.Settings{
        Name:        "aws-service",
        MaxRequests: 5,
        Interval:    10 * time.Second,
        Timeout:     30 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 10 && failureRatio >= 0.5
        },
        OnStateChange: func(name string, from, to gobreaker.State) {
            log.Printf("Circuit breaker %s: %s -> %s", name, from, to)
        },
    }

    return &AWSServices{
        dynamoDB: dynamodb.NewFromConfig(cfg),
        sqs:      sqs.NewFromConfig(cfg),
        breakers: map[string]*gobreaker.CircuitBreaker{
            "dynamodb": gobreaker.NewCircuitBreaker(cbSettings),
            "sqs":      gobreaker.NewCircuitBreaker(cbSettings),
        },
    }, nil
}

// Safe DynamoDB call with circuit breaker
func (s *AWSServices) GetItem(ctx context.Context, input *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
    result, err := s.breakers["dynamodb"].Execute(func() (any, error) {
        return s.dynamoDB.GetItem(ctx, input)
    })
    if err != nil {
        return nil, err
    }
    return result.(*dynamodb.GetItemOutput), nil
}
```

### Netflix: AWS with Custom Abstractions

Netflix builds custom abstractions over AWS for their Go services:

```go
// Netflix-style cloud abstraction layer
package cloud

import (
    "context"
    "io"
    "log"
    "time"

    "github.com/Netflix/spectator-go/spectator"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

type StorageService interface{}
type MessagingService interface{}
type DatabaseService interface{}
type MetricsService interface{}

type SQSMessaging struct{}
type DynamoDatabase struct{}

type HealthChecker interface {
    IsHealthy(region string) bool
}

// CloudProvider abstracts cloud operations
type CloudProvider interface {
    Storage() StorageService
    Messaging() MessagingService
    Database() DatabaseService
    Metrics() MetricsService
}

// AWSProvider implements CloudProvider for AWS
type AWSProvider struct {
    registry spectator.Registry
    storage  *S3Storage
    messaging *SQSMessaging
    database  *DynamoDatabase
}

// S3Storage with Netflix metrics
type S3Storage struct {
    client   *s3.Client
    registry spectator.Registry
    bucket   string
}

func (s *S3Storage) Get(ctx context.Context, key string) ([]byte, error) {
    start := time.Now()

    result, err := s.client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: &s.bucket,
        Key:    &key,
    })

    // Record metrics
    duration := time.Since(start)
    s.registry.Timer("cloud.s3.latency", map[string]string{
        "operation": "get",
        "bucket":    s.bucket,
    }).Record(duration)

    if err != nil {
        s.registry.Counter("cloud.s3.errors", map[string]string{
            "operation": "get",
            "bucket":    s.bucket,
        }).Increment()
        return nil, err
    }

    defer result.Body.Close()
    return io.ReadAll(result.Body)
}

// Region-aware client selection
type RegionRouter struct {
    primaryRegion   string
    failoverRegion  string
    primaryClient   CloudProvider
    failoverClient  CloudProvider
    healthChecker   HealthChecker
}

func (r *RegionRouter) GetProvider(ctx context.Context) CloudProvider {
    if r.healthChecker.IsHealthy(r.primaryRegion) {
        return r.primaryClient
    }
    log.Println("Primary region unhealthy, failing over")
    return r.failoverClient
}
```

### Stripe: Multi-Region AWS with Consistency

Stripe's approach prioritizes consistency across regions:

```go
// Stripe-style multi-region database access
package database

import (
    "context"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type Item struct {
    ID   string
    Data string
}

func keyToAV(key string) map[string]types.AttributeValue {
    return map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: key}}
}

func itemToAV(item *Item) map[string]types.AttributeValue {
    return map[string]types.AttributeValue{
        "id":   &types.AttributeValueMemberS{Value: item.ID},
        "data": &types.AttributeValueMemberS{Value: item.Data},
    }
}

func avToItem(av map[string]types.AttributeValue) *Item {
    item := &Item{}
    if s, ok := av["id"].(*types.AttributeValueMemberS); ok {
        item.ID = s.Value
    }
    if s, ok := av["data"].(*types.AttributeValueMemberS); ok {
        item.Data = s.Value
    }
    return item
}

type MultiRegionClient struct {
    primary     *dynamodb.Client
    replicas    []*dynamodb.Client
    tableName   string
}

// StrongRead always reads from primary for consistency
func (c *MultiRegionClient) StrongRead(ctx context.Context, key string) (*Item, error) {
    result, err := c.primary.GetItem(ctx, &dynamodb.GetItemInput{
        TableName:      &c.tableName,
        Key:            keyToAV(key),
        ConsistentRead: aws.Bool(true),
    })
    if err != nil {
        return nil, err
    }
    return avToItem(result.Item), nil
}

// EventualRead can use any replica
func (c *MultiRegionClient) EventualRead(ctx context.Context, key string) (*Item, error) {
    // Try replicas first for lower latency
    for _, replica := range c.replicas {
        result, err := replica.GetItem(ctx, &dynamodb.GetItemInput{
            TableName: &c.tableName,
            Key:       keyToAV(key),
        })
        if err == nil {
            return avToItem(result.Item), nil
        }
    }

    // Fall back to primary
    return c.StrongRead(ctx, key)
}

// Write always goes to primary with idempotency
func (c *MultiRegionClient) Write(ctx context.Context, item *Item, idempotencyKey string) error {
    _, err := c.primary.PutItem(ctx, &dynamodb.PutItemInput{
        TableName:           &c.tableName,
        Item:                itemToAV(item),
        ConditionExpression: aws.String("attribute_not_exists(idempotency_key) OR idempotency_key = :key"),
        ExpressionAttributeValues: map[string]types.AttributeValue{
            ":key": &types.AttributeValueMemberS{Value: idempotencyKey},
        },
    })
    return err
}
```

### Amazon: Native AWS Integration

A Go service running inside AWS naturally leans on deep SDK integration:

```go
// Amazon-style service with full AWS integration
package main

import (
    "context"
    "io"
    "net/http"
    "os"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/feature/ec2/imds"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/aws/aws-xray-sdk-go/xray"
)

var s3Client *s3.Client

type ServiceConfig struct {
    Region       string
    InstanceID   string
    AccountID    string
    ServiceName  string
}

func LoadServiceConfig(ctx context.Context) (*ServiceConfig, error) {
    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return nil, err
    }

    // Get instance metadata on EC2/ECS
    imdsClient := imds.NewFromConfig(cfg)
    identity, _ := imdsClient.GetInstanceIdentityDocument(ctx, nil)

    return &ServiceConfig{
        Region:      identity.Region,
        InstanceID:  identity.InstanceID,
        AccountID:   identity.AccountID,
        ServiceName: os.Getenv("SERVICE_NAME"),
    }, nil
}

// X-Ray traced handler
func TracedHandler(next http.Handler) http.Handler {
    return xray.Handler(xray.NewFixedSegmentNamer("api-gateway"), next)
}

// X-Ray traced AWS calls
func GetFromS3(ctx context.Context, bucket, key string) ([]byte, error) {
    ctx, seg := xray.BeginSubsegment(ctx, "S3.GetObject")
    defer seg.Close(nil)

    result, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: &bucket,
        Key:    &key,
    })
    if err != nil {
        seg.AddError(err)
        return nil, err
    }
    defer result.Body.Close()

    return io.ReadAll(result.Body)
}
```

**Cloud Provider Comparison**:

| Company | Primary Cloud | Key Pattern |
|---------|--------------|-------------|
| Google | GCP | Native integration, Cloud Run |
| Uber | AWS | Circuit breakers, multi-region |
| Netflix | AWS | Custom abstractions, chaos-ready |
| Stripe | AWS | Strong consistency, idempotency |
| Amazon | AWS | X-Ray tracing, IMDS integration |

---

### Junior → FAANG: Reading Cloud Case Studies With a "What Can I Use Now?" Lens

Case studies from companies running Go on AWS/GCP at scale demonstrate what is possible, but the applicable lesson for early-career engineers is narrower: what practices can you adopt immediately that reduce risk and improve operational quality, regardless of scale?

The immediately applicable lessons from these case studies: using IAM roles instead of hardcoded credentials (day-one practice), enabling CloudTrail and Cloud Audit Logs (day-one practice, requires a single checkbox), structuring S3/GCS object names for performance (design-time decision, easy to do correctly from the start), and handling SDK errors with proper retry logic (implementation-time discipline). These are not scale-dependent. They are correct practices at any scale.

### Senior @ FAANG: Cloud Strategy as a Board-Level Concern

At staff level, cloud provider strategy intersects with organizational risk management, contract negotiation, and architectural flexibility. The enterprise discount agreements, committed use discounts, and reserved instance pricing that reduce cloud costs by 30-60% are negotiated at the executive level but shaped by the technical architecture. A service that is tightly coupled to AWS-specific managed services is harder to negotiate pricing for because the switching cost is high. A service that uses provider-agnostic interfaces with provider-specific adapters retains negotiating leverage.

The technical decisions that preserve architectural flexibility: using a data portability layer above the specific storage API (a Go interface for object storage implemented by S3 and GCS adapters), avoiding proprietary database features that have no portable equivalent, and using Kubernetes instead of provider-specific container services where the workload complexity justifies it. The staff engineer's role is to identify which cloud dependencies are strategically acceptable (because the managed service value is clearly worth the coupling) and which should be abstracted (because the coupling creates organizational risk without sufficient benefit).
