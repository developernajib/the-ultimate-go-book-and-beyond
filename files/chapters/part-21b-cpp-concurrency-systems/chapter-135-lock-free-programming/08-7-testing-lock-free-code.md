## 7. Testing Lock-Free Code

Lock-free code is notoriously difficult to test because bugs depend on specific thread interleavings that may occur once in millions of runs.

### ThreadSanitizer (TSan)

TSan is the first line of defense. Compile with `-fsanitize=thread`:

```bash
g++ -std=c++20 -fsanitize=thread -g -O1 lock_free_stack.cpp -o test
./test
```

TSan instruments memory accesses and detects data races. It will catch missing or incorrect memory orderings on atomic operations.

### Stress Testing

Run operations at high concurrency and verify invariants:

```cpp
#include <thread>
#include <vector>
#include <set>
#include <cassert>
#include <iostream>

template <typename Stack>
void stress_test_stack(int num_threads, int ops_per_thread) {
    Stack stack;
    std::atomic<int> push_count{0};
    std::atomic<int> pop_count{0};

    // Phase 1: Concurrent pushes
    {
        std::vector<std::thread> threads;
        for (int t = 0; t < num_threads; ++t) {
            threads.emplace_back([&, t]() {
                for (int i = 0; i < ops_per_thread; ++i) {
                    int val = t * ops_per_thread + i;
                    stack.push(val);
                    push_count.fetch_add(1, std::memory_order_relaxed);
                }
            });
        }
        for (auto& th : threads) th.join();
    }

    // Phase 2: Concurrent pops -- verify all elements come out exactly once
    std::vector<std::vector<int>> per_thread_results(num_threads);
    {
        std::vector<std::thread> threads;
        for (int t = 0; t < num_threads; ++t) {
            threads.emplace_back([&, t]() {
                while (true) {
                    auto val = stack.pop();
                    if (!val) break;
                    per_thread_results[t].push_back(*val);
                    pop_count.fetch_add(1, std::memory_order_relaxed);
                }
            });
        }
        for (auto& th : threads) th.join();
    }

    // Verify: every pushed value was popped exactly once
    std::set<int> all_popped;
    for (auto& v : per_thread_results) {
        for (int val : v) {
            assert(all_popped.insert(val).second && "Duplicate value popped!");
        }
    }

    int expected = num_threads * ops_per_thread;
    assert(static_cast<int>(all_popped.size()) == expected);
    std::cout << "Stress test passed: " << expected
              << " items pushed and popped correctly.\n";
}
```

### Model Checking with CDSChecker or GenMC

For formal verification of lock-free algorithms, model checkers exhaustively explore all possible interleavings:

```bash
# Using GenMC (https://github.com/MPI-SWS/genmc)
genmc -imm -- lock_free_stack_test.c

# Using CDSChecker
./cds_checker lock_free_stack_test
```

These tools operate on C/C++11 atomics and verify correctness under all possible memory orderings and schedules. They are invaluable for verifying new algorithms but do not scale to full applications.

### Injecting Scheduling Noise

Real race conditions are rare under normal scheduling. Deliberately inject noise to widen race windows:

```cpp
#include <atomic>
#include <thread>
#include <random>

// Insert at critical points in your lock-free code
inline void scheduling_noise() {
#ifdef STRESS_TEST
    thread_local std::mt19937 rng(
        std::hash<std::thread::id>{}(std::this_thread::get_id()));
    switch (rng() % 8) {
        case 0: std::this_thread::yield(); break;
        case 1: std::this_thread::sleep_for(
                     std::chrono::microseconds(rng() % 100)); break;
        default: break;  // No delay most of the time
    }
#endif
}

// Usage in lock-free pop:
// Node* old_head = head_.load(std::memory_order_acquire);
// scheduling_noise(); // Widen the window between load and CAS
// head_.compare_exchange_weak(old_head, old_head->next, ...);
```

Compile with `-DSTRESS_TEST` during testing and without it in production. This technique dramatically increases the probability of hitting rare interleavings.

### Cross-Architecture Testing

x86's strong memory model (Total Store Order) makes many ordering bugs invisible. Code that works perfectly on x86 may crash on ARM or RISC-V. Always test on weak-memory architectures:

- **Native ARM testing:** Use an ARM-based CI machine (AWS Graviton, Apple M-series, Raspberry Pi).
- **QEMU emulation:** `qemu-aarch64 -L /usr/aarch64-linux-gnu ./test_binary` runs ARM binaries on x86.
- **Compiler flags:** Some compilers can simulate weaker memory models for testing, though this is not a substitute for real hardware.

### Testing Checklist

1. **Compile with TSan** (`-fsanitize=thread`) and run all tests.
2. **Stress test** with varying thread counts (1, 2, 4, 8, 16, 64).
3. **Verify invariants:** no lost items, no duplicates, no corruption.
4. **Inject delays:** Add scheduling noise at strategic points to widen race windows.
5. **Run on different architectures:** x86 has strong ordering that hides bugs visible on ARM.
6. **Model check** critical algorithms with GenMC or CDSChecker.
7. **Test under memory pressure:** `malloc` failures during lock-free operations should not corrupt state.
8. **Run with ASan** (`-fsanitize=address`) to catch use-after-free from incorrect reclamation.
9. **Fuzz the operation sequence:** Randomize the mix of push/pop/enqueue/dequeue across threads.

### Junior → FAANG: The Minimum Testing Bar for Lock-Free Code

The minimum testing bar for any lock-free data structure: (1) TSan clean under a concurrent stress test with at least 8 threads for 30 seconds, (2) ASan clean with the same stress test to catch use-after-free from incorrect reclamation, (3) a single-threaded correctness test that validates the data structure semantics (FIFO order, LIFO order, etc.) without concurrency noise.

The single-threaded test is often skipped because engineers assume "the concurrent test covers it." Do not skip it. Many lock-free bugs manifest as semantic violations (wrong order, lost elements) rather than crashes, and these are easier to detect in a single-threaded test with deterministic execution.

The TSan stress test pattern: N producer threads pushing M elements each, N consumer threads consuming until all elements are dequeued. At the end, verify that the total elements consumed equals N*M. Run with TSan. Any count mismatch is a lost-update bug. Any TSan report is an ordering bug.

### Senior @ FAANG: Testing Lock-Free Code as a CI Gate, Not a One-Time Effort

At L5+, testing lock-free code is a continuous process, not a one-time gate. The testing infrastructure must be part of CI with the following requirements: (1) TSan stress test at multiple thread counts (8, 32, 64) on both x86 and ARM, (2) a memory ordering litmus test for the core algorithm (using `herd7` or `Dat3M`), (3) a benchmark regression test that fails if throughput drops more than 5% from baseline.

The litmus test requirement is the senior-level addition. TSan verifies that the code as compiled and run does not have races. A litmus test verifies that the memory model expressed by the orderings is correct for the algorithm. TSan can miss bugs that only manifest under specific memory orderings on non-x86 hardware. Litmus tests catch these statically.

The benchmark regression gate is often missing in practice and is the most important long-term signal. Lock-free code can silently regress in performance due to: a compiler optimization that changes code generation, a change to an adjacent struct that introduces false sharing, a dependency update that changes allocator behavior. Without a benchmark gate, these regressions are invisible until a production incident.

Bar-raiser signal: in a design review of a new lock-free structure, ask "what is the CI testing plan?" If the answer is "TSan in CI," that is L4. If the answer includes "TSan on x86 and ARM, litmus tests for the core algorithm, and a benchmark regression gate," that is L5. If the answer also includes "property-based tests using Lincheck or a model checker," that is L6.

---
