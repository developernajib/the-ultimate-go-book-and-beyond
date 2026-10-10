## Real-Time Allocators and No-Malloc Paths

A real-time C++ thread cannot call `malloc`. Not because `malloc` is slow on average, but because it has unbounded worst-case latency. A `malloc` call that triggers a page fault, a contended mutex on the central cache, or a `madvise` on a freed extent can stall for milliseconds. For an audio thread (1 ms callback budget), a trading engine (sub-microsecond decisions), a robotics control loop (500 Hz hard deadline), or a flight control system, "milliseconds, sometimes" is fatal.

The discipline is straightforward: the real-time path allocates nothing. All memory it uses was allocated before the path entered. The allocator runs on a different thread, in a different lifetime, with no cross-thread synchronization with the real-time path.

### The Audio Plugin Rule

The audio community has codified the rules. Inside the audio callback, the following are banned.

- `malloc`, `free`, `new`, `delete`. Includes anything that calls them transitively.
- Any standard container that may allocate (`std::vector::push_back`, `std::string::operator+`, `std::map::insert`, etc).
- Any mutex, condition variable, or other lock that the operating system might block on.
- Any system call that may block (file I/O, networking, `printf`).
- Any function that calls dynamic linker resolution (the first call to a not-yet-resolved symbol).

The constraint sounds harsh. In practice, codebases that follow it are simpler: every allocation site is in setup code, every `delete` site is in teardown. Lifetime is obvious.

```cpp
class AudioPlugin {
    std::vector<float> scratch_;       // pre-allocated
    LockFreeRingBuffer<MidiEvent> midi_; // pre-allocated, lock-free
    std::array<Voice, 64> voices_;     // fixed-size, in-class

public:
    void prepare(int max_block_size) {
        scratch_.resize(max_block_size);  // allocates ONCE, before realtime
        midi_.reserve(1024);
    }

    // Realtime callback. No allocation here.
    void process(float* input, float* output, int n_samples) {
        for (auto& v : voices_) v.render(scratch_.data(), n_samples);
        // ... mix scratch into output ...
    }
};
```

`prepare` runs on the audio host's setup thread. `process` runs on the audio callback. Allocator never appears in `process`.

### Pre-allocation Patterns

The patterns that make pre-allocation tractable.

1. Reserve max capacity at startup. Vectors never grow. Maps are replaced by sorted arrays. Strings are bounded.

2. Pool fixed-size objects. A real-time thread that "creates" a Voice actually pops one from a pre-filled free list. Returning is pushing back.

3. Bounded lock-free queues for cross-thread communication. The real-time thread reads commands from a queue. The non-real-time thread pushes commands. Neither blocks.

4. Static singletons for non-real-time allocations. If the real-time thread needs to log, it does so via a lock-free queue to a logging thread that handles the actual I/O.

### A Real-Time Pool

```cpp
template <typename T, size_t N>
class RTPool {
    static_assert(sizeof(T) >= sizeof(void*));

    alignas(T) std::byte storage_[sizeof(T) * N];
    std::atomic<void*> free_head_;

public:
    RTPool() {
        // Setup-time only. NOT realtime-safe.
        void* head = nullptr;
        for (size_t i = 0; i < N; ++i) {
            void* slot = storage_ + i * sizeof(T);
            *reinterpret_cast<void**>(slot) = head;
            head = slot;
        }
        free_head_.store(head, std::memory_order_relaxed);
    }

    [[nodiscard]] T* try_acquire() noexcept {
        void* head = free_head_.load(std::memory_order_acquire);
        while (head) {
            void* next = *reinterpret_cast<void**>(head);
            if (free_head_.compare_exchange_weak(
                    head, next,
                    std::memory_order_acquire,
                    std::memory_order_relaxed)) {
                return std::launder(reinterpret_cast<T*>(head));
            }
        }
        return nullptr;  // pool exhausted; caller must handle
    }

    void release(T* p) noexcept {
        void* old = free_head_.load(std::memory_order_relaxed);
        do {
            *reinterpret_cast<void**>(p) = old;
        } while (!free_head_.compare_exchange_weak(
            old, p,
            std::memory_order_release,
            std::memory_order_relaxed));
    }
};
```

Capacity is `N`, baked into the type. Bounded latency: `try_acquire` performs at most a few CAS retries under contention, the worst case is bounded by the contention level, which is bounded by the thread count. Returns `nullptr` on exhaustion. Real-time threads must handle this gracefully (drop the event, etc).

The Treiber-stack ABA problem applies here. For pools dedicated to one consumer, ABA cannot happen because there is only one popper. For multi-consumer pools, add tagged pointers (top 16 bits of pointer for a generation counter, as discussed in the lock-free chapter).

### RT-Safe Lock-Free Allocator

A real-time allocator that supports variable sizes (within bounded limits) needs more than a single-size pool. The pattern: per-size-class pools, all pre-allocated, sized to the workload's worst case.

```cpp
class RTAllocator {
    RTPool<std::byte[16], 4096> pool_16_;
    RTPool<std::byte[64], 2048> pool_64_;
    RTPool<std::byte[256], 512> pool_256_;
    RTPool<std::byte[1024], 128> pool_1k_;
    RTPool<std::byte[4096], 32> pool_4k_;

    // Note: different size classes are different RTPool instantiations.
    // The interface below uses type erasure carefully.

public:
    [[nodiscard]] void* allocate(size_t bytes) noexcept {
        if (bytes <= 16) return pool_16_.try_acquire();
        if (bytes <= 64) return pool_64_.try_acquire();
        if (bytes <= 256) return pool_256_.try_acquire();
        if (bytes <= 1024) return pool_1k_.try_acquire();
        if (bytes <= 4096) return pool_4k_.try_acquire();
        return nullptr;  // too large
    }

    void deallocate(void* p, size_t bytes) noexcept {
        if (bytes <= 16) pool_16_.release(reinterpret_cast<std::byte(*)[16]>(p));
        else if (bytes <= 64) pool_64_.release(reinterpret_cast<std::byte(*)[64]>(p));
        // ...
    }
};
```

