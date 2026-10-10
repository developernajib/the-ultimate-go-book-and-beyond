## Compiler Intrinsics and Inline Assembly

Compiler intrinsics are function-like hooks that emit specific machine instructions while remaining visible to the optimizer. Inline assembly is the escape hatch when the intrinsic does not exist. Senior engineers use both, but sparingly, and always with a measured justification.

### Intrinsics for Branch Hints

GCC and Clang accept `__builtin_expect` and, more precisely, `__builtin_expect_with_probability`. The latter lets you annotate the exact probability, which the compiler feeds into its block-placement algorithm the same way it feeds PGO data.

```cpp
#include <cstdint>

// Rare error path. Tell the compiler explicitly.
[[gnu::always_inline]] inline bool validate(std::int64_t value) {
    if (__builtin_expect_with_probability(value < 0, 0, 0.001)) {
        // cold path, split into a separate section
        log_invalid(value);
        return false;
    }
    return true;
}
```

Prefer the C++20 `[[likely]]` and `[[unlikely]]` attributes in new code. They are portable and carry the same semantics without the `__builtin_` prefix. But both are only hints. The compiler ignores them under `-O0` and may override them under PGO. Verify with `objdump -d` that the hot path is actually the fall-through.

### Intrinsics for Assumptions

`__builtin_assume(cond)` tells the compiler to treat `cond` as true. The compiler will not emit a check, it will optimize as if the condition holds. Wrong assumptions produce undefined behavior, so use this only where the invariant is already guaranteed elsewhere.

```cpp
inline float fast_divide(float numerator, float denominator) {
    __builtin_assume(denominator != 0.0f);
    return numerator / denominator;
}

inline std::size_t indexed_load(const std::vector<int>& v, std::size_t i) {
    __builtin_assume(i < v.size());  // bounds already checked by caller
    return v[i];
}
```

In C++26, `[[assume(cond)]]` is the standard form. It works on MSVC, GCC 13+, and Clang 17+. Using it lets the compiler remove redundant bounds checks, eliminate impossible branches, and constant-propagate more aggressively.

### Serialization and Timing: RDTSCP with Fences

Benchmarking a function that takes tens of nanoseconds requires serializing the pipeline, otherwise out-of-order execution reorders your start and stop timestamps with the measured code. The correct sequence on x86-64 is `CPUID` (full serialization) followed by `RDTSC`, or `RDTSCP` (partially serializing) bracketed by `LFENCE`.

```cpp
#include <cstdint>
#include <x86intrin.h>

[[gnu::always_inline]] inline std::uint64_t rdtscp_start() {
    unsigned aux;
    _mm_lfence();
    return __rdtscp(&aux);
}

[[gnu::always_inline]] inline std::uint64_t rdtscp_end() {
    unsigned aux;
    std::uint64_t tsc = __rdtscp(&aux);
    _mm_lfence();
    return tsc;
}

// Measuring a function of ~5ns resolution
auto start = rdtscp_start();
critical_kernel(data);
auto end = rdtscp_end();
std::uint64_t cycles = end - start;
```

Convert cycles to nanoseconds using the nominal TSC frequency (read once at startup from `/proc/cpuinfo` or `CPUID.15H`). `RDTSC` returns wallclock cycles on modern Intel and AMD CPUs, regardless of P-state, so you do not need to disable frequency scaling as long as you convert with the nominal TSC frequency.

### PAUSE and Spinlocks

A spinlock that does not call the `PAUSE` instruction inside its wait loop wastes power and starves hyperthread siblings. `PAUSE` signals the core that the loop is a spin-wait, causing the pipeline to throttle memory ordering speculation and yielding execution resources to the sibling thread.

```cpp
#include <atomic>
#include <immintrin.h>

class Spinlock {
    std::atomic_flag flag_ = ATOMIC_FLAG_INIT;
public:
    void lock() {
        while (flag_.test_and_set(std::memory_order_acquire)) {
            do {
                _mm_pause();  // throttle, yield to SMT sibling
            } while (flag_.test(std::memory_order_relaxed));
        }
    }
    void unlock() { flag_.clear(std::memory_order_release); }
};
```

Even better on modern hardware: use `UMONITOR` / `UMWAIT` (Tremont, Sapphire Rapids) to sleep the core until the cache line is modified, avoiding polling entirely.

### Inline Assembly: When All Else Fails

Inline asm is the last resort because it opaque to the optimizer. If you use it, be rigorous about clobbers and memory ordering.

```cpp
// Atomic 16-byte load with CMPXCHG16B (for lock-free descriptors on pre-AVX hw)
struct alignas(16) Pair { std::uint64_t a, b; };

inline Pair atomic_load_16(const Pair* p) {
    Pair out;
    __asm__ volatile(
        "movq    %%rbx, %%rax\n\t"    // zero expected-low
        "movq    %%rcx, %%rdx\n\t"    // zero expected-high
        "lock cmpxchg16b %2\n\t"
        : "=&a"(out.a), "=&d"(out.b)
        : "m"(*p)
        : "rbx", "rcx", "cc", "memory"
    );
    return out;
}
```

Every inline asm block should come with a comment explaining why the intrinsic or C++ atomic was insufficient, and a benchmark showing the measured win. "Because it felt faster" is not an engineering justification.
