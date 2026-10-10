## 16.3 Goroutine Leaks

Goroutine leaks occur when goroutines never terminate.

### Blocked on Channel

A goroutine blocked on a channel send with no receiver will remain allocated indefinitely, consuming stack memory and preventing garbage collection of anything it references. The fix is to include a cancellation path via `context.Done()` or a dedicated done channel so the goroutine can unblock and exit when the parent is no longer interested.

```go
// LEAK: channel never receives
func leak() {
    ch := make(chan int)
    go func() {
        ch <- 42  // Blocked forever
    }()
    // Function returns, goroutine still running
}
```

**Fix: Use context or done channel:**
```go
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
```

#### The one-line fix people forget: buffer the result channel

The most common leak in real code is not an exotic one, it is a request that gives up. A caller starts a worker, waits for the result with a timeout, and returns on timeout. The worker then finishes, sends its result to a channel nobody is reading, and blocks forever:

```go
// LEAK: the goroutine outlives the caller's patience
func fetchWithTimeout(ctx context.Context) (int, error) {
    ch := make(chan int) // unbuffered
    go func() {
        ch <- slowWork() // Nobody is here after the timeout fires
    }()

    select {
    case v := <-ch:
        return v, nil
    case <-ctx.Done():
        return 0, ctx.Err() // Caller leaves, worker parks FOREVER
    }
}
```

Every timed-out request leaks a goroutine, plus whatever `slowWork` was holding. Load-test a service with this shape and it dies precisely when it is already struggling, which is the worst possible time.

The fix is one character. Give the channel a buffer of one:

```go
func fetchWithTimeout(ctx context.Context) (int, error) {
    ch := make(chan int, 1) // Buffered: the send never blocks

    go func() {
        ch <- slowWork() // Always completes, receiver or not
    }()

    select {
    case v := <-ch:
        return v, nil
    case <-ctx.Done():
        return 0, ctx.Err() // Worker still finishes and exits cleanly
    }
}
```

The buffer slot means the send always succeeds, so the goroutine runs to completion and exits whether or not anyone is listening. The unread value becomes garbage along with the channel. This is why `context`-aware helpers throughout the standard library hand results to a buffered channel of exactly the capacity of the number of sends: a `select` with a cancellation branch and an *unbuffered* result channel is a goroutine leak with extra steps.

Size the buffer to the number of sends, not to a guess. One sender, one slot.

### Blocked on Select Without Default

A `select` with no `default` and no cancellation case will block permanently if none of the channels ever become ready. This pattern is easy to introduce accidentally when channels are created for a one-shot handoff but the sending side exits early due to an error.

```go
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
```

### Leaking Timers via time.After in Loops

A subtle memory leak pattern occurs when using 	ime.After inside an event loop. 	ime.After(d) allocates a new 	ime.Timer on every iteration. If the select chooses another channel branch (e.g., incoming message), the timer is **not** cancelled or garbage collected; it remains pinned in runtime memory until its full duration expires. Under high throughput, thousands of abandoned timers accumulate in memory:

`go
// LEAK: allocates an uncollected timer on every iteration
func worker(ch <-chan int) {
    for {
        select {
        case v := <-ch:
            process(v)
        case <-time.After(5 * time.Second): // New timer allocated every message!
            return
        }
    }
}
`

**Fix**: Create a single 	ime.Timer outside the loop, stop it deferred, and reset it on each message:

`go
func worker(ch <-chan int) {
    timer := time.NewTimer(5 * time.Second)
    defer timer.Stop()

    for {
        select {
        case v := <-ch:
            process(v)
            if !timer.Stop() {
                select {
                case <-timer.C:
                default:
                }
            }
            timer.Reset(5 * time.Second)
        case <-timer.C:
            return // Timed out waiting for messages
        }
    }
}
`

### WaitGroup Deadlock via Skipped Done() on Error

When coordinating multiple worker goroutines with sync.WaitGroup, placing wg.Done() at the tail of the function rather than in a defer causes the caller's wg.Wait() to block indefinitely if the worker encounters an early error return or panic:

`go
// ANTI-PATTERN: early return skips wg.Done(), hanging wg.Wait() forever
func processAll(tasks []Task) error {
    var wg sync.WaitGroup
    for _, t := range tasks {
        wg.Add(1)
        go func(task Task) {
            if err := task.Execute(); err != nil {
                return // BUG: wg.Done() is never called!
            }
            wg.Done()
        }(t)
    }
    wg.Wait()
    return nil
}
`

**Fix**: Always invoke wg.Done() in a defer statement immediately upon entering the goroutine:

`go
func processAll(tasks []Task) error {
    var wg sync.WaitGroup
    for _, t := range tasks {
        wg.Add(1)
        go func(task Task) {
            defer wg.Done() // Guaranteed to execute on return or panic
            if err := task.Execute(); err != nil {
                return
            }
        }(task)
    }
    wg.Wait()
    return nil
}
`

