## C++ vs Go Performance: Real Benchmarks

### Where C++ Wins

C++ has fundamental performance advantages in specific domains:

**1. SIMD and Vectorization**

```cpp
// C++: explicit AVX2 matrix multiply kernel
#include <immintrin.h>

void matmul_avx(float* C, const float* A, const float* B, int N) {
    for (int i = 0; i < N; ++i) {
        for (int j = 0; j < N; j += 8) {
            __m256 sum = _mm256_setzero_ps();
            for (int k = 0; k < N; ++k) {
                __m256 a = _mm256_broadcast_ss(&A[i * N + k]);
                __m256 b = _mm256_loadu_ps(&B[k * N + j]);
                sum = _mm256_fmadd_ps(a, b, sum);
            }
            _mm256_storeu_ps(&C[i * N + j], sum);
        }
    }
}
```

Go has no access to SIMD intrinsics without assembly or CGo. The Go compiler's auto-vectorizer is significantly less mature than GCC/Clang. For compute-intensive numerical workloads, C++ is typically 3-8x faster.

**2. Zero-Cost Abstractions**

```cpp
// C++ templates: zero runtime overhead
template<typename T>
T sum(const std::vector<T>& v) {
    T result{};
    for (const auto& x : v) result += x;
    return result;
}
// Instantiated at compile time, fully inlined, no virtual dispatch

// Go equivalent uses interfaces with runtime overhead
// or generics (since Go 1.18) which still don't optimize as aggressively
```

**3. Memory Layout Control**

```cpp
// C++: exact control over struct layout and alignment
struct alignas(64) CacheLine {
    float data[16];  // exactly one cache line
};

// Placement new, custom allocators, arena allocation
#include <memory_resource>
std::pmr::monotonic_buffer_resource arena(1024 * 1024);
std::pmr::vector<CacheLine> particles(&arena);
```

While Go's non-compacting mark-sweep collector does not move heap objects, the runtime abstracts away memory mapping, preventing manual placement new or custom arena allocators for general structs without CGo or unsafe tricks.

### Where Go Competes or Wins

**1. Concurrency-Heavy Workloads**

```go
// Go: HTTP server handling 100K concurrent connections
package main

import (
    "fmt"
    "net/http"
    "sync/atomic"
)

var requestCount atomic.Int64

func handler(w http.ResponseWriter, r *http.Request) {
    count := requestCount.Add(1)
    fmt.Fprintf(w, "Request #%d", count)
}

func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}
// Goroutines make this trivially concurrent
// C++ equivalent requires careful thread pool + async I/O setup
```

Go's goroutine scheduler and lightweight concurrency model make it easier to write efficient concurrent code. While C++ can match or exceed Go's throughput with careful use of io_uring or epoll, the development effort is substantially higher.

**2. Compilation Speed**

Go compiles a large project in seconds. C++ with LTO can take minutes to hours. For iterative development, Go's fast compilation cycle often leads to faster overall delivery despite slower runtime performance.

**3. GC Latency (Modern Go)**

Go's garbage collector has sub-millisecond pause times (typically 50-100 microseconds as of Go 1.27+). For services where p99 latency matters more than throughput, Go's predictable GC pauses can be preferable to C++ memory management bugs that cause sporadic latency spikes.

### Benchmark Comparison Table

Representative benchmarks (normalized, lower is faster):

| Workload                    | C++ (clang -O3) | Go 1.27  | Ratio   |
|-----------------------------|-----------------|----------|---------|
| Matrix multiply (1024x1024) | 1.0x            | 4-8x     | C++ wins|
| JSON parsing (large file)   | 1.0x            | 1.5-2x   | C++ wins|
| HTTP server throughput      | 1.0x            | 0.9-1.2x | Tie     |
| Binary tree allocation      | 1.0x            | 1.2-1.8x | C++ wins|
| Regex matching              | 1.0x            | 1.5-3x   | C++ wins|
| Concurrent map reduce       | 1.0x            | 0.8-1.1x | Tie/Go  |
| String processing           | 1.0x            | 2-3x     | C++ wins|
| Protobuf ser/deser          | 1.0x            | 1.3-2x   | C++ wins|
| Channel pipeline            | N/A             | 1.0x     | Go wins |
| Build time (large project)  | 10-60x          | 1.0x     | Go wins |

The general rule: C++ is 2-5x faster for compute-bound, memory-intensive workloads. Go is competitive for I/O-bound, concurrency-heavy workloads. Go wins decisively on developer productivity and build times.

---
