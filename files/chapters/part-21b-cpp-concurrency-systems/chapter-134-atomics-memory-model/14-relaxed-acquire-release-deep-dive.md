## Relaxed, Acquire, Release Deep Dive

Acquire-release is the workhorse of production lock-free code. It is cheaper than seq_cst on weakly-ordered hardware and strong enough for nearly all message-passing patterns. Getting it right requires understanding both operational semantics (what the hardware does) and axiomatic semantics (what the standard guarantees).

### The Two Views

**Operational**: Each thread has a local "view" of memory. A release store flushes pending writes into a globally visible buffer tagged with a version. An acquire load that reads that store imports the version, making prior writes by the storing thread visible.

**Axiomatic**: The standard defines synchronizes-with edges. The compiler and hardware must produce executions whose happens-before graph respects every constraint. The hardware mechanism is irrelevant.

Both views give the same answer for any well-formed program. The operational view is useful for debugging. The axiomatic view is what proofs must reduce to.

### Release-Acquire Pair-Up Rule

Release synchronizes with acquire iff the acquire reads-from the release (or from its release sequence). Pair-up is per-object. A release on X does not synchronize with an acquire on Y.

```cpp
std::atomic<int> flag{0};
std::atomic<int> data{0};

// T1
data.store(42, std::memory_order_relaxed);
flag.store(1, std::memory_order_release);   // RELEASE on flag

// T2
while (flag.load(std::memory_order_acquire) == 0) {} // ACQUIRE on flag
int v = data.load(std::memory_order_relaxed);
// v == 42 guaranteed
```

The release on flag synchronizes with the acquire on flag. By transitivity through sequenced-before in T1, the relaxed store to data happens-before the relaxed load in T2.

A common mistake is releasing X and acquiring Y, expecting cross-object synchronization. There is none.

### Transitive Synchronization

Synchronizes-with is not transitive on its own. Happens-before, the transitive closure of (sb ∪ sw), is.

```cpp
std::atomic<int> a{0}, b{0};
int x = 0, y = 0;

// T1
x = 1;
a.store(1, std::memory_order_release);

// T2
while (a.load(std::memory_order_acquire) == 0) {}
y = x;                               // sees x == 1
b.store(1, std::memory_order_release);

// T3
while (b.load(std::memory_order_acquire) == 0) {}
assert(y == 1);                      // OK by transitivity
assert(x == 1);                      // also OK
```

T1 sw T2 (via a). T2 sw T3 (via b). So T1's writes happen-before T3's reads, even though T3 never reads from T1's release directly.

### Release Sequence Headed by W

The release sequence (discussed in the memory model formalism section) extends a release store to include subsequent same-thread stores and any-thread RMWs. This lets RMW chains forward release effects.

```cpp
// Producer chain
std::atomic<int> head{0};
Node* nodes[N];

// T1 produces
nodes[0]->payload = 1;
head.store(1, std::memory_order_release);   // W: release head

// T2 takes via RMW (counter increment)
int prev = head.fetch_add(1, std::memory_order_acq_rel);
// prev == 1, head now 2. T2's RMW is in W's release sequence.

// T3 acquires
int seen = head.load(std::memory_order_acquire);
if (seen >= 2) {
    // synchronizes with T2's RMW, which inherits W's release sequence
    // so T1's store to nodes[0]->payload is visible
    assert(nodes[0]->payload == 1);
}
```

The acquire need only synchronize with any element of the release sequence to inherit all prior release effects.

### RMW Inheritance: The Subtle Case

An RMW is both a load and a store. The load side reads from some store in mo. The store side becomes the next element of mo. The RMW's "synchronizes-with" behavior depends on its memory order:

- `relaxed`: no sw, but it still extends the release sequence of the store it read from
- `acquire`: load side acquires from any release that headed the chain it reads from
- `release`: store side is itself a release for future acquires
- `acq_rel`: both
- `seq_cst`: both, plus participates in S

The subtle part: even a relaxed RMW extends the release sequence. This is necessary for queue patterns.

```cpp
std::atomic<int> seq{0};
Payload data;

// Producer
data.fill(...);
seq.store(1, std::memory_order_release);

// Consumer A bumps seq via relaxed RMW
seq.fetch_add(1, std::memory_order_relaxed);

// Consumer B acquires
if (seq.load(std::memory_order_acquire) >= 2) {
    // Still synchronizes with producer because A's relaxed RMW
    // is in the release sequence headed by the producer's store.
    use(data);
}
```

If A had used a non-RMW relaxed store, the chain would break and B would not synchronize with the producer. The RMW property is what keeps the release sequence alive.

### Cost on Real Hardware

On x86-64:
- relaxed load = `mov`
- acquire load = `mov` (x86 has implicit acquire on loads)
- relaxed store = `mov`
- release store = `mov` (x86 has implicit release on stores)
- seq_cst store = `xchg` or `mov` + `mfence` or `lock add [rsp], 0`
- acq_rel RMW = `lock cmpxchg` or `lock xadd`

x86 makes acq_rel free relative to relaxed. The only cost is loss of compiler reordering.

On ARMv8-A:
- relaxed load = `ldr`
- acquire load = `ldar` (load-acquire register)
- relaxed store = `str`
- release store = `stlr` (store-release register)
- seq_cst load = `ldar`
- seq_cst store = `stlr` (and on ARMv8.0, requires extra fence to fix IRIW)
- acq_rel RMW = `casal` (on LSE) or `ldaxr`/`stlxr` loop

ARMv8 has cheap acquire/release dedicated instructions. The cost over relaxed is the loss of reordering, not a fence.

On POWER:
- acquire = `ld; cmp; bc; isync` or fast-isync
- release = `lwsync; st`
- seq_cst = `hwsync; ld; cmp; bc; isync` or `lwsync; st; hwsync`

POWER pays real cycles for synchronization. seq_cst on POWER costs `hwsync` which serializes the pipeline.

### When Relaxed Is Wrong

Relaxed is for counters and statistics where you only need atomicity, not ordering.

```cpp
// Correct use of relaxed
std::atomic<size_t> bytes_processed{0};
bytes_processed.fetch_add(n, std::memory_order_relaxed);
```

Relaxed is wrong any time the value of an atomic gates access to non-atomic data.

```cpp
// BUG
struct Cache {
    std::atomic<bool> ready{false};
    Data data;
};

// Producer
cache.data = compute();
cache.ready.store(true, std::memory_order_release);  // MUST be release
```

If relaxed were used here, this would be a data race. On x86 it appears to work because of TSO. On ARM it does not. On any compiler with optimization, the load may be hoisted and the use may run with stale data.

### Junior at FAANG vs Senior at FAANG

The junior writes `memory_order_seq_cst` everywhere because "it is safest". They are right that it is safest. They miss that on ARM and POWER they just paid 30 to 100 cycles per op for guarantees they did not need. The senior picks acq_rel for message passing, relaxed for stats counters, seq_cst only when the IRIW pattern matters (discussed in the seq_cst vs acq_rel section). The senior also documents the ordering choice with a comment that names the synchronizes-with edge.

```cpp
// data is published by store-release on ready (sw with acquire-load below)
ready.store(true, std::memory_order_release);
```

If you cannot describe the sw edge in one sentence, you are using the wrong order.
