## Vectorization and Loop Optimization

The compiler's loop optimizer is a stack of passes: LICM, unswitch, IV simplify, distribute, vectorize, unroll, runtime-unroll, software pipeline. Most of them depend on alias analysis being able to prove disjointness. Most C++ code defeats alias analysis by accident.

### Why a Loop Did Not Vectorize

Get the report:

```bash
# Clang
clang++ -O3 -march=native -Rpass=loop-vectorize \
    -Rpass-missed=loop-vectorize \
    -Rpass-analysis=loop-vectorize -c hot.cc

# GCC
g++ -O3 -march=native -fopt-info-vec -fopt-info-vec-missed \
    -fopt-info-vec-note -c hot.cc
```

Common failure messages and fixes:

#### "loop not vectorized: cannot prove pointers do not alias"

```cpp
void axpy(float* x, const float* y, float a, size_t n) {
    for (size_t i = 0; i < n; ++i) x[i] += a * y[i];
}
```

Fix:

```cpp
void axpy(float* __restrict x, const float* __restrict y,
          float a, size_t n) { ... }
```

`__restrict` is GCC/Clang/MSVC. C99 has `restrict`, C++ does not (yet). Without it the compiler must assume `x` and `y` may overlap.

#### "could not determine number of loop iterations"

```cpp
for (auto* p = first; p != last; ++p) ...
```

Pointer-comparison loops are sometimes harder to analyze than counted loops. Convert to counted:

```cpp
size_t n = last - first;
for (size_t i = 0; i < n; ++i) ... first[i] ...
```

#### "loop contains a call which prevents vectorization"

The function called inside the loop is opaque (not inlined, not pure, may have side effects). Fix: inline it, mark it `[[gnu::const]]` or `[[gnu::pure]]`, or use a vectorizable intrinsic. `std::math.h` functions are typically vectorizable when `-fno-math-errno -fno-trapping-math` are set (or `-ffast-math`, with care).

#### "control flow cannot be substituted for a select"

If-conversion failed. Either too much divergence, or there are stores inside a conditional. Fix: pre-store and conditionally update, or use masked SIMD intrinsics.

#### "loop contains unsupported reduction"

```cpp
float min = INF;
for (size_t i = 0; i < n; ++i) if (a[i] < min) { min = a[i]; idx = i; }
```

Argmin is a multi-output reduction the vectorizer often refuses (depends on version). Split:

```cpp
float min = std::reduce(std::execution::unseq, a, a+n, INF, [](float x,float y){return x<y?x:y;});
size_t idx = std::find(a, a+n, min) - a;
```

Two passes, both vectorize.

### Loop Unrolling

Manual unrolling existed because compilers were timid. Modern compilers unroll counted loops aggressively at `-O3`. When to unroll manually:

- The compiler cannot prove the trip count is divisible by the unroll factor (use `__builtin_assume(n % 8 == 0)`)
- You need cross-iteration ILP (independent reductions in separate accumulators)

```cpp
// One accumulator: sequential dependency, FMA latency 4 cycles, throughput 1 stalled
float dot1(const float* a, const float* b, size_t n) {
    float s = 0;
    for (size_t i = 0; i < n; ++i) s += a[i] * b[i];
    return s;
}

// Four accumulators: 4 FMAs in flight, throughput-limited
float dot4(const float* a, const float* b, size_t n) {
    float s0=0,s1=0,s2=0,s3=0;
    size_t i=0;
    for (; i+4<=n; i+=4) {
        s0 += a[i]*b[i];   s1 += a[i+1]*b[i+1];
        s2 += a[i+2]*b[i+2]; s3 += a[i+3]*b[i+3];
    }
    float s = s0+s1+s2+s3;
    for (; i<n; ++i) s += a[i]*b[i];
    return s;
}
```

Compilers do this automatically only if `-ffast-math` is on (FP add is non-associative). Without it, you must split accumulators yourself, accepting the precision tradeoff.

### Software Pipelining

Reorders iterations so that the start of iteration i+1 issues while iteration i is still in flight. GCC has it as `-fmodulo-sched` for innermost loops. Clang's vectorizer combined with unroll achieves similar effects. Hand-pipelining is for embedded DSPs and PowerPC, rarely worth it on x86.

### Polyhedral Optimization (Polly, Graphite)

Polly (LLVM) and Graphite (GCC) reason about affine loops as integer polyhedra and apply tiling, fusion, fission, and skewing.

```bash
# Clang/Polly
clang++ -O3 -mllvm -polly -mllvm -polly-vectorizer=stripmine -c gemm.cc

# GCC/Graphite
g++ -O3 -fgraphite-identity -floop-nest-optimize -c gemm.cc
```

