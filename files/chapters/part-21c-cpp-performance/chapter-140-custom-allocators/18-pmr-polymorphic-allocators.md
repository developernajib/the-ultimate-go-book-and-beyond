## PMR: Polymorphic Allocators in Modern C++

`std::pmr` (C++17) is the first allocator interface in standard C++ that does not poison your container types. The classic `std::vector<T, MyAllocator>` is a different type from `std::vector<T>`. Two functions returning vectors with different allocators are incompatible. Generic libraries cannot accept "any vector regardless of allocator" without templates. PMR fixes this by hiding the allocator behind a virtual interface. The container type is `std::pmr::vector<T>`. The allocator is a `std::pmr::memory_resource*` stored inside the vector.

The cost is one indirect call per allocation. The benefit is composability. For most codebases this is a good trade.

### The Three Standard Resources

```cpp
#include <memory_resource>

// 1. monotonic_buffer_resource: bump allocator. No deallocation.
std::byte buffer[64 * 1024];
std::pmr::monotonic_buffer_resource mono(buffer, sizeof(buffer));

// 2. unsynchronized_pool_resource: pool of fixed-size blocks per size class.
//    Single-threaded use only.
std::pmr::pool_options opts{
    .max_blocks_per_chunk = 1024,
    .largest_required_pool_block = 4096,
};
std::pmr::unsynchronized_pool_resource pool(opts);

// 3. synchronized_pool_resource: like above, with a mutex.
std::pmr::synchronized_pool_resource sync_pool(opts);
```

`monotonic_buffer_resource` is the workhorse. It serves bump-allocator workloads (request scope, frame scope) without any heap traffic until the local buffer fills. It is the right default for short-lived containers.

`unsynchronized_pool_resource` is a per-size-class pool that does support deallocation. Use it for many-small-objects workloads where individual frees matter (you cannot wait until the resource dies to reclaim).

`synchronized_pool_resource` is the same with a mutex. Use it from multiple threads. Performance is mediocre because the mutex serializes everything. For real multi-threaded workloads, use a thread-cached allocator (jemalloc/mimalloc/tcmalloc) or shard the resource per thread.

### The Default Resource

There is a process-wide default. New `std::pmr` containers without an explicit resource use it. By default it is `std::pmr::new_delete_resource()` (a wrapper over `::operator new`). You can replace it.

```cpp
// At program start, before any pmr container is constructed:
std::pmr::set_default_resource(&my_resource);

// Now this allocates from my_resource:
std::pmr::vector<int> v;
```

Setting the default resource at startup is one way to override allocations across an entire subsystem without rewriting every container declaration.

### Chained Resources

`monotonic_buffer_resource` accepts an "upstream" resource. When its local buffer fills, it asks upstream for more. This composes naturally.

```cpp
std::pmr::synchronized_pool_resource pool;
std::byte stack_buf[8192];
std::pmr::monotonic_buffer_resource arena(stack_buf, sizeof(stack_buf), &pool);

std::pmr::vector<std::pmr::string> strings(&arena);
strings.emplace_back("hello");
// First few allocations come from stack_buf.
// When stack_buf fills, arena pulls a chunk from pool.
// When pool is exhausted (rare), pool pulls from its upstream
// (default: new_delete_resource).
```

Three layers, no virtual call cost beyond one per allocation. The layering pattern (stack buffer -> bump arena -> pool -> heap) is the standard pattern for low-allocation hot paths in modern C++.

### Writing a Custom Resource

`memory_resource` has three virtual functions to override.

