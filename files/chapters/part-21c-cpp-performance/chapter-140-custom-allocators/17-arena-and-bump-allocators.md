## Arena and Bump Allocators

The bump allocator is the simplest fast allocator that exists. Allocate a slab. Hold a pointer to the next free byte. To allocate N bytes, return the pointer and add N to it. There is no per-allocation metadata. There is no free list. Individual `free` is not supported. To free, throw away the entire arena.

This is not a toy. Google's Protocol Buffers ship a production arena. LLVM uses arenas (`BumpPtrAllocator`) throughout the compiler. Rust's `bumpalo` crate is the same idea. Region-based memory management is a serious programming model and arena allocators are how you implement it in C++.

### The Allocator

```cpp
class BumpAllocator {
    struct Chunk {
        Chunk* prev;
        size_t size;
        std::byte data[];  // flexible array, sized at allocation time
    };

    Chunk* current_ = nullptr;
    std::byte* next_ = nullptr;
    std::byte* end_ = nullptr;
    size_t next_chunk_size_ = 4096;

    void grow(size_t needed) {
        const size_t sz = std::max(next_chunk_size_, needed + sizeof(Chunk));
        auto* raw = static_cast<std::byte*>(::operator new(sz));
        auto* chunk = reinterpret_cast<Chunk*>(raw);
        chunk->prev = current_;
        chunk->size = sz;
        current_ = chunk;
        next_ = chunk->data;
        end_ = raw + sz;
        next_chunk_size_ = std::min<size_t>(sz * 2, 1 << 20);
    }

public:
    BumpAllocator() = default;
    BumpAllocator(const BumpAllocator&) = delete;

    ~BumpAllocator() { reset(); }

    [[nodiscard]] void* allocate(size_t bytes, size_t alignment) {
        std::byte* aligned = reinterpret_cast<std::byte*>(
            (reinterpret_cast<uintptr_t>(next_) + alignment - 1) & ~(alignment - 1));
        if (aligned + bytes > end_) [[unlikely]] {
            grow(bytes + alignment);
            aligned = reinterpret_cast<std::byte*>(
                (reinterpret_cast<uintptr_t>(next_) + alignment - 1) & ~(alignment - 1));
        }
        next_ = aligned + bytes;
        return aligned;
    }

    void reset() noexcept {
        while (current_) {
            Chunk* prev = current_->prev;
            ::operator delete(current_);
            current_ = prev;
        }
        next_ = end_ = nullptr;
        next_chunk_size_ = 4096;
    }
};
```

The hot path is six instructions: align next, compare to end, store next, return. Compare to a generic `malloc` (~30 ns) and a bump allocation (~3 ns).

### Geometric Growth

`next_chunk_size_` doubles up to a cap. Without geometric growth, an arena that allocates 100MB through a stream of 1KB allocations performs 100,000 chunk allocations. With doubling, it performs ~17.

The cap matters. Without a cap, a long-lived arena that hits a peak of 1GB and then settles at 100KB still holds the 1GB chunk. The cap (here 1MiB) puts an upper bound on wasted tail space.

### No Per-Object Free, On Purpose

Region-based memory management is a programming model where every allocation belongs to a "region" with a known lifetime. Inside the region you do not free individual objects. When the region ends, all of it goes at once. This is provably leak-free for the region's allocations, dramatically faster than per-object freeing, and much simpler to reason about.

Server request handlers are a near-perfect fit. Compiler passes are a perfect fit (LLVM does this). Game engine per-frame data is a perfect fit. Any computation with a clear "scope" is a candidate.

```cpp
void handle_request(const Request& req) {
    BumpAllocator arena;
    auto* parsed = arena.allocate_obj<ParsedRequest>(arena, req);
    auto* result = process(arena, parsed);
    write_response(result);
    // arena destructor frees everything in O(num_chunks).
}
```

Inside `process`, you build trees, vectors, strings, all rooted in `arena`. None of them have destructors that free memory (only ones that invalidate handles, run hooks, etc). The arena destructor is the only freeing path.

