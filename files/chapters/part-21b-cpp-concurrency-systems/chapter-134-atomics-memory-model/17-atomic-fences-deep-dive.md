## Atomic Fences Deep Dive

`std::atomic_thread_fence` is the standalone barrier in the C++ atomics library. It is not equivalent to a memory-ordered atomic op. Understanding when fences buy you something atomics cannot is the difference between a working and a broken lock-free implementation.

### The Five Fence Flavors

```cpp
std::atomic_thread_fence(std::memory_order_relaxed);   // no-op
std::atomic_thread_fence(std::memory_order_acquire);   // acquire fence
std::atomic_thread_fence(std::memory_order_release);   // release fence
std::atomic_thread_fence(std::memory_order_acq_rel);   // both
std::atomic_thread_fence(std::memory_order_seq_cst);   // total order participant
```

Plus `std::atomic_signal_fence`, which is a compiler-only barrier with no machine instruction emitted. It is useful between a thread and its own signal handler.

### The Synchronization Rules

The standard defines three fence-related synchronization patterns.

**Fence-fence**: A release fence F1 in T1 synchronizes with an acquire fence F2 in T2 if there exist atomic operations A in T1 (sequenced after F1) and B in T2 (sequenced before F2) on the same object M, where A is a store, B is a load, and B reads from A or from A's release sequence.

**Fence-atomic**: A release fence F1 in T1 synchronizes with an acquire load B in T2 if there is a store A in T1 sequenced after F1, on the same object as B, and B reads-from A or its release sequence.

**Atomic-fence**: A release store A in T1 synchronizes with an acquire fence F2 in T2 if there is a load B in T2 sequenced before F2 such that B reads-from A or its release sequence.

The pattern is: a release-side construct (release atomic or release fence) pairs with an acquire-side construct (acquire atomic or acquire fence). The atomic op and the fence cooperate to establish synchronizes-with.

### When Fences Buy You Something Atomics Do Not

**Case 1: ordering multiple unrelated relaxed stores with one barrier**

```cpp
std::atomic<int> a{0}, b{0}, c{0};
std::atomic<int> ready{0};

// T1
a.store(1, std::memory_order_relaxed);
b.store(2, std::memory_order_relaxed);
c.store(3, std::memory_order_relaxed);
std::atomic_thread_fence(std::memory_order_release);   // one fence
ready.store(1, std::memory_order_relaxed);

// T2
while (ready.load(std::memory_order_relaxed) == 0) {}
std::atomic_thread_fence(std::memory_order_acquire);   // one fence
int x = a.load(std::memory_order_relaxed);
int y = b.load(std::memory_order_relaxed);
int z = c.load(std::memory_order_relaxed);
```

This is equivalent in observed behavior to using release on the ready store and acquire on the ready load. The fence form has the same hardware cost on most architectures but expresses intent: "everything before/after this point".

**Case 2: separating atomic op from synchronization point**

```cpp
// T1, register thread
my_id.store(tid, std::memory_order_relaxed);    // happens early
// ... lots of code ...
std::atomic_thread_fence(std::memory_order_release);
flag.store(1, std::memory_order_relaxed);
```

If the atomic store happens far from the synchronization point, a fence at the actual handoff is clearer than retrofitting release to a far-away store.

**Case 3: emulating older or platform-specific patterns**

Linux kernel has `smp_mb()`, `smp_rmb()`, `smp_wmb()`. Mapping to C++:

- `smp_mb()` = `atomic_thread_fence(seq_cst)`
- `smp_rmb()` = `atomic_thread_fence(acquire)`
- `smp_wmb()` = `atomic_thread_fence(release)`

User-level code talking to a kernel API or porting kernel idioms to userspace uses fences directly.

**Case 4: seq_cst fence between two relaxed atomic operations**

```cpp
// Dekker lite
me.store(1, std::memory_order_relaxed);
std::atomic_thread_fence(std::memory_order_seq_cst);  // global ordering point
int v = you.load(std::memory_order_relaxed);
```

A seq_cst fence participates in S, the global total order on seq_cst operations. This gives you StoreLoad-style ordering across two relaxed atomics. P0668 clarified the exact semantics. The fence sits in S between the two relaxed ops on its own thread and forces global agreement on the relative order of stores observed by each thread.

### Fences and Non-Atomic Memory

Fences order atomic and non-atomic accesses. A release fence orders all prior non-atomic stores before subsequent atomic stores. An acquire fence orders prior atomic loads before subsequent non-atomic accesses.

