export default `## 7.10 Common Mistakes

### 1. Ignoring Escape Analysis

Returning a pointer to a local array forces it to the heap, adding GC pressure on every call. Passing the buffer as a parameter or operating on a caller-provided slice keeps it stack-allocated, which is especially important for functions in the hot path of a server.

\`\`\`go
// BAD: Forces heap allocation
func createBuffer() *[1024]byte {
    var buf [1024]byte // Would be stack allocated
    return &buf        // Escapes to heap
}

// GOOD: Keep on stack when possible
func processBuffer() {
    var buf [1024]byte // Stack allocated
    doWork(buf[:])     // Pass slice, buffer stays on stack
}
\`\`\`

### 2. Creating Too Many Goroutines

Spawning one goroutine per request without any bound can exhaust memory when request rates spike, since each goroutine starts with at least 2KB of stack. A bounded worker pool with a fixed number of goroutines reading from a buffered channel provides predictable memory usage and natural back-pressure.

\`\`\`go
// BAD: Goroutine per request
func handleRequests(requests []Request) {
    for _, req := range requests {
        go process(req) // Millions of goroutines!
    }
}

// GOOD: Bounded worker pool
func handleRequests(requests []Request) {
    work := make(chan Request, 100)

    // Fixed number of workers
    for i := 0; i < runtime.GOMAXPROCS(0)*2; i++ {
        go func() {
            for req := range work {
                process(req)
            }
        }()
    }

    for _, req := range requests {
        work <- req
    }
    close(work)
}
\`\`\`

### 3. Blocking in Runtime Callbacks

Finalizers run on the GC goroutine, and blocking inside one can stall garbage collection for the entire program. Spawning a separate goroutine for any potentially blocking cleanup keeps the GC goroutine free and ensures finalizers complete promptly.

\`\`\`go
// BAD: Blocking in finalizer
runtime.SetFinalizer(obj, func(o *Object) {
    o.file.Close() // May block!
    <-o.done       // May block forever!
})

// GOOD: Non-blocking finalizer
runtime.SetFinalizer(obj, func(o *Object) {
    go func() {
        o.file.Close()
        <-o.done
    }()
})
\`\`\`

### 4. Not Understanding GC Impact

Appending to a zero-capacity slice in a loop triggers repeated doubling reallocations, each of which produces garbage that increases GC frequency. Pre-allocating with \`make([]Result, 0, len(items))\` performs a single allocation sized to the expected output, eliminating mid-loop garbage.

\`\`\`go
// BAD: Allocating in hot path
func processItems(items []Item) []Result {
    results := make([]Result, 0) // Reallocates multiple times
    for _, item := range items {
        results = append(results, process(item))
    }
    return results
}

// GOOD: Pre-allocate
func processItems(items []Item) []Result {
    results := make([]Result, 0, len(items)) // Single allocation
    for _, item := range items {
        results = append(results, process(item))
    }
    return results
}
\`\`\`

### 5. Misunderstanding Channel Buffering

An unbuffered done channel forces the sender goroutine to block until the receiver is ready. Using a buffered channel with capacity 1 lets the goroutine signal completion and exit immediately, regardless of when the main goroutine processes the signal.

\`\`\`go
// BAD: Unbuffered channel for signaling
func worker(done chan struct{}) {
    // Work...
    done <- struct{}{} // Blocks until receiver ready
}

// GOOD: Buffered channel for signaling
func worker(done chan struct{}) {
    // Work...
    done <- struct{}{} // Never blocks
}

func main() {
    done := make(chan struct{}, 1) // Buffered!
    go worker(done)
    // ...
    <-done
}
\`\`\`

### Detection Mechanisms

For a senior engineer building the team's review discipline, each mistake has a detection approach:

1. **Goroutine leak.** \`goleak.VerifyNone(t)\` in tests. \`runtime.NumGoroutine()\` metric in production.
2. **GOMAXPROCS in container.** Resolved by Go 1.25+ (container-aware default). Below 1.25, use \`uber-go/automaxprocs\`.
3. **Manual GC calls.** Code review. Lint rule: grep for \`runtime.GC(\` in non-test code.
4. **Concurrent map access.** \`go test -race\` catches in tests. Runtime detection in production panics the process.
5. **Unbuffered channel signalling.** Code review. Pattern recognition on the reviewer's part.

---
`;
