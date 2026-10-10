## Common Mistakes and Pitfalls

### Torn Reads

A torn read occurs when a thread reads a value that is partially updated, some bytes from the old value, some from the new. This happens when accessing non-atomic types that span multiple machine words.

```cpp
// WRONG: uint64_t on a 32-bit platform is TWO 32-bit loads
// A concurrent write can update one half between the two loads
uint64_t shared_counter = 0; // Non-atomic!

void writer() {
    shared_counter = 0xDEADBEEF'CAFEBABE; // Two 32-bit stores on 32-bit platform
}

void reader() {
    uint64_t val = shared_counter; // Two 32-bit loads on 32-bit platform
    // Possible torn reads:
    // 0x00000000'CAFEBABE  (low word updated, high word not yet)
    // 0xDEADBEEF'00000000  (high word updated, low word not yet)
}

// FIX: Use std::atomic<uint64_t>
std::atomic<uint64_t> safe_counter{0};
```

On 64-bit platforms, `uint64_t` loads and stores are naturally atomic on most architectures, but the C++ standard does NOT guarantee this. Always use `std::atomic` for shared data.

### The ABA Problem

The ABA problem occurs in CAS-based lock-free algorithms when a value changes from A to B and back to A. A thread performing CAS sees the value is "still A" and succeeds, but the underlying state has changed.

```cpp
#include <atomic>
#include <thread>
#include <iostream>

// Simplified lock-free stack that is VULNERABLE to ABA
struct Node {
    int data;
    Node* next;
};

std::atomic<Node*> head{nullptr};

void push(Node* node) {
    node->next = head.load();
    while (!head.compare_exchange_weak(node->next, node)) {}
}

Node* pop() {
    Node* old_head = head.load();
    while (old_head && !head.compare_exchange_weak(old_head, old_head->next)) {}
    return old_head;
}

// ABA scenario:
// Stack: A -> B -> C
//
// Thread 1: pop() - reads old_head = A, old_head->next = B
//           (gets preempted before CAS)
//
// Thread 2: pop() A, pop() B, push() A (reuses Node A with different data)
//           Stack is now: A -> C
//
// Thread 1: resumes, CAS succeeds because head is still A
//           Sets head = B, but B was freed!
//           USE AFTER FREE - undefined behavior
```

**Solutions to ABA**:

1. **Tagged pointers**: Pack a version counter into unused bits of the pointer.

```cpp
#include <atomic>
#include <cstdint>

// Use the upper 16 bits of a 64-bit value as a version counter
// (assumes pointers only use 48 bits, which is true on current x86-64)
struct TaggedPointer {
    uintptr_t value;

    TaggedPointer() : value(0) {}
    TaggedPointer(Node* ptr, uint16_t tag)
        : value(reinterpret_cast<uintptr_t>(ptr) | (static_cast<uintptr_t>(tag) << 48)) {}

    Node* ptr() const {
        return reinterpret_cast<Node*>(value & 0x0000FFFFFFFFFFFF);
    }

    uint16_t tag() const {
        return static_cast<uint16_t>(value >> 48);
    }
};

// CAS on the entire TaggedPointer - if the tag changed, CAS fails
std::atomic<TaggedPointer> tagged_head;

Node* safe_pop() {
    TaggedPointer old_head = tagged_head.load();
    while (true) {
        if (!old_head.ptr()) return nullptr;
        TaggedPointer new_head(old_head.ptr()->next, old_head.tag() + 1);
        if (tagged_head.compare_exchange_weak(old_head, new_head)) {
            return old_head.ptr();
        }
    }
}
```

2. **Hazard pointers**: Register pointers that are "in use" so other threads cannot free them.
3. **Epoch-based reclamation**: Defer freeing memory until no thread can hold a reference.
4. **`std::atomic<std::shared_ptr<T>>`** (C++20): Provides safe atomic operations on shared pointers with built-in lifetime management.

### Forgetting volatile Is Not Atomic

