## SIMD: SSE, AVX, AVX-512, and NEON

### What SIMD Is

Single Instruction, Multiple Data (SIMD) allows one instruction to operate on multiple data elements simultaneously. Instead of adding two floats, a single AVX instruction adds eight floats in parallel.

| ISA Extension | Register Width | Floats per Op | Availability         |
|---------------|---------------|---------------|----------------------|
| SSE           | 128-bit       | 4             | All x86-64           |
| AVX/AVX2      | 256-bit       | 8             | Intel Haswell+ (2013)|
| AVX-512       | 512-bit       | 16            | Intel Skylake-X+     |
| NEON          | 128-bit       | 4             | All ARM64            |

### Intrinsics: Manual Vectorization

Intrinsics are C/C++ functions that map directly to SIMD instructions, giving you precise control:

```cpp
#include <immintrin.h>  // AVX2 intrinsics
#include <cstddef>

// SSE: add two float arrays (4 floats at a time)
void add_arrays_sse(float* dst, const float* a, const float* b, size_t n) {
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        __m128 va = _mm_loadu_ps(&a[i]);
        __m128 vb = _mm_loadu_ps(&b[i]);
        __m128 vc = _mm_add_ps(va, vb);
        _mm_storeu_ps(&dst[i], vc);
    }
    // Handle remaining elements
    for (; i < n; ++i) {
        dst[i] = a[i] + b[i];
    }
}

// AVX: add two float arrays (8 floats at a time)
void add_arrays_avx(float* dst, const float* a, const float* b, size_t n) {
    size_t i = 0;
    for (; i + 8 <= n; i += 8) {
        __m256 va = _mm256_loadu_ps(&a[i]);
        __m256 vb = _mm256_loadu_ps(&b[i]);
        __m256 vc = _mm256_add_ps(va, vb);
        _mm256_storeu_ps(&dst[i], vc);
    }
    for (; i < n; ++i) {
        dst[i] = a[i] + b[i];
    }
}

// AVX dot product: compute dot product of two float arrays
float dot_product_avx(const float* a, const float* b, size_t n) {
    __m256 sum = _mm256_setzero_ps();
    size_t i = 0;

    for (; i + 8 <= n; i += 8) {
        __m256 va = _mm256_loadu_ps(&a[i]);
        __m256 vb = _mm256_loadu_ps(&b[i]);
        sum = _mm256_fmadd_ps(va, vb, sum);  // fused multiply-add
    }

    // Horizontal sum of the 8 floats in sum
    __m128 hi = _mm256_extractf128_ps(sum, 1);
    __m128 lo = _mm256_castps256_ps128(sum);
    __m128 s = _mm_add_ps(lo, hi);
    s = _mm_hadd_ps(s, s);
    s = _mm_hadd_ps(s, s);
    float result = _mm_cvtss_f32(s);

    // Handle tail
    for (; i < n; ++i) {
        result += a[i] * b[i];
    }
    return result;
}
```

### Auto-Vectorization: Letting the Compiler Do It

Modern compilers (GCC, Clang, MSVC) can automatically vectorize simple loops. You help the compiler by writing vectorizable code:

```cpp
// Compiler-friendly: simple loop, no dependencies, aligned access
// Compile with: g++ -O3 -march=native -ftree-vectorize
void scale_array(float* __restrict__ dst,
                 const float* __restrict__ src,
                 float factor, size_t n) {
    // __restrict__ tells the compiler dst and src don't alias
    for (size_t i = 0; i < n; ++i) {
        dst[i] = src[i] * factor;
    }
    // GCC/Clang will auto-vectorize this to AVX if -march=native is set
}

// Check auto-vectorization with compiler reports:
// GCC:   -fopt-info-vec-optimized
// Clang: -Rpass=loop-vectorize
// MSVC:  /Qvec-report:2

// Anti-pattern: loop the compiler CANNOT vectorize
float bad_loop(float* data, size_t n) {
    float result = 1.0f;
    for (size_t i = 0; i < n; ++i) {
        result *= data[i];  // loop-carried dependency
        data[i] = result;   // store depends on result
    }
    return result;
}
```

Key rules for auto-vectorization: use `__restrict__` to assert no aliasing, avoid loop-carried dependencies, keep loop bodies simple, use `-O3 -march=native`, and check compiler output to confirm vectorization happened.

---
