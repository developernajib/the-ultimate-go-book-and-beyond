export default `## 8.7 Company Case Studies

### Google: Type-Safe Configuration

Google's internal Go libraries use generics to build type-safe configuration loaders. The pattern below parameterizes the config struct type, so the loader deserializes JSON directly into the correct struct without any \`interface{}\` intermediate or manual type assertions. A builder-style \`WithValidation\` method attaches domain-specific validation before the config reaches application code.

\`\`\`go
// Google-style typed configuration
package config

import (
    "encoding/json"
    "os"
)

// ConfigLoader loads typed configuration
type ConfigLoader[T any] struct {
    path     string
    defaults T
    validate func(T) error
}

func NewConfigLoader[T any](path string, defaults T) *ConfigLoader[T] {
    return &ConfigLoader[T]{
        path:     path,
        defaults: defaults,
    }
}

func (c *ConfigLoader[T]) WithValidation(fn func(T) error) *ConfigLoader[T] {
    c.validate = fn
    return c
}

func (c *ConfigLoader[T]) Load() (T, error) {
    config := c.defaults

    data, err := os.ReadFile(c.path)
    if err != nil {
        if os.IsNotExist(err) {
            return config, nil // Return defaults
        }
        return config, err
    }

    if err := json.Unmarshal(data, &config); err != nil {
        return config, err
    }

    if c.validate != nil {
        if err := c.validate(config); err != nil {
            return config, err
        }
    }

    return config, nil
}

// Usage at Google-scale
type ServiceConfig struct {
    Port        int      \`json:"port"\`
    Timeout     Duration \`json:"timeout"\`
    MaxRequests int      \`json:"max_requests"\`
    Endpoints   []string \`json:"endpoints"\`
}

func loadServiceConfig() (ServiceConfig, error) {
    loader := NewConfigLoader("config.json", ServiceConfig{
        Port:        8080,
        Timeout:     Duration(30 * time.Second),
        MaxRequests: 1000,
    }).WithValidation(func(c ServiceConfig) error {
        if c.Port <= 0 || c.Port > 65535 {
            return errors.New("invalid port")
        }
        return nil
    })

    return loader.Load()
}
\`\`\`

### Uber: Generic Retry Mechanism

Uber's Go platform libraries wrap retry logic in a generic \`Do[T]\` function. The type parameter preserves the return type through the retry loop, so callers get a typed result without casting. The implementation includes exponential backoff with jitter, context cancellation, and configurable error filtering, all patterns from Uber's production retry infrastructure.

\`\`\`go
// Uber-style retry with generics
package retry

import (
    "context"
    "errors"
    "math"
    "math/rand/v2"
    "time"
)

type RetryConfig struct {
    MaxAttempts   int
    InitialDelay  time.Duration
    MaxDelay      time.Duration
    Multiplier    float64
    Jitter        float64
    RetryableErrs []error
}

func DefaultConfig() RetryConfig {
    return RetryConfig{
        MaxAttempts:  3,
        InitialDelay: 100 * time.Millisecond,
        MaxDelay:     10 * time.Second,
        Multiplier:   2.0,
        Jitter:       0.1,
    }
}

// Do executes fn with retry, returning the result type T
func Do[T any](ctx context.Context, cfg RetryConfig, fn func() (T, error)) (T, error) {
    var lastErr error
    var zero T

    delay := cfg.InitialDelay

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        result, err := fn()
        if err == nil {
            return result, nil
        }

        lastErr = err

        // Check if error is retryable
        if !isRetryable(err, cfg.RetryableErrs) {
            return zero, err
        }

        // Don't wait after last attempt
        if attempt == cfg.MaxAttempts-1 {
            break
        }

        // Calculate delay with jitter
        jitter := delay.Seconds() * cfg.Jitter * (rand.Float64()*2 - 1)
        actualDelay := time.Duration(delay.Seconds()+jitter) * time.Second

        select {
        case <-ctx.Done():
            return zero, ctx.Err()
        case <-time.After(actualDelay):
        }

        // Exponential backoff
        delay = time.Duration(float64(delay) * cfg.Multiplier)
        if delay > cfg.MaxDelay {
            delay = cfg.MaxDelay
        }
    }

    return zero, lastErr
}

func isRetryable(err error, retryableErrs []error) bool {
    if len(retryableErrs) == 0 {
        return true // Retry all errors
    }
    for _, re := range retryableErrs {
        if errors.Is(err, re) {
            return true
        }
    }
    return false
}

// Usage
type User struct {
    ID   int
    Name string
}

func fetchUser(ctx context.Context, id int) (User, error) {
    return Do(ctx, DefaultConfig(), func() (User, error) {
        // Actual HTTP call
        resp, err := http.Get(fmt.Sprintf("http://api/users/%d", id))
        if err != nil {
            return User{}, err
        }
        defer resp.Body.Close()

        var user User
        if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
            return User{}, err
        }
        return user, nil
    })
}
\`\`\`

### Netflix: Generic Circuit Breaker

Netflix's resilience libraries use a generic circuit breaker that tracks failure/success counts and transitions between closed, open, and half-open states. The type parameter \`T\` captures the response type, so the \`Execute\` method returns \`(T, error)\` instead of \`(any, error)\`. This eliminates type assertions at every call site across hundreds of microservices.

\`\`\`go
// Netflix-style circuit breaker with generics
package circuitbreaker

import (
    "context"
    "encoding/json"
    "errors"
    "log"
    "net/http"
    "sync"
    "time"
)

var (
    ErrCircuitOpen    = errors.New("circuit breaker is open")
    ErrTimeout        = errors.New("execution timeout")
)

type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

type CircuitBreaker[T any] struct {
    mu              sync.RWMutex
    state           State
    failures        int
    successes       int
    lastFailure     time.Time

    // Configuration
    maxFailures     int
    timeout         time.Duration
    halfOpenMax     int
    resetTimeout    time.Duration

    // Callbacks
    onStateChange   func(from, to State)
}

type CircuitConfig struct {
    MaxFailures   int
    Timeout       time.Duration
    HalfOpenMax   int
    ResetTimeout  time.Duration
}

func NewCircuitBreaker[T any](cfg CircuitConfig) *CircuitBreaker[T] {
    return &CircuitBreaker[T]{
        state:        StateClosed,
        maxFailures:  cfg.MaxFailures,
        timeout:      cfg.Timeout,
        halfOpenMax:  cfg.HalfOpenMax,
        resetTimeout: cfg.ResetTimeout,
    }
}

func (cb *CircuitBreaker[T]) OnStateChange(fn func(from, to State)) {
    cb.onStateChange = fn
}

func (cb *CircuitBreaker[T]) Execute(ctx context.Context, fn func() (T, error)) (T, error) {
    var zero T

    if !cb.canExecute() {
        return zero, ErrCircuitOpen
    }

    // Execute with timeout
    resultCh := make(chan struct {
        value T
        err   error
    }, 1)

    go func() {
        value, err := fn()
        resultCh <- struct {
            value T
            err   error
        }{value, err}
    }()

    select {
    case <-ctx.Done():
        cb.recordFailure()
        return zero, ctx.Err()
    case <-time.After(cb.timeout):
        cb.recordFailure()
        return zero, ErrTimeout
    case result := <-resultCh:
        if result.err != nil {
            cb.recordFailure()
            return zero, result.err
        }
        cb.recordSuccess()
        return result.value, nil
    }
}

func (cb *CircuitBreaker[T]) canExecute() bool {
    cb.mu.RLock()
    defer cb.mu.RUnlock()

    switch cb.state {
    case StateClosed:
        return true
    case StateOpen:
        if time.Since(cb.lastFailure) > cb.resetTimeout {
            cb.mu.RUnlock()
            cb.mu.Lock()
            cb.transitionTo(StateHalfOpen)
            cb.mu.Unlock()
            cb.mu.RLock()
            return true
        }
        return false
    case StateHalfOpen:
        return cb.successes < cb.halfOpenMax
    }
    return false
}

func (cb *CircuitBreaker[T]) recordSuccess() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        cb.failures = 0
    case StateHalfOpen:
        cb.successes++
        if cb.successes >= cb.halfOpenMax {
            cb.transitionTo(StateClosed)
        }
    }
}

func (cb *CircuitBreaker[T]) recordFailure() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.lastFailure = time.Now()
    cb.failures++

    switch cb.state {
    case StateClosed:
        if cb.failures >= cb.maxFailures {
            cb.transitionTo(StateOpen)
        }
    case StateHalfOpen:
        cb.transitionTo(StateOpen)
    }
}

func (cb *CircuitBreaker[T]) transitionTo(newState State) {
    if cb.state == newState {
        return
    }

    oldState := cb.state
    cb.state = newState
    cb.failures = 0
    cb.successes = 0

    if cb.onStateChange != nil {
        go cb.onStateChange(oldState, newState)
    }
}

func (cb *CircuitBreaker[T]) State() State {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.state
}

// Usage
type APIResponse struct {
    Data  json.RawMessage
    Error string
}

func main() {
    cb := NewCircuitBreaker[APIResponse](CircuitConfig{
        MaxFailures:  5,
        Timeout:      2 * time.Second,
        HalfOpenMax:  3,
        ResetTimeout: 30 * time.Second,
    })

    cb.OnStateChange(func(from, to State) {
        log.Printf("Circuit breaker state changed: %v -> %v", from, to)
    })

    response, err := cb.Execute(context.Background(), func() (APIResponse, error) {
        resp, err := http.Get("http://api.example.com/data")
        if err != nil {
            return APIResponse{}, err
        }
        defer resp.Body.Close()

        var apiResp APIResponse
        json.NewDecoder(resp.Body).Decode(&apiResp)
        return apiResp, nil
    })

    if err != nil {
        log.Printf("Request failed: %v", err)
        return
    }

    log.Printf("Response: %+v", response)
}
\`\`\`

### What the Case Studies Have in Common

The companies that adopted generics successfully share three traits:

1. **They started with well-understood use cases.** Collections, caching, retry logic. Not domain types.
2. **They measured performance impact.** Some generic adoptions saved allocations by removing \`interface{}\` boxing. Others had no measurable impact either way.
3. **They documented the team discipline.** When to use generics, when to stay concrete, examples of each.

The team adopting generics without this structure gets generics-heavy code that is hard to read and slow to compile. The team with this structure gets the benefits and not the costs.

---
`;
