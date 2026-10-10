## Linearizability and Sequential Consistency

These two correctness properties for concurrent objects are often conflated. They are different. Linearizability composes. Sequential consistency does not. This file pins down the definitions, the proof techniques, and the bugs that arise when the wrong one is assumed.

### Sequential Consistency (Lamport, 1979)

Lamport: "the result of any execution is the same as if the operations of all the processors were executed in some sequential order, and the operations of each individual processor appear in this sequence in the order specified by its program."

Two parts:

1. There exists a total order on all operations.
2. The total order respects program order within each thread.

Sequential consistency is a property of a system or a single shared object viewed in isolation.

### Linearizability (Herlihy and Wing, 1990)

Linearizability adds: each operation appears to take effect at some instantaneous point between its invocation and its response.

Formally, an execution is linearizable if there exists a total order on completed operations (and a subset of pending operations) such that:

1. The order respects real-time precedence: if op A completes before op B begins (in real time), A precedes B in the order.
2. The order is consistent with the sequential specification of the object.

The real-time precedence requirement is what distinguishes linearizability from SC. SC requires only that program order be respected within a thread. Linearizability requires that real-time order be respected across threads as well.

### The Crucial Difference: Composability

Linearizability is local: the composition of linearizable objects is linearizable. If queue Q and stack S are individually linearizable, then a system using both is linearizable with respect to the operations on each.

SC is not local: the composition of two SC objects is not necessarily SC.

The classic counterexample (Herlihy and Wing):

```cpp
SC_Queue Q1, Q2;

// T1
Q1.enq(x);            // 1
Q2.enq(x);            // 2

// T2
Q2.enq(y);            // 3
Q1.enq(y);            // 4

// T3
auto a = Q1.deq();    // 5
auto b = Q1.deq();    // 6

// T4
auto c = Q2.deq();    // 7
auto d = Q2.deq();    // 8
```

Both queues individually SC (each enq/deq pair has some sequential explanation). But the system can produce `a=x, b=y, c=y, d=x`. T3 sees Q1 as x-then-y, T4 sees Q2 as y-then-x. There is no global program-order-respecting interleaving that produces both. The composition is not SC.

If Q1 and Q2 had been linearizable, this outcome would be forbidden. The real-time precedence between T1's two enqs and T2's two enqs would constrain both queues consistently.

### Why This Matters in Practice

When you build a complex concurrent system from primitives, you assume the primitives compose. For SC primitives, they do not. For linearizable primitives, they do.

`std::atomic<T>` with seq_cst is linearizable (the standard requires real-time-respecting total order on seq_cst ops). With acq_rel it is per-object SC but not globally linearizable across multiple atomics.

Concurrent data structures (queues, stacks, hash tables) advertised as "lock-free" should specify whether they are linearizable. Most production-quality structures (Michael-Scott queue, Treiber stack, split-ordered hash) are linearizable. Some optimistic structures are weaker (e.g., quiescent consistency, eventual consistency).

### Linearization Points

Proof technique: identify a single instruction in each operation as its linearization point. The operation appears to execute atomically at that instant.

For Treiber stack push:
- Linearization point: the successful CAS that updates head.
- The push appears to happen at that instant.

For Treiber stack pop:
- Linearization point: the successful CAS that updates head, OR the load that observes head==null (for empty pop).

For Michael-Scott queue enq:
- Linearization point: the CAS that links the new node onto tail.

For Michael-Scott queue deq:
- Linearization point: the CAS that updates head (or the load that observes head==tail and tail->next==null for empty).

The linearization point may be in another thread. Helping algorithms (where one thread completes another's work) have linearization points that are sometimes in the helper thread, not the original requester. This is fine as long as the proof identifies them.

### Proving Linearizability

The standard proof obligations:

1. For each operation, define its linearization point.
2. Show that linearization points respect real-time precedence (LP of A before LP of B if A ended before B started).
3. Show that the sequential specification holds when operations are ordered by their LPs.

Formal proofs use Owicki-Gries reasoning, rely-guarantee, or simulation arguments. For most production code, an informal argument plus a model checker (TLA+, Spin, herd7) is sufficient.

Helping algorithms and external linearization points complicate proofs. Recent papers (Khyzha, Dodds, Gotsman) extend linearizability for these patterns.

### Real Bugs from Non-Linearizable APIs

**Bug 1: ConcurrentHashMap.size() in old Java**

Java's ConcurrentHashMap had a non-linearizable size() method. It iterated through segments without locking, summing sizes. The result could differ from any size that ever actually existed during the iteration. Code that relied on `if (map.size() == map.capacity())` for triggering a resize had a window where size() lied, the resize was skipped, and the map degraded.

**Bug 2: Compare-and-set on stale read**

```cpp
// Read X, compute, write back if X unchanged
T x_old = x.load(std::memory_order_acquire);
T x_new = transform(x_old);
if (!x.compare_exchange_strong(x_old, x_new, std::memory_order_acq_rel)) {
    // retry
}
```

This is linearizable per CAS. But if `transform` reads from another atomic Y that is also being modified, the combined operation is not linearizable. Two threads can each compute transforms based on inconsistent (X, Y) snapshots and both succeed. The system-level invariant breaks.

The fix: Linearize the read of X and Y together (e.g., pack them in one atomic, use a sequence lock, or use a lock).

**Bug 3: Multi-counter snapshot**

Reading multiple per-CPU counters and summing is not linearizable. You may observe (counter[0]=3, counter[1]=2) when the global state was never (3,2), only ever (2,2) or (3,3).

The fix: take a global snapshot via membarrier or by reading each counter twice and verifying consistency.

### Weaker Correctness Conditions

When linearizability is too expensive, weaker properties may suffice:

**Sequential consistency**: Already covered. Per-thread program order respected, but real-time order not enforced cross-thread.

**Quiescent consistency**: Operations appear in a serial order during quiescent periods (when no operations are pending). Useful for performance counters.

**Eventual consistency**: Replicas converge given no new updates. Used in distributed systems, rarely in single-machine concurrency.

**Strict serializability** (database term): Linearizability + ACID. Common in transactional systems.

For a concurrent data structure in C++, target linearizability unless you have a documented reason to relax.

### The Cost of Linearizability

Linearizability requires real-time-respecting total order. This usually requires seq_cst or careful acq_rel + sequence numbers. On weakly-ordered hardware (ARM, POWER), this is more expensive than on x86 TSO.

Lock-free linearizable structures often use a single CAS as the linearization point, paying one expensive op per call. Lock-based structures linearize at the lock acquisition or release.

If profiling shows the cost of linearizability is unacceptable, consider:

- Splitting the data structure into independent shards (each linearizable, but cross-shard operations are not).
- Switching to quiescent consistency for read-mostly aggregates.
- Using an explicit batch interface so the cost of linearization is amortized.

### Junior at FAANG vs Senior at FAANG

Junior reads "linearizable" and "sequentially consistent" and treats them as synonyms. Senior knows that linearizability composes, SC does not, and that this distinction is exactly why complex systems built from SC-only primitives have surprising bugs. Senior's API specs explicitly say "linearizable" and identify linearization points in the doc-comment of every public method.

When reviewing a new concurrent data structure, senior asks three questions:

1. What is the linearization point of each operation?
2. What is the proof that LPs respect real-time order?
3. What seq_cst or fence operations enforce that order on weakly-ordered hardware?

If the author cannot answer all three, the structure is suspect.
