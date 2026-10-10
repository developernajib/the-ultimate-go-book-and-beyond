## Compiler and CPU Reorderings

The C++ memory model abstracts over two layers of reordering: the compiler and the CPU. Both will move your code unless you stop them. This file enumerates what each does and what each fence costs in cycles and instructions.

### Compiler Reorderings

Without atomic ordering tags or volatile, the compiler will:

- Hoist loads out of loops (LICM).
- Sink stores past unrelated code.
- Combine adjacent loads into a single wider load.
- Tear stores into multiple narrower stores.
- Reorder independent ops freely under data dependence.
- Introduce or eliminate temporary loads (rematerialization).
- Speculate loads (read before checking, discard if branch not taken).

`std::atomic<T>` operations participate in the abstract machine's ordering rules. The compiler must produce code such that all observable ordering is consistent with the chosen memory order. For `relaxed`, the compiler still cannot tear or fuse atomics, but it can reorder atomic-relaxed across non-atomic ops freely.

A compiler barrier such as `std::atomic_signal_fence(std::memory_order_seq_cst)` or asm volatile("" ::: "memory") in GCC inhibits compiler reordering at that point. It emits no instructions. It is useful in single-threaded ISR code where you only need to stop the compiler.

### The Hardware Models

#### x86-TSO

x86 (and x86-64) implements Total Store Order. The model:

- Each core has a FIFO store buffer.
- Stores enter the store buffer in program order.
- Loads first check the local store buffer (store-to-load forwarding) then the cache.
- Drain to L1 happens in FIFO order.
- All cores see drains in a single global order.

Permitted reordering: a load may execute before an earlier store to a different address, because the store sits in the buffer while the load goes to cache. This is the only architectural reordering on x86. Everything else is in program order.

Implications:

- LoadLoad: forbidden.
- LoadStore: forbidden.
- StoreStore: forbidden.
- StoreLoad: allowed (only).

Therefore on x86, `acquire` loads and `release` stores need no fence. `seq_cst` stores need a StoreLoad barrier (`mfence`, `xchg`, or `lock`-prefixed op).

#### ARMv8-A Weakly Ordered

ARMv8 allows all four reorderings unless instructions specifically constrain them. Dedicated ordered instructions:

- `ldar` (load-acquire). All later memory ops happen after this load.
- `stlr` (store-release). All earlier memory ops complete before this store.
- `dmb ish` (data memory barrier, inner shareable). Full barrier.
- `dmb ishld` (load barrier, ARMv8.3+). LoadLoad and LoadStore.
- `dmb ishst` (store barrier). StoreStore.

ARMv8.0 had a subtle gap. `stlr` followed by `ldar` did not provide a StoreLoad barrier strong enough for IRIW-style seq_cst. ARMv8.3 introduced "RCsc" semantics where stlr-ldar pairs are properly sequenced. On ARMv8.0, GCC and Clang emit extra `dmb ish` before `ldar` for seq_cst loads, or extra `dmb ish` after `stlr` for seq_cst stores.

LSE (Large System Extensions, ARMv8.1) added cheap atomics:

- `cas`, `casa`, `casl`, `casal` for compare-and-swap.
- `swp`, `swpa`, `swpl`, `swpal` for swap.
- `ldadd`, `ldaddal` and friends for atomic arithmetic.

The `a` suffix is acquire, `l` is release, `al` is both.

LSE2 (ARMv8.4) added single-copy atomicity for unaligned 16-byte access, which matters for `atomic<__int128>`. Before LSE2 there is no native double-CAS on ARM64. You use `ldxp/stxp` loops.

#### POWER (PowerPC) Weakly Ordered

POWER allows even more reordering than ARM, including dependent load reordering through speculation (with hardware checking). Barriers:

- `lwsync` (lightweight sync). LoadLoad, LoadStore, StoreStore. NOT StoreLoad.
- `hwsync` (heavy sync, just `sync`). All four.
- `isync` (instruction sync). Pairs with a load and a control dependency to make an acquire fence. Cheaper than lwsync on some chips.

Mappings (POWER ELFv2 and IBM):

- acquire load: `ld; cmp; bc; isync`
- release store: `lwsync; std`
- seq_cst load: `hwsync; ld; cmp; bc; isync`
- seq_cst store: `lwsync; std; hwsync` (or leading hwsync)

POWER is the architecture where the cost of getting orderings right is most visible in cycle counts.

#### RISC-V

