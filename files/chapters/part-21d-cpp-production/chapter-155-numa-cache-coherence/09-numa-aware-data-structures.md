## 9. NUMA-Aware Data Structures

A standard `std::unordered_map` shared across NUMA nodes is a coherence machine: every insert invalidates lines across the fabric. The fix is to design data structures whose state is partitioned by node, and whose cross-node operations are explicit and rare.

### Per-Node Hash Map

```cpp
#include <numa.h>
#include <unordered_map>
#include <vector>
#include <shared_mutex>

template <typename K, typename V, typename H = std::hash<K>>
class PerNodeHashMap {
    struct Shard {
        std::unordered_map<K, V, H> data;
        mutable std::shared_mutex mu;
    };
    std::vector<Shard*> shards_;          // one per NUMA node
    H hasher_;

    Shard* shard_for(const K& k) const {
        size_t h = hasher_(k);
        return shards_[h % shards_.size()];
    }
public:
    PerNodeHashMap() {
        int n = numa_num_configured_nodes();
        shards_.resize(n);
        for (int i = 0; i < n; ++i) {
            void* mem = numa_alloc_onnode(sizeof(Shard), i);
            shards_[i] = new (mem) Shard();
        }
    }
    ~PerNodeHashMap() {
        for (auto* s : shards_) {
            s->~Shard();
            numa_free(s, sizeof(Shard));
        }
    }
    bool find(const K& k, V& out) const {
        auto* s = shard_for(k);
        std::shared_lock lk(s->mu);
        auto it = s->data.find(k);
        if (it == s->data.end()) return false;
        out = it->second;
        return true;
    }
    void insert(K k, V v) {
        auto* s = shard_for(k);
        std::unique_lock lk(s->mu);
        s->data.emplace(std::move(k), std::move(v));
    }
};
```

The Shard objects live on different NUMA nodes. A key always hashes to the same shard, so a thread that touches the same keys repeatedly stays mostly local if it runs on the right node. The lock is per-shard, so contention is divided by node count. The `unordered_map`'s internal allocations come from the system allocator and may not be on the right node. To fix this fully, give each shard its own `std::pmr::memory_resource` backed by `numa_alloc_onnode`.

### NUMA-Aware Cohort Lock

The "cohort" technique reorders lock acquisitions to keep the lock local to one node when possible, reducing cross-socket lock handoffs.

```cpp
class NumaCohortLock {
    struct NodeLock {
        std::atomic<int> waiters{0};
        std::atomic<int> owner{-1};
    };
    std::vector<NodeLock*> per_node_;
    std::atomic<int> global_owner_{-1};
public:
    void lock() {
        int node = numa_node_of_cpu(sched_getcpu());
        // Try to acquire local cohort lock first.
        // If a thread on the same node already holds the global lock,
        // hand off locally. Otherwise compete for the global lock.
        // Full implementation is intricate. See Dice/Marathe/Shavit.
    }
    // ...
};
```

The full algorithm is in "Lock cohorting: A general technique for designing NUMA locks" (Dice et al, 2012). It is the basis for Linux kernel's `osq_lock` (optimized for cache-line ownership transfer).

### Per-Node Memory Pool

For high-frequency allocations, per-node slab pools eliminate the syscall cost of `numa_alloc_onnode` on each request:

```cpp
#include <numa.h>
#include <vector>
#include <cstddef>

template <size_t BlockSize, size_t BlocksPerArena = 4096>
class NumaPool {
    struct Arena {
        void* base;
        size_t used;
    };
    std::vector<Arena> arenas_;
    int node_;
    static constexpr size_t kArenaBytes = BlockSize * BlocksPerArena;
public:
    explicit NumaPool(int node) : node_(node) { grow(); }
    ~NumaPool() {
        for (auto& a : arenas_) numa_free(a.base, kArenaBytes);
    }
    void* alloc() {
        if (arenas_.back().used == kArenaBytes) grow();
        Arena& a = arenas_.back();
        void* p = static_cast<char*>(a.base) + a.used;
        a.used += BlockSize;
        return p;
    }
private:
    void grow() {
        void* mem = numa_alloc_onnode(kArenaBytes, node_);
        arenas_.push_back({mem, 0});
    }
};
```

This pool is per-thread (one instance per worker), allocates on a specific node, and returns blocks in O(1). Free is omitted in the simple version because per-request pools often free in bulk at request end.

### Partitioned Counter

A globally shared `std::atomic<uint64_t>` counter ping-pongs across nodes when many cores increment it. A partitioned counter keeps a per-core slot:

```cpp
#include <atomic>
#include <thread>
#include <vector>
#include <new>

class PartitionedCounter {
    struct alignas(64) Slot { std::atomic<uint64_t> v{0}; };
    std::vector<Slot> slots_;
public:
    PartitionedCounter() : slots_(std::thread::hardware_concurrency()) {}
    void inc(int cpu_hint) {
        slots_[cpu_hint % slots_.size()].v.fetch_add(1, std::memory_order_relaxed);
    }
    uint64_t read() const {
        uint64_t s = 0;
        for (auto& sl : slots_) s += sl.v.load(std::memory_order_relaxed);
        return s;
    }
};
```

Increment is now uncontended (each core writes to its own slot, in M state). Read is O(num_cores) but rare. This is the standard pattern for metrics counters in high-throughput services.

For NUMA-awareness specifically, allocate slots on the local node of each CPU. This keeps the L1 line on the writing core's cache and avoids the slot ever being allocated on a remote node by accident.

### NUMA-Aware Concurrent Skip List

A skip list shared across nodes suffers because the upper levels are read-heavy and modified rarely (good for caches), but the lower levels are write-heavy and contended.

The NUMA-aware variant:

1. Per-node copies of the upper levels (read-mostly), kept in sync with RCU.
2. Single global lower-level structure, but with finely partitioned locks.
3. Inserts buffer per-node and batch-merge into the global structure during low-traffic windows.

The full structure is involved and beyond this chapter's scope. Folly's `ConcurrentSkipList` is a starting reference, though it does not yet have NUMA-aware tiering. Research papers from Dice and Shavit cover the details.

### A Real Example: Per-Node Cache

A database buffer pool that holds 256 GB of pages on a 4-node system can be partitioned 64 GB per node. Each query is routed to the node holding its working set, and remote pages are pulled across UPI on demand. Postgres, MySQL, and most legacy databases do not do this. Newer engines (TiDB, ScyllaDB, ClickHouse with NUMA tuning) do.

```cpp
class NumaBufferPool {
    struct NodePool {
        char* base;
        size_t size;
        // page index, free list, etc.
    };
    std::vector<NodePool> nodes_;
public:
    void init(size_t per_node_bytes) {
        int n = numa_num_configured_nodes();
        nodes_.resize(n);
        for (int i = 0; i < n; ++i) {
            nodes_[i].base = static_cast<char*>(numa_alloc_onnode(per_node_bytes, i));
            nodes_[i].size = per_node_bytes;
        }
    }
    char* page_for(uint64_t page_id, int requesting_node) {
        // Pages are statically partitioned across nodes by hash.
        int home = page_id % nodes_.size();
        if (home == requesting_node) {
            // Fast path: local node.
        } else {
            // Slow path: cross-socket. Worth tracking metric.
        }
        // ...
    }
};
```

### Junior to FAANG

A junior shares a global hash map. A FAANG engineer shards by node and aligns the sharding with the request routing.

### Senior at FAANG

Staff engineers design the data structure and the request router together. A NUMA-aware data structure with a router that does not respect the sharding is wasted effort. The two pieces must be co-designed and benchmarked end to end.

---