```cpp
class TrackingResource : public std::pmr::memory_resource {
    std::pmr::memory_resource* upstream_;
    std::atomic<size_t> live_bytes_{0};

public:
    explicit TrackingResource(std::pmr::memory_resource* up = std::pmr::new_delete_resource())
        : upstream_(up) {}

    size_t live_bytes() const noexcept { return live_bytes_.load(); }

private:
    void* do_allocate(size_t bytes, size_t alignment) override {
        void* p = upstream_->allocate(bytes, alignment);
        live_bytes_.fetch_add(bytes, std::memory_order_relaxed);
        return p;
    }

    void do_deallocate(void* p, size_t bytes, size_t alignment) override {
        upstream_->deallocate(p, bytes, alignment);
        live_bytes_.fetch_sub(bytes, std::memory_order_relaxed);
    }

    bool do_is_equal(const std::pmr::memory_resource& o) const noexcept override {
        return this == &o;
    }
};
```

A few rules.

- `do_is_equal` is used to decide whether memory allocated by one resource can be deallocated by another. Default to identity (`this == &o`). Override only if you actually have a sharing model.
- `do_allocate` may throw. Throw `std::bad_alloc` (which is what the upstream call will already do).
- The standard requires `do_allocate(0, ...)` to return a valid pointer. Most upstreams handle this. If you implement allocation by hand, do not return `nullptr` for zero.

### Propagation Traits

`std::pmr::polymorphic_allocator` deliberately does not propagate on copy assignment, move assignment, or swap. The allocator is "sticky" to the container instance.

```cpp
std::pmr::vector<int> a(&res1);
std::pmr::vector<int> b(&res2);

a = b;       // a still uses res1; elements are reallocated from res1
a = std::move(b);  // a still uses res1; if res1 != res2, elements are MOVED (or copied)
                   // element-by-element from res2 into res1
swap(a, b);  // UB if res1 != res2 (the standard says swap requires equal allocators)
```

This catches engineers off-guard. The mental model: "the container belongs to its arena, the contents follow regardless of where they came from." For most use cases this is what you want. A request-scoped vector should not start allocating from the previous request's arena because you assigned to it from a long-lived vector.

The classic `std::allocator_traits` propagation flags (`propagate_on_container_copy_assignment`, etc) still exist for non-pmr allocators. PMR's choice is to set them all to `false`.

### Bloomberg's Production Pattern

Bloomberg drove PMR into the standard. Their internal allocator framework predates C++17 by years and informs every design decision. The pattern they use in production:

1. Allocators are first-class arguments. Every constructor that allocates accepts an `allocator_type`.
2. No global allocator state. Test scenarios pass test allocators that count, track, or fail.
3. Components are allocator-agnostic. A library function accepting `std::pmr::vector<T>` works regardless of the resource.
4. Resources have explicit lifetimes. A `TestResource` that detects leaks at destruction is the foundation of allocation testing.

```cpp
class TestResource : public std::pmr::memory_resource {
    size_t live_ = 0;
    size_t total_ = 0;
public:
    ~TestResource() {
        assert(live_ == 0 && "leak detected");
    }
    // ... do_allocate increments both, do_deallocate decrements live_
};

void test_my_function() {
    TestResource res;
    {
        std::pmr::vector<int> v(&res);
        my_function(v);
    }
    // res destructor asserts no leaks
}
```

Run this in CI. Every test gets its own resource. Leak in any test, fail in that test, point at the function. Production-grade.

### Performance Cost

The virtual call adds a few cycles per allocation. For a `monotonic_buffer_resource` with a hot bump pointer, the indirect call is comparable to the actual allocation work. For workloads where allocation is the bottleneck this matters.

The escape: template containers on the resource type to devirtualize. Or use the non-pmr allocator for the absolute hot path and pmr everywhere else. Most production code does not need to escape, the indirect call is paid for by the composability.

### Junior to FAANG

A junior engineer uses `std::pmr` because it sounds modern and gets confused when assignment does not propagate the allocator. A FAANG-grade engineer designs subsystems around a clear resource hierarchy (stack buffer -> arena -> pool -> heap), writes test resources that detect leaks, accepts `std::pmr::memory_resource*` in public APIs, and knows that the right way to make a hot path zero-allocation is to construct an arena once and reuse it across requests, not to chase virtual call cost. They also read the Bloomberg BDE design docs at least once to internalize the discipline.