### Unbounded Spawning and Downstream Block Pile-up

Spawning a new goroutine per incoming request or batch item without concurrency limits can trigger severe resource exhaustion during traffic spikes. If downstream dependencies (such as a database connection pool or external API) slow down, goroutines pile up in blocked states:

`go
// ANTI-PATTERN: Unbounded concurrency saturates runtime scheduler and DB pools
func handleBatch(items []Item) {
    for _, item := range items {
        go processItem(item) // Spawns 100k goroutines during a spike
    }
}
`

**Fix**: Enforce strict concurrency boundaries using a buffered channel as a semaphore or an explicit worker pool:

`go
func handleBatch(items []Item) {
    const maxConcurrency = 20
    sem := make(chan struct{}, maxConcurrency)
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)
        sem <- struct{}{} // Blocks when concurrency limit is reached

        go func(it Item) {
            defer wg.Done()
            defer func() { <-sem }() // Releases slot
            processItem(it)
        }(item)
    }
    wg.Wait()
}
`

### Detecting Leaks

Comparing `runtime.NumGoroutine()` before and after a test provides a simple leak check without external dependencies. When a leak is detected, printing the full goroutine stack via `runtime.Stack` with `all=true` identifies which goroutines are still live and where they are blocked.

Be aware that the version below is flaky in both directions, which is the reason `goleak` exists. A single fixed `time.Sleep` either passes early, letting a genuinely slow-but-correct goroutine look like a leak, or wastes 100ms on every test. Background goroutines from the runtime, from `testing`, and from HTTP transports can also drift the count on their own. `goleak` handles this by retrying with backoff and by filtering known-benign stacks, so prefer it and treat the hand-rolled check as an illustration of the idea.

```go
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
        t.Logf("Goroutines:\n%s", buf[:n])
    }
}
```

### Using goleak

`goleak.VerifyTestMain` hooks into the test binary's exit point and fails the suite if any unexpected goroutines remain after all tests complete. It filters known background goroutines (runtime, testing internals) and reports the stack traces of any leaked goroutines, making it the most ergonomic way to enforce leak-free tests across an entire package.

```go
import "go.uber.org/goleak"

// Verify across the entire package test suite:
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// Or verify at individual test scope for targeted debugging:
func TestWorker(t *testing.T) {
    defer goleak.VerifyNone(t)
    worker(context.Background())
}
```

> [!NOTE]
> For a field retrospective on diagnosing goroutine leaks and structuring goroutine lifecycle exit conditions before entry, see Yaninyz witty's analysis in [*Common goroutine leak Patterns (And how to detect them)*](https://medium.com/@yaninyzwitty/common-goroutine-leak-patterns-and-how-to-detect-them).

### Production Leak Detection

In production, monitor `runtime.NumGoroutine()` as a Prometheus metric. A healthy service has a goroutine count that fluctuates around a baseline proportional to request volume. A leak shows as monotonic upward growth. Alert on sustained upward trends.

For diagnosis, capture a goroutine dump: `curl http://service/debug/pprof/goroutine?debug=2 > dump.txt`. Group goroutines by stack. The dominant stack in a growing bucket is the leak site.

### The Goroutine Leak Profile

Go 1.27 promotes the goroutine leak profile to general availability, exposing `/debug/pprof/goroutineleak`. It first appeared in Go 1.26 behind `GOEXPERIMENT=goroutineleakprofile`, so on 1.26 you need the experiment flag and on 1.27 you do not.

The distinction that makes it useful is **reachability**. A plain goroutine dump lists everything that is blocked, and most blocked goroutines are perfectly healthy: a worker parked on a job channel is blocked, but a live producer still holds that channel and will wake it. This profile reports only goroutines blocked on synchronization primitives that are no longer reachable from any running goroutine, meaning nothing can ever wake them. That is the precise definition of a leak, and it turns "read a thousand stacks and reason about each one" into a list you can act on.

The reachability criterion is also the caveat. A goroutine blocked forever on a channel that *is* still reachable, because some other goroutine holds it and will never send, is not reported. It is unreachable-ness, not stuckness, that this detects, so the profile is a strong signal rather than a complete one.

```bash
# Go 1.27: leaked goroutines only
curl 'http://localhost:6060/debug/pprof/goroutineleak?debug=2'
```

Enable it on canary instances to catch leaks before full rollout.

### Staff Lens: Leak Prevention as Process

Every new goroutine must pass the four-question test at code review:

1. Who starts this goroutine?
2. Who cancels it?
3. What is its exit path?
4. Is context propagated correctly?

If any question is unclear, the goroutine is a leak risk. Establish this as a review discipline. Most goroutine leaks are prevented by answering these four questions at design time, not discovered in production.

---
