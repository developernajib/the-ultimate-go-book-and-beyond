## Deadlock and Livelock Detection

A C++ service deadlocks when two threads each hold one lock and wait for the other. A C++ service livelocks when threads make endless small adjustments without making net progress. Both look the same on a dashboard: latency rises, throughput collapses, CPU stays high (livelock) or drops to zero (deadlock). Both have the same root cause: a synchronization design that did not account for an interleaving the developer did not foresee.

This chapter is about catching them in development, in CI, and at runtime in production.

### The Theory: Coffman Conditions

A deadlock requires four conditions. Break any one and you cannot deadlock:

1. **Mutual exclusion.** Locks are exclusive.
2. **Hold-and-wait.** A thread holds one lock while requesting another.
3. **No preemption.** A held lock cannot be forcibly taken.
4. **Circular wait.** Thread A waits for B, B for A.

The most common practical break is condition 4: enforce a total order on lock acquisition. If every thread acquires locks in the same order, there is no cycle, hence no deadlock.

### Lock-Order Graphs

A lock-order graph has a node per mutex and an edge from A to B if any thread acquires B while holding A. If the graph is acyclic, the program is deadlock-free.

The trouble is that the graph is implicit in the code. You have to discover it by static analysis or by runtime instrumentation.

### Abseil's Mutex Deadlock Checker

Abseil's `absl::Mutex` includes a built-in deadlock detector. When debug-build mutex tracking is enabled, every `Lock` call records the (thread, mutex, mutex-stack) tuple. If a new acquisition would create a cycle, abseil aborts with a stack trace pointing at both the current acquisition site and the prior acquisition that created the conflict.

The detector is cheap enough to run in tests, sometimes in CI canary builds, and rarely in production (the bookkeeping cost is non-trivial under heavy lock contention).

```cpp
#include "absl/synchronization/mutex.h"

absl::Mutex a;
absl::Mutex b;

void T1() {
    absl::MutexLock l1(&a);
    absl::MutexLock l2(&b);
}

void T2() {
    absl::MutexLock l1(&b);  // abseil flags this in debug
    absl::MutexLock l2(&a);  // ... because it would create a cycle with T1
}
```

In debug builds, the detector triggers a `LOG(FATAL)` with the lock-order conflict. In production builds, the detector is a no-op.

### Helgrind and DRD

Valgrind's helgrind and DRD tools detect lock-order violations dynamically. They are slow (5x to 20x), so they run in CI, not production. They catch races that ThreadSanitizer does not, particularly around custom synchronization primitives that TSan does not understand.

```bash
$ valgrind --tool=helgrind ./mybin --integration_test
```

For a comprehensive defense, run TSan on every CI build, helgrind on a nightly subset, and abseil's deadlock detector in debug builds and on the SAN canary.

### A Poor-Man's Dynamic Deadlock Detector

