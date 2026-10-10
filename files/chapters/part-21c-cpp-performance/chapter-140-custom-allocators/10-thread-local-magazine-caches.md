## Thread-Local Magazine Caches for Tail-Latency Determinism

Throughput-optimized allocators (jemalloc, tcmalloc, mimalloc) already use thread-local caches to avoid lock contention on the common path. But p99.9 and p99.99 latency tell a different story: the occasional cache refill, central heap lock, or `mmap` call introduces multi-microsecond spikes that show up in production SLOs. A magazine cache is a senior-level pattern that makes the fast path entirely lock-free and the slow path predictable.

### Magazines: Batch-Oriented Free Lists

A magazine is a fixed-size stack of free objects for a single size class. Each thread holds two: a **primary** (where allocations are drawn) and a **reserve** (used when the primary empties). When both empty, the allocator swaps them with a central depot in bulk, amortizing the locking cost over an entire magazine's worth of allocations.

The terminology comes from Bonwick's 2001 paper "Magazines and Vmem: Extending the Slab Allocator," which introduced the design in Solaris. Modern allocators (illumos libumem, jemalloc `tcache`, tcmalloc `CentralFreeList`) all borrow the idea.

### C++26 Implementation Sketch

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory_resource>
#include <mutex>
#include <vector>

template <std::size_t ObjectSize, std::size_t MagazineSize = 64>
class MagazineAllocator {
    static_assert(ObjectSize >= sizeof(void*));
    static_assert((MagazineSize & (MagazineSize - 1)) == 0, "power of two");

    struct Magazine {
        std::array<void*, MagazineSize> slots{};
        std::size_t count{};
    };

    struct CentralDepot {
        std::mutex mu;
        std::vector<Magazine> full;
        std::vector<Magazine> empty;
        std::pmr::memory_resource* upstream;

        explicit CentralDepot(std::pmr::memory_resource* up) : upstream(up) {}

        Magazine take_full() {
            std::lock_guard lock(mu);
            if (full.empty()) return refill();
            Magazine m = std::move(full.back());
            full.pop_back();
            return m;
        }
        void return_empty(Magazine m) {
            std::lock_guard lock(mu);
            empty.push_back(std::move(m));
        }
        Magazine refill() {
            Magazine m{};
            for (std::size_t i = 0; i < MagazineSize; ++i) {
                m.slots[i] = upstream->allocate(ObjectSize);
            }
            m.count = MagazineSize;
            return m;
        }
    };

    inline static CentralDepot* depot_{};

    thread_local static Magazine primary_;
    thread_local static Magazine reserve_;

public:
    static void bind(CentralDepot* d) { depot_ = d; }

    [[gnu::hot]] static void* allocate() noexcept {
        if (primary_.count > 0) [[likely]] {
            return primary_.slots[--primary_.count];
        }
        return slow_allocate();
    }

    [[gnu::hot]] static void deallocate(void* p) noexcept {
        if (primary_.count < MagazineSize) [[likely]] {
            primary_.slots[primary_.count++] = p;
            return;
        }
        slow_deallocate(p);
    }

private:
    [[gnu::cold, gnu::noinline]] static void* slow_allocate() {
        if (reserve_.count > 0) {
            std::swap(primary_, reserve_);
            return primary_.slots[--primary_.count];
        }
        if (reserve_.count == 0 && primary_.count == 0) {
            depot_->return_empty(std::move(reserve_));
            reserve_ = depot_->take_full();
            std::swap(primary_, reserve_);
        }
        return primary_.slots[--primary_.count];
    }

    [[gnu::cold, gnu::noinline]] static void slow_deallocate(void* p) {
        if (reserve_.count < MagazineSize) {
            std::swap(primary_, reserve_);
            primary_.slots[primary_.count++] = p;
            return;
        }
        depot_->return_empty(std::move(reserve_));
        reserve_ = Magazine{};
        primary_.slots[primary_.count++] = p;
    }
};

template <std::size_t O, std::size_t M>
thread_local typename MagazineAllocator<O, M>::Magazine MagazineAllocator<O, M>::primary_;
template <std::size_t O, std::size_t M>
thread_local typename MagazineAllocator<O, M>::Magazine MagazineAllocator<O, M>::reserve_;
```

### Why This Matters for p99.9

The hot path is two integer ops (decrement, indexed load) and a predictable branch. No atomics, no fences, no locks. Cost measured on modern Xeon: 1.5-2 ns. Compare to `malloc`: 15-25 ns typical, but p99.9 spikes to 500 ns to 5 microseconds during central-heap refills.

The slow path (central depot lock) runs once every 64 allocations (or whatever `MagazineSize` is set to). The lock contention window is bounded to copying 64 pointers, which completes in tens of nanoseconds under contention. Crucially, the slow path is `[[gnu::cold, gnu::noinline]]`, so the compiler places it in the cold section and the hot icache stays dense.

### Tuning the Magazine Size

Bigger magazines mean fewer central refills but higher per-thread memory overhead. Typical sizes:

- Small objects (8-64 bytes), high-frequency allocation: `MagazineSize = 128` or `256`.
- Medium objects (256-4096 bytes): `MagazineSize = 16` or `32`.
- Large objects (>4 KB): skip magazines entirely. Hit the central arena directly. The fixed overhead of the central path is amortized over the object size.

Measure with a production workload under load. The metric to watch is "central depot operations per second" divided by "total allocations per second." If that ratio exceeds 5%, the magazine is too small. If it is below 0.1% and per-thread memory is high, the magazine is too big.
