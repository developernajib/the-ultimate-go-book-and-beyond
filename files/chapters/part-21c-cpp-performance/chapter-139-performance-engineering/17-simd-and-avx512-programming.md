## SIMD and AVX-512 Programming

SIMD turns a 4 GHz core into a 64 GFLOP/s engine for the right workload. Getting there requires either trusting the autovectorizer (often optimistic), writing intrinsics, or using a portable wrapper (xsimd, std::experimental::simd, highway).

### Register Widths and ISA Generations

| ISA | Width | Year | Lanes (f32 / i32) |
|-----|-------|------|-------------------|
| SSE2 | 128b | 2001 | 4 / 4 |
| SSE4.2 | 128b | 2008 | 4 / 4 |
| AVX | 256b | 2011 | 8 / 8 (FP only initially) |
| AVX2 | 256b | 2013 | 8 / 8 (full int) |
| AVX-512F | 512b | 2016 | 16 / 16 |
| AVX-512 VBMI/VBMI2 | 512b | Icelake | byte permutes |
| AVX-512 VNNI | 512b | Cascade Lake | int8 dot product |
| AVX-512 BF16 | 512b | Cooper Lake | bfloat16 mul-add |
| AMX | 8 KB tiles | Sapphire Rapids | bf16/int8 matmul |
| AVX10.1 | 256b/512b | Granite Rapids | unifies AVX-512 across Intel |

AMD: Zen 4 has full-width AVX-512 (since 2022). Zen 5 widens FPU and improves throughput. Apple Silicon: NEON 128b plus SVE2 on M4. ARM Neoverse V2 has 256b SVE2.

### The AVX-512 Frequency Throttling Story

Skylake-X, Cascade Lake, and Icelake-SP applied a frequency license penalty when AVX-512 instructions executed:

- License 0: scalar/SSE, full turbo
- License 1: AVX/AVX2 256b, ~5 to 10% lower max
- License 2: AVX-512 heavy (FMA), ~15 to 25% lower max

A program that briefly used AVX-512 dropped the entire core's frequency for ~2 ms after the last 512b instruction. On mixed workloads this made AVX-512 a net loss. The infamous "Linus Torvalds AVX-512 rant" came from this era.

Sapphire Rapids and later: license model removed for normal AVX-512 ops, only the heaviest FMA workloads at sustained high duty cycle still throttle, and even then much less. Zen 4 has no equivalent license penalty.

Practical rule: target AVX2 for portability and code that mixes scalar and SIMD. Use AVX-512 when you have sustained vector work or you want the masking and `vpcompressd`-class instructions that have no AVX2 equivalent.

### Intrinsics vs Auto-Vectorization

Compilers will autovectorize:

- Counted loops with no early exit
- Contiguous, aligned (or predictably unaligned) accesses
- No data-dependent control flow inside (unless if-conversion is cheap)
- No aliasing that the compiler cannot prove away

```cpp
void scale(float* __restrict a, float k, size_t n) {
    for (size_t i = 0; i < n; ++i) a[i] *= k;
}
```

Add `__restrict`. Add `-march=native -O3 -ffast-math` (the last carefully). Check `-Rpass=loop-vectorize -Rpass-missed=loop-vectorize -Rpass-analysis=loop-vectorize` (Clang) or `-fopt-info-vec` / `-fopt-info-vec-missed` (GCC).

### SIMD memcpy

Glibc memcpy is already heroic, do not replace it. But for fixed-size copies inlined into hot paths:

```cpp
#include <immintrin.h>
inline void copy_64(void* dst, const void* src) {
    __m512i v = _mm512_loadu_si512(src);
    _mm512_storeu_si512(dst, v);
}
inline void copy_256(void* dst, const void* src) {
    auto* d = (__m512i*)dst;
    auto* s = (const __m512i*)src;
    __m512i a = _mm512_loadu_si512(s);
    __m512i b = _mm512_loadu_si512(s + 1);
    __m512i c = _mm512_loadu_si512(s + 2);
    __m512i d4 = _mm512_loadu_si512(s + 3);
    _mm512_storeu_si512(d,     a);
    _mm512_storeu_si512(d + 1, b);
    _mm512_storeu_si512(d + 2, c);
    _mm512_storeu_si512(d + 3, d4);
}
```

For streaming copies (data not reused), use non-temporal stores to bypass cache:

```cpp
_mm512_stream_si512(d, v);
// followed by _mm_sfence() before consumers read it
```

Streaming stores keep the LLC clean, raise effective DRAM bandwidth from ~70% to ~95% of peak.

### SIMD String Search (memchr-style)

Find the first byte equal to needle in a buffer:

