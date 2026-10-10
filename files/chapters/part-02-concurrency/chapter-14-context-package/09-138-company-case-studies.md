## 14.8 Company Case Studies

As in the previous chapter, the first case study is drawn from code you can read yourself. The rest are composite patterns named for the problem they solve rather than attributed to a company whose private source you cannot check. The reasoning is what transfers.

Read the last three critically. Each contains a real defect, left in deliberately and dissected afterwards, because "this is how a big company does it" is exactly the sentence that stops engineers from noticing that code is wrong.

### The Standard Library: Context Conventions

The context package grew out of hard-won experience with request-scoped propagation, and the standard library now reflects those conventions everywhere: `net/http` attaches a context to every request, `database/sql` provides `*Context` variants of every query method, and `os/exec` supports context-based process cancellation. The four guidelines below come straight from the package documentation.

```go
// Context conventions across the standard library

// net/http: Request context
func (r *Request) Context() context.Context
func (r *Request) WithContext(ctx context.Context) *Request

// database/sql: Context-aware queries
func (db *DB) QueryContext(ctx context.Context, query string, args ...any) (*Rows, error)
func (db *DB) ExecContext(ctx context.Context, query string, args ...any) (Result, error)

// os/exec: Command with context
func CommandContext(ctx context.Context, name string, arg ...string) *Cmd

// The documented guidelines:
// 1. Context should be first parameter
// 2. Don't store context in structs
// 3. Pass context explicitly to every function that needs it
// 4. Context values for request-scoped data only
```

### Pattern: Context Propagation Across Microservices

In a fleet of services communicating over gRPC, each request carries a `ServiceContext` bundling trace IDs, tenant IDs, user identity, and permissions into a single struct propagated via metadata. `ExtractServiceContext` reconstructs the struct from incoming metadata on the receiving end. `InjectServiceContext` serializes it back into outgoing metadata so the next hop inherits the same identity chain.

Bundling several values into one struct behind one context key is a deliberate choice worth noting: `Value` lookup walks a linked list, so one key holding five fields is one hop instead of five, and the values stay consistent with each other by construction.

`InjectServiceContext` below has a bug. Find it before reading on.

```go
// Context propagation across service boundaries
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

    if vals := md.Get("trace-id"); len(vals) > 0 {
        sc.TraceID = vals[0]
    }

    if vals := md.Get("x-tenant"); len(vals) > 0 {
        sc.TenantID = vals[0]
    }

    if deadline, ok := ctx.Deadline(); ok {
        sc.Deadline = deadline
    }

    return sc, nil
}

// BROKEN: Injected into outgoing request
func InjectServiceContext(ctx context.Context, sc *ServiceContext) context.Context {
    ctx = metadata.AppendToOutgoingContext(ctx,
        "trace-id", sc.TraceID,
        "x-tenant", sc.TenantID,
    )

    if !sc.Deadline.IsZero() {
        remaining := time.Until(sc.Deadline)
        if remaining > 0 {
            ctx, _ = context.WithTimeout(ctx, remaining) // cancel discarded!
        }
    }

    return ctx
}
```

**The bug is `ctx, _ = context.WithTimeout(ctx, remaining)`.** The cancel function is thrown away, so the timer stays armed until `remaining` elapses and the derived context stays linked to its parent the whole time. Called once per outgoing RPC, this leaks a timer and a context node per call. `go vet` reports it without being asked:

```
the cancel function returned by context.WithTimeout should be called,
not discarded, to avoid a context leak
```

Notice this is not a slip that a more careful author would have avoided. It is forced by the function's signature. `InjectServiceContext` returns only a `context.Context`, so there is nowhere to put the `CancelFunc`, and `defer cancel()` inside would cancel the context before the caller ever used it. **A function that derives a cancellable context must return its cancel function.** The signature is the bug:

```go
// Correct: hand the cancel back to the caller, who owns it.
func InjectServiceContext(ctx context.Context, sc *ServiceContext) (context.Context, context.CancelFunc) {
    ctx = metadata.AppendToOutgoingContext(ctx,
        "trace-id", sc.TraceID,
        "x-tenant", sc.TenantID,
    )

    if !sc.Deadline.IsZero() {
        if remaining := time.Until(sc.Deadline); remaining > 0 {
            return context.WithTimeout(ctx, remaining)
        }
    }

    // No deadline to apply: return a no-op cancel so callers can always
    // write `defer cancel()` without a nil check.
    return ctx, func() {}
}

// Caller:
ctx, cancel := InjectServiceContext(ctx, sc)
defer cancel()
```

