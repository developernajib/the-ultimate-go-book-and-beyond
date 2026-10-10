## Lock Contention Profiling

A scalable C++ service does not necessarily run lock-free. It does, however, know exactly which locks it holds, for how long, and how often threads wait. Contention is invisible in IPC and CPU use, it shows up only in throughput plateaus and p99 spikes.

### perf lock

```bash
sudo perf lock record -- ./binary
sudo perf lock report --sort=wait_max
sudo perf lock contention --threads
```

Output (excerpt):

```
contended   total wait  max wait   avg wait    type   caller
1283         512 ms     34 ms      0.4 ms    mutex   PostingsCache::lookup+0x1c
974          203 ms      8 ms      0.2 ms    mutex   StatsAggregator::record+0x4a
22             0.3 ms    0.1 ms    0.014 ms  rwlock  Config::read_snapshot+0x80
```

Sort by `max wait` to find tail-latency offenders. By `total wait` to find throughput-killers.

### perf sched and futex tracing

```bash
sudo perf sched record -- ./binary
sudo perf sched latency
sudo perf sched timehist
```

`perf sched latency` shows per-thread runqueue wait time. Threads sitting in `D` (uninterruptible) may be waiting on futex (mutex), I/O, or page faults.

```bash
sudo perf trace -e 'syscalls:sys_enter_futex' -p <pid>
# or BCC tools:
sudo /usr/share/bcc/tools/funccount 'futex_*'
sudo /usr/share/bcc/tools/offcputime -p <pid>   # who blocks where
sudo /usr/share/bcc/tools/wakeuptime -p <pid>   # who wakes them
```

`offcputime` is the killer tool. It captures stacks at the moment a thread blocks, with the time blocked. Lock contention shows up as stacks ending in `futex_wait`/`__pthread_mutex_lock`.

### Mutex Types

`std::mutex` on Linux is a futex-based mutex with adaptive spinning. The fast path (uncontended) is a single CAS, ~10 ns. Contended path enters kernel via `futex()` syscall, costs ~1 to 5 microseconds.

`pthread_mutex_t` with `PTHREAD_MUTEX_ADAPTIVE_NP` spins briefly before going to kernel. Better when contention is short.

```cpp
pthread_mutexattr_t a;
pthread_mutexattr_init(&a);
pthread_mutexattr_settype(&a, PTHREAD_MUTEX_ADAPTIVE_NP);
pthread_mutex_t m;
pthread_mutex_init(&m, &a);
```

`absl::Mutex` is Google's adaptive mutex with deadlock detection (debug builds), priority inheritance, and a richer API (`AssertHeld`, `Await(Condition)`).

`folly::DistributedMutex`: 1 byte, NUMA-aware, fairness through MCS. Used in Meta services where mutex memory matters.

`folly::PicoSpinLock`: 1 bit. Use only when contention is rare.

### Spinlocks: pause vs sched_yield

```cpp
// Bad: yield on every iteration causes scheduler ping-pong
while (locked.exchange(true, std::memory_order_acquire))
    std::this_thread::yield();

// Better: pause first, yield after a budget
class Spin {
    std::atomic_flag f = ATOMIC_FLAG_INIT;
public:
    void lock() noexcept {
        for (int spin = 0; ; ) {
            if (!f.test_and_set(std::memory_order_acquire)) return;
            for (int i = 0; i < (1 << spin); ++i) _mm_pause();  // PAUSE
            if (spin < 8) ++spin;
            else { sched_yield(); spin = 0; }
        }
    }
    void unlock() noexcept { f.clear(std::memory_order_release); }
};
```

`_mm_pause()` (PAUSE instruction) hints the CPU that this is a spin-wait, releases pipeline resources to the SMT sibling, and on Skylake+ delays for ~140 cycles (significantly more than older uarches). Without PAUSE, a busy spin starves the other hyperthread.

`sched_yield()` is heavy and can deschedule onto a different core (cache-cold). Use sparingly, after a real spin budget.

### Lock-Free Counterparts

