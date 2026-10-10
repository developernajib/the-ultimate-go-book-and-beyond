## C++ Memory Model Formalism

The C++ memory model is not a folk theorem about caches. It is a formal axiomatic system defined in N4527 and refined in subsequent papers (P0668, P0982, P1217). If you reason about atomics by drawing CPU diagrams, you will write bugs that the standard does not protect against. This file gives the formal vocabulary you need to argue rigorously about a lock-free algorithm.

### The Four Primitive Relations

The standard defines program behavior in terms of four base relations on memory operations. Every concurrency proof reduces to these.

**sequenced-before (sb)**: Intra-thread program order, modulo expression evaluation rules. If `a` and `b` are evaluations in the same thread and `a` is sequenced before `b`, the abstract machine completes `a` (and side effects) before starting `b`. Note this is a partial order, not total. `f() + g()` does not sequence `f` before `g` or vice versa.

**modification order (mo)**: For each atomic object M, a total order over all modifications to M across all threads. Modification order is per-object. There is no global modification order across distinct atomic variables unless seq_cst is used.

**reads-from (rf)**: Maps each atomic load L to the unique store W whose value L observed. Every atomic load reads from exactly one store. The standard requires `rf` be coherent with `mo`.

**synchronizes-with (sw)**: A cross-thread relation. A release operation A on object M synchronizes with an acquire operation B on M if B reads a value written by A or by any store in the release sequence headed by A.

### Happens-Before, the Derived Relation

Happens-before (hb) is the transitive closure of sequenced-before and synchronizes-with:

```
hb = (sb ∪ sw)+
```

If `A hb B`, then any side effect visible at A is visible at B. Data race freedom is defined as: for any two conflicting accesses (same location, at least one a write, at least one non-atomic), one happens-before the other. If your program has a pair of conflicting accesses with no `hb` ordering, behavior is undefined. Not "may produce wrong values". Undefined. The compiler may delete the entire program.

### Coherence Axioms

The model imposes four coherence rules. Violating any of them is a contradiction, so the implementation must prevent the corresponding execution.

**CoRR (read-read coherence)**: If thread T reads X1 then X2 from the same location, and X1 hb X2 in modification order, then T cannot read X2 before X1.

**CoWR (write-read coherence)**: A read cannot return a value earlier in mo than a write that happens-before it.

**CoWW (write-write coherence)**: hb on writes to the same location must agree with mo.

**CoRW (read-write coherence)**: A write cannot precede in mo a value that a happens-before-earlier read observed.

These four rules together are the per-location SC guarantee. Even relaxed atomics give you coherence per object. What relaxed gives up is cross-location ordering.

### The seq_cst Total Order

Sequentially consistent operations participate in a single total order S, consistent with hb and with each object's mo. The key axiom (P0668):

> For every pair of seq_cst operations A and B on possibly different objects, either A precedes B in S or B precedes A in S, and this order is consistent with happens-before.

This is what makes IRIW work for seq_cst and fail for acq_rel. We treat IRIW formally in the seq_cst vs acq_rel section.

### Release Sequences

A release sequence headed by a release store A on object M is the longest contiguous subsequence of mo(M) starting at A consisting of:

1. A itself.
2. Stores by the same thread as A.
3. Atomic read-modify-write operations by any thread.

Any acquire load that reads from any element of the release sequence synchronizes with A. C++20 (P0982) tightened this. Before C++20, non-RMW writes by other threads were also included via a "release sequence" concept that turned out to be unimplementable without barriers nobody wanted to pay for. Modern release sequences are RMW-only after the head (excepting same-thread stores).

```cpp
// Release sequence example
std::atomic<int> x{0};
std::atomic<bool> ready{false};

// T1
x.store(42, std::memory_order_relaxed);
ready.store(true, std::memory_order_release);     // head of release seq

// T2 (RMW extends the release sequence)
bool expected = true;
ready.compare_exchange_strong(expected, true,
    std::memory_order_acq_rel,
    std::memory_order_acquire);

// T3 acquires from T2's RMW
if (ready.load(std::memory_order_acquire)) {
    // sees x == 42, even though it synchronized with T2 not T1
    assert(x.load(std::memory_order_relaxed) == 42);
}
```

T3 reads from T2's CAS. Because T2's CAS is part of the release sequence headed by T1's store, T3 acquires the release effects of T1.

### Why memory_order_consume Was Deprecated

`consume` was meant to encode dependency-ordered-before (dob), the formalization of address-dependency ordering on POWER and ARM. The intent: if a load is consume and a subsequent operation uses the loaded value to compute an address, the dependency is preserved without a barrier. The cost on x86 was zero because x86 already orders dependent loads.

The problem was the "dependency tracking" rule. The standard required compilers to preserve syntactic dependencies through arbitrary code, including across function boundaries. Compilers cannot do this without disabling optimizations like value numbering, jump threading, and dead code elimination on every consume-derived value. No mainstream compiler ever implemented consume correctly. They all promote it to acquire.

P0750 (deprecation) and P0735 (replacement direction) document the failure. RCU implementations in production (Linux kernel, userspace RCU) use volatile casts and `READ_ONCE` to force the dependency to be respected. The replacement proposal is `memory_order_dependency` paired with `[[carries_dependency]]` annotations, but progress has stalled since 2022.

For now, treat consume as "acquire that some day might be cheaper". If you need true dependency-ordered loads on POWER or ARMv7, write the asm or use kernel-style READ_ONCE patterns.

### What the Standard Does NOT Define

- Cache coherence protocols. The standard talks about modification order, never about MESI, MOESI, or directories.
- Store buffers, invalidation queues, snoop traffic. These are implementation details.
- Out-of-thin-air values. The standard prohibits them informally. Formal prohibition is unsolved (P1217).
- Mixed-size atomics. `atomic<uint64_t>` and `atomic<uint32_t>` overlapping is implementation-defined.

If your reasoning depends on any of these, you have left the standard and are relying on implementation-specific lore. That world is fine for kernel hackers but it is not portable.

### Junior at FAANG vs Senior at FAANG

A junior at FAANG sees `std::atomic<int>` and thinks "thread-safe int". A senior at FAANG sees an object whose modification order is total per-object, whose loads must read from somewhere in that order consistent with happens-before, and whose interaction with other atomics depends entirely on the memory order tags chosen at every operation. The junior debugs by reading values. The senior debugs by drawing the rf graph and checking coherence.

### Reading the Formal Proofs

Batty et al. "Mathematizing C++ Concurrency" (POPL 2011) is the foundational mechanization. It defines the model in HOL4 and proves theorems about its consistency. Lahav et al. "Repairing Sequential Consistency in C/C++11" (PLDI 2017) is the source of the seq_cst fix in P0668 and explains why the original C++11 seq_cst was unimplementable on POWER without expensive global fences.

If you are designing a new lock-free structure that the team will run in production, the Batty paper is the level of rigor your proof should reach. Code review should ask: "show me the synchronizes-with edges that prove your invariant".
