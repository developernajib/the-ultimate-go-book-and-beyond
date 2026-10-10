## 47.7 Company Case Studies

### Netflix: Microservices at Scale

Netflix operates one of the largest microservices architectures, serving 200+ million subscribers with thousands of services.

**Netflix's Key Patterns:**

Netflix popularized the circuit breaker pattern through its open-source Hystrix library, which wraps every inter-service call with timeout enforcement, concurrency limits (bulkhead isolation), and automatic fallback when error rates exceed a threshold. The Go implementation below reproduces this behavior using `sync/atomic` for lock-free state transitions between closed, open, and half-open states. Netflix also developed Eureka for service discovery, using client-side caching with a self-preservation mode that prevents mass eviction during network partitions: when heartbeat renewals drop below 85% of the expected rate (that is, when more than 15% of instances miss heartbeats at once), Eureka assumes a partition rather than mass failure and stops evicting.

```go
// Netflix-style service client with Hystrix-like circuit breaker
package netflix

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "time"
)

// HystrixCommand wraps service calls with resilience patterns
type HystrixCommand struct {
    Name            string
    Timeout         time.Duration
    MaxConcurrent   int32
    ErrorThreshold  float64
    SleepWindow     time.Duration

    state           int32 // 0=closed, 1=open, 2=half-open
    failures        int64
    successes       int64
    lastFailureTime int64
    concurrent      int32

    mu sync.RWMutex
}

const (
    StateClosed = iota
    StateOpen
    StateHalfOpen
)

func (c *HystrixCommand) Execute(ctx context.Context, run func() (any, error), fallback func(error) (any, error)) (any, error) {
    // Check circuit state
    if atomic.LoadInt32(&c.state) == StateOpen {
        if time.Now().UnixNano()-atomic.LoadInt64(&c.lastFailureTime) < c.SleepWindow.Nanoseconds() {
            // Circuit is open, use fallback
            return fallback(errors.New("circuit open"))
        }
        // Try half-open
        atomic.StoreInt32(&c.state, StateHalfOpen)
    }

    // Check concurrency limit (bulkhead)
    current := atomic.AddInt32(&c.concurrent, 1)
    defer atomic.AddInt32(&c.concurrent, -1)

    if current > c.MaxConcurrent {
        return fallback(errors.New("max concurrency reached"))
    }

    // Execute with timeout
    ctx, cancel := context.WithTimeout(ctx, c.Timeout)
    defer cancel()

    resultCh := make(chan struct {
        result any
        err    error
    }, 1)

    go func() {
        result, err := run()
        resultCh <- struct {
            result any
            err    error
        }{result, err}
    }()

    select {
    case <-ctx.Done():
        c.recordFailure()
        return fallback(ctx.Err())
    case r := <-resultCh:
        if r.err != nil {
            c.recordFailure()
            return fallback(r.err)
        }
        c.recordSuccess()
        return r.result, nil
    }
}

func (c *HystrixCommand) recordFailure() {
    atomic.AddInt64(&c.failures, 1)
    atomic.StoreInt64(&c.lastFailureTime, time.Now().UnixNano())

    total := atomic.LoadInt64(&c.failures) + atomic.LoadInt64(&c.successes)
    if total > 10 {
        errorRate := float64(atomic.LoadInt64(&c.failures)) / float64(total)
        if errorRate > c.ErrorThreshold {
            atomic.StoreInt32(&c.state, StateOpen)
        }
    }
}

func (c *HystrixCommand) recordSuccess() {
    atomic.AddInt64(&c.successes, 1)
    if atomic.LoadInt32(&c.state) == StateHalfOpen {
        // Successful request in half-open, close circuit
        atomic.StoreInt32(&c.state, StateClosed)
        atomic.StoreInt64(&c.failures, 0)
        atomic.StoreInt64(&c.successes, 0)
    }
}

// Netflix uses Eureka for service discovery
// This client implements a caching registry with self-preservation
type EurekaClient struct {
    eurekaURL       string
    appName         string
    instanceID      string
    localCache      sync.Map
    renewalInterval time.Duration
    selfPreservation bool
}

func (c *EurekaClient) Register(ctx context.Context, instance Instance) error {
    // Register with Eureka server
    // Netflix uses heartbeats every 30 seconds
    go c.heartbeat(ctx, instance)
    return nil
}

func (c *EurekaClient) heartbeat(ctx context.Context, instance Instance) {
    ticker := time.NewTicker(c.renewalInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := c.sendHeartbeat(instance); err != nil {
                // Netflix's self-preservation mode: the server stops evicting
                // when renewals drop below 85% of the expected rate (likely a
                // network partition, not mass instance failure)
            }
        }
    }
}

// Netflix uses regional failover
func (c *EurekaClient) GetInstances(serviceName string) []Instance {
    // Check local region first
    if instances, ok := c.localCache.Load(serviceName); ok {
        return instances.([]Instance)
    }

    // Fallback to remote regions
    return c.getFromRemoteRegion(serviceName)
}
```

