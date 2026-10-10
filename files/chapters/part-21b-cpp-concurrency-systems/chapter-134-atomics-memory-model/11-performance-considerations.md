## Performance Considerations

### Cost of Atomic Operations by Architecture

On x86-64:

```
Plain load/store:           ~1 cycle
Atomic load (any order):    ~1 cycle (x86 loads are inherently acquire)
Atomic store (relaxed):     ~1 cycle
Atomic store (release):     ~1 cycle (x86 stores are inherently release-ish)
Atomic store (seq_cst):     ~20-40 cycles (requires MFENCE or LOCK XCHG)
Atomic RMW (fetch_add):     ~10-40 cycles (LOCK prefix)
Contended atomic RMW:       ~100-500 cycles (cache line bouncing)
```

On ARMv8:

```
Plain load/store:           ~1 cycle
Atomic load (relaxed):      ~1 cycle (plain LDR)
Atomic load (acquire):      ~1-5 cycles (LDAR)
Atomic store (relaxed):     ~1 cycle (plain STR)
Atomic store (release):     ~1-5 cycles (STLR)
Atomic store (seq_cst):     ~20-50 cycles (STLR + DMB ISH)
Atomic RMW (fetch_add):     ~10-20 cycles (LDXR/STXR loop)
Contended atomic RMW:       ~100-1000 cycles (LL/SC retry storms)
```

The takeaway: on x86, the big cost is `seq_cst` stores and contended RMW operations. On ARM, even acquire/release has measurable cost. On both architectures, the dominant cost under contention is cache line bouncing, not the barrier instructions.

### Reducing Contention

Cache line bouncing, where multiple cores repeatedly invalidate each other's cached copy of the same 64-byte line, is the primary reason contended atomics are orders of magnitude slower than uncontended ones. The most effective mitigation is to reduce the frequency of shared writes: accumulate updates in thread-local or local variables and flush to the global atomic in a single operation at the end of a batch. For read-heavy workloads, caching the last observed value in a `thread_local` and refreshing it only periodically converts what would be thousands of acquire loads per second into a handful, eliminating cross-core coherence traffic on the hot path entirely.

```cpp
// Pattern 1: Batch updates
// Instead of incrementing a shared counter per-item, batch locally
void process_batch(std::atomic<int64_t>& global_count,
                   const std::vector<Item>& items) {
    int64_t local_count = 0;
    for (const auto& item : items) {
        process(item);
        ++local_count; // Local increment - no atomic needed
    }
    // One atomic operation instead of N
    global_count.fetch_add(local_count, std::memory_order_relaxed);
}

// Pattern 2: Thread-local accumulation (shown in DistributedCounter above)

// Pattern 3: Read-mostly optimization
// Use a local cache that is periodically refreshed from the atomic
void reader_hot_path(const std::atomic<Config*>& global_config) {
    thread_local Config* cached = nullptr;
    thread_local int reads_since_refresh = 0;

    if (++reads_since_refresh > 1000 || !cached) {
        cached = global_config.load(std::memory_order_acquire);
        reads_since_refresh = 0;
    }
    // Use cached config - no atomic load on the hot path
    use_config(cached);
}
```

### Junior → FAANG: Performance Thinking for Atomic Operations

The junior mindset: "atomics are faster than mutexes." The nuanced truth: atomics are faster than mutexes in the uncontended case and at low thread counts. Under high contention (many threads CAS-ing the same variable), atomics can be slower than a well-designed mutex due to CAS retry storms.

The performance rule of thumb: a `fetch_add` with seq_cst on a hot counter shared by 64 threads is the worst-case scenario for an atomic. On a 2-socket x86 server, this can serialize to ~10ns per operation due to cache coherence traffic. A sharded counter (one counter per thread, aggregated on read) scales linearly.

First-job habit: whenever you add an `std::atomic` to a hot path, add a Google Benchmark or Criterion benchmark that measures it at 1, 8, 32, and 64 threads. The performance cliff at high concurrency is not visible at low thread counts.

### Senior @ FAANG: Atomic Performance Budgeting in System Design

At L5+, atomic performance is a budget item in a system's latency allocation. A request handler with a p99 budget of 1ms cannot spend 200ns on atomic operations in the critical path without explicit justification.

The senior practice: build a perf model during design. List every atomic operation in the critical path. Assign a per-operation cost (from architecture-specific benchmarks). Sum them. If the sum is more than 10% of the latency budget, redesign. Common redesign patterns: read-copy-update for read-mostly data, per-CPU caches for write-heavy counters, epoch-based batching for high-frequency flags.

The caching pattern shown in this file (caching the result of an atomic load in a local variable on the hot path) is the single most impactful optimization for read-heavy atomics. It reduces the number of atomic operations from one-per-call to one-per-epoch. Implementing this pattern correctly requires understanding the consistency model: the cached value may be stale by at most one epoch, and the code must be correct with that staleness.

Platform-specific consideration: on ARM Graviton3 (AWS), `memory_order_seq_cst` loads are implemented with LDAR instructions that prevent out-of-order execution of all subsequent loads. This makes seq_cst loads measurably more expensive than on x86. A C++ service migrating from x86 to Graviton must re-benchmark all hot-path atomics.

---
