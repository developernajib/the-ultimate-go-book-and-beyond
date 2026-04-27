export default `## 14.8 Company Case Studies

### Google: Context in the Standard Library

Google designed the context package based on years of internal experience with request-scoped data propagation. The standard library now reflects those conventions: \`net/http\` attaches a context to every request, \`database/sql\` provides \`*Context\` variants of all query methods, and \`os/exec\` supports context-based process cancellation. The four guidelines below appear directly in the package documentation and are enforced by internal code review at Google.

\`\`\`go
// Google's context patterns in standard library

// net/http: Request context
func (r *Request) Context() context.Context
func (r *Request) WithContext(ctx context.Context) *Request

// database/sql: Context-aware queries
func (db *DB) QueryContext(ctx context.Context, query string, args ...any) (*Rows, error)
func (db *DB) ExecContext(ctx context.Context, query string, args ...any) (Result, error)

// os/exec: Command with context
func CommandContext(ctx context.Context, name string, arg ...string) *Cmd

// Google's guidelines:
// 1. Context should be first parameter
// 2. Don't store context in structs
// 3. Pass context explicitly to every function that needs it
// 4. Context values for request-scoped data only
\`\`\`

### Uber: Context for Microservices

Uber's architecture consists of thousands of microservices communicating over gRPC. Each request carries a \`ServiceContext\` that bundles trace IDs, tenant IDs, user identity, and permissions into a single struct propagated via gRPC metadata. On the receiving end, \`ExtractServiceContext\` reconstructs this struct from incoming metadata headers. On the sending end, \`InjectServiceContext\` serializes it back into outgoing metadata so the next hop inherits the same identity chain. Deadline propagation follows the same path, if the upstream service has 2 seconds remaining, the downstream service receives that constraint automatically.

\`\`\`go
// Uber's context propagation pattern
type ServiceContext struct {
    TraceID     string
    SpanID      string
    TenantID    string
    UserID      string
    Permissions []string
    Deadline    time.Time
}

// Extracted from incoming request
func ExtractServiceContext(ctx context.Context) (*ServiceContext, error) {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return nil, errors.New("no metadata")
    }

    sc := &ServiceContext{}

    if vals := md.Get("uber-trace-id"); len(vals) > 0 {
        sc.TraceID = vals[0]
    }

    if vals := md.Get("x-uber-tenant"); len(vals) > 0 {
        sc.TenantID = vals[0]
    }

    if deadline, ok := ctx.Deadline(); ok {
        sc.Deadline = deadline
    }

    return sc, nil
}

// Injected into outgoing request
func InjectServiceContext(ctx context.Context, sc *ServiceContext) context.Context {
    ctx = metadata.AppendToOutgoingContext(ctx,
        "uber-trace-id", sc.TraceID,
        "x-uber-tenant", sc.TenantID,
    )

    if !sc.Deadline.IsZero() {
        remaining := time.Until(sc.Deadline)
        if remaining > 0 {
            ctx, _ = context.WithTimeout(ctx, remaining)
        }
    }

    return ctx
}
\`\`\`

### Netflix: Context for Resilience

Netflix combines context with circuit breaker and bulkhead patterns to prevent cascading failures across its microservice fleet. A \`CircuitContext\` attached to the request context carries per-operation timeout budgets, retry limits, and an optional fallback function. When \`ExecuteWithCircuit\` detects an open circuit (too many recent failures to a downstream service), it returns the fallback result immediately without consuming any network resources. When the circuit is closed, the function enforces the timeout through \`context.WithTimeout\` and records success or failure to drive the circuit state machine.

\`\`\`go
// Netflix-style resilience with context
type CircuitContext struct {
    ServiceName    string
    OperationName  string
    TimeoutBudget  time.Duration
    RetryBudget    int
    FallbackFunc   func() (any, error)
}

func WithCircuit(ctx context.Context, cc CircuitContext) context.Context {
    return context.WithValue(ctx, circuitKey, cc)
}

func ExecuteWithCircuit(ctx context.Context, fn func() (any, error)) (any, error) {
    cc, ok := ctx.Value(circuitKey).(CircuitContext)
    if !ok {
        return fn()
    }

    // Check circuit state
    if circuit.IsOpen(cc.ServiceName) {
        if cc.FallbackFunc != nil {
            return cc.FallbackFunc()
        }
        return nil, ErrCircuitOpen
    }

    // Apply timeout
    ctx, cancel := context.WithTimeout(ctx, cc.TimeoutBudget)
    defer cancel()

    // Execute with retry
    var lastErr error
    for i := 0; i <= cc.RetryBudget; i++ {
        result, err := fn()
        if err == nil {
            circuit.RecordSuccess(cc.ServiceName)
            return result, nil
        }

        lastErr = err
        if ctx.Err() != nil {
            break
        }
    }

    circuit.RecordFailure(cc.ServiceName)
    return nil, lastErr
}
\`\`\`

### Stripe: Context for Request Tracing

Stripe threads a \`RequestContext\` through every layer of their payment processing stack. This struct carries the request ID, idempotency key, API version, and connected account identifier. The pattern extends beyond HTTP handlers: database queries are tagged with SQL comments containing the request ID so slow-query logs can be correlated back to the originating API call, and async jobs enqueued during a request carry the same metadata for end-to-end traceability through the worker pipeline.

\`\`\`go
// Stripe-style request correlation
type RequestContext struct {
    RequestID      string
    IdempotencyKey string
    APIVersion     string
    Livemode       bool
    ConnectAccount string
}

func WithRequestContext(ctx context.Context, rc RequestContext) context.Context {
    return context.WithValue(ctx, requestContextKey, rc)
}

// Automatic propagation to database queries
func (db *StripeDB) Query(ctx context.Context, query string, args ...any) (*Rows, error) {
    rc, _ := ctx.Value(requestContextKey).(RequestContext)

    // Add query metadata for tracing
    query = fmt.Sprintf("/* request_id=%s */ %s", rc.RequestID, query)

    return db.underlying.QueryContext(ctx, query, args...)
}

// Propagation to async workers
func (q *Queue) Enqueue(ctx context.Context, job Job) error {
    rc, _ := ctx.Value(requestContextKey).(RequestContext)

    // Attach context to job for correlation
    job.Metadata = map[string]string{
        "request_id":      rc.RequestID,
        "idempotency_key": rc.IdempotencyKey,
        "api_version":     rc.APIVersion,
    }

    return q.enqueue(job)
}
\`\`\`

### Staff Lens: Context Propagation Across Async Boundaries

The Stripe example above illustrates the key async-boundary pattern: when a request hands work off to a background queue, the context value (request ID, idempotency key) must be serialised into the job metadata so the worker can reconstruct it. The context itself does not cross process boundaries; the identifiers do. This is the correct pattern.

A common mistake: passing \`ctx\` into the job and expecting it to be useful in the worker. The cancellation signal does not serialise. Reconstruct what matters on the worker side (trace ID, user identity) and use a fresh context with its own deadline.

### Principal Lens: Your Context Conventions Are Your API

The request-context pattern a company adopts (what goes in, what comes out, how it flows through services) is part of its internal API surface. Changing it is expensive. Principal engineers at a growing company should pay attention to this early: the first request-context design will be copied by every team, and correcting it at year three costs ten times what correcting it at year one does. Spend the time to get it right.

---
`;
