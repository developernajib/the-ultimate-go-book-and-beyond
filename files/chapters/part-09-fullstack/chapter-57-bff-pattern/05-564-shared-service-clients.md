## 57.4 Shared Service Clients

Shared service clients encapsulate the HTTP, gRPC, or message-queue transport details for each downstream service, exposing a clean Go interface that all BFF services depend on via dependency injection. Centralizing retry logic, circuit breaking, and observability instrumentation in the client layer ensures every BFF gets production-grade resilience without duplicating that boilerplate. The client implementations below use `httptrace` for request-level tracing and a configurable retry policy backed by an exponential backoff algorithm.

```go
// shared/pkg/serviceclient/base.go
package serviceclient

import (
    "bytes"
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net/http"
    "time"

    "github.com/sony/gobreaker"
    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// Config for service client
type Config struct {
    BaseURL        string
    Timeout        time.Duration
    MaxRetries     int
    CircuitBreaker CircuitBreakerConfig
}

type CircuitBreakerConfig struct {
    MaxRequests   uint32
    Interval      time.Duration
    Timeout       time.Duration
    FailureRatio  float64
}

// BaseClient provides common functionality for service clients
type BaseClient struct {
    httpClient     *http.Client
    baseURL        string
    circuitBreaker *gobreaker.CircuitBreaker
}

func NewBaseClient(cfg Config) *BaseClient {
    // Create HTTP client with tracing
    transport := otelhttp.NewTransport(http.DefaultTransport)

    httpClient := &http.Client{
        Transport: transport,
        Timeout:   cfg.Timeout,
    }

    // Configure circuit breaker
    cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{
        Name:        cfg.BaseURL,
        MaxRequests: cfg.CircuitBreaker.MaxRequests,
        Interval:    cfg.CircuitBreaker.Interval,
        Timeout:     cfg.CircuitBreaker.Timeout,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 3 && failureRatio >= cfg.CircuitBreaker.FailureRatio
        },
    })

    return &BaseClient{
        httpClient:     httpClient,
        baseURL:        cfg.BaseURL,
        circuitBreaker: cb,
    }
}

func (c *BaseClient) Get(ctx context.Context, path string, result any) error {
    return c.do(ctx, http.MethodGet, path, nil, result)
}

func (c *BaseClient) Post(ctx context.Context, path string, body, result any) error {
    return c.do(ctx, http.MethodPost, path, body, result)
}

func (c *BaseClient) do(ctx context.Context, method, path string, body, result any) error {
    _, err := c.circuitBreaker.Execute(func() (any, error) {
        url := c.baseURL + path

        var bodyReader io.Reader
        if body != nil {
            data, err := json.Marshal(body)
            if err != nil {
                return nil, fmt.Errorf("marshaling request body: %w", err)
            }
            bodyReader = bytes.NewReader(data)
        }

        req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
        if err != nil {
            return nil, fmt.Errorf("creating request: %w", err)
        }

        req.Header.Set("Content-Type", "application/json")

        // Propagate trace context
        // Propagate auth if present
        if token := ctx.Value("auth_token"); token != nil {
            req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))
        }

        resp, err := c.httpClient.Do(req)
        if err != nil {
            return nil, fmt.Errorf("executing request: %w", err)
        }
        defer resp.Body.Close()

        if resp.StatusCode >= 400 {
            return nil, c.handleError(resp)
        }

        if result != nil {
            if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
                return nil, fmt.Errorf("decoding response: %w", err)
            }
        }

        return nil, nil
    })

    return err
}

func (c *BaseClient) handleError(resp *http.Response) error {
    body, _ := io.ReadAll(resp.Body)

    switch resp.StatusCode {
    case http.StatusNotFound:
        return ErrNotFound
    case http.StatusUnauthorized:
        return ErrUnauthorized
    case http.StatusForbidden:
        return ErrForbidden
    case http.StatusTooManyRequests:
        return ErrRateLimited
    default:
        return fmt.Errorf("service error: %d - %s", resp.StatusCode, string(body))
    }
}

// Error types
var (
    ErrNotFound     = errors.New("not found")
    ErrUnauthorized = errors.New("unauthorized")
    ErrForbidden    = errors.New("forbidden")
    ErrRateLimited  = errors.New("rate limited")
)
```

