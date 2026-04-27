export default `## 9.10 Company Case Studies

### Google's Error Handling Patterns

Google's Go Style Guide codifies the patterns their teams use across thousands of internal Go services. The recommendations below come directly from the public style guide and internal engineering posts.

**1. Add Context Progressively**

Each function in the call chain wraps the error from the layer below with its own operation name. The final error message reads like a breadcrumb trail from the outermost caller to the root cause.

\`\`\`go
// Each layer adds its own context
func (s *UserService) SaveUser(ctx context.Context, user User) error {
    if err := s.validate(user); err != nil {
        return fmt.Errorf("validate: %w", err)
    }
    if err := s.repo.Insert(ctx, user); err != nil {
        return fmt.Errorf("insert: %w", err)
    }
    return nil
}

// Result: "save user: insert: connection refused"
\`\`\`

**2. Error Messages Should Be Lowercase**

Error messages are often concatenated through wrapping, so capitalized or punctuated messages produce awkward output like \`"process: Failed to connect."\`. Lowercase, unpunctuated messages compose cleanly.

\`\`\`go
// Good
return errors.New("connection refused")

// Bad
return errors.New("Connection refused")  // Don't capitalize
return errors.New("Connection refused.") // Don't use period
\`\`\`

**3. Don't Start with "failed to"**

Since the error is already being handled in an error path, "failed to" is redundant. Name the operation directly.

\`\`\`go
// Good
return fmt.Errorf("connect to database: %w", err)

// Bad
return fmt.Errorf("failed to connect to database: %w", err)
\`\`\`

**4. Error Handling Order**

Check for the most specific known errors first (sentinel values, then typed errors), and fall through to generic handling last. This mirrors the specificity principle in pattern matching.

\`\`\`go
// Check specific known errors first
if errors.Is(err, context.Canceled) {
    return nil  // Expected cancellation
}
if errors.Is(err, context.DeadlineExceeded) {
    return fmt.Errorf("timeout: %w", err)
}

// Then check error types
var netErr net.Error
if errors.As(err, &netErr) && netErr.Timeout() {
    return retry(fn)
}
\`\`\`

### Uber's Error Handling Approach

Uber's Go Style Guide, maintained by their platform team, focuses on consistency across hundreds of microservices.

**1. Error Type Location**

Declare sentinel errors at the top of the file, grouped in a \`var\` block, so reviewers can see all error conditions a package defines at a glance.

\`\`\`go
// Declare errors at the top of the file
var (
    ErrBrokenLink  = errors.New("link is broken")
    ErrCouldNotOpen = errors.New("could not open")
)

// Or inline for one-time use
if err != nil {
    return errors.New("could not open")
}
\`\`\`

**2. Error Wrapping Guidelines**

Uber's guide draws a clear line between when wrapping adds value and when it adds noise. Wrap an error when you are adding context that the caller does not already have, the operation name, the input that caused the failure, or the fact that an API boundary was crossed. Do not wrap when the function has a single call site that makes the origin obvious, when you are returning a sentinel error that callers need to match with \`errors.Is\`, or when there is genuinely no extra context to contribute.

**3. Uber's Error Handling Library**

Uber created [github.com/uber-go/multierr](https://github.com/uber-go/multierr) for combining errors:

\`\`\`go
import "go.uber.org/multierr"

func validate(u User) error {
    var errs error

    if u.Name == "" {
        errs = multierr.Append(errs, errors.New("name required"))
    }
    if u.Email == "" {
        errs = multierr.Append(errs, errors.New("email required"))
    }

    return errs
}

// Check multiple errors
errs := validate(user)
for _, err := range multierr.Errors(errs) {
    fmt.Println(err)
}
\`\`\`

### Stripe's Error Handling for APIs

Stripe's API documentation is widely cited as a model for clear, machine-readable error responses. Their Go SDK follows the same structure internally.

**1. Typed API Errors**

Stripe categorizes every error response by type (\`card_error\`, \`invalid_request_error\`, etc.) so clients can programmatically branch on the error category rather than parsing message strings.

\`\`\`go
type APIError struct {
    Type       string \`json:"type"\`
    Code       string \`json:"code,omitempty"\`
    Message    string \`json:"message"\`
    Param      string \`json:"param,omitempty"\`
    StatusCode int    \`json:"-"\`
    RequestID  string \`json:"request_id,omitempty"\`
}

func (e *APIError) Error() string {
    return e.Message
}

// Error types following Stripe's conventions
const (
    ErrorTypeAPIError        = "api_error"
    ErrorTypeCardError       = "card_error"
    ErrorTypeIdempotencyError = "idempotency_error"
    ErrorTypeInvalidRequest  = "invalid_request_error"
    ErrorTypeRateLimit       = "rate_limit_error"
)
\`\`\`

**2. Rich Error Details**

A Stripe error response includes the error type, a machine-readable code, a human-readable message, and the parameter that triggered the error. This gives client SDKs enough information to retry, display a user message, or escalate without parsing free-text strings.

\`\`\`go
// Stripe-style error response
{
    "error": {
        "type": "card_error",
        "code": "card_declined",
        "message": "Your card was declined.",
        "param": "card_number",
        "decline_code": "insufficient_funds"
    }
}
\`\`\`

**3. Idempotency Error Handling**

Stripe's API supports idempotency keys to safely retry failed requests. When a request is replayed with a key that was already used for a different request body, Stripe returns an idempotency error. Modeling this as a distinct error type lets the client SDK surface it separately from card errors or rate limits.

\`\`\`go
type IdempotencyError struct {
    APIError
    IdempotencyKey string \`json:"idempotency_key"\`
}

func handleIdempotencyError(err *IdempotencyError) {
    // Log and alert - this shouldn't happen in production
    log.Printf("Idempotency error for key %s: %v",
        err.IdempotencyKey, err.Message)
}
\`\`\`

### Netflix's Resilience Patterns

Netflix uses Go for internal tooling and infrastructure services where resilience under partial failure is a hard requirement.

**1. Circuit Breaker with Error Classification**

A circuit breaker opens after too many consecutive failures, preventing cascading load on a degraded service. Error classification determines which failures count toward the threshold, transient network errors should trip the breaker, while client-side validation errors should not.

\`\`\`go
type ErrorClassifier func(error) bool

func IsRetryable(err error) bool {
    if err == nil {
        return false
    }

    // Network errors are usually retryable
    var netErr net.Error
    if errors.As(err, &netErr) {
        return netErr.Timeout() || netErr.Temporary()
    }

    // Context errors
    if errors.Is(err, context.DeadlineExceeded) {
        return true
    }

    // Rate limiting
    var appErr *AppError
    if errors.As(err, &appErr) {
        return appErr.Code.IsRetryable()
    }

    return false
}
\`\`\`

**2. Error Budgeting**

Error budgets track the ratio of failed requests to total requests over a sliding time window. When the error rate exceeds a threshold (e.g., 1% over 5 minutes), the system can trigger automated responses such as rolling back a deployment or shedding non-critical traffic.

\`\`\`go
type ErrorBudget struct {
    mu          sync.Mutex
    window      time.Duration
    threshold   float64
    errors      []time.Time
    total       []time.Time
}

func (eb *ErrorBudget) Record(err error) {
    eb.mu.Lock()
    defer eb.mu.Unlock()

    now := time.Now()
    eb.total = append(eb.total, now)
    if err != nil {
        eb.errors = append(eb.errors, now)
    }

    eb.cleanup(now)
}

func (eb *ErrorBudget) ErrorRate() float64 {
    eb.mu.Lock()
    defer eb.mu.Unlock()

    eb.cleanup(time.Now())

    if len(eb.total) == 0 {
        return 0
    }
    return float64(len(eb.errors)) / float64(len(eb.total))
}

func (eb *ErrorBudget) BudgetExceeded() bool {
    return eb.ErrorRate() > eb.threshold
}
\`\`\`

### The Common Pattern

Every case study in this section shares a shape: typed errors with structured fields, consistent wrapping, explicit error codes, and observability integration. The teams that succeed at production Go operate this way. The teams that do not accumulate error-handling debt.

---
`;
