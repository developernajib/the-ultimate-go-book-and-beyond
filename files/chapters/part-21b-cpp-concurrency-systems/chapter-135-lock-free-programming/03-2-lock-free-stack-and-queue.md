## 2. Lock-Free Stack and Queue

### Lock-Free Stack (Treiber Stack)

The Treiber stack is the simplest lock-free data structure. Push and pop both operate on the head pointer using CAS.

```cpp
#include <atomic>
#include <memory>
#include <optional>

template <typename T>
class LockFreeStack {
    struct Node {
        T data;
        Node* next;
        Node(T val) : data(std::move(val)), next(nullptr) {}
    };

    std::atomic<Node*> head_{nullptr};

public:
    void push(T val) {
        Node* new_node = new Node(std::move(val));
        new_node->next = head_.load(std::memory_order_relaxed);
        // CAS loop: set head to new_node if head still equals new_node->next
        while (!head_.compare_exchange_weak(
                   new_node->next, new_node,
                   std::memory_order_release,
                   std::memory_order_relaxed))
        {
            // new_node->next is updated to current head on failure
        }
    }

    std::optional<T> pop() {
        Node* old_head = head_.load(std::memory_order_acquire);
        while (old_head &&
               !head_.compare_exchange_weak(
                   old_head, old_head->next,
                   std::memory_order_acq_rel,
                   std::memory_order_acquire))
        {
            // old_head is updated to current head on failure
        }
        if (!old_head) return std::nullopt;

        T val = std::move(old_head->data);
        // WARNING: deleting old_head here is UNSAFE.
        // Another thread may still hold a reference. See Section 3.
        // delete old_head;
        return val;
    }

    ~LockFreeStack() {
        while (pop().has_value()) {}
    }
};
```

**The critical problem:** In `pop()`, after CAS succeeds and we read `old_head->data`, we cannot immediately `delete old_head`. Another thread might be mid-CAS, still reading `old_head->next`. This is the memory reclamation problem, addressed in Section 3.

### Lock-Free Queue (Michael-Scott Queue)

The Michael-Scott queue uses two pointers, `head` and `tail`, and a sentinel node.

```cpp
#include <atomic>
#include <optional>

template <typename T>
class LockFreeQueue {
    struct Node {
        std::optional<T> data;
        std::atomic<Node*> next{nullptr};
        Node() = default;
        explicit Node(T val) : data(std::move(val)) {}
    };

    std::atomic<Node*> head_;
    std::atomic<Node*> tail_;

public:
    LockFreeQueue() {
        Node* sentinel = new Node();
        head_.store(sentinel, std::memory_order_relaxed);
        tail_.store(sentinel, std::memory_order_relaxed);
    }

    void enqueue(T val) {
        Node* new_node = new Node(std::move(val));
        Node* old_tail;

        while (true) {
            old_tail = tail_.load(std::memory_order_acquire);
            Node* next = old_tail->next.load(std::memory_order_acquire);

            if (old_tail == tail_.load(std::memory_order_acquire)) {
                if (next == nullptr) {
                    // Tail is truly at the end. Try to link new node.
                    if (old_tail->next.compare_exchange_weak(
                            next, new_node,
                            std::memory_order_release,
                            std::memory_order_relaxed)) {
                        break;  // Enqueue successful
                    }
                } else {
                    // Tail is lagging. Help advance it.
                    tail_.compare_exchange_weak(
                        old_tail, next,
                        std::memory_order_release,
                        std::memory_order_relaxed);
                }
            }
        }
        // Try to advance tail (best-effort - others may do it too)
        tail_.compare_exchange_strong(
            old_tail, new_node,
            std::memory_order_release,
            std::memory_order_relaxed);
    }

    std::optional<T> dequeue() {
        while (true) {
            Node* old_head = head_.load(std::memory_order_acquire);
            Node* old_tail = tail_.load(std::memory_order_acquire);
            Node* next = old_head->next.load(std::memory_order_acquire);

            if (old_head == head_.load(std::memory_order_acquire)) {
                if (old_head == old_tail) {
                    if (next == nullptr) {
                        return std::nullopt;  // Queue is empty
                    }
                    // Tail is lagging. Help advance it.
                    tail_.compare_exchange_weak(
                        old_tail, next,
                        std::memory_order_release,
                        std::memory_order_relaxed);
                } else {
                    T val = std::move(*next->data);
                    if (head_.compare_exchange_weak(
                            old_head, next,
                            std::memory_order_acq_rel,
                            std::memory_order_acquire)) {
                        // old_head (sentinel) can be reclaimed
                        // (with safe reclamation -- see Section 3)
                        delete old_head;
                        return val;
                    }
                }
            }
        }
    }

    ~LockFreeQueue() {
        while (dequeue().has_value()) {}
        delete head_.load();  // Delete final sentinel
    }
};
```

**Design highlights:**

- The sentinel node separates head and tail operations, reducing contention.
- "Helping", when a thread detects tail is lagging, it advances tail for the other thread. This cooperative behavior is characteristic of lock-free algorithms.
- Both `enqueue` and `dequeue` are lock-free: if one thread stalls, others still make progress.

### Junior → FAANG: Understanding the Michael-Scott Queue Structure

The Michael-Scott queue is the canonical lock-free queue and appears in FAANG interviews frequently. Key structural points: the sentinel node separates head and tail, so enqueue and dequeue rarely contend with each other. The "helping" mechanism (a thread advances the lagging tail) is what makes it lock-free: if the thread that set the new next pointer is preempted before updating the tail, any other thread that notices the lagging tail can do it instead.

The ABA risk in the MS queue: if a node is dequeued and then reused (via a memory allocator) and re-enqueued before another thread's CAS fires, the CAS succeeds on a "different" node with the same address. The standard fix is to use a tagged pointer or hazard pointers.

For the interview: know why the sentinel node exists (it avoids special-casing an empty queue in dequeue), and know the "helping" invariant. These are the two design insights that interviewers want to hear.

### Senior @ FAANG: Lock-Free Queue Selection for Production Workloads

At L5+, the MS queue is a starting point, not an ending point. For production workloads, you choose among established implementations based on measured throughput profiles:

Folly `MPMCQueue`: bounded, high-throughput, uses epochs internally. Best for bounded producer-consumer with burst tolerance. Does not require hazard pointers because it is bounded.

Folly `UnboundedQueue`: unbounded, uses hazard pointers for reclamation. Best for unbounded work queues where back-pressure is handled at a higher level.

TBB `concurrent_queue`: uses a similar structure to MS but with additional optimizations for Intel architectures. Best when your fleet is exclusively x86 and you are already using TBB.

The architectural decision: bounded vs. unbounded is the primary axis. A bounded queue (fixed capacity) allows back-pressure signaling: when full, producers block or return an error, preventing unbounded memory growth. An unbounded queue grows with load and requires external back-pressure. For most FAANG service-to-service queues, bounded is preferable because it makes memory consumption predictable.

---
