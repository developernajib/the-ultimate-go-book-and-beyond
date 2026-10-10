## 14.12 Exercises with Solutions

### Exercise 1: Timeout Budget Manager

Implement a timeout budget manager that tracks remaining time across operations. The budget should allocate time slices to sub-operations, record how long each step actually took, and report the remaining balance.

**Solution:**

The `Budget` type maintains a running total of remaining time and records each step's actual duration. `ExecuteWithBudget` wraps any operation with a child context whose timeout is the minimum of the requested duration and the remaining budget, then records the elapsed time after the operation completes. This prevents any single step from consuming more time than the overall budget allows.

```go
package budget

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type Budget struct {
    mu        sync.Mutex
    remaining time.Duration
    steps     []StepRecord
}

type StepRecord struct {
    Name     string
    Duration time.Duration
    Error    error
}

type budgetKey struct{}

func NewBudget(total time.Duration) *Budget {
    return &Budget{
        remaining: total,
        steps:     make([]StepRecord, 0),
    }
}

func WithBudget(ctx context.Context, budget *Budget) context.Context {
    return context.WithValue(ctx, budgetKey{}, budget)
}

func GetBudget(ctx context.Context) (*Budget, bool) {
    budget, ok := ctx.Value(budgetKey{}).(*Budget)
    return budget, ok
}

func (b *Budget) Allocate(name string, max time.Duration) (time.Duration, error) {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.remaining <= 0 {
        return 0, fmt.Errorf("budget exhausted")
    }

    allocated := max
    if allocated > b.remaining {
        allocated = b.remaining
    }

    return allocated, nil
}

func (b *Budget) Record(name string, duration time.Duration, err error) {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.remaining -= duration
    b.steps = append(b.steps, StepRecord{
        Name:     name,
        Duration: duration,
        Error:    err,
    })
}

func (b *Budget) Remaining() time.Duration {
    b.mu.Lock()
    defer b.mu.Unlock()
    return b.remaining
}

func (b *Budget) Summary() []StepRecord {
    b.mu.Lock()
    defer b.mu.Unlock()
    result := make([]StepRecord, len(b.steps))
    copy(result, b.steps)
    return result
}

// ExecuteWithBudget runs a step with budget tracking
func ExecuteWithBudget(ctx context.Context, name string, maxDuration time.Duration, fn func(context.Context) error) error {
    budget, hasBudget := GetBudget(ctx)

    var allocated time.Duration
    if hasBudget {
        var err error
        allocated, err = budget.Allocate(name, maxDuration)
        if err != nil {
            return fmt.Errorf("%s: %w", name, err)
        }
    } else {
        allocated = maxDuration
    }

    stepCtx, cancel := context.WithTimeout(ctx, allocated)
    defer cancel()

    start := time.Now()
    err := fn(stepCtx)
    duration := time.Since(start)

    if hasBudget {
        budget.Record(name, duration, err)
    }

    return err
}

// Usage
func ProcessRequest(ctx context.Context) error {
    budget := NewBudget(30 * time.Second)
    ctx = WithBudget(ctx, budget)

    // Step 1: Auth (max 2s)
    if err := ExecuteWithBudget(ctx, "auth", 2*time.Second, authenticate); err != nil {
        return err
    }

    // Step 2: Database (max 5s)
    if err := ExecuteWithBudget(ctx, "database", 5*time.Second, queryDB); err != nil {
        return err
    }

    // Step 3: External API (max 10s)
    if err := ExecuteWithBudget(ctx, "external", 10*time.Second, callAPI); err != nil {
        return err
    }

    // Print summary
    for _, step := range budget.Summary() {
        fmt.Printf("%s: %v (error: %v)\n", step.Name, step.Duration, step.Error)
    }
    fmt.Printf("Remaining budget: %v\n", budget.Remaining())

    return nil
}
```

### Exercise 2: Context-Aware Worker Pool

Implement a worker pool that properly handles context cancellation. Workers should stop accepting new tasks when the context is canceled, drain any remaining tasks with a bounded cleanup timeout, and report results through a channel.

**Solution:**

This exercise is mostly a trap about channel ownership. The obvious design has `Stop` close the task channel and `Submit` do a non-blocking send, and it is broken in three separate ways. Work through them before reading the code.

