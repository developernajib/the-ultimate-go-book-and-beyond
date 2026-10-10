## atomic_ref and Non-Trivially-Copyable Atomics

C++20's `std::atomic_ref` finally gave the language a way to perform atomic operations on memory you did not declare atomic. Combined with the lock-free guarantees on `std::atomic<T>`, this section maps out the entire territory of "is this access atomic, and at what cost".

### The atomic_ref Motivation

Before C++20, applying atomic operations to existing data required either:

- Wrapping the data in `std::atomic<T>` from creation. Forces a redesign of any pre-existing struct.
- Using compiler intrinsics (`__atomic_*`, `_InterlockedExchange*`). Non-portable.
- Reinterpret-casting to `std::atomic<T>*`. Undefined behavior.

`std::atomic_ref<T>` lets you create a non-owning atomic view over an existing object.

```cpp
struct LegacyCounter {
    int count;        // not atomic, can't change the type
    char name[32];
};

void increment(LegacyCounter& c) {
    std::atomic_ref<int> ref(c.count);
    ref.fetch_add(1, std::memory_order_relaxed);
}
```

Constraints:

- The referenced object must be aligned to `std::atomic_ref<T>::required_alignment`. Often stricter than `alignof(T)`.
- During the lifetime of any atomic_ref to an object, all access to that object must go through atomic_ref instances. Mixing atomic and non-atomic access is a data race.
- atomic_ref does not extend the lifetime of the referenced object.

### Alignment Requirements

`std::atomic_ref<T>::required_alignment` is the alignment needed for the reference to be lock-free. For most ISAs:

- T of size 1, 2, 4, 8: aligned to size. Always lock-free on commodity hardware.
- T of size 16: aligned to 16. Lock-free on x86-64 with cmpxchg16b, on ARMv8 with LSE casp.
- T of size > 16 or odd size: not lock-free. atomic_ref falls back to a hashed lock table.

If you build a struct intending to use atomic_ref later, declare the field `alignas(std::atomic_ref<T>::required_alignment)`.

### Lock-Free Fallback for `std::atomic<T>`

`std::atomic<T>` for T larger than the hardware native CAS size is not lock-free. The implementation uses a hash table of mutexes indexed by the address of the atomic.

```cpp
struct Big {
    double a, b, c, d;     // 32 bytes
};

std::atomic<Big> x;
static_assert(!std::atomic<Big>::is_always_lock_free);
```

Operations on x acquire a global mutex from a fixed pool, perform the operation, release the mutex. This is correct but:

- Throughput is worse than a normal `std::mutex` because the lock pool serializes unrelated atomics.
- Priority inversion is possible if a high-priority thread waits on the same hash slot as a low-priority thread's atomic op.
- Signal-safety is gone. The lock is not async-signal-safe.

Always check `is_lock_free()` (runtime) or `is_always_lock_free` (compile-time constant, since C++17) before relying on lock-free behavior.

```cpp
static_assert(std::atomic<int>::is_always_lock_free);
static_assert(std::atomic<void*>::is_always_lock_free);
// std::atomic<Big>::is_always_lock_free is false on most platforms
```

The cmpxchg16b case: on x86-64 with `-mcx16`, `std::atomic<__int128>::is_always_lock_free` is true. Without `-mcx16`, it is false and the atomic falls back to libatomic which uses a lock. The compiler does not error. You silently get slow code. Always check the assembly for double-CAS code.

### Trivially Copyable Requirement

`std::atomic<T>` requires T to be trivially copyable. This means:

- Trivial copy constructor, copy assignment, move constructor, move assignment, destructor.
- No virtual functions, no virtual base.
- Each base class subobject and non-static data member is trivially copyable.

Why: the implementation does memcpy and bitwise compare on T. Any user-defined operations would not compose with atomic semantics.

`std::atomic_ref<T>` has the same requirement.

This rules out wrapping `std::string`, `std::shared_ptr<T>` (use `std::atomic<std::shared_ptr<T>>` from C++20 which has a special implementation), or any class with non-trivial members in atomic.

### `atomic<shared_ptr>` and `atomic<weak_ptr>`

