## SIMD Batch Processing for Hot Loops

Scalar code leaves 4x to 16x of modern CPU throughput unused. SIMD (Single Instruction Multiple Data) processes 4, 8, 16, or 32 lanes in parallel per instruction, and on AVX-512 hardware a well-vectorized loop saturates memory bandwidth before it saturates the ALU. For parsers, checksums, JSON filters, and columnar analytics, SIMD is table stakes.

### Portable SIMD: C++26 `std::simd`

C++26 standardizes `std::simd<T, Abi>` after years as `std::experimental::simd`. The API exposes fixed-width and native-width vector types with deterministic alignment, ops, and reductions.

```cpp
#include <simd>
#include <span>
#include <cstdint>

// Sum an array of int32 using native-width SIMD
std::int64_t sum_int32(std::span<const std::int32_t> data) {
    using v = std::native_simd<std::int32_t>;
    v acc{};
    std::size_t i = 0;
    for (; i + v::size() <= data.size(); i += v::size()) {
        acc += v(data.data() + i, std::element_aligned);
    }
    std::int64_t total = reduce(acc);
    for (; i < data.size(); ++i) total += data[i];
    return total;
}
```

On AVX2 `v::size()` is 8, on AVX-512 it is 16, on NEON it is 4. One source file, three code paths selected at compile time based on target flags.

### Intrinsics for peak performance

When the standard API cannot express the pattern (shuffles, gather/scatter, masked stores), drop to intrinsics. A classic example: validate UTF-8 at 10 GB/s by checking 64 bytes per iteration on AVX-512.

```cpp
#include <immintrin.h>
#include <cstddef>

// Count bytes equal to a target character in a buffer (AVX2).
std::size_t count_byte_avx2(const char* p, std::size_t n, char target) {
    __m256i needle = _mm256_set1_epi8(target);
    std::size_t count = 0;
    std::size_t i = 0;
    for (; i + 32 <= n; i += 32) {
        __m256i v = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(p + i));
        __m256i eq = _mm256_cmpeq_epi8(v, needle);
        unsigned mask = _mm256_movemask_epi8(eq);
        count += __builtin_popcount(mask);
    }
    for (; i < n; ++i) count += (p[i] == target);
    return count;
}
```

One `movemask` plus `popcount` processes 32 bytes per iteration with three instructions in the hot path. Scalar code needs 32 compares, 32 branches, and pays for each mispredict.

### Runtime dispatch

Production binaries ship multiple SIMD variants selected at startup via `cpuid`. Compile three translation units with `-mavx2`, `-mavx512f`, and a baseline path, expose the same symbol via `ifunc` or a function pointer populated in a `static` initializer.

```cpp
using count_fn = std::size_t(*)(const char*, std::size_t, char);

count_fn resolve_count_byte() {
    if (__builtin_cpu_supports("avx512bw")) return count_byte_avx512;
    if (__builtin_cpu_supports("avx2"))     return count_byte_avx2;
    return count_byte_scalar;
}

static count_fn count_byte = resolve_count_byte();
```

Never mix AVX and SSE modes in a hot loop, the implicit vzeroupper boundary costs hundreds of cycles. Keep AVX code paths in dedicated translation units compiled with matching flags.

### Memory layout matters more than intrinsics

SIMD falls flat on AoS (array of structs) because lanes come from non-contiguous memory. Convert to SoA (struct of arrays) at ingest time. A columnar store with per-field contiguous buffers vectorizes effortlessly, an array of objects does not. This refactor is usually the most effective SIMD optimization.

### Masked operations and alignment

Masked loads and stores (`_mm256_maskload_epi32`, C++26 `std::simd_mask`) let vectorized loops handle the tail without a scalar fixup, critical for short inputs where the tail is a meaningful fraction of runtime. Align buffers to `alignof(std::simd<T>)` when you control allocation, unaligned loads are legal on modern x86 but crossing a cache line still costs an extra cycle.

### When not to vectorize

SIMD is for bandwidth-bound or ALU-bound hot loops with regular data flow. Branchy code (state machines, graph traversal) rarely benefits, and hand-vectorized versions of such code are often slower than scalar due to mask shuffling overhead. Profile first with `perf stat -e instructions,cycles,cache-misses`, vectorize only loops that dominate CPU time.

### Go comparison

Go exposes no portable SIMD, you must write Plan 9 assembly per target or call C via cgo (and pay the cgo boundary cost, often more than the speedup). This is one domain where C++ is unambiguously superior, and it is why performance-critical data-plane code (Envoy, ClickHouse, DuckDB) is written in C++.
