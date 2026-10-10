## Relacy and TSan for Lock-Free Code

Testing lock-free code with conventional unit tests is insufficient. A bug may manifest only on specific hardware, with specific scheduling, after billions of iterations. Three tools target this gap: ThreadSanitizer (TSan) for runtime race detection, Relacy Race Detector for model checking, and CDSChecker for stateless model checking under the C++ memory model.

### ThreadSanitizer

TSan is a compiler instrumentation pass plus a runtime library. The compiler injects calls into every memory access. The runtime tracks happens-before relations and reports any access pair that is conflicting (same location, at least one write) without a happens-before edge.

```bash
clang++ -fsanitize=thread -g -O1 my_lockfree.cpp -o my_lockfree
./my_lockfree
```

TSan's algorithm is FastTrack (Flanagan-Freund 2009), which uses vector clocks to track the most recent access per thread per location. Memory overhead is roughly 5-10x, runtime overhead is 2-20x.

#### What TSan Catches

Genuine data races. Two threads access the same variable, at least one writes, and the synchronization between them is missing or insufficient.

Mismatched memory orderings. A release that should be acq_rel because the store also reads the prior value is flagged when the absence of acquire causes a missing edge.

Use-after-free in concurrent code. TSan's shadow memory tracks deallocations and flags any access to freed memory.

#### What TSan Misses

TSan only sees executions it actually runs. If your test does not exercise the racy interleaving, TSan does not flag it. This is fundamental to dynamic analysis.

TSan also does not understand C++ memory order subtleties around relaxed atomics. An algorithm that relies on relaxed loads to never observe certain values may pass TSan in practice while being incorrect under the model.

#### TSan and Intentional Races

Many lock-free algorithms perform intentional races on relaxed atomics. The classic example is double-checked locking with a relaxed initial check.

```cpp
std::atomic<bool> initialized{false};
T* shared;

T* get() {
    if (initialized.load(std::memory_order_acquire)) return shared;
    std::lock_guard<std::mutex> lk(init_mutex);
    if (initialized.load(std::memory_order_relaxed)) return shared;
    shared = new T();
    initialized.store(true, std::memory_order_release);
    return shared;
}
```

TSan correctly recognizes this is race-free because the publication uses release/acquire on `initialized`. But certain idioms (sequence-locked reads, statistics counters incremented racily on purpose) trigger false positives.

#### Suppressing TSan False Positives

Use `__tsan_acquire` and `__tsan_release` annotations to manually inform TSan of synchronization that it cannot infer.

```cpp
#include <sanitizer/tsan_interface.h>

void publish(Node* n) {
    __tsan_release(&shared);
    shared.store(n, std::memory_order_relaxed);  // intentional relaxed
}

Node* consume() {
    Node* n = shared.load(std::memory_order_relaxed);
    __tsan_acquire(&shared);
    return n;
}
```

This is dangerous. You are asserting to TSan that synchronization exists when in fact you have only relaxed atomics. If your reasoning is wrong, you have created a real data race that TSan will no longer flag.

A safer pattern is to use `std::atomic_thread_fence` with explicit ordering, which TSan understands natively.

```cpp
void publish(Node* n) {
    std::atomic_thread_fence(std::memory_order_release);
    shared.store(n, std::memory_order_relaxed);
}

Node* consume() {
    Node* n = shared.load(std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_acquire);
    return n;
}
```

Per the C++ standard, a fence-fence synchronization is established when a release fence is followed by a relaxed atomic store, which is read by a relaxed load followed by an acquire fence. TSan models this correctly.

#### Suppression Files

For known-safe races (code you cannot modify), use a suppression file.

```
race:my_legacy_lib::*
race_top:specific_function
```

Suppression files are a last resort. Every entry is a documented exception that future maintainers must understand.

### Relacy Race Detector

Relacy (Dmitry Vyukov, 2008) is a stateless model checker for C++ lock-free code. Unlike TSan, Relacy does not run the program once and observe, it explores all possible interleavings systematically and verifies that each is correct.

The key constraint: your code must be transformed to use Relacy's primitives instead of `std::atomic`. Relacy intercepts every atomic operation to track interleavings.

```cpp
#include <relacy/relacy.hpp>

struct SPSCTest : rl::test_suite<SPSCTest, 2> {
    rl::atomic<int> tail;
    rl::atomic<int> head;
    int             buf[16];

    void before() {
        tail.store(0, rl::mo_relaxed);
        head.store(0, rl::mo_relaxed);
    }

    void thread(unsigned tid) {
        if (tid == 0) {
            int t = tail.load(rl::mo_relaxed);
            buf[t] = 42;
            tail.store(t + 1, rl::mo_release);
        } else {
            while (true) {
                int t = tail.load(rl::mo_acquire);
                int h = head.load(rl::mo_relaxed);
                if (h == t) continue;
                int v = buf[h];
                RL_ASSERT(v == 42);
                head.store(h + 1, rl::mo_release);
                break;
            }
        }
    }
};

int main() {
    rl::test_params p;
    p.search_type = rl::sched_full;
    rl::simulate<SPSCTest>(p);
}
```