Returning a no-op `func() {}` on the non-deadline path matters more than it looks. The alternative, returning `nil`, forces every caller to write `if cancel != nil`, and the first caller who forgets gets a nil-pointer panic. Make the contract uniform: the caller always calls `cancel`, always.

There is also a subtlety about re-applying the deadline at all. gRPC already propagates deadlines automatically via `grpc-timeout`, so `sc.Deadline` is usually redundant with what `ctx` already carries. Since `WithTimeout` can only shorten, re-applying it is harmless but pointless. Carrying a deadline as a *value* alongside the context's real deadline gives you two sources of truth, and they diverge the moment anyone derives a shorter child. Prefer `ctx.Deadline()`.

### Pattern: Context With Circuit Breaking

Combining context with circuit breaker and bulkhead patterns prevents cascading failures. A `CircuitContext` carries per-operation timeout budgets, retry limits, and an optional fallback. When the circuit is open (too many recent failures to a downstream service), the call returns the fallback immediately without touching the network. When closed, it enforces the timeout and records the outcome to drive the state machine.

This one has a subtler bug than the last. It is in the type signature again.

```go
// BROKEN: the timeout context is created and never used.
type CircuitContext struct {
    ServiceName   string
    OperationName string
    TimeoutBudget time.Duration
    RetryBudget   int
    FallbackFunc  func() (any, error)
}

func ExecuteWithCircuit(ctx context.Context, fn func() (any, error)) (any, error) {
    cc, ok := ctx.Value(circuitKey).(CircuitContext)
    if !ok {
        return fn()
    }

    if circuit.IsOpen(cc.ServiceName) {
        if cc.FallbackFunc != nil {
            return cc.FallbackFunc()
        }
        return nil, ErrCircuitOpen
    }

    ctx, cancel := context.WithTimeout(ctx, cc.TimeoutBudget)
    defer cancel()

    var lastErr error
    for i := 0; i <= cc.RetryBudget; i++ {
        result, err := fn() // fn takes NO ctx. The timeout does nothing.
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
```

**`fn` is a `func() (any, error)`. It takes no context.** So `ctx, cancel := context.WithTimeout(ctx, cc.TimeoutBudget)` builds a deadline and wires it to nothing. `fn` never sees it and cannot be cancelled by it. `TimeoutBudget` looks enforced, is documented as enforced, and is not enforced. The only thing the deadline does is get checked *between* retries, so a single `fn` call that hangs forever hangs `ExecuteWithCircuit` forever, no matter what `TimeoutBudget` says.

This is the same failure as calling `http.Get` inside a carefully deadline-bounded function. A context that is not passed to the thing doing the work is decoration.

```go
// Correct: fn accepts the context, so the deadline actually binds.
func ExecuteWithCircuit(ctx context.Context, fn func(context.Context) (any, error)) (any, error) {
    cc, ok := ctx.Value(circuitKey).(CircuitContext)
    if !ok {
        return fn(ctx)
    }

    if circuit.IsOpen(cc.ServiceName) {
        if cc.FallbackFunc != nil {
            return cc.FallbackFunc()
        }
        return nil, ErrCircuitOpen
    }

    ctx, cancel := context.WithTimeout(ctx, cc.TimeoutBudget)
    defer cancel()

    var lastErr error
    for attempt := 0; attempt <= cc.RetryBudget; attempt++ {
        // Stop before burning a retry on an already-dead context.
        if err := ctx.Err(); err != nil {
            if lastErr == nil {
                lastErr = err
            }
            break
        }

        result, err := fn(ctx) // ctx reaches the work
        if err == nil {
            circuit.RecordSuccess(cc.ServiceName)
            return result, nil
        }
        lastErr = err

        // A canceled/expired context is not a downstream failure, and
        // retrying it immediately just burns the remaining budget.
        if ctx.Err() != nil {
            break
        }

        // Back off before retrying, respecting the deadline.
        if attempt < cc.RetryBudget {
            backoff := time.Duration(1<<attempt) * 50 * time.Millisecond
            timer := time.NewTimer(backoff)
            select {
            case <-timer.C:
            case <-ctx.Done():
                timer.Stop()
                return nil, lastErr
            }
        }
    }

    circuit.RecordFailure(cc.ServiceName)
    if cc.FallbackFunc != nil {
        return cc.FallbackFunc()
    }
    return nil, lastErr
}
```

