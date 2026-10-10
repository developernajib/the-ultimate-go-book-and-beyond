## Custom Allocators with `std::pmr`

Heap allocation dominates latency profiles in high-QPS C++ services. Global `operator new` traverses a central bookkeeping structure, contends on locks under load, and fragments over hours of uptime. C++17's polymorphic memory resources (`std::pmr`) let you swap in arena, stack, or pool allocators per call site, without changing container types. This is the allocator subsystem FAANG services run in production.

### The `std::pmr` model

`std::pmr::memory_resource` is an abstract base with three virtual operations: `do_allocate`, `do_deallocate`, `do_is_equal`. Concrete resources derive from it. Containers accept a `polymorphic_allocator<T>` that dispatches through the resource pointer. One container type, many allocation strategies.

```cpp
#include <memory_resource>
#include <vector>
#include <string>

void per_request_handler(std::byte* stack_buf, std::size_t n) {
    std::pmr::monotonic_buffer_resource arena(stack_buf, n);
    std::pmr::vector<std::pmr::string> tokens(&arena);
    tokens.reserve(64);
    tokens.emplace_back("hello", &arena);
    // All allocations hit the stack buffer, zero heap traffic.
    // arena destructor is a no-op, entire request memory is reclaimed at once.
}
```

Per-request arenas are the single biggest win. Allocate a thread-local 64 KB buffer on entry, point every container at it, and at response time the entire working set is discarded in O(1). No individual `delete` calls, no free-list traversal.

### Pool resource for fixed-size churn

`std::pmr::unsynchronized_pool_resource` maintains free-lists segregated by block size. Ideal for workloads that churn small objects of a few discrete sizes (request headers, JSON nodes). Configure it explicitly:

```cpp
std::pmr::pool_options opts{
    .max_blocks_per_chunk = 256,
    .largest_required_pool_block = 512
};
std::pmr::unsynchronized_pool_resource pool(opts);
std::pmr::vector<Event> events(&pool);
```

Unsynchronized variants are fastest but thread-local. The `synchronized_pool_resource` adds an internal mutex for multi-threaded use, and under high contention it is slower than per-thread unsynchronized pools with occasional upstream refill.

### Slab allocator for homogeneous objects

For a single type allocated at millions of ops/sec (packet descriptors, futures), a custom slab resource beats any general-purpose pool. Preallocate a contiguous array, manage a free-list inside the unused slots, and `allocate` becomes a pointer bump on the free-list head.

```cpp
class slab_resource : public std::pmr::memory_resource {
public:
    slab_resource(std::size_t block_size, std::size_t capacity)
        : block_size_(block_size) {
        storage_.resize(block_size * capacity);
        for (std::size_t i = 0; i < capacity; ++i) {
            auto* slot = reinterpret_cast<free_slot*>(storage_.data() + i * block_size);
            slot->next = head_;
            head_ = slot;
        }
    }

protected:
    void* do_allocate(std::size_t bytes, std::size_t) override {
        if (bytes > block_size_ || !head_) throw std::bad_alloc();
        auto* s = head_;
        head_ = s->next;
        return s;
    }
    void do_deallocate(void* p, std::size_t, std::size_t) override {
        auto* s = static_cast<free_slot*>(p);
        s->next = head_;
        head_ = s;
    }
    bool do_is_equal(const memory_resource& o) const noexcept override {
        return this == &o;
    }

private:
    struct free_slot { free_slot* next; };
    std::vector<std::byte> storage_;
    std::size_t block_size_;
    free_slot* head_{nullptr};
};
```

Wrap in a mutex or make it thread-local for safety. A slab allocator delivers sub-10 ns allocation on modern hardware, two orders of magnitude faster than `malloc`.

### Upstream composition

Resources chain through an `upstream` pointer. A pool allocates chunks from its upstream (default: `new_delete_resource`), a monotonic arena falls back to upstream when its buffer is exhausted. You compose a four-tier system, thread-local slab, thread-local pool, process-wide synchronized pool, global `new`, by wiring upstreams without rewriting a single container type.

### Measurement

Always measure. Replace `vector<T>` with `pmr::vector<T>(arena)` in hot paths, run your service under `perf record -g`, and compare. Typical result on a JSON parser: 3x throughput, 70 percent lower p99, because allocation leaves the critical path and cache locality improves dramatically.

### Go comparison

Go's GC is excellent for general code but offers no per-request arena escape hatch. The closest analogue is `sync.Pool`, which is a per-P free-list, weaker than pmr pools because objects can be reclaimed between uses. For allocation-sensitive services, C++'s pmr is a decisive advantage.
