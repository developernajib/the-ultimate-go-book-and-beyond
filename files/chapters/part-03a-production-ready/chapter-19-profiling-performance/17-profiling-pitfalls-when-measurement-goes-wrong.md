## Profiling Pitfalls: When Measurement Goes Wrong

Profiling mistakes can be more costly than the bugs they aim to fix. Engineers who profile incorrectly often optimize the wrong code, miss the real bottleneck, or, worst case, degrade performance while believing they improved it.

### The Premature Optimization Trap

**The Story**: A team spent 3 weeks optimizing JSON parsing to use zero-allocation techniques. CPU profiles showed JSON parsing was 5% of CPU time. After optimization, it was 3%. Total system performance improvement: unmeasurable. Meanwhile, database queries (70% of latency) remained unaddressed.

```go
// WRONG: Optimizing without profiling first

// "JSON must be slow, let's optimize it!"
func parseUserOptimized(data []byte) (*User, error) {
    // Weeks of work on custom zero-alloc JSON parser
    // But JSON was never the bottleneck
    return customJSONParser(data)
}

// What they should have done first:
// go test -cpuprofile cpu.prof -bench .
// go tool pprof cpu.prof
// (pprof) top10
//
// Showing top 10 nodes out of 150
//       flat  flat%   sum%        cum   cum%
//     15.2s  70.5%  70.5%     15.2s  70.5%  database/sql.(*DB).Query
//      2.1s   9.7%  80.2%      2.1s   9.7%  net/http.(*conn).readRequest
//      1.1s   5.1%  85.3%      1.1s   5.1%  encoding/json.Unmarshal  <-- Not the bottleneck!
```

### Profiling in the Wrong Environment

**The Trap**: Profiling on a developer laptop, then deploying to production with completely different characteristics.

```go
// Profile looks great on laptop with SSD and 32GB RAM
// Production has:
// - Network storage with 10ms latency
// - 4GB RAM with GC pressure
// - 200 concurrent users instead of 1
// - Noisy neighbors on shared infrastructure

// WRONG: Benchmark on empty system
func BenchmarkProcessOrder(b *testing.B) {
    // Database is local, empty, no concurrent load
    for b.Loop() {
        ProcessOrder(testOrder)
    }
}

// BETTER: Benchmark with realistic conditions
func BenchmarkProcessOrder_Realistic(b *testing.B) {
    // Simulate concurrent load for the duration of the benchmark
    ctx, cancel := context.WithCancel(context.Background())
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            simulateBackgroundLoad(ctx) // loops until ctx is canceled
        }()
    }
    b.Cleanup(func() { cancel(); wg.Wait() })

    for b.Loop() {
        ProcessOrder(testOrder)
    }
}
```

### The Memory Profiling Misconception

**The Misunderstanding**: "Allocations are always bad."

```go
// WRONG: Avoiding allocations at all costs

var globalBuffer = make([]byte, 1<<20)  // 1MB global buffer
var globalMutex sync.Mutex

func ProcessDataWrong(data []byte) []byte {
    globalMutex.Lock()
    defer globalMutex.Unlock()

    // "Zero allocations!"
    // But: mutex contention, no parallelism, buffer reuse bugs
    copy(globalBuffer, data)
    process(globalBuffer[:len(data)])
    return globalBuffer[:len(data)]  // 🚨 Returns reference to global!
}

// CORRECT: Sometimes allocations are fine

func ProcessDataRight(data []byte) []byte {
    // One allocation per call - but fully parallel, no contention
    result := make([]byte, len(data))
    copy(result, data)
    process(result)
    return result
}

// ALSO CORRECT: sync.Pool for high-throughput scenarios.
// Pool a *pointer* to the slice. Pooling the slice by value makes every Put
// box the slice header into the interface, which allocates 24 bytes and
// quietly defeats the point of the pool.

var bufferPool = sync.Pool{
    New: func() any {
        buf := make([]byte, 0, 4096)
        return &buf
    },
}

func ProcessDataPooled(data []byte) []byte {
    bufPtr := bufferPool.Get().(*[]byte)
    buf := (*bufPtr)[:0]  // Reset length, keep capacity

    buf = append(buf, data...)
    process(buf)

    // Copy out before the buffer goes back: the caller must not alias pool memory.
    result := slices.Clone(buf)

    *bufPtr = buf  // Store back, so any growth from append is retained
    bufferPool.Put(bufPtr)

    return result
}
```