Real wins on dense linear algebra: 2 to 5x for naive triple-nested matrix multiply. For irregular code (graph, hash, string), polyhedral does nothing. Real production code rarely benefits, BLAS already exists. Mostly relevant if you write your own kernel and refuse to use Eigen / MKL / BLIS.

### Restrict Pointers in Practice

```cpp
struct Image {
    float* __restrict r;
    float* __restrict g;
    float* __restrict b;
    int w, h;
};

void to_grayscale(Image& img, float* __restrict out) {
    size_t n = img.w * img.h;
    for (size_t i = 0; i < n; ++i)
        out[i] = 0.299f * img.r[i] + 0.587f * img.g[i] + 0.114f * img.b[i];
}
```

`__restrict` on member pointers and outputs unblocks the vectorizer. If you lie (the pointers do alias at runtime), behavior is undefined.

### Alias Analysis Helpers

C++ has a few legitimate alias-busters:

- `char*` and `unsigned char*` may alias anything (type-based AA does not apply)
- `std::byte*` aliases by spec (since C++17)
- Two pointers to different types of struct fields are typically presumed disjoint by TBAA, unless you cast

Pessimizing patterns:

```cpp
// Hides aliasing from the compiler
void* p = ...;
auto* a = (float*)p;
auto* b = (float*)((char*)p + 16);
// Compiler often assumes a and b alias
```

Use `__builtin_assume_aligned(p, 64)` to communicate alignment without changing the type.

### Vectorization Pragmas

```cpp
#pragma clang loop vectorize(enable) interleave(enable) vectorize_width(8)
for (size_t i = 0; i < n; ++i) ...

#pragma GCC ivdep   // ignore vector dependencies (you swear they do not alias)
for (...) ...

#pragma omp simd                       // OpenMP standard
for (size_t i = 0; i < n; ++i) ...

#pragma omp simd reduction(+:sum) aligned(a:64)
for (size_t i = 0; i < n; ++i) sum += a[i];
```

Use these as last resort. They are non-portable and easy to get wrong.

### Reading the Generated Code

```bash
clang++ -O3 -march=native -S -o - hot.cc | c++filt | less
# Or
objdump -d --no-show-raw-insn -M intel app | less
# Better: Compiler Explorer (godbolt.org) for interactive
```

What you want to see in a hot inner loop:

- `vfmadd*` or `vmul*`/`vadd*` (vector FMA/mul/add)
- ZMM (AVX-512) or YMM (AVX2) registers, not XMM
- A small number of memory ops, ideally aligned (`vmovaps` not `vmovups`, though on modern uarch unaligned is free if not crossing a line)
- Unroll factor 2 or 4 (multiple independent accumulators)

What you do NOT want:

- A scalar prologue and a scalar epilogue plus a tiny middle (means trip count is too small or alignment unknown)
- Conditional `vmovd` interleaved with arithmetic (failed if-conversion)
- `gather`/`scatter` (often slow, see SIMD and AVX-512 Programming)

### Tile and Block

Cache-aware tiling for matrix kernels:

```cpp
// Naive: bad cache behavior for large N
for (i=0; i<N; ++i) for (j=0; j<N; ++j) for (k=0; k<N; ++k)
    C[i][j] += A[i][k] * B[k][j];

// Tiled: each tile fits in L2/L1
constexpr int TI=64, TJ=64, TK=64;
for (i0=0; i0<N; i0+=TI) for (j0=0; j0<N; j0+=TJ) for (k0=0; k0<N; k0+=TK)
  for (i=i0; i<i0+TI; ++i) for (j=j0; j<j0+TJ; ++j) for (k=k0; k<k0+TK; ++k)
    C[i][j] += A[i][k] * B[k][j];
```

For real GEMM use BLAS (MKL, OpenBLAS, BLIS). They include packed micro-kernels in hand-written AVX-512 with software pipelining. You will not beat them.

### Junior to FAANG callout

Compile with the optimization report on. Read it. Fix the top three "failed to vectorize" messages on hot loops. That is most of the work. You do not need to write intrinsics for 80% of vectorizable code, you just need to write loops the compiler accepts.

### Senior at FAANG callout

Track vectorization in CI. A reviewer-visible diff that converts a vectorized loop to scalar (because someone added a function call inside, or removed `__restrict`) is a regression. Add `-Werror=pass-failed=loop-vectorize` to the build of files marked perf-critical, or run a custom check. Vector regressions silently lose 4 to 16x.

### Tooling

- `compiler-explorer` (godbolt.org) for quick checks
- `llvm-mca` for in-order analysis of small kernels
- `osaca` (Open Source Architecture Code Analyzer) similar
- `iaca` (Intel, deprecated but still useful for older uarches)
- `uica.uops.info` for back-end timing on every Intel uarch
