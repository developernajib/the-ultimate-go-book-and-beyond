export default `## 12.8 Retry Pattern

Handle transient failures with intelligent retries.

### Exponential Backoff with Jitter

The \`JitterFactor\` introduces randomness that desynchronizes retries from multiple callers, preventing the thundering herd where all clients retry at identical intervals. The \`RetryIf\` predicate classifies errors as retriable or terminal, ensuring that 4xx client errors are not retried indefinitely while transient network errors are.

\`\`\`go
// RetryConfig configures retry behavior
type RetryConfig struct {
    MaxRetries     int
    InitialBackoff time.Duration
    MaxBackoff     time.Duration
    Multiplier     float64
    JitterFactor   float64
    RetryIf        func(error) bool
}

func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxRetries:     3,
        InitialBackoff: 100 * time.Millisecond,
        MaxBackoff:     30 * time.Second,
        Multiplier:     2.0,
        JitterFactor:   0.2,
        RetryIf:        func(error) bool { return true },
    }
}

// Retry executes a function with retries
func Retry(ctx context.Context, cfg RetryConfig, fn func() error) error {
    var lastErr error
    backoff := cfg.InitialBackoff

    for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
        // Execute function
        err := fn()
        if err == nil {
            return nil
        }

        lastErr = err

        // Check if error is retryable
        if cfg.RetryIf != nil && !cfg.RetryIf(err) {
            return fmt.Errorf("non-retryable error: %w", err)
        }

        // Last attempt, don't wait
        if attempt == cfg.MaxRetries {
            break
        }

        // Calculate wait with jitter
        jitter := time.Duration(rand.Float64() * cfg.JitterFactor * float64(backoff))
        wait := backoff + jitter

        // Wait or cancel
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(wait):
        }

        // Exponential backoff
        backoff = time.Duration(float64(backoff) * cfg.Multiplier)
        if backoff > cfg.MaxBackoff {
            backoff = cfg.MaxBackoff
        }
    }

    return fmt.Errorf("max retries (%d) exceeded: %w", cfg.MaxRetries, lastErr)
}

// RetryWithResult retries a function that returns a value
func RetryWithResult[T any](ctx context.Context, cfg RetryConfig, fn func() (T, error)) (T, error) {
    var result T
    var lastErr error
    backoff := cfg.InitialBackoff

    for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
        var err error
        result, err = fn()
        if err == nil {
            return result, nil
        }

        lastErr = err

        if cfg.RetryIf != nil && !cfg.RetryIf(err) {
            return result, fmt.Errorf("non-retryable error: %w", err)
        }

        if attempt == cfg.MaxRetries {
            break
        }

        jitter := time.Duration(rand.Float64() * cfg.JitterFactor * float64(backoff))
        wait := backoff + jitter

        select {
        case <-ctx.Done():
            return result, ctx.Err()
        case <-time.After(wait):
        }

        backoff = time.Duration(float64(backoff) * cfg.Multiplier)
        if backoff > cfg.MaxBackoff {
            backoff = cfg.MaxBackoff
        }
    }

    return result, fmt.Errorf("max retries (%d) exceeded: %w", cfg.MaxRetries, lastErr)
}
\`\`\`

### Retryable Errors

Not every error warrants a retry, retrying a 400 Bad Request or an authentication failure wastes time and can trigger account lockouts. The \`RetryableError\` wrapper lets a callee explicitly tag an error as transient and optionally specify a \`RetryAfter\` duration extracted from a \`Retry-After\` HTTP header. The \`DefaultRetryIf\` predicate provides a safe baseline by short-circuiting on context cancellation and using \`errors.As\` unwrapping to detect network-layer errors, which are reliably transient in distributed systems.

\`\`\`go
// RetryableError marks an error as retryable
type RetryableError struct {
    Err       error
    RetryAfter time.Duration
}

func (e *RetryableError) Error() string {
    return e.Err.Error()
}

func (e *RetryableError) Unwrap() error {
    return e.Err
}

// IsRetryable checks if an error is retryable
func IsRetryable(err error) bool {
    var re *RetryableError
    return errors.As(err, &re)
}

// GetRetryAfter returns the retry-after duration if set
func GetRetryAfter(err error) (time.Duration, bool) {
    var re *RetryableError
    if errors.As(err, &re) && re.RetryAfter > 0 {
        return re.RetryAfter, true
    }
    return 0, false
}

// Common retryable error checkers
func IsTemporary(err error) bool {
    var temp interface{ Temporary() bool }
    return errors.As(err, &temp) && temp.Temporary()
}

func IsTimeout(err error) bool {
    var timeout interface{ Timeout() bool }
    return errors.As(err, &timeout) && timeout.Timeout()
}

func IsNetworkError(err error) bool {
    var netErr *net.OpError
    return errors.As(err, &netErr)
}

// DefaultRetryIf is a reasonable default retry predicate
func DefaultRetryIf(err error) bool {
    if err == nil {
        return false
    }

    // Context errors are not retryable
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
        return false
    }

    // Check for explicit retryable marker
    if IsRetryable(err) {
        return true
    }

    // Network errors are often transient
    if IsNetworkError(err) || IsTimeout(err) || IsTemporary(err) {
        return true
    }

    return false
}
\`\`\`

### Jitter Is Not Optional

Retry without jitter causes thundering herds: every failing client retries at the same exponential-backoff intervals, hitting the recovering downstream simultaneously. Jitter spreads the retries across a random window, smoothing the load. The AWS Architecture Blog post "Exponential Backoff and Jitter" is required reading for anyone implementing retries. The decorrelated-jitter variant described there is the canonical production shape.

\`\`\`go
// Equal jitter: sleep in range [backoff/2, backoff]
sleep := time.Duration(rand.Int63n(int64(backoff/2))) + backoff/2

// Full jitter: sleep in range [0, backoff]
sleep := time.Duration(rand.Int63n(int64(backoff)))
\`\`\`

Hand-rolling retry without jitter is a thundering-herd incident waiting to fire. Either use a library (\`github.com/cenkalti/backoff\`, \`github.com/avast/retry-go\`) or be explicit about adding jitter in review.

### Retry Budget

A retry policy can amplify load by its retry count. Three retries means every failure potentially quadruples the request rate on the downstream. Under a partial outage this makes things worse. The retry-budget concept: globally cap how much of your service's outbound traffic is retries. If retries exceed, say, 10% of total outbound, stop retrying for a while. This prevents retries from overwhelming a recovering system. Google SRE book covers this pattern in detail.

### When Not to Retry

Not every error is retryable. 4xx status codes usually are not (the request is bad, retrying will not fix it). Context-cancelled is not retryable. Some specific business errors are not retryable (payment declined, permission denied). The retry policy must know which errors to retry and which to surface. A policy that retries everything silently masks bugs in the caller's request.

### Staff Lens: Retry Policy Is a Negotiation

Every retry policy is an implicit negotiation between the caller and the downstream. The caller wants resilience. The downstream wants to not be overwhelmed. A well-designed retry policy respects both. Attributes of a good policy:

- Bounded by count (not infinite).
- Bounded by total time (not unbounded backoff).
- Honours \`Retry-After\` headers from the downstream if provided.
- Integrated with a circuit breaker so retries stop during sustained failures.
- Instrumented with metrics (retries per second, retry success rate).

Write this down for the team. Apply it consistently. Retry policies that differ service-to-service make incident response hard.

### Principal Lens: Idempotency Is the Retry Prerequisite

Retries are safe only for idempotent operations. Retrying a non-idempotent operation (e.g., a POST that creates a resource) risks duplicate effects. The principal-level design invariant: mark every retryable operation as idempotent and enforce it (idempotency keys, conditional requests, unique constraint). Retrying without idempotency creates subtle duplicate-effect bugs that are hard to diagnose and often persist silently. When designing a new service, decide which operations are retryable at the API-design level, not the client-implementation level.

---
`;
