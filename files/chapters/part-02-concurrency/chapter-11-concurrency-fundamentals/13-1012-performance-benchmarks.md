## 11.12 Performance Benchmarks

### Goroutine Creation Overhead

Goroutine creation is cheap relative to OS threads, and a fresh goroutine starts with a 2 KB stack, but it is not free. Read the benchmark below for what it actually measures: not creation in isolation, but the complete round-trip of allocating a channel, spawning the goroutine, scheduling it onto a thread, closing the channel, and waking the waiting benchmark goroutine. That full cycle lands near a microsecond, which is several times the roughly 300 ns that the `go` statement alone costs. The synchronisation, not the spawn, is the bulk of it.

That distinction is the useful one, because it establishes the granularity at which handing work to a goroutine pays off. Work measured in tens of nanoseconds should never be shipped to another goroutine. The coordination costs more than the work.

```go
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
// BenchmarkGoroutineCreation-8    1000000    1050 ns/op    96 B/op    1 allocs/op
```

The single allocation is the `hchan` for `done`. It escapes to the heap because the spawned closure captures it, so escape analysis cannot keep it on the stack. This is worth internalising: any channel shared with a goroutine is a heap allocation, every time.

### Channel Operations

Unbuffered channels require a sender and receiver to rendezvous, so every send blocks until the matching receive is ready, introducing synchronization overhead on each operation. Buffered channels decouple the two sides, allowing the sender to proceed without waiting as long as space remains in the buffer, which cuts per-operation cost substantially. The benchmarks below compare both modes on the same producer-consumer shape, which is the only way the two numbers mean anything next to each other.

Two rules govern these benchmarks. `b.Loop` may only be called from the benchmark's own goroutine, never from a spawned one, so the consumer ranges over the channel instead of running its own loop counter. And both variants must measure the same thing: one producer sending, one consumer receiving. A benchmark where the same goroutine sends and immediately receives from a buffered channel measures the buffer round-trip and is not comparable to a rendezvous at all.

```go
func BenchmarkUnbufferedChannel(b *testing.B) {
    ch := make(chan int)
    done := make(chan struct{})

    go func() {
        defer close(done)
        for range ch { // Drains until the producer closes ch.
        }
    }()

    for b.Loop() {
        ch <- 1
    }

    close(ch)
    <-done // Ensure the consumer is finished before returning.
}

func BenchmarkBufferedChannel(b *testing.B) {
    ch := make(chan int, 100)
    done := make(chan struct{})

    go func() {
        defer close(done)
        for range ch {
        }
    }()

    for b.Loop() {
        ch <- 1
    }

    close(ch)
    <-done
}

// Results (typical):
// BenchmarkUnbufferedChannel-8     5000000     280 ns/op
// BenchmarkBufferedChannel-8      10000000     150 ns/op
```

The gap is the rendezvous. The unbuffered send parks the producer until a consumer arrives, so each operation costs a scheduler round-trip. The buffered send usually finds room and returns without ever parking. Note what the buffer does not buy you: it does not make the channel lock-free. Every send and receive still takes the channel's internal lock, on every path. The buffer removes the blocking, not the locking.

### Worker Pool vs Direct Goroutines

Spawning a new goroutine for each unit of work is convenient but incurs allocation and scheduler overhead that adds up under high throughput. A worker pool amortizes that cost by keeping a fixed set of goroutines alive and feeding work to them over a buffered jobs channel. The benchmarks below run the same task both ways so you can see the difference on your hardware.

The workload has to be real CPU work for this comparison to mean anything. A `time.Sleep` here would measure the timer, not the scheduler: sleeps do not consume a processor, their wall-clock granularity dwarfs the microsecond being requested, and both variants would converge on the sleep duration while telling you nothing about goroutine cost. `spin` below does actual arithmetic instead.

```go
// spin does a fixed, non-elidable amount of CPU work.
func spin() uint64 {
    var acc uint64
    for i := 0; i < 200; i++ {
        acc = acc*1664525 + 1013904223
    }
    return acc
}

func BenchmarkDirectGoroutines(b *testing.B) {
    var wg sync.WaitGroup

    for b.Loop() {
        wg.Add(1)
        go func() {
            defer wg.Done()
            sink(spin())
        }()
    }
    wg.Wait()
}

func BenchmarkWorkerPool(b *testing.B) {
    jobs := make(chan func(), 1000)
    var workers sync.WaitGroup

    for i := 0; i < runtime.NumCPU(); i++ {
        workers.Add(1)
        go func() {
            defer workers.Done()
            for job := range jobs {
                job()
            }
        }()
    }

    var wg sync.WaitGroup
    for b.Loop() {
        wg.Add(1)
        jobs <- func() {
            defer wg.Done()
            sink(spin())
        }
    }
    wg.Wait()

    close(jobs)
    workers.Wait() // Do not leak the pool out of the benchmark.
}

// sink prevents the compiler from optimizing spin away.
var sinkVal uint64

func sink(v uint64) { sinkVal = v }

// Results (CPU-bound work, indicative only):
// BenchmarkDirectGoroutines-8      100000    15000 ns/op    256 B/op    2 allocs/op
// BenchmarkWorkerPool-8            200000     8500 ns/op     64 B/op    1 allocs/op
```