**`Submit` racing `Stop` panics.** If `Stop` does `close(p.tasks)` while any goroutine may still call `Submit`, the send panics with "send on closed channel". A `select` with a `default` does **not** protect you: `default` only fires when the send would *block*, and a send to a closed channel does not block, it panics. Measured over 500 trials of a submitter racing a closer:

```
Submit racing Stop over 500 trials: 498 panicked (send on closed channel), 2 survived
```

Not a rare race. Effectively guaranteed. The rule it violates is the fundamental one: **only the sender may close a channel, and only when no other sender exists.** `Stop` is not the sender. `Submit` is.

**The drain loop hangs.** `for task := range p.tasks` blocks until the channel is closed. A worker that reaches it on `ctx.Done()` sits there forever unless someone also calls `Stop`. Cancel the context without stopping the pool and every worker leaks.

**The unguarded `p.results <- task(cleanupCtx)` hangs.** If nobody is draining `Results()`, this blocks forever, the worker never returns, and `Stop`'s `wg.Wait()` never returns either.

The fix for all three is to stop closing the task channel at all. Signal shutdown with a dedicated `quit` channel, which only `Stop` owns and only `Stop` closes:

```go
package worker

import (
    "context"
    "sync"
    "time"
)

type Task func(ctx context.Context) error

type Pool struct {
    workers int
    tasks   chan Task
    results chan error
    quit    chan struct{} // closed by Stop; the ONLY thing Stop closes
    once    sync.Once     // makes Stop idempotent (double close panics)
    wg      sync.WaitGroup
}

func NewPool(workers int, queueSize int) *Pool {
    return &Pool{
        workers: workers,
        tasks:   make(chan Task, queueSize),
        results: make(chan error, queueSize),
        quit:    make(chan struct{}),
    }
}

func (p *Pool) Start(ctx context.Context) {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.worker(ctx, i)
    }
}

func (p *Pool) worker(ctx context.Context, id int) {
    defer p.wg.Done()

    for {
        select {
        case <-ctx.Done():
            p.drain()
            return
        case <-p.quit:
            p.drain()
            return
        case task := <-p.tasks:
            p.send(task(ctx))
        }
    }
}

// drain runs whatever is already queued, with a bounded cleanup context.
// Non-blocking receive, not `range`: p.tasks is never closed, so ranging
// over it would block forever.
func (p *Pool) drain() {
    for {
        select {
        case task := <-p.tasks:
            // WithoutCancel would need a ctx - drain is called after ctx is
            // dead, so a fresh bounded context is right here.
            cleanupCtx, cancel := context.WithTimeout(
                context.Background(), 5*time.Second)
            p.send(task(cleanupCtx))
            cancel()
        default:
            return
        }
    }
}

// send never blocks. If nobody is draining Results(), a blocking send here
// would wedge the worker and deadlock Stop's wg.Wait().
// The trade-off is explicit: results are dropped rather than the pool hanging.
// Callers who need every result must drain Results() concurrently.
func (p *Pool) send(err error) {
    select {
    case p.results <- err:
    default: // results buffer full: drop
    }
}

// Submit never panics: p.tasks is never closed by anyone.
func (p *Pool) Submit(task Task) bool {
    select {
    case <-p.quit:
        return false // pool is shutting down
    default:
    }

    select {
    case p.tasks <- task:
        return true
    default:
        return false // queue full
    }
}

func (p *Pool) Results() <-chan error {
    return p.results
}

// Stop is idempotent and safe to call concurrently with Submit.
//
// Note that the ENTIRE body is inside once.Do, not just close(p.quit).
// Leaving close(p.results) outside would double-close on a second Stop.
// sync.Once also blocks concurrent callers until f returns, so every
// Stop caller correctly waits for the drain to finish.
func (p *Pool) Stop() {
    p.once.Do(func() {
        close(p.quit)
        p.wg.Wait()
        close(p.results) // safe: every sender (worker) has now exited
    })
}

// Usage
func Example() {
    ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
    defer cancel()

    pool := NewPool(4, 100)
    pool.Start(ctx)

    // Submit tasks
    for i := 0; i < 10; i++ {
        i := i
        pool.Submit(func(ctx context.Context) error {
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(100 * time.Millisecond):
                fmt.Printf("Task %d completed\n", i)
                return nil
            }
        })
    }

    // Collect results
    go func() {
        for err := range pool.Results() {
            if err != nil {
                fmt.Printf("Task error: %v\n", err)
            }
        }
    }()

    // Wait for completion or timeout
    <-ctx.Done()
    pool.Stop()
}
```

