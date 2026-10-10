## C++ Performance Mythology

> **Junior to FAANG:** Performance intuition built from blog posts is wrong more often than right. Measure on your hardware, your data, your compiler, your flags.
>
> **Senior at FAANG:** The real performance bottleneck in 2026 is memory hierarchy, not instruction count. A poorly laid-out C++ struct can lose to well-laid-out Java or Go.

This chapter busts five myths that show up in interviews, design docs, and Stack Overflow answers. Numbers below are from public benchmarks and reproducible micro-benchmarks. Hardware referenced is roughly Zen 4 / Sapphire Rapids / Apple M3 class unless stated.

### Myth 1: "C++ is always faster than Go/Java/C#"

False as stated. True under specific conditions.

What is actually true: a careful C++ implementation can be made faster than a careful Go/Java implementation for almost any compute-bound workload, *given equivalent engineering effort*. The "equivalent engineering effort" caveat does most of the work.

Where Go and modern Java actually match or beat naive C++:

- **String-heavy code with poor allocation patterns.** Go's string slicing is zero-copy. A C++ implementation that does `std::string` copies in a hot loop can be slower than the equivalent Go.
- **JIT-compiled hot paths in the JVM** with profile-guided escape analysis can occasionally beat AOT-compiled C++ that does not have PGO enabled.
- **Code with poor cache layout.** A C++ `std::list<Widget>` traversal will lose to a Go `[]Widget` slice traversal because cache misses dominate.

A concrete benchmark example: parsing a 1 GB JSON file.

| Implementation | Time (s) | Notes |
|--------------------------------|----------|------------------------------------|
| Naive C++ with `std::string` | ~6.5 | Heavy allocations |
| Go encoding/json | ~9.0 | Reflection-heavy |
| Go simdjson-go | ~1.8 | SIMD parsing |
| C++ simdjson | ~0.9 | Same algorithm, no GC overhead |
| Java Jackson | ~5.0 | Decent, JIT-optimized |

Naive C++ beats naive Go but loses to Go simdjson. The right comparison is "equivalent algorithm, equivalent care". Then C++ pulls ahead, often by a factor of 2-3x for compute-bound work, much more for latency-tail-sensitive workloads where GC matters.

The honest summary: C++ has the highest performance ceiling. It does not have a performance floor that beats other languages by default.

### Myth 2: "Templates make code slower"

False. Templates are a compile-time mechanism. They have zero runtime cost.

The mythology comes from binary size. A heavily templated codebase produces more object code (because the compiler instantiates the template per type), and binary size *can* hurt instruction cache behavior. This is a real concern, but it is rare and measurable.

What templates actually give you: zero-cost abstraction. The classic example is `std::sort` vs C's `qsort`.

```cpp
// C qsort: function pointer indirection on every comparison.
int compare_int(const void* a, const void* b) {
    return (*(int*)a) - (*(int*)b);
}
qsort(arr, n, sizeof(int), compare_int);

// C++ std::sort: comparator inlined.
std::sort(arr.begin(), arr.end());
```

Real numbers on sorting 10M ints, GCC 13 -O2:

| Method | Time (ms) | Why |
|--------------------------|-----------|----------------------------------------|
| `qsort` | ~1100 | Indirect call per comparison |
| `std::sort` | ~400 | Comparator inlined, branch predictable |
| `std::sort` with pdqsort | ~340 | Modern libstdc++ uses pdqsort |

A 2.7x difference, all from inlining the comparator. Templates make this possible. They do not make it slower.

Where templates hurt:

- **Compile time.** Yes, templates are slow to compile. C++20 modules and `extern template` declarations help. This is a developer-time cost, not a runtime cost.
- **Error messages.** Pre-concepts, template error messages were horrific. Concepts (C++20) fixed this.
- **Binary size when over-instantiated.** Real but measurable. Use `extern template` and explicit instantiation in shared headers.

Templates are not a performance liability. They are the foundation of the C++ performance story.

### Myth 3: "Exceptions are slow, never use them"

This one is half-true and the half that is true is misunderstood.

The truth: exceptions are *almost free* on the happy path with the Itanium ABI (Linux, macOS). The unwind tables sit in `.eh_frame` in cold memory and are not touched unless an exception is thrown. A function that *can* throw but does not has the same instruction sequence as a function that cannot throw, modulo a few extra prologue instructions in some cases.

The cost shows up *when an exception is actually thrown*. Stack unwinding is expensive: roughly 10-100 microseconds depending on call depth, because the unwinder walks frames, looks up handlers in the `.eh_frame` tables, and runs destructors. Throwing in a hot loop is catastrophic. Throwing on a once-per-request error path is invisible.

A measured example. A function that returns `std::expected<int, Error>` vs a function that throws `Error`:

| Path | Throws | Returns expected | Notes |
|-------------------------------|------------|------------------|--------------------------|
| Happy path (10M iterations) | ~12 ms | ~12 ms | Same |
| Error path (10M iterations) | ~3500 ms | ~12 ms | Throw is ~300x slower |