### The CPU Profile Blind Spot (and a Myth About It)

First, the myth, because it is widely repeated and it is false.

**Myth**: "CPU profiles sample at 100Hz, so a function that takes only a microsecond per call will never be sampled and shows up as 0%, even if it is called millions of times."

This misunderstands what is being sampled. The profiler does not sample *calls*, it samples *time*. Every 10ms it stops and records whichever stack is currently on-CPU. A function's share of the profile is therefore its share of CPU time, and the duration of any individual call is irrelevant. A function that burns 65% of your CPU across three million one-microsecond calls occupies 65% of the samples, exactly as it should.

Verified on the machine used for this book, calling `quickHash` three million times alongside a chunky compute loop:

```
      flat  flat%   sum%        cum   cum%
     230ms 65.71% 65.71%      230ms 65.71%  hash/fnv.(*sum64a).Write (inline)
     120ms 34.29%   100%      120ms 34.29%  main.slowLoop (inline)
         0     0%   100%      230ms   100%  main.quickHash
```

Not 0%. It is the top entry, correctly identified as the dominant cost. Statistical sampling works, and short functions do not hide from it.

That output does reveal a genuine subtlety, though: `main.quickHash` has a **flat time of 0** while its **cumulative time is 65.71%**. The work was inlined into `fnv.(*sum64a).Write`, so the flat time is attributed there. Sort a profile by flat time alone and a heavily inlined function can look innocent. Read the `cum` column, and use `-gcflags=-m` or `//go:noinline` when you need to see through an inlining decision.

**The real blind spot is time your program spends not running at all.** A CPU profile can only sample goroutines that are on-CPU. Every microsecond spent blocked on a mutex, a channel, a syscall, or a network read is invisible to it. Here is a program whose two goroutines run for two seconds of wall clock, one burning CPU and one sleeping:

```
Duration: 2s, Total samples = 30ms ( 1.50%)
      flat  flat%   sum%        cum   cum%
      30ms   100%   100%       30ms   100%  main.cpuWork
```

The two seconds of blocking are simply absent. `blockedOnIO` does not appear anywhere in the profile, at any percentage. If you were hunting a two-second latency with only a CPU profile, you would find nothing and conclude the code was fast, which it is. It just was not running.

Learn to read that header line. **`Total samples` far below `Duration` means your program spends most of its time waiting, not computing**, and it is telling you to stop reading the CPU profile. At 1.50% here, the CPU profile has already answered its only useful question: the bottleneck is not CPU.

Where to look instead, depending on what it is waiting for:

- **`go tool trace`** shows the timeline: exactly when a goroutine blocked, on what, and for how long.
- **The block profile** shows time blocked on channels and mutexes. Remember it records nothing until you call `runtime.SetBlockProfileRate`.
- **The mutex profile** shows lock contention, and likewise requires `runtime.SetMutexProfileFraction` before it records anything.
- **Distributed tracing** shows time spent in downstream services, which no runtime profile can see.

### The GC Blame Game

**The Misconception**: "GC pauses are killing our latency."

