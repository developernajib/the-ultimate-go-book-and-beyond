## Memory Ordering Proofs

The C++ memory model defines correctness for concurrent code by axioms over inter-thread relations. To prove a lock-free algorithm correct, you show that no execution permitted by these axioms can produce a bad outcome. This chapter shows how, with a worked proof for SPSC ring buffer correctness.

### Axiomatic vs Operational Semantics

Operational semantics defines memory by stepping through a state machine. Each load returns the value of the most recent matching store, with reorderings governed by hardware rules. Useful for intuition but hard to reason about formally because the state space explodes with thread count.

Axiomatic semantics defines memory by relations. A program execution is a graph of memory events (loads, stores, fences) with edges encoding ordering relations. An execution is allowed if its graph is consistent with all axioms. C++ uses axiomatic semantics, the standard text in clause 6.9.2 ([intro.races]) defines all the relations.

### The Core Relations

**Sequenced-before (sb).** The intra-thread program order. If statement S1 precedes S2 in the source, sb(S1, S2) holds within that thread.

**Synchronizes-with (sw).** A release operation A synchronizes with an acquire operation B if B reads the value stored by A (or by something in A's release sequence).

**Happens-before (hb).** The transitive closure of sb and sw. If hb(A, B) holds, A's effects are visible at B.

**Reads-from (rf).** rf(W, R) holds if the load R returns the value written by store W.

**Coherence-order (co).** A total order on stores to the same location, agreed on by all threads.

**Modification order (mo).** Equivalent to coherence-order, the C++ standard's term.

A program has a data race if there exist conflicting memory accesses (at least one a write) on the same location with no happens-before edge between them. A program with a data race has undefined behavior.

### Release Sequence

A release sequence headed by store A consists of A and all subsequent atomic read-modify-writes (RMWs) on the same location, plus any subsequent atomic stores by the same thread. An acquire load that reads from any store in this sequence synchronizes with A.

This is why a CAS chain works. Thread 1 release-stores X. Thread 2 RMW-modifies X. Thread 3 acquires X (reading thread 2's value) and synchronizes with thread 1.

```cpp
std::atomic<int> x{0};
std::atomic<int> data{0};

// Thread 1
data.store(42, std::memory_order_relaxed);
x.store(1, std::memory_order_release);  // A

// Thread 2 (RMW in release sequence of A)
int expected = 1;
x.compare_exchange_strong(expected, 2, std::memory_order_acq_rel);  // B

// Thread 3
if (x.load(std::memory_order_acquire) == 2)  // C
    int v = data.load(std::memory_order_relaxed);  // sees 42
```

C synchronizes with A through B's RMW. The release sequence chains the synchronization.

### SPSC Ring Buffer Proof

Here is the SPSC ring from earlier in this chapter (Lock-Free Queues), simplified for proof purposes.

```cpp
template <typename T, size_t N>
class SPSC {
    std::atomic<size_t> tail_{0};   // producer-only writer
    std::atomic<size_t> head_{0};   // consumer-only writer
    T buf_[N];

    bool push(T v) {
        size_t t = tail_.load(std::memory_order_relaxed);
        size_t h = head_.load(std::memory_order_acquire);
        if ((t + 1) % N == h) return false;
        buf_[t] = std::move(v);                    // (1) data write
        tail_.store((t + 1) % N, std::memory_order_release);  // (2) release
        return true;
    }

    bool pop(T& out) {
        size_t h = head_.load(std::memory_order_relaxed);
        size_t t = tail_.load(std::memory_order_acquire);     // (3) acquire
        if (h == t) return false;
        out = std::move(buf_[h]);                  // (4) data read
        head_.store((h + 1) % N, std::memory_order_release);
        return true;
    }
};
```

**Claim.** Every value popped at index i was previously pushed at index i, with the data write fully visible before the read.

**Proof.**

1. The producer's data write at slot t (line 1) is sequenced-before the release store of tail_ to t+1 (line 2). This gives sb(1, 2).

2. The consumer's acquire load of tail_ (line 3) reads some value t' >= h. Since only the producer writes tail_, the value read came from some specific producer store. Call that store (2'). rf(2', 3) holds.

3. (2') is a release store. (3) is an acquire load that reads-from (2'). Therefore (2') synchronizes-with (3). sw(2', 3) holds.

4. (1') (the data write paired with (2')) is sequenced-before (2'). sb(1', 2').

5. By transitivity of happens-before through sb and sw: hb(1', 2') and hb(2', 3), therefore hb(1', 3). And (3) is sequenced-before (4), so hb(1', 4).

6. Since hb(1', 4), the data write at slot h (which equals the t' at which (1') wrote) is visible at the read (4). The consumer reads exactly the value the producer wrote.

7. There is no data race on `buf_[h]` because hb(1', 4) orders the producer's write before the consumer's read.

8. There is no data race on tail_ because all accesses are atomic. There is no data race on head_ for the same reason.

The proof depends on three ordering choices being correct:

- The producer's tail store must be release. Replace with relaxed and step 3 fails: the synchronizes-with edge does not exist, so the data write at line 1 is not ordered before the consumer's read at line 4. Data race.

- The consumer's tail load must be acquire. Replace with relaxed and step 3 fails for the same reason.

- The producer's data write at line 1 can be relaxed (not even atomic) because the release store at line 2 carries it forward. The release fence is what publishes everything sequenced-before it.

### What Goes Wrong with Weaker Orderings

Replace tail store with relaxed:

```cpp
buf_[t] = v;
tail_.store(t + 1, std::memory_order_relaxed);  // BUG
```

On ARM the producer's CPU may retire the tail store before the data write hits L1. The consumer observes the new tail, reads the slot, and gets the previous occupant of that memory. Hardware-level reordering, no compiler reordering required.

Replace tail load with relaxed:

```cpp
size_t t = tail_.load(std::memory_order_relaxed);  // BUG
out = buf_[h];
```

The consumer's acquire-free load of tail_ does not pair with the producer's release. The compiler is free to hoist the `buf_[h]` load above the tail load. Result: read garbage.

### Tools for Proofs

**cppmem (cppmem.github.io).** Web-based simulator for the C++ memory model. Enter a small program, get all permitted executions visualized as graphs. Useful for sanity-checking ordering claims on programs of 5-15 lines.

```c
int main() {
  atomic_int x = 0;
  atomic_int y = 0;
  {{{ { x.store(1, mo_release); }
  ||| { r1 = x.load(mo_acquire);
        r2 = y.load(mo_relaxed); }
  ||| { y.store(1, mo_release); }
  }}}
}
```

Run it through cppmem and inspect whether `r1 == 1, r2 == 0` is allowed. Yes, because the y store synchronizes with nothing.

**Herd7 (part of the herdtools7 suite).** Industrial-strength memory model simulator. Supports C11/C++11, ARMv8, x86, RISC-V, POWER. Used by hardware vendors to validate their architectures and by researchers to prove software memory model properties.

A herd litmus test for the SPSC pattern:

```
C SPSC-tail
{ x = 0; tail = 0; }
P0 (atomic_int* x, atomic_int* tail) {
  atomic_store_explicit(x, 1, memory_order_relaxed);
  atomic_store_explicit(tail, 1, memory_order_release);
}
P1 (atomic_int* x, atomic_int* tail) {
  r0 = atomic_load_explicit(tail, memory_order_acquire);
  r1 = atomic_load_explicit(x, memory_order_relaxed);
}
exists (1:r0=1 /\ 1:r1=0)
```

Run with `herd7 -model rc11 SPSC-tail.litmus`. Result: "Never". The release/acquire pair forbids the read of stale x after a fresh tail.

Change the tail accesses to relaxed and the result becomes "Sometimes": the bug is observable.

**RC11 vs LKMM.** RC11 is the C++11 (with patches) memory model. LKMM is the Linux Kernel Memory Model, slightly different in its handling of dependencies. Use the matching model for the code you are analyzing.

### Senior at FAANG: SC-DRF Theorem

The Sequential Consistency for Data-Race-Free programs (SC-DRF) theorem states: if a program has no data races under sequentially consistent execution, then all of its executions under the C++ memory model are equivalent to some sequentially consistent interleaving.

Practical consequence: you can prove correctness assuming SC, then verify the absence of data races using only the synchronization relations. You do not need to reason about every possible weak-memory reordering. The theorem is your shield.

Catch: this only works if every memory access is either non-conflicting or properly synchronized. A single relaxed store on shared mutable data, observed by a relaxed load with no synchronization edge, breaks DRF and breaks the theorem. Your program enters undefined behavior territory.

### Catching Real Bugs with cppmem

A real bug found in production code:

```cpp
std::atomic<bool> ready{false};
int data = 0;

// Producer
data = 42;
ready.store(true, std::memory_order_release);

// Consumer
while (!ready.load(std::memory_order_relaxed)) {}
int v = data;
```

The relaxed load on the consumer is the bug. The release on the producer pairs with nothing. The compiler can hoist `int v = data` above the loop. cppmem confirms: `v == 0` is a permitted outcome.

Fix: change the load to acquire. The release/acquire pair establishes happens-before, and the data read sees 42.

### Real-World Application

Folly's `RWSpinLock`, `Hazptr`, and `RCU` implementations all carry comments referencing herd7 litmus tests in their repository. The Linux kernel's `Documentation/memory-barriers.txt` and `tools/memory-model/` directories contain hundreds of litmus tests proving kernel primitives correct under LKMM.

The takeaway for senior interviews: memory ordering proofs are a normal part of code review at the L6+ level. Reviewers at Meta, Google, and Microsoft expect you to either justify your ordering choices verbally with happens-before reasoning or point to a herd7 test that validates them. "I tried it and it worked" is not acceptable for production lock-free code.
