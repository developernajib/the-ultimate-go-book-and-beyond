## 18.10 Testing Concurrent Code

Concurrent code introduces failure modes that sequential code cannot have: race conditions, deadlocks, and goroutine leaks. These bugs are non-deterministic, they may pass locally but fail in CI, or vice versa, so testing them requires specific tools and patterns.

### Detecting Race Conditions

Go's built-in race detector, enabled with `go test -race`, instruments memory accesses at compile time and reports unsynchronized concurrent access at runtime. Its key advantage is that it does not need the race to *corrupt anything*: it tracks happens-before relationships, so two conflicting accesses with no ordering between them are reported even when the run produced the correct answer.

That property matters more than it sounds, because a racy counter usually produces the right answer. Running the intentionally racy test below ten times without `-race`:

```
failed 4/10 runs without -race   <-- so it PASSED 6 times
```

A test that catches your bug 40% of the time is a test that gets marked flaky and retried. With `-race`, the same code is reported on the first run, every run.

Be clear about the limits, though, because "the race detector proves my code is race-free" is a dangerous overstatement. It is a **dynamic** analyzer: it only sees memory accesses that actually execute during that run. A race on a code path your test never takes is invisible to it, and so is a race between goroutines whose interleaving never got scheduled. It produces no false positives, which is what makes it trustworthy, but plenty of false negatives. `-race` finding nothing means "no race was observed on the paths exercised", not "there are no races".

The example below juxtaposes an intentionally racy `Counter` with a mutex-protected `SafeCounter` to show exactly what the detector catches and how synchronization eliminates it.

```go
// race_test.go
package concurrent

import (
    "sync"
    "testing"
)

// Counter is intentionally racy for demonstration
type Counter struct {
    value int // No synchronization!
}

func (c *Counter) Increment() {
    c.value++ // RACE CONDITION: read-modify-write
}

func (c *Counter) Value() int {
    return c.value
}

// This test will detect the race condition
func TestCounter_Race(t *testing.T) {
    // Run with: go test -race
    counter := &Counter{}
    var wg sync.WaitGroup

    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter.Increment()
        }()
    }

    wg.Wait()

    // With race detector: WARNING: DATA RACE
    // Without: value may be < 100
    if counter.Value() != 100 {
        t.Errorf("expected 100, got %d", counter.Value())
    }
}

// SafeCounter is properly synchronized
type SafeCounter struct {
    mu    sync.Mutex
    value int
}

func (c *SafeCounter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.value++
}

func (c *SafeCounter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}

func TestSafeCounter_NoRace(t *testing.T) {
    counter := &SafeCounter{}
    var wg sync.WaitGroup

    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter.Increment()
        }()
    }

    wg.Wait()

    if counter.Value() != 100 {
        t.Errorf("expected 100, got %d", counter.Value())
    }
}
```

### Testing with Goroutine Synchronization

Deterministic concurrent tests require explicit synchronization points rather than `time.Sleep` calls, since sleep-based approaches produce flaky tests that pass or fail depending on scheduler timing. The `Worker` below communicates via buffered channels, and tests coordinate completion through `sync.WaitGroup` and per-result timeouts using `time.After`, so the test either receives all expected results or fails fast with a clear timeout message. Using `t.Parallel()` signals that the test can run concurrently with others, improving overall suite throughput.

```go
// sync_test.go
package concurrent

import (
    "fmt"
    "sync"
    "testing"
    "time"
)

// Worker processes jobs from a channel
type Worker struct {
    jobs    chan string
    results chan string
    done    chan struct{}
}

func NewWorker() *Worker {
    w := &Worker{
        jobs:    make(chan string, 100),
        results: make(chan string, 100),
        done:    make(chan struct{}),
    }
    go w.run()
    return w
}

func (w *Worker) run() {
    for {
        select {
        case job := <-w.jobs:
            w.results <- "processed: " + job
        case <-w.done:
            return
        }
    }
}

func (w *Worker) Submit(job string) {
    w.jobs <- job
}

func (w *Worker) Result() string {
    return <-w.results
}

func (w *Worker) Stop() {
    close(w.done)
}

func TestWorker_ProcessesJobs(t *testing.T) {
    worker := NewWorker()
    defer worker.Stop()

    // Submit jobs
    worker.Submit("job1")
    worker.Submit("job2")

    // Collect results with timeout
    results := make([]string, 0, 2)
    timeout := time.After(time.Second)

    for i := 0; i < 2; i++ {
        select {
        case result := <-worker.results:
            results = append(results, result)
        case <-timeout:
            t.Fatal("timeout waiting for results")
        }
    }

    if len(results) != 2 {
        t.Errorf("expected 2 results, got %d", len(results))
    }
}

// Test with controlled timing using channels
func TestWorker_Synchronization(t *testing.T) {
    t.Parallel()

    worker := NewWorker()
    defer worker.Stop()

    var wg sync.WaitGroup
    var mu sync.Mutex
    results := make([]string, 0)

    // Producer
    wg.Add(1)
    go func() {
        defer wg.Done()
        for i := 0; i < 10; i++ {
            worker.Submit(fmt.Sprintf("job%d", i))
        }
    }()

    // Consumer
    wg.Add(1)
    go func() {
        defer wg.Done()
        for i := 0; i < 10; i++ {
            result := worker.Result()
            mu.Lock()
            results = append(results, result)
            mu.Unlock()
        }
    }()

    wg.Wait()

    if len(results) != 10 {
        t.Errorf("expected 10 results, got %d", len(results))
    }
}
```

