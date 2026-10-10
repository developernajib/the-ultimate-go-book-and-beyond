## 102Q.1 Serverless with AWS Lambda

### Lambda Handler Architecture

AWS Lambda executes Go code as a stateless function invoked per request, so the entry point must accept a typed event struct and return a typed response rather than managing an HTTP server lifecycle. Structuring the handler as a method on a dependency-injected struct keeps the business logic testable and makes it straightforward to swap real AWS services for mocks in unit tests. The implementation below routes API Gateway proxy requests by HTTP method and path, checks an ElastiCache layer before hitting DynamoDB, and serializes every response as JSON.

```go
// cmd/lambda/main.go
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// Handler is the dependency-injected Lambda handler
type Handler struct {
	logger *slog.Logger
	db     Database
	cache  Cache
}

// NewHandler creates a handler with all dependencies
func NewHandler() *Handler {
	return &Handler{
		logger: slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
			Level: slog.LevelInfo,
		})),
		db:    NewDynamoDB(),
		cache: NewElastiCache(),
	}
}

// HandleRequest is the main Lambda entry point
func (h *Handler) HandleRequest(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	h.logger.InfoContext(ctx, "request received",
		slog.String("method", event.HTTPMethod),
		slog.String("path", event.Path),
		slog.String("requestId", event.RequestContext.RequestID),
	)

	// Route based on method + path
	switch {
	case event.HTTPMethod == http.MethodGet && event.Path == "/users":
		return h.listUsers(ctx, event)
	case event.HTTPMethod == http.MethodGet && matchPath(event.Path, "/users/{id}"):
		return h.getUser(ctx, event)
	case event.HTTPMethod == http.MethodPost && event.Path == "/users":
		return h.createUser(ctx, event)
	default:
		return jsonResponse(http.StatusNotFound, map[string]string{
			"error": "not found",
		})
	}
}

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

func (h *Handler) getUser(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	userID := event.PathParameters["id"]
	if userID == "" {
		return jsonResponse(http.StatusBadRequest, map[string]string{"error": "missing user ID"})
	}

	// Check cache first
	var user User
	if err := h.cache.Get(ctx, "user:"+userID, &user); err == nil {
		return jsonResponse(http.StatusOK, user)
	}

	// Fetch from DB
	if err := h.db.GetItem(ctx, userID, &user); err != nil {
		if isNotFound(err) {
			return jsonResponse(http.StatusNotFound, map[string]string{"error": "user not found"})
		}
		h.logger.ErrorContext(ctx, "db error", slog.String("error", err.Error()))
		return jsonResponse(http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}

	// Cache for 5 minutes
	_ = h.cache.Set(ctx, "user:"+userID, user, 5*60)

	return jsonResponse(http.StatusOK, user)
}

func (h *Handler) createUser(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	var req struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := json.Unmarshal([]byte(event.Body), &req); err != nil {
		return jsonResponse(http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
	}
	if req.Name == "" || req.Email == "" {
		return jsonResponse(http.StatusBadRequest, map[string]string{"error": "name and email required"})
	}

	user := User{
		ID:    generateID(),
		Name:  req.Name,
		Email: req.Email,
	}

	if err := h.db.PutItem(ctx, user); err != nil {
		h.logger.ErrorContext(ctx, "db put error", slog.String("error", err.Error()))
		return jsonResponse(http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}

	return jsonResponse(http.StatusCreated, user)
}

func (h *Handler) listUsers(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	var users []User
	if err := h.db.Scan(ctx, &users); err != nil {
		return jsonResponse(http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
	return jsonResponse(http.StatusOK, map[string]any{"users": users})
}

func jsonResponse(statusCode int, body any) (events.APIGatewayProxyResponse, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return events.APIGatewayProxyResponse{StatusCode: 500}, err
	}
	return events.APIGatewayProxyResponse{
		StatusCode: statusCode,
		Headers: map[string]string{
			"Content-Type": "application/json",
		},
		Body: string(b),
	}, nil
}

func matchPath(path, pattern string) bool {
	// Simplified path matching - use gorilla/mux or chi for production
	parts := splitPath(path)
	patternParts := splitPath(pattern)
	if len(parts) != len(patternParts) {
		return false
	}
	for i, p := range patternParts {
		if len(p) > 0 && p[0] == '{' {
			continue // wildcard
		}
		if p != parts[i] {
			return false
		}
	}
	return true
}

func splitPath(path string) []string {
	var parts []string
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

func main() {
	h := NewHandler()
	lambda.Start(h.HandleRequest)
}
```