Treat those numbers as shape, not truth. They depend on core count, work size, and channel capacity, and the ordering can invert: when the work per item is large enough, the spawn cost disappears into the noise and the pool's extra channel hop makes it the slower option. The pool wins when the work is small and the volume is high, which is exactly when the fixed overhead per item dominates.

### Select Performance

The Go runtime evaluates `select` cases by scanning them in random order to ensure fairness, so cost scales roughly linearly with the number of cases rather than being constant. A two-case `select` costs around 60 ns on typical hardware while an eight-case statement costs closer to 280 ns, which matters in tight inner loops that fan across many channels. If your hot path requires more than a handful of cases, consider restructuring with a single multiplexed channel to keep select overhead minimal.

```go
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
```

### Mutex vs Atomic vs Channel for Counters

For the common "increment a shared counter" problem, three implementations and their costs on modern hardware:

```go
// atomic:   ~5 ns per increment
atomic.AddInt64(&counter, 1)

// mutex:    ~25 ns per increment (uncontended)
mu.Lock(); counter++; mu.Unlock()

// channel:  ~250 ns per increment (dedicated goroutine)
inc <- 1
```

Order of magnitude difference. For a hot counter, `atomic` wins. For bounded shared state with more than one field, `sync.Mutex` wins. For coordination and ownership transfer, channels win. "Share memory by communicating" is a design principle, not a performance principle. Measure before choosing.

### Contention Matters More Than Primitive Choice

The numbers above are uncontended. Under contention, `sync.Mutex` can become the bottleneck: every goroutine trying to acquire it serializes. At that point the choice is not "channel vs mutex" but "how do I reduce contention". Options:

- **Shard the state.** Replace one counter with 16 counters, each in its own cache line, summed on read. `sync/atomic` plus sharding gives near-linear scaling with core count.
- **`sync.RWMutex` for read-heavy workloads.** If reads vastly outnumber writes, RWMutex allows concurrent reads. But RWMutex has higher overhead than Mutex and wins only when read contention dominates.
- **Lock-free structures.** `sync.Map` for specific access patterns, lock-free data structures for specialized cases.
- **Change the design.** Push the contended state into a less-contended location.

The staff-level benchmark discipline: never compare primitives in isolation. Benchmark under realistic contention. A channel that "looks slow" in an uncontended microbenchmark may be equivalent in a realistic workload where both versions stall on something else.

### False Sharing

On multi-core hardware, two counters in adjacent memory locations can share a cache line. Two goroutines on different cores incrementing these counters cause cache line bouncing, which degrades performance dramatically despite no logical contention. Pad hot fields to separate cache lines:

```go
type paddedCounter struct {
    v int64
    _ [56]byte // pad to 64-byte cache line
}
```

Relevant only at the extreme end of the performance spectrum. Most services never need to think about this. Services that do should measure with `perf` or equivalent before assuming false sharing is the issue.

### Staff Lens: Benchmarks Are a Design Input, Not a Conclusion

The numbers in this section give you the cost of primitives. They do not tell you which primitive to use. The right primitive depends on the semantics you need (ownership transfer, shared state, coordination), the contention pattern, and the specific workload. A benchmark that shows channels are 10x slower than atomics is useful if you are choosing between them for an equivalent problem. It is misleading if the channel version does something the atomic version cannot. The staff-track instinct: benchmark the realistic shape of the decision, not the primitives in isolation. "My counter benchmark shows atomics win" is often answering the wrong question.

### Principal Lens: Most Go Services Are Not Concurrency-Bound

After a decade of Go at scale, the clearest lesson: the vast majority of Go service performance problems are not in the concurrency primitives. They are in: allocation (garbage collection pressure), network I/O (latency to downstream services), database queries (N+1, missing indexes), JSON serialization (reflection cost). A service that spends 5ms in concurrency overhead and 200ms in JSON serialization gets no meaningful speedup from switching mutexes to atomics. Principal-level performance work starts with profiling and follows the flame graph to the actual bottleneck. The concurrency primitives are almost never the answer.

---
