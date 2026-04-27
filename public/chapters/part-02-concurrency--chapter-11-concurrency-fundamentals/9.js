export default `## 11.8 Goroutine Leaks

Goroutine leaks are memory leaks, goroutines that never terminate consume resources forever.

### Common Leak Patterns

**1. Blocked Send (No Receiver)**

\`\`\`go
// LEAK: Goroutine blocks forever on send
func leak1() {
    ch := make(chan int)
    go func() {
        ch <- 42  // Blocks forever - no receiver
    }()
    // Function returns, goroutine lives forever
}

// FIX: Ensure receiver exists or use buffered channel
func noLeak1() {
    ch := make(chan int, 1)  // Buffered
    go func() {
        ch <- 42  // Doesn't block
    }()
}
\`\`\`

**2. Blocked Receive (No Sender)**

\`\`\`go
// LEAK: Goroutine blocks forever on receive
func leak2() {
    ch := make(chan int)
    go func() {
        <-ch  // Blocks forever - no sender
    }()
}

// FIX: Close channel or send value
func noLeak2() {
    ch := make(chan int)
    go func() {
        <-ch  // Will return when channel closed
    }()
    close(ch)  // Signal completion
}
\`\`\`

**3. Infinite Loop Without Exit**

\`\`\`go
// LEAK: No way to stop
func leak3() {
    go func() {
        for {
            doWork()
        }
    }()
}

// FIX: Use context or done channel
func noLeak3(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
                doWork()
            }
        }
    }()
}
\`\`\`

**4. Slow Receiver with Fast Producer**

\`\`\`go
// LEAK: If consumer is cancelled, producer is stuck
func leak4(ctx context.Context) {
    ch := make(chan int)

    // Producer
    go func() {
        for i := 0; ; i++ {
            ch <- i  // Blocks if consumer stops
        }
    }()

    // Consumer
    for {
        select {
        case <-ctx.Done():
            return  // Consumer exits, producer leaks!
        case v := <-ch:
            process(v)
        }
    }
}

// FIX: Producer also checks context
func noLeak4(ctx context.Context) {
    ch := make(chan int)

    // Producer
    go func() {
        defer close(ch)
        for i := 0; ; i++ {
            select {
            case <-ctx.Done():
                return  // Exit when cancelled
            case ch <- i:
            }
        }
    }()

    // Consumer
    for {
        select {
        case <-ctx.Done():
            return
        case v, ok := <-ch:
            if !ok {
                return
            }
            process(v)
        }
    }
}
\`\`\`

### Leak Detection

**Runtime Detection**

The simplest leak detector compares \`runtime.NumGoroutine()\` before and after running the code under test. A short sleep and GC call give goroutines time to exit, and if the count is higher afterward, something is still blocked. Dumping all goroutine stack traces with \`runtime.Stack\` pinpoints exactly which goroutine is stuck and where.

\`\`\`go
func TestNoLeaks(t *testing.T) {
    before := runtime.NumGoroutine()

    // Run your code
    doSomething()

    // Give goroutines time to exit
    time.Sleep(100 * time.Millisecond)
    runtime.GC()

    after := runtime.NumGoroutine()
    if after > before {
        t.Errorf("goroutine leak: before=%d, after=%d", before, after)

        // Print stack traces for debugging
        buf := make([]byte, 1<<20)
        n := runtime.Stack(buf, true)
        t.Logf("goroutine stacks:\\n%s", buf[:n])
    }
}
\`\`\`

**Using goleak Package**

Uber's \`goleak\` package automates leak detection for your entire test suite. Calling \`goleak.VerifyTestMain(m)\` at the package level checks for leaked goroutines after all tests finish, and \`goleak.VerifyNone(t)\` can be placed in individual tests for finer-grained detection. It filters out known background goroutines (like the runtime's signal handler) to reduce false positives.

\`\`\`go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

func TestNoLeaks(t *testing.T) {
    defer goleak.VerifyNone(t)

    // Your test code
    doSomething()
}
\`\`\`

**Using testing/synctest (experiment in Go 1.24, stable in Go 1.25)**

The \`testing/synctest\` package runs code inside an isolated goroutine bubble with a virtualized clock. Time package functions operate on a fake clock that advances instantly when every goroutine in the bubble is blocked. The bubble's \`Wait\` function blocks until every goroutine is either finished or "durably blocked" (blocked on another goroutine in the bubble). This makes "the test left goroutines running" a deterministic condition rather than a timing guess.

The package was introduced as an experiment in Go 1.24 (\`GOEXPERIMENT=synctest\` with \`synctest.Run\`) and stabilized in Go 1.25, which also promoted the preferred API to \`synctest.Test(t, func(t *testing.T) { ... })\`. On 1.25+ prefer \`Test\`; \`Run\` still exists but is deprecated.

\`\`\`go
import "testing/synctest"

func TestNoLeaks(t *testing.T) {
    synctest.Test(t, func(t *testing.T) {
        ctx, cancel := context.WithCancel(context.Background())
        go backgroundWorker(ctx)

        cancel()
        synctest.Wait() // blocks until every goroutine in the bubble is done or durably blocked.
        // If any goroutine is still runnable here, the test fails.
    })
}
\`\`\`

**Using /debug/pprof/goroutineleak (Go 1.26 experiment)**

Go 1.26 added an opt-in goroutine leak profile behind \`GOEXPERIMENT=goroutineleakprofile\`. Enabling it exposes a \`/debug/pprof/goroutineleak\` HTTP endpoint and a corresponding \`goroutineleak\` profile type in \`runtime/pprof\`. Requesting the endpoint triggers a leak-detection GC cycle, which identifies goroutines blocked on concurrency primitives (channels, sync.Mutex, sync.Cond) that are unreachable from any runnable goroutine, and returns stacks for just those leaked goroutines. The Go team plans to enable it by default in Go 1.27.

### Production Leak Diagnosis Workflow

When a production service shows symptoms of a goroutine leak (gradual memory growth, monotonically rising goroutine count), the diagnosis workflow:

1. **Confirm the leak.** \`runtime.NumGoroutine()\` metric should show monotonic upward trend, not fluctuation around a stable value.
2. **Capture a goroutine dump.** \`curl http://service/debug/pprof/goroutine?debug=2 > dump.txt\` dumps all goroutines with their stacks. Capture two dumps 60 seconds apart. The diff shows growth.
3. **Bucket by stack.** Group goroutines by their current position. The common stack in the growing bucket is the leak site. Usually dozens or hundreds of goroutines share a single stack signature.
4. **Read the stack.** The goroutine is blocked on some primitive: channel send, channel receive, mutex acquire. Trace back from the blocked line to understand the pattern.
5. **Fix the lifetime.** Almost always the fix is "this goroutine does not respect context cancellation" or "this channel's sender never terminates". Add the context check, fix the sender.

This workflow, applied consistently, closes leak-class incidents in an hour. Applied sporadically, the same incidents take days.

### The Leak Budget

A healthy production service has a goroutine count that fluctuates around a baseline proportional to request volume. The staff-level metric: goroutine count per request-per-second should be bounded by a constant. If your service handles 1000 RPS and has 5000 goroutines, each request is responsible for 5 goroutines. That number should be stable over hours. If it creeps upward, you have a leak. If it is wildly variable, you have an unbounded pattern somewhere.

### \`goleak\` in CI

Uber's \`goleak\` package catches leaks at test time, before production. Add it to TestMain for every package that spawns goroutines. The cost is a few milliseconds per test run. The benefit is that a regression that introduces a leak fails the test run, not the production service. This is the highest-leverage single change a team can make to prevent goroutine leaks. Teams that run \`goleak\` in CI have dramatically fewer leak incidents than teams that do not.

### Staff Lens: Goroutine Leaks Are a Systemic Signal

One goroutine leak is a bug. Ten goroutine leaks across a service portfolio is a systemic problem with how the team writes concurrent code. The systemic fixes: context propagation discipline (every goroutine takes a context, every I/O respects \`ctx.Done()\`), shared goroutine-spawning helpers that enforce the pattern (\`safeGo\` wrapping recover, metrics, and context), CI integration of \`goleak\`, and runtime metrics that alert on monotonic growth. None of these is a code fix. All of them prevent leak-class bugs at the team scale. The staff-level impact is building the systemic fixes, not patching individual leaks one at a time.

### Principal Lens: Leak Prevention Is a Cultural Artifact

Some Go teams have essentially zero goroutine leak incidents per year. Other teams have one per quarter. The difference is rarely technical skill. It is cultural: does the team treat goroutine lifetime as something to specify at design time, or as something to discover in production? Principal engineers shape the culture. Make "who cancels this goroutine" a standard question in design reviews. Require context in every goroutine signature. Wire \`goleak\` into CI. Celebrate teams that go a full year without a leak incident. The culture compounds. Six months of discipline makes "goroutine without context" feel wrong to every engineer. Twelve months makes the team immune to most leak-class bugs. This is one of the clearest examples of how cultural investment by a principal engineer pays dividends for years.

---
`;
