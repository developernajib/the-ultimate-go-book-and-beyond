## ABA and Tagged Pointers

The ABA problem is the canonical bug in lock-free code. A thread reads value A, plans to CAS A to C, but between the read and the CAS the value changes A -> B -> A. The CAS succeeds because the value matches, but the surrounding state is different. The algorithm corrupts.

### Concrete ABA in a Stack

```cpp
// Thread 1: pop()
Node* old = head_.load();        // old = A
Node* next = old->next;          // next = B
// Thread 1 preempted

// Thread 2: pop() pop() push(A_reused)
// Stack was A -> B -> C
// After T2: stack is A -> C (because B was popped, then A reused as a new node pointing to C)

// Thread 1 resumes
head_.compare_exchange_strong(old, next);
// Succeeds! head was A, now it is set to B.
// But B is no longer in the stack. Corruption.
```

The pointer comparison succeeded but the semantic state changed. CAS only checks bitwise equality, not "has anyone touched this since I read it".

### Where ABA Bites

Stacks. Pop reads head, reads head->next, then CASes. If head was popped and the same node reused, head->next is stale.

Queues. MSQueue's tail-and-next CAS is vulnerable. The tail might be reused as a different node before the helper-CAS lands.

Freelists. The classic ABA scenario: a node is popped from the freelist, used, returned to the freelist, all while another thread has it cached. The other thread's CAS succeeds but the freelist topology changed.

Counters wrapped in custom indexes. If a slot index can be recycled, an indexed structure has the same ABA risk as a pointer.

### Solution 1: Tagged Pointers (Counted Pointers)

Pair every pointer with a counter that increments on each modification. A 64-bit tagged pointer has 48 bits of pointer (the canonical address space on x86_64) and 16 bits of tag.

```cpp
struct TaggedPointer {
    uintptr_t bits;
    void* ptr() const {
        intptr_t p = bits & 0x0000FFFFFFFFFFFFLL;
        // sign-extend bit 47
        if (p & (1LL << 47)) p |= 0xFFFF000000000000LL;
        return reinterpret_cast<void*>(p);
    }
    uint16_t tag() const { return bits >> 48; }
    static TaggedPointer make(void* p, uint16_t t) {
        return {(reinterpret_cast<uintptr_t>(p) & 0x0000FFFFFFFFFFFFLL) |
                (uintptr_t{t} << 48)};
    }
};
static_assert(sizeof(TaggedPointer) == 8);
```

Every CAS that modifies the pointer also increments the tag. The same pointer with different tags compares unequal, defeating ABA.

```cpp
std::atomic<TaggedPointer> head_;

bool pop(T& out) {
    TaggedPointer old = head_.load(std::memory_order_acquire);
    while (true) {
        Node* p = static_cast<Node*>(old.ptr());
        if (!p) return false;
        TaggedPointer fresh = TaggedPointer::make(p->next, old.tag() + 1);
        if (head_.compare_exchange_weak(old, fresh,
                std::memory_order_acq_rel)) {
            out = std::move(p->value);
            return true;
        }
    }
}
```

The 16-bit tag wraps every 65536 modifications. For most workloads this is enough. ABA requires the tag to wrap exactly between a thread's load and CAS, with the same pointer reappearing. The probability is roughly 1 in 2^16 per CAS retry, multiplied by the probability of pointer collision. Acceptable for general-purpose use.

For high-throughput allocators that recycle pointers millions of times per second, 16 bits is too narrow. Move to double-word CAS.

### Solution 2: Double-Word CAS (cmpxchg16b)

x86_64 supports `cmpxchg16b`, a CAS over 16 bytes. C++ exposes it via `std::atomic<T>` for 16-byte trivially-copyable T, provided the compiler emits the instruction (GCC requires `-mcx16`, MSVC supports it natively).

