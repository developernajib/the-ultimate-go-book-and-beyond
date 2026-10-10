## Intel TSX and Hardware Transactional Memory

Hardware Transactional Memory promised lock-free programming for the masses. Intel TSX shipped, was disabled, was re-enabled, was deprecated, and finally re-emerged in restricted form. This file covers the history, the mechanics, the lessons, and where HTM stands on current hardware.

### The Dream

Take any critical section. Wrap it in a hardware transaction. The CPU speculatively executes, tracks reads and writes in a buffer, and commits atomically if no conflict occurred. If conflict, it aborts and falls back to a regular lock. Programmers get lock-like semantics with optimistic concurrency cost.

Two interfaces were exposed by Intel TSX-NI (Transactional Synchronization Extensions, New Instructions):

**HLE (Hardware Lock Elision)**: legacy-compatible. Add `XACQUIRE` and `XRELEASE` prefix bytes to existing locked instructions. Old CPUs ignore the prefix. New CPUs treat the prefixed lock as a transaction. The lock variable is read but not written. If transaction succeeds, the lock appears unmodified.

**RTM (Restricted Transactional Memory)**: explicit. New instructions `XBEGIN`, `XEND`, `XABORT`, `XTEST`. The programmer wraps a transaction explicitly with a fallback path.

```c
unsigned status = _xbegin();
if (status == _XBEGIN_STARTED) {
    if (lock_held) _xabort(0xff);
    // critical section
    _xend();
} else {
    // fall back to taking the lock
    take_lock();
    // critical section
    release_lock();
}
```

### Abort Reasons

Transactions abort for many reasons. The status code from `_xbegin()` after abort encodes them:

- `_XABORT_EXPLICIT`: software called `_xabort`. Status includes user code.
- `_XABORT_RETRY`: hardware suggests retry may succeed.
- `_XABORT_CONFLICT`: another core touched a cache line in the read or write set.
- `_XABORT_CAPACITY`: read or write set exceeded buffer (typically L1 cache size, ~32KB).
- `_XABORT_DEBUG`: debug breakpoint hit.
- `_XABORT_NESTED`: nested transaction inside a non-transactional region.

The most painful aborts are spurious or environmental:

- Page faults abort transactions. First touch of a page inside a transaction is doomed.
- TLB shootdowns abort.
- Interrupts and context switches abort.
- Hardware prefetchers can pull cache lines that bloat the read set.
- Cache line eviction by SMT sibling thread can abort.
- System Management Interrupts (SMIs) abort and have firmware-determined frequency.

A non-trivial fraction of well-formed transactions abort for reasons unrelated to actual conflicts. Production HTM code must have a robust fallback path that eventually takes a real lock.

### HTM-Elided Spinlocks

The canonical use case: a spinlock where most acquisitions do not actually conflict.

```cpp
struct elided_spinlock {
    std::atomic<int> locked{0};

    void lock() {
        for (int retries = 0; retries < 3; ++retries) {
            unsigned status = _xbegin();
            if (status == _XBEGIN_STARTED) {
                if (locked.load(std::memory_order_relaxed) == 0) {
                    return;          // elided, no actual lock taken
                }
                _xabort(0xff);
            }
            if (status & _XABORT_EXPLICIT) break;
            if (!(status & _XABORT_RETRY)) break;
        }
        // fallback
        while (locked.exchange(1, std::memory_order_acquire)) {
            while (locked.load(std::memory_order_relaxed)) cpu_pause();
        }
    }

    void unlock() {
        if (locked.load(std::memory_order_relaxed) == 0 && _xtest()) {
            _xend();
        } else {
            locked.store(0, std::memory_order_release);
        }
    }
};
```

The trick: every "transaction" reads `locked` (added to the read set) and verifies it is 0. Two threads that do not actually modify shared state can both run their critical sections concurrently, each in a transaction. If either thread modifies a memory location the other reads, the conflict aborts both, falling back to the real lock.

### The Deprecation History

**2013**: Intel ships TSX in Haswell. Erratum HSD136 disables TSX in microcode for almost all SKUs after a hang bug is found.

**2014-2015**: Intel ships TSX in Broadwell with fewer issues. Some workloads see 2-3x speedups.