A common misconception from C and Java programmers. In C++, `volatile` means "don't optimize away reads/writes to this variable", it says nothing about atomicity or memory ordering.

```cpp
// WRONG: volatile does NOT make this thread-safe
volatile int counter = 0;

void increment() {
    counter++; // NOT atomic: load, add, store - can race
}

// RIGHT: use std::atomic
std::atomic<int> safe_counter{0};

void safe_increment() {
    safe_counter.fetch_add(1, std::memory_order_relaxed); // Truly atomic
}
```

### Over-Synchronization

Using `seq_cst` everywhere when `relaxed` would suffice:

```cpp
// SLOW: seq_cst on a hot counter path
std::atomic<uint64_t> request_count{0};

void handle_request() {
    // This emits MFENCE on x86 - unnecessary for a simple counter
    request_count.fetch_add(1); // Default: memory_order_seq_cst
}

// FAST: relaxed for a counter that doesn't synchronize other data
void handle_request_fast() {
    request_count.fetch_add(1, std::memory_order_relaxed);
}
```

### Under-Synchronization: The Subtle Bug

Using `relaxed` when you actually need acquire/release:

```cpp
// BUG: Relaxed ordering doesn't synchronize the message data
std::string message;
std::atomic<bool> ready{false};

void producer() {
    message = "important data";
    ready.store(true, std::memory_order_relaxed); // BUG: should be release
}

void consumer() {
    while (!ready.load(std::memory_order_relaxed)) {} // BUG: should be acquire
    std::cout << message << "\n"; // UNDEFINED: may see empty or partial string
}
```

### Junior → FAANG: The Three Mistakes That Trip Up Every Junior Writing Atomics

The three most common mistakes in atomic code from engineers new to C++:

First, treating `std::atomic<T>` as a magic thread-safe wrapper. An atomic gives you atomic individual operations, not atomic compound operations. `if (x.load() > 0) x.fetch_sub(1)` is not atomic as a unit. Between the load and the fetch_sub, another thread can intervene. Use CAS for check-then-act.

Second, using `volatile` instead of `std::atomic` for inter-thread communication. `volatile` in C++ prevents the compiler from caching the variable in a register, but it provides no memory ordering guarantees and no atomicity guarantee. This mistake compiles silently and fails intermittently on ARM.

Third, forgetting that `compare_exchange_weak` can fail spuriously. It requires a retry loop. `compare_exchange_strong` does not spuriously fail but may be slower. In a retry loop, always use weak. In a one-shot comparison, use strong.

### Senior @ FAANG: Pitfall Patterns That Escape Code Review and Bite in Production

At L5+, the pitfalls that matter are the ones that pass code review, pass TSan, and still cause production incidents:

The ABA problem in CAS-based structures: two threads simultaneously see value A, one changes it to B then back to A, and the second thread's CAS succeeds on the "original" A even though the underlying state has changed. This is invisible to TSan. The fix requires either tagged pointers or hazard pointers. The risk is highest in lock-free memory allocators where pointer values are reused.

Ordering bugs that only manifest on non-TSO hardware: TSan validates happens-before edges, but a relaxed load that should be acquire will pass TSan on x86 because x86 TSO guarantees prevent the reordering. The same code on ARM (Graviton, Apple Silicon) will exhibit the race. The only reliable detection is running TSan on ARM in CI, or using a memory model litmus test tool.

Lock-free code that is correct at low concurrency but exhibits live-lock at high concurrency: a CAS retry loop that always retries immediately under high contention causes CAS storms. The thread that most recently wrote wins the next CAS, causing all other threads to retry forever in the worst case. The fix is exponential backoff or yielding on CAS failure. This is a performance cliff, not a correctness bug, but it can take a service from 95th-percentile acceptable to p99 unacceptable under load.

Bar-raiser expectation: in a design review of a CAS loop, ask "what is the retry strategy?" and "what is the worst-case livelock scenario?" If the answer is "retry immediately," follow up with a load scenario at 64 threads and ask whether the team has benchmarked that case. The absence of a retry strategy is a production readiness gap.

---
