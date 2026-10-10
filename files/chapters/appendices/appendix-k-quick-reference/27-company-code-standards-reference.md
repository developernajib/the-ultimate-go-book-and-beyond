## Company Code Standards Reference

### Google's Go Style (Summary)

```go
// Package naming: short, lowercase, no underscores
package users     // Good
package user_svc  // Avoid

// Interface naming: -er suffix for single-method
type Reader interface { Read([]byte) (int, error) }
type Writer interface { Write([]byte) (int, error) }

// Error handling: check immediately, wrap with context
result, err := doSomething()
if err != nil {
    return fmt.Errorf("doSomething: %w", err)
}

// Context: first parameter, never stored
func (s *Service) Handle(ctx context.Context, req *Request) error

// Comments: complete sentences, start with name
// ProcessData handles incoming data streams.
func ProcessData(data []byte) error
```

### Uber's Go Style (Summary)

```go
// Imports: group stdlib, external, internal
import (
    "context"
    "fmt"

    "go.uber.org/zap"
    "github.com/pkg/errors"

    "mycompany/internal/config"
)

// Errors: use uber-go/multierr for combining
var errs error
for _, item := range items {
    errs = multierr.Append(errs, process(item))
}

// Logging: structured with zap
logger.Info("request processed",
    zap.String("request_id", reqID),
    zap.Duration("latency", time.Since(start)),
)

// DI: use fx for dependency injection
fx.New(
    fx.Provide(NewConfig),
    fx.Provide(NewServer),
    fx.Invoke(Run),
)
```

### Netflix's Go Style (Summary)

```go
// Resilience: always use circuit breakers
cb := circuitbreaker.New(circuitbreaker.Config{
    Timeout:          5 * time.Second,
    MaxFailures:      3,
    ResetTimeout:     30 * time.Second,
})

result, err := cb.Execute(func() (any, error) {
    return client.Call(ctx, req)
})

// Timeouts: always set, never infinite
ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
defer cancel()

// Retries: exponential backoff with jitter
backoff := retry.NewExponential(100*time.Millisecond).
    WithMaxRetries(3).
    WithJitter(0.2)
```

### Stripe's Go Style (Summary)

```go
// API responses: consistent structure
type Response struct {
    Object    string      `json:"object"`
    Data      any `json:"data"`
    HasMore   bool        `json:"has_more,omitempty"`
    RequestID string      `json:"request_id"`
}

// Idempotency: always support for mutations
func CreatePayment(ctx context.Context, params CreateParams) (*Payment, error) {
    if params.IdempotencyKey != "" {
        // Check idempotency cache first
    }
    // Process...
}

// Versioning: header-based API versions
type Client struct {
    APIVersion string // e.g., "2024-01-01"
}

// Error types: structured with codes
type Error struct {
    Type    string `json:"type"`
    Code    string `json:"code"`
    Message string `json:"message"`
    Param   string `json:"param,omitempty"`
}
```

### Company Standards Comparison

| Aspect | Google | Uber | Netflix | Stripe |
|--------|--------|------|---------|--------|
| **Logging** | stdlib | zap | spectator | custom |
| **Errors** | wrap | multierr | custom | structured |
| **DI** | wire | fx | manual | manual |
| **Config** | flags | env | env | env |
| **HTTP** | stdlib | stdlib | custom | stdlib |
| **Testing** | table | table | chaos | table |

### Quick Reference: Which Style to Follow

```
Building at Google? → google/styleguide/go
Building at Uber?   → uber-go/guide
Building at Netflix? → Resilience patterns
Building at Stripe? → API design focus
Open source?        → golang.org/doc/effective_go
```

---