```cpp
struct Counted {
    void* ptr;
    uint64_t tag;
};
static_assert(sizeof(Counted) == 16);

std::atomic<Counted> head_;

bool pop(T& out) {
    Counted old = head_.load(std::memory_order_acquire);
    while (true) {
        if (!old.ptr) return false;
        Node* p = static_cast<Node*>(old.ptr);
        Counted fresh{p->next, old.tag + 1};
        if (head_.compare_exchange_weak(old, fresh,
                std::memory_order_acq_rel)) {
            out = std::move(p->value);
            return true;
        }
    }
}
```

64 bits of tag never wrap in any practical timeframe (at 1 billion CAS/sec, wrap takes 584 years). The downside is performance: `cmpxchg16b` is roughly 2x slower than `cmpxchg8b` on Intel, around 30-40 cycles uncontended.

ARMv8 supports double-word CAS via `casp` (compare-and-swap pair) introduced in ARMv8.1-LSE. Without LSE, the compiler emits an LL/SC loop that is functionally equivalent but slower under contention.

### Solution 3: Hazard Pointers / EBR

Reclamation-based ABA prevention. If you never reuse a pointer until all readers have released it, ABA cannot happen by definition. The pointer remains unique for its entire lifetime.

This is why hazard pointers and EBR are usually presented together with lock-free algorithms. They solve the memory reclamation problem and the ABA problem simultaneously.

```cpp
bool pop(T& out) {
    hazard_pointer h = make_hazard_pointer();
    while (true) {
        Node* old = h.protect(head_);
        if (!old) return false;
        Node* next = old->next.load(std::memory_order_acquire);
        if (head_.compare_exchange_weak(old, next,
                std::memory_order_acq_rel)) {
            out = std::move(old->value);
            old->retire();
            return true;
        }
    }
}
```

No tag needed. The hazard pointer guarantees `old` is not freed and reused while we hold a reference to it.

### Solution 4: Pointer Tag Hijacking on x86_64

x86_64 canonical addresses use only 48 bits (or 57 with 5-level paging). The top 16 bits must equal bit 47 (sign extension). User space cannot use bit 47, so user pointers always have the top 16 bits zero. This gives 16 free bits per pointer with no extra storage.

```cpp
class PtrTag {
    static constexpr uint64_t kPtrMask = 0x0000FFFFFFFFFFFFULL;
    static constexpr uint64_t kTagMask = 0xFFFF000000000000ULL;

    static uintptr_t pack(void* p, uint16_t tag) {
        return (reinterpret_cast<uintptr_t>(p) & kPtrMask) |
               (uintptr_t{tag} << 48);
    }
    static void* unpack_ptr(uintptr_t bits) {
        return reinterpret_cast<void*>(bits & kPtrMask);
    }
    static uint16_t unpack_tag(uintptr_t bits) {
        return static_cast<uint16_t>(bits >> 48);
    }
};
```

This works on Linux, FreeBSD, and Windows user space. The kernel uses the top half of the address space, kernel code cannot do this trick.

Two caveats. First, future Intel 5-level paging extends user addresses to 57 bits, leaving only 7 free bits. Linux currently opts in via mmap hint. Most production code today still uses 4-level paging, but new servers may break this assumption.

Second, Linear Address Masking (LAM) on Sapphire Rapids and ARM TBI both use the high bits for pointer tagging via hardware. Software that hijacks the same bits conflicts with these features.

### Pointer Tagging on ARM64 TBI

ARM64 Top Byte Ignore is a hardware feature. The CPU ignores the top 8 bits of every load/store address. Software can stash 8 bits of tag in pointers and dereference them directly without masking.

```cpp
#if defined(__aarch64__)
template <typename T>
T* tag_ptr(T* p, uint8_t tag) {
    return reinterpret_cast<T*>(
        (reinterpret_cast<uintptr_t>(p) & 0x00FFFFFFFFFFFFFFULL) |
        (uintptr_t{tag} << 56));
}

template <typename T>
T* untag_ptr(T* p) {
    return reinterpret_cast<T*>(
        reinterpret_cast<uintptr_t>(p) & 0x00FFFFFFFFFFFFFFULL);
}
#endif
```