```go
// WRONG: Blaming GC without evidence

// "Our P99 is 100ms, must be GC!"
// Actual GC pause time: 500μs
// Actual problem: Database connection pool exhaustion

// How to actually measure GC impact:
// GODEBUG=gctrace=1 ./myservice
//
// gc 1 @0.012s 2%: 0.019+0.32+0.004 ms clock, 0.15+0.11/0.28/0.044+0.035 ms cpu, 4->4->1 MB, 4 MB goal, 8 P
//       ↑                        ↑
//       STW pause                Total GC CPU time

// If STW pause is microseconds but latency is milliseconds, GC is NOT the problem

// Real investigation:
func investigateLatency() {
    // 1. Check GC metrics
    var stats runtime.MemStats
    runtime.ReadMemStats(&stats)
    fmt.Printf("GC Pauses: %d\n", stats.NumGC)
    fmt.Printf("Total GC Pause: %v\n", time.Duration(stats.PauseTotalNs))
    fmt.Printf("Last GC Pause: %v\n", time.Duration(stats.PauseNs[(stats.NumGC+255)%256]))

    // 2. If GC pauses are small, look elsewhere:
    // - Database query time
    // - Network latency
    // - Lock contention
    // - Goroutine scheduling delays
}
```

### The sync.Pool Misuse

**Common Mistakes**: Using sync.Pool incorrectly and making things worse.

```go
// WRONG: Pool with pointers to small objects

var smallPool = sync.Pool{
    New: func() any {
        return new(int)  // 🚨 8 bytes - Pool overhead exceeds benefit
    },
}

// WRONG: Pool that's rarely used

var rarelyUsedPool = sync.Pool{
    New: func() any {
        return make([]byte, 1<<20)  // 1MB buffer
    },
}

func rareOperation() {
    buf := rarelyUsedPool.Get().([]byte)
    defer rarelyUsedPool.Put(buf)
    // Called once per hour - pool is cleared between uses!
    // You're just adding overhead
}

// WRONG: Putting dirty objects back, and leaking pooled memory to the caller

var bufPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

func processWrong(data []byte) []byte {
    buf := bufPool.Get().(*bytes.Buffer)
    // Bug 1: not resetting. Whatever the last user wrote is still in here.
    buf.Write(data)
    result := buf.Bytes()  // Bug 2: aliases the buffer's internal array
    bufPool.Put(buf)       // ...which now belongs to the pool. result is doomed.
    return result
}

// CORRECT: Proper sync.Pool usage

func processCorrect(data []byte) []byte {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Reset()  // Always reset before use: Get gives you someone else's leftovers

    buf.Write(data)

    // Copy out. The caller must not hold memory the pool is about to hand away.
    result := slices.Clone(buf.Bytes())

    buf.Reset()  // Clear before returning: do not leave data sitting in the pool
    bufPool.Put(buf)

    return result
}
```

Note that `processWrong` has two independent bugs, and only the first one is obvious. Failing to `Reset` means you inherit the previous user's bytes. But `return buf.Bytes()` followed by `Put` is the more dangerous one, because it hands the caller a slice backed by memory the pool is simultaneously handing to another goroutine. That is the cross-request data leak from earlier in this chapter, and no amount of resetting fixes it. Copy on the way out.

### Benchmarking Lies

**The Problem**: Benchmarks that don't measure what you think they measure.

```go
// LIE 1: Compiler optimization eliminates the work

func BenchmarkCompilerOptimizedAway(b *testing.B) {
    data := []byte("test data")
    for b.Loop() {
        _ = sha256.Sum256(data)  // Result unused - might be optimized away!
    }
}

// TRUTH: Use the result

var benchResult [32]byte

func BenchmarkActualWork(b *testing.B) {
    data := []byte("test data")
    for b.Loop() {
        benchResult = sha256.Sum256(data)
    }
}

// LIE 2: Setup time included in benchmark

func BenchmarkIncludesSetup(b *testing.B) {
    for b.Loop() {
        data := generateLargeDataset()  // 🚨 Setup in loop!
        process(data)
    }
}

// TRUTH: Setup outside the loop.
// b.Loop() resets the timer on its first call, so setup before the loop is
// already excluded. No b.ResetTimer() needed.

func BenchmarkClean(b *testing.B) {
    data := generateLargeDataset()
    for b.Loop() {
        process(data)
    }
}

// LIE 3: A single run means anything at all

func BenchmarkNoisy(b *testing.B) {
    // Run this three times and you may get 33460, 34525, and 58970 ns/op
    // from identical code. CPU frequency scaling, cache state, and other
    // processes all move the number.
    for b.Loop() {
        process(testData)
    }
}

// TRUTH: Repeat, then let benchstat decide what is real.
//
//   go test -bench=Noisy -count=10 > old.txt
//   # make the change
//   go test -bench=Noisy -count=10 > new.txt
//   benchstat old.txt new.txt
//
// If benchstat prints "~", the difference is indistinguishable from noise,
// no matter how much you want it to be a speedup.
```

