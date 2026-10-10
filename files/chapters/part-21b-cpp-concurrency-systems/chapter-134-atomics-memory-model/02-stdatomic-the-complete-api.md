## std::atomic: The Complete API

`std::atomic<T>` is a template that wraps a type `T` and provides atomic operations on it. For `T` to be usable, it must be trivially copyable (no custom copy constructor, no virtual functions, no references as members).

### Construction and Basic Properties

`std::atomic<int>` defaults to uninitialized in C++14. Always initialize explicitly with a value or brace syntax. The `is_lock_free()` method reveals whether the hardware supports the operation natively (without a hidden mutex), true for types whose size matches a native word width (int, pointer) and false for large structs, where the standard library falls back to a mutex internally.
```cpp
#include <atomic>
#include <iostream>

int main() {
    // Default construction - value is uninitialized (C++17 fixes this for
    // some types, but always initialize explicitly)
    std::atomic<int> a1;          // Uninitialized - do not read before writing

    // Value initialization
    std::atomic<int> a2(0);       // Initialized to 0
    std::atomic<int> a3{42};      // Brace initialization

    // C++20 allows:
    // std::atomic<int> a4 = 42; // Copy initialization

    // Atomics are NOT copyable or movable
    // std::atomic<int> a5 = a2; // ERROR: deleted copy constructor
    // std::atomic<int> a6(std::move(a2)); // ERROR: deleted move constructor

    // Check if lock-free (hardware-supported atomic operations)
    std::cout << "int is lock-free: " << a2.is_lock_free() << "\n";

    // Compile-time check (C++17)
    std::cout << "always lock-free: " << std::atomic<int>::is_always_lock_free << "\n";

    // Typical results on x86-64:
    // - atomic<int>: lock-free (4 bytes, fits in a single cache line word)
    // - atomic<long long>: lock-free (8 bytes on 64-bit)
    // - atomic<large_struct>: NOT lock-free (uses internal mutex)

    return 0;
}
```

**Lock-free means the hardware provides native atomic instructions** (like `lock cmpxchg` on x86 or `ldxr`/`stxr` on ARM). Non-lock-free atomics use an internal spinlock or mutex, which defeats many performance benefits.

### load and store

The most basic operations: read and write an atomic value.

```cpp
#include <atomic>
#include <thread>
#include <iostream>

std::atomic<int> counter(0);

void writer() {
    // store: atomically write a value
    // Signature: void store(T desired, memory_order order = memory_order_seq_cst)
    counter.store(42, std::memory_order_release);
}

void reader() {
    // load: atomically read the current value
    // Signature: T load(memory_order order = memory_order_seq_cst)
    int value = counter.load(std::memory_order_acquire);
    std::cout << "Read: " << value << "\n";
}

int main() {
    // Implicit conversions also work (use seq_cst ordering):
    counter = 10;           // Equivalent to counter.store(10)
    int val = counter;      // Equivalent to counter.load()

    std::thread t1(writer);
    std::thread t2(reader);
    t1.join();
    t2.join();

    return 0;
}
```

### exchange

Atomically replaces the value and returns the old value. This is an unconditional swap.

```cpp
#include <atomic>
#include <iostream>

int main() {
    std::atomic<int> flag(0);

    // Signature: T exchange(T desired, memory_order order = memory_order_seq_cst)
    int old = flag.exchange(1);
    std::cout << "Was: " << old << ", Now: " << flag.load() << "\n";
    // Output: Was: 0, Now: 1

    // Common use: implement a simple spinlock
    // try_lock: exchange 0 -> 1, if old value was 0, we acquired the lock
    old = flag.exchange(1);
    if (old == 0) {
        std::cout << "Lock acquired\n";
    } else {
        std::cout << "Lock was already held\n";
    }

    return 0;
}
```

### compare_exchange_weak and compare_exchange_strong

The most powerful atomic operations. They implement compare-and-swap (CAS): "If the current value equals `expected`, replace it with `desired` and return true. Otherwise, load the current value into `expected` and return false."

