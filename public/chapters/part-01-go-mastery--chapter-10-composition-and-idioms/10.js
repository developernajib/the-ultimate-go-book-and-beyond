export default `## 10.9 Company Case Studies

The patterns from this chapter are not academic exercises. Large-scale Go codebases at major companies converge on the same idioms because they solve real maintenance and reliability problems.

### Google: Interface-Based Design

Google's internal Go style guide centers on a single principle: accept interfaces, return structs. Functions declare their dependencies as the narrowest possible interface, making them testable and reusable across contexts. Concrete return types give callers full access to the type's methods without requiring a type assertion:

\`\`\`go
// Google's approach: accept interfaces, return structs
type Logger interface {
    Log(ctx context.Context, msg string, args ...any)
}

type Service struct {
    logger Logger
    // ...
}

func NewService(logger Logger) *Service {
    return &Service{logger: logger}
}

// Functions accept minimal interfaces
func ProcessData(r io.Reader) error {
    // Accepts any io.Reader: file, network, buffer, etc.
}

// Returns concrete types
func NewReader(path string) (*FileReader, error) {
    // ...
}
\`\`\`

### Uber: Error Handling and Configuration

Uber's Go ecosystem libraries demonstrate two patterns from this chapter: functional options for configuration (seen in \`zap\`) and error accumulation for validation (seen in \`multierr\`). Both avoid forcing callers into rigid APIs:

\`\`\`go
// From uber-go/zap
logger, err := zap.NewProduction(
    zap.AddCaller(),
    zap.AddStacktrace(zap.ErrorLevel),
    zap.Fields(
        zap.String("service", "api"),
        zap.String("version", "1.0.0"),
    ),
)

// Uber's multierr for combining errors
import "go.uber.org/multierr"

func validateUser(u *User) error {
    var errs error

    if u.Name == "" {
        errs = multierr.Append(errs, errors.New("name required"))
    }
    if u.Email == "" {
        errs = multierr.Append(errs, errors.New("email required"))
    }

    return errs
}
\`\`\`

### Stripe: API Design

Stripe's Go SDK uses typed parameter structs for required fields, functional options for client configuration, and the iterator pattern for paginated results. The result is an API where correct usage is obvious from the types alone:

\`\`\`go
// Clear, type-safe API
params := &stripe.CustomerParams{
    Email: stripe.String("customer@example.com"),
    Name:  stripe.String("John Doe"),
}
customer, err := customer.New(params)

// Functional options for optional configuration
client := stripe.NewClient(
    stripe.WithAPIKey(apiKey),
    stripe.WithHTTPClient(httpClient),
    stripe.WithRetries(3),
)

// Idiomatic iterator pattern
params := &stripe.CustomerListParams{}
params.Filters.AddFilter("created", "gt", "1234567890")

iter := customer.List(params)
for iter.Next() {
    c := iter.Customer()
    // Process customer
}
if err := iter.Err(); err != nil {
    // Handle error
}
\`\`\`

### Netflix: Resilience Patterns

Netflix's Go services use composition to layer resilience around business logic. A circuit breaker tracks failure counts and stops calling a failing dependency once a threshold is reached. A bulkhead limits concurrency with a buffered channel used as a semaphore, preventing one slow service from exhausting all available goroutines:

\`\`\`go
// Circuit breaker pattern
type CircuitBreaker struct {
    mu            sync.Mutex
    failures      int
    lastFailure   time.Time
    state         State
    threshold     int
    resetTimeout  time.Duration
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    if !cb.canExecute() {
        return ErrCircuitOpen
    }

    err := fn()
    cb.recordResult(err)
    return err
}

// Bulkhead pattern - limit concurrent executions
type Bulkhead struct {
    sem chan struct{}
}

func NewBulkhead(maxConcurrent int) *Bulkhead {
    return &Bulkhead{sem: make(chan struct{}, maxConcurrent)}
}

func (b *Bulkhead) Execute(ctx context.Context, fn func() error) error {
    select {
    case b.sem <- struct{}{}:
        defer func() { <-b.sem }()
        return fn()
    case <-ctx.Done():
        return ctx.Err()
    }
}
\`\`\`

### Pattern Extraction

Each case study shows a composable pattern that the team applied at scale. The lesson for a senior engineer is not the specific patterns but the process: identify recurring shapes, extract them to shared packages, document the conventions. The team that does this compounds its patterns. The team that does not re-solves the same problems in each service.

### Cloudflare: Edge-Local Decision-Making

Cloudflare's Go services run on hundreds of edge locations. The shared idioms are shaped by this constraint. Configuration is pushed to edges rather than fetched (avoiding round trips per request). Resilience primitives (rate limiters, circuit breakers) are local to the edge, not centralised. The composition pattern that matters most here is the per-request middleware chain that can be reconfigured from a central control plane without restarting processes. The Go idiom is a middleware chain where each middleware takes its configuration from an atomically-swappable pointer, so a config push updates behaviour without lock contention.

\`\`\`go
type Config struct { RateLimit int }

var cfg atomic.Pointer[Config]

func RateLimitMW(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        c := cfg.Load() // lock-free per request
        _ = c.RateLimit
        next.ServeHTTP(w, r)
    })
}
\`\`\`

The generalisation: when a middleware needs configuration that changes at runtime, \`atomic.Pointer[Config]\` is the canonical shape. Passing a mutable \`*Config\` and locking per request does not scale to edge traffic volumes.

### Staff Lens: Read the Case Studies Against Your Context

Each of these patterns solves a specific problem. Applied out of context, they become cargo cult. Stripe's typed parameter structs make sense for a public SDK where callers are untrusted. They are overkill for internal service-to-service calls where the caller is a sibling microservice. Netflix's circuit breakers are critical on a service mesh with hundreds of downstream dependencies. They are overkill for a self-contained batch job. The staff-track exercise: for each pattern in the case studies, articulate the problem it solves, the context that made it necessary, and whether your team faces the same problem. If you face the same problem, adopt the pattern. If you do not, adopting it is overhead without benefit.

### Principal Lens: The Pattern Library

A Go org at scale accumulates an internal pattern library: shared middleware, shared resilience primitives, shared option types, shared logger adapters, shared test helpers. The principal-level decision is which patterns live in a shared platform package versus which patterns each team re-implements. The rule of thumb: a pattern gets extracted to the platform when three teams have independently implemented it, the variance between implementations is below a threshold, and the platform team is willing to own it for five years. Below that bar, premature extraction creates a shared dependency that fragments the moment one team's needs diverge. Most pattern libraries fail because they extracted too aggressively. The principal move is patience. Let the pattern be rewritten three times before you extract it. By then, you know what varies and what does not.

---
`;
