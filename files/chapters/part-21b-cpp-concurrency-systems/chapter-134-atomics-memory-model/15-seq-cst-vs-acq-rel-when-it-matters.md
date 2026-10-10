## seq_cst vs acq_rel: When It Actually Matters

Most working acq_rel programs would still be correct under seq_cst. The reverse is not true. There exists a small but important class of patterns where acq_rel breaks and only seq_cst works. This file pins down exactly that class.

### The IRIW Litmus Test

Independent Reads of Independent Writes. Two writers, two readers, two locations.

```cpp
std::atomic<int> x{0}, y{0};
int r1, r2, r3, r4;

// T1
x.store(1, std::memory_order_release);

// T2
y.store(1, std::memory_order_release);

// T3
r1 = x.load(std::memory_order_acquire);
r2 = y.load(std::memory_order_acquire);

// T4
r3 = y.load(std::memory_order_acquire);
r4 = x.load(std::memory_order_acquire);
```

Question: can `r1=1, r2=0, r3=1, r4=0` happen under acq_rel?

Yes. T3 sees x first, T4 sees y first. There is no contradiction. The acq_rel model says T3's view of the modification orders of x and y is independent from T4's. There is no global agreement on whether x's write came before y's write.

Under seq_cst, this outcome is forbidden. seq_cst gives a single total order S over all seq_cst operations. If x.store is before y.store in S, both T3 and T4 must agree. If after, both must see y first. The mixed answer is impossible.

Most code does not care about IRIW. If your algorithm has a single producer or has natural ordering by some other variable, acq_rel is fine. The IRIW pattern arises in:

- Symmetric protocols where two threads independently announce events.
- Voting algorithms where multiple observers must agree on the order of independent commits.
- Some implementations of Dekker's and Peterson's algorithms.

### The Store-Load Fence Problem

The classical reason for seq_cst: a store followed by a load of a different location, where the load must not be reordered before the store.

```cpp
std::atomic<int> turn{0};
std::atomic<int> me_want{0}, you_want{0};

// Dekker-like
me_want.store(1, std::memory_order_???);
if (you_want.load(std::memory_order_???) == 0) {
    // enter critical section
}
```

Under acq_rel:
- store-release on me_want allows later loads to be reordered before it.
- load-acquire on you_want allows earlier stores to be reordered after it.

Both reorderings break Dekker. Two threads can simultaneously read 0 and both enter.

The fix is seq_cst on both ops. seq_cst stores have a StoreLoad barrier. seq_cst loads have a full barrier. The total order S forbids the dangerous interleaving.

On x86 the cost falls entirely on the store side. seq_cst store compiles to `xchg` or `mov+mfence`. On ARMv8 the cost is split: `stlr` for store, `ldar` for load, plus extra fix-up to make seq_cst stores globally agree (the dmb ish ld pattern, fixed in ARMv8.3 with `stlr` semantics).

### The Two-Trip Rule

A useful heuristic: if your protocol has a "store-to-A then load-from-B then act on B" sequence in two threads where A and B are different, and where the threads must agree on the relative order of their stores, you need seq_cst on those operations.

If it is store-to-A then load-from-A, ordinary acq_rel suffices. The tripping point is the cross-location dependency.

### Real Bugs from acq_rel Where seq_cst Was Needed

**Bug 1: epoch-based reclamation announcer**

```cpp
// Each thread on entry
my_epoch.store(global_epoch.load(std::memory_order_acquire),
              std::memory_order_release);
// Must observe whether other threads are in critical section
for (auto& t : threads) {
    if (t.my_epoch.load(std::memory_order_acquire) < min_safe) {
        // proceed to reclaim
    }
}
```

Under acq_rel, two threads can each store their epoch and then read each other's prior (older) epoch, missing each other. Both reclaim memory the other is using. The fix is seq_cst on the announce store and the observation loads. EBR papers (Fraser, McKenney) explicitly call out this as requiring sequential consistency.

**Bug 2: hazard pointers protect-load loop**

```cpp
T* p;
do {
    p = head.load(std::memory_order_acquire);
    hp.store(p, std::memory_order_release);
} while (p != head.load(std::memory_order_acquire));
```

This is buggy under acq_rel. The reclaiming thread can read hp before the protector's store became visible relative to its own re-load of head. seq_cst on the hp store and the head re-load is required. Maged Michael's original paper specifies seq_cst here.

**Bug 3: WG21 P0668 motivation**

Before C++20 fixed seq_cst for POWER, certain compiler implementations of seq_cst stores using lwsync produced executions that were not actually sequentially consistent. The fix was the "leading hwsync" or "trailing hwsync" patterns documented in Maranget et al. P0668 changed the formal definition to remove a problematic constraint that made the original C++11 seq_cst unimplementable on POWER.

### When acq_rel Suffices

- Single producer, single consumer queue (Lamport, Vyukov SPSC).
- Multi-producer, multi-consumer queue where order is determined by a single seq counter (Vyukov MPMC).
- Reference counting (the decrement is acq_rel because the last decrement must synchronize with all previous releases).
- Most Treiber stack and Michael-Scott queue operations. The CAS on head establishes total order on its own.

In all these patterns there is a single atomic variable that establishes order. IRIW does not arise.

### Detecting the Bug

The hardest part is that acq_rel-instead-of-seq_cst bugs almost never reproduce on x86. x86 TSO makes most acq_rel patterns behave as seq_cst (because x86 only allows StoreLoad reordering, and even then only through the store buffer). Your CI on x86 will be green forever. The bug surfaces on first deployment to ARM or POWER.

Tools:

- **herd7** with the C11 cat model. Define your test, ask it to enumerate executions. If a forbidden outcome is observable under your chosen orderings, it tells you.
- **cppmem**. Smaller but easier interface for textbook patterns.
- **ARM's litmus tool** for hardware-level investigation.
- **TSan** does not help here. TSan reports data races, not memory order misuse on properly atomic accesses.

```
// herd7 IRIW test
C IRIW
{ }
P0 (atomic_int *x) { atomic_store_explicit(x, 1, memory_order_release); }
P1 (atomic_int *y) { atomic_store_explicit(y, 1, memory_order_release); }
P2 (atomic_int *x, atomic_int *y) {
  int r1 = atomic_load_explicit(x, memory_order_acquire);
  int r2 = atomic_load_explicit(y, memory_order_acquire);
}
P3 (atomic_int *x, atomic_int *y) {
  int r3 = atomic_load_explicit(y, memory_order_acquire);
  int r4 = atomic_load_explicit(x, memory_order_acquire);
}
exists (2:r1=1 /\ 2:r2=0 /\ 3:r3=1 /\ 3:r4=0)
```

herd7 reports this outcome as Allowed under the C11 model with acq_rel and Forbidden if all ops are seq_cst.

### Junior at FAANG vs Senior at FAANG

Junior reasoning: "acq_rel is faster, I will use it everywhere acquire-release seems to make sense". Senior reasoning: "I will use acq_rel by default. I will switch to seq_cst on any operation that participates in a multi-location agreement protocol. I will document the IRIW reasoning in a comment."

Code review red flag: any algorithm with two or more atomic variables where multiple threads each store to one and load from another. Without seq_cst on those edges, the algorithm is suspect. Make the author prove the IRIW outcome cannot happen, or change to seq_cst.