Capacities are picked from worst-case analysis. Exhaustion is graceful (return null). The allocator itself is real-time safe: every operation is a CAS-bounded sequence.

The cost is per-class capacity tuning. Get it wrong and the pool exhausts. Get it too generous and you waste memory.

### FreeRTOS heap_4 and Embedded Heaps

Embedded systems running FreeRTOS expose five heap implementations.

- `heap_1`: allocate-only. Cannot free. Trivially deterministic.
- `heap_2`: allocate and free. Best-fit. Fragments.
- `heap_3`: wraps the C library `malloc`. Defers determinism to your libc.
- `heap_4`: allocate, free, coalesce. First-fit-decreasing with adjacent-block coalescing. The default.
- `heap_5`: like heap_4 but supports multiple non-contiguous regions.

`heap_4` is the standard pick. Bounded worst-case latency (proportional to free-list length). Coalescing prevents long-term fragmentation. Single mutex (or critical section) on operations.

```c
// FreeRTOS heap_4 usage. C-level API.
size_t bytes_free = xPortGetFreeHeapSize();
void* p = pvPortMalloc(64);
vPortFree(p);
```

Internal layout: a doubly-linked free list of blocks, sorted by address (so coalescing is O(1) on free). Each block has a header with size and a "free" bit. Bounded worst case: walk the free list to find a fit on alloc.

For C++ on FreeRTOS, override `operator new` to call `pvPortMalloc`, or write per-class allocators that call FreeRTOS APIs. Either works. The discipline is the same: real-time threads do not call malloc.

### Bounded vs Soft Real-Time

Hard real-time: missing a deadline is a system failure. Flight control. Pacemakers. Anti-lock brakes. Allocator must be analytically bounded.

Soft real-time: missing a deadline degrades quality but is recoverable. Audio (a glitch is annoying but the show goes on). Games (a dropped frame is visible but acceptable). Trading (a slow tick is a missed opportunity). Allocator can be "fast in practice" (pool-based, lock-free) without analytic bounds.

Most C++ code that calls itself real-time is soft real-time. Hard real-time C++ exists in safety-critical embedded but rarely uses dynamic allocation at all.

### The Two-Allocator Pattern

A common architecture for soft real-time C++.

- Setup thread: uses the system allocator (jemalloc, mimalloc, whatever). Allocates pools, queues, voice banks, etc. May call malloc freely. Slow operations are fine here.
- Real-time thread: uses only the pre-allocated pools. Never touches the system allocator.
- Worker threads (logging, file I/O, GC): use the system allocator. Communicate with real-time thread via lock-free queues.

This separates concerns. The real-time path is small, simple, and easy to audit. The complex allocation logic lives in setup and worker threads where it does not matter.

### What the OS Can Do To You

Even a thread that does not call malloc can stall.

- Page faults: the first access to a freshly-mapped page faults into the kernel for zero-fill or COW. Pre-touch the pages with `mlockall(MCL_CURRENT | MCL_FUTURE)` and explicit writes.
- Demand-paged code: a function called for the first time may page-fault its code pages in. Pre-touch by calling once during setup.
- TLB shootdowns: a sibling thread modifying its memory mappings sends an inter-processor interrupt to invalidate TLB entries, stalling all CPUs briefly. Avoid by minimizing `mmap`/`munmap` traffic on the system.
- Scheduler preemption: another process at the same priority can preempt the real-time thread. Use `SCHED_FIFO` or `SCHED_RR` with a real-time priority and pin to a CPU.
- CPU frequency scaling: a freshly-active core may take microseconds to ramp up. Pin to a busy core or disable C-states.

```cpp
#include <sys/mman.h>
#include <sched.h>
#include <pthread.h>

void enter_realtime() {
    // Lock all current and future memory.
    mlockall(MCL_CURRENT | MCL_FUTURE);

    // Set real-time scheduling.
    sched_param p{};
    p.sched_priority = 80;
    pthread_setschedparam(pthread_self(), SCHED_FIFO, &p);

    // Pin to a CPU.
    cpu_set_t cpus;
    CPU_ZERO(&cpus);
    CPU_SET(3, &cpus);
    pthread_setaffinity_np(pthread_self(), sizeof(cpus), &cpus);
}
```

`mlockall` requires `CAP_IPC_LOCK` or root. Real-time scheduling requires `CAP_SYS_NICE` or root. Production deployments typically grant these via systemd unit files or container security contexts.

### Junior to FAANG

A junior engineer adds `std::vector<float>::push_back` to an audio callback and is confused when the buffer underruns. A FAANG-grade engineer pre-allocates every container at setup, runs the real-time thread under `SCHED_FIFO` with `mlockall`, communicates with non-real-time threads exclusively via lock-free queues, and treats every `malloc` symbol that appears in the real-time call graph as a build failure (linker can warn on `--wrap=malloc`). They also know that hard real-time is mostly an embedded discipline and that "no allocation in the hot path" is the correct soft-real-time discipline for trading, audio, and game engines.