```cpp
#include <atomic>
#include <iostream>
#include <thread>
#include <vector>

std::atomic<int> value(0);

// Lock-free increment using CAS
void increment(int times) {
    for (int i = 0; i < times; ++i) {
        int expected = value.load(std::memory_order_relaxed);
        // compare_exchange_weak may fail spuriously (even when expected == current)
        // This is fine in a loop - spurious failures are rare and retrying is cheap
        while (!value.compare_exchange_weak(
            expected,                       // Reference: updated on failure
            expected + 1,                   // Desired value on success
            std::memory_order_relaxed,      // Success ordering
            std::memory_order_relaxed       // Failure ordering
        )) {
            // 'expected' has been updated with the actual value
            // Loop will retry with the new expected value
        }
    }
}

int main() {
    std::vector<std::thread> threads;
    for (int i = 0; i < 10; ++i) {
        threads.emplace_back(increment, 10000);
    }
    for (auto& t : threads) {
        t.join();
    }
    std::cout << "Final value: " << value.load() << "\n";
    // Always prints: Final value: 100000
    return 0;
}
```

**Weak vs Strong**:

| Property | `compare_exchange_weak` | `compare_exchange_strong` |
|----------|------------------------|--------------------------|
| Spurious failure | Yes, may fail even when `expected == current` | No, fails only when values differ |
| Performance | Faster on LL/SC architectures (ARM, POWER) | May need internal loop on LL/SC |
| Use case | Inside a retry loop (the common case) | Single-shot CAS without a loop |
| On x86 | Identical, both map to `lock cmpxchg` | Identical, both map to `lock cmpxchg` |

**Rule of thumb**: Use `weak` when you already have a retry loop. Use `strong` when you need a single-shot decision.

```cpp
// compare_exchange_strong: Use when you need a single attempt
std::atomic<int> singleton_state(0); // 0=uninitialized, 1=initializing, 2=ready

void initialize_once() {
    int expected = 0;
    // Only one thread will succeed - no retry loop needed
    if (singleton_state.compare_exchange_strong(expected, 1)) {
        // We won the race - perform initialization
        // ... expensive initialization ...
        singleton_state.store(2, std::memory_order_release);
    } else {
        // Another thread is initializing or already done
        while (singleton_state.load(std::memory_order_acquire) != 2) {
            // Spin or yield
        }
    }
}
```

### Fetch Operations: fetch_add, fetch_sub, fetch_and, fetch_or, fetch_xor

These perform read-modify-write atomically and return the **previous** value. Available for integer and pointer atomic types.

```cpp
#include <atomic>
#include <iostream>
#include <thread>
#include <vector>
#include <bitset>

int main() {
    // fetch_add: Atomically adds and returns old value
    std::atomic<int> counter(0);
    int old = counter.fetch_add(5, std::memory_order_relaxed);
    std::cout << "fetch_add: was " << old << ", now " << counter.load() << "\n";
    // Output: fetch_add: was 0, now 5

    // Operator overloads (always use seq_cst):
    counter++;       // fetch_add(1), returns old value
    ++counter;       // fetch_add(1), returns NEW value
    counter += 10;   // fetch_add(10), returns old value

    // fetch_sub: Atomically subtracts and returns old value
    old = counter.fetch_sub(3, std::memory_order_relaxed);
    std::cout << "fetch_sub: was " << old << ", now " << counter.load() << "\n";

    // fetch_and: Atomically performs bitwise AND
    std::atomic<unsigned> flags(0b11111111);
    unsigned old_flags = flags.fetch_and(0b11110000, std::memory_order_relaxed);
    std::cout << "fetch_and: was " << std::bitset<8>(old_flags)
              << ", now " << std::bitset<8>(flags.load()) << "\n";
    // Output: fetch_and: was 11111111, now 11110000

    // fetch_or: Atomically performs bitwise OR
    flags.fetch_or(0b00001100, std::memory_order_relaxed);
    std::cout << "fetch_or: now " << std::bitset<8>(flags.load()) << "\n";
    // Output: fetch_or: now 11111100

    // fetch_xor: Atomically performs bitwise XOR (toggle bits)
    flags.fetch_xor(0b10101010, std::memory_order_relaxed);
    std::cout << "fetch_xor: now " << std::bitset<8>(flags.load()) << "\n";
    // Output: fetch_xor: now 01010110

    // Pointer arithmetic with fetch_add
    int arr[10] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
    std::atomic<int*> ptr(arr);
    int* old_ptr = ptr.fetch_add(3); // Advances by 3 elements (3 * sizeof(int) bytes)
    std::cout << "Pointer: was arr[" << (old_ptr - arr)
              << "], now arr[" << (ptr.load() - arr) << "]\n";
    // Output: Pointer: was arr[0], now arr[3]

    return 0;
}
```

### Atomic Flags: std::atomic_flag

