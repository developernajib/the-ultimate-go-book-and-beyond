## compare_exchange: Strong vs Weak

`compare_exchange_strong` and `compare_exchange_weak` are the two CAS forms in C++. The difference is one word in the standard but the implications run from microarchitecture up to algorithm correctness.

### The Signatures

```cpp
template<class T>
class atomic {
    bool compare_exchange_weak(T& expected, T desired,
        memory_order success, memory_order failure);
    bool compare_exchange_strong(T& expected, T desired,
        memory_order success, memory_order failure);
};
```

Both ops:

1. Atomically compare the current value to `expected`.
2. If equal, replace with `desired`, return true.
3. If not equal, write current value into `expected`, return false.

The `failure` order applies to the load when the compare fails. It cannot be `release` or `acq_rel`. A common idiom is `success=acq_rel, failure=acquire`.

### The Difference

`compare_exchange_strong` is guaranteed to succeed if and only if the comparison succeeds. No spurious failure.

`compare_exchange_weak` may fail spuriously. That is, even if the value equals `expected`, the operation may report failure and leave the variable unchanged (with `expected` updated to the current value, which equals what it already was).

This sounds like weak is strictly worse. It is not. Weak maps to one machine instruction sequence (LL/SC retry) on architectures that do not have a native CAS. Strong on those architectures must implement a retry loop internally, which is wasteful when the caller already has its own retry loop.

### LL/SC Architectures

ARM (before LSE), POWER, and RISC-V provide load-linked / store-conditional pairs.

```
ldxr x0, [x1]          ; load-exclusive, sets up monitor
... compute ...
stxr w2, x3, [x1]      ; store-exclusive, w2 = 0 if success, 1 if fail
```

The store-conditional fails if any of:

- Another core wrote to the cache line.
- The line was evicted (cache miss, even unrelated).
- An exception or interrupt occurred between LL and SC.
- A different LL/SC pair on the same core was nested inside.
- The platform's "monitor" was cleared for any reason (some implementations clear on context switch, some on TLB invalidation, some on adjacent line touches).

Spurious failure is real and frequent on these architectures. Especially context switches and unrelated cache evictions cause LL/SC failure that has nothing to do with contention.

`compare_exchange_strong` on ARMv8.0 must wrap the LL/SC in a loop that distinguishes "value mismatch" from "spurious failure":

```
.Lretry:
    ldxr    x0, [x1]              ; LL
    cmp     x0, expected
    bne     .Lfail                ; real mismatch, exit
    stxr    w2, desired, [x1]     ; SC
    cbnz    w2, .Lretry           ; spurious, retry
    ; success
```

`compare_exchange_weak` skips the inner retry. If the SC fails for any reason, the call returns false with `expected` updated to the value just observed. The caller's outer retry loop handles all failures uniformly:

```cpp
T cur = x.load(std::memory_order_relaxed);
do {
    T next = transform(cur);
} while (!x.compare_exchange_weak(cur, next, std::memory_order_acq_rel));
```

This is the canonical CAS retry. With weak, the inner SC failure folds into the outer retry. With strong, you pay a doubly-nested loop.

On x86, `cmpxchg` is a single instruction that has no spurious failure. Strong and weak compile to the same code. The only difference on x86 is a missed micro-optimization: the compiler can sometimes elide a register copy in the weak case.

LSE (ARMv8.1) added `cas` instruction which has no spurious failure. On LSE-capable cores, strong and weak also compile to the same `casal` instruction.

### When Weak is Wrong

Weak inside a non-loop context. If you do not loop, a spurious failure becomes a real failure observable by the caller.

```cpp
// BUG. Single try, no loop.
bool acquired = x.compare_exchange_weak(expected, desired, ...);
if (acquired) { ... }
else { /* may falsely take this branch */ }
```

If you have no retry loop, use strong.

### ABA in CAS

CAS compares values, not identities. If a value goes A then B then back to A, a CAS expecting A succeeds even though the variable was modified. This is the ABA problem.

