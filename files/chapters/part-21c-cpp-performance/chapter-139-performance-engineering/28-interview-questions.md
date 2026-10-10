## Interview Questions

### Conceptual Questions

**Q1: Explain the difference between latency and throughput in the context of CPU pipelines.**

A pipeline increases throughput (instructions completed per cycle) without reducing latency (time for a single instruction to complete). A 15-stage pipeline still takes 15 cycles for one instruction, but it can complete one instruction per cycle in steady state. Stalls (from branches, dependencies, or cache misses) reduce the throughput advantage by creating pipeline bubbles.

**Q2: Why is linked list traversal slow on modern hardware, even though it is O(N)?**

Each node in a linked list is allocated independently, meaning consecutive nodes may be on different cache lines or even different memory pages. Following a pointer to the next node frequently causes an L1 or L2 cache miss, costing 4-100ns per node. A vector traversal accesses memory sequentially, and the hardware prefetcher loads the next cache line before it is needed. For N=10000, the vector traversal might be 10-50x faster despite identical algorithmic complexity.

**Q3: What is false sharing, and how do you prevent it?**

False sharing occurs when two threads write to different variables that happen to reside on the same cache line. Each write invalidates the entire cache line on the other core, causing expensive cache coherence traffic despite there being no logical data sharing. Prevention: pad or align shared variables to separate cache lines using `alignas(64)` or `std::hardware_destructive_interference_size`.

```cpp
// Bad: false sharing
struct Counters {
    std::atomic<int> counter_a;  // 4 bytes
    std::atomic<int> counter_b;  // 4 bytes - same cache line!
};

// Good: padded to avoid false sharing
struct PaddedCounters {
    alignas(64) std::atomic<int> counter_a;
    alignas(64) std::atomic<int> counter_b;
};
```

**Q4: When would you choose AoS over SoA?**

AoS is better when you frequently access all or most fields of each entity together (e.g., serialization, copying individual entities, operations that touch every field). SoA is better when operations touch only a subset of fields across many entities (e.g., physics updates that only need position and velocity). The decision depends on access patterns, not on a universal rule.

**Q5: What does profile-guided optimization (PGO) actually change in the generated code?**

PGO changes code layout (hot basic blocks in fall-through paths), inlining decisions (hot call sites inlined more aggressively, cold ones not inlined at all), branch prediction hints (compiler emits branch instructions matching observed probabilities), register allocation (hot paths get more registers), and loop optimization (unrolling decisions based on observed trip counts). It typically improves performance by 10-20%.

### Coding Questions

**Q6: Write a function that determines whether a given array access pattern is cache-friendly.**

```cpp
#include <chrono>
#include <vector>
#include <numeric>

// Measure access pattern performance and estimate cache-friendliness
struct CacheAnalysis {
    double ns_per_access;
    bool likely_cache_friendly;  // < 5ns/access = likely L1/L2 hits
};

CacheAnalysis analyze_access_pattern(const std::vector<size_t>& indices,
                                      const std::vector<int>& data) {
    volatile int sink = 0;
    // Warmup
    for (size_t idx : indices) sink += data[idx];

    auto start = std::chrono::high_resolution_clock::now();
    long long sum = 0;
    for (size_t idx : indices) {
        sum += data[idx];
    }
    auto end = std::chrono::high_resolution_clock::now();

    double ns = std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count();
    double ns_per = ns / indices.size();

    return CacheAnalysis{ns_per, ns_per < 5.0};
}
```

**Q7: Implement a simple arena allocator and demonstrate its performance advantage over `new`/`delete`.**