**2017**: Skylake-SP and Cascade Lake ship with TSX enabled.

**2019**: TAA (TSX Async Abort) side-channel vulnerability discovered. Intel mitigates by disabling TSX in microcode on most Skylake-X, Cascade Lake, and earlier parts. Workloads relying on TSX silently lose 2-3x performance.

**2021**: Ice Lake ships with TSX enabled but with mitigations that reduce its benefit.

**2022**: Sapphire Rapids ships with TSX deprecated. Intel announces TSX will be removed from future client CPUs.

**2023+**: TSX remains in Xeon Scalable but Intel guidance is "do not write new code depending on it".

The deprecation reasoning: HTM has narrow benefit (workloads with low contention, large enough to amortize the transaction overhead but small enough to fit in L1), the side-channel risk recurs, and software lock-free / RCU patterns close the gap.

### ARM TME

ARM's Transactional Memory Extension was announced in 2019 as part of ARMv8.5. It is similar in spirit to RTM:

- `tstart` begins a transaction, returns status in a register.
- `tcommit` commits.
- `tcancel` explicitly aborts with a code.
- `ttest` checks if currently in a transaction.

ARM TME is conservative: it requires a software fallback, abort handling, no nested commits, and limits the transactional footprint. Implementations are scarce. As of 2026, mainstream ARM cores (Apple M-series, Qualcomm Oryon, AWS Graviton 3 and 4) do not implement TME. ARM has not pushed it.

### Lessons Learned

1. **Footprint is real**. Transactions abort once the read+write set exceeds L1. Hot-cold separation matters more than for non-HTM code.

2. **Speculative execution channels**. TAA showed that HTM creates new side channels. Any future HTM design must be analyzed for speculative leaks from the start.

3. **Software lock-free won**. By the time HTM matured, RCU, hazard pointers, and seqlocks covered the workloads HTM targeted. The marginal benefit of HTM over good lock-free design is small.

4. **Fallback paths are unforgiving**. The fallback must take the same logical lock the transaction used as a guard, or the transaction-fallback combination violates serializability.

5. **Microbenchmarks lie**. HTM benchmarks under low contention show 2-3x speedup. Real workloads with mixed contention, page faults, and OS interrupts show 0-20%, with abort-induced tail latency spikes.

### Software Transactional Memory

If hardware TM is gone, what about software TM? STM has been researched since the 90s. Implementations exist (Haskell STM, Clojure refs, GCC libitm). The cost in production C++ is generally too high (10-100x for short transactions, due to per-access logging) for it to displace mutexes or lock-free.

Some narrow uses survive: GCC's libitm can be useful for very rare critical sections in legacy code where you need the composability of TM. But STM is not a general replacement for locks in modern C++.

### What Replaces HTM

HTM-shaped problems are addressed by:

- **RCU and EBR**: For read-mostly data structures, readers pay zero atomic ops.
- **Per-CPU data**: Use `__thread` or `thread_local` and aggregate at read time.
- **Sharded locks**: Many small locks instead of one. Avoids contention without HTM.
- **Lock-free data structures**: Treiber stack, Michael-Scott queue, hazard pointers.
- **Optimistic concurrency in software**: Sequence locks, version counters with CAS retry.

Each of these is a more reliable path to scalability than HTM in practice.

### The Future of HTM

ARM TME may yet ship at scale. RISC-V is exploring its own TM extension. Intel may revisit HTM after side-channel concerns are addressed at the architectural level. None of these will be mainstream-targetable for 5+ years.

For new code in 2026, write lock-free or use scalable locks. If you have legacy TSX code on Xeon Scalable, keep it but plan to retire it.

### Junior at FAANG vs Senior at FAANG

Junior reads about TSX, gets excited, prototypes lock elision in a hot path, sees 2x speedup on benchmark, ships. Production traffic surfaces TAA mitigation rollouts that disable TSX on the fleet, latency regresses 30%, the team scrambles to remove TSX. Senior knows TSX is deprecated, evaluates RCU and sharded locks first, only considers HTM for legacy maintenance not new code, and always has a non-HTM fallback path that performs acceptably standalone.
