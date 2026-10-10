## Slab and Pool Allocators

A slab allocator is a fixed-size object cache. Bonwick described it for the Solaris kernel in 1994 and it has since shown up in every operating system kernel and every high-performance C++ codebase. The promise: O(1) alloc, O(1) free, zero fragmentation within a single object size, and natural cache locality.

If you allocate millions of `connection`, `request`, `node` objects per second, a slab allocator beats the general allocator by 5x to 20x.

### The Free List Is the Object

The trick that makes a slab allocator fast: when an object is free, the storage it occupies holds a pointer to the next free object. There is no separate free list array, no metadata header per object, no allocation map.

```cpp
template <typename T, size_t BlockCount = 4096>
class SlabAllocator {
    static_assert(sizeof(T) >= sizeof(void*), "T must be pointer-sized or larger");

    struct Block {
        alignas(T) std::byte storage[sizeof(T) * BlockCount];
        Block* next_block = nullptr;
    };

    void* free_head_ = nullptr;
    Block* blocks_ = nullptr;

    void grow() {
        Block* b = new Block;
        b->next_block = blocks_;
        blocks_ = b;
        // Thread BlockCount slots onto the free list.
        std::byte* base = b->storage;
        for (size_t i = 0; i < BlockCount; ++i) {
            void* slot = base + i * sizeof(T);
            *reinterpret_cast<void**>(slot) = free_head_;
            free_head_ = slot;
        }
    }

public:
    SlabAllocator() = default;
    SlabAllocator(const SlabAllocator&) = delete;
    SlabAllocator& operator=(const SlabAllocator&) = delete;

    ~SlabAllocator() {
        while (blocks_) {
            Block* next = blocks_->next_block;
            delete blocks_;
            blocks_ = next;
        }
    }

    [[nodiscard]] T* allocate() {
        if (!free_head_) [[unlikely]] grow();
        void* slot = free_head_;
        free_head_ = *reinterpret_cast<void**>(slot);
        return std::launder(reinterpret_cast<T*>(slot));
    }

    void deallocate(T* p) noexcept {
        *reinterpret_cast<void**>(p) = free_head_;
        free_head_ = p;
    }
};
```

`allocate()` is three instructions on x86-64 in optimized code. `deallocate()` is two. The `Block` structure is the slab. Each call to `grow()` adds one slab.

`std::launder` matters. After punning the storage to a `void*` and back, the compiler is allowed to assume the memory still holds the previous object. `std::launder` tells it the type has changed.

### Constructor and Destructor Discipline

A slab allocator returns raw storage. Construction and destruction are the caller's responsibility.

```cpp
SlabAllocator<Connection> pool;

// Allocate and construct.
Connection* c = pool.allocate();
new (c) Connection(args...);

// Destroy and return.
c->~Connection();
pool.deallocate(c);
```

Wrap this in a factory if you do it in many places. Failing to call the destructor is a leak. Failing to call the constructor is undefined behavior.

```cpp
template <typename... Args>
Connection* create(Args&&... args) {
    Connection* c = pool.allocate();
    try {
        return new (c) Connection(std::forward<Args>(args)...);
    } catch (...) {
        pool.deallocate(c);  // rollback on constructor throw
        throw;
    }
}

void destroy(Connection* c) noexcept {
    c->~Connection();
    pool.deallocate(c);
}
```

The `try` block matters. If `Connection`'s constructor throws, the storage is already taken from the slab. Without rollback you leak it.

### Type-Stable Storage

The slab does not return memory to the operating system on `deallocate`. The storage is reused for the same type forever. This property is "type stability." It enables a powerful pattern: dangling pointers do not cause type confusion, only logical errors.

A pointer to a freed `Connection` slot, dereferenced after a different `Connection` has been allocated there, reads the new connection's bytes. You get incorrect behavior, not memory corruption. No vtable smashing. No stack pivot. The category of bugs available to an attacker drops dramatically.

