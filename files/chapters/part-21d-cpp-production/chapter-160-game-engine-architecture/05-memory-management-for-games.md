## Memory Management for Games

The rule is simple and absolute: **no allocation during the frame**. Everything else in this section follows from it.

### Why `new` Is Banned

`malloc` is not slow on average. It is slow *sometimes*, and sometimes is what kills you. A general allocator may take a lock, may search a free list, may fall into a slow path, may ask the OS for pages and take a page fault, may trigger a heap coalesce. Each is rare and each lands on one unlucky frame, and that frame is a stutter.

The distribution is the whole problem. An allocator averaging 30 ns with a 200 microsecond tail is excellent for a server and unusable in a frame loop, because at 10,000 allocations per frame you will hit the tail every frame.

Fragmentation is the second reason, and on consoles it is existential. A long play session with mixed-size allocations fragments the heap until a large allocation fails despite sufficient free memory. A PC can lean on virtual memory - a console with a fixed budget and no swap cannot. Shipping titles have crashed after four hours specifically from fragmentation.

So engines do not use general allocators on the hot path. They use purpose-built ones whose worst case equals their average case.

### The Frame Arena

The most-used allocator in any engine. Bump a pointer to allocate, reset the pointer at end of frame to free everything at once.

```cpp
class FrameArena {
public:
    explicit FrameArena(size_t bytes)
        : base_(static_cast<std::byte*>(::operator new(bytes)))
        , size_(bytes) {}

    ~FrameArena() { ::operator delete(base_); }

    // Allocation is: align, bump, return. No lock, no search, no free list.
    void* alloc(size_t bytes, size_t align = alignof(std::max_align_t)) {
        size_t p = (offset_ + align - 1) & ~(align - 1);
        if (p + bytes > size_) return nullptr;   // budget exceeded: a bug
        offset_ = p + bytes;
        return base_ + p;
    }

    template <typename T, typename... Args>
    T* make(Args&&... args) {
        static_assert(std::is_trivially_destructible_v<T>,
                      "arena never runs destructors");
        void* m = alloc(sizeof(T), alignof(T));
        return m ? new (m) T(std::forward<Args>(args)...) : nullptr;
    }

    void reset() { offset_ = 0; }   // frees everything, O(1)

private:
    std::byte* base_;
    size_t size_;
    size_t offset_ = 0;
};
```

Allocation is a handful of instructions with no branch worth predicting and no lock. Deallocation is setting an integer to zero. There is no fragmentation because there is no free list.

The `static_assert` encodes the contract: **the arena never runs destructors**. Anything with a non-trivial destructor must not live in it. That is not a limitation so much as the point, and it is why arena-allocated types in engines are plain data.

Each thread gets its own arena, so there is no synchronization at all.

### Pool Allocators

For fixed-size objects with individual lifetimes (particles, bullets, audio voices), a pool preallocates N slots and threads a free list through the unused ones.

```cpp
template <typename T, size_t N>
class Pool {
public:
    Pool() {
        for (size_t i = 0; i < N - 1; ++i)
            nextFree(i) = static_cast<uint32_t>(i + 1);
        nextFree(N - 1) = kEnd;
    }

    T* acquire() {
        if (head_ == kEnd) return nullptr;   // pool exhausted
        uint32_t i = head_;
        head_ = nextFree(i);
        return new (slot(i)) T();
    }

    void release(T* p) {
        p->~T();
        uint32_t i = static_cast<uint32_t>(
            (reinterpret_cast<std::byte*>(p) - storage_) / sizeof(Slot));
        nextFree(i) = head_;
        head_ = i;
    }

private:
    // The free list lives inside the unused slots. Zero overhead.
    static constexpr uint32_t kEnd = 0xFFFFFFFF;
    union Slot { alignas(T) std::byte data[sizeof(T)]; uint32_t next; };
    uint32_t& nextFree(uint32_t i) { return reinterpret_cast<Slot*>(storage_)[i].next; }
    void* slot(uint32_t i) { return &reinterpret_cast<Slot*>(storage_)[i]; }
    alignas(Slot) std::byte storage_[sizeof(Slot) * N];
    uint32_t head_ = 0;
};
```

Acquire and release are both O(1) with no search. The free list costs nothing because it lives in the storage of the free slots themselves, a trick worth internalizing.

The design decision a pool forces is **what happens when it is exhausted**, and it is a gameplay decision rather than a technical one. Returning null and dropping the particle is usually right. Growing the pool re-introduces the allocation you were avoiding. Recycling the oldest is right for audio voices. Every engine picks per subsystem and writes it down.

### The Allocator Menu

| Allocator | Alloc | Free | Use for |
|-----------|-------|------|---------|
| Frame arena | bump | reset all, O(1) | Per-frame scratch, command buffers |
| Pool | free-list pop | free-list push | Fixed-size, individual lifetimes |
| Stack | bump | pop to marker (LIFO) | Nested scopes, level load |
| Buddy / TLSF | bounded search | bounded | Bounded-latency general purpose |
| System `new` | unbounded | unbounded | Startup and tools only |

The rightmost column is a policy statement. In a shipping engine, `new` on a frame path is a review rejection.

### Junior to FAANG: The Answer That Lands

"Why do engines write custom allocators when `malloc` is fast?"

The answer is that `malloc` is fast *on average* and the frame loop cannot use averages. It may lock, search, fault, or coalesce, each rarely, and rarely times 10,000 allocations per frame is every frame. A 200 microsecond tail is fine for a server and a visible stutter at 60 fps.

Then name the second reason: fragmentation on a fixed memory budget with no swap, which has crashed shipping games hours into a session.

Then name the fix: arena for per-frame scratch (bump to allocate, reset to free, no fragmentation possible), pool for fixed-size objects with individual lifetimes. Both have worst case equal to average case, which is the property that actually matters.

### Senior at FAANG: Budgets as an Org Chart

At staff level memory is not a technical problem, it is an allocation of a scarce shared resource, and the engines that ship are the ones that made it explicit.

A console has a fixed budget. Every subsystem gets a number: textures 3 GB, meshes 1 GB, audio 512 MB, gameplay 256 MB, and the sum must be under the box's limit with headroom. Those numbers are negotiated between teams, tracked in CI, and enforced: a build that exceeds a budget fails, the way a test failure does. Without this, memory is a commons and it gets tragedied, because every individual feature's 5 MB is defensible and the sum ships at 110 percent.

The technical mechanism that makes budgets enforceable is per-subsystem allocators. If textures allocate from the texture arena, the texture budget is `arena.size()` and overspending is a hard failure at the allocation site rather than an OOM three hours later in someone else's code. This is the real reason engines have a dozen allocators, and it is an organizational reason as much as a performance one: it makes ownership legible and attribution automatic.

The corollary for review: a subsystem that allocates from the global heap has opted out of the budget system, and that is the finding, not its allocation count.