The simplest atomic type. Guaranteed to be lock-free on every platform (unlike `std::atomic<bool>`, which is lock-free on most but not all platforms). Has only `test_and_set` and `clear` operations.

```cpp
#include <atomic>
#include <thread>
#include <iostream>

class Spinlock {
    std::atomic_flag flag = ATOMIC_FLAG_INIT; // Guaranteed initialized to clear state

public:
    void lock() {
        // test_and_set: atomically sets to true, returns previous value
        // If previous was false, we acquired the lock
        while (flag.test_and_set(std::memory_order_acquire)) {
            // Spin. On C++20, you can use flag.wait(true) instead.
        }
    }

    void unlock() {
        flag.clear(std::memory_order_release);
    }
};

Spinlock spin;
int shared_counter = 0;

void increment(int n) {
    for (int i = 0; i < n; ++i) {
        spin.lock();
        ++shared_counter;
        spin.unlock();
    }
}

int main() {
    std::thread t1(increment, 100000);
    std::thread t2(increment, 100000);
    t1.join();
    t2.join();
    std::cout << "Counter: " << shared_counter << "\n";
    // Always prints: Counter: 200000
    return 0;
}
```

### C++20 Additions: wait, notify_one, notify_all

C++20 added blocking wait operations to atomics, similar to futex on Linux:

```cpp
#include <atomic>
#include <thread>
#include <iostream>

std::atomic<int> state(0);

void waiter() {
    // Blocks until state != 0 (no busy-spinning)
    state.wait(0, std::memory_order_acquire);
    std::cout << "State changed to: " << state.load() << "\n";
}

void signaler() {
    state.store(42, std::memory_order_release);
    state.notify_one(); // Wake one waiting thread
    // state.notify_all(); // Wake all waiting threads
}

int main() {
    std::thread t1(waiter);
    std::thread t2(signaler);
    t1.join();
    t2.join();
    return 0;
}
```

### Junior → FAANG: Using std::atomic Without Getting Burned

The most important thing to know at the junior level: `std::atomic<T>` does not make the entire operation on `T` atomic, it makes each individual operation atomic. The classic mistake is treating `counter++` as safe just because `counter` is `std::atomic<int>`. The increment is atomic, but if you need "read, check, increment" to be atomic as a unit, you need `compare_exchange`.

Worked example to internalize: a statistics counter that only ever increments from multiple threads is a correct use of `std::atomic<int>` with `fetch_add`. A rate limiter that checks-then-decrements is not safe with `fetch_sub` alone, you need a CAS loop or a mutex. Be able to identify which category a use case falls into.

First-job habit: whenever you add a new `std::atomic`, leave a comment explaining which threads read it, which threads write it, and what invariant the atomic is protecting. This takes 30 seconds and saves hours of debugging.

### Senior @ FAANG: The Lock-Free API as a System-Level Commitment

At L5+, choosing `std::atomic` over a mutex is not a performance micro-optimization, it is a system-level commitment. Lock-free code is harder to reason about, harder to test, and harder to modify safely. Every lock-free path in a codebase is a liability that requires active maintenance.

The key senior question before using `std::atomic` in a new design: is lock-free actually necessary here? The answer is yes only when (1) the lock-free path is in a context where taking a mutex is impossible (signal handler, interrupt context) or (2) a measured benchmark shows the mutex is a bottleneck at production concurrency levels. "I think it will be faster" is not a sufficient justification at L5.

`is_lock_free()` and `ATOMIC_xxx_LOCK_FREE` matter for production decisions. A `std::atomic<double>` may not be lock-free on all platforms, which means it may acquire an internal mutex, defeating the purpose. Before committing to a lock-free design for a 128-bit type or a custom struct, verify lock-freedom on every target architecture. This belongs in an ADR with benchmark data attached.

Bar-raiser signal: in a design review, the question "why not use a mutex?" should have a quantitative answer. "Lock-free is faster" is not sufficient. "Our benchmark at 64 threads shows 2.1x throughput improvement and the mutex shows 40% time in lock contention at p99" is sufficient. Senior engineers bring data. Bar-raisers require it.

L6 platform thinking: `std::atomic<T>::wait` and `notify_one/all` (C++20) allow building condition variables on top of atomics without futex overhead in the uncontended case. If your platform (Linux kernel 5.16+, recent glibc) supports futex2, the atomic wait may outperform `std::condition_variable` for short waits. This is a platform-specific optimization worth understanding before designing a high-throughput producer-consumer system.

---
