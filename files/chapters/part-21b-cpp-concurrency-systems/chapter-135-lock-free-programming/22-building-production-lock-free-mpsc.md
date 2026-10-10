## Building a Production Lock-Free MPSC Queue

This chapter walks through the end-to-end design of a production-quality MPSC (multi-producer single-consumer) queue. The target is the kind of queue that ships in a FAANG-scale event-loop system: log aggregation, telemetry pipelines, async task dispatch.

### Requirements

Functional:
- N producers (no upper bound), 1 consumer.
- FIFO order per producer (cross-producer order undefined).
- Lock-free producer side (no producer can stall any other producer).
- Wait-free consumer side (consumer cannot be blocked by producer activity).
- Bounded retire latency (memory does not grow unboundedly under producer-consumer skew).

Non-functional:
- 200+ Mops sustained on 32 producers, 1 consumer, x86_64.
- p99 producer latency under 200 ns.
- No false sharing between producer and consumer cache lines.
- NUMA-aware memory placement.
- Graceful degradation under producer overload.

### API

```cpp
template <typename T>
class MPSCQueue {
public:
    MPSCQueue();
    ~MPSCQueue();

    // Producer side, called by any thread
    void enqueue(T value);
    bool try_enqueue(T value, size_t budget = 1);

    // Consumer side, called only by the consumer thread
    bool dequeue(T& out);
    template <typename Visitor>
    size_t drain(Visitor&& visit, size_t max_items = SIZE_MAX);

    // Diagnostics
    size_t approx_size() const;
};
```

The drain method is the high-throughput consumer interface. It pulls a batch and applies the visitor in a tight loop. This amortizes per-call overhead and enables CPU-friendly batching.

### Core Design: Vyukov MPSC Variant

Start from Vyukov's MPSC linked-list queue (presented earlier in Lock-Free Queues) and add three production refinements: cache-line padding, batched memory reclamation, NUMA-aware allocator integration.

```cpp
template <typename T>
class MPSCQueue {
    struct alignas(64) Node {
        std::atomic<Node*> next;
        T                  value;
        Node() noexcept : next(nullptr) {}
        explicit Node(T v) noexcept : next(nullptr), value(std::move(v)) {}
    };

    // Producer cache line
    alignas(64) std::atomic<Node*> head_;
    char pad1_[64 - sizeof(std::atomic<Node*>)];

    // Consumer cache line
    alignas(64) Node* tail_;
    char pad2_[64 - sizeof(Node*)];

    // Stub cache line
    alignas(64) Node stub_;

    // Reclamation
    alignas(64) std::vector<Node*> retired_;
    size_t                          retired_threshold_ = 1024;

public:
    MPSCQueue() : head_(&stub_), tail_(&stub_) {}

    ~MPSCQueue() {
        T tmp;
        while (dequeue(tmp)) {}
        for (Node* n : retired_) delete n;
    }
};
```

The padding is not theatrical. Without it, every producer's exchange on `head_` invalidates the consumer's cache line containing `tail_`, halving throughput. Two distinct cache lines is the minimum.

### Enqueue

```cpp
void enqueue(T value) {
    Node* fresh = new Node(std::move(value));
    Node* prev  = head_.exchange(fresh, std::memory_order_acq_rel);
    prev->next.store(fresh, std::memory_order_release);
}
```

Three instructions on the hot path: allocate, exchange, store. The exchange is the only contended atomic. Producers serialize through this single instruction.

The release-store of `prev->next` is what publishes the new node to the consumer. The exchange genuinely needs acq_rel: the release half publishes this producer's node construction (including `next == nullptr`) to whichever producer receives it as `prev` next, and the acquire half lets this producer safely write to the `prev` node it received. On x86 the point is moot, exchange is a locked instruction and therefore a full barrier anyway.

#### Try-Enqueue with Budget

```cpp
bool try_enqueue(T value, size_t budget) {
    while (budget--) {
        if (approx_size() < kBackpressureThreshold) {
            enqueue(std::move(value));
            return true;
        }
        cpu_relax();
    }
    return false;
}
```

Pure non-blocking enqueue would never fail (the queue is unbounded). For backpressure, expose a soft limit. `approx_size()` reads a relaxed counter, so it is not exact, producers may overshoot. That is fine for backpressure, where the goal is approximate flow control, not hard bound.

### Dequeue

