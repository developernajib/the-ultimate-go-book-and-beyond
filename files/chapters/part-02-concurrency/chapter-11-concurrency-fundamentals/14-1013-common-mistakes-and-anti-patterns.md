## 11.13 Common Mistakes and Anti-Patterns

### Mistake 1: Forgetting Goroutine Cleanup

Launching goroutines with `go` and never tracking them creates goroutine leaks: the goroutine continues consuming memory and scheduler time even after the work it was created for has become irrelevant. Using a `sync.WaitGroup` in combination with context cancellation ensures every spawned goroutine has a clear path to exit and the parent can block until all in-flight work drains cleanly.

```go
// BAD: Goroutines may never terminate
func processRequests(requests <-chan Request) {
    for req := range requests {
        go process(req)  // Fire and forget!
    }
}

// GOOD: Track and wait for goroutines
func processRequests(ctx context.Context, requests <-chan Request) {
    var wg sync.WaitGroup

    for {
        select {
        case <-ctx.Done():
            wg.Wait()  // Wait for in-flight work
            return
        case req, ok := <-requests:
            if !ok {
                wg.Wait()
                return
            }
            wg.Add(1)
            go func(r Request) {
                defer wg.Done()
                process(r)
            }(req)
        }
    }
}
```

### Mistake 2: Unbounded Concurrency

Spawning one goroutine per input item works fine for small slices but becomes a resource exhaustion problem at scale: ten thousand URLs would create ten thousand simultaneous goroutines, overwhelming the network stack and the Go scheduler alike. A semaphore channel with a fixed capacity acts as a concurrency limiter.

Where you acquire the semaphore is the entire lesson. Acquiring *inside* the goroutine is the trap, and it looks correct enough to pass review: it does bound the concurrent `fetch` calls to ten. What it does not bound is the goroutines. All ten thousand still get spawned, and 9,990 of them sit parked on the semaphore holding a stack apiece. You have capped the expensive resource and left the one you were worried about untouched. Acquire *before* the `go` statement and the loop itself becomes the throttle, so at most ten goroutines exist at any moment.

```go
// BAD: Can spawn unlimited goroutines
func fetchAll(urls []string) {
    for _, url := range urls {
        go fetch(url)  // 10,000 URLs = 10,000 goroutines
    }
}

// ALSO BAD: bounds the fetches, not the goroutines.
// Still 10,000 goroutines, 9,990 of them blocked on the semaphore.
func fetchAll(ctx context.Context, urls []string) {
    sem := make(chan struct{}, 10)
    var wg sync.WaitGroup

    for _, url := range urls {
        wg.Add(1)
        go func(u string) {
            defer wg.Done()
            sem <- struct{}{}
            defer func() { <-sem }()
            fetch(u)
        }(url)
    }
    wg.Wait()
}

// GOOD: acquire before spawning. At most 10 goroutines are ever alive.
func fetchAll(ctx context.Context, urls []string) {
    sem := make(chan struct{}, 10)  // Max 10 concurrent
    var wg sync.WaitGroup

    for _, url := range urls {
        select {
        case <-ctx.Done():
            wg.Wait()
            return
        case sem <- struct{}{}:
        }

        wg.Add(1)
        go func(u string) {
            defer wg.Done()
            defer func() { <-sem }()
            fetch(u)
        }(url)
    }

    wg.Wait()
}
```

### Mistake 3: Closing Channels from Receiver

Closing a channel from the receiver side is dangerous because the sender may still be writing to it, which causes a panic on the closed channel. The established Go convention is that only the sending side, the party that knows when data production is complete, should call `close`, typically via `defer close(ch)` right where the channel is created.

```go
// BAD: Receiver closing channel
func consumer(ch chan int) {
    for v := range ch {
        process(v)
    }
    close(ch)  // WRONG: receiver shouldn't close
}

// GOOD: Sender closes channel
func producer(ch chan<- int) {
    defer close(ch)  // Sender closes when done
    for i := 0; i < 10; i++ {
        ch <- i
    }
}
```

### Mistake 4: Not Handling Channel Closure

A receive from a closed channel does not block. It immediately returns the zero value for the element type, so a bare `v := <-ch` loop will spin infinitely processing meaningless zero values after the sender closes the channel. The two-value receive form `v, ok := <-ch` exposes the closure signal, though `for v := range ch` is the idiomatic and least error-prone way to consume a channel until it closes.

```go
// BAD: Ignores channel closure
for {
    v := <-ch  // Returns zero value when closed!
    process(v)
}

// GOOD: Check if channel is closed
for {
    v, ok := <-ch
    if !ok {
        return  // Channel closed
    }
    process(v)
}

// BETTER: Use range
for v := range ch {
    process(v)
}
```

### Mistake 5: Data Race on Shared State

Concurrent goroutines that read and write a plain integer variable without synchronization create a data race. `counter++` is not one operation but three: load, add, store. Two goroutines interleaving those steps both read the same value and both write back the same increment, so one update is lost and the final count comes out below 1000.

Be careful about *why* this is wrong, because the usual explanation is imported from C++ and does not apply. A data race in Go is not undefined behaviour. The Go memory model is deliberate on this point: an implementation may report the race and terminate, but otherwise a read of a word-sized location must observe some value actually written to it, not a fabricated one. That places Go alongside Java rather than C and C++, where a race poisons the meaning of the entire program. The practical consequence is that this loop does not summon demons, it simply loses updates. That is still a bug, and it is still worth failing the build over, but describing it as undefined behaviour teaches the wrong model of the language.

