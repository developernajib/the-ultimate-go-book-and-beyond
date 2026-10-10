## Company Learning Resources

### Google's Go Resources

**Official Resources:**
- **Go Blog** (go.dev/blog) - Official announcements and deep dives
- **Go Talks** (go.dev/talks) - Conference presentations by Go team
- **Effective Go** (go.dev/doc/effective_go) - Official style guide

**Internal-to-External Publications:**

```go
// Google's Go Style Guide (available on GitHub)
// Key recommendations from google/styleguide/go

// Package naming: short, lowercase, no underscores
package users  // Good
package user_accounts  // Avoid

// Interface naming: verb + er suffix for single-method interfaces
type Reader interface {
    Read(p []byte) (n int, err error)
}

// Error handling: don't panic, return errors
func ProcessData(data []byte) error {
    if len(data) == 0 {
        return errors.New("empty data")
    }
    // Process...
    return nil
}

// Context: always first parameter, never stored in structs
func (s *Service) HandleRequest(ctx context.Context, req *Request) (*Response, error) {
    // Use ctx for cancellation and deadlines
}
```

**Google Cloud Go Documentation:**
- Cloud Client Libraries for Go
- Cloud Run Go quickstarts
- Pub/Sub Go tutorials

### Uber's Go Resources

**Open Source Documentation:**

```go
// Uber's Go Style Guide (available on GitHub: uber-go/guide)
// Key patterns from Uber's internal practices

// Dependency Injection with fx
// uber-go/fx provides structured DI
import "go.uber.org/fx"

func main() {
    app := fx.New(
        fx.Provide(
            NewConfig,
            NewDatabase,
            NewHTTPServer,
        ),
        fx.Invoke(StartServer),
    )
    app.Run()
}

// Logging with zap
// uber-go/zap for high-performance structured logging
import "go.uber.org/zap"

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    logger.Info("starting server",
        zap.String("address", ":8080"),
        zap.Int("workers", 10),
    )
}

// Error handling with multierr
// uber-go/multierr for combining errors
import "go.uber.org/multierr"

func processAll(items []Item) error {
    var errs error
    for _, item := range items {
        if err := process(item); err != nil {
            errs = multierr.Append(errs, err)
        }
    }
    return errs
}
```

**Uber Engineering Blog Posts on Go:**
- "Building Reliable Reprocessing with Kafka"
- "Optimizing M3 Metrics Platform"
- "Cadence: The Workflow Engine"

### Netflix's Go Resources

**Tech Blog Deep Dives:**

```go
// Netflix's resilience patterns in Go
// Based on Hystrix concepts

// Circuit Breaker implementation
type CircuitBreaker struct {
    failures    int
    threshold   int
    state       State
    lastFailure time.Time
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    if cb.state == Open {
        if time.Since(cb.lastFailure) > resetTimeout {
            cb.state = HalfOpen
        } else {
            return ErrCircuitOpen
        }
    }

    err := fn()
    if err != nil {
        cb.recordFailure()
    } else {
        cb.recordSuccess()
    }
    return err
}

// Chaos Engineering principles
// Implement failure injection for testing
type FaultInjector interface {
    InjectLatency(duration time.Duration)
    InjectError(errorRate float64)
    TerminateInstance()
}
```

**Netflix OSS Go Repositories:**
- github.com/Netflix/go-env - Environment configuration
- github.com/Netflix/spectator-go - Metrics library

### Stripe's Go Resources

**API Design Documentation:**

```go
// Stripe's API patterns implemented in Go
// From stripe-go library patterns

// Client configuration with functional options
type Client struct {
    key        string
    baseURL    string
    httpClient *http.Client
}

type ClientOption func(*Client)

func WithBaseURL(url string) ClientOption {
    return func(c *Client) {
        c.baseURL = url
    }
}

func WithHTTPClient(hc *http.Client) ClientOption {
    return func(c *Client) {
        c.httpClient = hc
    }
}

func NewClient(key string, opts ...ClientOption) *Client {
    c := &Client{
        key:        key,
        baseURL:    "https://api.stripe.com",
        httpClient: &http.Client{Timeout: 30 * time.Second},
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}

// Idempotency key pattern
type RequestParams struct {
    IdempotencyKey string
}

func (c *Client) CreateCharge(params *ChargeParams) (*Charge, error) {
    req, _ := http.NewRequest("POST", c.baseURL+"/v1/charges", nil)
    if params.IdempotencyKey != "" {
        req.Header.Set("Idempotency-Key", params.IdempotencyKey)
    }
    // Execute request...
}
```

**Stripe Engineering Blog:**
- "Building API-First Infrastructure"
- "Idempotency in Distributed Systems"

### Company Resource Summary

| Company | Style Guide | Key Libraries | Blog Focus |
|---------|-------------|---------------|------------|
| **Google** | google/styleguide/go | cloud.google.com/go | Language design |
| **Uber** | uber-go/guide | zap, fx, multierr | Scale & reliability |
| **Netflix** | Internal | spectator-go | Resilience |
| **Stripe** | Internal | stripe-go | API design |
| **Cloudflare** | Internal | cfssl, cloudflared | Security |
| **HashiCorp** | hashicorp/terraform | consul, vault, nomad | Infrastructure |

### Recommended Learning Paths by Company Standards

**To match Google's expectations:**
1. Master effective-go.md
2. Study google-cloud-go patterns
3. Practice with GopherCon talks
4. Focus on: Code clarity, testing, documentation

**To match Uber's expectations:**
1. Adopt uber-go/guide style
2. Learn zap, fx, multierr
3. Study eng.uber.com articles
4. Focus on: Performance, observability, reliability

**To match Netflix's expectations:**
1. Understand Hystrix patterns
2. Implement chaos engineering
3. Study netflixtechblog.com
4. Focus on: Resilience, streaming, scale

**To match Stripe's expectations:**
1. Study stripe-go library design
2. Learn idempotency patterns
3. Read stripe.com/blog/engineering
4. Focus on: API design, correctness, security

---

---

## Conclusion

Start with the official resources (go.dev, Effective Go), read production code (standard library, Kubernetes), and build real projects. Theory without practice is incomplete. Study and build in equal measure.

---

| [◀ Appendix H: Comprehensive Glossary](../appendix-h-glossary/00-introduction.md) | [Appendix I: Recommended Resources](00-introduction.md) | [Appendix J: Go Version Changelog](../appendix-j-version-changelog/00-introduction.md) ▶ |
| :--- | :---: | ---: |
