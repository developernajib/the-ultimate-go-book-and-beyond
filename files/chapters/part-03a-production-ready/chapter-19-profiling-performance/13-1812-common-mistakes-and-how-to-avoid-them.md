## 19.12 Common Mistakes and How to Avoid Them

### Mistake 1: Premature Optimization

Writing complex optimizations before measuring guarantees effort spent on the wrong code path, profiling routinely shows that the function developers assumed was slow is not in the top ten hotspots. Write straightforward code first, profile under realistic load, then apply optimizations only to the measured bottlenecks.

```go
// BAD: Optimizing without profiling
func process(data []byte) []byte {
    // "I think this is slow, let me optimize"
    result := make([]byte, 0, len(data)*2) // Pre-allocated
    for i := 0; i < len(data); i++ {       // Manual loop
        result = append(result, transform(data[i]))
    }
    return result
}

// GOOD: Profile first, then optimize bottlenecks
func process(data []byte) []byte {
    // Simple implementation first
    var result []byte
    for _, b := range data {
        result = append(result, transform(b))
    }
    return result
}

// After profiling shows this is a bottleneck:
func processOptimized(data []byte) []byte {
    result := make([]byte, len(data))
    for i, b := range data {
        result[i] = transform(b)
    }
    return result
}
```

### Mistake 2: Benchmarking Incorrectly

The Go compiler's dead-code elimination can optimize away benchmark work entirely if results are not consumed, producing impossibly fast measurements. Assigning the result to a package-level `sink` variable makes it observable to the compiler, which forces the work to actually happen.

```go
// BAD: Compiler optimizes away the work
func BenchmarkBad(b *testing.B) {
    for b.Loop() {
        compute(42) // Result discarded, compiler may skip
    }
}

// GOOD: Prevent compiler optimization
var sink int

func BenchmarkGood(b *testing.B) {
    var result int
    for b.Loop() {
        result = compute(42)
    }
    sink = result // Prevent optimization
}

// BAD: Including setup in benchmark
func BenchmarkWithSetup_Bad(b *testing.B) {
    for b.Loop() {
        data := generateLargeData() // Setup in loop!
        process(data)
    }
}

// GOOD: setup happens once, before the loop.
// b.Loop() resets the timer itself, so no b.ResetTimer() is needed here.
func BenchmarkWithSetup_Good(b *testing.B) {
    data := generateLargeData()

    for b.Loop() {
        process(data)
    }
}
```

Measured on the machine used for this book, `BenchmarkBad_Loop` above runs in 1.19 ns/op against 2.22 ns/op for `BenchmarkGood_Loop`. The "faster" one is faster because `compute(42)` never ran. Its result went nowhere, so the compiler deleted it and the benchmark timed an empty loop.

Two clarifications that matter if you take this pattern elsewhere.

`b.Loop()` is doing more of the protective work here than the `sink` is. It keeps values assigned inside the loop alive, which is why `result = compute(42)` survives. Write the same "sink after the loop" pattern with an old-style `b.N` loop and it does not save you: because `compute(42)` is loop-invariant, only the final assignment to `sink` is observable, so the compiler hoists the call out of the loop and the benchmark measures nothing again. Both the sink version and the discarded version measure roughly 0.47 ns/op that way. The lesson is not "add a sink and stop thinking". It is to check that the reported time is physically plausible for the work you believe you are doing.

`b.ResetTimer()` is not wrong, just unnecessary alongside `b.Loop()`, which already excludes setup before the loop and cleanup after it. Keep `b.ResetTimer()` for `b.N`-style benchmarks, where it is genuinely required.

### Mistake 3: Misinterpreting Profiles