If your codebase uses `std::mutex` (not abseil's) and you do not want to switch, you can build a lock-order tracker as a thin wrapper:

```cpp
class TrackedMutex {
    std::mutex m_;
    int order_;  // assigned at construction, total order

public:
    explicit TrackedMutex(int order) : order_(order) {}

    void lock() {
        thread_local std::vector<int> held;
        if (!held.empty() && held.back() >= order_) {
            LOG(FATAL) << "lock-order violation: holding "
                       << held.back() << ", acquiring " << order_;
        }
        m_.lock();
        held.push_back(order_);
    }

    void unlock() {
        thread_local std::vector<int> held;
        m_.unlock();
        held.pop_back();
    }
};
```

The static order is assigned by the developer (or by hash of the mutex's name). Acquisitions strictly in increasing order are safe, out-of-order acquisitions are flagged immediately.

Limitations: works only when locks have a global static order. Reader-writer locks complicate the picture. Conditional waits with locks held are tricky. For most codebases, this 30-line check catches a lot of real bugs.

### Detecting Live Deadlock at Runtime

The detectors above are static or build-time. In production, you sometimes encounter a deadlock that escaped CI. The symptom: zero throughput, threads stuck.

A simple watchdog:

```cpp
class HeartbeatMonitor {
    std::atomic<uint64_t> last_heartbeat_ns_{NowNs()};
public:
    void Heartbeat() { last_heartbeat_ns_.store(NowNs()); }

    void Run() {
        while (!stopping_) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            uint64_t since = NowNs() - last_heartbeat_ns_.load();
            if (since > kDeadThresholdNs) {
                LOG(ERROR) << "service appears deadlocked, dumping stacks";
                DumpAllThreadStacks();
                std::abort();
            }
        }
    }
};
```

The main loop calls `Heartbeat()` periodically. If the heartbeat stops, the watchdog dumps thread stacks (via `pstack`, `eu-stack`, or by sending `SIGQUIT` to the process and letting the JVM... wait, this is C++. By calling `backtrace()` for each thread or using `gdb -p $$ -batch -ex 'thread apply all bt'`).

Crash, restart, and the supervisor brings the service back. A 30-second deadlock turns into a 30-second outage on one replica, not an indefinite outage.

### Livelock

A livelock is harder to spot. Threads are running. CPU is at 100%. Yet net progress is zero. Common causes:

- **Two threads each backing off when the other is busy.** Each constantly retries, neither commits.
- **Adaptive spinning that never escalates.** Threads spin forever because the heuristic never decides to block.
- **Optimistic concurrency control with too many writers.** Every transaction aborts because of conflict, restarts, and aborts again.

Symptoms:

- High CPU, low throughput.
- Many small operations that all roll back.
- Profile shows high time in retry loops.

Detection: instrument the suspected operation with a "successful work done" counter and a "retries" counter. If retries exceed work by a wide ratio, you have livelock.

```cpp
class TransactionMetrics {
    std::atomic<uint64_t> commits_{0};
    std::atomic<uint64_t> aborts_{0};

public:
    void RecordCommit() { commits_.fetch_add(1); }
    void RecordAbort() { aborts_.fetch_add(1); }

    double AbortRatio() const {
        uint64_t c = commits_.load();
        uint64_t a = aborts_.load();
        return c == 0 ? 1.0 : static_cast<double>(a) / (a + c);
    }
};
```

Alert if abort ratio exceeds 50% for a sustained window. The fix is usually to add backoff with jitter, switch to pessimistic locking for hot keys, or shed load.

### Priority Inversion

Priority inversion is a deadlock cousin. A high-priority thread waits on a lock held by a low-priority thread. The low-priority thread cannot run because medium-priority threads are CPU-saturating. The system stalls.

The classic case: the Mars Pathfinder, where a low-priority meteorological data thread held a mutex that a high-priority task needed. Medium-priority comm tasks hogged the CPU. The watchdog reset the spacecraft.

Solutions:

- **Priority inheritance.** The low-priority thread temporarily inherits the high priority while holding the contended lock. POSIX supports this via `PTHREAD_PRIO_INHERIT`.
- **Priority ceiling.** Each lock has a priority, threads holding it run at that priority.
- **Avoid mixed priorities at all.** Use a single thread-pool with FIFO queueing, do not fight scheduler interactions.

For most C++ services, the right answer is the third: do not mix kernel priorities. Use cooperative scheduling within a single priority class. Reserve true priorities for hard real-time, where you have already accepted the complexity.

### Real Postmortem Flavor

A C++ database had two locks, `table_lock` and `cache_lock`. The convention was to acquire them in alphabetical order. One developer wrote a code path that held `cache_lock` and called a helper that acquired `table_lock`. In test, the helper was never called from that path. In production, a rare query type triggered it. The deadlock fired once per million queries, but with thousands of concurrent connections, the deadlocked threads accumulated, exhausted the connection pool, and the service stalled.

The bug had passed every test. The lock-order checker (added after this incident) flagged it on the first run.

The team adopted abseil mutexes and turned on the deadlock detector in debug builds. Subsequent lock-order bugs were found at unit-test time, not at 3 AM.

### Senior at FAANG: The Layered Defense

The senior approach is layered:

1. Lock-order convention documented in the codebase.
2. Lock-order checker (abseil's or custom) in debug builds.
3. TSan and helgrind in CI.
4. Heartbeat watchdog at runtime.
5. Postmortem discipline that surfaces every observed deadlock as a learning.

No single layer catches everything. The combination catches almost everything.

---