### Uber: Domain-Oriented Microservice Architecture (DOMA)

Uber evolved from thousands of microservices to domain-oriented architecture for better maintainability.

**Uber's DOMA Pattern:**

After scaling to thousands of microservices, Uber found that fine-grained services created a tangled dependency graph that was difficult to reason about and operate. DOMA groups related services into domains (Rides, Eats, Freight), each fronted by a single gateway that is the only entry point for cross-domain communication. Within a domain, services are organized into four layers: the gateway, product services (use cases like UberX or Express Pool), core services (business logic like rider-driver matching), and shared infrastructure. Uber also uses Ringpop, a consistent-hashing library, to route stateful requests to the correct node without a centralized coordinator.

```go
// Uber's domain-oriented microservice architecture
package uber

import (
    "context"
    "fmt"
)

// Domain represents a business domain (e.g., Rides, Eats, Freight)
type Domain struct {
    Name       string
    Gateway    DomainGateway
    Services   map[string]Service
    DataLayer  DomainDataLayer
}

// DomainGateway is the single entry point for a domain
// External services communicate only through the gateway
type DomainGateway interface {
    // Public APIs exposed to other domains
    GetPublicAPIs() []API

    // Route requests to appropriate internal services
    Route(ctx context.Context, req Request) (Response, error)
}

// Uber uses a 4-layer architecture within each domain
type RidesDomain struct {
    // Layer 1: Gateway (entry point)
    gateway *RidesGateway

    // Layer 2: Product layer (use cases)
    products map[string]ProductService

    // Layer 3: Core services (business logic)
    coreServices map[string]CoreService

    // Layer 4: Infrastructure (shared utilities)
    infrastructure *Infrastructure
}

// ProductService implements a specific use case
type ProductService interface {
    // Express Pool, UberX, etc.
    Name() string
    Execute(ctx context.Context, req any) (any, error)
}

// Uber's request matching service
type MatchingService struct {
    // Matches riders with drivers using ML models
    predictor    RideDemandPredictor
    optimizer    RouteOptimizer
    dispatcher   DriverDispatcher
}

func (s *MatchingService) MatchRider(ctx context.Context, req *MatchRequest) (*Match, error) {
    // 1. Predict demand in the area
    demand, err := s.predictor.Predict(ctx, req.Location, req.Time)
    if err != nil {
        return nil, fmt.Errorf("predict demand: %w", err)
    }

    // 2. Find optimal drivers
    candidates, err := s.dispatcher.FindCandidates(ctx, req.Location, demand)
    if err != nil {
        return nil, fmt.Errorf("find candidates: %w", err)
    }

    // 3. Optimize route and ETA
    for _, driver := range candidates {
        route, err := s.optimizer.Optimize(ctx, driver.Location, req.Pickup, req.Dropoff)
        if err != nil {
            continue
        }

        return &Match{
            DriverID: driver.ID,
            Route:    route,
            ETA:      route.EstimatedDuration,
        }, nil
    }

    return nil, ErrNoDriversAvailable
}

// Uber uses Ringpop for consistent hashing and service discovery
type RingpopCluster struct {
    ring         *HashRing
    localAddress string
    members      []string
}

func (c *RingpopCluster) Lookup(key string) string {
    // Consistent hashing for stateful services
    // Same key always routes to same node
    return c.ring.Get(key)
}

func (c *RingpopCluster) Forward(ctx context.Context, key string, req Request) (Response, error) {
    target := c.Lookup(key)
    if target == c.localAddress {
        // Handle locally
        return c.handleLocal(ctx, req)
    }
    // Forward to owner node
    return c.forwardTo(ctx, target, req)
}
```

### Amazon: Two-Pizza Teams and Service-Oriented Architecture

Amazon pioneered microservices with their "two-pizza team" rule and strict service ownership.

**Amazon's Patterns:**