`pprof` reports two cost columns for every function: flat time (CPU spent executing that function's own instructions) and cumulative time (flat time plus all time spent in callees). A function with a small flat value but large cumulative value is not itself slow, it is an aggregation point that calls the actual bottleneck. Chasing the function with the highest cumulative time without drilling into its call tree leads to refactoring the wrong code. The correct approach is to use `peek` or `list` to identify which callee accounts for the gap between flat and cumulative cost.

```go
// Profile shows:
// main.handler: 10ms (flat)
// main.handler: 500ms (cum)

// WRONG interpretation:
// "handler is slow, optimize it"

// RIGHT interpretation:
// handler's own code takes 10ms
// but it calls functions that take 490ms total
// Look at callees to find the real bottleneck

// Use these pprof commands:
// (pprof) list handler    # See annotated source
// (pprof) peek handler    # See callers and callees
// (pprof) tree handler    # See call tree
```

### Mistake 4: Over-using sync.Pool

`sync.Pool` has a real per-`Get`/`Put` cost from the P-local storage lookup and the interface conversion. The mistake is reaching for it reflexively, before a profile has shown that allocation of this specific object is actually a problem worth the complexity it adds.

You will see confident rules of thumb about a byte-size threshold below which pooling "does not pay off". Be skeptical of all of them, including any this book might have offered. Measured on the machine used for this book (linux/amd64, Go 1.27.1), a `Get`/`Put` round trip and a plain heap allocation compare like this:

| Size | Plain `make` | Pool round trip |
|---|---|---|
| 64B | 54.9 ns ±54% | 28.1 ns ±19% |
| 256B | 132.2 ns ±10% | 25.8 ns ±13% |
| 4096B | 1508 ns ±6% | 51.8 ns ±216% |

The pool won at every size, including 64 bytes. So much for a 256-byte threshold.

Now distrust that table too, because it is a microbenchmark and it flatters the pool in three ways. It is single-goroutine, so every `Get` hits the fastest private per-P slot and never contends. Nothing else is allocating, so the GC never clears the pool and the hit rate is a perfect 100%. And the buffer is never actually used, which is not what your code does. Note the ±216% variance on the 4096B pool row: that number is barely a measurement at all.

The honest guidance does not come from a size threshold:

- Reach for `sync.Pool` when a **heap profile shows this object dominating `alloc_space`**, not because it seems large.
- It works best for objects that are expensive to create, uniform in size, and strictly scoped to one operation.
- Weigh the correctness risk. The previous section showed how returning pooled memory to a caller leaks one user's data to another, and the race detector cannot see it. That risk is constant regardless of object size, so a pool that saves 20ns is a bad trade at any scale.
- Measure your actual workload, concurrently, with your real access pattern. Then keep the pool only if the service-level numbers moved.

```go
// Reasonable: large, uniform, short-lived, and profile-justified.
var largePool = sync.Pool{
    New: func() any {
        buf := make([]byte, 0, 4096)
        return &buf
    },
}
```

Note the `*[]byte` rather than `[]byte`. Putting a slice directly into a pool boxes the slice header into an interface on every `Put`, which allocates and quietly undoes part of what you came for. Measured on the same machine:

| Pooled type | ns/op | B/op | allocs/op |
|---|---|---|---|
| `[]byte` (value) | 120-146 | 24 | 1 |
| `*[]byte` (pointer) | 41-51 | 0 | 0 |

Those 24 bytes are the slice header (pointer, length, capacity) being heap-allocated so it can fit in an interface. A pool built to avoid allocations that allocates on every `Put` is a special kind of defeat, and it is entirely invisible unless you check `allocs/op`. Staticcheck flags this as `SA6002`. Pool a pointer.

### Mistake 5: Ignoring Memory Layout

The Go compiler inserts alignment padding between struct fields so that each field starts at an address that is a multiple of its size. Ordering fields from largest to smallest eliminates most padding and shrinks the struct, which reduces cache pressure and improves performance in struct-heavy workloads where many instances are iterated over.

```go
// BAD: Poor cache utilization
type ColdStruct struct {
    A int64     // 8 bytes
    B bool      // 1 byte + 7 padding
    C int64     // 8 bytes
    D bool      // 1 byte + 7 padding
}
// Total: 32 bytes due to padding

// GOOD: Pack fields by size
type HotStruct struct {
    A int64     // 8 bytes
    C int64     // 8 bytes
    B bool      // 1 byte
    D bool      // 1 byte + 6 padding
}
// Total: 24 bytes

// Check struct size:
// fmt.Println(unsafe.Sizeof(ColdStruct{})) // 32
// fmt.Println(unsafe.Sizeof(HotStruct{}))  // 24
```

### Additional Mistakes to Flag

1. **Optimizing without profile evidence.** Change must be measured before claimed as improvement.
2. **Microbenchmarking out of context.** A fast primitive in isolation may be dominated by surrounding code.
3. **Over-use of sync.Pool.** Adds complexity, only worth it for genuinely hot paths.
4. **Struct padding obsession.** Matters on tight hot loops, wasted effort elsewhere.
5. **Premature concurrency.** Goroutines add overhead, and sequential is often faster for small workloads.

### Staff Lens: Evidence-Based Review

Every performance-related PR should answer: what was the bottleneck, how was it measured, what does the measurement show now, and is the improvement statistically significant? Without these answers, the PR is a guess. Guesses sometimes help and sometimes hurt. Measurement distinguishes.

---