RISC-V's RVWMO model is closer to ARM than to x86. Barriers are `fence rw,rw` and friends. The "A" extension provides `lr.aq`/`sc.rl`-style acquire-release LR/SC pairs and AMO ops with `.aq`, `.rl`, `.aqrl` suffixes.

### Fence Cost Table

Approximate cycle counts on modern Intel Skylake/IceLake, AMD Zen 3, ARM Neoverse N1, and IBM POWER10. Numbers vary by microarchitecture and contention.

| Operation | x86 | ARMv8.4 | POWER10 |
|-----------|-----|---------|---------|
| relaxed load | 1 | 1 | 1 |
| acquire load | 1 | 1 (ldar) | 5-10 (ld+isync) |
| relaxed store | 1 | 1 | 1 |
| release store | 1 | 1 (stlr) | 5-10 (lwsync+st) |
| seq_cst store | 20-30 (mfence/xchg) | 5-10 (stlr + dmb on v8.0) | 20-40 (lwsync+st+hwsync) |
| acq_rel CAS uncontended | 15-25 (lock cmpxchg) | 10-20 (casal) | 20-40 (larx/stcx loop) |
| full fence | 20-30 (mfence) | 10-20 (dmb ish) | 30-50 (hwsync) |

Numbers blow up under contention. A contended `lock cmpxchg` on x86 can stretch to hundreds of cycles due to cache line bouncing.

### Compiler Output Examples

Producer-consumer pattern with acquire-release:

```cpp
#include <atomic>
std::atomic<int> flag{0};
int data;

void producer() {
    data = 42;
    flag.store(1, std::memory_order_release);
}

int consumer() {
    while (flag.load(std::memory_order_acquire) == 0) {}
    return data;
}
```

x86-64 GCC 13 -O2:
```
producer():
    mov     DWORD PTR data[rip], 42
    mov     DWORD PTR flag[rip], 1
    ret
consumer():
.L2:
    mov     eax, DWORD PTR flag[rip]
    test    eax, eax
    je      .L2
    mov     eax, DWORD PTR data[rip]
    ret
```

No fences. x86 TSO gives you acquire-release for free at the hardware level. Compiler still respects ordering for optimization purposes.

ARM64 GCC 13 -O2:
```
producer():
    adrp    x0, data
    mov     w1, 42
    str     w1, [x0, #:lo12:data]
    adrp    x0, flag
    mov     w1, 1
    stlr    w1, [x0]                ; store-release
    ret
consumer():
    adrp    x1, flag
.L2:
    ldar    w0, [x1]                ; load-acquire
    cbz     w0, .L2
    adrp    x0, data
    ldr     w0, [x0, #:lo12:data]
    ret
```

`stlr` and `ldar` do the work. No `dmb`.

Same code with seq_cst, ARM64 GCC 13 -O2 ARMv8.0:
```
producer():
    str     w1, [x0, #:lo12:data]
    mov     w1, 1
    stlr    w1, [x0]
    dmb     ish                     ; trailing fence for seq_cst
    ret
```

POWER GCC 13 -O2 acquire-release:
```
producer:
    li      9,42
    stw     9,0(3)                  ; store data
    li      9,1
    lwsync                          ; release barrier
    stw     9,0(4)                  ; store flag
    blr
consumer:
.L2:
    lwz     9,0(3)
    cmpwi   0,9,0
    beq     .L2
    isync                           ; acquire fence after dependent branch
    lwz     3,0(4)
    blr
```

Notice POWER pays `lwsync` and `isync` even for acq_rel.

### What the Compiler May NOT Do with Atomics

- May not introduce a load that did not exist (no spurious atomic loads).
- May not duplicate an atomic load (would change rf graph).
- May not remove an atomic store except via the "as-if" rule for irrelevant stores. In practice, removal of dead atomic stores is forbidden by all major compilers.
- May not tear or fuse atomics across width.
- May not promote a non-atomic store to atomic (would surprise hardware on some ISAs).

P0062 and the ongoing discussion in WG21 about compiler optimization of atomics document the exact rules. In practice, treat atomic ops as opaque to the optimizer.

### Junior at FAANG vs Senior at FAANG

Junior writes a benchmark, sees acq_rel and seq_cst perform the same on their x86 dev box, concludes "memory order does not matter for performance". Senior knows that x86 is a special case, runs the same benchmark on a Graviton or Ampere ARM machine, sees seq_cst is 2-3x slower than acq_rel under contention, files the perf gain. Senior also reads the godbolt output before committing any new lock-free primitive, on at least x86 and ARM64.