This is why kernel slab allocators (Linux SLUB, FreeBSD UMA) use type stability. It is also why a CVE in slab-allocated kernel code often becomes a use-after-free with bounded impact rather than a generic write primitive.

### Per-CPU and Per-Thread Sharding

A single shared free list scales to maybe 4 cores. Beyond that, contention dominates. The fix: per-CPU or per-thread slabs, with a global "magazine" reserve for refills.

```cpp
template <typename T>
class ShardedSlab {
    struct alignas(64) Shard {
        SlabAllocator<T> local;
    };
    std::vector<Shard> shards_;

public:
    explicit ShardedSlab(size_t n_shards)
        : shards_(n_shards) {}

    T* allocate() {
        const auto cpu = sched_getcpu();
        return shards_[cpu % shards_.size()].local.allocate();
    }
    // deallocate must route back to the right shard, or use a magazine.
};
```

Cross-CPU frees are the hard part. Either route the free back to the originating shard (track origin in the object header), use a per-shard MPSC queue for foreign frees, or accept some imbalance. The Bonwick "magazines" paper describes a depot of fully-loaded magazines that shards swap into and out of, which spreads contention across the depot lock instead of all on one slab lock.

### Growable vs Fixed Pools

A growable pool calls `grow()` on demand. Suitable for general use. The downside: an unbounded workload can eat the heap.

A fixed pool reserves N slots at construction and returns null (or throws) when exhausted. Suitable for embedded and real-time systems where you must prove the worst case fits in memory.

```cpp
template <typename T>
class FixedPool {
    std::unique_ptr<std::byte[]> storage_;
    void* free_head_ = nullptr;
    size_t capacity_;

public:
    explicit FixedPool(size_t capacity)
        : storage_(std::make_unique<std::byte[]>(sizeof(T) * capacity)),
          capacity_(capacity) {
        for (size_t i = 0; i < capacity; ++i) {
            void* slot = storage_.get() + i * sizeof(T);
            *reinterpret_cast<void**>(slot) = free_head_;
            free_head_ = slot;
        }
    }

    [[nodiscard]] T* try_allocate() noexcept {
        if (!free_head_) return nullptr;
        void* s = free_head_;
        free_head_ = *reinterpret_cast<void**>(s);
        return std::launder(reinterpret_cast<T*>(s));
    }

    void deallocate(T* p) noexcept {
        *reinterpret_cast<void**>(p) = free_head_;
        free_head_ = p;
    }
};
```

Fixed pools also enable trivially-bounded allocation on real-time threads. No syscall, no malloc, no surprises.

### Exception Safety

Pool allocators must be exception-safe at three boundaries.

1. Pool growth: if `new Block` throws, the pool's invariants must hold. The code above does not insert the new block until allocation succeeds, so this is fine.
2. Object construction: covered in the `create` factory above. Reclaim the slot on throw.
3. Destruction order: if the pool destroys before its objects, you have dangling pointers. Static initialization order matters here, pools that outlive all clients are usually module-scoped or owned by a registry that destroys clients first.

### When a Pool Hurts

A pool is wrong when:

- Object sizes vary. One pool per size means many pools, plus a routing mechanism, often slower than a good general allocator.
- Lifetimes vary wildly. Long-lived objects pin slabs that mostly hold short-lived ones, defeating cache locality.
- The general allocator is already a thread-cached allocator (jemalloc, mimalloc, tcmalloc). The win shrinks. Measure before assuming.

A pool is right when: fixed size, similar lifetime, high allocation rate, contention-bound workload. Connection pools, message buffers, AST nodes during compilation, particle objects in a game.

### Junior to FAANG

A junior engineer writes a slab allocator with `std::vector<T>` as backing storage and calls it a pool. A FAANG-grade engineer writes a sharded slab with magazines, type-stable storage, exception-safe factory wrappers, and a fixed-pool variant for the real-time path. They benchmark against jemalloc / mimalloc on the actual workload before deploying because for many modern workloads the general allocator already does most of the work, and a pool is a maintenance burden if it does not pay back at least 2x.
