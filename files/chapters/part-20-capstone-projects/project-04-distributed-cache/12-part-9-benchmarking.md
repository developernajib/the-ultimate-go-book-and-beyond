## Part 9: Benchmarking

### Benchmark Suite

Benchmarking is essential for understanding how your cache performs under different workloads. The benchmark suite below tests three common scenarios: pure writes (SET operations), pure reads (GET operations), and a realistic mixed workload that simulates 80% reads and 20% writes. Go's built-in `testing.B` framework handles the timing and iteration counting automatically, while `RunParallel` simulates multiple concurrent clients. The load test function goes further by running a sustained workload for a fixed duration and reporting overall throughput and error rates.

```go
// benchmark/bench_test.go
package benchmark

import (
    "fmt"
    "math/rand/v2"
    "sync"
    "testing"
    "time"

    "gocache/client"
)

func BenchmarkSet(b *testing.B) {
    c := client.NewClient("localhost:6379", 100)
    defer c.Close()

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            key := fmt.Sprintf("key:%d", i)
            value := []byte(fmt.Sprintf("value:%d", i))
            if err := c.Set(key, value, nil); err != nil {
                b.Fatal(err)
            }
            i++
        }
    })
}

func BenchmarkGet(b *testing.B) {
    c := client.NewClient("localhost:6379", 100)
    defer c.Close()

    // Pre-populate
    for i := 0; i < 10000; i++ {
        key := fmt.Sprintf("key:%d", i)
        value := []byte(fmt.Sprintf("value:%d", i))
        c.Set(key, value, nil)
    }

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            key := fmt.Sprintf("key:%d", rand.IntN(10000))
            _, err := c.Get(key)
            if err != nil {
                b.Fatal(err)
            }
        }
    })
}

func BenchmarkMixed(b *testing.B) {
    c := client.NewClient("localhost:6379", 100)
    defer c.Close()

    // Pre-populate
    for i := 0; i < 10000; i++ {
        key := fmt.Sprintf("key:%d", i)
        value := []byte(fmt.Sprintf("value:%d", i))
        c.Set(key, value, nil)
    }

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            if rand.Float32() < 0.8 {
                // 80% reads
                key := fmt.Sprintf("key:%d", rand.IntN(10000))
                c.Get(key)
            } else {
                // 20% writes
                key := fmt.Sprintf("key:%d", rand.IntN(10000))
                value := []byte(fmt.Sprintf("value:%d", rand.IntN(10000)))
                c.Set(key, value, nil)
            }
        }
    })
}

// Load Test
func TestLoadTest(t *testing.T) {
    c := client.NewClient("localhost:6379", 100)
    defer c.Close()

    duration := 10 * time.Second
    concurrency := 100

    var (
        ops       int64
        errors    int64
        mu        sync.Mutex
        startTime = time.Now()
    )

    done := make(chan bool)

    for i := 0; i < concurrency; i++ {
        go func() {
            for {
                select {
                case <-done:
                    return
                default:
                    key := fmt.Sprintf("key:%d", rand.IntN(100000))

                    if rand.Float32() < 0.8 {
                        _, err := c.Get(key)
                        if err != nil {
                            mu.Lock()
                            errors++
                            mu.Unlock()
                        }
                    } else {
                        value := []byte(fmt.Sprintf("value:%d", rand.IntN(100000)))
                        err := c.Set(key, value, nil)
                        if err != nil {
                            mu.Lock()
                            errors++
                            mu.Unlock()
                        }
                    }

                    mu.Lock()
                    ops++
                    mu.Unlock()
                }
            }
        }()
    }

    time.Sleep(duration)
    close(done)

    elapsed := time.Since(startTime)
    opsPerSec := float64(ops) / elapsed.Seconds()

    t.Logf("Duration: %v", elapsed)
    t.Logf("Total ops: %d", ops)
    t.Logf("Errors: %d", errors)
    t.Logf("Ops/sec: %.2f", opsPerSec)
    t.Logf("Avg latency: %.2fμs", float64(elapsed.Microseconds())/float64(ops))
}
```

### Run Benchmarks

Use the following commands to run the benchmarks and generate CPU and memory profiles. The profiling data can be analyzed with `go tool pprof` to identify bottlenecks such as lock contention, excessive allocations, or slow serialization paths. Make sure the GoCache server is running locally before executing these commands.

```bash
# Standard benchmarks
go test -bench=. -benchmem ./benchmark/

# With CPU profiling
go test -bench=BenchmarkMixed -cpuprofile=cpu.prof ./benchmark/
go tool pprof cpu.prof

# With memory profiling
go test -bench=BenchmarkMixed -memprofile=mem.prof ./benchmark/
go tool pprof mem.prof

# Load test
go test -v -run=TestLoadTest ./benchmark/
```

---

### Junior → FAANG: Benchmarking as a Verification Discipline

Go's built-in `testing.B` framework is the right tool for micro-benchmarks. The 80/20 read/write mix in the load test reflects realistic cache workload patterns: caches are read-heavy because the point is to serve repeated reads from memory rather than from a slower source of truth.

Interpreting benchmark results requires understanding what you are measuring. `ns/op` (nanoseconds per operation) measures latency under the benchmark conditions. `ops/sec` (operations per second) measures throughput. For a cache, you care about both: latency determines whether cached reads are faster than database reads, throughput determines whether the cache can keep up with your peak request rate.

`RunParallel` in `testing.B` simulates concurrent clients. Run benchmarks with different `GOMAXPROCS` values to understand how your implementation scales with CPU cores. If throughput does not scale with CPU count, you have a serialization bottleneck (likely a contended mutex).

### Senior @ FAANG: Benchmarks as Regression Guards

At senior level, benchmarks are not one-time measurements. They are regression guards in CI. A benchmark that shows 10% performance regression should block a PR merge the same way a failing test does. Go's `benchstat` tool compares benchmark results between two code versions and reports statistically significant differences.

Benchmark design matters for correctness. A benchmark that measures only the happy path (all keys in memory, no eviction, no replication) produces numbers that are irrelevant to production behavior. A production-representative benchmark includes memory pressure (cache at 90% capacity, with frequent evictions), network latency simulation (adding artificial delay to replica writes), and request distribution (Zipf distribution for key access, not uniform distribution).

p99 latency is the metric that matters for production cache SLAs, not average latency. A benchmark that reports average latency of 0.5ms may have a p99 latency of 10ms due to GC pauses or lock contention spikes. Use `histogram` or `hdrhistogram` to capture latency distribution in your benchmarks, not just mean and standard deviation.

---
