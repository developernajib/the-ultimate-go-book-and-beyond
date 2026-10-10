## Lock-Free Stacks and the Treiber Stack

R. Kent Treiber's 1986 IBM technical report described the simplest non-trivial lock-free structure. A linked list with CAS on the head pointer. Forty years later it remains the textbook stack, with one major refinement (Hendler-Shavit-Yerushalmi's elimination backoff stack) for high contention.

### The Treiber Stack

```cpp
template <typename T>
class TreiberStack {
    struct Node {
        T value;
        Node* next;
    };
    std::atomic<Node*> head_{nullptr};
public:
    void push(T v) {
        Node* fresh = new Node{std::move(v), head_.load(std::memory_order_relaxed)};
        while (!head_.compare_exchange_weak(fresh->next, fresh,
                std::memory_order_release, std::memory_order_relaxed)) {
        }
    }

    bool pop(T& out) {
        Node* old = head_.load(std::memory_order_acquire);
        while (old) {
            Node* next = old->next;  // unsafe without HP
            if (head_.compare_exchange_weak(old, next,
                    std::memory_order_acquire, std::memory_order_acquire)) {
                out = std::move(old->value);
                delete old;  // unsafe without HP
                return true;
            }
        }
        return false;
    }
};
```

The pop is broken without reclamation protection. The `old->next` read can fault if another thread freed `old` between the load and the dereference. The ABA scenario is also live: the head pointer can be popped, popped again, then the original node re-pushed at the same address, and your CAS succeeds while the stack is in a different state.

### Treiber with Hazard Pointers

```cpp
bool pop(T& out) {
    hazard_pointer h = make_hazard_pointer();
    while (true) {
        Node* old = h.protect(head_);
        if (!old) return false;
        Node* next = old->next;
        if (head_.compare_exchange_weak(old, next,
                std::memory_order_acq_rel, std::memory_order_acquire)) {
            out = std::move(old->value);
            old->retire();
            return true;
        }
    }
}
```

The hazard protect ensures `old` is not freed while we read `old->next`. The retire defers free until no thread has `old` in a hazard slot.

### The Cache Line Bottleneck

Every push and pop CASes the same head pointer. With 16 threads, 15 of them are constantly invalidating each other's cache lines. Treiber stack throughput collapses past 4-8 threads on x86 (peak around 30-40 Mops at 4 threads, dropping to 5-10 Mops at 32 threads).

This is fundamental. Any LIFO stack on a single shared pointer cannot scale. The contention is inherent to LIFO ordering.

### Elimination Backoff Stack (Hendler-Shavit-Yerushalmi 2004)

Observation: a push followed quickly by a pop is equivalent to no operation at all. If we can pair them off without touching the central head pointer, both threads make progress without contention.

The elimination layer is a side array of exchange slots. A thread that fails its CAS on the central head visits a random slot in the array. If the slot is empty, it advertises its operation (push or pop) and waits briefly. If another thread arrives with the matching operation, they exchange and both return success without ever modifying the central stack.

```cpp
template <typename T>
class EliminationStack {
    struct Node { T value; Node* next; };

    static constexpr size_t kSlots = 32;
    enum class Op { Empty, Push, Pop };
    struct Slot {
        std::atomic<Op>   op{Op::Empty};
        std::atomic<T*>   data{nullptr};
        char pad[64 - sizeof(std::atomic<Op>) - sizeof(std::atomic<T*>)];
    };

    std::atomic<Node*> head_{nullptr};
    Slot               slots_[kSlots];

    bool try_central_push(Node* fresh) {
        Node* h = head_.load(std::memory_order_relaxed);
        fresh->next = h;
        return head_.compare_exchange_strong(h, fresh,
            std::memory_order_release, std::memory_order_relaxed);
    }
    bool try_central_pop(T& out) {
        Node* h = head_.load(std::memory_order_acquire);
        if (!h) return false;
        if (head_.compare_exchange_strong(h, h->next,
                std::memory_order_acq_rel, std::memory_order_relaxed)) {
            out = std::move(h->value);
            delete h;
            return true;
        }
        return false;
    }

    bool try_eliminate_push(T& v) {
        size_t idx = thread_random() % kSlots;
        Slot& s = slots_[idx];
        Op expected = Op::Empty;
        if (!s.op.compare_exchange_strong(expected, Op::Push,
                std::memory_order_acq_rel)) return false;
        s.data.store(&v, std::memory_order_release);
        for (int i = 0; i < 200; ++i) {
            if (s.op.load(std::memory_order_acquire) == Op::Empty) return true;
            cpu_relax();
        }
        Op got = Op::Push;
        return !s.op.compare_exchange_strong(got, Op::Empty,
            std::memory_order_acq_rel);
    }

    bool try_eliminate_pop(T& out) {
        size_t idx = thread_random() % kSlots;
        Slot& s = slots_[idx];
        Op got = s.op.load(std::memory_order_acquire);
        if (got != Op::Push) return false;
        if (!s.op.compare_exchange_strong(got, Op::Empty,
                std::memory_order_acq_rel)) return false;
        T* p = s.data.load(std::memory_order_acquire);
        out = std::move(*p);
        return true;
    }

public:
    void push(T v) {
        Node* fresh = new Node{std::move(v), nullptr};
        while (true) {
            if (try_central_push(fresh)) return;
            if (try_eliminate_push(fresh->value)) {
                delete fresh;
                return;
            }
        }
    }
    bool pop(T& out) {
        while (true) {
            if (try_central_pop(out)) return true;
            if (try_eliminate_pop(out)) return true;
            if (head_.load(std::memory_order_relaxed) == nullptr) return false;
        }
    }
};
```

