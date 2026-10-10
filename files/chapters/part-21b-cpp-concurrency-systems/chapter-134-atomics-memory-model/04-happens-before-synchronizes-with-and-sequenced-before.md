## Happens-Before, Synchronizes-With, and Sequenced-Before

These are the formal relationships that the C++ standard uses to define when one operation's effects are guaranteed visible to another.

### Sequenced-Before (Single Thread)

Within a single thread, evaluation A is **sequenced-before** evaluation B if A appears before B in program order (with respect to sequence points / sequencing rules). This is the familiar "code runs top to bottom" guarantee.

```cpp
int x = 0;
x = 1;    // A
int y = x; // B - A is sequenced-before B, so y == 1 is guaranteed
```

### Synchronizes-With (Between Threads)

A release store **synchronizes-with** an acquire load if the load reads the value written by the store (or a value later in the modification order). This is how atomics create cross-thread ordering.

```cpp
// Thread 1
data = 42;                                    // W1
flag.store(true, std::memory_order_release);  // W2 (release)

// Thread 2
while (!flag.load(std::memory_order_acquire)) {} // R1 (acquire) - synchronizes-with W2
int local = data;                                 // R2 - sees W1
```

W2 synchronizes-with R1 because R1 reads the value written by W2. This synchronizes-with relationship, combined with sequenced-before, establishes happens-before.

### Happens-Before (Transitive Closure)

Operation A **happens-before** operation B if any of these hold:

1. A is sequenced-before B (same thread).
2. A synchronizes-with B (cross-thread atomic pair).
3. A happens-before C, and C happens-before B (transitivity).

If A happens-before B, then the side effects of A are guaranteed visible to B.

```
Thread 1:                    Thread 2:
data = 42          (W1)
    |
    | sequenced-before
    v
flag.store(release) (W2) ----synchronizes-with----> flag.load(acquire) (R1)
                                                         |
                                                         | sequenced-before
                                                         v
                                                    local = data  (R2)

W1 happens-before R2 via the chain:
  W1 → (sequenced-before) → W2 → (synchronizes-with) → R1 → (sequenced-before) → R2
```

### Modification Order

Every atomic variable has a **modification order**: a total order of all writes to that variable. All threads agree on this order. Even with relaxed ordering, no thread can see writes to a single atomic variable in a different order.

```cpp
std::atomic<int> x(0);

// Thread 1: x = 1; x = 2;
// Thread 2: x = 3;
// Possible modification orders:
// 0 → 1 → 2 → 3
// 0 → 1 → 3 → 2
// 0 → 3 → 1 → 2
// But NOT: Thread A sees 0→1→2→3 while Thread B sees 0→3→1→2
// All threads agree on ONE of the possible orders
```

### Junior → FAANG: Happens-Before as the Core of Concurrent Reasoning

The three terms in this chapter's title, happens-before, synchronizes-with, and sequenced-before, describe the same idea at different levels of abstraction. "Sequenced-before" is about statements in a single thread. "Synchronizes-with" is about the edge created by a release/acquire pair across threads. "Happens-before" is the transitive closure of both.

The practical implication: if operation A happens-before operation B, then B is guaranteed to see all side effects of A. If no happens-before relationship exists between A and B, B may see any value, including one that was never written. This is not a probability statement. It is a guarantee about what the standard permits.

First-job habit: when writing any concurrent code, draw the happens-before graph. Each node is an operation. Each edge is established by a mutex lock/unlock pair, an acquire/release pair, or a thread start/join. If data flows from thread A to thread B and you cannot draw a happens-before edge that covers that data, you have a data race.

### Senior @ FAANG: Happens-Before as the Proof Obligation for Lock-Free Code

At L5+, every lock-free algorithm ships with an implicit proof that the happens-before graph is correct for all interleavings. The happens-before relationship is not just a debugging tool. It is the formal specification of the algorithm's correctness.

The senior discipline: when reviewing a lock-free data structure, reconstruct the happens-before graph explicitly. For each pair of operations that access shared state, identify which synchronizes-with edge (if any) covers the access. If the graph has a hole, the algorithm has a race. This is the only reliable way to review lock-free code. Intuition and testing are insufficient.

Litmus tests are the industry tool for validating happens-before reasoning. The `herd7` model checker and `Dat3M` can verify small concurrent algorithms against the C++ memory model mechanically. At Google, Facebook, and other FAANG companies, non-trivial lock-free algorithms are validated with litmus tests before landing. This is a bar-raiser-level expectation for staff engineers working on concurrent infrastructure.

The seq_cst total order provides a global happens-before order that is easy to reason about but carries the costs described in the previous section. The practical senior skill is knowing when the full total order is necessary for correctness (Dekker's algorithm, Peterson's algorithm, any multi-producer multi-consumer pattern that requires observing relative interleaving order) vs. when acquire/release suffices (single-producer single-consumer queues, publish-subscribe patterns with a single flag).

L7 concern: at principal level, the happens-before model affects how you design system-level contracts between services. In a distributed system, the memory model analogy is causal consistency vs. sequential consistency. Engineers who deeply understand the C++ happens-before model are better equipped to reason about distributed consistency models, Lamport clocks, and vector clocks. This cross-domain transfer is what distinguishes systems architects from systems programmers.

---