Three further changes worth noting. The retry loop now **backs off** instead of hammering a struggling dependency as fast as the CPU allows, which is how a slow downstream becomes a dead one. It **sleeps via `select` on `ctx.Done()`** rather than `time.Sleep`, so a cancellation during the backoff is honored instantly instead of after the full delay. And it consults the fallback on final failure, not only when the circuit is already open, since the whole point of a fallback is to have an answer when the dependency does not.

One design question left open deliberately: `RecordFailure` fires once per `ExecuteWithCircuit` call, not once per attempt. Both are defensible. Per-call means the circuit counts "operations that failed". Per-attempt means it counts "requests the downstream dropped" and trips roughly `RetryBudget` times faster. Pick one on purpose and write it down, because the difference decides how quickly your circuit opens under load.

### Pattern: Request Correlation Through Every Layer

A `RequestContext` threaded through a payment stack carries the request ID, idempotency key, API version, and connected account. The pattern extends past HTTP handlers: database queries are tagged with SQL comments containing the request ID so slow-query logs correlate back to the originating API call, and async jobs enqueued during a request carry the same metadata for end-to-end traceability.

The idea is genuinely good. The implementation below has a vulnerability. Look at the `Query` method before reading on.

```go
// Request correlation
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

// VULNERABLE: SQL injection via the request ID
func (db *TracedDB) Query(ctx context.Context, query string, args ...any) (*Rows, error) {
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
```

**`rc.RequestID` is concatenated straight into SQL.** Where does it come from? The `RequestIDMiddleware` from section 14.5: `r.Header.Get("X-Request-ID")`, used verbatim when present. That is an attacker-controlled string being interpolated into a query.

The `/* ... */` comment wrapper is not a defense. `*/` closes it:

```
attacker sets X-Request-ID to break out of the comment:
  /* request_id=x */ UNION SELECT card_number, cvv FROM cards; DROP TABLE audit_log; --  */ SELECT * FROM charges WHERE id = $1
```

Every parameterized query in the codebase is irrelevant, because the injection is not in the parameters. It is in the query text, added by the tracing layer that exists to be helpful. This is worth sitting with: the vulnerability was introduced by an observability feature, in a wrapper nobody thinks of as security-sensitive, on a value everyone assumes is internal.

Two fixes, and you want both:

```go
var safeRequestID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (db *TracedDB) Query(ctx context.Context, query string, args ...any) (*Rows, error) {
    rc, _ := ctx.Value(requestContextKey).(RequestContext)

    // Only ever embed an ID that cannot escape the comment.
    if safeRequestID.MatchString(rc.RequestID) {
        query = fmt.Sprintf("/* request_id=%s */ %s", rc.RequestID, query)
    }

    return db.underlying.QueryContext(ctx, query, args...)
}
```

**Allowlist the shape at the point of interpolation.** Not a blocklist of `*/`, an allowlist of what is permitted: alphanumerics, dash, underscore, bounded length. A blocklist invites you to enumerate every escape, while an allowlist makes the safe set explicit. If the ID does not match, drop the comment rather than the query, since tracing is a nice-to-have and executing attacker SQL is not.

**Fix it at the source too.** The middleware should not accept an arbitrary client header as its request ID in the first place. Validate it on entry, or generate your own ID and treat the client's value as a separate, clearly-untrusted correlation hint:

```go
requestID := r.Header.Get("X-Request-ID")
if !safeRequestID.MatchString(requestID) {
    requestID = uuid.New().String() // don't trust it, replace it
}
```

The general principle: **a value's trust level travels with it, and context values are excellent at hiding where a value came from.** Once `rc.RequestID` is in a context, it looks exactly like an internally-generated ID. The layer that interpolates it into SQL is nowhere near the layer that read it from an HTTP header, and no reviewer of either file sees both halves. That distance is precisely what makes context-carried values worth validating at the boundary, before they enter the context at all.

### Staff Lens: Context Propagation Across Async Boundaries

The `Enqueue` example above illustrates the key async-boundary pattern: when a request hands work off to a background queue, the context values (request ID, idempotency key) must be serialized into the job metadata so the worker can reconstruct them. The context itself does not cross process boundaries. The identifiers do. This is the correct pattern.

A common mistake: passing `ctx` into the job and expecting it to be useful in the worker. The cancellation signal does not serialize. Reconstruct what matters on the worker side (trace ID, user identity) and use a fresh context with its own deadline.

### Principal Lens: Your Context Conventions Are Your API

The request-context pattern a company adopts (what goes in, what comes out, how it flows through services) is part of its internal API surface. Changing it is expensive. Principal engineers at a growing company should pay attention to this early: the first request-context design will be copied by every team, and correcting it at year three costs ten times what correcting it at year one does. Spend the time to get it right.

---