### Testing Timeouts and Deadlines

Context-based timeout tests verify that your code responds correctly to cancellation rather than blocking indefinitely when a dependency is slow. The table-driven approach below constructs a `context.WithTimeout` for each scenario, allowing the same `Fetch` call to be exercised under both a generous deadline (where it should succeed) and a tight one (where it should return `context.DeadlineExceeded`). Using `errors.Is` instead of string comparison makes the assertion resilient to error wrapping.

```go
// timeout_test.go
package concurrent

import (
    "context"
    "errors"
    "testing"
    "time"
)

// SlowService simulates a slow external service
type SlowService struct {
    delay time.Duration
}

func (s *SlowService) Fetch(ctx context.Context) (string, error) {
    select {
    case <-time.After(s.delay):
        return "data", nil
    case <-ctx.Done():
        return "", ctx.Err()
    }
}

func TestSlowService_Timeout(t *testing.T) {
    tests := []struct {
        name      string
        delay     time.Duration
        timeout   time.Duration
        wantErr   bool
        errString string
    }{
        {
            name:    "completes before timeout",
            delay:   10 * time.Millisecond,
            timeout: 100 * time.Millisecond,
            wantErr: false,
        },
        {
            name:      "times out",
            delay:     100 * time.Millisecond,
            timeout:   10 * time.Millisecond,
            wantErr:   true,
            errString: "context deadline exceeded",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()

            service := &SlowService{delay: tt.delay}
            ctx, cancel := context.WithTimeout(context.Background(), tt.timeout)
            defer cancel()

            _, err := service.Fetch(ctx)

            if tt.wantErr {
                if err == nil {
                    t.Error("expected error, got nil")
                } else if !errors.Is(err, context.DeadlineExceeded) {
                    t.Errorf("expected DeadlineExceeded, got %v", err)
                }
            } else {
                if err != nil {
                    t.Errorf("unexpected error: %v", err)
                }
            }
        })
    }
}
```

### Testing Goroutine Leaks

A goroutine leak occurs when a goroutine is started but never exits, gradually consuming memory as the program runs. The naive detection strategy is to snapshot `runtime.NumGoroutine()` before and after the code under test and assert the count returns to baseline after a settling sleep. The `LeakyService` below omits `Stop()` to demonstrate a leak, and the commented-out line shows the fix.

Study this pattern so you can recognize it, then **do not use it**. Two sections down, `goleak` does the same job correctly. The reasons are covered right after the example.

```go
// leak_test.go
package concurrent

import (
    "runtime"
    "testing"
    "time"
)

// LeakyService has a goroutine leak
type LeakyService struct {
    stop chan struct{}
}

func NewLeakyService() *LeakyService {
    s := &LeakyService{
        stop: make(chan struct{}),
    }

    // This goroutine leaks if stop is never closed
    go func() {
        for {
            select {
            case <-s.stop:
                return
            case <-time.After(time.Millisecond):
                // Do work
            }
        }
    }()

    return s
}

func (s *LeakyService) Stop() {
    close(s.stop)
}

func TestGoroutineLeak(t *testing.T) {
    // Record initial goroutine count
    initialCount := runtime.NumGoroutine()

    // Create and use service
    service := NewLeakyService()

    // Without calling Stop(), we leak a goroutine
    // service.Stop() // Uncomment to fix the leak

    // Give goroutines time to clean up
    time.Sleep(100 * time.Millisecond)

    // Check for leaks
    finalCount := runtime.NumGoroutine()
    if finalCount > initialCount {
        t.Errorf("goroutine leak: started with %d, ended with %d",
            initialCount, finalCount)
    }
}

```

**Why the `NumGoroutine` approach is unfit for real use.** It has three defects, and they are not theoretical.

*It produces false positives.* `runtime.NumGoroutine()` is process-global, so it counts goroutines belonging to every other test running at that moment. Here is a test that leaks absolutely nothing, run alongside two well-behaved parallel neighbours:

```
initial=4 final=22  (delta=18)
FALSE POSITIVE: reported a leak but this test leaks nothing
--- FAIL: TestCleanServiceButNoisyNeighbours
```