### Exercise 3: Distributed Trace Propagation

Implement trace context propagation across HTTP boundaries. The solution should parse incoming W3C `Traceparent` headers, create child spans for each hop, and inject trace headers into outgoing HTTP requests automatically.

**Solution:**

The `TraceMiddleware` parses the incoming `Traceparent` header, creates a child span (or a new root trace if none exists), and stores it in the request context. On the client side, `TracingTransport` implements `http.RoundTripper` to inject the trace header into every outgoing request, so downstream services receive the parent span ID without manual intervention at each call site.

Two rules govern this code, and both are easy to violate:

**A `RoundTripper` must not modify the request it is given.** The interface documentation is explicit: "RoundTrip should not modify the request, except for consuming and closing the Request's Body." The request belongs to the caller, and `net/http` may reuse it across a redirect or retry. Setting a header directly on `r` is a contract violation that produces intermittent, maddening bugs. `r.Clone(r.Context())` is the fix, and it is cheap relative to the network call that follows.

**A `traceparent` header is attacker-controlled input.** `ParseTraceContext` below takes whatever arrives and, on a parse failure, correctly falls back to a fresh trace. But it does not validate the *shape* of what it accepted, and the parsed `TraceID` flows into logs, into outgoing headers, and potentially into a query comment (see section 14.8). Validate it, as shown after the code.

