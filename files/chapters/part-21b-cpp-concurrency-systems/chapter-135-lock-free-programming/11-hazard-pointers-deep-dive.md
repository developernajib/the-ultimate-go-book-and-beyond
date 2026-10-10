## Hazard Pointers Deep Dive

Maged Michael's 2004 paper "Hazard Pointers: Safe Memory Reclamation for Lock-Free Objects" solved the fundamental problem in lock-free code that uses dynamic memory. A reader holds a pointer to a node, the node is unlinked by another thread, and a third thread frees it before the reader dereferences. The reader segfaults or reads garbage. Hazard pointers (HPs) let each thread publish the addresses it is currently dereferencing so other threads cannot reclaim them.

### The Core Algorithm

Each thread owns a fixed number of hazard pointer slots (typically one or two per algorithm). A slot is a single-writer, multi-reader atomic pointer. To safely access a node:

1. Read the shared pointer.
2. Publish it into your hazard slot with `memory_order_seq_cst` (or release plus an acquire fence on the reclaimer).
3. Re-read the shared pointer. If it changed, retry.
4. Dereference. The validation step proves the node was still reachable when you announced your interest.

To retire a node, push it onto a thread-local retired list. When the list reaches a threshold (typically `2 * H * P` where `H` is HPs per thread and `P` is thread count), run a scan: snapshot all hazard pointers across all threads into a hash set, then free any retired node not in the set.

```cpp
template <typename T>
class HazardSlot {
    std::atomic<T*> ptr_{nullptr};
public:
    T* protect(std::atomic<T*>& src) {
        T* p;
        do {
            p = src.load(std::memory_order_acquire);
            ptr_.store(p, std::memory_order_seq_cst);
        } while (p != src.load(std::memory_order_acquire));
        return p;
    }
    void clear() { ptr_.store(nullptr, std::memory_order_release); }
    T* raw() const { return ptr_.load(std::memory_order_acquire); }
};
```

The seq_cst store on line 6 plus an seq_cst fence in the retiring thread is what makes the protocol correct. Without sequential consistency between the announce and the reclaimer's read, a reader can publish a hazard, the reclaimer can miss it, and the node can be freed under the reader. Michael's paper proves this with the IRIW (Independent Reads of Independent Writes) lemma.

### ABI-Stable Record List

