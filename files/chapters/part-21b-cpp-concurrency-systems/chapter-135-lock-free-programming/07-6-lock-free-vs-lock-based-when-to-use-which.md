## 6. Lock-Free vs. Lock-Based: When to Use Which

### Decision Framework

Choose **lock-based** (mutexes) when:
- Contention is low or moderate.
- Critical sections do I/O, allocate memory, or call complex functions.
- Simplicity and correctness are priorities.
- You need to protect complex invariants spanning multiple variables.
- Development time matters more than nanosecond-level latency.

Choose **lock-free** when:
- You have measured lock contention as a bottleneck (not assumed).
- You need guaranteed system-wide progress (no deadlocks).
- You are building infrastructure used by millions of operations per second (queues, counters, caches).
- Real-time constraints prohibit unbounded blocking.
- A well-tested library provides the structure you need (prefer libraries over hand-rolled).

Choose **wait-free** when:
- Hard real-time guarantees are required (per-thread bounded latency).
- Fairness is critical (no thread may starve).
- The structure is simple enough that wait-free overhead is acceptable.

### Performance Reality Check

Under low contention, a mutex-based counter and an atomic counter perform similarly. Under high thread contention the atomic counter (using `fetch_add` with `memory_order_relaxed`) significantly outperforms the mutex because it avoids OS kernel involvement, the CAS loop retries in user space rather than blocking. Measure before choosing: the performance difference only matters when many threads contend on the same variable simultaneously.
```cpp
#include <atomic>
#include <mutex>
#include <thread>
#include <chrono>
#include <iostream>
#include <vector>

// Benchmark: mutex vs atomic counter under contention
void benchmark(int num_threads, int ops_per_thread) {
    // Mutex-based counter
    {
        int64_t counter = 0;
        std::mutex mtx;
        auto start = std::chrono::high_resolution_clock::now();

        std::vector<std::thread> threads;
        for (int i = 0; i < num_threads; ++i) {
            threads.emplace_back([&]() {
                for (int j = 0; j < ops_per_thread; ++j) {
                    std::lock_guard<std::mutex> lock(mtx);
                    ++counter;
                }
            });
        }
        for (auto& t : threads) t.join();

        auto elapsed = std::chrono::high_resolution_clock::now() - start;
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
        std::cout << "Mutex:     " << ms.count() << " ms, value=" << counter << "\n";
    }

    // Lock-free counter
    {
        std::atomic<int64_t> counter{0};
        auto start = std::chrono::high_resolution_clock::now();

        std::vector<std::thread> threads;
        for (int i = 0; i < num_threads; ++i) {
            threads.emplace_back([&]() {
                for (int j = 0; j < ops_per_thread; ++j) {
                    counter.fetch_add(1, std::memory_order_relaxed);
                }
            });
        }
        for (auto& t : threads) t.join();

        auto elapsed = std::chrono::high_resolution_clock::now() - start;
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
        std::cout << "Lock-free: " << ms.count() << " ms, value=" << counter << "\n";
    }
}

int main() {
    std::cout << "=== 4 threads, 10M ops each ===\n";
    benchmark(4, 10'000'000);
    std::cout << "\n=== 16 threads, 10M ops each ===\n";
    benchmark(16, 10'000'000);
}
```

**Typical results (x86-64, 8-core):**

| Threads | Mutex (ms) | Lock-Free (ms) | Speedup |
|---------|-----------|-----------------|---------|
| 4 | 850 | 320 | 2.7x |
| 16 | 3400 | 1200 | 2.8x |

Lock-free wins for hot counters, but the advantage shrinks or reverses for complex operations where the mutex critical section is short relative to lock overhead.

### Junior → FAANG: The Decision Framework in Practice

The decision table in this section is more useful than a gut feeling. Before choosing lock-free, answer all four questions: Is there contention? Is the mutex measurably a bottleneck? Is a signal handler or real-time context involved? Is a battle-tested lock-free implementation available?

In most first-job scenarios, the answer to "use lock-free?" is no. Mutexes are easier to reason about, easier to test, and easier to debug. The exception: using an existing lock-free container from a well-tested library (Folly, TBB, Abseil) where someone else has done the correctness work.

Interview framing: if asked "would you use a lock-free queue or a mutex-protected queue?", the correct answer starts with "it depends on the measured access pattern and the progress requirements." Never say "lock-free is always faster." That answer fails the interview.

### Senior @ FAANG: Lock-Free vs. Lock-Based as an Architectural Decision with Maintenance Implications

At L5+, the decision affects the team's ability to maintain the code, not just its immediate performance. A mutex-based queue that is correct and readable is worth more than a lock-free queue that requires the three team members who understand it to be on-call 24/7.

The maturity signal: teams that have good production experience with lock-free code have a discipline around it. They use it only for specific, well-understood patterns (SPSC queues, counters, RCU), rely on proven libraries for complex structures, and write extensive stress tests and property tests for anything custom. Teams without this discipline accumulate lock-free code that works in dev but fails in production under load.

The ADR for a new lock-free structure must include a maintenance plan: who owns it, how is correctness validated after refactors, how do you detect regressions (TSan in CI, benchmark regression gate). Without a maintenance plan, lock-free code is technical debt that compounds over time.

The benchmark data in this section (2.8x improvement at 16 threads for a hot counter) is the typical best case. For complex operations (insert with rebalancing, eviction with expiry), the mutex typically wins at moderate thread counts because the critical section is shorter than the CAS retry cost. Always measure at your specific access pattern and thread count.

---