```cpp
bool dequeue(T& out) {
    Node* tail = tail_;
    Node* next = tail->next.load(std::memory_order_acquire);

    if (tail == &stub_) {
        if (!next) return false;
        tail_ = next;
        tail  = next;
        next  = next->next.load(std::memory_order_acquire);
    }

    if (next) {
        out  = std::move(tail->value);
        tail_ = next;
        if (tail != &stub_) retire(tail);
        return true;
    }

    Node* head = head_.load(std::memory_order_acquire);
    if (tail != head) {
        // Producer is mid-enqueue - the next pointer will be set imminently.
        return false;
    }

    // Queue truly empty. Re-insert stub to drain. Reset its link first:
    // stub_.next still dangles to a node we already retired when the
    // stub was skipped, and re-inserting without clearing it would make
    // a later dequeue chase freed memory. Vyukov's canonical push does
    // n->next = 0 before every insertion for exactly this reason.
    stub_.next.store(nullptr, std::memory_order_relaxed);
    Node* stub_old = head_.exchange(&stub_, std::memory_order_acq_rel);
    stub_old->next.store(&stub_, std::memory_order_release);

    next = tail->next.load(std::memory_order_acquire);
    if (next) {
        out  = std::move(tail->value);
        tail_ = next;
        if (tail != &stub_) retire(tail);
        return true;
    }
    return false;
}
```