C++20 added `std::atomic<std::shared_ptr<T>>` as a special case. Despite shared_ptr not being trivially copyable, the standard provides an atomic specialization that internally uses a split-counter or DCAS scheme to swap pointers atomically while managing reference counts.

Implementation (libstdc++): uses a mutex internally except on platforms with native double-CAS. libc++ uses tagged pointers and cmpxchg16b on x86-64. Performance varies wildly by implementation. Benchmark before relying on it for hot paths.

Pre-C++20 the same functionality existed as free functions `std::atomic_load(shared_ptr*)`, `std::atomic_store(shared_ptr*, ...)`. These were deprecated in C++20 in favor of the atomic specialization.

### atomic_ref vs atomic: The Choice

Use `std::atomic<T>` when:

- You own the type definition.
- You want the atomic property to be part of the type.
- You will never access non-atomically.

Use `std::atomic_ref<T>` when:

- You need atomic access at certain call sites only.
- You cannot change the original type (legacy code, FFI struct).
- You want shared atomic operations on an array or buffer where most access is non-atomic and fenced separately.

```cpp
// Common pattern: atomic_ref over an array element
std::vector<int> stats(N);

// Hot path, no atomicity
for (auto& s : stats) s += local_add[/* index */];

// Cold path, snapshot via atomic_ref
for (size_t i = 0; i < N; ++i) {
    int v = std::atomic_ref<int>(stats[i]).load(std::memory_order_acquire);
    // ... use v
}
```

Note: this example assumes you have arranged not to access stats[i] both atomically and non-atomically concurrently. The standard requires the entire lifetime of any atomic_ref to be consistent (all accesses atomic). Mixed access is undefined behavior even on x86 where it might appear to work.

### Padding and False Sharing

When you wrap an existing field in atomic_ref, watch the cache line layout. If the field shares a line with frequently-modified non-atomic data, you have false sharing.

```cpp
struct Counters {
    int counter_a;          // atomic_ref'd
    int counter_b;          // atomic_ref'd
    int padding[14];        // separate counter_a and counter_b? Maybe.
};
```

`std::hardware_destructive_interference_size` (C++17) gives the platform's destructive interference size. Use `alignas(std::hardware_destructive_interference_size)` on each independently-modified atomic field.

### Volatile vs Atomic

`volatile` is not for threading in C++. It prevents compiler optimization but does not insert any memory barriers and does not prevent tearing. `volatile int` reads and writes are not atomic on architectures where the type spans multiple words.

Use volatile only for memory-mapped I/O and for asynchronous signal handlers in single-threaded code. For multithreading use `std::atomic` or `std::atomic_ref`.

C++20 and C++23 deprecated certain compound volatile operations (`v += 1` on volatile is deprecated) to push users toward atomic when they meant atomic.

### ARMv8.4 LSE2

LSE2 (Large System Extensions 2, ARMv8.4) added single-copy atomicity for unaligned 16-byte loads and stores via `ldp`/`stp`. Before LSE2:

- 16-byte aligned load/store on ARM was already single-copy atomic since ARMv8.0.
- 16-byte CAS required `casp` (LSE) or `ldxp`/`stxp` loop.

LSE2 made `ldp` and `stp` on a single 16-byte aligned address single-copy atomic. This benefits `std::atomic<__int128>::load` and `store` on ARM, which now do not require an LL/SC loop. Compare-and-swap still needs `casp` or the loop.

For the C++ programmer this is mostly invisible. Compilers since GCC 12 and Clang 15 emit LSE2 instructions when targeting `-march=armv8.4-a` or higher. Modern Apple Silicon (M1 and later), AWS Graviton 3, and Ampere Altra all support LSE2.

### Junior at FAANG vs Senior at FAANG

Junior creates `std::atomic<MyStruct>` where MyStruct is 64 bytes, never checks `is_lock_free`, ships code that secretly mutex-serializes every "atomic" op. Senior:

- Checks `is_always_lock_free` at compile time with `static_assert`.
- For T > 16 bytes, redesigns the data structure (e.g., split hot fields into separately atomic words).
- Uses `atomic_ref` for legacy data instead of redesigning the struct.
- Reads the assembly to verify cmpxchg16b is emitted on x86 with `-mcx16`.