Amazon's architecture enforces two rules rigorously: every team exposes functionality only through service APIs (no shared databases, no back-door access), and each service team owns the full lifecycle including on-call. This "you build it, you run it" model drives operational discipline. Amazon also pioneered cell-based architecture, where services are deployed in isolated cells to limit blast radius, a failure in one cell cannot propagate to others. The code below shows a service structured around these principles, including correlation ID propagation for distributed tracing (using the `X-Amzn-Trace-Id` header format) and DynamoDB's single-table design pattern for efficient data access.

```go
// Amazon-style service with strict ownership
package amazon

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Every service owns its data and exposes it via APIs only
// No shared databases (enforced by architecture review)
type ProductCatalogService struct {
    // Private database - no external access
    db ProductDatabase

    // Public API - the only way to access product data
    api *ProductAPI

    // Metrics and monitoring (owned by team)
    metrics *ServiceMetrics

    // On-call rotation (team responsibility)
    oncall *OncallSchedule
}

// Amazon's "You Build It, You Run It" principle
func (s *ProductCatalogService) Start(ctx context.Context) error {
    // Health check - required for load balancer
    http.HandleFunc("/health", s.healthCheck)

    // Operational endpoints
    http.HandleFunc("/internal/metrics", s.metrics.Handler)
    http.HandleFunc("/internal/canary", s.canaryHandler)

    // Business APIs
    http.HandleFunc("/v1/products", s.api.HandleProducts)
    http.HandleFunc("/v1/products/{id}", s.api.HandleProduct)

    // Start server with graceful shutdown
    return s.listenAndServe(ctx)
}

// Amazon's Cell-Based Architecture
// Services are deployed in isolated cells to limit blast radius
type Cell struct {
    ID       string
    Region   string
    Services map[string]*ServiceDeployment
    Router   *CellRouter
}

// Cell router ensures requests stay within the cell when possible
func (c *Cell) Route(ctx context.Context, req Request) (Response, error) {
    // Check if request can be handled within this cell
    if service, ok := c.Services[req.ServiceName]; ok {
        return service.Handle(ctx, req)
    }

    // Cross-cell communication through dedicated gateways
    return c.Router.RouteToCell(ctx, req)
}

// Amazon's correlation ID pattern for distributed tracing
type CorrelationContext struct {
    TraceID      string
    SpanID       string
    ParentSpanID string
    Depth        int
    StartTime    time.Time
}

func PropagateContext(ctx context.Context, req *http.Request) *http.Request {
    cc := GetCorrelationContext(ctx)
    if cc == nil {
        cc = &CorrelationContext{
            TraceID:   generateTraceID(),
            SpanID:    generateSpanID(),
            Depth:     0,
            StartTime: time.Now(),
        }
    }

    // Propagate in headers (X-Amzn-Trace-Id format)
    req.Header.Set("X-Amzn-Trace-Id", cc.ToHeader())
    req.Header.Set("X-Request-Id", cc.TraceID)

    return req
}

// Amazon's DynamoDB patterns for microservices
type DynamoDBRepository struct {
    client    *dynamodb.Client
    tableName string
}

// Single-table design pattern
// All entities in one table with partition and sort keys
func (r *DynamoDBRepository) GetProduct(ctx context.Context, id string) (*Product, error) {
    result, err := r.client.GetItem(ctx, &dynamodb.GetItemInput{
        TableName: &r.tableName,
        Key: map[string]types.AttributeValue{
            "PK": &types.AttributeValueMemberS{Value: fmt.Sprintf("PRODUCT#%s", id)},
            "SK": &types.AttributeValueMemberS{Value: "METADATA"},
        },
    })
    if err != nil {
        return nil, err
    }

    var product Product
    if err := attributevalue.UnmarshalMap(result.Item, &product); err != nil {
        return nil, err
    }

    return &product, nil
}

// Retrieve product with all reviews in single query
func (r *DynamoDBRepository) GetProductWithReviews(ctx context.Context, id string) (*ProductWithReviews, error) {
    result, err := r.client.Query(ctx, &dynamodb.QueryInput{
        TableName:              &r.tableName,
        KeyConditionExpression: aws.String("PK = :pk"),
        ExpressionAttributeValues: map[string]types.AttributeValue{
            ":pk": &types.AttributeValueMemberS{Value: fmt.Sprintf("PRODUCT#%s", id)},
        },
    })
    if err != nil {
        return nil, err
    }

    // First item is product metadata (SK = "METADATA")
    // Remaining items are reviews (SK = "REVIEW#<timestamp>")
    product := &ProductWithReviews{}
    for _, item := range result.Items {
        sk := item["SK"].(*types.AttributeValueMemberS).Value
        if sk == "METADATA" {
            attributevalue.UnmarshalMap(item, &product.Product)
        } else {
            var review Review
            attributevalue.UnmarshalMap(item, &review)
            product.Reviews = append(product.Reviews, review)
        }
    }

    return product, nil
}
```

