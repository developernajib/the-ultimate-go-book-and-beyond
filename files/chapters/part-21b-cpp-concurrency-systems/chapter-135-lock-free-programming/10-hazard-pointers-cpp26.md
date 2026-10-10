## Hazard Pointers with C++26 `std::hazard_pointer`

Safe memory reclamation is the hardest part of lock-free programming. CAS tells you the pointer did not change, but it cannot tell you whether another thread is still reading the object you are about to free. Hazard pointers, standardized in C++26 as `std::hazard_pointer` and `std::hazard_pointer_obj_base`, solve this with bounded memory overhead and wait-free reads.

### Core idea

Each reader publishes the pointer it is about to dereference into a per-thread hazard slot. Writers enqueue retired objects onto a thread-local retired list. When the list grows past a threshold, the writer scans all hazard slots, any retired object whose address does not appear in any slot is safe to free. The scan is O(H + R), H = hazard slots, R = retired objects, and frees amortize to constant time per reclamation.

### C++26 API

```cpp
#include <hazard_pointer>
#include <atomic>

struct Node : std::hazard_pointer_obj_base<Node> {
    int value;
    std::atomic<Node*> next{nullptr};
};

class HPStack {
public:
    void push(int v) {
        auto* n = new Node{{}, v, {}};
        Node* head = head_.load(std::memory_order_relaxed);
        do {
            n->next.store(head, std::memory_order_relaxed);
        } while (!head_.compare_exchange_weak(head, n,
                     std::memory_order_release, std::memory_order_relaxed));
    }

    std::optional<int> pop() {
        std::hazard_pointer hp = std::make_hazard_pointer();
        Node* head;
        while (true) {
            head = hp.protect(head_);               // publish + reload
            if (!head) return std::nullopt;
            Node* next = head->next.load(std::memory_order_acquire);
            if (head_.compare_exchange_weak(head, next,
                    std::memory_order_acq_rel, std::memory_order_relaxed)) {
                break;
            }
        }
        int v = head->value;
        head->retire();                             // safe, freed when no HP protects it
        return v;
    }

private:
    std::atomic<Node*> head_{nullptr};
};
```

`hp.protect(head_)` atomically publishes the loaded value into the hazard slot and returns it after verifying the source has not changed. `retire()` defers the delete until no hazard pointer references the node.

### Why hazard pointers beat reference counting

Reference-counted lock-free structures require `atomic<shared_ptr<T>>`, which is typically implemented with a mutex or split counter and serializes cache-line writes between readers. Hazard pointers require only a relaxed store per read, readers never write to shared state. On a 64-core box reading a lock-free queue, hazard pointers deliver near-linear scaling, `shared_ptr`-based reclamation plateaus around 8 cores.

### Tuning the retired-list threshold

The threshold controls reclamation latency versus scan overhead. Default implementations (libstdc++ 15, folly) use `2 * H`, meaning twice the number of hazard slots. For a producer-consumer queue with millions of ops per second, raise the threshold to amortize scans over larger batches. Folly exposes `hazptr_obj_batch` for this purpose, standard C++26 does not yet, so expect vendor extensions.

### Comparison with EBR and RCU

Epoch-based reclamation (EBR) is faster under light read contention because it has no per-read publish cost, but a single stalled reader can block all reclamation indefinitely. RCU is fastest of all for reads (zero synchronization) but writers must synchronize against a grace period, which costs a full barrier per retirement. Hazard pointers occupy the middle ground: bounded unreclaimed memory, wait-free reads, no global barriers. Use EBR for burst workloads, RCU for read-mostly kernels, hazard pointers for mixed read/write at high concurrency.

### Common pitfalls

Do not dereference a pointer before `protect` returns, the window between load and publish is where other threads may retire and free the node. Do not hold a hazard pointer across blocking calls, you will stall reclamation globally. And never store the hazard slot, it is thread-local by contract.

With C++26 bringing hazard pointers into the standard, lock-free code finally has a portable, production-grade reclamation primitive. Adopt it over hand-rolled schemes in new code.

### Junior → FAANG: Hazard Pointers as the Answer to "Why Can't We Just Free the Node?"

The junior question that comes up every time: after a CAS removes a node from the structure, can't we just free it? No. Another thread may still hold a raw pointer to it (it read the pointer before the CAS fired). Freeing it causes use-after-free.

Hazard pointers solve this by letting each reader publish "I am currently accessing this pointer" before dereferencing it. Reclaimers scan the published hazard table before freeing any node. If the pointer appears in any hazard slot, reclamation is deferred.

The mental model: a hazard pointer is a voluntary "I am using this" flag that the reader sets before dereference and clears after. It is a lightweight, distributed reference counting scheme with O(threads) scan cost on the writer side.

### Senior @ FAANG: Hazard Pointer Library Selection for Production

At L5+, the decision between Folly's `hazptr`, custom EBR, and `std::hazard_pointer` (C++26) is a platform decision. Folly's `hazptr` is battle-tested at Meta scale with domain separation, preventing stalled threads in one domain from blocking reclamation in another. It is the most mature option for production use today (C++17 compatible).

`std::hazard_pointer` (C++26) provides portability and reduces Folly dependency. As of 2025, compiler support is experimental. For production fleets, verify support before adopting.

ADR for hazard pointer vs. EBR: document the maximum number of concurrent threads, the expected memory overhead of each approach, and the behavior under thread stall. Hazard pointers pin specific nodes per thread while other reclamation proceeds. EBR pins an entire epoch globally when any thread stalls. The choice depends on whether threads in your system can stall indefinitely (EBR is riskier in that case).

---
