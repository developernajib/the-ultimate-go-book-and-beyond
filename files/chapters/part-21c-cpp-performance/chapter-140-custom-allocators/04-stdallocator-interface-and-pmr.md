## std::allocator Interface and PMR

C++ provides two standardized ways to use custom allocators: the classic `std::allocator` interface (since C++98) and the modern Polymorphic Memory Resources (since C++17).

### The Classic std::allocator Interface

Every STL container accepts an allocator as a template parameter:

```cpp
#include <vector>
#include <cstdlib>

template <typename T>
class ArenaStdAllocator {
    ArenaAllocator* arena_;

public:
    using value_type = T;

    explicit ArenaStdAllocator(ArenaAllocator* arena) : arena_(arena) {}

    template <typename U>
    ArenaStdAllocator(const ArenaStdAllocator<U>& other) noexcept
        : arena_(other.arena()) {}

    ArenaAllocator* arena() const { return arena_; }

    T* allocate(std::size_t n) {
        void* p = arena_->allocate(n * sizeof(T), alignof(T));
        if (!p) throw std::bad_alloc();
        return static_cast<T*>(p);
    }

    void deallocate(T* p, std::size_t n) noexcept {
        arena_->deallocate(p);  // no-op for arena
    }

    template <typename U>
    bool operator==(const ArenaStdAllocator<U>& other) const {
        return arena_ == other.arena();
    }

    template <typename U>
    bool operator!=(const ArenaStdAllocator<U>& other) const {
        return !(*this == other);
    }
};

void example_classic_allocator() {
    ArenaAllocator arena(1024 * 1024);  // 1 MB arena

    // Vector backed by arena -- no malloc calls
    std::vector<int, ArenaStdAllocator<int>> vec(
        ArenaStdAllocator<int>(&arena)
    );

    for (int i = 0; i < 10000; ++i) {
        vec.push_back(i);
    }
    // vec's internal buffer lives in the arena
}
```

The classic interface has a major problem: the allocator type is baked into the container type. A `vector<int, ArenaAllocator<int>>` is a different type from `vector<int, PoolAllocator<int>>`, so you cannot pass one where the other is expected.

### PMR, Polymorphic Memory Resources (C++17)

PMR solves the type-infection problem by using runtime polymorphism instead of templates:

```cpp
#include <memory_resource>
#include <vector>
#include <string>
#include <cstdio>

// Custom memory resource that tracks allocations
class TrackingResource : public std::pmr::memory_resource {
    std::pmr::memory_resource* upstream_;
    size_t total_allocated_ = 0;
    size_t allocation_count_ = 0;

protected:
    void* do_allocate(size_t bytes, size_t alignment) override {
        total_allocated_ += bytes;
        ++allocation_count_;
        return upstream_->allocate(bytes, alignment);
    }

    void do_deallocate(void* p, size_t bytes, size_t alignment) override {
        total_allocated_ -= bytes;
        upstream_->deallocate(p, bytes, alignment);
    }

    bool do_is_equal(const memory_resource& other) const noexcept override {
        return this == &other;
    }

public:
    explicit TrackingResource(
        std::pmr::memory_resource* upstream = std::pmr::get_default_resource()
    ) : upstream_(upstream) {}

    size_t total_allocated() const { return total_allocated_; }
    size_t allocation_count() const { return allocation_count_; }
};

void example_pmr() {
    // Stack-based buffer for small allocations
    char buffer[4096];
    std::pmr::monotonic_buffer_resource pool(
        buffer, sizeof(buffer),
        std::pmr::null_memory_resource()  // Fail instead of falling back
    );

    TrackingResource tracker(&pool);

    // All pmr containers share the same base type regardless of resource
    std::pmr::vector<int> vec1(&tracker);
    std::pmr::vector<int> vec2(&tracker);

    for (int i = 0; i < 100; ++i) {
        vec1.push_back(i);
        vec2.push_back(i * 2);
    }

    std::printf("Allocations: %zu, Total bytes: %zu\n",
        tracker.allocation_count(), tracker.total_allocated());
}
```

### PMR Built-in Resources

C++17 ships several useful memory resources:

```cpp
#include <memory_resource>
#include <vector>
#include <list>

void pmr_builtin_resources() {
    // 1. monotonic_buffer_resource -- arena/bump allocator
    //    Fast allocation, no individual deallocation, bulk-free on destruction
    char stack_buf[8192];
    std::pmr::monotonic_buffer_resource arena(
        stack_buf, sizeof(stack_buf),
        std::pmr::get_default_resource()  // Overflow goes to default
    );

    std::pmr::vector<int> fast_vec(&arena);
    for (int i = 0; i < 1000; ++i) fast_vec.push_back(i);

    // 2. unsynchronized_pool_resource -- pool allocator (single-threaded)
    std::pmr::pool_options opts;
    opts.max_blocks_per_chunk = 100;
    opts.largest_required_pool_block = 1024;

    std::pmr::unsynchronized_pool_resource pool(opts);
    std::pmr::list<int> fast_list(&pool);  // List nodes from pool
    for (int i = 0; i < 1000; ++i) fast_list.push_back(i);

    // 3. synchronized_pool_resource -- thread-safe pool allocator
    std::pmr::synchronized_pool_resource thread_safe_pool(opts);
    // Safe to use from multiple threads
}
```

### Classic vs PMR, Decision Guide

| Feature | Classic `std::allocator` | PMR |
|---------|--------------------------|-----|
| Type infection | Yes, changes container type | No, same type regardless of resource |
| Performance | Compile-time dispatch (faster) | Virtual dispatch (small overhead) |
| Composability | Difficult | Easy, chain resources |
| Interoperability | Containers with different allocators are different types | All `pmr::` containers are interchangeable |
| Standard support | C++98+ | C++17+ |

**Rule of thumb:** Use PMR unless profiling shows the virtual dispatch overhead matters. In practice, it almost never does because allocator calls are already expensive compared to a virtual call.

---