### Junior → FAANG: Using Case Studies in Interview Narratives

Citing real company case studies in interviews signals that you follow the industry beyond textbooks. These three examples (Netflix, Uber, Amazon) are the canonical references in microservices conversations.

Netflix is the canonical circuit breaker reference. If you mention Hystrix, note that Netflix has largely moved to the Resilience4j successor and that the pattern, not the library, is what matters. The key takeaway: circuit breakers exist because in a highly connected system, a single slow service can exhaust the caller's thread pool and cascade the failure upward. Circuit breakers fail fast rather than queue.

Uber DOMA is the reference for the "too many microservices" problem. After decomposing to thousands of fine-grained services, Uber found that the dependency graph was unmanageable. Their solution was not to re-merge everything but to add a layer of structure: domains with gateway services as the only cross-domain entry points. The lesson for interviews: decompose by business domain first, not by technical function. Domain boundaries are more stable than technical boundaries.

Amazon's two-pizza team rule is the reference for Conway's Law in action. The team structure determines the system structure. If your organization has ten product teams and one platform team, you will naturally end up with roughly ten product services and a shared platform. When interviewers ask "how did you decide the service boundary?" the correct answer often references team ownership.

DynamoDB single-table design is a topic that appears in data modeling interviews at AWS-adjacent companies. The pattern: all entities for a service live in one table, distinguished by PK/SK key patterns (PRODUCT#id, REVIEW#timestamp). This enables efficient queries for composite access patterns that would require multiple tables in a relational model. Know when to use it (high-read, key-value or sorted-range access patterns) and when not to (complex ad-hoc queries, analytical workloads).

### Senior @ FAANG: Extracting Platform Principles from Case Studies

Staff-level engineers do not cite case studies as trivia. They extract the platform principles and apply them to their own organization's context. Each case study contains a specific organizational learning that is transferable.

**Netflix: resilience as a default, not an add-on.** Netflix's insight was that in a large distributed system, failures are not exceptional events. They are the steady state. Simian Army (Chaos Monkey, Chaos Gorilla, Latency Monkey) was the operationalization of this insight: if failures are the steady state, you must continuously test your system's ability to handle them in production. The platform principle is that resilience tooling (circuit breakers, fallback behavior, chaos injection) should be part of the service template, not something each team implements when they first get paged about a cascade failure. At L6/L7, you are the person who writes the service template and the platform policy that requires its adoption.

**Uber DOMA: inter-domain contracts as governance.** DOMA's domain gateway pattern solves a governance problem, not a technical one. Without explicit cross-domain boundaries, teams call each other's internal services directly, creating invisible dependencies that make refactoring impossible. The domain gateway forces every cross-domain call to go through a published, versioned API owned by the destination domain team. The platform principle: inter-domain communication requires a design review and a published contract. Intra-domain communication is the domain team's internal concern. This is the organizational equivalent of Go's `internal` package visibility, enforced by architecture review rather than compiler.

**Amazon: cell-based architecture as a blast-radius model.** Cell-based architecture is the production answer to "what is your blast-radius containment strategy?" Each cell is a complete, self-contained deployment of the service stack, serving a partition of customers (by user ID hash, by geographic region, or by customer tier). A failure in cell 3 affects only the customers routed to cell 3, not the entire user base. The implementation requirements in Go: stateless services route to cells based on a routing key in the request (shard ID extracted from a JWT claim or a URL parameter), and the router layer is cell-aware. State that spans cells (like global counters or cross-shard relationships) is the hardest problem and must be explicitly designed to tolerate cell isolation. Staff engineers at Amazon design new services with cell boundaries in mind from day one, not as a retrofit.

**The common thread across all three.** Each company independently arrived at the same conclusion: the technical architecture follows from the organizational structure, the resilience model must be tested continuously rather than assumed, and the platform team's job is to make the correct behavior the default behavior. This is the staff-level synthesis that interviewers at L6/L7 are looking for: not "here are three case studies I memorized" but "here is the platform principle I would extract and apply to your system."

---
