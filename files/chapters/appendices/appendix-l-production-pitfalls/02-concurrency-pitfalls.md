## Concurrency Pitfalls

Concurrency is Go's flagship capability, but concurrent runtime bugs account for the vast majority of severe production outages. In Go, race conditions and deadlocks do not always manifest as immediate panics; they frequently produce silent memory corruption, corrupt database records, and orphaned goroutines that exhaust cluster memory over days.

---

### 1. The Channel Closure Panic & Send on Closed Channel

#### Root Cause Mechanics
A send on a closed channel panics immediately (`panic: send on closed channel`). Closing an already closed channel also panics (`panic: close of closed channel`). Only the producer (the sender) should ever close a channel, and only when there is exactly one sender. When multiple goroutines write to a shared channel, calling `close()` from any sender creates a race condition that crashes the entire process.

#### Vulnerable Code
```go
// BUG: Multiple producers attempting to close a shared channel
func broadcast(ch chan int, wg *sync.WaitGroup) {
    for i := 0; i < 5; i++ {
        go func(val int) {
            defer wg.Done()
            ch <- val
            close(ch) // PANIC: Second goroutine to reach here crashes the service!
        }(i)
    }
}
```

#### Production-Grade Solution
```go
// FIX: Coordinate channel closure using a coordinator goroutine and sync.WaitGroup
func SafeBroadcast(data []int) <-chan int {
    out := make(chan int, len(data))
    var wg sync.WaitGroup

    for _, v := range data {
        wg.Add(1)
        go func(val int) {
            defer wg.Done()
            out <- val
        }(v)
    }

    // Single coordinator closes channel only after all producers finish
    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}
```

---

### 2. Goroutine Leaks from Blocked Channel Sends

#### Root Cause Mechanics
If a worker goroutine attempts to send to an unbuffered channel (or a full buffered channel) where no receiver is reading, that goroutine blocks indefinitely. In Go, the garbage collector **cannot** collect a blocked goroutine, even if all references to the channel are dropped. Over time, leaked goroutines consume RAM and file descriptors until Kubernetes terminates the pod with an OOMKilled signal.

#### Vulnerable Code
```go
// BUG: If ctx cancels before query finishes, the background goroutine blocks forever on ch <- result
func QueryFirst(ctx context.Context, servers []string) string {
    ch := make(chan string) // Unbuffered!
    for _, s := range servers {
        go func(server string) {
            res := ping(server)
            ch <- res // LEAK: If QueryFirst returns early, this send blocks forever!
        }(s)
    }
    return <-ch
}
```

#### Production-Grade Solution
```go
// FIX: Use a buffered channel matching the number of workers OR select on context cancellation
func QueryFirstSafe(ctx context.Context, servers []string) string {
    ch := make(chan string, len(servers)) // Buffer guarantees send will never block
    for _, s := range servers {
        go func(server string) {
            select {
            case <-ctx.Done():
                return // Discard work cleanly
            case ch <- ping(server):
            }
        }(s)
    }

    select {
    case <-ctx.Done():
        return ""
    case res := <-ch:
        return res
    }
}
```

---

### 3. Loop Variable Capture in Goroutines (Pre-1.22 vs 1.22+)

#### Root Cause Mechanics
In Go versions prior to 1.22, the for-loop variable was allocated once per loop, not per iteration. Launching a goroutine that captured the loop variable by reference caused all goroutines to observe only the final iteration value. While Go 1.22 scoped loop variables per-iteration, older codebases and closures over pointers still suffer from this bug.

#### Vulnerable Code
```go
// BUG (in Go <1.22 or with pointer slices):
items := []*Item{a, b, c}
for _, item := range items {
    go func() {
        process(item) // Dangerous: If items slice is modified concurrently
    }()
}
```

#### Production-Grade Solution
```go
// FIX: Always pass loop variables explicitly as arguments to the goroutine
for _, item := range items {
    go func(target *Item) {
        process(target)
    }(item)
}
```

---

### 4. Detection & Runbook Verification
- Always execute tests with the race detector enabled: `go test -race ./...`
- Monitor goroutine counts in Prometheus: `go_goroutines` metric. If the metric exhibits a monotonically increasing slope, a goroutine leak is present.
- Inspect blocked goroutines in real-time via `curl http://localhost:6060/debug/pprof/goroutine?debug=2`.
