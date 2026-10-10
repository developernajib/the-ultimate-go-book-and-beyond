## 3. The ABA Problem and Solutions

### What Is ABA?

The ABA problem is the most subtle pitfall in lock-free programming. Consider a CAS on a pointer:

1. Thread A reads `head = X`, where `X->next = Y`.
2. Thread A is preempted.
3. Thread B pops `X`, pops `Y`, pushes `Z`, then pushes `X` back (reusing the same memory address).
4. Thread A resumes. CAS sees `head == X` (success!), but `X->next` is now `Z`, not `Y`. The stack is corrupted.

CAS only checks the *value* of the pointer, not whether the state has changed and changed back. The value went A -> B -> A, hence "ABA."

### Solution 1: Tagged Pointers (Counter-Based)

Pair the pointer with a monotonically increasing counter. CAS both together atomically.

```cpp
#include <atomic>
#include <cstdint>
#include <optional>

template <typename T>
class ABAFreeStack {
    struct Node {
        T data;
        Node* next;
        Node(T val) : data(std::move(val)), next(nullptr) {}
    };

    // Pack pointer + counter into a single atomic unit
    struct TaggedPtr {
        Node* ptr;
        uintptr_t tag;  // Monotonic counter

        bool operator==(const TaggedPtr& other) const {
            return ptr == other.ptr && tag == other.tag;
        }
    };

    std::atomic<TaggedPtr> head_{{nullptr, 0}};

public:
    void push(T val) {
        Node* new_node = new Node(std::move(val));
        TaggedPtr old_head = head_.load(std::memory_order_relaxed);
        TaggedPtr new_head;

        do {
            new_node->next = old_head.ptr;
            new_head = {new_node, old_head.tag + 1};
        } while (!head_.compare_exchange_weak(
                     old_head, new_head,
                     std::memory_order_release,
                     std::memory_order_relaxed));
    }

    std::optional<T> pop() {
        TaggedPtr old_head = head_.load(std::memory_order_acquire);
        TaggedPtr new_head;

        do {
            if (!old_head.ptr) return std::nullopt;
            new_head = {old_head.ptr->next, old_head.tag + 1};
        } while (!head_.compare_exchange_weak(
                     old_head, new_head,
                     std::memory_order_acq_rel,
                     std::memory_order_acquire));

        T val = std::move(old_head.ptr->data);
        delete old_head.ptr;  // Safe if no other thread can re-read this node
        return val;
    }
};
```

**Caveat:** `TaggedPtr` is 16 bytes. On x86-64, `std::atomic<TaggedPtr>` requires `CMPXCHG16B` (double-width CAS). Check `is_lock_free()` to confirm. Some platforms do not support 16-byte atomic CAS natively.

### Solution 2: Hazard Pointers

Hazard pointers let each thread "announce" which nodes it is currently accessing. No node is freed while any thread's hazard pointer references it.

