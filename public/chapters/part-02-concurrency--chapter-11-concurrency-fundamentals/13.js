export default `## 11.12 Performance Benchmarks

### Goroutine Creation Overhead

Goroutine creation is cheap relative to OS threads, typically around 1 µs and starting with a 2 KB stack, but it is not free. Benchmarking goroutine lifecycle cost with \`testing.B\` measures the complete round-trip: allocation, scheduling, execution, and channel synchronization. The result establishes the minimum granularity at which concurrency pays off versus sequential execution.

\`\`\`go
func BenchmarkGoroutineCreation(b *testing.B) {
    for b.Loop() {
        done := make(chan struct{})
        go func() {
            close(done)
        }()
        <-done
    }
}

// Results (typical):
// BenchmarkGoroutineCreation-8    1000000    1050 ns/op    0 B/op    0 allocs/op
\`\`\`

### Channel Operations

Unbuffered channels require a sender and receiver to rendezvous, so every send blocks until the matching receive is ready, introducing synchronization overhead on each operation. Buffered channels decouple the two sides, allowing the sender to proceed without waiting as long as space remains in the buffer, which cuts per-operation latency roughly in half. The benchmarks below compare both modes to give you a concrete cost baseline when choosing channel capacity for a new design.

\`\`\`go
func BenchmarkUnbufferedChannel(b *testing.B) {
    ch := make(chan int)
    go func() {
        for b.Loop() {
            ch <- i
        }
    }()

    for b.Loop() {
        <-ch
    }
}

func BenchmarkBufferedChannel(b *testing.B) {
    ch := make(chan int, 100)

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            ch <- 1
            <-ch
        }
    })
}

// Results (typical):
// BenchmarkUnbufferedChannel-8     5000000     280 ns/op
// BenchmarkBufferedChannel-8      10000000     150 ns/op
\`\`\`

### Worker Pool vs Direct Goroutines

Spawning a new goroutine for each unit of work is convenient but incurs allocation and scheduler overhead that adds up under high throughput. A worker pool amortizes that cost by keeping a fixed set of goroutines alive and feeding work to them over a buffered jobs channel, reducing allocations per operation and improving cache locality on CPU-bound tasks. The benchmarks below run the same microsecond-scale task both ways so you can see the throughput difference on your hardware.

\`\`\`go
func BenchmarkDirectGoroutines(b *testing.B) {
    var wg sync.WaitGroup
    work := func() { time.Sleep(time.Microsecond) }

    b.ResetTimer()
    for b.Loop() {
        wg.Add(1)
        go func() {
            defer wg.Done()
            work()
        }()
    }
    wg.Wait()
}

func BenchmarkWorkerPool(b *testing.B) {
    jobs := make(chan func(), 1000)
    var wg sync.WaitGroup

    // Start workers
    for i := 0; i < runtime.NumCPU(); i++ {
        go func() {
            for job := range jobs {
                job()
            }
        }()
    }

    work := func() { time.Sleep(time.Microsecond) }

    b.ResetTimer()
    for b.Loop() {
        wg.Add(1)
        jobs <- func() {
            defer wg.Done()
            work()
        }
    }
    wg.Wait()
    close(jobs)
}

// Results (for CPU-bound work):
// BenchmarkDirectGoroutines-8      100000    15000 ns/op    256 B/op    2 allocs/op
// BenchmarkWorkerPool-8            200000     8500 ns/op     64 B/op    1 allocs/op
\`\`\`

### Select Performance

The Go runtime evaluates \`select\` cases by scanning them in random order to ensure fairness, so cost scales roughly linearly with the number of cases rather than being constant. A two-case \`select\` costs around 60 ns on typical hardware while an eight-case statement costs closer to 280 ns, which matters in tight inner loops that fan across many channels. If your hot path requires more than a handful of cases, consider restructuring with a single multiplexed channel to keep select overhead minimal.

\`\`\`go
func BenchmarkSelect2Cases(b *testing.B) {
    ch1 := make(chan int, 1)
    ch2 := make(chan int, 1)
    ch1 <- 1

    for b.Loop() {
        select {
        case v := <-ch1:
            ch1 <- v
        case v := <-ch2:
            ch2 <- v
        }
    }
}

func BenchmarkSelect8Cases(b *testing.B) {
    channels := make([]chan int, 8)
    for i := range channels {
        channels[i] = make(chan int, 1)
    }
    channels[0] <- 1

    for b.Loop() {
        select {
        case v := <-channels[0]:
            channels[0] <- v
        case v := <-channels[1]:
            channels[1] <- v
        case v := <-channels[2]:
            channels[2] <- v
        case v := <-channels[3]:
            channels[3] <- v
        case v := <-channels[4]:
            channels[4] <- v
        case v := <-channels[5]:
            channels[5] <- v
        case v := <-channels[6]:
            channels[6] <- v
        case v := <-channels[7]:
            channels[7] <- v
        }
    }
}

// Results show linear scaling with number of cases
// BenchmarkSelect2Cases-8    20000000    60 ns/op
// BenchmarkSelect8Cases-8     5000000   280 ns/op
\`\`\`

### Mutex vs Atomic vs Channel for Counters

For the common "increment a shared counter" problem, three implementations and their costs on modern hardware:

\`\`\`go
// atomic:   ~5 ns per increment
atomic.AddInt64(&counter, 1)

// mutex:    ~25 ns per increment (uncontended)
mu.Lock(); counter++; mu.Unlock()

// channel:  ~250 ns per increment (dedicated goroutine)
inc <- 1
\`\`\`

Order of magnitude difference. For a hot counter, \`atomic\` wins. For bounded shared state with more than one field, \`sync.Mutex\` wins. For coordination and ownership transfer, channels win. "Share memory by communicating" is a design principle, not a performance principle. Measure before choosing.

### Contention Matters More Than Primitive Choice

The numbers above are uncontended. Under contention, \`sync.Mutex\` can become the bottleneck: every goroutine trying to acquire it serializes. At that point the choice is not "channel vs mutex" but "how do I reduce contention". Options:

- **Shard the state.** Replace one counter with 16 counters, each in its own cache line, summed on read. \`sync/atomic\` plus sharding gives near-linear scaling with core count.
- **\`sync.RWMutex\` for read-heavy workloads.** If reads vastly outnumber writes, RWMutex allows concurrent reads. But RWMutex has higher overhead than Mutex and wins only when read contention dominates.
- **Lock-free structures.** \`sync.Map\` for specific access patterns, lock-free data structures for specialized cases.
- **Change the design.** Push the contended state into a less-contended location.

The staff-level benchmark discipline: never compare primitives in isolation. Benchmark under realistic contention. A channel that "looks slow" in an uncontended microbenchmark may be equivalent in a realistic workload where both versions stall on something else.

### False Sharing

On multi-core hardware, two counters in adjacent memory locations can share a cache line. Two goroutines on different cores incrementing these counters cause cache line bouncing, which degrades performance dramatically despite no logical contention. Pad hot fields to separate cache lines:

\`\`\`go
type paddedCounter struct {
    v int64
    _ [56]byte // pad to 64-byte cache line
}
\`\`\`

Relevant only at the extreme end of the performance spectrum. Most services never need to think about this. Services that do should measure with \`perf\` or equivalent before assuming false sharing is the issue.

### Staff Lens: Benchmarks Are a Design Input, Not a Conclusion

The numbers in this section give you the cost of primitives. They do not tell you which primitive to use. The right primitive depends on the semantics you need (ownership transfer, shared state, coordination), the contention pattern, and the specific workload. A benchmark that shows channels are 10x slower than atomics is useful if you are choosing between them for an equivalent problem. It is misleading if the channel version does something the atomic version cannot. The staff-track instinct: benchmark the realistic shape of the decision, not the primitives in isolation. "My counter benchmark shows atomics win" is often answering the wrong question.

### Principal Lens: Most Go Services Are Not Concurrency-Bound

After a decade of Go at scale, the clearest lesson: the vast majority of Go service performance problems are not in the concurrency primitives. They are in: allocation (garbage collection pressure), network I/O (latency to downstream services), database queries (N+1, missing indexes), JSON serialisation (reflection cost). A service that spends 5ms in concurrency overhead and 200ms in JSON serialisation gets no meaningful speedup from switching mutexes to atomics. Principal-level performance work starts with profiling and follows the flame graph to the actual bottleneck. The concurrency primitives are almost never the answer.

---
`;