`sync/atomic` makes the read-modify-write indivisible, which is exactly the missing property.

```go
// BAD: Race condition
var counter int
var wg sync.WaitGroup

for i := 0; i < 1000; i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        counter++  // RACE!
    }()
}

// GOOD: Use atomic or mutex
var counter atomic.Int64

for i := 0; i < 1000; i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        counter.Add(1)  // Safe
    }()
}
```

### Mistake 6: time.After in Long-Running Loops (Pre-1.23 Modules)

Historically, `time.After(d)` allocated a timer that survived until the duration elapsed, even when the select proceeded via a different case. In a hot loop this leaked timers at request rate. Go 1.23 fixed it for modules with `go 1.23` or higher: unreferenced timers are collected immediately, and the unbuffered timer channels also made the old drain-before-Reset idiom unnecessary. Go 1.27 removes the transition escape hatch entirely.

```go
// Pre-1.23 modules: timer leaked per iteration
for {
    select {
    case v := <-ch: handle(v)
    case <-time.After(time.Second): return
    }
}

// Still the cheapest form in hot loops (avoids per-iteration
// allocation), and the only safe form on pre-1.23 modules
timer := time.NewTimer(time.Second)
defer timer.Stop()
for {
    select {
    case v := <-ch:
        handle(v)
        timer.Reset(time.Second) // pre-1.23 modules also need the
                                 // if !timer.Stop() { <-timer.C } drain
    case <-timer.C: return
    }
}
```

The 2026 code-review posture: on a modern module, `time.After` in a loop is a performance nit, not a leak. Flag it in hot paths, let it pass elsewhere, and correct anyone who still calls it a leak on a 1.23+ module.

### Mistake 7: sync.Mutex Copied by Value

`sync.Mutex` must not be copied. Passing a struct that contains a mutex by value creates two mutexes, and locking one does not lock the other. `go vet` catches this, but only if the mutex is not embedded in a way that hides the copy.

```go
type Counter struct { mu sync.Mutex; v int }

func (c Counter) Inc() { c.mu.Lock(); c.v++; c.mu.Unlock() } // BUG: value receiver copies mutex

// FIX: pointer receiver
func (c *Counter) Inc() { c.mu.Lock(); c.v++; c.mu.Unlock() }
```

### Mistake 8: Goroutines Without Context

A goroutine that calls I/O or blocking operations without accepting a `context.Context` cannot be canceled. This is the most common cause of goroutine leaks in modern Go services. The fix is universal: every function that may block takes `context.Context` as the first argument, and passes it to every I/O call.

### Mistake 9: Select Without Default on Non-Blocking Intent

A non-blocking send or receive requires `default`. Forgetting it turns the operation into a blocking one, which may deadlock.

```go
// BAD: blocks if channel full
select {
case ch <- v:
}

// GOOD: non-blocking send
select {
case ch <- v:
default: // channel full, drop
}
```

### Mistake 10: Fan-Out Without Error Propagation

Spawning goroutines without a mechanism to collect their errors means failures are silently swallowed. `errgroup.Group` solves this. Using raw `sync.WaitGroup` without an error channel should be a review finding in modern Go.

### Mistake 11: Double-Close Panic

Closing a channel twice panics. Closing a channel that another goroutine also writes to causes a send-on-closed panic. The "only the sender closes, only once" rule prevents both. When multiple senders converge on a channel, introduce a coordinator goroutine that owns the close.

### Staff Lens: The Anti-Pattern Inventory

Most production concurrency incidents trace back to one of the mistakes above. The staff-level deliverable: a checklist of these anti-patterns, reviewed against every concurrent PR, automated where possible.

Be honest about how little of this the tools actually catch. `-race` catches mistake 5 when a test happens to exercise the interleaving. `goleak` catches mistake 1 when a test leaves the goroutine behind. `go vet`'s `copylocks` catches mistake 7 outright, and it is the only one on the list a tool reliably rejects. Everything else, unbounded fan-out, closing from the receiver, ignoring closure, missing context, absent error propagation, is invisible to the toolchain: each is a perfectly legal Go program. That is precisely why the review checklist exists. Automation covers the narrow slice it can, and human discipline covers the rest. A team that applies this checklist consistently has dramatically fewer concurrency incidents than one that re-learns each lesson per engineer. The rate at which a team avoids these mistakes is a leading indicator of engineering maturity.

### Principal Lens: The Cultural Patterns That Prevent These Mistakes

The deeper question is not "how do we avoid mistake N?" but "what culture prevents these mistakes at the systemic level?" Three cultural interventions that matter:

1. **Every goroutine design is reviewed before code.** The lifetime and termination path are specified at design time, not discovered in production.
2. **`goleak` and `-race` are blocking CI gates.** Code that introduces leaks or races cannot merge.
3. **Postmortems for concurrency incidents become teaching material.** Every team member reads the incident, understands the pattern, and applies the prevention.

Principal engineers who invest in these cultural patterns have lower incident rates. Principal engineers who only patch the individual bugs have the same bugs recur. The payoff from cultural work is slow but compounding.

---