```go
package trace

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "net/http"
    "strconv"
    "strings"
)

const (
    TraceparentHeader = "Traceparent"
    TracestateHeader  = "Tracestate"
)

type TraceContext struct {
    Version    string
    TraceID    string
    ParentID   string
    TraceFlags byte
    Tracestate map[string]string
}

type traceKey struct{}

func WithTraceContext(ctx context.Context, tc *TraceContext) context.Context {
    return context.WithValue(ctx, traceKey{}, tc)
}

func GetTraceContext(ctx context.Context) (*TraceContext, bool) {
    tc, ok := ctx.Value(traceKey{}).(*TraceContext)
    return tc, ok
}

func NewTraceContext() *TraceContext {
    return &TraceContext{
        Version:    "00",
        TraceID:    randomHex(16),
        ParentID:   randomHex(8),
        TraceFlags: 0x01, // Sampled
        Tracestate: make(map[string]string),
    }
}

func (tc *TraceContext) NewChild() *TraceContext {
    return &TraceContext{
        Version:    tc.Version,
        TraceID:    tc.TraceID,
        ParentID:   randomHex(8),
        TraceFlags: tc.TraceFlags,
        Tracestate: copyMap(tc.Tracestate),
    }
}

func (tc *TraceContext) ToHeader() string {
    return fmt.Sprintf("%s-%s-%s-%02x",
        tc.Version, tc.TraceID, tc.ParentID, tc.TraceFlags)
}

// ParseTraceContext parses a W3C traceparent header.
//
// The header is attacker-controlled: validate strictly and reject anything
// that is not exactly the expected shape. Whatever this returns ends up in
// logs, in outgoing headers, and in downstream systems.
func ParseTraceContext(header string) (*TraceContext, error) {
    parts := strings.Split(header, "-")
    if len(parts) != 4 {
        return nil, fmt.Errorf("invalid traceparent: want 4 fields, got %d", len(parts))
    }

    // Per W3C: version is 2 hex, trace-id 32 hex, parent-id 16 hex,
    // flags 2 hex. All-zero trace-id and parent-id are invalid.
    if !isHex(parts[0], 2) || !isHex(parts[1], 32) ||
        !isHex(parts[2], 16) || !isHex(parts[3], 2) {
        return nil, fmt.Errorf("invalid traceparent: malformed fields")
    }
    if parts[1] == strings.Repeat("0", 32) || parts[2] == strings.Repeat("0", 16) {
        return nil, fmt.Errorf("invalid traceparent: all-zero id")
    }

    flags, err := strconv.ParseUint(parts[3], 16, 8)
    if err != nil {
        return nil, fmt.Errorf("invalid traceparent: bad flags")
    }

    return &TraceContext{
        Version:    parts[0],
        TraceID:    parts[1],
        ParentID:   parts[2],
        TraceFlags: byte(flags),
        Tracestate: make(map[string]string),
    }, nil
}

// isHex reports whether s is exactly n lowercase hex digits.
func isHex(s string, n int) bool {
    if len(s) != n {
        return false
    }
    for _, c := range s {
        if !('0' <= c && c <= '9') && !('a' <= c && c <= 'f') {
            return false
        }
    }
    return true
}

// HTTP Middleware
func TraceMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        var tc *TraceContext

        if header := r.Header.Get(TraceparentHeader); header != "" {
            var err error
            tc, err = ParseTraceContext(header)
            if err != nil {
                tc = NewTraceContext()
            } else {
                tc = tc.NewChild() // Create child span
            }
        } else {
            tc = NewTraceContext()
        }

        // Add trace to context
        ctx := WithTraceContext(r.Context(), tc)

        // Set response headers
        w.Header().Set(TraceparentHeader, tc.ToHeader())

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// HTTP Client with trace propagation
type TracingTransport struct {
    Base http.RoundTripper
}

func (t *TracingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
    base := t.Base
    if base == nil {
        base = http.DefaultTransport
    }

    tc, ok := GetTraceContext(r.Context())
    if !ok {
        return base.RoundTrip(r)
    }

    // MUST NOT mutate r. The http.RoundTripper contract states:
    // "RoundTrip should not modify the request, except for consuming and
    // closing the Request's Body." net/http may retry a request, and the
    // caller still owns it. Clone, then modify the clone.
    r2 := r.Clone(r.Context())
    child := tc.NewChild()
    r2.Header.Set(TraceparentHeader, child.ToHeader())

    return base.RoundTrip(r2)
}

func NewTracingClient() *http.Client {
    return &http.Client{
        Transport: &TracingTransport{},
    }
}

func randomHex(bytes int) string {
    b := make([]byte, bytes)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func copyMap(src map[string]string) map[string]string {
    dst := make(map[string]string, len(src))
    for k, v := range src {
        dst[k] = v
    }
    return dst
}
```

### Senior at FAANG Track

5. **Context audit.** Pick one production service you own. Find every I/O function that does not accept a context and refactor it. Measure lines changed, bugs surfaced, review time. Write up as a case study.

6. **Deadline-propagation test harness.** Build an integration test that sets a request deadline, captures downstream call metadata (via mock or interceptor), and asserts deadlines propagate correctly. Run it in CI. Document the coverage.

7. **Migrate to context.Cause.** For one service, introduce `context.WithCancelCause` at request entry. Propagate causes through cancellation paths. Emit metrics per cause. Measure the diagnostic improvement.

### Staff / Principal Track

8. **Org-wide deadline-propagation enforcement.** Build shared middleware that enforces deadline propagation at every service entry and exit. Drive adoption. Monitor compliance. Publish a report after six months showing percentage of services propagating deadlines correctly.

9. **Context-value governance.** Create a registry of allowed context keys for the org. Audit usage quarterly. Retire unused keys. Document the policy and enforce it through code review.

10. **Shutdown protocol convention.** Write the org's graceful-shutdown convention: root context canceled on SIGTERM, bounded drain deadline, shutdown diagnostics. Provide a shared library. Drive adoption. Measure shutdown cleanness via leaked-goroutine count across services.

11. **Cross-service tracing rollout.** Integrate context with distributed tracing (OpenTelemetry). Every request gets a trace span propagated via context. Every downstream call carries the trace ID. Build dashboards that surface cross-service latency. Drive adoption.

12. **Context migration retrospective.** If your org migrated to context (from done channels or ad-hoc cancellation), write up the retrospective: what worked, what did not, lessons for future migrations. This is the teaching material that helps the next wave of service adoptions.

---
