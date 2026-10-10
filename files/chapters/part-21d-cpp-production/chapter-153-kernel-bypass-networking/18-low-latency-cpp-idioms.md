## Low-Latency C++ Idioms

Kernel bypass gets the OS out of the way. Then your C++ has to be fast enough to use the time it gave you. The idioms that work for general-purpose code do not work for the inner loop of a feed handler or order book. This chapter is the practitioner's collection of idioms and pitfalls.

### Branchless Code

Predictable branches are free, unpredictable ones cost ~10 cycles on a misprediction (Skylake) or ~15+ on Sapphire Rapids. The hot path of a feed parser sees random message types, that's an unpredictable branch.

The fix where it matters: replace branches with arithmetic.

```cpp
// Branchful: max-of-two
int a = (x > y) ? x : y;

// Branchless on x86 (cmov)
int a = (x > y) * x + (x <= y) * y;
// or rely on the compiler with a hint
int a = std::max(x, y);    // cmovg on x86
```

Compilers generally emit `cmov` for `std::max`, `std::min`, simple ternaries on integers. For more complex logic, write carefully and check the assembly. Godbolt is your friend.

A more interesting case: dispatching on message type without a switch:

```cpp
using Handler = void(*)(const uint8_t*, size_t);
static Handler g_table[256];
g_table['A'] = handle_add;
g_table['E'] = handle_execute;
// ...

inline void process(const uint8_t* msg, size_t len) {
    g_table[msg[0]](msg, len);
}
```

A computed-jump through a table is one indirect branch (well-predicted because the BTB caches it) plus the call. For 5+ message types, this beats a switch with mispredictions.

### Prefetching

The CPU's hardware prefetcher detects sequential and stride-N access patterns. For random-access patterns (hash lookups, indirect-pointer chases) it cannot help, you must prefetch by hand.

```cpp
for (uint16_t i = 0; i < n; i++) {
    if (i + 4 < n) {
        rte_prefetch0(rte_pktmbuf_mtod(burst[i + 4], void*));
    }
    process(burst[i]);
}
```

Prefetch 4-8 iterations ahead, depending on per-iteration latency vs memory latency. Wrong distance is worthless: too close and the prefetched line is evicted before use, too far and the prefetch fires after the real load already missed.

Use `__builtin_prefetch(addr, rw=0, locality=3)` for portable prefetch. `rw=1` if you intend to write (causes the cache line to come in already in M state).

### Avoiding Malloc on the Hot Path

`malloc` and `new` are catastrophic on the latency hot path. A typical glibc `malloc` is 50-200 ns when fast, 1+ microseconds when it triggers `mmap`. Worse, the allocator's internal locks can serialize concurrent threads.

The discipline:

- **Pre-allocate at startup.** Order pools, mbuf pools, work queues. Size for peak demand.
- **Use fixed-size slabs.** A "memory region" is a `std::array<Order, N>` plus a free list. Allocation is a single pointer load and store.
- **Object pools over allocators.** Boost.Pool, custom intrusive free lists.
- **Flag malloc on the hot path.** Run with `MALLOC_CHECK_=3` in CI tests, panic if any allocation fires. Tools: `mimalloc-stats`, custom `malloc` interceptor that logs callers.

Example slab:

```cpp
template <typename T, size_t N>
class Slab {
    union Slot {
        T      obj;
        Slot*  next;
    };
    Slot  storage_[N];
    Slot* free_;
public:
    Slab() {
        for (size_t i = 0; i + 1 < N; i++) storage_[i].next = &storage_[i+1];
        storage_[N-1].next = nullptr;
        free_ = &storage_[0];
    }
    T* alloc() {
        if (!free_) return nullptr;
        Slot* s = free_;
        free_ = s->next;
        return new (&s->obj) T;
    }
    void free(T* p) {
        p->~T();
        Slot* s = reinterpret_cast<Slot*>(p);
        s->next = free_;
        free_ = s;
    }
};
```

### Statically-Sized SoA Layouts

Struct-of-Arrays beats Array-of-Structs when the hot loop touches one field per iteration. The SoA layout puts the touched field's elements in contiguous memory, one cache line covers more iterations.

```cpp
// AoS: bad for "sum prices"
struct Order { uint64_t id; uint32_t price; uint32_t qty; char side; };
std::array<Order, N> orders;

// SoA: good for "sum prices"
struct Orders {
    std::array<uint64_t, N> id;
    std::array<uint32_t, N> price;
    std::array<uint32_t, N> qty;
    std::array<char,     N> side;
};
```

When one loop touches `price` for all orders, AoS pulls 16 bytes per cache line that are useful (`price`, padded), wasting the rest. SoA pulls 16 entries per line. 4x bandwidth win for that access pattern.

The hybrid: hot fields together, cold fields elsewhere. ITCH-style books often use AoS for `Order` because every order operation touches all fields, but SoA at the level array (price + qty arrays per side) for top-of-book queries.