```cpp
#include <atomic>
#include <functional>
#include <vector>
#include <optional>
#include <algorithm>

// Simplified hazard pointer scheme
class HazardPointerDomain {
    static constexpr int MAX_THREADS = 64;

    struct HazardRecord {
        std::atomic<void*> ptr{nullptr};
        std::atomic<bool> active{false};
    };

    HazardRecord records_[MAX_THREADS];

public:
    // Acquire a hazard pointer slot
    class Guard {
        HazardRecord* record_;
    public:
        explicit Guard(HazardPointerDomain& domain) {
            for (auto& rec : domain.records_) {
                bool expected = false;
                if (rec.active.compare_exchange_strong(expected, true)) {
                    record_ = &rec;
                    return;
                }
            }
            throw std::runtime_error("No hazard pointer slots available");
        }

        template <typename T>
        T* protect(std::atomic<T*>& source) {
            T* ptr;
            do {
                ptr = source.load(std::memory_order_acquire);
                record_->ptr.store(ptr, std::memory_order_release);
                // Re-check: source may have changed between load and store
            } while (ptr != source.load(std::memory_order_acquire));
            return ptr;
        }

        void reset() {
            record_->ptr.store(nullptr, std::memory_order_release);
        }

        ~Guard() {
            record_->ptr.store(nullptr, std::memory_order_release);
            record_->active.store(false, std::memory_order_release);
        }
    };

    // Check if any thread has a hazard pointer to 'ptr'
    bool is_hazardous(void* ptr) const {
        for (const auto& rec : records_) {
            if (rec.active.load(std::memory_order_acquire) &&
                rec.ptr.load(std::memory_order_acquire) == ptr) {
                return true;
            }
        }
        return false;
    }

    // Reclaim nodes not protected by any hazard pointer
    template <typename T>
    void retire(T* ptr, std::vector<T*>& retired_list) {
        retired_list.push_back(ptr);

        if (retired_list.size() >= MAX_THREADS * 2) {
            auto it = std::remove_if(retired_list.begin(), retired_list.end(),
                [this](T* p) {
                    if (!is_hazardous(p)) {
                        delete p;
                        return true;
                    }
                    return false;
                });
            retired_list.erase(it, retired_list.end());
        }
    }
};
```

**Usage in a lock-free stack pop:**

```cpp
HazardPointerDomain hp_domain;

std::optional<T> pop() {
    HazardPointerDomain::Guard guard(hp_domain);

    while (true) {
        Node* old_head = guard.protect(head_);  // Announce we're reading this
        if (!old_head) return std::nullopt;

        Node* next = old_head->next;
        if (head_.compare_exchange_strong(old_head, next,
                std::memory_order_acq_rel)) {
            T val = std::move(old_head->data);
            guard.reset();
            // Retire, don't delete immediately
            hp_domain.retire(old_head, retired_nodes_);
            return val;
        }
    }
}
```

### Solution 3: Epoch-Based Reclamation (EBR)

EBR divides time into epochs. A thread enters an epoch when starting a lock-free operation and leaves when done. Memory is freed only when all threads have advanced past the epoch in which the node was retired.

```cpp
#include <atomic>
#include <vector>
#include <array>
#include <functional>

class EpochBasedReclamation {
    static constexpr int NUM_EPOCHS = 3;

    std::atomic<uint64_t> global_epoch_{0};

    struct ThreadState {
        std::atomic<uint64_t> local_epoch{0};
        std::atomic<bool> active{false};
        std::array<std::vector<std::function<void()>>, NUM_EPOCHS> garbage;
    };

    static thread_local ThreadState* tls_state_;
    std::vector<ThreadState*> all_threads_;
    std::atomic<int> thread_count_{0};

public:
    class Guard {
        EpochBasedReclamation& ebr_;
    public:
        explicit Guard(EpochBasedReclamation& ebr) : ebr_(ebr) {
            ebr_.enter();
        }
        ~Guard() { ebr_.leave(); }
    };

    void enter() {
        if (!tls_state_) register_thread();
        tls_state_->active.store(true, std::memory_order_relaxed);
        uint64_t epoch = global_epoch_.load(std::memory_order_acquire);
        tls_state_->local_epoch.store(epoch, std::memory_order_release);
    }

    void leave() {
        tls_state_->active.store(false, std::memory_order_release);
        try_advance_epoch();
    }

    template <typename T>
    void retire(T* ptr) {
        uint64_t epoch = global_epoch_.load(std::memory_order_acquire);
        tls_state_->garbage[epoch % NUM_EPOCHS].push_back(
            [ptr]() { delete ptr; }
        );
    }

private:
    void register_thread() {
        tls_state_ = new ThreadState();
        // In production, use a lock or lock-free list to register
    }

    void try_advance_epoch() {
        uint64_t current = global_epoch_.load(std::memory_order_acquire);
        // Check if all threads have observed the current epoch
        for (auto* ts : all_threads_) {
            if (ts->active.load(std::memory_order_acquire) &&
                ts->local_epoch.load(std::memory_order_acquire) != current) {
                return;  // Some thread is behind
            }
        }
        // All threads are current. Advance epoch.
        uint64_t new_epoch = current + 1;
        if (global_epoch_.compare_exchange_strong(current, new_epoch)) {
            // Safe to free garbage from two epochs ago
            uint64_t safe_epoch = new_epoch % NUM_EPOCHS;
            for (auto* ts : all_threads_) {
                for (auto& deleter : ts->garbage[safe_epoch]) {
                    deleter();
                }
                ts->garbage[safe_epoch].clear();
            }
        }
    }
};
```

