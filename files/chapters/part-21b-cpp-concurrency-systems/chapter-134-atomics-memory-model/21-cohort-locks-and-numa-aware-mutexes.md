## Cohort Locks and NUMA-Aware Mutexes

`std::mutex` is fine for low contention. Under high contention on a NUMA machine, `std::mutex` collapses. The cache line carrying the lock state bounces between sockets, every acquisition pays a remote miss, and throughput falls to a few hundred thousand ops per second. This file covers the lock variants that scale.

### The Problem

A single mutex variable lives on one cache line. When N cores contend for it, every state change requires the line to migrate. On a 2-socket NUMA box, every cross-socket migration costs hundreds of cycles. When critical sections are short (microseconds), the lock migration cost dominates the work.

Symptoms:
- Throughput is flat or decreasing as cores increase.
- `perf c2c` shows the lock cache line at the top of contention.
- Tail latency is far worse than median.
- Cores spend most time spinning or in kernel futex wait.

Three families of solutions:

1. **MCS-style queue locks**: Each waiter spins on its own cache line. The line passes ownership.
2. **Cohort locks**: Hand the lock to a thread on the same socket before letting another socket take it.
3. **Distributed locks**: Sharded internal state, fast acquire on the local shard.

### Ticket Lock

Simplest scalable lock. Two counters: `next` and `now_serving`. Each acquirer atomically increments `next` to get a ticket and spins on `now_serving` until it matches.

```cpp
struct ticket_lock {
    std::atomic<uint32_t> next{0};
    std::atomic<uint32_t> now_serving{0};

    void lock() {
        uint32_t my = next.fetch_add(1, std::memory_order_relaxed);
        while (now_serving.load(std::memory_order_acquire) != my) {
            cpu_pause();
        }
    }

    void unlock() {
        now_serving.store(now_serving.load(std::memory_order_relaxed) + 1,
                          std::memory_order_release);
    }
};
```

Fair (FIFO) but every waiter spins on the same line. Under contention all cores still see the same `now_serving` line bouncing on every release.

### MCS Lock

Mellor-Crummey and Scott (1991). Each waiter has a per-thread node. The lock holder's node points to the next waiter. Each waiter spins on its own node's `locked` flag.

```cpp
struct mcs_node {
    std::atomic<mcs_node*> next{nullptr};
    std::atomic<bool> locked{true};
};

struct mcs_lock {
    std::atomic<mcs_node*> tail{nullptr};

    void lock(mcs_node* my) {
        my->next.store(nullptr, std::memory_order_relaxed);
        my->locked.store(true, std::memory_order_relaxed);
        mcs_node* prev = tail.exchange(my, std::memory_order_acq_rel);
        if (prev) {
            prev->next.store(my, std::memory_order_release);
            while (my->locked.load(std::memory_order_acquire)) cpu_pause();
        }
    }

    void unlock(mcs_node* my) {
        mcs_node* succ = my->next.load(std::memory_order_acquire);
        if (!succ) {
            mcs_node* expected = my;
            if (tail.compare_exchange_strong(expected, nullptr,
                                             std::memory_order_release)) {
                return;
            }
            while (!(succ = my->next.load(std::memory_order_acquire))) {
                cpu_pause();
            }
        }
        succ->locked.store(false, std::memory_order_release);
    }
};
```

