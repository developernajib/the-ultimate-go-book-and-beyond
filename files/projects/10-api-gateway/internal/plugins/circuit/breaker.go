// internal/plugins/circuit/breaker.go
package circuit

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/example/api-gateway/internal/plugin"
)

// State represents circuit breaker state
type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

func (s State) String() string {
    switch s {
    case StateClosed:
        return "closed"
    case StateOpen:
        return "open"
    case StateHalfOpen:
        return "half-open"
    default:
        return "unknown"
    }
}

// CircuitBreakerPlugin implements the circuit breaker pattern
type CircuitBreakerPlugin struct {
    mu                  sync.RWMutex
    state               State
    errorThreshold      int
    successThreshold    int
    timeout             time.Duration
    halfOpenMaxRequests int

    failures            int
    successes           int
    halfOpenRequests    int
    lastStateChange     time.Time
}

func NewCircuitBreakerPlugin() plugin.Plugin {
    return &CircuitBreakerPlugin{
        state:            StateClosed,
        lastStateChange:  time.Now(),
    }
}

func (p *CircuitBreakerPlugin) Name() string {
    return "circuit_breaker"
}

func (p *CircuitBreakerPlugin) Priority() int {
    return 400
}

func (p *CircuitBreakerPlugin) Init(config map[string]any) error {
    if threshold, ok := config["error_threshold"].(int); ok {
        p.errorThreshold = threshold
    } else {
        p.errorThreshold = 50
    }

    if threshold, ok := config["success_threshold"].(int); ok {
        p.successThreshold = threshold
    } else {
        p.successThreshold = 5
    }

    if timeout, ok := config["timeout"].(string); ok {
        dur, err := time.ParseDuration(timeout)
        if err != nil {
            return fmt.Errorf("invalid timeout: %w", err)
        }
        p.timeout = dur
    } else {
        p.timeout = 60 * time.Second
    }

    if max, ok := config["half_open_max_requests"].(int); ok {
        p.halfOpenMaxRequests = max
    } else {
        p.halfOpenMaxRequests = 3
    }

    return nil
}

func (p *CircuitBreakerPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    // Check if we should transition from open to half-open
    if p.state == StateOpen {
        if time.Since(p.lastStateChange) > p.timeout {
            p.transitionTo(StateHalfOpen)
        }
    }

    // Reject request if circuit is open
    if p.state == StateOpen {
        return nil, &CircuitBreakerError{
            State:      p.state,
            RetryAfter: p.timeout - time.Since(p.lastStateChange),
        }
    }

    // Limit concurrent requests in half-open state
    if p.state == StateHalfOpen {
        if p.halfOpenRequests >= p.halfOpenMaxRequests {
            return nil, &CircuitBreakerError{
                State:      p.state,
                RetryAfter: time.Second,
            }
        }
        p.halfOpenRequests++
    }

    return req, nil
}

func (p *CircuitBreakerPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    // Record success or failure based on status code
    if resp.StatusCode >= 500 {
        p.recordFailure()
    } else {
        p.recordSuccess()
    }

    if p.state == StateHalfOpen {
        p.halfOpenRequests--
    }

    return resp, nil
}

func (p *CircuitBreakerPlugin) recordSuccess() {
    p.failures = 0
    p.successes++

    if p.state == StateHalfOpen && p.successes >= p.successThreshold {
        p.transitionTo(StateClosed)
    }
}

func (p *CircuitBreakerPlugin) recordFailure() {
    p.successes = 0
    p.failures++

    if p.state == StateClosed && p.failures >= p.errorThreshold {
        p.transitionTo(StateOpen)
    } else if p.state == StateHalfOpen {
        p.transitionTo(StateOpen)
    }
}

func (p *CircuitBreakerPlugin) transitionTo(state State) {
    p.state = state
    p.lastStateChange = time.Now()
    p.failures = 0
    p.successes = 0
    p.halfOpenRequests = 0
}

type CircuitBreakerError struct {
    State      State
    RetryAfter time.Duration
}

func (e *CircuitBreakerError) Error() string {
    return fmt.Sprintf("circuit breaker %s, retry after %v", e.State, e.RetryAfter)
}

func init() {
    plugin.Register("circuit_breaker", NewCircuitBreakerPlugin)
}
