## Lock-Free Queues

Queues are the most contended data structure in concurrent systems. Producers enqueue, consumers dequeue, and both ends compete for cache lines. Four queue families dominate production code: Michael-Scott (MPMC, unbounded), Vyukov MPMC bounded ring, Vyukov MPSC linked list, and SPSC ring buffer.

### Michael-Scott Queue (1996)

The original lock-free MPMC queue. Maged Michael and Michael Scott's PODC 1996 paper. Linked list with a tail pointer that may lag the actual tail by one node. Enqueuers fix the tail when they observe a lag.

```cpp
template <typename T>
class MSQueue {
    struct Node {
        std::atomic<Node*> next;
        T value;
        Node() : next(nullptr) {}
        Node(T v) : next(nullptr), value(std::move(v)) {}
    };
    alignas(64) std::atomic<Node*> head_;
    alignas(64) std::atomic<Node*> tail_;
public:
    MSQueue() {
        Node* dummy = new Node();
        head_.store(dummy);
        tail_.store(dummy);
    }

    void enqueue(T v) {
        Node* fresh = new Node(std::move(v));
        Node* tail;
        Node* next;
        while (true) {
            tail = tail_.load(std::memory_order_acquire);
            next = tail->next.load(std::memory_order_acquire);
            if (tail != tail_.load(std::memory_order_acquire)) continue;
            if (next == nullptr) {
                if (tail->next.compare_exchange_weak(next, fresh,
                        std::memory_order_release, std::memory_order_relaxed)) {
                    tail_.compare_exchange_strong(tail, fresh,
                        std::memory_order_release, std::memory_order_relaxed);
                    return;
                }
            } else {
                tail_.compare_exchange_strong(tail, next,
                    std::memory_order_release, std::memory_order_relaxed);
            }
        }
    }

    bool dequeue(T& out) {
        Node* head;
        Node* tail;
        Node* next;
        while (true) {
            head = head_.load(std::memory_order_acquire);
            tail = tail_.load(std::memory_order_acquire);
            next = head->next.load(std::memory_order_acquire);
            if (head != head_.load(std::memory_order_acquire)) continue;
            if (head == tail) {
                if (next == nullptr) return false;
                tail_.compare_exchange_strong(tail, next,
                    std::memory_order_release, std::memory_order_relaxed);
            } else {
                out = std::move(next->value);
                if (head_.compare_exchange_weak(head, next,
                        std::memory_order_acq_rel, std::memory_order_relaxed)) {
                    retire(head); // hazard pointers or RCU
                    return true;
                }
            }
        }
    }
};
```

The dummy node simplifies the empty-queue case. The `head == tail` branch with non-null `next` is the lag-recovery: an enqueuer added a node but did not yet swing the tail, and either we help or we wait.

#### The ABA Problem in MSQueue

Without reclamation protection, this sequence breaks the queue:

1. Thread A reads `head = X`, reads `next = Y`.
2. Thread B dequeues X (head moves to Y).
3. Thread B dequeues Y (head moves to Z).
4. Thread B re-enqueues a new node that happens to reuse X's address.
5. Thread A's CAS succeeds because head still equals X, but the queue is corrupted.

The original paper used tagged pointers (high bits as a counter) on architectures with 64-bit CAS over 32-bit pointers. Modern fixes are hazard pointers, EBR, or double-word CAS.

#### MSQueue with Hazard Pointers

```cpp
bool dequeue(T& out) {
    hazard_pointer h0 = make_hazard_pointer();
    hazard_pointer h1 = make_hazard_pointer();
    while (true) {
        Node* head = h0.protect(head_);
        Node* tail = tail_.load(std::memory_order_acquire);
        Node* next = h1.protect(head->next);
        if (head != head_.load(std::memory_order_acquire)) continue;
        if (head == tail) {
            if (!next) return false;
            tail_.compare_exchange_strong(tail, next,
                std::memory_order_release, std::memory_order_relaxed);
            continue;
        }
        out = std::move(next->value);
        if (head_.compare_exchange_weak(head, next,
                std::memory_order_acq_rel, std::memory_order_relaxed)) {
            head->retire();
            return true;
        }
    }
}
```

Two hazards per dequeue: one for the current head, one for next (because we dereference `next->value`).

### Vyukov MPMC Bounded Ring

