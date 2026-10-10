## Epoch-Based Reclamation (EBR)

EBR was introduced by Keir Fraser in his 2004 PhD thesis and refined in the crossbeam-epoch crate (Aaron Turon, 2015). The idea is opposite to hazard pointers. Instead of each thread publishing the addresses it protects, each thread publishes the time interval during which it is reading. The reclaimer waits until all threads have left an interval, then frees everything retired during it.

### The Algorithm

A global epoch counter increments periodically (every retire, or every N retires). Each thread has a per-thread epoch slot containing either "inactive" or the epoch the thread entered. A reader pins the current epoch on entry, performs its lock-free reads, and unpins on exit.

To safely free a retired node, you observe that all active readers are in epoch e or e-1 or e+1 (epochs differ by at most one because the global counter advances only when no thread lags). Memory retired in epoch e becomes safe to free in epoch e+2.

```cpp
constexpr int kBuckets = 3;

struct Domain {
    std::atomic<uint64_t> epoch{0};
    std::vector<std::atomic<uint64_t>> thread_epochs;
    std::array<std::vector<std::pair<void*, void(*)(void*)>>, kBuckets> retired;
    std::mutex retired_mu;
};
```

A thread_epoch of 0 means inactive. Otherwise the value encodes the epoch the thread is pinned to.

```cpp
class Guard {
    Domain& d_;
    size_t  tid_;
public:
    Guard(Domain& d, size_t tid) : d_(d), tid_(tid) {
        uint64_t e = d_.epoch.load(std::memory_order_acquire);
        d_.thread_epochs[tid_].store(e, std::memory_order_seq_cst);
    }
    ~Guard() {
        d_.thread_epochs[tid_].store(0, std::memory_order_release);
    }
    uint64_t epoch() const { return d_.thread_epochs[tid_].load(std::memory_order_relaxed); }
};
```

The seq_cst store on entry is what creates the synchronization with the reclaimer. The reclaimer issues a seq_cst fence and reads all thread_epochs. Any thread that observed an old global epoch must have published its old pin before the fence, which means the reclaimer sees it.

### Advancing the Epoch

```cpp
bool try_advance(Domain& d) {
    uint64_t cur = d.epoch.load(std::memory_order_acquire);
    std::atomic_thread_fence(std::memory_order_seq_cst);
    for (auto& te : d.thread_epochs) {
        uint64_t e = te.load(std::memory_order_acquire);
        if (e != 0 && e != cur) return false;
    }
    return d.epoch.compare_exchange_strong(cur, cur + 1,
        std::memory_order_acq_rel, std::memory_order_relaxed);
}
```

If every active thread is at the current epoch (or inactive), it is safe to advance. Crossbeam advances probabilistically (1 in N retires) to amortize the scan cost.

### Retire and Collect

```cpp
template <typename T>
void retire(Domain& d, T* p) {
    uint64_t e = d.epoch.load(std::memory_order_acquire);
    std::lock_guard<std::mutex> lk(d.retired_mu);
    d.retired[e % kBuckets].emplace_back(p, [](void* x){ delete static_cast<T*>(x); });
}

void collect(Domain& d) {
    if (!try_advance(d)) return;
    uint64_t e = d.epoch.load(std::memory_order_acquire);
    size_t safe_bucket = (e + 1) % kBuckets;
    std::vector<std::pair<void*, void(*)(void*)>> drained;
    {
        std::lock_guard<std::mutex> lk(d.retired_mu);
        drained.swap(d.retired[safe_bucket]);
    }
    for (auto& [ptr, del] : drained) del(ptr);
}
```

Three buckets are enough because the epoch skew between readers and the reclaimer is bounded by one. Bucket e+1 (mod 3) holds nodes retired two epochs ago, which all readers have passed.

### Per-Thread Retire Lists

The mutex-protected global retire list is a bottleneck. Crossbeam and folly use thread-local retire bags that flush to the global list in batches.

```cpp
thread_local std::vector<std::pair<void*, void(*)(void*)>> tls_bag;
thread_local uint64_t tls_bag_epoch = 0;

template <typename T>
void retire_local(Domain& d, T* p) {
    uint64_t e = d.epoch.load(std::memory_order_relaxed);
    if (e != tls_bag_epoch && !tls_bag.empty()) flush_bag(d);
    tls_bag_epoch = e;
    tls_bag.emplace_back(p, [](void* x){ delete static_cast<T*>(x); });
    if (tls_bag.size() >= 64) flush_bag(d);
}
```