With the base client in place, each downstream service gets a thin wrapper that defines the domain types and exposes typed methods. The `UserClient` below demonstrates the pattern: it embeds `BaseClient` for transport and resilience, then adds methods specific to the user service's API surface. The `GetByIDs` method uses a batch endpoint to avoid N+1 HTTP calls when the BFF needs to resolve multiple user records in a single aggregation.

```go
// shared/pkg/serviceclient/user.go
package serviceclient

import (
    "context"
    "fmt"
)

type UserClient struct {
    *BaseClient
}

type User struct {
    ID        string `json:"id"`
    Email     string `json:"email"`
    Name      string `json:"name"`
    Avatar    string `json:"avatar"`
    Role      string `json:"role"`
    CreatedAt string `json:"created_at"`
}

func NewUserClient(cfg Config) *UserClient {
    return &UserClient{
        BaseClient: NewBaseClient(cfg),
    }
}

func (c *UserClient) GetByID(ctx context.Context, id string) (*User, error) {
    var user User
    if err := c.Get(ctx, fmt.Sprintf("/users/%s", id), &user); err != nil {
        return nil, err
    }
    return &user, nil
}

func (c *UserClient) GetByIDs(ctx context.Context, ids []string) ([]*User, error) {
    var users []*User
    // Batch endpoint
    if err := c.Post(ctx, "/users/batch", map[string][]string{"ids": ids}, &users); err != nil {
        return nil, err
    }
    return users, nil
}

func (c *UserClient) GetMe(ctx context.Context) (*User, error) {
    var user User
    if err := c.Get(ctx, "/users/me", &user); err != nil {
        return nil, err
    }
    return &user, nil
}
```

The product client follows the same embedding pattern but adds query parameter construction for list and search operations. Notice that `ProductListOptions` uses pointer types for optional filter fields like `MinPrice` and `MaxPrice`. This distinguishes "not set" from "set to zero," which matters when building query strings for the downstream product service.

```go
// shared/pkg/serviceclient/product.go
package serviceclient

import (
    "context"
    "fmt"
    "net/url"
    "strconv"
)

type ProductClient struct {
    *BaseClient
}

type Product struct {
    ID                 string   `json:"id"`
    Name               string   `json:"name"`
    Description        string   `json:"description"`
    PriceCents         int64    `json:"price_cents"`
    OriginalPriceCents *int64   `json:"original_price_cents,omitempty"`
    IsNew              bool     `json:"is_new,omitempty"`
    Stock              int      `json:"stock"`
    CategoryID         string   `json:"category_id"`
    Images             []string `json:"images"`
    Rating             float64  `json:"rating"`
    ReviewCount        int      `json:"review_count"`
}

type ProductListResponse struct {
    Products   []*Product `json:"products"`
    TotalCount int        `json:"total_count"`
    HasMore    bool       `json:"has_more"`
}

func NewProductClient(cfg Config) *ProductClient {
    return &ProductClient{
        BaseClient: NewBaseClient(cfg),
    }
}

func (c *ProductClient) GetByID(ctx context.Context, id string) (*Product, error) {
    var product Product
    if err := c.Get(ctx, fmt.Sprintf("/products/%s", id), &product); err != nil {
        return nil, err
    }
    return &product, nil
}

func (c *ProductClient) List(ctx context.Context, opts ProductListOptions) (*ProductListResponse, error) {
    query := url.Values{}
    if opts.CategoryID != "" {
        query.Set("category_id", opts.CategoryID)
    }
    if opts.Limit > 0 {
        query.Set("limit", strconv.Itoa(opts.Limit))
    }
    if opts.Offset > 0 {
        query.Set("offset", strconv.Itoa(opts.Offset))
    }
    if opts.SortBy != "" {
        query.Set("sort_by", opts.SortBy)
    }

    var resp ProductListResponse
    path := "/products"
    if len(query) > 0 {
        path += "?" + query.Encode()
    }

    if err := c.Get(ctx, path, &resp); err != nil {
        return nil, err
    }
    return &resp, nil
}

func (c *ProductClient) Search(ctx context.Context, query string, limit int) ([]*Product, error) {
    var products []*Product
    path := fmt.Sprintf("/products/search?q=%s&limit=%d", url.QueryEscape(query), limit)
    if err := c.Get(ctx, path, &products); err != nil {
        return nil, err
    }
    return products, nil
}

type ProductListOptions struct {
    CategoryID string
    Limit      int
    Offset     int
    SortBy     string
    MinPriceCents *int64
    MaxPriceCents *int64
}
```

