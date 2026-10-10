## 8. Shared-Nothing and Shard-Per-Core Architectures

The shard-per-core model takes NUMA awareness to its logical conclusion. Instead of treating the machine as a pool of cores sharing data through coherence, you treat each core as its own machine. Data is partitioned per core. Communication between cores happens through explicit message passing. The coherence protocol is barely used during steady state.

### SeaStar / ScyllaDB

ScyllaDB rewrote Cassandra's data path on top of SeaStar, a C++ framework built around three principles:

1. One thread per CPU core, pinned, no oversubscription.
2. Every piece of mutable state is owned by exactly one core. No cross-core mutexes, no atomics on shared state.
3. Cross-core communication happens via lock-free SPSC (single producer, single consumer) queues, one per core pair.

The result: on the same hardware, ScyllaDB delivers 5 to 10x the throughput of Cassandra and a fraction of the tail latency. The performance gap is not from a smarter algorithm. It is from eliminating coherence traffic in the inner loops.

### The Mental Model

Traditional thread pool model:

```cpp
std::shared_mutex shard_lock;
std::unordered_map<Key, Value> shard;

void handle_request(Request r) {
    std::shared_lock lk(shard_lock);
    auto it = shard.find(r.key);
    // ...
}
```

Multiple threads contend on `shard_lock` and on the cache lines of `shard`'s buckets. Even with a shared_mutex (multiple readers OK), the rwlock itself is a contended atomic.

Shard-per-core model:

```cpp
struct Shard {
    std::unordered_map<Key, Value> data;
    SPSCQueue<Request> inbox;
    SPSCQueue<Response> outbox;
};

void shard_loop(Shard& s) {
    while (running) {
        Request r;
        if (s.inbox.pop(r)) {
            auto it = s.data.find(r.key);
            // ... mutate s.data freely, no locks needed
            s.outbox.push(make_response(it));
        }
    }
}
```

Each shard is single-threaded. No locks. No coherence on `s.data`. The only coherence traffic is on the SPSC queue head/tail pointers, which is unavoidable but minimal.

### SPSC Queue Skeleton

```cpp
#include <atomic>
#include <array>
#include <new>

template <typename T, size_t N>
class SPSCQueue {
    static_assert((N & (N - 1)) == 0, "N must be power of two");
    static constexpr size_t MASK = N - 1;
    alignas(64) std::array<T, N> buf_;
    alignas(64) std::atomic<size_t> head_{0};   // consumer
    alignas(64) std::atomic<size_t> tail_{0};   // producer
public:
    bool push(const T& v) {
        size_t t = tail_.load(std::memory_order_relaxed);
        size_t h = head_.load(std::memory_order_acquire);
        if (t - h == N) return false;            // full
        buf_[t & MASK] = v;
        tail_.store(t + 1, std::memory_order_release);
        return true;
    }
    bool pop(T& v) {
        size_t h = head_.load(std::memory_order_relaxed);
        size_t t = tail_.load(std::memory_order_acquire);
        if (h == t) return false;                // empty
        v = buf_[h & MASK];
        head_.store(h + 1, std::memory_order_release);
        return true;
    }
};
```

The `alignas(64)` separating `head_` and `tail_` is critical. The producer writes `tail_` constantly. The consumer writes `head_` constantly. If they share a cache line, every push and every pop ping-pongs the line. With separate lines, each side owns its line in M state and only invalidates the other on the periodic load-acquire.

### RCU Instead of Mutex

Read-Copy-Update is a synchronization technique where readers do not synchronize at all. Writers create a new version of the data structure, swap a pointer, and wait for a quiescent period before freeing the old version.

```cpp
std::atomic<Map*> current_map{new Map()};

const Map* read_lock() {
    return current_map.load(std::memory_order_acquire);
}

void write(Key k, Value v) {
    Map* old = current_map.load(std::memory_order_relaxed);
    Map* fresh = new Map(*old);
    fresh->insert(k, v);
    current_map.store(fresh, std::memory_order_release);
    // Defer delete of old until all current readers are done.
    schedule_for_grace_period(old);
}
```

The consumer side of an RCU read is a single atomic load with acquire. No coherence traffic on the data itself, only on the pointer. liburcu and folly's RCU implementations are mature options. Linux kernel RCU is the canonical reference.

### Comparison: Thread-Per-Core vs Thread Pool

| Aspect | Thread Pool (e.g. Tomcat, classic Java) | Thread-Per-Core (SeaStar, glommio) |
|---|---|---|
| Cache contention | High (shared data structures) | Minimal (per-core data) |
| NUMA placement | Hard to get right | Natural (each core knows its node) |
| Tail latency | Wide tail, GC and lock waits | Tight tail |
| Programming model | Synchronous, blocking IO common | Async, futures everywhere |
| Debugging | Easy (stack traces) | Hard (continuations) |
| Throughput on big SMP | Plateaus past 16-32 cores | Scales linearly to 96+ cores |

The trade-off is real. Shard-per-core makes the code harder. The payoff is that the code does not collapse on a 96-core machine.

### Work Stealing Inside a NUMA Domain

Pure shard-per-core can leave cores idle if work is skewed. Work stealing is the mitigation. The constraint: stealing should happen within a NUMA domain, not across.

```cpp
struct Worker {
    int node;
    int cpu;
    Deque<Task> local;
    std::vector<Worker*> peers;   // other workers on same node
};

Task steal(Worker& self) {
    // First try local:
    if (auto t = self.local.pop()) return *t;
    // Then steal from same-node peer:
    for (auto* p : self.peers) {
        if (auto t = p->local.steal()) return *t;
    }
    // Cross-node steal as last resort, with a cost penalty:
    // ...
    return {};
}
```

Tokio (Rust) uses this pattern. Folly's IOThreadPoolExecutor has hooks for it. The principle: stealing from the same node is cheap (intra-socket coherence), stealing across sockets is expensive (UPI/xGMI traffic), so prefer local work even at the cost of some imbalance.

### Junior to FAANG

A junior writes a thread pool with a shared queue. A FAANG engineer building a high-throughput service starts from shard-per-core, accepts the async programming complexity, and gets linear scaling to many cores.

### Senior at FAANG

Staff engineers know that shard-per-core is not free. It pushes complexity into the workload partitioning. A skewed key space breaks shard-per-core just as it breaks any sharded design. The architecture decision is whether the workload's natural partitioning aligns with the per-core sharding. If yes, this model wins. If no, you spend engineering time on rebalancing logic that may or may not be worth it.

---
