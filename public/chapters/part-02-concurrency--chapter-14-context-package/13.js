export default `## 14.12 Exercises with Solutions

### Exercise 1: Timeout Budget Manager

Implement a timeout budget manager that tracks remaining time across operations. The budget should allocate time slices to sub-operations, record how long each step actually took, and report the remaining balance.

**Solution:**

The \`Budget\` type maintains a running total of remaining time and records each step's actual duration. \`ExecuteWithBudget\` wraps any operation with a child context whose timeout is the minimum of the requested duration and the remaining budget, then records the elapsed time after the operation completes. This prevents any single step from consuming more time than the overall budget allows.

\`\`\`go
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
        fmt.Printf("%s: %v (error: %v)\\n", step.Name, step.Duration, step.Error)
    }
    fmt.Printf("Remaining budget: %v\\n", budget.Remaining())

    return nil
}
\`\`\`

### Exercise 2: Context-Aware Worker Pool

Implement a worker pool that properly handles context cancellation. Workers should stop accepting new tasks when the context is cancelled, drain any remaining tasks with a bounded cleanup timeout, and report results through a channel.

**Solution:**

Each worker goroutine selects on both \`ctx.Done()\` and the task channel. When the context is cancelled, the worker enters cleanup mode: it drains remaining tasks using a fresh \`context.Background()\` with a short timeout so that partially-completed work can finish without running indefinitely. The \`Submit\` method uses a non-blocking send so callers are never stuck waiting when the queue is full.

\`\`\`go
package worker

import (
    "context"
    "sync"
)

type Task func(ctx context.Context) error

type Pool struct {
    workers int
    tasks   chan Task
    results chan error
    wg      sync.WaitGroup
}

func NewPool(workers int, queueSize int) *Pool {
    return &Pool{
        workers: workers,
        tasks:   make(chan Task, queueSize),
        results: make(chan error, queueSize),
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
            // Drain remaining tasks on shutdown
            for task := range p.tasks {
                // Execute with fresh context (cleanup mode)
                cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                p.results <- task(cleanupCtx)
                cancel()
            }
            return

        case task, ok := <-p.tasks:
            if !ok {
                return // Channel closed
            }

            // Execute task with the pool's context
            err := task(ctx)
            select {
            case p.results <- err:
            case <-ctx.Done():
                return
            }
        }
    }
}

func (p *Pool) Submit(task Task) bool {
    select {
    case p.tasks <- task:
        return true
    default:
        return false // Queue full
    }
}

func (p *Pool) Results() <-chan error {
    return p.results
}

func (p *Pool) Stop() {
    close(p.tasks)
    p.wg.Wait()
    close(p.results)
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
                fmt.Printf("Task %d completed\\n", i)
                return nil
            }
        })
    }

    // Collect results
    go func() {
        for err := range pool.Results() {
            if err != nil {
                fmt.Printf("Task error: %v\\n", err)
            }
        }
    }()

    // Wait for completion or timeout
    <-ctx.Done()
    pool.Stop()
}
\`\`\`

### Exercise 3: Distributed Trace Propagation

Implement trace context propagation across HTTP boundaries. The solution should parse incoming W3C \`Traceparent\` headers, create child spans for each hop, and inject trace headers into outgoing HTTP requests automatically.

**Solution:**

The \`TraceMiddleware\` parses the incoming \`Traceparent\` header, creates a child span (or a new root trace if none exists), and stores it in the request context. On the client side, \`TracingTransport\` implements \`http.RoundTripper\` to automatically inject the trace header into every outgoing request, so downstream services receive the parent span ID without manual intervention at each call site.

\`\`\`go
package trace

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "net/http"
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

func ParseTraceContext(header string) (*TraceContext, error) {
    parts := strings.Split(header, "-")
    if len(parts) != 4 {
        return nil, fmt.Errorf("invalid traceparent header")
    }

    flags := byte(0)
    if parts[3] == "01" {
        flags = 0x01
    }

    return &TraceContext{
        Version:    parts[0],
        TraceID:    parts[1],
        ParentID:   parts[2],
        TraceFlags: flags,
        Tracestate: make(map[string]string),
    }, nil
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
    if tc, ok := GetTraceContext(r.Context()); ok {
        child := tc.NewChild()
        r.Header.Set(TraceparentHeader, child.ToHeader())
    }

    base := t.Base
    if base == nil {
        base = http.DefaultTransport
    }
    return base.RoundTrip(r)
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
\`\`\`

### Senior at FAANG Track

5. **Context audit.** Pick one production service you own. Find every I/O function that does not accept a context and refactor it. Measure lines changed, bugs surfaced, review time. Write up as a case study.

6. **Deadline-propagation test harness.** Build an integration test that sets a request deadline, captures downstream call metadata (via mock or interceptor), and asserts deadlines propagate correctly. Run it in CI. Document the coverage.

7. **Migrate to context.Cause.** For one service, introduce \`context.WithCancelCause\` at request entry. Propagate causes through cancellation paths. Emit metrics per cause. Measure the diagnostic improvement.

### Staff / Principal Track

8. **Org-wide deadline-propagation enforcement.** Build shared middleware that enforces deadline propagation at every service entry and exit. Drive adoption. Monitor compliance. Publish a report after six months showing percentage of services propagating deadlines correctly.

9. **Context-value governance.** Create a registry of allowed context keys for the org. Audit usage quarterly. Retire unused keys. Document the policy and enforce it through code review.

10. **Shutdown protocol convention.** Write the org's graceful-shutdown convention: root context cancelled on SIGTERM, bounded drain deadline, shutdown diagnostics. Provide a shared library. Drive adoption. Measure shutdown cleanness via leaked-goroutine count across services.

11. **Cross-service tracing rollout.** Integrate context with distributed tracing (OpenTelemetry). Every request gets a trace span propagated via context. Every downstream call carries the trace ID. Build dashboards that surface cross-service latency. Drive adoption.

12. **Context migration retrospective.** If your org migrated to context (from done channels or ad-hoc cancellation), write up the retrospective: what worked, what did not, lessons for future migrations. This is the teaching material that helps the next wave of service adoptions.

---
`;