### Production Profiling Dangers

**The Danger**: profiling is not free, and the endpoints that expose it are a genuine attack surface.

```go
// WRONG: Always-on profiling that never stops

func init() {
    f, _ := os.Create("cpu.prof")
    pprof.StartCPUProfile(f)  // Never stopped, error ignored, file grows forever
}

// WRONG: Profile endpoints on a public listener

import _ "net/http/pprof"  // Registers handlers on DefaultServeMux as a side effect

func main() {
    http.ListenAndServe(":6060", nil)  // Bound to 0.0.0.0: reachable from anywhere
}

// CORRECT: Production-safe profiling

func setupProfiling() {
    // Only expose on internal network
    go func() {
        mux := http.NewServeMux()

        // Add authentication
        mux.HandleFunc("/debug/pprof/", authMiddleware(pprof.Index))
        mux.HandleFunc("/debug/pprof/profile", authMiddleware(
            rateLimitMiddleware(pprof.Profile, 1*time.Minute), // Rate limit
        ))

        // Listen only on localhost or internal network
        http.ListenAndServe("127.0.0.1:6060", mux)
    }()
}

// BETTER: On-demand profiling with automatic cleanup

func enableProfilingTemporarily(duration time.Duration) {
    f, err := os.CreateTemp("", "cpu-*.prof")
    if err != nil {
        log.Printf("Failed to create profile: %v", err)
        return
    }

    log.Printf("Starting CPU profile for %v, output: %s", duration, f.Name())
    pprof.StartCPUProfile(f)

    time.AfterFunc(duration, func() {
        pprof.StopCPUProfile()
        f.Close()
        log.Printf("CPU profile complete: %s", f.Name())
    })
}
```

### Quick Reference: Profiling Mistakes

| Mistake | Why It's Wrong | Fix |
|---------|---------------|-----|
| Optimize without profiling | Might optimize the wrong thing | Profile first, always |
| Profile on dev machine only | Production has different characteristics | Profile in staging/production |
| Blame GC for all latency | GC pauses are usually microseconds | Measure actual GC impact |
| Allocations always bad | Contention can be worse than allocation | Measure actual impact |
| Reading a CPU profile for a blocked program | CPU profiles cannot see off-CPU time | Check `Total samples` vs `Duration`, then use trace/block profiles |
| Sorting only by flat time | Inlined work is attributed to the inlinee | Read the `cum` column too |
| Benchmark includes setup | Measures setup, not operation | Keep setup outside the loop (`b.Loop()` excludes it automatically) |

### Staff Lens: Low-Overhead Continuous Profiling Changes the Calculus

The old advice was "never profile in production". It came from an era of heavyweight instrumenting profilers, and Go's sampling profiler was never that expensive. Continuous profilers (Pyroscope, Google Cloud Profiler, Parca, Datadog) build on the same `runtime/pprof` sampling this chapter has been using all along, and vendors consistently report low single-digit percent overhead.

The important nuance is that these tools are not cheap because they invented a cheaper mechanism. They are cheap because they control the **duty cycle**: capturing a 30-second profile every few minutes rather than sampling continuously and forever. That is a knob you own too, and it is the one that actually determines your overhead.

So re-evaluate the reflex. Always-on continuous profiling is a good default for production Go services, and the diagnostic value is substantial. Verify the overhead on your own service rather than trusting a number, keep the capture duty cycle modest, and keep the endpoints off your public listener.

---
