## 1. CAS Loops: The Foundation of Lock-Free

Every lock-free algorithm is built on a single primitive: **Compare-And-Swap** (CAS). In C++, this is `std::atomic<T>::compare_exchange_weak` and `compare_exchange_strong`. CAS atomically reads a value, compares it to an expected value, and writes a new value only if the comparison succeeds.

### How CAS Works

```cpp
#include <atomic>
#include <iostream>

std::atomic<int> counter{0};

// Lock-free increment using a CAS loop
void lock_free_increment() {
    int old_val = counter.load(std::memory_order_relaxed);
    while (!counter.compare_exchange_weak(
               old_val,                      // expected (updated on failure)
               old_val + 1,                  // desired
               std::memory_order_release,    // success ordering
               std::memory_order_relaxed))   // failure ordering
    {
        // old_val was reloaded by compare_exchange_weak on failure.
        // Loop retries with the fresh value.
    }
}
```

**Key points:**

- `compare_exchange_weak` may fail spuriously (even when expected == current). Use it in loops.
- `compare_exchange_strong` never fails spuriously. Use it when a single attempt matters (e.g., inside an `if` rather than a `while`).
- On failure, `old_val` is updated to the current value, so you do not need an explicit reload.

### CAS Loop Pattern

The general pattern for any lock-free mutation:

```cpp
template <typename T, typename F>
T atomic_update(std::atomic<T>& target, F transform) {
    T old_val = target.load(std::memory_order_acquire);
    T new_val;
    do {
        new_val = transform(old_val);
    } while (!target.compare_exchange_weak(
                 old_val, new_val,
                 std::memory_order_acq_rel,
                 std::memory_order_acquire));
    return new_val;
}

// Usage: atomically double a value
// atomic_update(counter, [](int v) { return v * 2; });
```

This pattern, load, compute, CAS, retry on failure, is the heartbeat of every lock-free structure we build in this chapter.

### Weak vs. Strong: When to Choose

| Aspect | `compare_exchange_weak` | `compare_exchange_strong` |
|-------------------------|-------------------------------|--------------------------------|
| Spurious failure | Yes | No |
| Best used in | Loops (retry anyway) | Single-shot decisions |
| Performance | Faster on some architectures | May contain inner loop on LL/SC|
| Typical use | Lock-free data structures | State machine transitions |

On x86, both compile to the same `CMPXCHG` instruction. On ARM/RISC-V (LL/SC architectures), `weak` avoids an inner retry loop, making it cheaper in an outer CAS loop.

### Junior → FAANG: Writing CAS Loops That Do Not Spin Forever

The CAS loop pattern is the basis of all lock-free algorithms. The structure: read a value, compute a new value, attempt CAS, retry if it fails. The subtlety: after a CAS failure, you must re-read the current value (the `expected` variable is updated by `compare_exchange_weak` on failure) before retrying.

The common junior mistake: retrying the CAS with the original expected value after a failure. This spins forever because the value has changed and the CAS will always fail. The correct pattern uses the updated `expected` from the failed CAS as the input to the next attempt.

Interview pattern: in a FAANG interview, if asked to implement a lock-free counter increment, write the CAS loop with `fetch_add` first (which is atomic and does not need a loop). If the interviewer asks for a custom read-modify-write that `fetch_add` cannot express, write the CAS loop with `compare_exchange_weak` in a `do { } while (!cas)` pattern, reading `expected` from the current load each iteration.

### Senior @ FAANG: CAS Loop Contention Analysis and Backoff Strategies

At L5+, a CAS loop without a backoff strategy is a latent performance problem. Under high contention, threads that fail their CAS immediately retry, creating a contention storm where all threads are simultaneously trying to win the same CAS. The CPU's cache coherence protocol serializes these attempts, and all but one thread per round wastes its time budget.

The backoff strategies in order of increasing complexity: (1) yield (`std::this_thread::yield()`) after each failure, giving the OS scheduler a chance to run the successful thread, (2) exponential backoff with a ceiling (spin for 1, 2, 4, ... up to max cycles before yielding), (3) adaptive backoff based on the observed CAS failure rate, (4) elimination backoff (for stacks) where two concurrent push/pop threads short-circuit by exchanging directly. Each adds complexity and narrows the contention distribution without bounding it.

The production measurement: run a Google Benchmark of the CAS loop at 1, 8, 32, and 64 threads. Plot throughput per thread. A healthy lock-free structure shows near-linear scaling to 8 threads and graceful degradation to 32. If throughput collapses at 32 threads, the CAS loop has a contention problem that backoff alone may not fix, and you need structural redesign (sharding, per-CPU, or elimination).

---
