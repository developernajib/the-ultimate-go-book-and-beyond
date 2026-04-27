export default `## 16.3 Goroutine Leaks

Goroutine leaks occur when goroutines never terminate.

### Blocked on Channel

A goroutine blocked on a channel send with no receiver will remain allocated indefinitely, consuming stack memory and preventing garbage collection of anything it references. The fix is to include a cancellation path via \`context.Done()\` or a dedicated done channel so the goroutine can unblock and exit when the parent is no longer interested.

\`\`\`go
// LEAK: channel never receives
func leak() {
    ch := make(chan int)
    go func() {
        ch <- 42  // Blocked forever
    }()
    // Function returns, goroutine still running
}
\`\`\`

**Fix: Use context or done channel:**
\`\`\`go
func fixed(ctx context.Context) {
    ch := make(chan int)
    go func() {
        select {
        case ch <- 42:
        case <-ctx.Done():
            return
        }
    }()
}
\`\`\`

### Blocked on Select Without Default

A \`select\` with no \`default\` and no cancellation case will block permanently if none of the channels ever become ready. This pattern is easy to introduce accidentally when channels are created for a one-shot handoff but the sending side exits early due to an error.

\`\`\`go
// LEAK: all cases blocked
func leak() {
    ch1, ch2 := make(chan int), make(chan int)
    go func() {
        select {
        case <-ch1:  // Never receives
        case <-ch2:  // Never receives
        }
    }()
}
\`\`\`

### Detecting Leaks

Comparing \`runtime.NumGoroutine()\` before and after a test provides a simple leak check without external dependencies. When a leak is detected, printing the full goroutine stack via \`runtime.Stack\` with \`all=true\` identifies which goroutines are still live and where they are blocked.

\`\`\`go
func TestNoLeaks(t *testing.T) {
    before := runtime.NumGoroutine()

    // Run code under test
    doSomething()

    // Wait and check
    time.Sleep(100 * time.Millisecond)
    after := runtime.NumGoroutine()

    if after > before {
        t.Errorf("goroutine leak: %d -> %d", before, after)

        // Print goroutine stacks
        buf := make([]byte, 1024*1024)
        n := runtime.Stack(buf, true)
        t.Logf("Goroutines:\\n%s", buf[:n])
    }
}
\`\`\`

### Using goleak

\`goleak.VerifyTestMain\` hooks into the test binary's exit point and fails the suite if any unexpected goroutines remain after all tests complete. It filters known background goroutines (runtime, testing internals) and reports the stack traces of any leaked goroutines, making it the most ergonomic way to enforce leak-free tests across an entire package.

\`\`\`go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
\`\`\`

### Production Leak Detection

In production, monitor \`runtime.NumGoroutine()\` as a Prometheus metric. A healthy service has a goroutine count that fluctuates around a baseline proportional to request volume. A leak shows as monotonic upward growth. Alert on sustained upward trends.

For diagnosis, capture a goroutine dump: \`curl http://service/debug/pprof/goroutine?debug=2 > dump.txt\`. Group goroutines by stack. The dominant stack in a growing bucket is the leak site.

### Go 1.26 Goroutine Leak Profile

Go 1.26 added \`GOEXPERIMENT=goroutineleakprofile\` which exposes \`/debug/pprof/goroutineleak\`. This endpoint returns only leaked goroutines (blocked on primitives that are unreachable from any running goroutine). Much cleaner than filtering a full goroutine dump. Enable it on canary instances to catch leaks before full rollout.

### Staff Lens: Leak Prevention as Process

Every new goroutine must pass the four-question test at code review:

1. Who starts this goroutine?
2. Who cancels it?
3. What is its exit path?
4. Is context propagated correctly?

If any question is unclear, the goroutine is a leak risk. Establish this as a review discipline. Most goroutine leaks are prevented by answering these four questions at design time, not discovered in production.

---
`;