Nothing leaked. The test failed anyway. Add `t.Parallel()` anywhere in the package and this check becomes a random number generator.

*It produces false negatives.* The `time.Sleep(100 * time.Millisecond)` is a guess about how fast the runtime will clean up. Guess low and you accuse innocent code, guess high and you slow the suite while still missing a goroutine that takes 101ms to exit.

*It tells you nothing useful when it fails.* "started with 2, ended with 3" does not say which goroutine leaked or where it was created, which is the only information you actually need.

For real leak detection, use `goleak` (`go get go.uber.org/goleak`). It captures goroutines by **stack trace** rather than by count, so it names the leaker and its creation site, ignores known runtime and library background goroutines, and retries briefly instead of sleeping a fixed interval.

```go
package concurrent

import (
    "testing"

    "go.uber.org/goleak"
)

// Package-wide: fails the package if any test leaves a goroutine behind.
// Note this cannot coexist with a test that leaks on purpose.
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// Per-test: scope leak checking to one test instead.
func TestNoLeaks(t *testing.T) {
    defer goleak.VerifyNone(t)

    service := NewLeakyService()
    service.Stop() // Must stop, or this test fails.
}
```

Compare the diagnostics. Where `NumGoroutine` said "started with 2, ended with 3", `goleak` says exactly who leaked and who created them:

```
found unexpected goroutines:
[Goroutine 7 in state select, with concurrent.NewLeakyService.func1 on top of the stack:
concurrent.NewLeakyService.func1()
created by concurrent.NewLeakyService in goroutine 6
```

That is the difference between a test you can act on and a test you delete because nobody can debug it.

Pick **one** of `VerifyTestMain` or `VerifyNone`, and know which you are choosing. `VerifyTestMain` checks once after the whole package finishes, so it catches leaks from any test but cannot tell you which test leaked, and it is incompatible with a deliberately-leaking demonstration like `TestGoroutineLeak` above: the two together fail the package even though every other test passes.

```
--- FAIL: TestGoroutineLeak
--- PASS: TestPerfectlyFine
FAIL    gl
```

`VerifyNone(t)` scopes the check to one test, attributing the leak precisely, at the cost of remembering to add it. For a package where leaks matter, `VerifyTestMain` plus a `goleak.IgnoreTopFunction` for known-noisy library goroutines is usually the better default.

### The `goroutineleak` Profile (GA in Go 1.27)

Go 1.27 promotes a `goroutineleak` profile to general availability in `runtime/pprof`, alongside the long-standing `goroutine`, `heap`, `block`, and `mutex` profiles:

```
//	goroutine      - stack traces of all current goroutines
//	goroutineleak  - stack traces of all leaked goroutines
```

It works on a fundamentally different principle from everything above, and the difference is the point. `goleak` and the `NumGoroutine` hack are both **heuristics about time**: they assume a goroutine still running after some moment must be leaked. That assumption is what forces the settling sleeps, the retries, and the ignore-lists for legitimate background workers.

The `goroutineleak` profile is instead **reachability-based**. It identifies goroutines that are permanently blocked with no possible way to make progress, for example blocked on a channel that no live goroutine retains a reference to and therefore can never be sent on or closed. That is not a guess, it is a proof: such a goroutine is unblockable for the remaining life of the process. A long-lived worker that is merely idle is not reported, because it *could* still receive work, which is exactly the distinction the time-threshold approach cannot make.

The practical consequences: no arbitrary sleep, no threshold to tune, and no false accusations against healthy background goroutines. In exchange it detects a narrower and more rigorous category, permanently-blocked goroutines, rather than "anything still alive at the end of my test". A goroutine spinning in a `for` loop forever is a leak in every practical sense and reachability analysis will not flag it, because it is not blocked.

Use it as a complement, not a replacement. `goleak` remains the right per-test assertion. The `goroutineleak` profile shines where `goleak` cannot go: a long-running production process, where you can collect it like any other pprof profile and see leaks that accumulated over days.

Note the version boundary. It was available under `GOEXPERIMENT=goroutineleakprofile` before 1.27, so on an older toolchain it needs that flag and cannot be assumed present.

### Testing Channel Behavior

Channel-based pipelines require tests that verify both the happy path, values flow correctly from input to output, and the shutdown path, closing the pipeline does not cause panics or deadlocks. The `Pipeline` below models a single processing stage that doubles values, and the test suite uses a `select` with `time.After` as a watchdog to guarantee the test itself cannot hang if the pipeline stops draining. This pattern of wrapping channel operations in a timed select prevents tests from hanging indefinitely when the code under test has a bug.