Lock-free is not always faster. Lock-free atomics on a hot line cause coherence storms (every CAS invalidates other cores' copies). Measure both.

Patterns that beat naive mutexes:

- Per-thread counters, summed at read time
- Striped maps (one mutex per N buckets)
- RCU read-side (zero atomic ops on read)
- MCS / CLH locks (queue-based, eliminate cache-line bouncing on the lock)
- Sequence locks (writer increments seq, reader retries on mismatch)

```cpp
// Per-thread counter pattern
struct Counter {
    static thread_local uint64_t local;
    static std::array<std::atomic<uint64_t>*, 256> all;
    void incr() noexcept { local++; }
    static uint64_t read() {
        uint64_t s = 0;
        for (auto* p : all) if (p) s += p->load(std::memory_order_relaxed);
        return s;
    }
};
```

Hot path: one local increment, no atomic, no contention. Read path: O(threads), called by the rare metrics scrape.

### ParkingLot and Adaptive Wait

Webkit's ParkingLot, also adopted in Rust's `parking_lot` crate and folly's `MicroLock`, decouples the lock state from the wait queue. The lock can be a single byte or even one bit, the queue lives in a separate hash table keyed by address. Memory cost: 1 byte per lock instead of ~40 bytes for a `std::mutex`.

C++ does not standardize this yet. Build it from `std::atomic`, `futex` (Linux), and a global parking hash table.

### Reader-Writer Locks

Use only when reads vastly outnumber writes (10:1 or more). Otherwise the bookkeeping overhead beats the parallelism win.

`std::shared_mutex`: heavyweight. `folly::SharedMutex`: lighter, NUMA-aware. `boost::shared_mutex`: portable, intermediate.

For read-mostly access, RCU or seqlock often dominates rwlock.

```cpp
// Seqlock
struct Seqlock {
    std::atomic<uint64_t> seq{0};
};
template <class T>
T read(const Seqlock& sl, const T* data) {
    while (true) {
        uint64_t s1 = sl.seq.load(std::memory_order_acquire);
        if (s1 & 1) continue;        // writer in progress
        T copy = *data;
        std::atomic_thread_fence(std::memory_order_acquire);
        uint64_t s2 = sl.seq.load(std::memory_order_relaxed);
        if (s1 == s2) return copy;
    }
}
template <class T>
void write(Seqlock& sl, T* data, const T& v) {
    sl.seq.fetch_add(1, std::memory_order_acq_rel);
    *data = v;
    sl.seq.fetch_add(1, std::memory_order_release);
}
```

Reader pays only loads. Writer must be exclusive (one writer at a time, enforced separately).

### Diagnosing in Production

A latency spike correlated with thread count rising and CPU below 100% almost always means lock contention. Steps:

1. `perf top` while the spike is happening, look for `__pthread_mutex_lock` or `futex`.
2. `offcputime` for stack-traced wait times.
3. `perf lock contention --threads` for per-mutex breakdown.
4. eBPF script for histogram of wait times per lock address (advanced).

```bash
# Quick offcpu profile, 10s
sudo /usr/share/bcc/tools/offcputime -df -p $(pgrep myapp) 10 > stacks.txt
# Render flamegraph
~/FlameGraph/flamegraph.pl --color=io stacks.txt > offcpu.svg
```

The flamegraph reveals which call chain leads into the wait, often a single offending function.

### Real Example: Hot Counter

A serving binary at 50 K QPS used `std::atomic<uint64_t>` request counters, ~12 of them, all in one `Stats` struct. p99 latency 22 ms.

`perf c2c`: top HITM events on the cache line containing 4 of the counters. Cores were ping-ponging on writes.

Fix: per-thread counters with a 64-byte aligned struct. After: p99 dropped to 6 ms. No other change. The atomics were not even contended in the lock sense, just cache-line shared.

### Junior to FAANG callout

The default `std::mutex` is fine for 99% of code. The other 1% is your hot path. For that 1%: measure, do not assume. Lock-free is harder to write, easier to break, and not always faster. Always benchmark the alternative.

### Senior at FAANG callout

A service at scale has a contention budget. Above ~200 ns of average wait per request the user sees it. Track lock contention as a SLO metric. Add lock-instrumentation in debug builds, sampled in release. Know which mutexes your hot path touches and what their wait-time distributions look like under load.

### Tooling cheat sheet

| Tool | Use |
|------|-----|
| perf lock | per-mutex aggregates |
| perf sched / timehist | thread state visualization |
| BCC offcputime | who blocks, where, for how long |
| BCC funclatency | latency histogram of any function |
| eBPF custom | per-lock-address contention |
| absl::MutexLockHolder w/ timing | application-level instrumentation |
| folly::Synchronized | typed mutex wrapper that prevents bugs |
