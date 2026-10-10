## 4. Wait-Free Algorithms

### Lock-Free vs. Wait-Free

- **Lock-free:** At least one thread makes progress in a finite number of steps. Individual threads may starve.
- **Wait-free:** Every thread completes its operation in a bounded number of steps. No starvation possible.

Wait-free is strictly stronger than lock-free. It is also much harder to achieve and often carries higher overhead.

### Wait-Free Counter

A simple wait-free counter gives each thread its own slot:

```cpp
#include <atomic>
#include <array>
#include <numeric>
#include <thread>

class WaitFreeCounter {
    static constexpr int MAX_THREADS = 64;

    struct alignas(64) PaddedCounter {  // Avoid false sharing
        std::atomic<int64_t> value{0};
    };

    std::array<PaddedCounter, MAX_THREADS> slots_;

public:
    // Each thread increments its own slot -- no contention, no retry
    void increment(int thread_id) {
        slots_[thread_id].value.fetch_add(1, std::memory_order_relaxed);
    }

    // Sum is linearizable (snapshot is more complex -- see below)
    int64_t read() const {
        int64_t sum = 0;
        for (const auto& slot : slots_) {
            sum += slot.value.load(std::memory_order_acquire);
        }
        return sum;
    }
};
```

This is genuinely wait-free: `increment` completes in exactly one atomic operation regardless of contention.

### Wait-Free Snapshot

A linearizable snapshot of all slots requires the helping mechanism. The Afek et al. Algorithm is the classical approach:

```cpp
#include <atomic>
#include <array>
#include <vector>

template <typename T, int N>
class WaitFreeSnapshot {
    struct StampedValue {
        T value;
        int64_t stamp;
        std::vector<T> snapshot;  // Embedded snapshot for helping
    };

    std::array<std::atomic<StampedValue*>, N> registers_;

public:
    void update(int thread_id, T new_val) {
        // Take a scan before writing (for helping)
        auto snap = scan();
        auto* sv = new StampedValue{
            new_val,
            registers_[thread_id].load()->stamp + 1,
            snap
        };
        registers_[thread_id].store(sv, std::memory_order_release);
    }

    std::vector<T> scan() {
        // Double-collect: keep scanning until two consecutive reads match,
        // or detect a thread that moved twice (use its embedded snapshot).
        std::array<StampedValue*, N> first, second;
        std::array<bool, N> moved{};

        while (true) {
            for (int i = 0; i < N; ++i)
                first[i] = registers_[i].load(std::memory_order_acquire);
            for (int i = 0; i < N; ++i)
                second[i] = registers_[i].load(std::memory_order_acquire);

            bool clean = true;
            for (int i = 0; i < N; ++i) {
                if (first[i]->stamp != second[i]->stamp) {
                    if (moved[i]) {
                        // Thread i moved twice -- use its embedded snapshot
                        return second[i]->snapshot;
                    }
                    moved[i] = true;
                    clean = false;
                }
            }
            if (clean) {
                std::vector<T> result(N);
                for (int i = 0; i < N; ++i)
                    result[i] = second[i]->value;
                return result;
            }
        }
    }
};
```

**Why this is wait-free:** After at most N+1 double-collects, some thread must have moved twice, so we borrow its embedded snapshot. The bound is O(N^2) steps.

### Junior → FAANG: When Wait-Free Matters and When It Does Not

Wait-free is the gold standard of concurrent algorithm progress guarantees, but it is rarely necessary or practical in application-level code. The cases where wait-free is genuinely required: hard real-time systems (flight control, medical devices), interrupt handlers that must complete in bounded time, and systems with strict fairness requirements.

For FAANG interviews: know that wait-free is stronger than lock-free (every thread completes in bounded steps vs. at least one thread always makes progress). Know that wait-free algorithms are typically more complex and have higher constant factors. The MRSW snapshot algorithm shown here is O(N^2) steps per snapshot. A mutex-based snapshot is O(1) with constant overhead.

First-job advice: use wait-free algorithms only from proven libraries (`std::atomic::wait` for simple cases, Folly's hazard pointer infrastructure for node-based structures). Do not implement wait-free algorithms from scratch without a formal correctness proof.

### Senior @ FAANG: Wait-Free in Platform Infrastructure

At L5+, the decision to use a wait-free algorithm is a platform contract. If you provide a library with a wait-free read path, you are committing to that guarantee for all callers. Changing it to lock-free later is a breaking change for any caller that depended on the bounded-step property.

The practical use case at FAANG: read-heavy configuration stores (feature flags, routing tables, rate limit configs) where the read path must not block under any condition. The read-copy-update (RCU) pattern in the next section is the industry-standard approach. True wait-free RCU reads (using `std::atomic<std::shared_ptr<T>>` in C++20) give wait-free reads with lock-free writes.

The O(N^2) bound on the Afek-Attiya-Bar-Noy snapshot is academically interesting but practically unused at FAANG due to its high constant factor. Production snapshots use either RCU (wait-free reads, lock-free writes with copy) or seqlocks (wait-free reads under low write contention, retry on write collision). Both are pragmatically wait-free for typical workloads without the O(N^2) overhead.

Staff-level concern: if a library you own advertises a wait-free guarantee, document the specific bound (O(N) steps? O(1)?) and validate it with a stress test that measures maximum steps taken per operation across 1000 runs at peak concurrency. "Wait-free" without a concrete bound is a marketing claim, not an engineering guarantee.

---