```go
// channel_test.go
package concurrent

import (
    "fmt"
    "testing"
    "time"
)

// Pipeline processes data through multiple stages
type Pipeline struct {
    input  chan int
    output chan int
    done   chan struct{}
}

func NewPipeline() *Pipeline {
    p := &Pipeline{
        input:  make(chan int, 10),
        output: make(chan int, 10),
        done:   make(chan struct{}),
    }

    // Stage 1: Double the value
    go func() {
        for {
            select {
            case v := <-p.input:
                select {
                case p.output <- v * 2:
                case <-p.done:
                    return
                }
            case <-p.done:
                return
            }
        }
    }()

    return p
}

func (p *Pipeline) Process(v int) int {
    p.input <- v
    return <-p.output
}

func (p *Pipeline) Close() {
    close(p.done)
}

func TestPipeline_Process(t *testing.T) {
    p := NewPipeline()
    defer p.Close()

    tests := []struct {
        input    int
        expected int
    }{
        {1, 2},
        {5, 10},
        {-3, -6},
        {0, 0},
    }

    for _, tt := range tests {
        t.Run(fmt.Sprintf("input=%d", tt.input), func(t *testing.T) {
            result := p.Process(tt.input)
            if result != tt.expected {
                t.Errorf("Process(%d) = %d; want %d",
                    tt.input, result, tt.expected)
            }
        })
    }
}

// Test channel closure
func TestPipeline_ClosedChannel(t *testing.T) {
    p := NewPipeline()

    // Process a value
    result := p.Process(5)
    if result != 10 {
        t.Errorf("expected 10, got %d", result)
    }

    // Close pipeline
    p.Close()

    // Verify pipeline is closed (should not block indefinitely)
    done := make(chan struct{})
    go func() {
        defer close(done)
        // This should not panic or block forever
        select {
        case p.input <- 1:
            // Channel might accept one more
        case <-time.After(100 * time.Millisecond):
            // Pipeline is properly closed
        }
    }()

    select {
    case <-done:
        // Test passed
    case <-time.After(time.Second):
        t.Fatal("test timed out - possible deadlock")
    }
}
```

### testing/synctest (Go 1.25+)

The biggest advancement in testing concurrent Go is `testing/synctest`, which shipped as a GOEXPERIMENT in 1.24 and became stable in 1.25. It runs code in a virtual-time "bubble", making time-dependent concurrent tests deterministic:

```go
func TestCacheExpiry(t *testing.T) {
    synctest.Test(t, func(t *testing.T) {
        c := NewCache(time.Minute)
        c.Set("k", "v")
        time.Sleep(61 * time.Second) // virtual time
        if _, ok := c.Get("k"); ok { t.Fatal("expected expiry") }
    })
}
```

That test really does complete instantly. The 61-second sleep is virtual:

```
--- PASS: TestCacheExpiry (0.00s)
ok      st      0.002s
```

Inside a bubble, the `time` package runs on a fake clock that starts at midnight UTC on 2000-01-01 and advances only when every goroutine in the bubble is blocked. So a `time.Sleep(24 * time.Hour)` costs nothing:

```
bubble start=2000-01-01 00:00:00 +0000 UTC, after 24h sleep=2000-01-02 00:00:00 +0000 UTC
```

This is what makes it more than a speed trick. The clock does not advance until the bubble is *idle*, meaning "wait for everything to settle, then move time forward" becomes exact rather than a `time.Sleep(100 * time.Millisecond)` guess. That is the actual source of flakiness in time-dependent tests, and it disappears.

Know the boundaries. The bubble must be self-contained. Interacting with goroutines outside it, the real network, or external processes breaks the model, and a bubble that deadlocks fails loudly rather than hanging until the test timeout:

```
panic: deadlock: all goroutines in bubble are blocked
```

which is a feature: an unfinishable test reports in milliseconds instead of ten minutes. Use it for *your* time-and-concurrency logic (caches with TTL, retry backoff, rate limiters, debouncers), not for driving a real database.

Get the API right, because it changed. The stable surface is exactly two functions:

```
func Test(t *testing.T, f func(*testing.T))
func Wait()
```

`synctest.Test` is the 1.25 stable entry point. The 1.24 experiment used `synctest.Run`, which is **gone** from the stable package, so any code or blog post calling `Run` predates the stable release and will not compile. The other function, `synctest.Wait`, blocks until every other goroutine in the bubble is durably blocked, which is how you say "let everything settle" without a sleep.

Where it applies, retire your hand-rolled `Clock` interface. Injecting a fake clock everywhere was always a workaround for the language not having one, and it leaks test concerns into production signatures.

### Staff Lens: Concurrent Test Infrastructure

Every production Go team should have:

1. `-race` in every CI run.
2. `goleak` in every concurrent package's test.
3. `testing/synctest` for time-dependent tests.
4. Deterministic tests: no sleeps, no real network, no real time.

Teams with these have concurrent tests that are fast, reliable, and catch real bugs. Teams without them have flaky tests engineers skip.

---
