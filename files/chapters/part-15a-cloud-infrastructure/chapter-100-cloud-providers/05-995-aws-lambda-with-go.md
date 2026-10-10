## 100.5 AWS Lambda with Go

### Lambda Handler

The `aws-lambda-go` runtime wraps Go's `main` function so that `lambda.Start` marshals each incoming JSON event into the handler's typed parameter and marshals the return value back to JSON before Lambda returns the response. The event type you choose, `events.APIGatewayProxyRequest`, `events.SQSEvent`, `events.S3Event`, etc., is the only thing that changes between trigger sources. The runtime handles all serialization. For SQS and DynamoDB Streams, returning a non-nil error causes Lambda to report the batch as failed, which re-drives the messages according to the source's retry and dead-letter queue policy.

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/aws/aws-lambda-go/events"
    "github.com/aws/aws-lambda-go/lambda"
)

// API Gateway handler
func handleAPIGateway(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
    // Parse request body
    var input struct {
        Name string `json:"name"`
    }
    if err := json.Unmarshal([]byte(request.Body), &input); err != nil {
        return events.APIGatewayProxyResponse{
            StatusCode: 400,
            Body:       `{"error": "invalid request body"}`,
        }, nil
    }

    // Process request
    response := map[string]string{
        "message": fmt.Sprintf("Hello, %s!", input.Name),
    }

    body, _ := json.Marshal(response)

    return events.APIGatewayProxyResponse{
        StatusCode: 200,
        Headers: map[string]string{
            "Content-Type": "application/json",
        },
        Body: string(body),
    }, nil
}

// SQS trigger handler
func handleSQS(ctx context.Context, event events.SQSEvent) error {
    for _, record := range event.Records {
        fmt.Printf("Processing message: %s\n", record.Body)
        // Process message
    }
    return nil
}

// S3 trigger handler
func handleS3(ctx context.Context, event events.S3Event) error {
    for _, record := range event.Records {
        bucket := record.S3.Bucket.Name
        key := record.S3.Object.Key
        fmt.Printf("New object: s3://%s/%s\n", bucket, key)
        // Process object
    }
    return nil
}

// DynamoDB Streams handler
func handleDynamoDB(ctx context.Context, event events.DynamoDBEvent) error {
    for _, record := range event.Records {
        switch record.EventName {
        case "INSERT":
            fmt.Printf("New item: %v\n", record.Change.NewImage)
        case "MODIFY":
            fmt.Printf("Updated item: %v\n", record.Change.NewImage)
        case "REMOVE":
            fmt.Printf("Deleted item: %v\n", record.Change.OldImage)
        }
    }
    return nil
}

// Scheduled event handler (CloudWatch Events)
func handleScheduled(ctx context.Context, event events.CloudWatchEvent) error {
    fmt.Printf("Scheduled event at: %s\n", event.Time)
    // Run scheduled task
    return nil
}

func main() {
    // Choose handler based on your trigger
    lambda.Start(handleAPIGateway)
}
```

### Lambda with Dependencies

Lambda reuses the same execution environment for multiple sequential invocations after a cold start, so initializing heavyweight clients, database connections, SDK clients, loaded configuration, in `init()` amortizes that cost across hundreds of requests rather than paying it on every call. Placing the DynamoDB client and table name in package-level variables means the handler function itself stays free of setup logic and is cheaper to unit-test in isolation. Environment variables like `TABLE_NAME` decouple the deployed binary from any specific resource name, making it straightforward to point the same function at a staging or production table by changing only the Lambda configuration.

```go
package main

import (
    "context"
    "log"
    "os"

    "github.com/aws/aws-lambda-go/lambda"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

var (
    dbClient  *dynamodb.Client
    tableName string
)

func init() {
    // Initialize during cold start
    cfg, err := config.LoadDefaultConfig(context.Background())
    if err != nil {
        log.Fatalf("failed to load config: %v", err)
    }

    dbClient = dynamodb.NewFromConfig(cfg)
    tableName = os.Getenv("TABLE_NAME")
}

type Request struct {
    UserID string `json:"user_id"`
}

type Response struct {
    Message string `json:"message"`
}

func handler(ctx context.Context, req Request) (Response, error) {
    // Use initialized clients
    // This reuses connections across invocations

    return Response{Message: "Success"}, nil
}

func main() {
    lambda.Start(handler)
}
```

---

### Junior → FAANG: AWS Lambda with Go and the Cold Start Reality

Lambda with Go produces fast cold starts relative to JVM and Python-based runtimes, making it one of the better language choices for Lambda functions that need low-latency cold start. The key factors that affect cold start: binary size (smaller is faster to load), initialization work done outside the handler (runs on every cold start, not every invocation), and memory configuration (more memory means more CPU allocated, which speeds up initialization and execution).

The Lambda execution model has specific implications for Go: each invocation is handled by one goroutine, but Lambda may reuse the same process for multiple sequential invocations. Resources initialized outside the handler (AWS SDK clients, database connection pools) persist across invocations in a warm Lambda environment. This is a useful optimization (avoid re-initializing expensive resources), but it requires careful management of stateful resources that should not persist (buffered data that should be flushed after each invocation, request-scoped context values).

First-job habit: always set a timeout on Lambda functions. The default 3-second timeout is too short for functions that make network calls. The maximum is 15 minutes. Choose a timeout that allows for the expected execution time plus reasonable retry budget.

### Senior @ FAANG: Lambda Architecture and Cost Optimization at Scale

At staff level, Lambda is an architectural choice with specific cost and operational trade-offs. The cost model is per-invocation plus per-GB-second of compute. At low invocation rates (bursty traffic, batch jobs), Lambda is significantly cheaper than always-on containers. At high invocation rates (sustained high throughput), Lambda costs more than a well-sized container running on ECS or Kubernetes. The breakeven point depends on the memory configuration, invocation duration, and the equivalent EC2/container cost.

The provisioned concurrency feature eliminates cold starts by pre-initializing Lambda instances. It costs roughly the same as running equivalent EC2 instances 24/7, which defeats the cost advantage of Lambda for sustained workloads. The right use case for provisioned concurrency is predictable traffic patterns where cold start latency is not acceptable during normal operation (not just during scale-out): scheduled pre-warming for known traffic spikes (Monday morning for a B2B application) and Application Auto Scaling based on CloudWatch metrics for variable but predictable traffic.

The Lambda architecture decisions that require staff-level judgment: function granularity (one function per route versus one function per service, with the trade-offs of deployment isolation, cold start frequency, and IAM scoping), event source mapping configuration (batch size, parallelization factor, and error handling for SQS-triggered Lambdas), and the boundary between Lambda and container-based compute (which workloads belong in Lambda versus ECS/EKS). Documenting these decisions in ADRs with the specific cost and operational rationale is the staff engineer's contribution.