Dmitry Vyukov's MPMC bounded queue (2010) is the fastest production MPMC for bounded workloads. Each cell carries a sequence number that encodes whether it is empty, written, or read.

```cpp
template <typename T, size_t N>
class VyukovMPMC {
    static_assert((N & (N - 1)) == 0, "N must be power of two");
    struct Cell {
        std::atomic<size_t> seq;
        T data;
    };
    alignas(64) Cell buf_[N];
    alignas(64) std::atomic<size_t> enq_pos_{0};
    alignas(64) std::atomic<size_t> deq_pos_{0};
public:
    VyukovMPMC() {
        for (size_t i = 0; i < N; ++i) buf_[i].seq.store(i, std::memory_order_relaxed);
    }

    bool enqueue(T v) {
        Cell* c;
        size_t pos = enq_pos_.load(std::memory_order_relaxed);
        while (true) {
            c = &buf_[pos & (N - 1)];
            size_t seq = c->seq.load(std::memory_order_acquire);
            intptr_t diff = (intptr_t)seq - (intptr_t)pos;
            if (diff == 0) {
                if (enq_pos_.compare_exchange_weak(pos, pos + 1,
                        std::memory_order_relaxed)) break;
            } else if (diff < 0) {
                return false;  // full
            } else {
                pos = enq_pos_.load(std::memory_order_relaxed);
            }
        }
        c->data = std::move(v);
        c->seq.store(pos + 1, std::memory_order_release);
        return true;
    }

    bool dequeue(T& out) {
        Cell* c;
        size_t pos = deq_pos_.load(std::memory_order_relaxed);
        while (true) {
            c = &buf_[pos & (N - 1)];
            size_t seq = c->seq.load(std::memory_order_acquire);
            intptr_t diff = (intptr_t)seq - (intptr_t)(pos + 1);
            if (diff == 0) {
                if (deq_pos_.compare_exchange_weak(pos, pos + 1,
                        std::memory_order_relaxed)) break;
            } else if (diff < 0) {
                return false;  // empty
            } else {
                pos = deq_pos_.load(std::memory_order_relaxed);
            }
        }
        out = std::move(c->data);
        c->seq.store(pos + N, std::memory_order_release);
        return true;
    }
};
```

The protocol: cell `i` is empty when `seq == pos`, written when `seq == pos + 1`. After read, the cell is reset to `pos + N` so it will accept the next enqueue at `pos + N`.

Cache line padding on `enq_pos_` and `deq_pos_` matters. Without it, every enqueue invalidates the consumer's cache line and vice versa, halving throughput.

### Vyukov MPSC Linked List

When you have many producers and one consumer, drop the dequeue-side CAS entirely. Producers swap into a tail pointer with `exchange`, the consumer walks the list.

```cpp
template <typename T>
class VyukovMPSC {
    struct Node {
        std::atomic<Node*> next{nullptr};
        T value;
        Node() = default;
        Node(T v) : value(std::move(v)) {}
    };
    alignas(64) std::atomic<Node*> head_;
    alignas(64) Node* tail_;
    Node stub_;
public:
    VyukovMPSC() : head_(&stub_), tail_(&stub_) {}

    void enqueue(T v) {
        Node* fresh = new Node(std::move(v));
        Node* prev = head_.exchange(fresh, std::memory_order_acq_rel);
        prev->next.store(fresh, std::memory_order_release);
    }

    bool dequeue(T& out) {
        Node* tail = tail_;
        Node* next = tail->next.load(std::memory_order_acquire);
        if (tail == &stub_) {
            if (!next) return false;
            tail_ = next;
            tail = next;
            next = next->next.load(std::memory_order_acquire);
        }
        if (next) {
            tail_ = next;
            out = std::move(tail->value);
            if (tail != &stub_) delete tail;
            return true;
        }
        Node* head = head_.load(std::memory_order_acquire);
        if (tail != head) return false;  // producer mid-enqueue
        enqueue_stub();
        next = tail->next.load(std::memory_order_acquire);
        if (next) {
            tail_ = next;
            out = std::move(tail->value);
            if (tail != &stub_) delete tail;
            return true;
        }
        return false;
    }
private:
    void enqueue_stub() {
        Node* prev = head_.exchange(&stub_, std::memory_order_acq_rel);
        prev->next.store(&stub_, std::memory_order_release);
    }
};
```

