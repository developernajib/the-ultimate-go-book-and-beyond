## Part IX: Parallel STL Algorithms (C++17)

C++17 introduced execution policies that let you parallelize standard algorithms by adding a single argument. The compiler and runtime handle thread management, work distribution, and synchronization.

### Execution Policies

C++17's execution policies (`seq`, `par`, `par_unseq`) let standard algorithms parallelize with one extra argument, moving the threading decision into the call site.
```cpp
#include <algorithm>
#include <execution>
#include <vector>
#include <iostream>
#include <chrono>
#include <numeric>
#include <random>

int main() {
    const size_t N = 50'000'000;
    std::vector<double> data(N);
    
    // Generate random data
    std::mt19937 gen(42);
    std::uniform_real_distribution<double> dist(0.0, 1000.0);
    std::generate(data.begin(), data.end(), [&] { return dist(gen); });
    
    // Sequential sort
    auto data_seq = data;
    auto t1 = std::chrono::high_resolution_clock::now();
    std::sort(std::execution::seq, data_seq.begin(), data_seq.end());
    auto t2 = std::chrono::high_resolution_clock::now();
    auto seq_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t2 - t1);
    
    // Parallel sort
    auto data_par = data;
    auto t3 = std::chrono::high_resolution_clock::now();
    std::sort(std::execution::par, data_par.begin(), data_par.end());
    auto t4 = std::chrono::high_resolution_clock::now();
    auto par_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t4 - t3);
    
    // Parallel + vectorized sort
    auto data_par_unseq = data;
    auto t5 = std::chrono::high_resolution_clock::now();
    std::sort(std::execution::par_unseq, 
              data_par_unseq.begin(), data_par_unseq.end());
    auto t6 = std::chrono::high_resolution_clock::now();
    auto par_unseq_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t6 - t5);
    
    std::cout << "Sequential:          " << seq_ms.count() << "ms\n";
    std::cout << "Parallel:            " << par_ms.count() << "ms\n";
    std::cout << "Parallel+Vectorized: " << par_unseq_ms.count() << "ms\n";
    
    return 0;
}
```

**Typical results (50M doubles, 8-core machine):**
- Sequential: ~5000ms
- Parallel: ~800ms (~6x speedup)
- Parallel+Vectorized: ~700ms

### Execution Policy Reference

| Policy | Header Constant | Behavior |
|--------|----------------|----------|
| Sequential | `std::execution::seq` | Same as no policy. Single thread. |
| Parallel | `std::execution::par` | Multiple threads. Element access functions must not cause data races. |
| Parallel Unsequenced | `std::execution::par_unseq` | Multiple threads + SIMD vectorization. Element access must not use mutexes or blocking calls. |
| Unsequenced (C++20) | `std::execution::unseq` | SIMD vectorization on one thread. No mutexes or blocking calls. |

### Parallel Algorithms in Practice

Passing `std::execution::par_unseq` to `std::transform` and `std::sort` delegates parallelization to the standard library's thread pool (typically TBB on Linux, a platform thread pool on Windows). The algorithm handles work partitioning automatically. The only requirement is that the lambda captures no shared mutable state, making it an easy drop-in for embarrassingly parallel data transformations over large vectors.
```cpp
#include <algorithm>
#include <execution>
#include <vector>
#include <numeric>
#include <iostream>
#include <cmath>

int main() {
    std::vector<int> data(10'000'000);
    std::iota(data.begin(), data.end(), 1);  // 1, 2, 3, ..., 10M
    
    // Parallel transform: square each element
    std::vector<double> squares(data.size());
    std::transform(
        std::execution::par,
        data.begin(), data.end(),
        squares.begin(),
        [](int x) { return std::sqrt(static_cast<double>(x)); }
    );
    
    // Parallel reduce
    double total = std::reduce(
        std::execution::par,
        squares.begin(), squares.end(),
        0.0  // initial value
    );
    std::cout << "Sum of square roots: " << total << "\n";
    
    // Parallel count_if
    auto even_count = std::count_if(
        std::execution::par,
        data.begin(), data.end(),
        [](int x) { return x % 2 == 0; }
    );
    std::cout << "Even numbers: " << even_count << "\n";
    
    // Parallel for_each
    std::atomic<long long> sum{0};
    std::for_each(
        std::execution::par,
        data.begin(), data.end(),
        [&sum](int x) {
            if (x % 1000 == 0) {
                sum.fetch_add(x, std::memory_order_relaxed);
            }
        }
    );
    std::cout << "Sum of multiples of 1000: " << sum << "\n";
    
    return 0;
}
```

**Important:** `std::reduce` (parallel) vs `std::accumulate` (sequential). `accumulate` processes elements left-to-right and cannot be parallelized. `reduce` allows the implementation to group and combine elements in any order, which means:
1. The operation must be associative and commutative for correct results.
2. Floating-point addition is not truly associative - results may differ slightly from the sequential version.

### Compiler and Library Support

Parallel algorithms require runtime support. Common implementations:

- **GCC (libstdc++):** Uses Intel TBB as the backend. Link with `-ltbb`.
- **MSVC:** Built-in support via the ConcRT runtime.
- **Clang (libc++):** Limited support as of 2024. Some algorithms fall back to sequential.

```bash
# GCC compilation with parallel STL
g++ -std=c++17 -O2 -ltbb parallel_example.cpp -o parallel_example

# MSVC compilation (parallel support included)
cl /std:c++17 /O2 parallel_example.cpp
```

**Comparison with Go:** Go has no equivalent to parallel STL algorithms. To parallelize a sort in Go, you must manually partition the data, sort each partition in a goroutine, and merge. C++'s parallel algorithms are one of its genuine advantages over Go for data-parallel workloads.

---

### Junior → FAANG: Parallel STL as the Zero-Refactor Parallelization Tool

The most surprising feature in this section for Go engineers: changing `std::sort(v.begin(), v.end())` to `std::sort(std::execution::par, v.begin(), v.end())` may provide significant parallelism with zero algorithm change. The catch: it requires TBB (Intel Threading Building Blocks) on most Linux implementations. Verify your build system links TBB before relying on `par` execution policies.

### Senior @ FAANG: Parallel STL Adoption and Performance Measurement

At the staff level, parallel STL adoption requires: (1) verify TBB is linked (or another parallel STL backend), (2) benchmark the specific workload on the production hardware configuration (the speedup is highly dependent on data size and available cores), (3) verify thread safety of any element access in `par_unseq` operations (the policy allows vectorization, so element functions must be reentrant and free of data races).

**When parallel STL beats a custom thread pool.** For workloads that fit cleanly into the STL algorithm model (sort, transform, reduce), parallel STL is often faster than a custom thread pool implementation because TBB's work stealing and cache-aware partitioning is highly optimized. A staff engineer benchmarks parallel STL against a custom implementation before building anything custom.

