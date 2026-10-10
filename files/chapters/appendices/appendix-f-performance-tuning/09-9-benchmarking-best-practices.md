## 9. Benchmarking Best Practices

Accurate benchmarks are critical for performance optimization.

### 9.1 Writing Correct Benchmarks

**Basic Benchmark Structure**:

```go
package main

import (
    "testing"
)

// Simple benchmark
func BenchmarkExample(b *testing.B) {
    // Setup (not measured)
    data := setupData()

    // Reset timer after setup
    b.ResetTimer()

    // Benchmark loop
    for b.Loop() {
        // Code to benchmark
        processData(data)
    }
}

// Benchmark with memory stats
func BenchmarkWithAllocs(b *testing.B) {
    b.ReportAllocs() // Report memory allocations

    for b.Loop() {
        makeSlice(1000)
    }
}

// Benchmark with sub-benchmarks
func BenchmarkComparison(b *testing.B) {
    sizes := []int{10, 100, 1000, 10000}

    for _, size := range sizes {
        b.Run(fmt.Sprintf("Size%d", size), func(b *testing.B) {
            b.ReportAllocs()
            for b.Loop() {
                makeSlice(size)
            }
        })
    }
}

// Parallel benchmarks
func BenchmarkParallel(b *testing.B) {
    cache := NewCache()

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            cache.Get("key")
        }
    })
}
```

### 9.2 Benchmarking Pitfalls

**Common Mistakes**:

```go
package main

import (
    "testing"
)

// Bad: Compiler optimizations eliminate code
func BenchmarkBad(b *testing.B) {
    for b.Loop() {
        add(1, 2) // Result unused, may be optimized away
    }
}

// Good: Use result
func BenchmarkGood(b *testing.B) {
    var result int
    for b.Loop() {
        result = add(1, 2)
    }
    _ = result // Prevent unused variable warning
}

// Better: Global sink
var globalSink int

func BenchmarkBetter(b *testing.B) {
    var result int
    for b.Loop() {
        result = add(1, 2)
    }
    globalSink = result
}

// Bad: Loop overhead dominates
func BenchmarkTooFast(b *testing.B) {
    for b.Loop() {
        x := 1 + 1 // Too simple
    }
}

// Good: Meaningful work
func BenchmarkMeaningful(b *testing.B) {
    data := make([]int, 1000)
    b.ResetTimer()

    for b.Loop() {
        sum(data)
    }
}

// Bad: Setup inside loop
func BenchmarkSetupInLoop(b *testing.B) {
    for b.Loop() {
        data := make([]int, 1000) // Measured!
        sum(data)
    }
}

// Good: Setup outside loop
func BenchmarkSetupOutside(b *testing.B) {
    data := make([]int, 1000)
    b.ResetTimer()

    for b.Loop() {
        sum(data)
    }
}

// Bad: Non-deterministic input
func BenchmarkNonDeterministic(b *testing.B) {
    for b.Loop() {
        x := rand.IntN(100) // Different every time
        process(x)
    }
}

// Good: Fixed input
func BenchmarkDeterministic(b *testing.B) {
    inputs := []int{1, 5, 10, 25, 50, 75, 100}
    b.ResetTimer()

    for b.Loop() {
        x := inputs[i%len(inputs)]
        process(x)
    }
}
```

### 9.3 Benchmark Commands

**Running Benchmarks**:

```bash
# Run all benchmarks
go test -bench=.

# Run specific benchmark
go test -bench=BenchmarkMyFunc

# Run with memory stats
go test -bench=. -benchmem

# More iterations for accuracy
go test -bench=. -benchtime=10s

# Specific iteration count
go test -bench=. -benchtime=1000000x

# CPU profile
go test -bench=. -cpuprofile=cpu.prof

# Memory profile
go test -bench=. -memprofile=mem.prof

# Save results for comparison
go test -bench=. -benchmem > old.txt
# ... make changes ...
go test -bench=. -benchmem > new.txt
benchstat old.txt new.txt
```

### 9.4 Benchmark Comparison

**Using benchstat**:

```bash
# Install benchstat
go install golang.org/x/perf/cmd/benchstat@latest

# Run benchmark multiple times
go test -bench=. -count=10 > before.txt

# Make optimizations...

go test -bench=. -count=10 > after.txt

# Compare results
benchstat before.txt after.txt
```

**Example Output**:

```
name        old time/op    new time/op    delta
Process-8     1.23µs ± 2%    0.89µs ± 3%  -27.64%  (p=0.000 n=10+10)

name        old alloc/op   new alloc/op   delta
Process-8      512B ± 0%      256B ± 0%  -50.00%  (p=0.000 n=10+10)

name        old allocs/op  new allocs/op  delta
Process-8      5.00 ± 0%      2.00 ± 0%  -60.00%  (p=0.000 n=10+10)
```

### 9.5 Table-Driven Benchmarks

**Benchmark Matrix**:

```go
package main

import (
    "fmt"
    "testing"
)

func BenchmarkMatrix(b *testing.B) {
    // Different implementations
    impls := []struct {
        name string
        fn   func([]int) int
    }{
        {"ForLoop", sumForLoop},
        {"Range", sumRange},
        {"Recursive", sumRecursive},
    }

    // Different input sizes
    sizes := []int{10, 100, 1000, 10000}

    // Run all combinations
    for _, impl := range impls {
        for _, size := range sizes {
            name := fmt.Sprintf("%s/Size%d", impl.name, size)

            b.Run(name, func(b *testing.B) {
                data := make([]int, size)
                for i := range data {
                    data[i] = i
                }

                b.ReportAllocs()
                b.ResetTimer()

                for b.Loop() {
                    _ = impl.fn(data)
                }
            })
        }
    }
}

// Output:
// BenchmarkMatrix/ForLoop/Size10-8       50000000    28.4 ns/op     0 B/op    0 allocs/op
// BenchmarkMatrix/ForLoop/Size100-8      10000000     156 ns/op     0 B/op    0 allocs/op
// BenchmarkMatrix/Range/Size10-8         50000000    27.8 ns/op     0 B/op    0 allocs/op
// ...
```

---
