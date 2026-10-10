## When to Use Which Memory Ordering

Use this decision flowchart when choosing a memory ordering:

```
START
  │
  ├─ "Do I need to synchronize non-atomic data between threads?"
  │    │
  │    ├─ NO → Use memory_order_relaxed
  │    │        (counters, statistics, progress bars)
  │    │
  │    └─ YES
  │         │
  │         ├─ "Is this a store that publishes data?"
  │         │    └─ YES → Use memory_order_release
  │         │
  │         ├─ "Is this a load that consumes published data?"
  │         │    └─ YES → Use memory_order_acquire
  │         │
  │         ├─ "Is this a read-modify-write that both reads
  │         │    and publishes?"
  │         │    └─ YES → Use memory_order_acq_rel
  │         │
  │         └─ "Do I need a total order visible to ALL threads
  │              across MULTIPLE atomic variables?"
  │              │
  │              ├─ YES → Use memory_order_seq_cst
  │              │
  │              └─ NO → Use acquire/release pair
  │
  └─ "Am I unsure about any of the above?"
       └─ YES → Use memory_order_seq_cst (the safe default)
            Then profile and weaken ONLY if measurements prove it matters.
```

**The golden rule**: Start with `seq_cst`. Measure. Weaken to acquire/release only if the profiler shows atomics are a bottleneck. Weaken to relaxed only for truly independent counters.

### Junior → FAANG: Decision Rules You Can Actually Apply

The golden rule above is correct but abstract. Here is a concrete decision tree for first-job use:

1. Is this a counter that only ever increments or decrements and whose value you only read occasionally (e.g., a metrics counter)? Use `relaxed` on the writes, `relaxed` on the reads if approximate reads are acceptable, or `seq_cst` on reads if you need an exact snapshot.

2. Is this a flag that one thread sets to signal another (e.g., a "data is ready" flag)? Use `release` on the store, `acquire` on the load. This is the acquire/release handshake pattern.

3. Is this a shared pointer or reference count that may be modified by multiple threads and on which you perform conditional logic? Use `seq_cst` or a mutex. The complexity of getting acquire/release right with multiple writers is not worth the performance gain at this stage.

4. Everything else: use `seq_cst` until a benchmark tells you otherwise.

### Senior @ FAANG: Ordering Selection as a Formal Interface, Not a Hint

At senior level, the choice of memory ordering is a formal interface contract between the code that produces values and the code that consumes them. Changing an ordering is a breaking change to that contract, just as changing a function signature is a breaking change to an API. This means ordering choices must be:

(1) Documented adjacent to the declaration, with a comment explaining what synchronizes-with edge the ordering establishes.
(2) Verified by a litmus test or model checker for non-trivial algorithms.
(3) Reviewed under a separate PR from the surrounding logic changes, so reviewers can focus on the correctness argument.

The governance implication: a codebase where ordering choices are scattered across files, undocumented, and changed casually is a security and correctness liability. Memory ordering bugs have caused production data corruption at multiple FAANG companies. The cost of a documentation requirement is hours. The cost of a production ordering bug is days of incident response plus customer impact.

Bar-raiser expectation: at L6, you should be able to review a lock-free data structure, identify every memory ordering in it, and explain in one sentence per ordering why that specific ordering (and not a weaker or stronger one) is correct. If you cannot do this, you are not ready to approve the code.

L7 maturity signal: at staff level, you set the policy. The policy should be: seq_cst by default, documented exception for hot paths, litmus test required for any non-acquire/release pattern, annual audit of all non-seq_cst atomics in the codebase to verify the rationale still holds as the code evolves.

---