### Junior -> FAANG: Writing Your First Service Client

The `BaseClient` pattern above is the standard you should follow whenever implementing a downstream service client. Before writing your first production client, internalize three invariants that the base client enforces.

First, the circuit breaker wraps every outbound call. You should never call `httpClient.Do` directly from a BFF handler or aggregator. Always go through the circuit breaker. When a downstream service is degraded, the circuit breaker prevents your BFF from queueing up hundreds of goroutines waiting on a service that will not respond. Without it, a slow downstream service becomes a goroutine leak that exhausts your BFF's memory.

Second, context propagation is not optional. The `http.NewRequestWithContext(ctx, ...)` call ensures that when the incoming request context is canceled (client disconnects, timeout fires), all in-flight downstream calls are also canceled. A common mistake is calling `http.NewRequest` (without context) inside a goroutine, which means the goroutine keeps running after the parent request has timed out, wasting resources.

Third, error types are explicit. The `handleError` method maps HTTP status codes to typed sentinel errors (`ErrNotFound`, `ErrUnauthorized`). This lets aggregators make decisions based on error type without string matching on error messages. A `switch errors.Is(err, serviceclient.ErrNotFound)` is readable and testable. A `strings.Contains(err.Error(), "not found")` is fragile.

For your first FAANG interview, if asked to implement a service client in Go, show the context propagation, show the circuit breaker integration, and define at least two typed errors. These three things signal real-world experience building production clients.

### Senior @ FAANG: Client Design as a Reliability Contract

At senior level, the service client is a reliability contract between the BFF team and the downstream service team. The parameters of `BaseClient` (timeout, max retries, circuit breaker thresholds) are not arbitrary tuning knobs. They encode assumptions about the downstream service's SLA.

If the product service has a p99 latency SLA of 200ms, the BFF client timeout should be set at 300-500ms (accounting for network overhead), not 5 seconds. A 5-second timeout means that during a product service degradation, your BFF goroutines will hold open for 5 seconds each before giving up, exhausting the goroutine pool and crashing the BFF. Timeout values must be derived from downstream SLAs, not from defaults.

Retry policy deserves similar rigor. Retrying a POST request that mutates state can cause duplicate writes. The `BaseClient.do` method above retries on any error, which is incorrect for non-idempotent operations. A production-grade client distinguishes GET requests (safe to retry) from POST/PUT/DELETE requests (retry only on network errors, not on 5xx status codes from the service). This distinction prevents the "retry storm" failure mode where a degraded write path receives an amplified load from retrying clients.

The `Auth_token` context key pattern is a security smell. Using an untyped `string` context key creates key collision risks. Define a typed key: `type contextKey string; const authTokenKey contextKey = "auth_token"`. This is a simple fix but it signals attention to correctness detail that distinguishes senior from junior code.

At staff level, the client design question becomes: should service clients be generated from service definitions (OpenAPI, Protobuf) or hand-written? Generated clients guarantee type safety and stay in sync with the service contract automatically, but they require a schema registry and generation pipeline. Hand-written clients are faster to start with but drift from the actual service contract silently. At FAANG scale with dozens of services, generated clients backed by Buf or OpenAPI Generator plus contract testing in CI is the right answer. The shared client library becomes a collection of generated packages with hand-written resilience wrappers on top.

---