The exchange on `head_` is the only atomic primitive on the producer side. Producers serialize through that single instruction. The consumer reads the chain entirely with relaxed/acquire loads.

The producer-mid-enqueue gap is real. If a producer has done the exchange but not yet stored its `prev->next`, the consumer sees a null `next` and reports empty. The "wait or insert stub" trick recovers from this race.

### SPSC Ring Buffer

Single producer, single consumer. The fastest queue on any architecture. No CAS, no exchange, just relaxed/release/acquire stores.

```cpp
template <typename T, size_t N>
class SPSCRing {
    static_assert((N & (N - 1)) == 0);
    alignas(64) std::atomic<size_t> head_{0};  // consumer
    char pad1_[64 - sizeof(std::atomic<size_t>)];
    alignas(64) std::atomic<size_t> tail_{0};  // producer
    char pad2_[64 - sizeof(std::atomic<size_t>)];
    alignas(64) T buf_[N];

    // Producer-cached consumer head, consumer-cached producer tail
    alignas(64) size_t cached_head_{0};
    char pad3_[64 - sizeof(size_t)];
    alignas(64) size_t cached_tail_{0};
public:
    bool push(T v) {
        size_t t = tail_.load(std::memory_order_relaxed);
        size_t next = (t + 1) & (N - 1);
        if (next == cached_head_) {
            cached_head_ = head_.load(std::memory_order_acquire);
            if (next == cached_head_) return false;
        }
        buf_[t] = std::move(v);
        tail_.store(next, std::memory_order_release);
        return true;
    }

    bool pop(T& out) {
        size_t h = head_.load(std::memory_order_relaxed);
        if (h == cached_tail_) {
            cached_tail_ = tail_.load(std::memory_order_acquire);
            if (h == cached_tail_) return false;
        }
        out = std::move(buf_[h]);
        head_.store((h + 1) & (N - 1), std::memory_order_release);
        return true;
    }
};
```

The cached_head and cached_tail are the trick. The producer reads its own tail (cheap, in its cache) and a cached version of the consumer's head. It only re-reads the consumer's head when the cache says full. This eliminates a cross-core read on the hot path.

Throughput on a Skylake: 350-450 million ops/sec for SPSC, compared to 80-120 Mops for Vyukov MPMC and 8-15 Mops for MSQueue.

### Boost.Lockfree Internals

`boost::lockfree::queue` is an MSQueue with a freelist instead of malloc. Each node is allocated from a typed pool keyed by a tagged pointer (32-bit index plus 32-bit ABA tag in a 64-bit slot). The tag increments on every allocation, defeating ABA without hazard pointers or RCU.

```cpp
struct tagged_index {
    uint32_t index;
    uint32_t tag;
};
static_assert(sizeof(tagged_index) == 8);

class FreeList {
    std::atomic<tagged_index> head_;
    Node* pool_;
    bool pop(Node*& out) {
        tagged_index old = head_.load(std::memory_order_acquire);
        while (old.index != UINT32_MAX) {
            tagged_index next{pool_[old.index].next_index,
                              static_cast<uint32_t>(old.tag + 1)};
            if (head_.compare_exchange_weak(old, next,
                    std::memory_order_acq_rel)) {
                out = &pool_[old.index];
                return true;
            }
        }
        return false;
    }
};
```

The 32-bit tag overflows every 4 billion allocations per slot, which is fine for most workloads. The cost is that the queue is bounded by the freelist size and cannot grow.

### Senior at FAANG: Choosing the Right Queue

| Workload | Best queue |
| --- | --- |
| 1 producer, 1 consumer, fixed size | SPSC ring |
| N producers, 1 consumer (event loop) | Vyukov MPSC |
| N producers, M consumers, bounded | Vyukov MPMC ring |
| N producers, M consumers, unbounded | MSQueue + EBR/HP |
| Persistence required | Disruptor pattern (LMAX) |
| NUMA, very high throughput | Per-NUMA-node Vyukov MPMC + work stealing |

The naive "use MSQueue everywhere" choice is 5-50x slower than the right specialized queue. Senior interview signal: when asked for a queue, ask about producer/consumer counts, bound, and reclamation budget before writing code.