### Trivially Destructible Constraint

Bump-allocated objects either need their destructors invoked manually or must be trivially destructible. The arena does not track which objects exist. If you bump-allocate a `std::string` (with its own heap pointer), you must remember to destroy it before resetting the arena, or you leak the inner heap allocation.

The clean rule: store only trivially destructible types in arenas. Use arena-aware string types (`absl::string_view`, in-arena strings) instead of `std::string`. Use arena-aware containers (LLVM's `SmallVector` with arena allocator) instead of `std::vector`.

If you must store types with destructors, register them.

```cpp
class TrackingArena {
    BumpAllocator alloc_;
    struct Dtor { void* obj; void (*fn)(void*); };
    std::vector<Dtor> dtors_;

public:
    template <typename T, typename... Args>
    T* create(Args&&... args) {
        void* mem = alloc_.allocate(sizeof(T), alignof(T));
        T* obj = new (mem) T(std::forward<Args>(args)...);
        if constexpr (!std::is_trivially_destructible_v<T>) {
            dtors_.push_back({obj, [](void* p) { static_cast<T*>(p)->~T(); }});
        }
        return obj;
    }

    ~TrackingArena() {
        for (auto it = dtors_.rbegin(); it != dtors_.rend(); ++it) {
            it->fn(it->obj);
        }
    }
};
```

Iterating destructors costs you the per-object overhead you were trying to avoid. The compromise: track only non-trivially-destructible objects.

### Google Protobuf Arena

Protobuf's `google::protobuf::Arena` is a production arena allocator with bells.

```cpp
google::protobuf::ArenaOptions options;
options.start_block_size = 4096;
options.max_block_size = 1 << 20;

google::protobuf::Arena arena(options);
auto* msg = google::protobuf::Arena::Create<MyMessage>(&arena);
msg->set_field(...);
// arena dtor frees msg and all sub-messages allocated inside it
```

Arena-aware messages skip per-field heap allocation. A `repeated string` field stores the strings inside the arena. The whole message tree allocates from one arena. For RPC servers handling 100k messages per second, the savings are enormous.

Subtleties.

- Copying an arena-allocated message into a non-arena message copies the strings. The arena does not own them anymore.
- `set_allocated_xxx` on an arena message is dangerous if the value is heap-allocated, it transfers ownership wrong.
- `Swap` between arenas of different lifetimes is a bug factory.

Read the protobuf arena guide carefully before building services on it.

### Integration with `std::pmr`

`std::pmr::monotonic_buffer_resource` is a standard-library bump allocator. Same idea, standard interface.

```cpp
#include <memory_resource>
#include <vector>

std::byte buffer[8192];
std::pmr::monotonic_buffer_resource pool(buffer, sizeof(buffer));
std::pmr::vector<int> v(&pool);
v.reserve(1000);  // allocates from pool, no heap
v.push_back(42);
// pool dtor releases everything (the buffer here is on the stack)
```

`monotonic_buffer_resource` accepts an upstream resource for when the buffer fills. The default upstream is `std::pmr::new_delete_resource`. This is the standard, portable way to write region-allocated containers in modern C++.

### When the Arena Hurts

- Long-lived objects mixed with short-lived ones in the same arena. The long-lived ones pin chunks that should have been released. Use separate arenas.
- Arena lifetimes that escape function scope and become "the whole program." Now you have a leak.
- High-rate cross-thread sharing. A bump pointer is one atomic on contention. Past a few cores it becomes a bottleneck. Either shard arenas per thread or pick a different allocator.

### Junior to FAANG

A junior engineer writes a `BumpAllocator` and uses it for everything. A FAANG-grade engineer scopes arenas to clearly-defined regions (request, frame, query, compilation pass), enforces trivially-destructible discipline, integrates `std::pmr` so containers Just Work, knows when to track destructors and when not, and treats per-object `free` from an arena as an architectural mistake. They also know that arenas are the cheapest path to "delete a million objects in microseconds" that exists in C++.