### Lambda with SQS Trigger

SQS-triggered Lambdas receive a batch of messages in a single invocation, so processing failures must be handled at the individual record level rather than by failing the entire function. The `events.SQSEventResponse` type lets you report which specific message IDs failed, causing SQS to return only those messages to the queue for retry while successfully processed messages are deleted. This partial-batch failure pattern prevents a single bad message from blocking good ones and is essential for reliable event-driven pipelines.

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

type OrderProcessor struct {
	emailService EmailService
	inventory    InventoryService
}

// ProcessSQSMessages handles a batch of SQS messages
func (p *OrderProcessor) ProcessSQSMessages(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
	var response events.SQSEventResponse

	for _, record := range event.Records {
		err := p.processRecord(ctx, record)
		if err != nil {
			// Mark failed items for retry - don't fail the whole batch
			response.BatchItemFailures = append(response.BatchItemFailures, events.SQSBatchItemFailure{
				ItemIdentifier: record.MessageId,
			})
			fmt.Printf("failed to process message %s: %v\n", record.MessageId, err)
		}
	}

	return response, nil
}

type Order struct {
	ID         string `json:"id"`
	CustomerID string `json:"customer_id"`
	Items      []Item `json:"items"`
	TotalCents int64  `json:"total_cents"`
}

type Item struct {
	ProductID  string `json:"product_id"`
	Quantity   int    `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

func (p *OrderProcessor) processRecord(ctx context.Context, record events.SQSMessage) error {
	var order Order
	if err := json.Unmarshal([]byte(record.Body), &order); err != nil {
		return fmt.Errorf("unmarshal order: %w", err)
	}

	// Reserve inventory
	if err := p.inventory.Reserve(ctx, order.Items); err != nil {
		return fmt.Errorf("reserve inventory: %w", err)
	}

	// Send confirmation email
	if err := p.emailService.SendOrderConfirmation(ctx, order); err != nil {
		// Non-critical: log but don't fail
		fmt.Printf("warning: failed to send email for order %s: %v\n", order.ID, err)
	}

	return nil
}

func main() {
	proc := &OrderProcessor{
		emailService: NewSESEmailService(),
		inventory:    NewDynamoDBInventory(),
	}
	lambda.Start(proc.ProcessSQSMessages)
}
```

### Lambda Cold Start Optimization

A Lambda cold start happens when the platform must bootstrap a fresh execution environment, which adds latency before the first invocation is handled. Go's fast startup time already helps, but deferred connection initialization with `sync.Once` avoids performing expensive operations, opening a database connection, loading secrets, during the cold-start path when they may not yet be needed. Combined with a small binary built with `-ldflags="-s -w"` and provisioned concurrency for latency-sensitive functions, these techniques keep cold-start overhead well under 100 milliseconds.

```go
// Cold start occurs when Lambda creates a new execution environment.
// Optimizations:
// 1. Keep init() minimal - don't open connections in init()
// 2. Use lazy initialization
// 3. Keep binary small (strip debug info)
// 4. Pre-warm with provisioned concurrency

package main

import (
	"context"
	"database/sql"
	"os"
	"sync"
)

// LazyDB is a database connection that's opened on first use
type LazyDB struct {
	once sync.Once
	db   *sql.DB
	err  error
}

func (l *LazyDB) Get() (*sql.DB, error) {
	l.once.Do(func() {
		l.db, l.err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
		if l.err == nil {
			l.db.SetMaxOpenConns(5) // Lambda: keep connections low
			l.db.SetMaxIdleConns(2)
		}
	})
	return l.db, l.err
}

var globalDB = &LazyDB{}

// Warm-up: Lambda sends a warm-up event before routing real traffic
func handleWarmup(ctx context.Context) bool {
	// Check if this is a warming event
	// Various warming tools send different signals
	type warmupEvent struct {
		WarmupSource string `json:"warmer"`
	}
	return false // simplified; detect your warm-up format
}

// Dockerfile for Lambda container (alternative to zip)
// FROM public.ecr.aws/lambda/provided:al2
// COPY bootstrap ${LAMBDA_RUNTIME_DIR}/bootstrap
// COPY function.handler ${LAMBDA_TASK_ROOT}/
// CMD ["function.handler"]
```

### Lambda Deployment with SAM/CDK

AWS SAM (Serverless Application Model) lets you describe Lambda functions, API routes, and DynamoDB tables in a single CloudFormation-based YAML file, which SAM compiles into the full infrastructure stack during deployment. The template below targets the `arm64` Graviton architecture, which offers better price-performance for Go binaries than `x86_64` and pairs with the `provided.al2023` runtime that runs the compiled `bootstrap` binary directly. The accompanying Makefile cross-compiles the binary for Linux ARM64, strips debug symbols to minimize the deployment artifact, and invokes `sam deploy` in a single command.

```yaml
# template.yaml (AWS SAM)
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Runtime: provided.al2023
    Architectures: [arm64]  # Graviton: cheaper + faster for Go
    MemorySize: 256
    Timeout: 30
    Environment:
      Variables:
        GOMAXPROCS: "1"  # Lambda has limited vCPUs

Resources:
  UserAPI:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./
      Handler: bootstrap
      Events:
        API:
          Type: HttpApi
          Properties:
            Path: /{proxy+}
            Method: ANY
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref UserTable

  UserTable:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH
```

```makefile
# Makefile for Lambda deployment
.PHONY: build deploy

build:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
	go build -ldflags="-s -w" -o bootstrap ./cmd/lambda
	zip function.zip bootstrap

deploy: build
	sam deploy --stack-name my-api --resolve-s3 --capabilities CAPABILITY_IAM
```

---

### Junior → FAANG: Lambda Handler Architecture as the Foundation for All Serverless Work

The handler architecture pattern in this section, separating initialization from handler execution, is the single most important Lambda pattern to internalize. Code outside the handler function runs once per container lifecycle, not once per invocation. The AWS SDK client, database connection pool, and config parsing belong outside the handler. Putting them inside the handler is the most common Lambda performance mistake, and it is measurable: a function that initializes an AWS SDK client per invocation pays 50-200ms of extra latency on every cold AND warm invocation, not just cold starts.

The context propagation pattern is the second critical habit. Lambda passes a context with a deadline corresponding to the function's configured timeout. Every downstream call (DynamoDB, S3, HTTP) should receive that context so it respects the timeout. Functions that ignore context deadlines produce the worst failure mode: the Lambda times out, the downstream call completes successfully, and the message is retried, producing a duplicate operation. This is the root cause of many Lambda-based data consistency bugs.

First-job habit: write a local test harness that invokes your handler directly with a mock event, bypassing the Lambda runtime. This enables fast iteration and makes your handler unit-testable. The handler should accept the typed event struct (APIGatewayProxyRequest, SQSEvent, etc.) and return the typed response. The logic can be extracted into a service struct that is tested independently of the Lambda wrapper.

### Senior @ FAANG: Lambda Platform Architecture and Organizational Scaling

At staff level, the SAM/CDK deployment pattern is a starting point for a platform-owned deployment framework. The problems that emerge at scale are not in the individual function but in the fleet. One hundred Lambda functions, each owned by a different team, each with different memory settings, different timeout values, different IAM roles, and different observability configurations, is not a manageable system. The platform team's job is to define the standard Lambda configuration and enforce it.

The organizational standard should cover: execution role baseline (CloudWatch Logs write permission, X-Ray trace permission, and nothing else by default), memory tier recommendations (256MB for lightweight HTTP handlers, 1GB for data-processing functions, with documented benchmark criteria for each tier), timeout policy (never set timeout to the Lambda maximum without a documented rationale), and the observability contract (structured JSON logs with correlation ID, Lambda Powertools for tracing, custom metrics via EMF).

Lambda SnapStart for Java workloads demonstrated an organizational pattern worth tracking: AWS will continue investing in cold start reduction at the runtime layer, and those improvements need to be adopted deliberately rather than automatically. Go Lambda functions running on Amazon Linux 2023 have different cold start characteristics than those on Amazon Linux 2. The platform team should own a benchmark that measures cold start latency for the organization's standard function configuration across runtime versions, and that benchmark should run on each new runtime release as a regression check. The result is an evidence-based upgrade policy rather than a policy of "upgrade when something breaks."