The exchange slot has three states: Empty, Push (a thread is offering a value), and the implicit "consumed" which transitions back to Empty. A pop arriving at a Push slot CASes it to Empty and reads the data pointer. Both threads return without touching `head_`.

### Spin Strategy in the Slot

The 200-iteration spin is the critical tuning parameter. Too short and partners do not find each other. Too long and the elimination layer adds latency to genuinely uncontended operations. Hendler-Shavit-Yerushalmi recommend an adaptive strategy: each thread tracks its recent elimination success rate and adjusts the spin count.

Production implementations (Cliff Click's Java NonBlockingDeque, JDK's `ConcurrentLinkedDeque`) use exponential backoff combined with elimination. The first few CAS failures on the central stack do plain backoff. After persistent failure, the elimination layer kicks in.

### Senior at FAANG: When Elimination Fails

Elimination requires balanced push and pop traffic. A producer-only burst (logging, metrics) finds no partners and wastes time in the elimination layer. Production code monitors the success rate and disables elimination when the workload is unbalanced.

```cpp
class AdaptiveStack {
    std::atomic<int> recent_eliminations_{0};
    std::atomic<int> recent_attempts_{0};

    bool elimination_useful() {
        int hits = recent_eliminations_.load(std::memory_order_relaxed);
        int tries = recent_attempts_.load(std::memory_order_relaxed);
        return tries > 100 && hits * 4 > tries;
    }
};
```

If elimination success drops below 25 percent over 100 attempts, fall back to pure CAS with exponential backoff.

### Exchanger Arrays

The elimination slot generalizes to a standalone primitive: the exchanger. Two threads meet at a slot and swap values. Java's `java.util.concurrent.Exchanger` is the canonical implementation.

```cpp
template <typename T>
class Exchanger {
    enum State { Empty, Waiting, Busy };
    struct Cell {
        std::atomic<State> state{Empty};
        T offered;
        T returned;
    };
    static constexpr size_t kSlots = 16;
    Cell slots_[kSlots];

public:
    bool exchange(T in, T& out, int spin_budget) {
        size_t idx = thread_random() % kSlots;
        Cell& c = slots_[idx];
        State s = c.state.load(std::memory_order_acquire);

        if (s == Empty) {
            State expected = Empty;
            if (!c.state.compare_exchange_strong(expected, Busy,
                    std::memory_order_acq_rel)) return false;
            c.offered = std::move(in);
            c.state.store(Waiting, std::memory_order_release);
            for (int i = 0; i < spin_budget; ++i) {
                if (c.state.load(std::memory_order_acquire) == Empty) {
                    out = std::move(c.returned);
                    return true;
                }
                cpu_relax();
            }
            State expected2 = Waiting;
            if (c.state.compare_exchange_strong(expected2, Empty,
                    std::memory_order_acq_rel)) {
                in = std::move(c.offered);
                return false;
            }
            out = std::move(c.returned);
            return true;
        }
        if (s == Waiting) {
            State expected = Waiting;
            if (!c.state.compare_exchange_strong(expected, Busy,
                    std::memory_order_acq_rel)) return false;
            out = std::move(c.offered);
            c.returned = std::move(in);
            c.state.store(Empty, std::memory_order_release);
            return true;
        }
        return false;
    }
};
```

The state machine: Empty -> Busy -> Waiting (first arrival has set its offer) -> Busy (second arrival has claimed the slot) -> Empty (exchange complete). The spin budget bounds wait time. If the budget expires, the first arrival reverts the slot and returns failure.

Exchangers are useful as primitives for genetic algorithms, parallel pipeline stages, and as the backbone of elimination stacks.

### Cost Comparison

On a 32-core Cascade Lake, balanced push/pop workload, 16 threads:

| Stack | Throughput |
| --- | --- |
| `std::stack` + `std::mutex` | 8-12 Mops |
| Treiber + HP | 18-25 Mops |
| Elimination backoff stack | 65-95 Mops |
| Per-thread stacks + work stealing | 200+ Mops |

The elimination stack is roughly 4x faster than plain Treiber under balanced contention. Per-thread stacks with work stealing beat both because they avoid the shared head entirely, but they change the LIFO contract slightly (a popped element is not necessarily the most recently pushed across all threads).

### Junior to FAANG: Why Treiber Pop Re-Reads head_

The CAS in pop has memory_order_acquire on success and memory_order_acquire on failure. Junior engineers often write `memory_order_relaxed` on failure, reasoning that a failed CAS does not need ordering. This is wrong. A failed CAS still re-reads `head_` and feeds it back into the loop. Without acquire ordering on the re-read, a subsequent dereference of `old->next` can see stale memory. The strong-or-weak choice does not matter much for stacks, but the ordering on both success and failure paths must be at least acquire on the read side.

### Bounded Treiber Variants

For systems that cannot tolerate unbounded growth, a bounded Treiber pre-allocates a node pool indexed by 32-bit handles. The head is a tagged 64-bit value: 32 bits of node index plus 32 bits of ABA tag.

```cpp
struct TaggedHead {
    uint32_t index;
    uint32_t tag;
};
static_assert(sizeof(TaggedHead) == 8);
std::atomic<TaggedHead> head_;
```

Push and pop CAS the 64-bit value atomically. Tag increments on every modification, which kills ABA. This is exactly what `boost::lockfree::stack` does internally with its freelist.