```cpp
#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <new>

class Arena {
    char* buffer_;
    size_t capacity_;
    size_t offset_;

public:
    explicit Arena(size_t capacity)
        : buffer_(static_cast<char*>(std::aligned_alloc(64, capacity)))
        , capacity_(capacity)
        , offset_(0) {
        if (!buffer_) throw std::bad_alloc();
    }

    ~Arena() { std::free(buffer_); }

    void* allocate(size_t size, size_t alignment = alignof(std::max_align_t)) {
        size_t aligned_offset = (offset_ + alignment - 1) & ~(alignment - 1);
        if (aligned_offset + size > capacity_) throw std::bad_alloc();
        void* ptr = buffer_ + aligned_offset;
        offset_ = aligned_offset + size;
        return ptr;
    }

    void reset() { offset_ = 0; }  // "free" all allocations at once

    // No individual deallocation - that's the point
};

// Usage: allocate thousands of small objects with zero fragmentation
// and free them all at once
void arena_benchmark() {
    constexpr int N = 1'000'000;

    // Standard allocation
    auto start = std::chrono::high_resolution_clock::now();
    std::vector<int*> ptrs(N);
    for (int i = 0; i < N; ++i) {
        ptrs[i] = new int(i);
    }
    for (int i = 0; i < N; ++i) {
        delete ptrs[i];
    }
    auto end = std::chrono::high_resolution_clock::now();
    auto std_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count();

    // Arena allocation
    Arena arena(N * sizeof(int) + N * alignof(int));
    start = std::chrono::high_resolution_clock::now();
    for (int i = 0; i < N; ++i) {
        int* p = static_cast<int*>(arena.allocate(sizeof(int), alignof(int)));
        *p = i;
    }
    arena.reset();  // free everything at once
    end = std::chrono::high_resolution_clock::now();
    auto arena_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count();

    std::cout << "Standard: " << std_ns / 1'000'000 << " ms\n";
    std::cout << "Arena:    " << arena_ns / 1'000'000 << " ms\n";
    std::cout << "Speedup:  " << (double)std_ns / arena_ns << "x\n";
}
```

**Q8: You have a hot loop that processes a stream of events. Each event has a type field, and the processing logic differs by type. The branch predictor struggles because event types arrive in random order. How do you fix this?**

Sort events by type before processing, then use a tight loop per type. This converts unpredictable branches into predictable ones and enables the compiler to optimize each type-specific loop independently:

```cpp
enum class EventType : uint8_t { Click, Scroll, KeyPress, Resize, COUNT };

struct Event {
    EventType type;
    uint32_t data;
    uint64_t timestamp;
};

// Slow: unpredictable branches in hot loop
void process_unsorted(std::vector<Event>& events) {
    for (auto& e : events) {
        switch (e.type) {  // branch predictor struggles
            case EventType::Click:    handle_click(e);    break;
            case EventType::Scroll:   handle_scroll(e);   break;
            case EventType::KeyPress: handle_keypress(e);  break;
            case EventType::Resize:   handle_resize(e);   break;
        }
    }
}

// Fast: sort by type, then process each type in a tight loop
void process_sorted(std::vector<Event>& events) {
    // Radix-sort by type (4 buckets, single pass)
    std::array<std::vector<Event>, static_cast<size_t>(EventType::COUNT)> buckets;
    for (auto& e : events) {
        buckets[static_cast<size_t>(e.type)].push_back(std::move(e));
    }

    // Process each bucket: branches are perfectly predictable
    for (auto& e : buckets[0]) handle_click(e);
    for (auto& e : buckets[1]) handle_scroll(e);
    for (auto& e : buckets[2]) handle_keypress(e);
    for (auto& e : buckets[3]) handle_resize(e);
}
```

**Q9: Explain why this code is slow and fix it:**

```cpp
struct Node {
    int value;
    Node* next;
};

int sum_list(Node* head) {
    int sum = 0;
    while (head) {
        sum += head->value;
        head = head->next;
    }
    return sum;
}
```

The linked list causes a cache miss on nearly every `head = head->next` dereference because nodes are scattered in memory. The fix depends on constraints: if insertion order does not matter, use a `std::vector<int>`. If you need pointer stability, use a pool allocator so nodes are contiguous in memory. If you need the list structure, you can embed a prefetch hint:

```cpp
int sum_list_prefetched(Node* head) {
    int sum = 0;
    while (head) {
        // Prefetch the next-next node to hide one pointer-chase latency
        if (head->next) {
            _mm_prefetch(reinterpret_cast<const char*>(head->next->next), _MM_HINT_T0);
        }
        sum += head->value;
        head = head->next;
    }
    return sum;
}
```

But the real fix is to not use a linked list at all for performance-critical traversal.

**Q10: A Go developer argues that Go's performance is "close enough" to C++ for most applications. How do you respond?**

They are largely correct for I/O-bound and concurrency-heavy workloads. Go typically achieves 50-80% of C++ throughput for these cases, and the development velocity advantage often outweighs the performance gap. However, for compute-bound workloads (scientific computing, game engines, codecs, databases, trading systems), C++ offers 2-8x better performance through SIMD intrinsics, zero-cost abstractions, deterministic memory management, and fine-grained hardware control. The right answer depends on the workload profile: measure first, then choose the language that best matches your performance requirements and team capabilities.

---