This is what makes the "publish data via flag" pattern work with a fence:

```cpp
struct Item { int payload; };
Item item;
std::atomic<bool> ready{false};

// T1
item.payload = 42;
std::atomic_thread_fence(std::memory_order_release);
ready.store(true, std::memory_order_relaxed);

// T2
if (ready.load(std::memory_order_relaxed)) {
    std::atomic_thread_fence(std::memory_order_acquire);
    use(item.payload);   // sees 42
}
```

The fence-atomic pattern: T1's fence + T1's relaxed store + T2's relaxed load + T2's fence yields a synchronizes-with edge.

### Asymmetric Fences (Linux membarrier)

Some patterns require a barrier on every thread, but most threads never write to a shared variable. The cost of executing a fence on the read-mostly path is wasted.

`membarrier(2)` on Linux solves this. The slow-path thread calls `membarrier()`, which IPI-sends a barrier to every running thread. The fast-path threads pay zero cost in steady state. They effectively get a fence at their next entry to the kernel or via the IPI.

Use cases:

- RCU implementations. Readers do not pay any fence. Writers call membarrier to ensure all readers see prior updates.
- Garbage collectors with write barriers. Application threads run barrier-free. The collector calls membarrier to synchronize with mutators.
- Fast-path counters where the consumer wants a snapshot of all threads' counters consistent up to a point.

```c
membarrier(MEMBARRIER_CMD_PRIVATE_EXPEDITED, 0, 0);
```

Variants:
- `MEMBARRIER_CMD_GLOBAL`. Slow, system-wide. Avoid.
- `MEMBARRIER_CMD_PRIVATE_EXPEDITED`. Fast, this process only. Default for production.
- `MEMBARRIER_CMD_PRIVATE_EXPEDITED_SYNC_CORE`. Synchronizes core pipelines, useful for JIT code modification.
- `MEMBARRIER_CMD_PRIVATE_EXPEDITED_RSEQ`. Pairs with restartable sequences.

The cost is one syscall plus IPIs proportional to the number of running threads. For a writer that runs once per second this is invisible. For readers that run a million times per second, the saved cycles add up.

### Linux RCU Fence Patterns

Read-Copy-Update on Linux uses asymmetric fences plus a quiescent state mechanism. The simplified pattern:

```c
// Reader (fast path, no fences)
rcu_read_lock();
p = rcu_dereference(shared);     // dependent load, free on x86 and ARM
use(p->field);
rcu_read_unlock();

// Writer
new_p = make_new();
rcu_assign_pointer(shared, new_p);  // store-release equivalent
synchronize_rcu();                  // wait for all current readers
free(old_p);
```

`synchronize_rcu()` internally uses `membarrier` (or the equivalent) plus a per-CPU quiescent state count. The reader pays no atomic ops beyond `rcu_dereference`, which on most architectures compiles to a plain load with a compiler barrier. The writer pays the synchronize cost once per update batch.

Userspace RCU (liburcu) implements the same semantics. The "memb" flavor uses membarrier. The "qsbr" flavor requires application threads to periodically declare quiescence. The "bp" flavor uses signals.

### Fence vs Fenceless Implementations

Many lock-free algorithms have two variants:

1. Strong-fence variant. Symmetric, every op pays a barrier.
2. Asymmetric-fence variant. Most ops are fence-free, expensive ops use IPIs.

Crossbeam in Rust and folly in C++ both implement EBR with asymmetric fences for the common case where reclamation is rare relative to read traffic.

Choosing depends on read/write ratio. If reads are 1000x writes, asymmetric fences win. If reads and writes are balanced, asymmetric fences cost more (the membarrier syscall is expensive when frequent). Profile before choosing.

### Junior at FAANG vs Senior at FAANG

Junior reaches for `std::atomic_thread_fence(seq_cst)` whenever they are unsure. Senior knows that fences are expensive (full barrier on x86, hwsync on POWER) and reaches for them only when:

- Multiple non-atomic stores share one synchronization point.
- The handoff point is far from the atomic op semantically.
- Implementing a kernel-style barrier API.
- Implementing asymmetric fence patterns (membarrier).

Senior also knows that on x86 a fence is `mfence` (~30 cycles) while a `lock`-prefixed RMW that they already need does the same job for free. Choosing `lock add [rsp], 0` over `mfence` is a 30 cycle win on Skylake. AMD Zen behaves differently. Check your microarch.