Relacy explores every possible scheduling of these two threads under the C++ memory model. If the assertion fails in any execution, Relacy reports the exact interleaving and ordering choices that caused the failure.

#### When Relacy Beats TSan

Relacy explores executions TSan never runs. A bug that requires a specific 12-step interleaving with weak ordering on three different atomics might never manifest in 10^9 TSan runs but Relacy will find it in seconds because it explores all schedules.

Vyukov used Relacy to validate his MPMC queue. The validation found three bugs in widely-cited lock-free queue papers, demonstrating that even peer-reviewed published algorithms can have subtle ordering errors that human review misses.

#### When Relacy Loses

Relacy cannot scale to large code. Its state space grows exponentially with thread count and atomic operation count. Relacy works for verifying primitives (queue with 2-3 threads, 5-10 atomic ops per thread). It cannot verify a full application.

Relacy also requires source modification. You cannot run Relacy on production code unmodified. The standard pattern is to extract the lock-free algorithm into a header that switches between `std::atomic` (production) and `rl::atomic` (Relacy) via macros.

```cpp
#ifdef RELACY_TEST
  #include <relacy/relacy.hpp>
  using std_atomic = rl::atomic;
  #define MO_RELAXED rl::mo_relaxed
  #define MO_ACQUIRE rl::mo_acquire
  #define MO_RELEASE rl::mo_release
#else
  template <typename T> using std_atomic = std::atomic<T>;
  #define MO_RELAXED std::memory_order_relaxed
  #define MO_ACQUIRE std::memory_order_acquire
  #define MO_RELEASE std::memory_order_release
#endif
```

### CDSChecker

CDSChecker (Norris-Demsky 2013, UC Irvine) is a stateless model checker that targets the actual C++11 memory model. Where Relacy uses a slightly simplified model, CDSChecker implements the full axiomatic semantics.

```bash
g++ -std=c++11 -O0 my_test.cc -lcdsmod -o my_test
./run.sh ./my_test
```

CDSChecker hooks `pthread_create` and `std::atomic` operations, exploring schedules under the standard model. It reports the specific axiom violation when an assertion fails: which release-sequence chain failed, which happens-before edge was missing.

CDSChecker is slower than Relacy because it explores more executions (the C++ model permits more behaviors than Relacy's simplified model). For 2 threads with 6 atomics each, CDSChecker takes minutes. Relacy takes seconds.

CDSChecker is the gold standard when you must verify that your code is correct under the actual standard, not a simplified surrogate.

### Putting It Together

Production workflow for new lock-free code:

1. Design the algorithm. Write a paper-style proof or cppmem litmus test for the core ordering properties.

2. Implement and run TSan tests at high contention. TSan catches the easy bugs (missing release/acquire, use-after-free).

3. Extract the core algorithm into a Relacy harness. Run with full schedule exploration. Fix any reported bugs.

4. For algorithms where the C++ model details matter, run a CDSChecker pass. This catches subtleties Relacy misses around release sequences and consume ordering.

5. Run a long-running stress test (hours to days) on production-like hardware. This catches any timing-dependent bug that survived the model checkers.

6. Code review with happens-before annotations on every atomic operation, justifying the chosen memory order.

Each step catches a different class of bug. Skipping any step lets bugs through. Production lock-free code at FAANG goes through all six.

### Senior at FAANG: Stress Test Design

A bad stress test runs N threads doing the same operation in a loop and checks that the final state is consistent. Most bugs do not show up because the threads interleave at coarse granularity.

A good stress test:

- Pins threads to different physical cores to maximize hardware-level race exposure.
- Mixes operations (push and pop, insert and delete) at adjustable ratios.
- Uses CPU pause/yield calls at random points to expand the interleaving space.
- Runs on weakly-ordered hardware (ARM64) in addition to x86. ARM exposes ordering bugs that x86's TSO masks.
- Uses sanitized binaries (TSan + ASan) for the stress run, accepting the slowdown for the bug-finding power.
- Runs for hours, not seconds. Some bugs have a 1-in-10^10 manifestation rate per operation.

Folly's `folly/test/StressTest.h` and Google Abseil's `absl/synchronization/internal/per_thread_sem_test.cc` are good production examples to study.

### Common False Positives

TSan flags atomic init races. Solution: ensure atomics are initialized before any thread can observe them, or use `std::atomic<T>::ATOMIC_VAR_INIT` (deprecated in C++20, use direct initialization).

TSan flags false sharing as data races on adjacent fields. Solution: pad to cache line. The flag itself indicates a real performance problem even though it is not a correctness bug.

TSan flags reads of atomic variables that look mismatched in size. Solution: ensure all accesses to a given atomic use the same operations and orderings.

### Junior to FAANG: Why TSan Alone Is Insufficient

Junior engineers ship code that "passed TSan in CI". This is necessary but not sufficient. TSan only sees the schedules CI happened to run, often with low core counts and warm caches. Production runs at 64+ cores with cold caches in NUMA configurations TSan never visits. Bugs that manifest 1-in-10^8 in production can go undetected by TSan for years.

The right framing: TSan is a smoke test. It catches bugs you would have caught in code review with effort. Relacy and CDSChecker catch bugs that survive code review. Stress testing catches bugs that survive model checking. None of these subsumes the others.
