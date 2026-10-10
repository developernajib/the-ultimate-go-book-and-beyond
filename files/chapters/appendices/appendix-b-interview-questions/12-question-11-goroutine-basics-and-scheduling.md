## Question 11: Goroutine Basics and Scheduling

**Level**: Mid

**Question**: What does this code print? Explain goroutine scheduling.

```go
func main() {
    go fmt.Println("Goroutine 1")
    go fmt.Println("Goroutine 2")
    go fmt.Println("Goroutine 3")

    fmt.Println("Main")
}
```

**Answer**:

Most likely output:
```
Main
```

The goroutines might not print anything because `main()` exits before they can run!

**Explanation**:

When the main goroutine exits, the program terminates immediately, regardless of other running goroutines.

**Goroutine Lifecycle**:

```go
// Goroutines are:
// 1. Lightweight (start with 2KB stack)
// 2. Multiplexed onto OS threads by Go scheduler
// 3. Not guaranteed to run if main exits
```

**Fix - WaitGroup**:

```go
func main() {
    var wg sync.WaitGroup

    wg.Add(3)

    go func() {
        defer wg.Done()
        fmt.Println("Goroutine 1")
    }()

    go func() {
        defer wg.Done()
        fmt.Println("Goroutine 2")
    }()

    go func() {
        defer wg.Done()
        fmt.Println("Goroutine 3")
    }()

    wg.Wait()  // Wait for all goroutines
    fmt.Println("Main")
}

// Possible output (order not guaranteed):
// Goroutine 2
// Goroutine 1
// Goroutine 3
// Main
```

**Go Scheduler (GMP Model)**:

```
G = Goroutine
M = Machine (OS Thread)
P = Processor (Logical CPU)

┌──────────┐
│  G1  G2  │  Goroutines (thousands)
└────┬─────┘
     │
┌────▼─────┐
│  P1  P2  │  Processors (GOMAXPROCS)
└────┬─────┘
     │
┌────▼─────┐
│  M1  M2  │  OS Threads (created as needed)
└──────────┘
```

**Scheduler Behavior**:

```go
// Example: GOMAXPROCS = 2 (2 logical processors)

func main() {
    runtime.GOMAXPROCS(2)  // Use 2 logical CPUs

    for i := 0; i < 10; i++ {
        go func(n int) {
            // CPU-bound work
            sum := 0
            for j := 0; j < 1000000; j++ {
                sum += j
            }
            fmt.Printf("Goroutine %d done\n", n)
        }(i)
    }

    time.Sleep(time.Second)
}

// The 10 goroutines will be scheduled across 2 OS threads
// Scheduler uses cooperative scheduling with preemption
```

**Scheduler Triggers**:

Goroutines yield control when:
1. **Blocking on channel** operation
2. **Blocking on system call** (network, file I/O)
3. **Sleeping** (`time.Sleep`)
4. **Waiting** on mutex
5. **Function calls** (Go 1.14+ has preemption points)
6. **Long loops** (Go 1.14+ can preempt)

```go
// Before Go 1.14, this could block other goroutines:
func cpuBound() {
    for {
        // Never yields
    }
}

// Go 1.14+ preempts after ~10ms
```

**Goroutine Leaks**:

```go
// ✗ LEAK: Goroutine never exits
func leak() {
    ch := make(chan int)

    go func() {
        val := <-ch  // Blocks forever if nothing sends
        fmt.Println(val)
    }()

    // Function returns, channel never used
}

// ✓ FIX: Use context for cancellation
func noLeak(ctx context.Context) {
    ch := make(chan int)

    go func() {
        select {
        case val := <-ch:
            fmt.Println(val)
        case <-ctx.Done():
            fmt.Println("Canceled")
            return
        }
    }()
}
```

**Goroutine Stack Growth**:

```go
// Goroutines start with small stack (2KB)
// Stack grows/shrinks automatically

func recursive(n int) {
    if n == 0 {
        return
    }
    var buf [1024]byte  // 1KB local variable
    _ = buf
    recursive(n - 1)
}

func main() {
    go recursive(1000)  // Stack grows to ~1MB, no problem!
    time.Sleep(time.Second)
}

// OS thread stack: 1-8MB fixed
// Goroutine stack: 2KB initial, grows to GB if needed
```

**Production Pattern - Goroutine Pool**:

```go
func workerPool(jobs <-chan int, results chan<- int, numWorkers int) {
    var wg sync.WaitGroup

    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            for job := range jobs {
                // Process job
                result := job * 2
                results <- result
            }
        }(i)
    }

    wg.Wait()
    close(results)
}

func main() {
    jobs := make(chan int, 100)
    results := make(chan int, 100)

    // Start 10 workers
    go workerPool(jobs, results, 10)

    // Send jobs
    for i := 0; i < 100; i++ {
        jobs <- i
    }
    close(jobs)

    // Collect results
    for result := range results {
        fmt.Println(result)
    }
}
```

**Companies that asked this**: Google, Uber, Netflix, Cloudflare

---