### EBR Versus Hazard Pointers

| Property | EBR | Hazard Pointers |
| --- | --- | --- |
| Read overhead | One relaxed/acquire load + one seq_cst store on pin enter | One acquire load, one seq_cst store, one validating acquire load per protected pointer |
| Worst-case memory | Unbounded if a thread parks while pinned | Bounded by H*P + retired threshold |
| Code complexity | Pin/unpin only | Per-pointer protect with retry |
| Throughput under low contention | Higher (one fence covers many reads) | Lower (per-pointer fence) |
| Throughput when threads stall | Collapses (no advancement) | Robust |

EBR wins when readers traverse many pointers per pin. A skip list lookup touches log N nodes, which under hazard pointers means log N protect calls. Under EBR it is a single pin.

EBR loses when a thread can stall arbitrarily inside a critical region (oversubscribed cores, blocking syscalls, debugger breakpoints). The reclaimer cannot advance, retired memory accumulates, and the process eventually OOMs. Hazard pointers degrade gracefully in that case because each stalled thread only blocks reclamation of the specific pointers in its slots.

### Senior at FAANG: Folly's epoch_holder

Folly does not ship a pure EBR. It ships `folly::synchronization::epoch` and `RcuToken` as part of its RCU infrastructure (covered in the next section), which is EBR with stronger guarantees. The closest pure EBR primitive in production C++ is in DPDK (`rte_rcu_qsbr`) and in ScyllaDB's `seastar::rcu`.

The `epoch_holder` pattern looks like this in production:

```cpp
template <typename Func>
auto with_pin(Domain& d, Func&& f) {
    Guard g(d, current_tid());
    return std::forward<Func>(f)();
}

int lookup(Map& m, int key) {
    return with_pin(m.domain, [&] {
        Node* n = m.head.load(std::memory_order_acquire);
        while (n && n->key != key) n = n->next.load(std::memory_order_acquire);
        return n ? n->value : -1;
    });
}
```

The lambda runs entirely inside the pin. No allocations, no syscalls, no blocking. Production code enforces this with linters because a single yield inside a pin can stall reclamation across the process.

### Crossbeam-epoch Design Ported to C++

Crossbeam's design has three innovations worth porting.

**Garbage bags.** A retired item is a `Garbage` with a destructor stored as a function pointer. Bags are arrays of 64 garbages. Local bags flush to a global queue when full.

**Pin counter.** A thread that re-pins while already pinned increments a counter rather than re-publishing. This makes nested pins free.

```cpp
struct LocalEpoch {
    Domain* domain;
    size_t  tid;
    uint32_t pin_count = 0;

    void pin() {
        if (pin_count++ == 0) {
            uint64_t e = domain->epoch.load(std::memory_order_relaxed);
            domain->thread_epochs[tid].store(e | 1, std::memory_order_seq_cst);
        }
    }
    void unpin() {
        if (--pin_count == 0) {
            domain->thread_epochs[tid].store(0, std::memory_order_release);
        }
    }
};
```

The low bit on the published epoch encodes "pinned". The reclaimer treats any odd value as active.

**Probabilistic advancement.** Every 128 retires, a thread tries to advance the epoch. This keeps the advancement cost amortized at O(1) per retire while bounding memory at O(retires per epoch period).

```cpp
void maybe_advance(Domain& d) {
    thread_local uint32_t counter = 0;
    if ((++counter & 127) == 0) try_advance(d);
}
```

### Cost in Cycles

On a Skylake-X with 32 threads:
- Pin enter (uncontended): 12-18 cycles (one seq_cst store).
- Pin exit: 4-6 cycles (one release store).
- Retire (local bag, no flush): 8-12 cycles.
- Retire (with flush, no advance): 200-400 cycles.
- Retire (with advance, scan 32 thread epochs): 600-1200 cycles.

Hazard pointers on the same machine cost 25-35 cycles per protect, so for traversals over 3 or more pointers EBR wins on read latency.

### Failure Modes

A pin held across a `co_await`, `pthread_cond_wait`, or any blocking call is a bug. The thread becomes unschedulable for the reclaimer's purposes. Production systems detect this with a watchdog that scans thread_epochs every second and logs any thread pinned for more than a configured threshold.

A pin held during memory allocation is also a bug if the allocator can take a slow path that yields. tcmalloc and jemalloc do not yield in the fast path, but they do call mmap on slow paths. Production code allocates outside the pin and only links in once allocated.
