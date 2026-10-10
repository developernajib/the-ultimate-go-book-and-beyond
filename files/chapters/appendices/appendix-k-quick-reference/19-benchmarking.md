## Benchmarking

Go's testing package includes built-in support for benchmarks, making it easy to measure and compare the performance of your code. Benchmark functions start with `Benchmark` and use `b.Loop()` to run the code under test the right number of times for accurate timing. Always use the `-benchmem` flag to track memory allocations alongside execution time, since excessive allocations are a common performance bottleneck. You can profile CPU and memory usage by generating `.prof` files and analyzing them with `go tool pprof`.

```go
import "testing"

// Basic benchmark
func BenchmarkAdd(b *testing.B) {
    for b.Loop() {
        Add(2, 3)
    }
}

// Run benchmarks
// go test -bench=.
// go test -bench=BenchmarkAdd
// go test -bench=. -benchmem  // Include memory stats

// Reset timer (exclude setup)
func BenchmarkSomething(b *testing.B) {
    // Expensive setup
    data := setupData()

    b.ResetTimer()  // Don't count setup time

    for b.Loop() {
        process(data)
    }
}

// Stop/start timer
func BenchmarkWithPauses(b *testing.B) {
    for b.Loop() {
        b.StopTimer()
        // Expensive setup for this iteration
        data := setupIteration()
        b.StartTimer()

        process(data)
    }
}

// Report allocations
func BenchmarkAllocations(b *testing.B) {
    b.ReportAllocs()

    for b.Loop() {
        // Code that allocates
    }
}

// Report metrics
func BenchmarkCustomMetrics(b *testing.B) {
    var totalBytes int64

    for b.Loop() {
        bytes := process()
        totalBytes += bytes
    }

    b.ReportMetric(float64(totalBytes)/float64(b.N), "bytes/op")
}

// Set bytes processed
func BenchmarkThroughput(b *testing.B) {
    data := make([]byte, 1024)

    b.SetBytes(int64(len(data)))

    for b.Loop() {
        process(data)
    }
}

// Parallel benchmark
func BenchmarkParallel(b *testing.B) {
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            // Code to benchmark
        }
    })
}

// Sub-benchmarks
func BenchmarkSizes(b *testing.B) {
    sizes := []int{1, 10, 100, 1000}

    for _, size := range sizes {
        b.Run(fmt.Sprintf("size=%d", size), func(b *testing.B) {
            for b.Loop() {
                process(size)
            }
        })
    }
}

// Compare benchmarks
// go test -bench=. -benchmem > old.txt
// (make changes)
// go test -bench=. -benchmem > new.txt
// benchcmp old.txt new.txt

// Or use benchstat (go install golang.org/x/perf/cmd/benchstat@latest)
// benchstat old.txt new.txt

// CPU profiling
// go test -bench=. -cpuprofile=cpu.prof
// go tool pprof cpu.prof

// Memory profiling
// go test -bench=. -memprofile=mem.prof
// go tool pprof mem.prof

// Benchmark output
// BenchmarkAdd-8   1000000000   0.25 ns/op
// Name-GOMAXPROCS  Iterations   Time/op

// With -benchmem:
// BenchmarkAdd-8   1000000000   0.25 ns/op   0 B/op   0 allocs/op
// Name-GOMAXPROCS  Iterations   Time/op      Bytes    Allocations

// Run for specific time
// go test -bench=. -benchtime=10s
// go test -bench=. -benchtime=1000000x  // Specific iterations

// Skip long benchmarks
func BenchmarkLong(b *testing.B) {
    if testing.Short() {
        b.Skip("skipping in short mode")
    }
    // Long benchmark
}

// go test -bench=. -short
```

---