TBI must be enabled per-process via prctl(PR_SET_TAGGED_ADDR_CTL). With TBI on, `*tagged_p` works without explicit untagging. With TBI off, dereferencing a tagged pointer faults.

8 bits of tag on ARM versus 16 bits on x86 is enough for ABA defense in low-contention scenarios but tight at scale. ARMv8.5 added MTE (Memory Tagging Extension) which uses TBI for hardware-checked memory safety, conflicting with software ABA tagging on the same bits.

### Pointer Authentication Interaction

ARMv8.3 added Pointer Authentication Codes (PAC). The instruction `pacia` signs a pointer with a key and embeds the signature in the high bits. `autia` verifies and strips the signature. Used for hardening function pointers (return addresses, vtables) against ROP attacks.

PAC consumes the same high bits TBI uses. A signed pointer cannot also carry an ABA tag in the same bits. Production code that uses both must allocate them in different bit ranges, typically PAC in bits 56-62 and ABA tag in bits 48-55.

```cpp
#if defined(__ARM_FEATURE_PAUTH)
struct PacAndTag {
    static constexpr int kPacBits = 7;
    static constexpr int kTagBits = 8;
    static constexpr uint64_t kTagShift = 48;
    static constexpr uint64_t kTagMask = ((1ULL << kTagBits) - 1) << kTagShift;

    static void* sign_and_tag(void* p, uint8_t tag) {
        void* signed_p = __builtin_ptrauth_sign_unauthenticated(p, 0, 0);
        return reinterpret_cast<void*>(
            (reinterpret_cast<uintptr_t>(signed_p) & ~kTagMask) |
            (uintptr_t{tag} << kTagShift));
    }
};
#endif
```

This is fragile. Most production lock-free code on ARM64 either disables PAC for the structure or uses 128-bit CAS via LSE.

### Senior at FAANG: When ABA Cannot Hurt You

Not every lock-free algorithm is ABA-vulnerable. ABA matters when the algorithm makes a decision based on a pointer-equality check expecting state-equivalence.

A counter `fetch_add` is immune to ABA because there is no pointer involved.

A stack with an immutable head (no pop, only push) is immune because pushed nodes are never reused.

A queue with monotonic indices (Vyukov's MPMC bounded ring uses sequence numbers, not pointers) is immune because the sequence number cannot return to a previous value.

A structure that uses `exchange` instead of CAS for the critical update is sometimes immune because `exchange` does not check the prior value. Vyukov's MPSC uses this: the producer side never CASes, only swaps.

Recognizing immunity saves you from paying tagged-pointer or hazard-pointer overhead unnecessarily.

### Junior to FAANG: ABA Is Not About Pointers

Pointers are the most common ABA vector but not the only one. Any value that can return to its prior bit pattern is at risk.

A 32-bit version counter that wraps is ABA-vulnerable. A flag that toggles between TRUE and FALSE is ABA-vulnerable if the algorithm depends on the transition history. A data field reused with the same content has the same problem.

The general rule: if your CAS is checking that "nothing has changed", and "nothing has changed" is implemented as bitwise equality, you are ABA-vulnerable whenever the bits can return to their prior value.

### Cost Comparison

| Strategy | CAS overhead | Memory overhead | Notes |
| --- | --- | --- | --- |
| 16-bit tag in pointer | 0 cycles | 0 bytes | Tag wrap risk at high throughput |
| 64-bit tag (DCAS) | 15-25 cycles vs single CAS | 8 bytes per pointer | Safe, slower |
| Hazard pointers | 30-50 cycles per protect | bounded retired list | Solves ABA + reclamation |
| EBR | 5-10 cycles per pin | unbounded if thread stalls | Solves ABA + reclamation |
| TBI / pointer hijacking | 0 cycles | 0 bytes | Conflicts with PAC, MTE, LAM |

Default to EBR or hazard pointers. They solve reclamation anyway. Reach for tagged pointers only when you have a custom allocator that cannot integrate with HP/EBR.
