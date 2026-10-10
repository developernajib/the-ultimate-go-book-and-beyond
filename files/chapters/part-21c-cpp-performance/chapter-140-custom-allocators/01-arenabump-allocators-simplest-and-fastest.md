## Arena/Bump Allocators, Simplest and Fastest

An arena allocator (also called a bump allocator or linear allocator) is the simplest possible allocator. It maintains a pointer into a contiguous block of memory and "bumps" it forward on each allocation. Deallocation is a no-op, you free the entire arena at once.

### Why Arenas Are Fast

A general-purpose allocator must maintain free lists, coalesce freed blocks, handle fragmentation, and synchronize across threads. A bump allocator does exactly one thing: increment a pointer. This compiles down to a single `add` instruction on the hot path.

```cpp
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cassert>
#include <new>

class ArenaAllocator {
    uint8_t* buffer_;
    size_t   capacity_;
    size_t   offset_;

public:
    explicit ArenaAllocator(size_t capacity)
        : buffer_(static_cast<uint8_t*>(std::malloc(capacity)))
        , capacity_(capacity)
        , offset_(0)
    {
        if (!buffer_) throw std::bad_alloc();
    }

    ~ArenaAllocator() {
        std::free(buffer_);
    }

    // Non-copyable, non-movable for simplicity
    ArenaAllocator(const ArenaAllocator&) = delete;
    ArenaAllocator& operator=(const ArenaAllocator&) = delete;

    void* allocate(size_t size, size_t alignment = alignof(std::max_align_t)) {
        // Round offset up to required alignment
        size_t aligned_offset = (offset_ + alignment - 1) & ~(alignment - 1);

        if (aligned_offset + size > capacity_) {
            return nullptr;  // Out of memory
        }

        void* ptr = buffer_ + aligned_offset;
        offset_ = aligned_offset + size;
        return ptr;
    }

    // Individual deallocation is a no-op
    void deallocate(void* /*ptr*/) {
        // Intentionally empty -- free everything at once with reset()
    }

    void reset() {
        offset_ = 0;  // "Free" everything in O(1)
    }

    size_t used() const { return offset_; }
    size_t remaining() const { return capacity_ - offset_; }
};
```

### Typed Allocation with Placement New

The `arena_new` helper wraps placement new so typed objects can be constructed directly inside arena-owned memory without a separate heap allocation. This pattern is commonly used in game engines and parsers where all per-frame or per-request objects share the same arena and are freed together at a single reset point, eliminating individual destructor calls and `free` overhead.
```cpp
template <typename T, typename... Args>
T* arena_new(ArenaAllocator& arena, Args&&... args) {
    void* mem = arena.allocate(sizeof(T), alignof(T));
    if (!mem) throw std::bad_alloc();
    return new (mem) T(std::forward<Args>(args)...);
}

// Usage
void process_frame(ArenaAllocator& frame_arena) {
    // Allocate per-frame data -- all freed together at frame end
    auto* positions = static_cast<float*>(
        frame_arena.allocate(1000 * sizeof(float), alignof(float))
    );

    struct Particle {
        float x, y, z;
        float vx, vy, vz;
    };

    auto* particles = arena_new<Particle>(frame_arena);
    particles->x = 1.0f;

    // ... do work ...

    // End of frame: free everything at once
    frame_arena.reset();
}
```

### When to Use Arenas

- **Per-frame game allocations**: Allocate everything for one frame, reset between frames.
- **Request-scoped server data**: Each HTTP request gets an arena, freed when the response is sent.
- **Compiler/parser temporary data**: AST nodes allocated during one pass, freed after the pass.
- **Batch processing**: Process a batch of records, then discard all intermediate results.

The pattern is always the same: many allocations sharing a common lifetime. If your objects die together, an arena is almost certainly the right choice.

---
