## Cache Hierarchy: L1/L2/L3, Cache Lines, and Prefetching

### The Memory Hierarchy

Modern CPUs access memory through a hierarchy of progressively larger but slower caches:

| Level       | Size (typical) | Latency (cycles) | Latency (ns)   |
|-------------|---------------|-------------------|-----------------|
| Register    | ~1 KB         | 0                 | ~0.3            |
| L1 Cache    | 32-64 KB      | 4-5               | ~1              |
| L2 Cache    | 256 KB-1 MB   | 12-15             | ~4              |
| L3 Cache    | 8-64 MB       | 30-50             | ~12             |
| Main Memory | 16-512 GB     | 150-300           | ~50-100         |
| NVMe SSD    | 1-8 TB        | ~25,000           | ~10,000         |

A cache miss at L1 that hits L3 costs roughly 10x. A miss that goes to main memory costs roughly 100x. This single fact dominates performance engineering.

### Cache Lines

Caches transfer data in fixed-size blocks called cache lines, typically 64 bytes on x86. When you access a single byte, the CPU loads the entire 64-byte line containing that byte. This means sequential access patterns are free after the first access in each line, while random access patterns pay the full miss penalty for every access.

```cpp
#include <chrono>
#include <iostream>
#include <vector>
#include <numeric>
#include <random>

// Sequential access: exploits cache line prefetching
long long sequential_sum(const std::vector<int>& data) {
    long long sum = 0;
    for (size_t i = 0; i < data.size(); ++i) {
        sum += data[i];
    }
    return sum;
}

// Strided access: misses increase with stride
long long strided_sum(const std::vector<int>& data, size_t stride) {
    long long sum = 0;
    for (size_t i = 0; i < data.size(); i += stride) {
        sum += data[i];
    }
    return sum;
}

// Random access: worst case for cache
long long random_sum(const std::vector<int>& data, const std::vector<size_t>& indices) {
    long long sum = 0;
    for (size_t idx : indices) {
        sum += data[idx];
    }
    return sum;
}

void cache_demo() {
    constexpr size_t N = 64 * 1024 * 1024;  // 256 MB of ints
    std::vector<int> data(N);
    std::iota(data.begin(), data.end(), 0);

    // Generate random indices
    std::vector<size_t> indices(N);
    std::iota(indices.begin(), indices.end(), 0);
    std::mt19937 rng(42);
    std::shuffle(indices.begin(), indices.end(), rng);

    auto bench = [](const char* label, auto fn) {
        auto start = std::chrono::high_resolution_clock::now();
        auto result = fn();
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
        std::cout << label << ": " << ms << " ms (sum=" << result << ")\n";
    };

    bench("Sequential", [&] { return sequential_sum(data); });
    bench("Stride-16 ", [&] { return strided_sum(data, 16); });
    bench("Random    ", [&] { return random_sum(data, indices); });
}
```

Typical results on modern hardware: sequential access is 5-10x faster than random access for arrays that exceed the L3 cache.

### Hardware Prefetching and Software Hints

CPUs detect sequential and strided access patterns and prefetch cache lines before they are needed. You can also issue explicit prefetch hints:

```cpp
#include <xmmintrin.h>  // _mm_prefetch

void sum_with_prefetch(const float* data, size_t n, float& result) {
    constexpr size_t PREFETCH_DISTANCE = 16;  // prefetch 16 elements ahead
    float sum = 0.0f;

    for (size_t i = 0; i < n; ++i) {
        // Prefetch data that will be needed soon
        if (i + PREFETCH_DISTANCE < n) {
            _mm_prefetch(
                reinterpret_cast<const char*>(&data[i + PREFETCH_DISTANCE]),
                _MM_HINT_T0  // prefetch into L1
            );
        }
        sum += data[i];
    }
    result = sum;
}
```

Software prefetching is rarely needed for sequential access (the hardware prefetcher handles it), but it can help with irregular but predictable access patterns like pointer chasing through linked structures.

---