### Comparison of Reclamation Schemes

| Scheme | Overhead per Op | Worst-Case Memory | Bounded? | Complexity |
|-----------------|-----------------|-------------------|---------------|------------|
| Tagged Pointers | Counter bump | Low | Yes | Low |
| Hazard Pointers | HP scan | O(threads * HP) | Yes | Medium |
| Epoch-Based | Epoch check | Unbounded* | No | Medium |
| Reference Count | Atomic inc/dec | Bounded | Yes | Low-Medium |

*EBR can accumulate garbage if a thread stalls inside a critical section.

### Junior → FAANG: Recognizing ABA Without Implementing the Fix

The ABA problem is a standard FAANG interview topic. Know the scenario: thread A reads pointer P pointing to node X. Thread B dequeues X, frees it, allocates a new node (which gets the same address), and enqueues it. Thread A's CAS on P succeeds because it sees the same pointer value, even though the underlying node has changed.

For the interview: describe ABA clearly, then describe two fixes. The simplest: tagged pointers (store a counter in unused pointer bits, increment on every CAS). The more correct for general cases: hazard pointers or epoch-based reclamation. You do not need to implement hazard pointers from scratch. Knowing why they solve ABA (a pointer in a hazard slot cannot be freed by any thread) is sufficient at L4.

The one sentence that passes the ABA question: "ABA happens because pointer equality does not imply identity after free and reallocation. The fix is to prevent reclamation of a pointer while any thread holds a reference to it, either via tagged pointers or hazard pointers."

### Senior @ FAANG: ABA in Production and Reclamation Strategy Selection

At L5+, ABA is not a theoretical concern, it is a real bug category with production incidents at FAANG. The question is not "do you know what ABA is?" but "what reclamation strategy does your lock-free data structure use, and why?"

Hazard pointers (`std::hazard_pointer` in C++26, or Folly's `hazptr`): each reader publishes a hazard pointer for every node it is accessing. Reclaimers scan the hazard table before freeing. Memory overhead is O(threads * max_hazard_pointers_per_thread). Latency overhead is one read barrier per hazardous access. Best for read-heavy structures with low writer frequency.

Epoch-based reclamation (EBR, used in Folly and many production systems): threads announce their current epoch when entering a read section. Reclaimers accumulate freed nodes in epoch-specific lists and free them only when all threads have advanced past that epoch. Lower overhead than hazard pointers in the common case, but a stalled thread blocks reclamation for its epoch indefinitely. Best for high-throughput structures where threads are always active.

Reference counting (used in `std::shared_ptr`): each node carries a reference count. Freed when count reaches zero. No deferred reclamation needed. But reference count updates are themselves atomic CAS operations, adding cost to every access. Best for low-frequency access patterns where the bookkeeping cost is acceptable.

ADR decision: for a new lock-free structure, the reclamation strategy selection should be documented with: (1) measured memory overhead at expected thread count, (2) measured latency overhead on the read path, (3) behavior under thread stall scenarios (stalled thread with EBR blocks reclamation indefinitely), and (4) C++ standard version availability (hazard pointers are C++26, requiring Folly or similar for earlier standards).

---