Properties:
- FIFO fairness.
- Each waiter spins on its own line. No global cache line contention.
- Lock release writes one cache line (the successor's). No broadcast.

The cost: each acquisition needs a per-thread node, and the API is awkward (caller passes node).

### K42 / CLH Variations

CLH (Craig, Landin, Hagersten) is similar to MCS but uses a different linkage (predecessor's node, not own). Properties are equivalent for our purposes.

K42 is an MCS variant that embeds the node into the lock for the holder, avoiding a per-call node allocation. IBM's K42 OS used this style.

### Cohort Locks (C-BO-MCS)

Cohort locks (Dice, Marathe, Shavit 2012) layer NUMA awareness over MCS. The idea: when a holder releases, hand the lock to another thread on the same socket if one is waiting, before allowing a thread on a remote socket. This keeps the lock's cache line warm in one socket's cache for as long as possible.

Structure:
- One per-socket MCS lock (the local lock).
- One global lock with a flag indicating whether a socket "owns" it.
- A per-socket counter of consecutive local hand-offs.

Acquire path:
1. Acquire the local socket's MCS lock.
2. If the global lock is held by this socket, increment the local hand-off counter and proceed.
3. Otherwise acquire the global lock, then proceed.

Release path:
1. If a thread is waiting on the local MCS lock and hand-off count is below threshold (say 32), release to it and increment counter.
2. Otherwise release the global lock and the local MCS lock.

The threshold balances throughput and fairness. With threshold 32, throughput is high (hand-offs stay local) but a remote socket may wait for up to 32 critical sections.

### Real-World Implementations

**std::mutex**: Implementation-defined. On glibc, futex-based, cheap when uncontended, slow under contention. Not NUMA-aware.

**absl::Mutex** (Abseil): Adaptive spinning, then futex. Good general-purpose. Not NUMA-aware. Includes deadlock detection in debug.

**folly::DistributedMutex** (Meta): Designed for cases where most acquisitions are uncontended but contention spikes occur. Uses inline node storage on the stack of the waiter. 4 bytes per lock when uncontended. Outperforms std::mutex by 5-10x under high contention. Not strictly NUMA-aware but its design naturally clusters acquisitions.

**folly::SharedMutex**: Reader-writer lock with reader scaling. Uses sharded reader counters per CPU.

**libstdc++ std::shared_mutex**: Single counter for readers and writers. Does not scale past ~16 cores under read load.

### Performance Comparison Sketch

On a 2-socket Xeon machine, 56 cores, short critical section (~50ns), 100% contention:

| Lock | M ops/sec |
|------|-----------|
| std::mutex (futex) | 0.3 |
| pthread_mutex (PI) | 0.4 |
| ticket lock | 0.8 |
| MCS lock | 4.5 |
| C-BO-MCS cohort | 28 |
| folly::DistributedMutex | 22 |

Numbers are illustrative. Your workload differs. Always benchmark.

For uncontended use, std::mutex is hard to beat. The cohort lock pays its overhead on every acquire, even the first.

### Lock-Free Is Sometimes Better Than Scalable Lock

Sometimes the right answer is to remove the lock. Patterns:

- **Per-CPU counters**: Each CPU has its own counter. Read aggregates. No locking.
- **RCU**: Readers pay no atomic. Writers pay synchronize_rcu cost.
- **Sequence locks**: Reader retries on writer interference.
- **Lock-free queues**: Vyukov MPMC, LMAX Disruptor pattern.

Cohort locks are the right answer when:
- The critical section accesses complex shared state (graph, hash table) that is hard to make lock-free.
- The workload has bursts of contention but no sustained high write rate.
- Latency under contention matters more than uncontended overhead.

### NUMA-Aware Allocation Matters

A NUMA-aware lock with NUMA-unaware data placement still suffers. Pin the lock variable's cache line to one socket via `numa_alloc_local` or `mbind(MPOL_BIND)`. Allocate per-socket data structures on the local socket. Run threads pinned to specific cores so the OS does not migrate them.

`numactl --cpunodebind=0 --membind=0` for a quick test of "what if everything stayed on one socket". If the cohort lock is not faster than MCS in this configuration, your data layout is the bottleneck, not the lock.

### Junior at FAANG vs Senior at FAANG

Junior swaps `std::mutex` for `cohort_lock`, sees no improvement on their 4-core dev box, concludes "cohort locks are not faster". Senior:

- Verifies the workload actually has contention. `perf lock` or contention-aware sampling.
- Runs on the production hardware (NUMA, many cores).
- Pins threads to cores to remove OS scheduler noise.
- Compares not just throughput but tail latency (p99, p999).
- Considers redesigning data layout to remove the contention before swapping locks.

Senior also knows that the simplest fix is often "split the lock". One lock for the freelist, one for the index, one for stats. Three locks, no contention. The cohort lock is for cases where splitting is genuinely impossible.
