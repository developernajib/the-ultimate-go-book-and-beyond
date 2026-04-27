export default `## 11.13 Common Mistakes and Anti-Patterns

### Mistake 1: Forgetting Goroutine Cleanup

Launching goroutines with \`go\` and never tracking them creates goroutine leaks: the goroutine continues consuming memory and scheduler time even after the work it was created for has become irrelevant. Using a \`sync.WaitGroup\` in combination with context cancellation ensures every spawned goroutine has a clear path to exit and the parent can block until all in-flight work drains cleanly.

\`\`\`go
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
\`\`\`

### Mistake 2: Unbounded Concurrency

Spawning one goroutine per input item works fine for small slices but becomes a resource exhaustion problem at scale: ten thousand URLs would create ten thousand simultaneous goroutines, overwhelming the network stack and the Go scheduler alike. A semaphore channel with a fixed capacity acts as a concurrency limiter, allowing only a controlled number of goroutines to proceed at any given moment.

\`\`\`go
// BAD: Can spawn unlimited goroutines
func fetchAll(urls []string) {
    for _, url := range urls {
        go fetch(url)  // 10,000 URLs = 10,000 goroutines
    }
}

// GOOD: Bounded concurrency
func fetchAll(ctx context.Context, urls []string) {
    sem := make(chan struct{}, 10)  // Max 10 concurrent
    var wg sync.WaitGroup

    for _, url := range urls {
        wg.Add(1)
        go func(u string) {
            defer wg.Done()

            select {
            case <-ctx.Done():
                return
            case sem <- struct{}{}:
                defer func() { <-sem }()
                fetch(u)
            }
        }(url)
    }

    wg.Wait()
}
\`\`\`

### Mistake 3: Closing Channels from Receiver

Closing a channel from the receiver side is dangerous because the sender may still be writing to it, which causes a panic on the closed channel. The established Go convention is that only the sending side, the party that knows when data production is complete, should call \`close\`, typically via \`defer close(ch)\` right where the channel is created.

\`\`\`go
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
\`\`\`

### Mistake 4: Not Handling Channel Closure

A receive from a closed channel does not block. It immediately returns the zero value for the element type, so a bare \`v := <-ch\` loop will spin infinitely processing meaningless zero values after the sender closes the channel. The two-value receive form \`v, ok := <-ch\` exposes the closure signal, though \`for v := range ch\` is the idiomatic and least error-prone way to consume a channel until it closes.

\`\`\`go
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
\`\`\`

### Mistake 5: Data Race on Shared State

Concurrent goroutines that read and write a plain integer variable without synchronization create a data race: the Go memory model makes no guarantee about the order or visibility of those accesses, so the final count can be less than expected and the program's behavior is undefined. \`sync/atomic\` provides lock-free integer operations that are safe across goroutines without the overhead of a full mutex.

\`\`\`go
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
\`\`\`

### Mistake 6: time.After in Long-Running Loops

\`time.After(d)\` allocates a timer that survives until the duration elapses, even if the outer select proceeds via a different case. In a hot loop, this leaks timers at request rate.

\`\`\`go
// BAD: timer leaks per iteration
for {
    select {
    case v := <-ch: handle(v)
    case <-time.After(time.Second): return
    }
}

// GOOD: reset a single timer
timer := time.NewTimer(time.Second)
defer timer.Stop()
for {
    select {
    case v := <-ch:
        handle(v)
        if !timer.Stop() { <-timer.C }
        timer.Reset(time.Second)
    case <-timer.C: return
    }
}
\`\`\`

### Mistake 7: sync.Mutex Copied by Value

\`sync.Mutex\` must not be copied. Passing a struct that contains a mutex by value creates two mutexes, and locking one does not lock the other. \`go vet\` catches this, but only if the mutex is not embedded in a way that hides the copy.

\`\`\`go
type Counter struct { mu sync.Mutex; v int }

func (c Counter) Inc() { c.mu.Lock(); c.v++; c.mu.Unlock() } // BUG: value receiver copies mutex

// FIX: pointer receiver
func (c *Counter) Inc() { c.mu.Lock(); c.v++; c.mu.Unlock() }
\`\`\`

### Mistake 8: Goroutines Without Context

A goroutine that calls I/O or blocking operations without accepting a \`context.Context\` cannot be cancelled. This is the most common cause of goroutine leaks in modern Go services. The fix is universal: every function that may block takes \`context.Context\` as the first argument, and passes it to every I/O call.

### Mistake 9: Select Without Default on Non-Blocking Intent

A non-blocking send or receive requires \`default\`. Forgetting it turns the operation into a blocking one, which may deadlock.

\`\`\`go
// BAD: blocks if channel full
select {
case ch <- v:
}

// GOOD: non-blocking send
select {
case ch <- v:
default: // channel full, drop
}
\`\`\`

### Mistake 10: Fan-Out Without Error Propagation

Spawning goroutines without a mechanism to collect their errors means failures are silently swallowed. \`errgroup.Group\` solves this. Using raw \`sync.WaitGroup\` without an error channel should be a review finding in modern Go.

### Mistake 11: Double-Close Panic

Closing a channel twice panics. Closing a channel that another goroutine also writes to causes a send-on-closed panic. The "only the sender closes, only once" rule prevents both. When multiple senders converge on a channel, introduce a coordinator goroutine that owns the close.

### Staff Lens: The Anti-Pattern Inventory

Most production concurrency incidents trace back to one of the mistakes above. The staff-level deliverable: a checklist of these anti-patterns, reviewed against every concurrent PR, automated where possible. Items one through five of this list are detectable by \`go vet\`, \`staticcheck\`, or \`goleak\`. Items six through eleven require review discipline. A team that applies this checklist consistently has dramatically fewer concurrency incidents than one that re-learns each lesson per engineer. The rate at which a team avoids these mistakes is a leading indicator of engineering maturity.

### Principal Lens: The Cultural Patterns That Prevent These Mistakes

The deeper question is not "how do we avoid mistake N?" but "what culture prevents these mistakes at the systemic level?" Three cultural interventions that matter:

1. **Every goroutine design is reviewed before code.** The lifetime and termination path are specified at design time, not discovered in production.
2. **\`goleak\` and \`-race\` are blocking CI gates.** Code that introduces leaks or races cannot merge.
3. **Postmortems for concurrency incidents become teaching material.** Every team member reads the incident, understands the pattern, and applies the prevention.

Principal engineers who invest in these cultural patterns have lower incident rates. Principal engineers who only patch the individual bugs have the same bugs recur. The payoff from cultural work is slow but compounding.

---
`;