```cpp
const char* find_byte_avx2(const char* p, size_t n, char needle) {
    __m256i nv = _mm256_set1_epi8(needle);
    size_t i = 0;
    for (; i + 32 <= n; i += 32) {
        __m256i v = _mm256_loadu_si256((const __m256i*)(p + i));
        __m256i eq = _mm256_cmpeq_epi8(v, nv);
        uint32_t mask = _mm256_movemask_epi8(eq);
        if (mask) return p + i + __builtin_ctz(mask);
    }
    for (; i < n; ++i) if (p[i] == needle) return p + i;
    return nullptr;
}
```

Throughput: 25 to 30 GB/s per core on Skylake-X, vs 6 to 8 GB/s for the scalar loop. Glibc's memchr uses the same pattern.

### SIMD JSON parsing (simdjson approach)

simdjson processes 64 bytes at a time, classifying each byte (whitespace, structural, in-string) using vector lookups (`_mm512_shuffle_epi8`), tracking string state with PCLMUL-based prefix XOR, and producing a bitmap of structural positions in one pass. Throughput on Sapphire Rapids: 4 to 6 GB/s parsing, 10x to 25x faster than RapidJSON.

Key tricks:

- `vpshufb` for parallel character classification (16 lookups per instruction)
- `pdep`/`pext` (BMI2) to compress structural bits to indices
- `clmul` for branchless string-state tracking through quotes and escapes
- 64-bit bitmap arithmetic for the whole 64-byte block

### Mask Registers (AVX-512)

AVX-512 introduced eight 64-bit mask registers (k0-k7). Every vector op can be predicated. This eliminates the blend-after-compute pattern and lets compilers if-convert loops cheaply.

```cpp
__m512 process(__m512 v, __mmask16 valid) {
    __m512 hi = _mm512_set1_ps(100.0f);
    __mmask16 over = _mm512_cmp_ps_mask(v, hi, _CMP_GT_OQ);
    return _mm512_mask_blend_ps(over & valid, v, hi);
}
```

`vpcompressd` packs the active lanes contiguously, branchless filter in one instruction.

### Gather and Scatter

`vpgatherdd` (AVX2) and `vpscatterdd` (AVX-512) load/store from arbitrary indices.

```cpp
__m512i idx = _mm512_loadu_si512(indices);
__m512i v = _mm512_i32gather_epi32(idx, base, 4);
```

Performance reality: gather is 8 to 16 separate cache accesses. Throughput limited by the load ports (2 per cycle on Sunny Cove, 3 on Golden Cove). On Skylake gather was barely faster than a scalar loop. On Sapphire Rapids it is meaningfully faster (~2 to 3x scalar) but still bandwidth-bound.

Use gather when:

- Indices are clustered (same cache line repeated)
- The alternative is a serial pointer chase
- You can pair with prefetch

Avoid gather when:

- Indices are uniform random over a large array (cache thrash)
- Lanes can be made contiguous with a permute

### Practical Build Flags

```bash
# Portable AVX2 binary
clang++ -O3 -march=x86-64-v3 -mtune=generic ...

# Sapphire Rapids targeted
clang++ -O3 -march=sapphirerapids -mtune=sapphirerapids ...

# Multi-versioning: ship one binary, dispatch at runtime
__attribute__((target("avx2"))) void hot_avx2() { ... }
__attribute__((target("avx512f,avx512vl"))) void hot_avx512() { ... }
__attribute__((target("default"))) void hot_default() { ... }
// IFUNC resolver picks at load time
```

### Pitfalls

- `_mm256_zeroupper` after AVX code on older uarches to avoid SSE/AVX transition penalty (no longer needed past Sandy Bridge for properly-tagged code, but compilers still emit it)
- Unaligned 32-byte loads cross cache lines, costing about 1 extra cycle. Aligned: `_mm256_load_ps` (faults on misalignment). Unaligned: `_mm256_loadu_ps` (cheap on modern uarch). Default to unaligned, align when you can prove it.
- Reading uninitialized lanes returns garbage that may be denormal floats, costing thousands of cycles in microcode if FP traps are enabled. Mask or zero properly.
- `vmovdqa` on misaligned address is a #GP fault, not a perf issue.

### Junior to FAANG callout

Do not start with intrinsics. Try `__restrict`, `-O3`, contiguous data, and check `-Rpass-analysis=loop-vectorize`. If the compiler vectorizes, you are done. If it explains why it cannot, fix that. Intrinsics are last resort and lock you to one ISA.

### Senior at FAANG callout

For library-grade code, write intrinsics with multi-versioning. For service code, use a portable wrapper (Highway from Google). Hand-tuned SIMD that does not have a runtime fallback breaks the moment your fleet has one Skylake host left.

### References

- Intel Intrinsics Guide: software.intel.com/sites/landingpage/IntrinsicsGuide/
- uops.info: latency and throughput of every instruction on every uarch
- Agner Fog's optimization manuals
- simdjson paper: Langdale and Lemire, 2019