This is why the rule is: throw exceptions for *exceptional* cases. Never use exceptions for control flow on a hot path. Use `std::expected` or error codes for expected error returns.

Where the "no exceptions" rule actually applies in 2026:

- **Game engines.** Exception unwinding traverses every frame with destructors. In a 60+ Hz tight loop, throwing once destroys frame timing. Most engines compile with `-fno-exceptions` and use error codes.
- **Embedded.** Unwind tables cost binary size and require runtime support that may not be present.
- **Hard real-time.** Unwind cost is non-deterministic.
- **Some HFT shops.** Same reason.
- **Code that crosses DLL boundaries on Windows.** Throwing across DLLs is fragile due to runtime mismatches.

For server-side C++ doing normal request-response work, exceptions are fine and arguably the cleanest error mechanism. The "exceptions are slow" claim was true for late 1990s implementations and has been quoted past its expiration date for two decades.

### Myth 4: "C++ is always faster than C"

False. Modern C++ is approximately tied with C on equivalent code, sometimes faster (`std::sort` with inlined comparator), sometimes slower (poorly written class hierarchies with virtual dispatch).

The myth in the other direction also exists: "C is faster than C++". Also false. There is no instruction cost to C++ features that you do not use. A C++ struct with no virtual functions, no exceptions, and no copy constructor is literally a C struct. It compiles to the same code.

What can make C++ slower than equivalent C:

- **Virtual function calls.** A virtual call costs an indirection (vtable lookup) and may defeat inlining. If you have `virtual int f()` called in a tight loop, that is a real cost. Devirtualization helps but is not always reliable.
- **Default copy and move overhead.** A C++ class with a non-trivial copy constructor that you accidentally invoke (passing by value when you meant const ref) is overhead C does not have because C does not have copy constructors.
- **Hidden allocations in `std::string`, `std::vector`** when used carelessly. C strings have explicit allocation. C++ strings can `malloc` behind your back if you assign a long string.

These are not language costs. They are *abstraction-misuse* costs. A C++ engineer who knows the language writes C++ that is at least as fast as C, often faster, and is much shorter.

### Myth 5: "Cache misses are the only thing that matters"

Closer to true than other myths, still incorrect as an absolute. Cache misses *dominate* on most modern CPUs for memory-bound workloads, but plenty of code is not memory-bound.

The hierarchy of performance concerns in 2026, roughly in order:

1. **Algorithmic complexity.** O(n^2) loses to O(n log n) eventually no matter how cache-friendly.
2. **Cache misses (L1, L2, L3, DRAM).** Cost ratios roughly 4 cycles, 12 cycles, 40 cycles, 200+ cycles. Layout matters.
3. **Branch misprediction.** ~20 cycle penalty on modern Intel/AMD, similar on Apple Silicon.
4. **Memory bandwidth.** Linear scans are throughput-bound at ~50 GB/s on Zen 4.
5. **SIMD opportunities missed.** AVX2/AVX-512/NEON lanes give 4-8-16x speedup on amenable code.
6. **Atomic and lock contention.** A contended atomic CAS is 50-200 cycles. A contended mutex is microseconds.
7. **Allocation overhead.** Per-allocation cost is ~50-200 ns plus cache effects from fragmentation.
8. **Function call overhead.** Largely free with inlining. Becomes visible only in pathological cases.

Sample real measurement. Summing 100M `int`s:

| Strategy | Time (ms) | Bandwidth |
|-------------------------------------|-----------|--------------|
| `std::vector<int>` linear scan | ~50 | ~32 GB/s |
| `std::list<int>` linear scan | ~3500 | <1 GB/s |
| `std::deque<int>` linear scan | ~80 | ~20 GB/s |
| Manually SIMD-summed `vector<int>` | ~25 | ~64 GB/s |

The `list` vs `vector` factor is 70x. The SIMD vs scalar factor is 2x. The data structure choice is the bigger lever, every time.

### What modern C++ performance actually looks like

The senior C++ engineer's mental model in 2026:

1. Choose data structures for cache layout (`vector` over `list`, `flat_map` over `map` for small N, struct of arrays over array of structs for SIMD).
2. Avoid pointer chasing and indirection in hot paths.
3. Eliminate unnecessary allocations. Reserve `vector` capacity. Reuse buffers.
4. Use `noexcept` where appropriate to enable optimizer optimizations and move semantics.
5. Profile before optimizing. Use `perf`, VTune, or Instruments. Read the assembly with Godbolt.
6. Sanity-check by reading the generated assembly. The compiler is smarter than you 95% of the time and dumber 5% of the time. Knowing which is which is a senior skill.
7. Use SIMD where the data shape allows it. Highway, xsimd, or `std::simd` (C++26).
8. Lock-free is not always faster than locked. A well-designed mutex with low contention beats a contended atomic queue.

C++ wins on performance when you treat it as a tool for laying out memory, not as a faster syntax for the same algorithms.