### Polling vs Sleeping Discipline

Repeating the rule from chapter 11: at sub-microsecond latency, sleeping is forbidden. The thread spins on its input ring or NIC RX queue, calling `_mm_pause()` per iteration to behave well with HT and the front-end.

```cpp
while (true) {
    if (try_pop(&work)) { process(work); continue; }
    _mm_pause();
}
```

For threads that do not need sub-microsecond response, the hybrid pattern (chapter 11) gives the rest of the system breathing room.

### Avoid Virtual Calls on the Hot Path

A virtual call is an indirect jump through the vtable: ~5 cycles when predicted, ~15 when not. For a hot path called millions of times per second, that adds up.

Alternatives:

- **CRTP for static polymorphism.** The "interface" is a template parameter, calls inline.

```cpp
template <typename Derived>
class HandlerBase {
public:
    void handle(const Msg& m) { static_cast<Derived*>(this)->do_handle(m); }
};
class MyHandler : public HandlerBase<MyHandler> {
public:
    void do_handle(const Msg& m) { /* hot path inlined */ }
};
```

- **Tagged dispatch with a switch.** When the set of derived types is closed, a `switch (tag)` is faster than a virtual call because the branch predictor can specialize.

- **Type erasure with function pointers.** Store the function pointer alongside the data, one indirect call but no vtable indirection.

### Hot/Cold Separation

Mark cold paths (error handling, logging, metrics) as `[[unlikely]]` or via `__builtin_expect`. The compiler moves them to the cold section, away from the hot loop in the i-cache.

```cpp
if (size > MAX_SIZE) [[unlikely]] {
    log_error("oversized");
    return -1;
}
```

For functions called only on rare paths (e.g., per-second flush), mark them `__attribute__((cold))` and the linker places them in `.text.cold`, never sharing i-cache with hot code.

### False Sharing

Two threads writing to different variables on the same cache line cause coherence traffic that destroys performance. Symptoms: per-thread counters that should scale linearly do not.

Diagnostic: `perf c2c record` and `perf c2c report`. It shows lines with cross-core HITM (modified line transferred to another core).

Fix: pad each variable to a cache line.

```cpp
struct alignas(64) PerThreadCounter {
    uint64_t count;
    char     pad[56];
};
PerThreadCounter g_counters[NUM_THREADS];
```

C++17 provides `std::hardware_destructive_interference_size` (typically 64) for portability.

### Bound Vector Sizes. Avoid std::vector on the Hot Path

`std::vector::push_back` may reallocate. `std::vector::erase` shifts elements. Both are unacceptable on the hot path.

Replacements:

- **`absl::InlinedVector` / `boost::container::small_vector`.** Allocates inline up to a threshold, falls back to heap only when exceeded.
- **Fixed-size arrays.** When the bound is known.
- **Intrusive lists.** When you need O(1) erase from the middle. The element holds the prev/next pointers, no separate node allocation.

### Hot Path Prohibitions

A practical list of what cannot appear in the inner loop:

- `malloc`, `new`, `realloc`, `free`, `delete`.
- `std::string`, `std::vector::push_back`, `std::map`, `std::unordered_map` (they all allocate).
- Virtual calls (use CRTP or tagged dispatch).
- `std::shared_ptr` (atomic ref count is multiple cycles).
- Exceptions (the path is fine but throw is expensive and prevents inlining).
- `std::cout`, `printf`, `std::format` (locale, allocations).
- Locks (`std::mutex`, `std::shared_mutex`), unless designed for never-contended.
- Floating point in the wrong context (FP register clobbers, denormals).
- `std::sort` on the hot path (use radix or insertion-sort for small N).

Build a CI check that flags these in files under `src/hot/`. Senior engineers add one-line review comments for each appearance.

### Templates Tightened by Concepts

C++20 concepts let the hot loop be generic without paying for it. The compiler instantiates one inline version per type, no virtual dispatch, no type erasure.

```cpp
template <typename T>
concept Message = requires(T t, const uint8_t* p) {
    { T::parse(p) } -> std::convertible_to<T>;
    { t.timestamp() } -> std::convertible_to<uint64_t>;
};

template <Message M, typename Handler>
inline void process_burst(const uint8_t* buf, size_t n, Handler& h) {
    for (size_t i = 0; i < n; i++) {
        M m = M::parse(buf + i * sizeof(M));
        h.on_message(m);
    }
}
```

> Junior engineer behavior: writing the hot loop with `std::vector` and `std::shared_ptr` and "letting the optimizer figure it out."
> Senior FAANG move: pre-allocate everything, use slab/intrusive lists, prefetch by hand, lay out hot fields together, mark unlikely branches, and validate with `perf stat -e cache-misses,branch-misses,L1-dcache-load-misses` that the inner loop is hitting the cache budget.