```cpp
// Treiber stack pop, naive
Node* head_local = head.load();
do {
    if (!head_local) return nullptr;
    Node* next = head_local->next;
} while (!head.compare_exchange_weak(head_local, next));
return head_local;
```

If between the load of `head_local->next` and the CAS, another thread pops head_local, pushes other nodes, and pushes head_local back, the CAS succeeds. But `next` is stale, pointing into freed memory or a relocated node.

Defenses:

1. **Tagged pointers**. Pack a counter in unused bits of the pointer (top 16 bits on x86-64). Increment on every modification. CAS compares the full word, so ABA on the value alone does not match.

2. **Hazard pointers**. Reader publishes the pointer it is reading. Reclaimer checks all hazard pointers before freeing.

3. **Epoch-based reclamation**. Defer free until all threads have passed an epoch boundary.

4. **Double-CAS / cmpxchg16b**. CAS on 128 bits, packing pointer and counter without stealing bits.

### Double-CAS

x86-64 has `cmpxchg16b`, which atomically compares and exchanges 128 bits aligned at 16 bytes. C++ exposes this as `std::atomic<T>` for T of size 16 with appropriate alignment, when `is_lock_free()` returns true.

```cpp
struct alignas(16) Tagged {
    Node* ptr;
    uintptr_t tag;
};

std::atomic<Tagged> head;

// pop
Tagged old_head = head.load(std::memory_order_acquire);
Tagged new_head;
do {
    if (!old_head.ptr) return nullptr;
    new_head.ptr = old_head.ptr->next;
    new_head.tag = old_head.tag + 1;
} while (!head.compare_exchange_weak(old_head, new_head,
                                      std::memory_order_acq_rel));
```

The tag prevents ABA. As long as the tag does not wrap (64 bits at GHz speeds, that is centuries), ABA is impossible.

GCC and Clang need `-mcx16` for cmpxchg16b. Older AMD chips lacked it. Modern hardware has it universally. Some compilers emit a libatomic call (slow!) if cmpxchg16b is not enabled. Always check the disassembly.

ARM64 does not have a 16-byte CAS until ARMv8.4 with LSE2 added 16-byte single-copy atomic loads/stores via `ldp`/`stp`, but the only native CAS on 16 bytes is `casp` (compare and swap pair) added in LSE. `casp` operates on two adjacent 64-bit registers.

ARMv8.0 to ARMv8.3 ARM users implement double-CAS via `ldxp`/`stxp` (load/store exclusive pair):

```
.Lretry:
    ldxp    x0, x1, [x4]          ; load 16 bytes exclusively
    cmp     x0, x2                ; compare low half
    bne     .Lfail
    cmp     x1, x3                ; compare high half
    bne     .Lfail
    stxp    w5, x6, x7, [x4]      ; store-exclusive pair
    cbnz    w5, .Lretry
```

Spurious failure on ldxp/stxp is more common than on single-word LL/SC because the cache footprint is bigger.

### Failure Memory Order Constraints

The standard requires:

- `failure` order cannot be stronger than `success` order.
- `failure` cannot be `release` or `acq_rel` (failure is a load, not a store).

Common patterns:

```cpp
// Producer hands off
x.compare_exchange_weak(expected, desired,
    std::memory_order_acq_rel,    // success: full sync
    std::memory_order_relaxed);   // failure: just retry

// Consumer probes
x.compare_exchange_weak(expected, desired,
    std::memory_order_acq_rel,
    std::memory_order_acquire);   // observe what changed
```

Choose failure order based on what you do with `expected` after a failure. If you read it and then loop without using non-atomic state, relaxed is enough. If you compute something and use it to decide branch behavior, acquire makes sense.

### Junior at FAANG vs Senior at FAANG

Junior writes `compare_exchange_strong` everywhere "to be safe". Senior writes `compare_exchange_weak` inside retry loops because:

- On ARM and POWER, weak avoids the doubly-nested loop.
- On x86 they compile identically, no penalty.
- It documents the algorithm: "I expect to retry on any failure".

Senior's code review heuristic: every `compare_exchange_strong` outside a single-shot context is a bug. Every `compare_exchange_weak` outside a loop is a bug.