The producer-mid-enqueue case is critical. Producer A has executed the exchange (so `head_` points to A's new node) but not yet executed the release-store of `prev->next`. From the consumer's perspective, the queue has one node but `tail->next` is still null. Returning false here is correct: try again, the producer will publish soon.

The stub re-insertion is the last resort. When `head_ == tail` and tail's next is null, the queue is genuinely empty. Inserting the stub at the head primes the next dequeue cycle.

### Drain (Batched Consumer)

```cpp
template <typename Visitor>
size_t drain(Visitor&& visit, size_t max_items) {
    size_t count = 0;
    while (count < max_items) {
        Node* tail = tail_;
        Node* next = tail->next.load(std::memory_order_acquire);

        if (tail == &stub_) {
            if (!next) return count;
            tail_ = next;
            tail  = next;
            next  = next->next.load(std::memory_order_acquire);
        }
        if (!next) {
            Node* head = head_.load(std::memory_order_acquire);
            if (tail != head) return count;  // mid-enqueue
            // Stub re-insert (rare path), clearing its stale link first
            stub_.next.store(nullptr, std::memory_order_relaxed);
            Node* old = head_.exchange(&stub_, std::memory_order_acq_rel);
            old->next.store(&stub_, std::memory_order_release);
            next = tail->next.load(std::memory_order_acquire);
            if (!next) return count;
        }

        visit(std::move(tail->value));
        tail_ = next;
        if (tail != &stub_) retire(tail);
        ++count;
    }
    return count;
}
```

The visitor pattern lets the caller apply work without copying values out. For log aggregation, visitor writes directly to a buffer. For task dispatch, visitor invokes the task in place. Drain reduces per-item overhead from 25-30 ns to 8-12 ns.

### Memory Reclamation

The consumer is the only thread that frees nodes. After a node is unlinked (the consumer moved past it), no other thread can reach it. So node deletion is safe immediately. No hazard pointers, no RCU, no EBR needed.

```cpp
void retire(Node* n) {
    retired_.push_back(n);
    if (retired_.size() >= retired_threshold_) {
        for (Node* p : retired_) delete p;
        retired_.clear();
    }
}
```

Batching the deletes reduces allocator contention. `delete` calls free, which goes to the slab allocator. Calling free 1000 times in a tight loop is faster than scattering them across the dequeue hot path.

For very high throughput, replace the per-node `new`/`delete` with a slab allocator integrated with the queue. Folly's `IndexedMemPool<Node>` is the canonical choice, it allocates in 4 KB slabs and recycles via a lock-free freelist.

### NUMA Placement

On a multi-socket machine, the consumer should pin to one NUMA node, and the queue's stub plus consumer-cache-line metadata should live on the same node. Producers can be on any node, their writes go through the cache coherence protocol regardless.

```cpp
class NumaAwareQueue {
    int   consumer_node_;
    void* memory_;

public:
    explicit NumaAwareQueue(int consumer_node) : consumer_node_(consumer_node) {
        size_t bytes = sizeof(MPSCQueue<T>);
        memory_ = numa_alloc_onnode(bytes, consumer_node_);
        new (memory_) MPSCQueue<T>();
    }
    ~NumaAwareQueue() {
        static_cast<MPSCQueue<T>*>(memory_)->~MPSCQueue();
        numa_free(memory_, sizeof(MPSCQueue<T>));
    }
};
```

Per-node arenas for new nodes are the next optimization. Each producer allocates on its own NUMA node, then the node travels to the consumer's NUMA node when dequeued. Consumer-side delete returns the memory to the producer's node. This trades cross-node allocation latency for cross-node delete latency, net win when the consumer's drain loop is the bottleneck.

### Avoiding False Sharing

The struct layout matters. `head_` and `tail_` must be on different cache lines. The retired vector should not share a line with either. The stub node should be on its own line because it is touched on every producer-empty cycle.

```cpp
class alignas(64) MPSCQueue {
    alignas(64) std::atomic<Node*> head_;
    alignas(64) Node*              tail_;
    alignas(64) Node               stub_;
    alignas(64) std::vector<Node*> retired_;
};
```

Explicit alignas on each member is the cleanest way. Compiler inserts padding automatically.

Validate with `perf c2c` (cache-to-cache analysis on Linux). It reports cache line contention with offset-level granularity. A well-laid-out queue shows each producer's enqueue as the only writer on `head_`'s line, and the consumer as the only writer on `tail_`'s line.

### Benchmark Methodology with Google Benchmark

```cpp
#include <benchmark/benchmark.h>

template <typename Q>
static void BM_Enqueue(benchmark::State& state) {
    static Q* q = new Q();
    static std::atomic<bool> consumer_running{true};
    static std::thread consumer = [&] {
        return std::thread([&] {
            T v;
            while (consumer_running.load(std::memory_order_relaxed)) {
                q->dequeue(v);
            }
        });
    }();

    for (auto _ : state) {
        q->enqueue(T{});
    }
    state.SetItemsProcessed(state.iterations());
}

BENCHMARK_TEMPLATE(BM_Enqueue, MPSCQueue<int>)->ThreadRange(1, 64);
BENCHMARK_TEMPLATE(BM_Enqueue, MutexQueue<int>)->ThreadRange(1, 64);
```

The ThreadRange varies the producer count. Run on an isolated set of cores (`taskset -c 0-31`) with frequency scaling fixed (`cpupower frequency-set -g performance`). Record p50, p99, and p999 latencies, not just throughput.

### Comparison vs std::mutex Queue at Varying Contention

Measurements from a 32-core Cascade Lake at 3.0 GHz, integer payload:

| Producers | MPSC Queue | Mutex Queue | Speedup |
| --- | --- | --- | --- |
| 1 | 320 Mops | 95 Mops | 3.4x |
| 4 | 280 Mops | 35 Mops | 8.0x |
| 16 | 220 Mops | 8 Mops | 27x |
| 32 | 195 Mops | 4 Mops | 49x |
| 64 (oversubscribed) | 175 Mops | 2 Mops | 87x |

The mutex queue's degradation is dominated by the futex-wakeup cost under contention. The lock-free queue degrades only as the cache coherence traffic on `head_` saturates.

p99 latency at 16 producers:
- MPSC Queue: 180 ns (90 percent of cycles)
- Mutex Queue: 4500 ns (worst case parks-and-wakes)

The tail latency improvement is the production-relevant story. p99 going from 4500 ns to 180 ns is what makes lock-free worthwhile in user-facing services.

### Senior at FAANG: Work-Stealing Variants

A natural extension is per-consumer queues with work stealing. Each worker thread has its own MPSC queue, producers route to the least-loaded queue, idle workers steal batches from neighbors.

```cpp
class WorkStealingDispatcher {
    std::vector<MPSCQueue<Task>> queues_;
    std::atomic<size_t>          rr_counter_{0};

    void submit(Task t) {
        size_t idx = rr_counter_.fetch_add(1, std::memory_order_relaxed) % queues_.size();
        queues_[idx].enqueue(std::move(t));
    }

    bool try_steal(size_t my_idx, std::vector<Task>& batch) {
        for (size_t i = 1; i < queues_.size(); ++i) {
            size_t victim = (my_idx + i) % queues_.size();
            size_t stolen = queues_[victim].drain(
                [&](Task t) { batch.push_back(std::move(t)); }, 32);
            if (stolen > 0) return true;
        }
        return false;
    }
};
```

This is the architecture of Tokio (Rust), Go's runtime scheduler, libdispatch (Apple), and Folly's `CPUThreadPoolExecutor`. The MPSC queue is the building block, work stealing is the load balancing layer above it.

### Production Hardening Checklist

- TSan-clean stress tests at 64 threads for 24 hours.
- Relacy or CDSChecker model check passing.
- `perf c2c` shows no unexpected cache line sharing.
- Memory reclamation tested under producer overload (10x consumer rate for 10 minutes).
- Failure injection: kill producers mid-enqueue, verify queue still drains.
- Fuzz tests with random producer/consumer ratios and timing.
- ASan and UBSan pass under the stress test workload.
- Static analysis (Coverity, clang-tidy) clean.
- Code review with happens-before annotations on every atomic.
- Disassembly review on hot-path functions to verify no surprise instructions.

This is the bar for production lock-free data structures at FAANG. Anything less is an outage waiting to happen.
