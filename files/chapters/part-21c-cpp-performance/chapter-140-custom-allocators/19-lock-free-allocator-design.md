## Lock-Free Allocator Design

Allocator hot paths are the most contended code in a multi-threaded process. A mutex-protected free list scales to maybe 4 cores. Past that, every additional thread spends most of its time parked. Production allocators (jemalloc, tcmalloc, mimalloc) all solve this with sharding plus lock-free fast paths. Building one from scratch is instructive even if you never ship it.

### The Treiber Stack as a Free List

The simplest lock-free free list is a Treiber stack: a singly-linked list with CAS-based push and pop.

```cpp
template <typename T>
class TreiberFreeList {
    static_assert(sizeof(T) >= sizeof(void*));

    std::atomic<void*> head_{nullptr};

public:
    void push(T* node) noexcept {
        void* old_head = head_.load(std::memory_order_relaxed);
        do {
            *reinterpret_cast<void**>(node) = old_head;
        } while (!head_.compare_exchange_weak(
            old_head, node,
            std::memory_order_release,
            std::memory_order_relaxed));
    }

    T* pop() noexcept {
        void* old_head = head_.load(std::memory_order_acquire);
        while (old_head) {
            void* next = *reinterpret_cast<void**>(old_head);
            if (head_.compare_exchange_weak(
                    old_head, next,
                    std::memory_order_acquire,
                    std::memory_order_relaxed)) {
                return std::launder(reinterpret_cast<T*>(old_head));
            }
        }
        return nullptr;
    }
};
```

This is wrong. The bug is the ABA problem.

### The ABA Problem

Thread A reads `head_ = X`, reads `next = X.next = Y`, then stalls.
Thread B pops X. Thread B pops Y. Thread B pushes X back.
Thread A resumes, sees `head_ = X` still, CAS succeeds, sets `head_ = Y`.
But Y is now in some other free list, or worse, in use. Heap corruption.

The CAS operates on the value, not the identity. ABA breaks the assumption that "same value means same state."

### Fixing ABA

Three classic fixes.

1. Tagged pointers (DCAS). Pack a generation counter into unused bits of the pointer. Every push/pop increments the tag. CAS now compares (pointer, tag), so ABA cannot happen because the tag has advanced. Requires `std::atomic<__int128>` on x86-64 or unused high bits.

2. Hazard pointers. Each thread publishes the pointer it is currently dereferencing. Free defers reclamation until no hazard pointer references the object. C++26 standardizes hazard pointers under `std::hazard_pointer`.

3. Epoch-based reclamation (RCU-flavored). Threads enter "epochs" while accessing shared structures. Memory is reclaimed only when all threads have advanced past the epoch in which it was retired.

