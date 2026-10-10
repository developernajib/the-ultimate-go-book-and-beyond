## 19.5 Benchmarking

### Writing Benchmarks

Go benchmarks follow a standard loop structure where the testing framework controls the iteration count to achieve statistically stable timing. `b.Loop()`, added in Go 1.24, is the modern form and manages the timer for you. `b.RunParallel` exercises the implementation under concurrent load to expose scalability characteristics on multi-core machines.

```go
func BenchmarkSort(b *testing.B) {
    original := generateData(1000)

    // No b.ResetTimer() needed: b.Loop() resets the timer itself.
    for b.Loop() {
        data := make([]int, len(original))
        copy(data, original)
        slices.Sort(data)
    }
}

func BenchmarkSortParallel(b *testing.B) {
    data := generateData(1000)

    b.RunParallel(func(pb *testing.PB) {
        localData := make([]int, len(data))
        for pb.Next() {
            copy(localData, data)
            slices.Sort(localData)
        }
    })
}
```

Two details in `b.Loop()` are worth being precise about, because both are commonly misunderstood.

`b.Loop()` resets the timer the first time it is called, and stops it when it returns false. Setup before the loop and cleanup after it are already excluded from the measurement, so an explicit `b.ResetTimer()` before a `b.Loop()` loop is redundant. It is harmless, but it signals that the author believed it was doing something. Use `b.ResetTimer()` only in older `b.N`-style benchmarks, and do not mix the two forms: a benchmark should use `b.Loop()` or a `for i := 0; i < b.N; i++` loop, never both.

`b.RunParallel` measures throughput under concurrency. It does not detect data races. Nothing in the benchmark tooling does. Races are found by the race detector, which you must ask for explicitly with `go test -race`, and which is a separate run from your timing run because it slows execution by roughly 2-20x and inflates memory use by 5-10x. Never read timings from a `-race` build.

### Memory Benchmarks

`b.ReportAllocs()` enables per-iteration allocation reporting, adding `allocs/op` and `B/op` columns to the benchmark output. Unlike the heap profile, these counts are exact rather than sampled, which is why a benchmark is the right tool for verifying that an optimization actually eliminated an allocation rather than merely reducing CPU time.

```go
var sink []byte

func BenchmarkAllocations(b *testing.B) {
    b.ReportAllocs()

    for b.Loop() {
        sink = make([]byte, 1024)
    }
}
```

On the machine used for this book (linux/amd64, Go 1.27.1), that reports `1024 B/op` and `1 allocs/op`, which is what we expect.

### The Trap: Benchmarks That Measure Nothing

That `sink` variable is not decoration, and this is the single most common way a Go benchmark lies to you. Write the same benchmark the obvious way:

```go
for b.Loop() {
    _ = make([]byte, 1024)  // WRONG: measures nothing
}
```

and it reports `0 B/op` and `0 allocs/op`. A benchmark whose entire purpose is to demonstrate allocation reporting reports no allocations, and it does not warn you. It just prints a plausible number.

Understanding why requires separating two different compiler behaviors that are easy to conflate.

**Dead-code elimination.** If a computed value is never used, the compiler is free to delete the computation. This is what destroys naive `b.N`-style benchmarks: written as `for i := 0; i < b.N; i++ { _ = make([]byte, 1024) }`, the body vanishes entirely and the benchmark reports around 0.5 ns/op, which is not the cost of allocating a kilobyte. It is the cost of an empty loop. Any per-operation time in the sub-nanosecond range should be read as "my benchmark was deleted", not "my code is fast".

`b.Loop()` protects you here, and this is a real advantage over the older form. The compiler keeps variables assigned inside a `b.Loop()` body alive, so the loop body cannot be optimized away wholesale. Note the two conditions the runtime documents: the protection applies only to statements syntactically inside the loop braces, and the condition must be written exactly as `b.Loop()`.

**Escape analysis.** This is the part `b.Loop()` does *not* solve, and why the `_ =` version still reports zero. Keeping a value alive is not the same as putting it on the heap. A 1KB buffer that never outlives its iteration does not escape, so the compiler allocates it on the stack, where it costs no heap allocation and no GC attention. `allocs/op` counts heap allocations, so it correctly reports 0. The benchmark is not broken in the sense of being deleted. It is measuring stack allocation while you believe you are measuring heap allocation.

Assigning to a package-level variable is what forces the value to escape, because the compiler cannot prove the buffer dies with the iteration. That is the entire job of `sink`. Half-measures do not work, and both of these still report `0 allocs/op`:

```go
buf := make([]byte, 1024)   // local: kept alive, but still stack-allocated
_ = buf

consume(make([]byte, 1024)) // passed to a function that does not retain it
```

The rule: if you are benchmarking allocation, assign the result to a package-level sink, then confirm the reported `allocs/op` is non-zero before you trust a single thing the benchmark tells you. Sanity-check the direction of your numbers against reality. A result that seems too good is usually a measurement error rather than a discovery.

### Running Benchmarks

Running benchmarks with `-count=5` and capturing results to files before and after a change lets `benchstat` compute confidence intervals and report whether a difference is statistically significant at all.

```bash
# Basic
go test -bench=.

# With memory stats
go test -bench=. -benchmem

# Compare implementations
go test -bench=. -count=5 > old.txt
# Make changes
go test -bench=. -count=5 > new.txt
benchstat old.txt new.txt
```

`benchstat` is not a formality, and `-count=5` is not superstition. A single benchmark run is close to meaningless, and the reason is worth internalizing rather than taking on faith.

While preparing this section, the sort benchmark above was run three times in a row, unchanged, on an otherwise idle machine. It reported 33460 ns/op, 34525 ns/op, and 58970 ns/op. That is a spread of roughly 1.8x across identical code, with nothing changing between runs but the machine's mood: CPU frequency scaling, cache state, other processes, and where the allocator happened to place things. If you had "optimized" something between run one and run three, you would have concluded you made the code 76% slower. You would have been measuring noise.

This is why the workflow matters:

- **Never** conclude anything from one run against one run. Use `-count=10` or higher for changes you actually care about.
- Feed both files to `benchstat` and read the `±` column and the p-value. If `benchstat` prints `~`, it is telling you the difference is not distinguishable from noise, and no amount of wanting a speedup changes that.
- Reduce the noise you can control: close other applications, keep the machine plugged in (laptops throttle aggressively on battery), and never trust numbers from a shared CI runner or a busy laptop as if they came from a quiet dedicated host.
- Compare only numbers gathered on the same machine in the same session. A "before" from yesterday and an "after" from today on a different machine is not a comparison.

This is also why this book does not hand you a table of benchmark results to memorize. Performance numbers are properties of a specific machine, toolchain, and workload, not facts about Go. Any number quoted here was measured on the machine described above and is there to illustrate a direction, not to be a value you should expect to reproduce. Run the benchmark on your own hardware, with your own data. That result is the only one that is true for you.

### Benchmarks in CI

For performance-sensitive services, run benchmarks in CI and commit baseline results. Regressions surface automatically. Without this, performance degrades quietly over months until someone notices.

### Staff Lens: Benchmark the Right Thing

A microbenchmark optimizes a function, but the service's real bottleneck is often elsewhere. Benchmark at the boundary you care about: request handling if it's a service, serialization if it's a parser, algorithm if it's a compute kernel. "My counter benchmark is 10% faster" is useless if counters are not in the hot path.

---
