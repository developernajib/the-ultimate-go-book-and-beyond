export default `## 14.11 Interview Questions

Context questions appear in most FAANG Go interviews because \`context.Context\` threads through every non-trivial service: request lifecycles, RPC timeouts, cancellation, and trace propagation. Interviewers use them to check whether you have absorbed the three key disciplines: take context as the first parameter, never store it in structs, always call \`cancel\` to release resources.

> **What FAANG actually tests here**: whether you understand cancellation trees, deadline inheritance, the typed-key convention for values, and the newer helpers. \`WithCancelCause\`, \`WithDeadlineCause\`, \`WithTimeoutCause\`, and \`context.Cause\` landed in Go 1.20. \`WithoutCancel\` and \`AfterFunc\` landed in Go 1.21. Candidates who store \`context.Context\` on a struct usually fail the senior bar.

### Question 1: Context Cancellation Flow

**What FAANG expects**: correct downward propagation, awareness that \`cancel\` functions must always be called (ideally via \`defer\`) to release the linked goroutines the context created, and that \`errors.Is(err, context.Canceled)\` is the correct check, not \`err == context.Canceled\` after wrapping.

**Q: Explain how context cancellation propagates to child contexts.**

**A:** Cancellation propagates strictly downward through the context tree. Cancelling a parent cancels all of its children and grandchildren, but cancelling a child never affects the parent or any sibling contexts. The effective deadline at any node is the minimum of its own deadline and its parent's deadline.

\`\`\`go
// Context cancellation propagates DOWN the tree, not up

parent, parentCancel := context.WithCancel(context.Background())
child, childCancel := context.WithCancel(parent)
grandchild, grandchildCancel := context.WithTimeout(child, time.Hour)

// Scenario 1: Cancel parent
parentCancel()
// Result: parent, child, and grandchild are ALL cancelled

// Scenario 2: Cancel child
childCancel()
// Result: child and grandchild are cancelled, parent is NOT

// Scenario 3: Cancel grandchild
grandchildCancel()
// Result: only grandchild is cancelled

// Key points:
// 1. Cancellation flows DOWN (parent → child)
// 2. Never flows UP (child → parent)
// 3. Deadline is minimum of parent and child
// 4. Values are looked up in chain (child → parent → grandparent)
\`\`\`

**Follow-ups**:
- What exactly does the \`cancel\` function returned by \`WithCancel\` do internally, and why is it critical to call it even if cancellation never fires?
- How does \`context.AfterFunc\` (Go 1.21+) let you run a callback when a context is cancelled without polling \`ctx.Done()\`?

### Question 2: WithoutCancel Use Case

**What FAANG expects**: you know \`context.WithoutCancel\` shipped in Go 1.21, you can name at least two concrete use cases, and you know that values still propagate, only cancellation and deadline are detached.

**Q: When would you use context.WithoutCancel (Go 1.21+)?**

**A:** \`context.WithoutCancel\` creates a derived context that inherits all values from the parent but is not cancelled when the parent is cancelled. This is useful for two specific situations: cleanup work that must finish even after the request ends, and background jobs spawned from a request that should outlive the HTTP response but still carry tracing metadata.

\`\`\`go
// WithoutCancel creates a context that inherits values but NOT cancellation

// Use case 1: Cleanup after cancellation
func handleRequest(ctx context.Context) error {
    defer func() {
        // Need to log metrics even if request was cancelled
        // Use WithoutCancel so logging isn't interrupted
        logCtx := context.WithoutCancel(ctx)
        logCtx, cancel := context.WithTimeout(logCtx, 5*time.Second)
        defer cancel()
        logMetrics(logCtx)
    }()

    return processRequest(ctx)
}

// Use case 2: Background job from request
func createJob(ctx context.Context, data Data) error {
    // Job should run independently of request lifecycle
    jobCtx := context.WithoutCancel(ctx)
    // Still has request values (trace ID, etc.)
    go runBackgroundJob(jobCtx, data)
    return nil
}

// Note: Values are still inherited!
// Only cancellation/deadline is detached
\`\`\`

**Follow-ups**:
- What is the \`context.Cause\` function and how does it interact with \`WithCancelCause\` to attribute *why* a context was cancelled?
- How would you test that a cleanup block actually ran after cancellation?

### Question 3: Timeout Hierarchy

**What FAANG expects**: you name the invariant ("child deadline is the minimum of its own and parent's"), and know \`context.WithDeadlineCause\` and \`context.WithTimeoutCause\` (Go 1.20+) let you attach a specific reason that shows up in \`context.Cause(ctx)\` when the deadline fires.

**Q: What happens when a child context has a longer timeout than its parent?**

**A:** The child's effective deadline is always the minimum of its own and its parent's. A child context cannot extend a parent's deadline, if the parent has 2 seconds remaining and the child requests 10 seconds, the child will still expire in 2 seconds when the parent does.

\`\`\`go
// Child timeout is capped by parent's remaining time

parent, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

// After 3 seconds...
time.Sleep(3 * time.Second)

// Parent has ~2 seconds left
// Child requests 10 seconds
child, cancel := context.WithTimeout(parent, 10*time.Second)
defer cancel()

deadline, _ := child.Deadline()
// deadline is ~2 seconds from now, NOT 10 seconds
// Child inherits the tighter constraint

// Key principle: deadline = min(parent_deadline, self_deadline)
\`\`\`

**Follow-ups**:
- If a parent has no deadline and the child sets \`10s\`, what does the child's \`Deadline()\` return?
- How would you propagate a deadline across an RPC boundary so the server-side context expires at the right time even if the client-server clock is skewed?

### Question 4: Context Values Thread Safety

**What FAANG expects**: the immutability-of-the-lookup-chain story, awareness that stored pointers to mutable values are the actual race hazard, and that the convention is to use unexported types as keys to prevent collisions between packages.

**Q: Are context values thread-safe?**

**A:** The context chain itself is immutable and safe for concurrent reads, multiple goroutines can call \`ctx.Value()\` simultaneously without synchronization. However, if the stored value is a pointer to a mutable struct, concurrent goroutines that modify that struct through the pointer introduce a data race. Store only immutable values (strings, integers, value-type structs) or inherently thread-safe types (atomics, channels) in context.

\`\`\`go
// Context values themselves are accessed safely (immutable chain lookup)
// BUT the values stored should be immutable or thread-safe

// SAFE: Immutable value
ctx := context.WithValue(ctx, "requestID", "abc123")
// String is immutable, safe to read from any goroutine

// UNSAFE: Mutable value without synchronization
type Counter struct {
    count int
}
ctx := context.WithValue(ctx, "counter", &Counter{})
// Multiple goroutines incrementing counter = race condition

// SAFE: Thread-safe value
var counter atomic.Int64
ctx := context.WithValue(ctx, "counter", &counter)
// Atomic operations are safe

// Best practice: Context values should be:
// 1. Immutable (strings, ints, structs with immutable fields)
// 2. Or inherently thread-safe (atomic types, channels)

// Key convention: the key must be an unexported type from your package
// to guarantee no collision with other packages' keys.
type ctxKey int
const userIDKey ctxKey = 0

ctx = context.WithValue(ctx, userIDKey, "u-123")
\`\`\`

**Follow-ups**:
- Why is using a plain \`string\` as a context value key an anti-pattern?
- What is the performance cost of \`ctx.Value(k)\` for deep context chains, and how is it usually mitigated?

### Question 5: Testing with Context

**What FAANG expects**: the three standard test shapes (success, deadline, cancellation), use of \`errors.Is\` for comparisons, and awareness that \`testing/synctest\` (Go 1.25+) eliminates real-time waits for context-driven tests.

**Q: How do you test context-aware code?**

**A:** Test context-aware code by creating contexts with known deadlines, cancellation triggers, and values, then asserting the function behaves correctly in each scenario. The three core cases are: successful completion within the timeout, \`context.DeadlineExceeded\` when the operation is too slow, and \`context.Canceled\` when cancellation is triggered externally. For context values, construct a context with the expected entries and verify the function reads them correctly.

\`\`\`go
func TestWithTimeout(t *testing.T) {
    // Test normal completion
    t.Run("completes before timeout", func(t *testing.T) {
        ctx, cancel := context.WithTimeout(context.Background(), time.Second)
        defer cancel()

        result, err := fastOperation(ctx)
        if err != nil {
            t.Errorf("unexpected error: %v", err)
        }
        if result != expected {
            t.Errorf("wrong result")
        }
    })

    // Test timeout
    t.Run("times out", func(t *testing.T) {
        ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
        defer cancel()

        _, err := slowOperation(ctx)
        if !errors.Is(err, context.DeadlineExceeded) {
            t.Errorf("expected DeadlineExceeded, got %v", err)
        }
    })

    // Test cancellation
    t.Run("handles cancellation", func(t *testing.T) {
        ctx, cancel := context.WithCancel(context.Background())

        go func() {
            time.Sleep(10 * time.Millisecond)
            cancel()
        }()

        _, err := slowOperation(ctx)
        if !errors.Is(err, context.Canceled) {
            t.Errorf("expected Canceled, got %v", err)
        }
    })

    // Test with values
    t.Run("uses context values", func(t *testing.T) {
        ctx := WithUserID(context.Background(), 123)
        ctx = WithRequestID(ctx, "test-request")

        err := operationNeedingContext(ctx)
        if err != nil {
            t.Errorf("unexpected error: %v", err)
        }
    })

    // Modern alternative: testing/synctest (experiment in 1.24, stable in 1.25)
    // removes real-time waits. The bubble's virtual clock advances instantly
    // when all goroutines in the bubble are blocked, so timeout tests run in
    // microseconds. On Go 1.25+ prefer synctest.Test; synctest.Run still exists
    // but is deprecated.
    t.Run("timeout under synctest", func(t *testing.T) {
        synctest.Test(t, func(t *testing.T) {
            ctx, cancel := context.WithTimeout(context.Background(), time.Second)
            defer cancel()
            _, err := slowOperation(ctx)
            if !errors.Is(err, context.DeadlineExceeded) {
                t.Fatal("expected DeadlineExceeded")
            }
        })
    })
}
\`\`\`

**Follow-ups**:
- Why is \`errors.Is(err, context.DeadlineExceeded)\` preferred over \`err == context.DeadlineExceeded\`?
- How would you use \`context.AfterFunc\` to register a cleanup that runs only if the context is cancelled before the main work finishes?

### Q (Senior track): How would you design end-to-end deadline propagation for a Go microservices architecture?

**What FAANG expects**: a concrete design involving RPC framework choice, middleware, monitoring, and testing.

**Answer**: Four pieces.

1. **Standardise on gRPC or a deadline-aware HTTP convention.** gRPC propagates deadlines automatically via metadata. For HTTP, adopt an \`X-Request-Deadline-Ms\` header and middleware that reads it on entry and sets it on every outbound call.
2. **Deadline budget middleware at every service entry point.** Set \`ctx, cancel := context.WithTimeout(r.Context(), budget)\` based on the propagated deadline. Call \`cancel()\` via middleware cleanup.
3. **Pass context everywhere.** Every function that does I/O takes context. Every database driver, HTTP client, RPC client is configured to respect context.
4. **Integration tests that verify propagation.** A test that sets a 500ms deadline on a request, inspects the downstream call, and asserts the downstream deadline is less than 500ms. Without this test, propagation breaks silently.

Bonus: tracing-based monitoring. Each span includes the deadline; a dashboard shows deadline distribution across the call graph. Propagation bugs surface as spans with inherited-deadline-equals-infinity.

### Q (Staff track): You discover that half the services in your org do not propagate deadlines. How do you fix it?

**What FAANG expects at staff**: a rollout plan balancing urgency, team autonomy, and risk.

**Answer**: Three phases.

1. **Socialise the problem.** Present the findings with concrete examples (service X receives deadline D but calls service Y with deadline infinity). Build consensus that this must be fixed.
2. **Provide shared middleware.** Ship a library that enforces deadline propagation. Make adopting it easy. Make not adopting it visible (linter rule, CI check).
3. **Opportunistic migration.** As teams touch their services for any reason, they adopt the middleware. Do not force a flag-day rollout. Track adoption. Escalate the long tail after six months.

The counter-intuitive staff insight: service teams often resist deadline propagation because they fear timeouts will cause new errors. Address this directly: without propagation, you have slow errors; with propagation, you have fast errors. Fast errors are better: they surface problems instead of hiding them. The mindset shift is the hard part.

**Follow-ups**:
- What metrics would you monitor to measure the adoption progress?
- How do you handle services that cannot be modified (vendor code, legacy systems)?

---
`;
