## Coroutine Allocator Customization

The coroutine frame is a heap allocation by default. At 100K coroutines per second, a malloc per coroutine is the bottleneck. Customizing the allocator brings frame allocation down to a bumped pointer in a per-thread arena. This chapter covers the mechanism, the measurement, and the cases where you can avoid the heap entirely.

### The Mechanism

The compiler asks the promise type for `operator new`. If overloaded on the promise, the override is called. Otherwise the global `::operator new` is used.

```cpp
struct task_promise {
    void* operator new(std::size_t n) {
        return ::operator new(n);
    }
    void operator delete(void* p, std::size_t n) noexcept {
        ::operator delete(p, n);
    }
    // ... rest of promise ...
};
```

Both must be present. The size argument to `operator new` is the frame size, computed by the compiler and stable for a given coroutine signature and compiler version.

#### Allocator-Aware Promises

The standard supports passing the first parameter of the coroutine as an allocator:

```cpp
struct task_promise {
    template <typename Alloc, typename... Args>
    void* operator new(std::size_t n, std::allocator_arg_t, Alloc const& a, Args&&...) {
        // n bytes, allocator a
        // store the allocator for later delete
        Alloc copy = a;
        auto* p = std::allocator_traits<Alloc>::allocate(copy, /*bytes*/ n + sizeof(Alloc));
        new (p + n) Alloc{copy};
        return p;
    }
    void operator delete(void* p, std::size_t n) noexcept {
        Alloc* a = std::launder(reinterpret_cast<Alloc*>(static_cast<char*>(p) + n));
        Alloc copy = *a;
        a->~Alloc();
        std::allocator_traits<Alloc>::deallocate(copy, static_cast<typename Alloc::value_type*>(p), n + sizeof(Alloc));
    }
};

task<int> work(std::allocator_arg_t, my_pool_alloc<>, int x);
```

The compiler matches the argument list with `std::allocator_arg_t` as the first parameter and selects the allocator-aware overload. The allocator is stored after the frame so `operator delete` can recover it.

This is verbose but precise. P2502 and follow-on papers propose simplification, but the allocator_arg_t pattern is what you write today.

### Pool Allocators for Frames

For uniform-size coroutines, a slab pool is the right structure.

```cpp
class frame_pool {
    static constexpr size_t kSlots = 4096;
    std::vector<std::byte*> chunks_;
    std::byte* free_head_ = nullptr;
    size_t slot_size_;
    std::mutex mu_;

public:
    explicit frame_pool(size_t sz) : slot_size_{sz} {}

    void* allocate() {
        std::lock_guard lk{mu_};
        if (!free_head_) refill();
        void* p = free_head_;
        free_head_ = *reinterpret_cast<std::byte**>(p);
        return p;
    }

    void deallocate(void* p) noexcept {
        std::lock_guard lk{mu_};
        *reinterpret_cast<std::byte**>(p) = free_head_;
        free_head_ = static_cast<std::byte*>(p);
    }

private:
    void refill() {
        auto chunk = new std::byte[slot_size_ * kSlots];
        chunks_.push_back(chunk);
        for (size_t i = 0; i < kSlots; ++i) {
            std::byte* slot = chunk + i * slot_size_;
            *reinterpret_cast<std::byte**>(slot) = free_head_;
            free_head_ = slot;
        }
    }
};
```

Per-thread variants eliminate the lock entirely. Thread-local pools backed by a global free-list for cross-thread frees (the classic LIFO with hazard pointers or Treiber stack) are the production shape. Mimalloc and tcmalloc already do this internally, for coroutine frames, a dedicated pool tuned to your dominant frame size beats the general-purpose allocator by 2-5x.

Wire it into the promise:

```cpp
struct task_promise {
    static frame_pool& pool() {
        static frame_pool p{256};
        return p;
    }
    void* operator new(std::size_t n) {
        if (n <= 256) return pool().allocate();
        return ::operator new(n);
    }
    void operator delete(void* p, std::size_t n) noexcept {
        if (n <= 256) pool().deallocate(p);
        else ::operator delete(p, n);
    }
};
```

The size dispatch handles the rare case of a coroutine larger than the pool's slot size. In well-tuned systems all task frames fit in the largest pool size and the fallback never fires.

### Measuring Frame Sizes

The override is the cleanest measurement. Log every size during a representative workload.

```cpp
struct logging_promise_base {
    void* operator new(std::size_t n) {
        thread_local std::map<size_t, size_t> hist;
        ++hist[n];
        if (hist.size() % 100 == 0) dump(hist);
        return ::operator new(n);
    }
};
```

In a real codebase you will see a small handful of dominant sizes (the common task signatures). Tune your pool to those. Production tip: a histogram bucket per power-of-two size with one slot size per bucket gets you 80% of the win with 5% of the engineering cost.

Clang has `__builtin_coro_size()` which returns the frame size at compile time inside a coroutine. Useful for static_asserts:

```cpp
task<int> hot_path() {
    static_assert(__builtin_coro_size() <= 128, "frame grew");
    co_return 42;
}
```

This is undocumented but stable. GCC's equivalent (`__builtin_coro_frame_size`) lags Clang by a release.

### HALO: Avoiding the Heap Entirely

Heap Allocation eLision Optimization (P0981) lets the compiler put the frame on the caller's stack when the coroutine's lifetime is bounded by the caller's scope.

Conditions for HALO to fire (see Coroutine Machinery Deep Dive for details):

