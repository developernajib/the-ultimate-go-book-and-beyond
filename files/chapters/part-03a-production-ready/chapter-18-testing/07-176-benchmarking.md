## 18.6 Benchmarking

### Writing Benchmarks

A benchmark function is distinguished from a test by accepting `*testing.B` and looping over `b.Loop()` (Go 1.24+) or, in older code, `b.N`. The testing framework automatically calibrates the iteration count to produce a stable measurement. The parallel variant uses `b.RunParallel` to distribute iterations across multiple goroutines, revealing whether the function scales with CPU cores or is bottlenecked by shared state.

```go
func BenchmarkFibonacci(b *testing.B) {
    for b.Loop() {
        Fibonacci(20)
    }
}

func BenchmarkFibonacciParallel(b *testing.B) {
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            Fibonacci(20)
        }
    })
}
```

### Why `b.Loop` and not `for i := 0; i < b.N; i++`

This is not a cosmetic modernization. The old form has a real failure mode: the compiler can see that the result is unused and delete the work you are trying to measure. Benchmarking `Add(a, b int) int`, which is small enough to inline, three ways:

```
BenchmarkAdd_OldBN-8            1000000000    0.5826 ns/op   <- call eliminated
BenchmarkAdd_OldBN_WithSink-8   1000000000    0.7263 ns/op   <- still folded
BenchmarkAdd_BLoop-8             322433398    3.560  ns/op   <- actually measured
```

The first benchmark hit the 1e9 iteration ceiling and reported roughly half a nanosecond, which is not "Add is fast", it is "Add never ran". A sub-nanosecond result on a machine whose clock ticks about every 0.5ns is the tell. Worse, this failure is silent and flatters you: the code looks fast because it does not exist.

`b.Loop()` fixes this at the language level rather than by trickery. The compiler treats the parameters and results of calls inside a `b.Loop()` body as escaping, so it must actually perform the call. That is why the same function honestly reports 3.5 ns/op.

The old workaround was to assign to a package-level sink variable. Note from the numbers above that the sink did not save this benchmark either, because with constant arguments the whole expression still folds. `b.Loop` needs no sink, no `runtime.KeepAlive`, and no ceremony.

`b.Loop` has two further advantages worth knowing: it resets the timer when first called, so setup before the loop is excluded automatically without a `b.ResetTimer()`, and it stops the timer when it returns false, so cleanup after the loop is excluded too. It also executes its body a predictable number of times, whereas `b.N` runs the whole function repeatedly with growing `N`, which surprises people whose benchmark has expensive setup.

### Running Benchmarks

Benchmarks are skipped by default during `go test` and must be explicitly enabled with the `-bench` flag, which accepts a regexp so you can target a single function or an entire package at once. Adding `-benchmem` is essential when profiling allocations because heap pressure and GC pauses often dominate real-world performance more than raw CPU cycles.

```bash
# Run benchmarks
go test -bench=.

# With memory allocation stats
go test -bench=. -benchmem

# Specific benchmark
go test -bench=BenchmarkFibonacci

# Multiple iterations for stability
go test -bench=. -count=5
```

### Benchmark Output

Each output line reports the benchmark name (suffixed with the GOMAXPROCS value), the number of iterations the framework ran, nanoseconds per operation, bytes allocated per operation, and heap allocations per operation.

Here is a real run of the two benchmarks above, `-count=3`, on an 8-thread (4-core) laptop:

```
goarch: amd64
cpu: Intel(R) Core(TM) i7-10510U CPU @ 1.80GHz
BenchmarkFibonacci-8               4796    236321 ns/op    0 B/op    0 allocs/op
BenchmarkFibonacci-8               6960    160583 ns/op    0 B/op    0 allocs/op
BenchmarkFibonacci-8               9211    135523 ns/op    0 B/op    0 allocs/op
BenchmarkFibonacciParallel-8      38096     42797 ns/op    0 B/op    0 allocs/op
BenchmarkFibonacciParallel-8      31298     43929 ns/op    0 B/op    0 allocs/op
BenchmarkFibonacciParallel-8      35956     35086 ns/op    0 B/op    0 allocs/op
```

Two things in that output deserve more attention than the headline number.

**The serial benchmark disagrees with itself by 1.7x across three runs of identical code** (236µs, 161µs, 136µs), here because the CPU is ramping clocks and the laptop is thermally noisy. This is the entire argument for `-count` and `benchstat`. If you had run `-count=1`, made no change, and run it again, you could have "measured" a 40% improvement that does not exist.

**`b.RunParallel` reports time per operation, not per core.** Roughly 160µs serial against roughly 40µs parallel is about a 4x speedup on 8 hardware threads (4 physical cores with hyper-threading). That is a good result and it tells you `Fibonacci` has no contention worth worrying about. It is emphatically *not* linear scaling to 8, and you should be suspicious of any write-up that claims it: hyper-threads are not cores, and a compute-bound recursive function is exactly the workload that gains least from them. Use `RunParallel` to detect contention (a flat or worsening ns/op under parallelism means shared state), not to produce a scaling factor for a slide.

### Sub-Benchmarks

`b.Run` creates named sub-benchmarks within a single function, letting you compare competing implementations, here JSON, Gob, and Protobuf encoding, using identical input data and identical measurement conditions. Because all three sub-benchmarks share the same `data` variable prepared once outside the loop, setup cost is excluded from every measurement, keeping the comparison fair.

```go
func BenchmarkEncoding(b *testing.B) {
    data := generateData()

    b.Run("JSON", func(b *testing.B) {
        for b.Loop() {
            json.Marshal(data)
        }
    })

    b.Run("Gob", func(b *testing.B) {
        for b.Loop() {
            var buf bytes.Buffer
            gob.NewEncoder(&buf).Encode(data)
        }
    })

    b.Run("Protobuf", func(b *testing.B) {
        for b.Loop() {
            proto.Marshal(data)
        }
    })
}
```

### benchstat for Statistical Comparison

A single benchmark run has variance. `benchstat` from `golang.org/x/perf/cmd/benchstat` compares two sets of benchmark runs with statistical rigor:

```bash
go test -bench=. -count=10 > old.txt
# make changes
go test -bench=. -count=10 > new.txt
benchstat old.txt new.txt
```

This reports mean, standard deviation, and significance. Single-run benchmarks are noise. Multi-run benchmarks with `benchstat` are evidence.

### Staff Lens: Benchmark in CI

For performance-sensitive code, commit benchmark baselines and run them in CI. Regressions surface automatically. Without CI benchmarks, performance regressions accumulate invisibly until someone notices production is slow.

### Profile-Guided Optimization (Go 1.21+)

Go 1.21 added PGO. Collect a CPU profile from production, feed it to the compiler, and get 2-14% speedups on typical workloads. For performance-critical services, this is a free win worth the pipeline complexity.

---