For an allocator free list, tagged pointers are the simplest. Hazard pointers fit better when the structure is read-heavy and the hazard pointer cost is amortized. Epoch-based reclamation is the choice in heavy concurrency frameworks (Folly's `UnboundedQueue`, ConcurrencyKit).

```cpp
struct TaggedPtr {
    uintptr_t raw;
    void* ptr() const { return reinterpret_cast<void*>(raw & 0x0000'ffff'ffff'ffff); }
    uint16_t tag() const { return static_cast<uint16_t>(raw >> 48); }
    static TaggedPtr make(void* p, uint16_t t) {
        return {(static_cast<uintptr_t>(t) << 48) |
                (reinterpret_cast<uintptr_t>(p) & 0x0000'ffff'ffff'ffff)};
    }
};

// On x86-64 user space, the top 16 bits of a virtual address are unused.
// Pack a tag there. CAS the entire 64-bit word.
```

This works because x86-64 (and ARM64) virtual addresses use only 48 bits in user space. The top 16 bits are sign-extended copies of bit 47. Repurposing them is portable across mainstream Linux/macOS/Windows configurations. Future "5-level paging" CPUs use 57 bits, leaving only 7 bits for tags. Plan accordingly.

### Per-CPU Caches: The Magazine Algorithm

Bonwick's "magazines" (USENIX 2001) are the prototype for per-CPU caching in modern allocators. A magazine is a small array (16, 32, 64 slots) of free objects. A CPU operates on its current magazine without locks. When the magazine fills (on free) or empties (on alloc), the CPU swaps it for another from a "depot." The depot is the only contended structure.

```cpp
template <typename T, size_t MagazineSize = 32>
class Magazine {
    std::array<T*, MagazineSize> slots_;
    size_t count_ = 0;

public:
    bool full() const { return count_ == MagazineSize; }
    bool empty() const { return count_ == 0; }
    void push(T* p) { slots_[count_++] = p; }
    T* pop() { return slots_[--count_]; }
};

template <typename T>
class MagazineDepot {
    std::mutex mu_;
    std::vector<std::unique_ptr<Magazine<T>>> full_;
    std::vector<std::unique_ptr<Magazine<T>>> empty_;

public:
    std::unique_ptr<Magazine<T>> get_full() {
        std::lock_guard g(mu_);
        if (full_.empty()) return nullptr;
        auto m = std::move(full_.back()); full_.pop_back();
        return m;
    }

    std::unique_ptr<Magazine<T>> get_empty() {
        std::lock_guard g(mu_);
        if (empty_.empty()) return std::make_unique<Magazine<T>>();
        auto m = std::move(empty_.back()); empty_.pop_back();
        return m;
    }

    void return_full(std::unique_ptr<Magazine<T>> m) {
        std::lock_guard g(mu_);
        full_.push_back(std::move(m));
    }

    void return_empty(std::unique_ptr<Magazine<T>> m) {
        std::lock_guard g(mu_);
        empty_.push_back(std::move(m));
    }
};
```

Each CPU keeps a "loaded" magazine and a "previous" magazine. Allocations pop from the loaded one. When loaded is empty, swap with previous. When both are empty, return both to the depot and ask for a full one. Free is symmetric. The depot lock is hit roughly once per `MagazineSize` allocations, so contention drops by 1/MagazineSize.

This is essentially what jemalloc does in its tcache and what tcmalloc does in its per-CPU cache. The magazine algorithm is the conceptual blueprint.

### NUMA Awareness

A multi-socket server has separate memory controllers per socket. A pointer allocated on socket 0 and freed on socket 1 walks an inter-socket coherence path on every cache-line touch. Numbers vary, but expect 100ns+ extra latency vs local-memory access.

NUMA-aware allocators tie arenas to nodes.

- Find current CPU and its NUMA node (`numa_node_of_cpu`, `getcpu`).
- Allocate from a per-node arena.
- Bind the arena's backing pages with `mbind(MPOL_BIND, ...)` to the same node.
- On free, route the object back to its origin arena (or accept some node migration).

```cpp
#include <numaif.h>
#include <numa.h>

void* alloc_on_node(size_t bytes, int node) {
    void* p = mmap(nullptr, bytes, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    unsigned long node_mask = 1UL << node;
    mbind(p, bytes, MPOL_BIND, &node_mask, 64, 0);
    return p;
}
```

Production allocators (jemalloc with NUMA-aware extent hooks, custom shards in trading systems) all build something like this. Without it, a 2-socket box wastes one socket's worth of memory bandwidth.

### Lock-Free Slab Allocator

Combining the pieces.

- Per-CPU magazine cache. Lock-free fast path.
- Treiber stack with tagged pointers as the per-slab free list. Used when the magazine misses.
- Depot of full and empty magazines, mutex-guarded, low-contention.
- NUMA-pinned slab storage from a per-node arena.

A simplified per-CPU fast path:

```cpp
T* allocate() noexcept {
    const int cpu = sched_getcpu();
    auto& cache = cpu_caches_[cpu];
    if (!cache.loaded->empty()) [[likely]] {
        return cache.loaded->pop();
    }
    if (!cache.previous->empty()) {
        std::swap(cache.loaded, cache.previous);
        return cache.loaded->pop();
    }
    return slow_path_refill(cpu);
}
```

The fast path is unlocked because we are on this CPU and writing to per-CPU storage. If preempted mid-sequence to another CPU we operate on the wrong cache, which is benign as long as the data structure is internally consistent. The kernel `rseq` syscall (which TCMalloc uses) abolishes even this "wrong CPU" risk by aborting on migration and restarting.

### What Lock-Free Costs

Lock-free is not free.

- CAS loops have variable latency under contention. The wait-free retry count is unbounded in theory and proportional to thread count in practice.
- Memory ordering matters. `memory_order_release` on push, `memory_order_acquire` on pop, and you still need to think about consume vs acquire on the dereferenced data.
- Tagged pointers tie you to 48-bit address spaces.
- Hazard pointers add a per-access store to a thread-local hazard slot.
- Magazines waste memory. Each per-CPU loaded+previous magazine is 64 pointers idle most of the time. On 96 CPUs that is 96 * 64 * 8 = 49 KiB per size class.

Use lock-free where it pays. A request handler hot path? Yes. A configuration loader? Mutex.

### Junior to FAANG

A junior engineer writes a Treiber stack and ships it. A FAANG-grade engineer recognizes ABA, picks tagged pointers or hazard pointers based on the workload, layers a magazine cache on top to amortize CAS contention, pins arenas to NUMA nodes, and benchmarks with a tool like `perf c2c` to see whether the cache lines are actually hot. They also know that the production allocators they could just link already do this work and that writing your own is justified only when measurement says the existing one is the bottleneck.