1. The handle does not escape the caller's frame.
2. The coroutine is destroyed before the caller returns.
3. Optimization level allows it (-O1 or higher).

The pattern that defeats HALO in practice is storing the coroutine handle in a long-lived data structure. Once the optimizer cannot prove containment, it allocates.

```cpp
generator<int> ints(int n) {
    for (int i = 0; i < n; ++i) co_yield i;
}

int sum_to(int n) {
    int s = 0;
    for (int v : ints(n)) s += v;       // HALO eligible
    return s;
}

generator<int> escapes(int n) {
    return ints(n);                     // returns the generator: NOT HALO eligible
}
```

Verifying HALO requires reading assembly. On Compiler Explorer, look for absence of `_Znwm` (libstdc++ `operator new`) in the symbol table. If you see it, HALO did not fire.

A subtle case: a noexcept `operator new` that returns nullptr on OOM defeats HALO because the optimizer must keep the allocation visible to handle the failure. Override `operator new(size_t, std::nothrow_t)` accordingly.

### clang::coro_only_destroy_when_complete

```cpp
class [[clang::coro_only_destroy_when_complete]] task { /* ... */ };
```

Tells Clang that the coroutine will only be destroyed at `final_suspend`, never via `coroutine_handle::destroy()` from a non-completed state. This eliminates the destroy branch in the generated state machine and enables more aggressive HALO.

The contract: never destroy a non-complete coroutine of this type. If you do, behavior is undefined. This is a strong constraint. Do not apply this attribute to a `task<T>` that supports cancellation, because cancellation may need to destroy a suspended coroutine.

A useful pattern: split into `cancellable_task<T>` (no attribute) and `nocancel_task<T>` (attributed) for hot paths where cancellation is impossible by construction. The hot path coroutines fit in registers more often.

### Allocator Considerations for Lifetime

The allocator must outlive the coroutine. The frame is allocated when the coroutine starts and freed when it completes (which may be much later). A scoped allocator that ties to the calling function's lifetime is broken: the coroutine outlives the call.

Two safe shapes:

1. Static or global pool. Lifetime is the program. Always safe.
2. Allocator with shared ownership. The allocator state is reference-counted, the frame holds a count.

The shared_ptr-style allocator works but introduces synchronization on the count. Static pools are usually fine and avoid the overhead. Use shared allocators only for tenancy isolation (per-customer pools).

### Avoiding Allocation: The Inline Coroutine Frame

For coroutines whose frame size is known and small, you can pre-allocate the frame inline:

```cpp
template <size_t N>
class fixed_frame {
    alignas(std::max_align_t) std::byte storage_[N];
    bool used_ = false;

public:
    void* allocate(size_t n) {
        if (used_ || n > N) return nullptr;
        used_ = true;
        return storage_;
    }
    void deallocate(void* p) noexcept {
        if (p == storage_) used_ = false;
    }
};
```

Pair with a promise that consults a thread_local fixed_frame:

```cpp
struct hot_task_promise {
    void* operator new(size_t n) {
        thread_local fixed_frame<512> tls;
        if (auto* p = tls.allocate(n)) return p;
        return ::operator new(n);  // fallback
    }
};
```

The pattern works for non-overlapping coroutines on one thread (a single in-flight call). When two coroutines need frames simultaneously, the second falls back to malloc. Useful for synchronous-fast-path coroutines.

#### Junior to FAANG callout

A junior reads "HALO eliminates allocation" and assumes it always works. It does not. HALO is an optimization, not a guarantee. Senior code measures: hooks `operator new` in development, asserts zero allocations on hot paths in tests, examines assembly when changes are made. Treat HALO as opportunistic and design to also be efficient when it does not fire (small frames, pooled allocators).

### Frame Size Pitfalls

Frame size grows with:

- Locals held across `co_await`. Move them in and out of awaiters or into the promise.
- Captured-by-value lambdas held across suspends. The capture lives in the frame.
- Exception state. The frame reserves space for the in-flight exception.
- Multiple `co_await` expressions. Each suspend point's awaiter is spilled.

Reduce frame size by:

- Releasing locals before the next `co_await`. Block-scope them or `std::move` them out.
- Using small awaiters. A 1KB awaiter for a 32-byte payload is wasteful.
- Avoiding capturing state in lambdas that span awaits. Pass by reference if lifetime allows.

```cpp
// Bad: large_buffer is held across the await.
task<void> bad(int fd) {
    std::array<char, 65536> large_buffer;
    co_await async_read(fd, large_buffer);
    // large_buffer lives in the frame: +64KB per coroutine
}

// Good: scope the buffer.
task<void> good(int fd) {
    auto reader = async_read_to_dynamic(fd);  // buffer owned by awaiter, freed after read
    auto data = co_await reader;
    // data is small - large buffer was freed before the await suspended
}
```

### Practical Checklist

- Override `operator new` on the promise during development. Log sizes. Build a histogram.
- Pool the dominant frame sizes. Static or thread_local, lock-free if cross-thread frees are common.
- Verify HALO at -O2 on hot paths. Compiler Explorer. Check for absence of `_Znwm`.
- Use `[[clang::coro_only_destroy_when_complete]]` only on coroutines that genuinely never get destroyed early.
- Keep frames small. Move locals out of scope. Audit captures.
- For per-tenant isolation, use a shared allocator. Otherwise static pools are simpler and faster.