Production systems (folly, Facebook's TAO, ScyllaDB) use a global linked list of hazard records. Each record contains an active flag and the hazard slot. Threads acquire records on first use and never release them, which avoids the registration race entirely.

```cpp
struct HazardRecord {
    std::atomic<HazardRecord*> next;
    std::atomic<bool> active;
    std::atomic<void*> hazard;
};

class HazardDomain {
    std::atomic<HazardRecord*> head_{nullptr};
    std::atomic<size_t> count_{0};
public:
    HazardRecord* acquire() {
        for (auto* r = head_.load(std::memory_order_acquire); r; r = r->next.load(std::memory_order_acquire)) {
            bool expected = false;
            if (!r->active.load(std::memory_order_relaxed) &&
                r->active.compare_exchange_strong(expected, true)) {
                return r;
            }
        }
        auto* fresh = new HazardRecord{nullptr, {true}, {nullptr}};
        auto* old = head_.load(std::memory_order_relaxed);
        do {
            fresh->next.store(old, std::memory_order_relaxed);
        } while (!head_.compare_exchange_weak(old, fresh,
                    std::memory_order_release, std::memory_order_relaxed));
        count_.fetch_add(1, std::memory_order_relaxed);
        return fresh;
    }
    void release(HazardRecord* r) {
        r->hazard.store(nullptr, std::memory_order_release);
        r->active.store(false, std::memory_order_release);
    }
};
```

The list grows monotonically. A thread exits, marks its record inactive, and the next thread to enter reuses the slot. Memory is never freed for the record itself. This avoids the chicken-and-egg problem of reclaiming hazard records with hazard pointers.

### Retire and Scan

```cpp
struct Retired {
    void* ptr;
    void (*deleter)(void*);
    Retired* next;
};

thread_local Retired* tls_retired_head = nullptr;
thread_local size_t   tls_retired_count = 0;

template <typename T>
void retire(T* p) {
    auto* r = new Retired{p, [](void* x){ delete static_cast<T*>(x); }, tls_retired_head};
    tls_retired_head = r;
    if (++tls_retired_count >= kScanThreshold) scan();
}

void scan() {
    std::unordered_set<void*> hazards;
    hazards.reserve(64);
    std::atomic_thread_fence(std::memory_order_seq_cst);
    for (auto* r = domain.head_.load(std::memory_order_acquire); r; r = r->next.load(std::memory_order_acquire)) {
        if (void* h = r->hazard.load(std::memory_order_acquire)) hazards.insert(h);
    }
    Retired** prev = &tls_retired_head;
    Retired*  cur  = tls_retired_head;
    size_t kept = 0;
    while (cur) {
        if (hazards.count(cur->ptr)) {
            prev = &cur->next; cur = cur->next; ++kept;
        } else {
            Retired* dead = cur;
            *prev = cur->next; cur = cur->next;
            dead->deleter(dead->ptr);
            delete dead;
        }
    }
    tls_retired_count = kept;
}
```

The seq_cst fence before snapshotting hazards is the cumulative fence. It pairs with the seq_cst store inside `protect`. After the fence, any hazard published before the unlink is visible. Any hazard published after the unlink read a different shared pointer and will retry.

### Junior to FAANG: Why the Validation Re-Read Matters

A junior implementation does load, store hazard, dereference. That is broken. Between the load and the store, another thread can unlink and retire. The hazard slot publishes a pointer that no longer protects anything because the pointer is already on a retired list. A FAANG implementation re-reads the source after publishing. If the source changed, the publish is meaningless and the loop retries. This re-read is the entire reason hazard pointers work.

### std::experimental::hazard_pointer (P1121)

P1121R3 (Maged Michael, Michael Wong) targeted C++26 and ships as `<experimental/hazard_pointer>` in libstdc++ 13 and folly. The standard surface is small.

```cpp
#include <experimental/hazard_pointer>
using std::experimental::hazard_pointer;
using std::experimental::make_hazard_pointer;
using std::experimental::hazard_pointer_obj_base;

struct Node : hazard_pointer_obj_base<Node> {
    int value;
    std::atomic<Node*> next;
};

std::atomic<Node*> head;

int read_head() {
    hazard_pointer h = make_hazard_pointer();
    Node* p = h.protect(head);
    return p ? p->value : -1;
}

void pop() {
    hazard_pointer h = make_hazard_pointer();
    Node* old;
    do {
        old = h.protect(head);
        if (!old) return;
    } while (!head.compare_exchange_weak(old, old->next.load(std::memory_order_acquire)));
    old->retire();
}
```

`hazard_pointer_obj_base<T>::retire()` queues the object for deletion in the default domain. `protect` is the load-and-validate primitive. The interface deliberately does not expose the domain or scan threshold because the standard committee wanted to leave room for QSBR-flavored or RCU-flavored implementations under the same API.

### Folly's HazptrDomain

Folly's `folly/synchronization/Hazptr.h` adds several optimizations over the textbook design.

**Single-writer fast path.** Writers that own the only mutator role on a structure can skip the validation re-read because no concurrent retire can happen for nodes they have not yet published.

**Tagged retirement.** Each retired node carries a cohort tag. Cohorts let you batch retires and run scans only when a cohort drains, which amortizes the snapshot cost. Folly's `hazptr_obj_cohort` is essential for high-throughput producer-consumer pipelines.

**Asynchronous reclamation.** A background thread drains overflowing retired lists, which prevents producers from paying scan latency on the hot path.

**Domain isolation.** Per-subsystem domains prevent unrelated workloads from inflating each other's scan times.

```cpp
folly::hazptr_obj_cohort cohort;

struct Entry : folly::hazptr_obj_base<Entry, std::default_delete<Entry>, folly::hazptr_obj_cohort> {
    int v;
};

void publish(int v) {
    auto* e = new Entry{v};
    e->set_cohort_tag(&cohort);
    // ... swap into structure ...
    e->retire();
}
```

### Senior at FAANG: False-Conflict Mitigation

A naive scan compares retired pointers to every hazard slot in the domain. With 200 threads and 8 slots each, that is 1600 atomic loads per scan. Two mitigations matter at scale.

**Sharded hazard arrays.** Group hazards by hash(pointer) % shards. Only the shard for a retired pointer needs to be scanned. This reduces scan cost from O(P) to O(P/shards).

**Generation-tagged hazards.** Pair each hazard with a generation counter. The reclaimer ignores hazards whose generation predates the unlink. This eliminates false conflicts where an old, stale hazard slot still contains a freed pointer because the thread parked.

**Padding for false sharing.** Each `HazardRecord` should occupy its own cache line (`alignas(64)`). Adjacent records on the same line cause writes to one record to invalidate another thread's cached read.

```cpp
struct alignas(64) HazardRecord {
    std::atomic<HazardRecord*> next;
    std::atomic<bool> active;
    std::atomic<void*> hazard;
    char pad[64 - sizeof(std::atomic<HazardRecord*>) - sizeof(std::atomic<bool>) - sizeof(std::atomic<void*>)];
};
```

### Cost Model

A `protect` call costs one acquire load, one seq_cst store, and one acquire load (the re-read). On x86 the seq_cst store is `mov` plus `mfence` or a locked instruction, which is roughly 20-40 cycles uncontended. On ARMv8 it is `stlr` (around 8-15 cycles) plus the implicit ordering. A retire costs an allocation for the retired record plus, every threshold-crossing, a scan of P*H atomics. For P=64, H=2 that is 128 acquire loads and a hash set insertion, around 1-3 microseconds.

Compare that to `std::shared_ptr` atomic operations (around 30-50 cycles for a refcount increment plus a seq_cst fence). Hazard pointers are competitive in the read path and beat shared_ptr decisively when retire frequency is low.

### When Hazard Pointers Lose

When the structure has a small number of long-lived nodes and many short-lived references, hazard pointers shine. When the structure churns rapidly with many threads holding references for long durations, the retire list bloats and scan latency spikes. Epoch-based reclamation handles that case better and is covered in the next section.

Hazard pointers also lose when the number of pointers a thread must protect simultaneously is unbounded (for example, traversing a deep skip list). You either need many slots per thread, or you need a different scheme. Folly's `hazptr_array<N>` lets you allocate N slots at once for traversal-heavy workloads.
