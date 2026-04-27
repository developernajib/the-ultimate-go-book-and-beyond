export default `## 11.16 Concurrency Performance Pitfalls

### Mistake 6: Thinking Concurrency Is Always Faster (#56)

One of the most persistent misconceptions in concurrent programming is that adding goroutines automatically makes code faster. Concurrency has real overhead: goroutine creation (~2KB stack allocation), scheduler context switching, channel synchronization, and cache coherency traffic between CPU cores. For small or fast tasks, this overhead can exceed the time saved by parallel execution.

**For CPU-bound work**, concurrency helps only up to \`GOMAXPROCS\` cores. Adding more goroutines than cores just adds context-switching overhead without improving throughput. **For small tasks**, the overhead of goroutine creation and channel communication can dwarf the actual computation time.

\`\`\`go
package main

import (
    "fmt"
    "math"
    "runtime"
    "sync"
    "testing"
)

// smallTask simulates a fast computation - microsecond-level work.
func smallTask(n int) float64 {
    return math.Sqrt(float64(n)) * math.Log(float64(n+1))
}

// largeTask simulates an expensive computation - millisecond-level work.
func largeTask(n int) float64 {
    result := 0.0
    for i := 0; i < 100_000; i++ {
        result += math.Sqrt(float64(n+i)) * math.Sin(float64(i))
    }
    return result
}

// Sequential processing - no goroutine overhead.
func processSequential(items []int, task func(int) float64) []float64 {
    results := make([]float64, len(items))
    for i, item := range items {
        results[i] = task(item)
    }
    return results
}

// Concurrent processing - goroutine + channel overhead per item.
func processConcurrent(items []int, task func(int) float64) []float64 {
    results := make([]float64, len(items))
    var wg sync.WaitGroup

    for i, item := range items {
        wg.Add(1)
        go func(idx, val int) {
            defer wg.Done()
            results[idx] = task(val)
        }(i, item)
    }

    wg.Wait()
    return results
}

// BenchmarkSmallTaskSequential - sequential wins for small tasks.
// The goroutine creation and synchronization overhead exceeds the
// computation time for each item.
func BenchmarkSmallTaskSequential(b *testing.B) {
    items := make([]int, 100)
    for i := range items {
        items[i] = i + 1
    }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        processSequential(items, smallTask)
    }
}

func BenchmarkSmallTaskConcurrent(b *testing.B) {
    items := make([]int, 100)
    for i := range items {
        items[i] = i + 1
    }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        processConcurrent(items, smallTask)
    }
}

// BenchmarkLargeTaskSequential - concurrent wins for large tasks.
// Each task takes long enough that goroutine overhead is negligible.
func BenchmarkLargeTaskSequential(b *testing.B) {
    items := make([]int, 100)
    for i := range items {
        items[i] = i + 1
    }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        processSequential(items, largeTask)
    }
}

func BenchmarkLargeTaskConcurrent(b *testing.B) {
    items := make([]int, 100)
    for i := range items {
        items[i] = i + 1
    }
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        processConcurrent(items, largeTask)
    }
}

// Typical benchmark results on an 8-core machine:
//
// BenchmarkSmallTaskSequential-8    500000    2400 ns/op     0 B/op   0 allocs/op
// BenchmarkSmallTaskConcurrent-8     10000  145000 ns/op  6400 B/op  200 allocs/op
//
// Sequential is ~60x FASTER for small tasks!
//
// BenchmarkLargeTaskSequential-8        1  1200000000 ns/op
// BenchmarkLargeTaskConcurrent-8        8   165000000 ns/op
//
// Concurrent is ~7x faster for large tasks (on 8 cores).
\`\`\`

**The merge sort example** demonstrates this clearly. A parallel merge sort that spawns goroutines for each recursive call is **slower** for small arrays because goroutine creation and channel overhead exceeds the O(n log n) comparison work:

\`\`\`go
// parallelMergeSort is SLOWER than sort.Slice for arrays under ~10,000 elements.
// The goroutine overhead dominates when the sub-problem is small.
func parallelMergeSort(data []int) []int {
    if len(data) <= 1 {
        return data
    }

    // For small slices, sequential sort is faster.
    // This threshold should be determined by benchmarking.
    const threshold = 4096
    if len(data) < threshold {
        result := make([]int, len(data))
        copy(result, data)
        sort.Ints(result)
        return result
    }

    mid := len(data) / 2
    var left, right []int
    var wg sync.WaitGroup

    wg.Add(2)
    go func() {
        defer wg.Done()
        left = parallelMergeSort(data[:mid])
    }()
    go func() {
        defer wg.Done()
        right = parallelMergeSort(data[mid:])
    }()
    wg.Wait()

    return merge(left, right)
}

func merge(left, right []int) []int {
    result := make([]int, 0, len(left)+len(right))
    i, j := 0, 0
    for i < len(left) && j < len(right) {
        if left[i] <= right[j] {
            result = append(result, left[i])
            i++
        } else {
            result = append(result, right[j])
            j++
        }
    }
    result = append(result, left[i:]...)
    result = append(result, right[j:]...)
    return result
}
\`\`\`

**Rule of thumb:** profile first, parallelize second. Use \`go test -bench\` to measure whether concurrency actually helps for your specific workload before adding goroutine complexity. The overhead of concurrency is not zero, and for many real-world tasks, sequential code is both faster and simpler.

### Mistake 7: Not Understanding Workload Type Impacts (#59)

The optimal concurrency strategy depends entirely on whether your workload is CPU-bound, I/O-bound, or memory-bound. Using the wrong strategy wastes resources and can actually degrade performance.

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                    Workload Types and Concurrency                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  CPU-BOUND (computation, hashing, compression):                     │
│  ├── Limited by number of CPU cores                                 │
│  ├── Optimal goroutines ≈ runtime.NumCPU()                         │
│  ├── More goroutines = more context switching, ZERO speedup        │
│  └── Example: image processing, cryptographic operations            │
│                                                                      │
│  I/O-BOUND (network calls, disk reads, DB queries):                │
│  ├── Goroutines spend most time blocked, waiting for I/O           │
│  ├── Can benefit from hundreds or thousands of goroutines           │
│  ├── The bottleneck is the external system, not the CPU            │
│  └── Example: HTTP clients, database queries, file processing      │
│                                                                      │
│  MEMORY-BOUND (large data set traversal, cache-heavy):             │
│  ├── Adding concurrency increases contention on memory bus         │
│  ├── More goroutines may cause cache thrashing                     │
│  ├── Optimal goroutines often < NumCPU()                           │
│  └── Example: large matrix operations, graph traversal             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

**CPU-bound worker pool** - size the pool to the number of available CPU cores:

\`\`\`go
package main

import (
    "crypto/sha256"
    "fmt"
    "runtime"
    "sync"
)

// CPUBoundPool processes CPU-intensive work with a pool sized to
// the number of CPU cores. Adding more workers beyond this point
// only increases context-switching overhead.
func CPUBoundPool(data [][]byte) []string {
    numWorkers := runtime.NumCPU()
    jobs := make(chan []byte, len(data))
    results := make(chan string, len(data))

    // Start exactly NumCPU() workers - one per core.
    var wg sync.WaitGroup
    for w := 0; w < numWorkers; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for payload := range jobs {
                hash := sha256.Sum256(payload)
                results <- fmt.Sprintf("%x", hash)
            }
        }()
    }

    // Send all work.
    for _, d := range data {
        jobs <- d
    }
    close(jobs)

    // Close results when all workers finish.
    go func() {
        wg.Wait()
        close(results)
    }()

    // Collect results.
    hashes := make([]string, 0, len(data))
    for h := range results {
        hashes = append(hashes, h)
    }
    return hashes
}
\`\`\`

**I/O-bound worker pool** - size the pool to hundreds because goroutines spend most time waiting:

\`\`\`go
package main

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "sync"
    "time"
)

// IOBoundPool fetches URLs with a pool sized for I/O-bound work.
// Each goroutine spends most of its time blocked on network I/O,
// so we can afford many more workers than CPU cores.
func IOBoundPool(ctx context.Context, urls []string) map[string]int {
    const maxConcurrent = 200 // Much larger than NumCPU()

    type result struct {
        url    string
        status int
    }

    jobs := make(chan string, len(urls))
    results := make(chan result, len(urls))

    client := &http.Client{Timeout: 10 * time.Second}

    var wg sync.WaitGroup
    for w := 0; w < maxConcurrent; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for url := range jobs {
                req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
                if err != nil {
                    results <- result{url: url, status: -1}
                    continue
                }
                resp, err := client.Do(req)
                if err != nil {
                    results <- result{url: url, status: -1}
                    continue
                }
                io.Copy(io.Discard, resp.Body)
                resp.Body.Close()
                results <- result{url: url, status: resp.StatusCode}
            }
        }()
    }

    for _, u := range urls {
        jobs <- u
    }
    close(jobs)

    go func() {
        wg.Wait()
        close(results)
    }()

    statusMap := make(map[string]int, len(urls))
    for r := range results {
        statusMap[r.url] = r.status
    }
    return statusMap
}
\`\`\`

**GOMAXPROCS configuration and its impact:**

\`\`\`go
package main

import (
    "fmt"
    "runtime"
)

func main() {
    // GOMAXPROCS controls how many OS threads can execute Go code
    // simultaneously. By default it equals the number of CPU cores.
    fmt.Printf("Default GOMAXPROCS: %d\\n", runtime.GOMAXPROCS(0))
    fmt.Printf("Available CPUs:     %d\\n", runtime.NumCPU())

    // Setting GOMAXPROCS higher than NumCPU() is almost never beneficial
    // for CPU-bound work. The OS threads compete for the same cores.
    //
    // Setting GOMAXPROCS lower than NumCPU() can be useful when:
    // - You want to leave cores free for other processes
    // - You're running multiple Go services on the same machine
    // - You need to reduce GC pause variance (fewer Ps = fewer GC workers)
    runtime.GOMAXPROCS(4) // Limit to 4 OS threads

    // Go 1.25+ (Aug 2025): GOMAXPROCS is now container-aware by default.
    // The runtime reads the cgroup CPU quota and sets GOMAXPROCS to match,
    // so a container limited to 2 CPUs on a 64-core host correctly runs
    // with GOMAXPROCS=2 out of the box. No third-party library needed.
    //
    // On Go 1.24 and earlier, GOMAXPROCS defaulted to the host core count,
    // NOT the container's CPU limit, which caused massive contention.
    // The pre-1.25 fix was the automaxprocs library:
    //
    //   import _ "go.uber.org/automaxprocs"
    //
    // If you are still on a pre-1.25 toolchain, keep automaxprocs.
    // If you are on 1.25 or later, remove it.
}
\`\`\`

**Anti-pattern, spawning unlimited goroutines for CPU-bound work:**

\`\`\`go
// BAD: Spawning one goroutine per item for CPU-bound work.
// On a 4-core machine with 100,000 items, this creates 100,000 goroutines
// that all compete for 4 cores, causing massive context switching.
func hashAllBad(data [][]byte) []string {
    results := make([]string, len(data))
    var wg sync.WaitGroup

    for i, d := range data {
        wg.Add(1)
        go func(idx int, payload []byte) {
            defer wg.Done()
            hash := sha256.Sum256(payload)
            results[idx] = fmt.Sprintf("%x", hash)
        }(i, d)
    }

    wg.Wait()
    return results
}

// GOOD: Bounded worker pool sized to CPU count.
// Workers pull from a shared channel - no more than NumCPU() goroutines
// are ever doing CPU work simultaneously.
func hashAllGood(data [][]byte) []string {
    results := make([]string, len(data))
    numWorkers := runtime.NumCPU()

    type job struct {
        idx     int
        payload []byte
    }

    jobs := make(chan job, numWorkers*2) // Small buffer to keep workers fed
    var wg sync.WaitGroup

    for w := 0; w < numWorkers; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := range jobs {
                hash := sha256.Sum256(j.payload)
                results[j.idx] = fmt.Sprintf("%x", hash)
            }
        }()
    }

    for i, d := range data {
        jobs <- job{idx: i, payload: d}
    }
    close(jobs)
    wg.Wait()

    return results
}
\`\`\`

### Mistake 8: Goroutine Self-Deadlock

One of the most confusing errors for newcomers is a goroutine that deadlocks against itself. This happens when a goroutine tries to send to an unbuffered channel with no other goroutine available to receive, or when it waits on a \`sync.WaitGroup\` that only it can resolve.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

// DEADLOCK: Sending to an unbuffered channel in the same goroutine.
// An unbuffered channel blocks the sender until a receiver is ready.
// Since there is only one goroutine (main), no receiver will ever exist.
func selfDeadlockChannel() {
    ch := make(chan int)
    ch <- 1   // Blocks forever - no other goroutine to receive
    fmt.Println(<-ch) // Never reached

    // Output:
    // fatal error: all goroutines are asleep - deadlock!
    //
    // goroutine 1 [chan send]:
    // main.selfDeadlockChannel()
    //     /tmp/main.go:13 +0x37
}

// FIX 1: Use a buffered channel.
// A buffered channel with capacity 1 can hold one value without a receiver.
func fixWithBuffer() {
    ch := make(chan int, 1) // Buffer of 1
    ch <- 1                // Succeeds - value stored in buffer
    fmt.Println(<-ch)      // Reads from buffer: prints 1
}

// FIX 2: Use a separate goroutine to send or receive.
func fixWithGoroutine() {
    ch := make(chan int)
    go func() {
        ch <- 1 // Runs in a separate goroutine
    }()
    fmt.Println(<-ch) // Main goroutine receives: prints 1
}

// DEADLOCK: Waiting on a WaitGroup in the same goroutine that
// should call Done(). The Wait() blocks forever because Done()
// is never called.
func selfDeadlockWaitGroup() {
    var wg sync.WaitGroup
    wg.Add(1)
    // wg.Done() should be called here or in another goroutine
    wg.Wait() // Blocks forever - counter never reaches 0

    // Output:
    // fatal error: all goroutines are asleep - deadlock!
}

// FIX: Launch the work in a separate goroutine.
func fixWaitGroup() {
    var wg sync.WaitGroup
    wg.Add(1)
    go func() {
        defer wg.Done()
        fmt.Println("work done")
    }()
    wg.Wait() // Returns when the goroutine calls Done()
}

// SUBTLE DEADLOCK: A function that adds to a WaitGroup and waits
// in the same scope, expecting a callback to call Done().
func subtleDeadlock() {
    var wg sync.WaitGroup
    ch := make(chan int)

    wg.Add(1)
    go func() {
        defer wg.Done()
        val := <-ch // Waits for a value on ch
        fmt.Println(val)
    }()

    wg.Wait()   // Blocks until goroutine calls Done()
    ch <- 42    // Never reached - wg.Wait() is blocking!

    // The goroutine waits for ch, main waits for wg.
    // Neither can proceed. Deadlock.
}

// FIX: Send before waiting, or restructure so there's no circular dependency.
func fixSubtleDeadlock() {
    var wg sync.WaitGroup
    ch := make(chan int, 1) // Buffered so send doesn't block

    wg.Add(1)
    go func() {
        defer wg.Done()
        val := <-ch
        fmt.Println(val)
    }()

    ch <- 42    // Send first - doesn't block with buffered channel
    wg.Wait()   // Now we can wait safely
}
\`\`\`

### Mistake 9: select{} as a Blocking Mechanism

The empty \`select{}\` statement blocks the current goroutine forever. It is sometimes used in \`main()\` to keep a program alive, but this is usually a code smell that indicates missing graceful shutdown logic.

\`\`\`go
package main

import (
    "context"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

// BAD: Using select{} to keep main alive.
// This program cannot be stopped gracefully - it ignores SIGTERM/SIGINT,
// doesn't drain connections, and doesn't flush buffers.
func mainBad() {
    go http.ListenAndServe(":8080", nil)
    select{} // Blocks forever - no way to shut down cleanly
}

// GOOD: Proper graceful shutdown with signal handling.
// This listens for OS signals, gives in-flight requests time to complete,
// and exits cleanly.
func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintln(w, "hello")
    })

    server := &http.Server{
        Addr:    ":8080",
        Handler: mux,
    }

    // Start the server in a goroutine.
    go func() {
        log.Printf("server listening on %s", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("server error: %v", err)
        }
    }()

    // Wait for interrupt signal.
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    sig := <-quit
    log.Printf("received signal %v, shutting down...", sig)

    // Give in-flight requests 30 seconds to complete.
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Fatalf("shutdown error: %v", err)
    }
    log.Println("server stopped gracefully")
}

// ALTERNATIVE (Go 1.16+): Using signal.NotifyContext for cleaner signal handling.
func mainWithNotifyContext() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintln(w, "hello")
    })

    server := &http.Server{
        Addr:    ":8080",
        Handler: mux,
    }

    go func() {
        log.Printf("server listening on %s", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("server error: %v", err)
        }
    }()

    // Block until signal is received.
    <-ctx.Done()
    log.Println("shutting down...")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Fatalf("shutdown error: %v", err)
    }
    log.Println("server stopped gracefully")
}

// WHEN select{} IS APPROPRIATE:
//
// 1. Test helpers that need to block forever (e.g., a mock server).
// 2. Long-running daemon processes where the work is entirely in
//    background goroutines and shutdown is handled by the OS/container
//    runtime (rare, but legitimate in some infrastructure tools).
//
// Even in these cases, prefer signal handling when possible.
// select{} should be a last resort, not a default pattern.

// Example: test helper where select{} is acceptable.
func startTestServer(t *testing.T) string {
    listener, err := net.Listen("tcp", "127.0.0.1:0")
    if err != nil {
        t.Fatal(err)
    }

    go func() {
        for {
            conn, err := listener.Accept()
            if err != nil {
                return // Listener closed
            }
            conn.Close()
        }
    }()

    t.Cleanup(func() {
        listener.Close()
    })

    return listener.Addr().String()
}
\`\`\`

### Staff Lens: The Concurrency-Is-Always-Faster Myth

The "more goroutines equals more speed" myth is one of the most expensive misconceptions in Go. At staff-level review, watch for:

- Parallelising a tight loop over small items (goroutine overhead dominates).
- Adding goroutines to I/O-bound code that is already maxing out the network (no speedup possible).
- Using a worker pool larger than the downstream dependency can handle (just queues work on the downstream).
- Concurrent execution where sequential ordering is actually required by the domain (race conditions masked by the concurrency that caused them).

The rule: concurrency is a design tool for handling independent work, not a speed knob. Profile before parallelising, measure after, and revert if the benchmark shows no improvement or regression.

### Principal Lens: Right-Sizing Concurrency for the Constraint

Every service has a binding constraint: CPU, memory, network, downstream throughput, database connections, lock contention. The right concurrency level is the one that saturates the binding constraint without exceeding it. More goroutines do not help past that point; fewer goroutines waste capacity. Principal-level tuning instinct: identify the constraint, size the concurrency to saturate it, and monitor for the constraint moving as the workload evolves. A service that is CPU-bound today may become database-bound next quarter as data volume grows. The concurrency tuning has to follow. Set up the monitoring that shows you when the constraint shifts.

---
`;
