## When Custom Allocators Matter (and When They Don't)

Custom allocators are not a default optimization. They add complexity and can introduce subtle bugs. Here is how to decide.

### Benchmark: Arena vs malloc vs PMR

Custom allocators replace the default heap allocator for a specific container or object graph, enabling allocation strategies such as pool allocation, arena allocation, or NUMA-aware placement. Providing a conforming allocator type hooks into the standard library's allocator-aware container interface without modifying container code.
```cpp
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory_resource>
#include <vector>

struct SmallObject {
    int data[4];
};

void benchmark_allocators() {
    constexpr size_t N = 1'000'000;

    // Benchmark 1: Raw malloc/free
    {
        auto start = std::chrono::high_resolution_clock::now();
        std::vector<void*> ptrs(N);

        for (size_t i = 0; i < N; ++i) {
            ptrs[i] = std::malloc(sizeof(SmallObject));
        }
        for (size_t i = 0; i < N; ++i) {
            std::free(ptrs[i]);
        }

        auto elapsed = std::chrono::high_resolution_clock::now() - start;
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
        printf("malloc/free:    %lld ms\n", (long long)ms.count());
    }

    // Benchmark 2: Arena (bump allocator)
    {
        auto start = std::chrono::high_resolution_clock::now();
        ArenaAllocator arena(N * sizeof(SmallObject) + N * alignof(SmallObject));

        for (size_t i = 0; i < N; ++i) {
            arena.allocate(sizeof(SmallObject), alignof(SmallObject));
        }
        arena.reset();

        auto elapsed = std::chrono::high_resolution_clock::now() - start;
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
        printf("Arena:          %lld ms\n", (long long)ms.count());
    }

    // Benchmark 3: PMR monotonic_buffer_resource
    {
        auto start = std::chrono::high_resolution_clock::now();
        std::pmr::monotonic_buffer_resource pool(
            N * sizeof(SmallObject) * 2
        );

        for (size_t i = 0; i < N; ++i) {
            pool.allocate(sizeof(SmallObject), alignof(SmallObject));
        }

        auto elapsed = std::chrono::high_resolution_clock::now() - start;
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
        printf("PMR monotonic:  %lld ms\n", (long long)ms.count());
    }

    // Benchmark 4: Pool allocator
    {
        auto start = std::chrono::high_resolution_clock::now();
        PoolAllocator<SmallObject> pool(N);

        std::vector<SmallObject*> ptrs(N);
        for (size_t i = 0; i < N; ++i) {
            ptrs[i] = pool.allocate();
        }
        for (size_t i = 0; i < N; ++i) {
            pool.deallocate(ptrs[i]);
        }

        auto elapsed = std::chrono::high_resolution_clock::now() - start;
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
        printf("Pool:           %lld ms\n", (long long)ms.count());
    }
}
```

### Typical Results (x86-64, Release Build, 1M Allocations)

The benchmark results below compare `malloc/free`, arena, PMR monotonic, and pool allocators across 1 million allocations on a release x86-64 build. The arena is ~14× faster than `malloc` because it replaces every allocation with a single pointer bump, while the PMR monotonic buffer and pool allocators show 5-8× gains from eliminating lock contention and free-list management overhead.
```
malloc/free:    42 ms
Arena:           3 ms      (~14x faster)
PMR monotonic:   5 ms      (~8x faster)
Pool:            8 ms      (~5x faster)
```

### When Custom Allocators ARE Worth It

1. **High allocation rate**: Millions of small allocations per second (game engines, parsers, compilers).
2. **Deterministic latency**: Real-time systems where malloc jitter is unacceptable.
3. **Known lifetimes**: Objects that are all freed together (request-scoped, frame-scoped).
4. **Cache optimization**: Keeping related objects contiguous in memory.
5. **Embedded/bare-metal**: No OS heap, or heap is too slow.
6. **Measured bottleneck**: Your profiler shows malloc in the hot path.

### When Custom Allocators Are NOT Worth It

1. **No profiling data**: If you have not measured, you are guessing.
2. **Few allocations**: Hundreds or even thousands of allocations per second are invisible.
3. **Complex lifetimes**: Objects with unpredictable lifetimes do not fit arenas or pools well.
4. **Small team/codebase**: The maintenance burden outweighs the performance gain.
5. **I/O-bound workload**: If you are waiting on disk or network, faster allocation will not help.

The golden rule: **profile first, allocate custom second.**

---
