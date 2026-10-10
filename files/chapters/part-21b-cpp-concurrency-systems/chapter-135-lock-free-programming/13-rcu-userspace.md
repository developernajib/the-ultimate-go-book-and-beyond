## RCU in Userspace

Read-Copy-Update originated in the Linux kernel (Paul McKenney, 1998) and was ported to userspace as `liburcu` (Mathieu Desnoyers, 2009). RCU is the production reclamation scheme for read-mostly data structures. Readers pay almost nothing on the read path. Writers pay an explicit grace period.

### RCU Primitives

Four operations form the core API.

```c
rcu_read_lock();
rcu_read_unlock();
rcu_dereference(p);
rcu_assign_pointer(p, v);
synchronize_rcu();
call_rcu(head, callback);
```

`rcu_read_lock` opens a read-side critical section. `rcu_dereference` does a consume-or-acquire load of a shared pointer. `rcu_assign_pointer` does a release store to publish a new pointer. `synchronize_rcu` blocks until every reader currently inside a critical section has exited. `call_rcu` registers a callback that fires after the next grace period, giving an asynchronous version of synchronize.

A standard RCU update pattern:

```c
struct node *old = rcu_dereference(head);
struct node *new = malloc(sizeof *new);
*new = *old;
new->value = updated_value;
rcu_assign_pointer(head, new);
synchronize_rcu();
free(old);
```

The grace period guarantees that no reader still holds a pointer to `old`, so freeing is safe.

### The Four Userspace Flavors

liburcu ships four implementations of the same API with different trade-offs.

**QSBR (Quiescent State Based Reclamation).** Fastest readers (no instructions on the read path), but every thread must periodically call `rcu_quiescent_state()` to declare itself out of any critical section. Designed for long-running threads in event loops or per-CPU worker threads.

**MB (Memory Barrier).** Each `rcu_read_lock` issues a full memory barrier. Slower readers but no quiescent-state contract. Use when threads cannot reliably mark themselves quiescent.

**MEMB (Memory Barrier with explicit lock).** Variant of MB with a counter incremented on read_lock. Slightly different ordering rules. Mostly historical.

**SIGNAL.** Readers do nothing on read_lock except increment a thread-local counter. Writers send `SIGUSR1` to every reader to force a barrier on the receiving side. Read path is as fast as QSBR without the quiescent-state contract, but `synchronize_rcu` is expensive (one signal per thread).

**BP (Bulletproof).** No registration required. Threads can come and go. Slightly slower than MB. Suitable for libraries embedded in applications that do not control thread lifetimes.

### Cost Per Read in Cycles

Measurements on Xeon Gold 6252 (Cascade Lake), single thread, hot cache:

| Flavor | rcu_read_lock | rcu_read_unlock | rcu_dereference |
| --- | --- | --- | --- |
| QSBR | 0 (compiler barrier only) | 0 | 1-2 (acquire load) |
| MB | 25-35 (mfence) | 25-35 | 1-2 |
| SIGNAL | 2-3 (TLS counter) | 2-3 | 1-2 |
| BP | 8-12 (TLS branch) | 8-12 | 1-2 |
| MEMB | 4-6 (TLS counter+barrier) | 4-6 | 1-2 |

QSBR's read path is essentially free. The cost moves to the application, which must call `rcu_quiescent_state` between work units. In a packet processing loop running at 10 Mpps that cost is amortized to nothing.

### Linux Kernel RCU vs Userspace RCU

Kernel RCU exploits properties userspace cannot.

**Preemption disabling.** Kernel readers run with preemption off, so a grace period is "every CPU has executed at least one context switch". Detecting this is a per-CPU counter check. No reader-side code is needed.

**Per-CPU data.** The kernel pins data to CPUs. Userspace RCU must use thread-local storage and registration tables.

**No signals needed.** Kernel can interrupt a CPU directly. Userspace SIGNAL flavor sends actual POSIX signals, which incur kernel transitions.

The result is that kernel RCU readers are literally zero-cost. The compiler emits no extra instructions for `rcu_read_lock`. Userspace QSBR is the closest equivalent, paying only a compiler fence.

### When to Choose Which Flavor

QSBR. Long-lived threads, event-loop architecture, you control all thread lifetimes. DPDK, ScyllaDB, kernel-bypass networking. Best read latency.

MB. Mixed thread lifetimes, cannot guarantee quiescent calls, but synchronize_rcu must be fast. General-purpose userspace.

SIGNAL. Read-mostly with rare updates, willing to pay multi-millisecond synchronize cost in exchange for cheap reads. Configuration distribution, route tables.

BP. Library code embedded in applications you do not control. Plugin systems, JNI bridges.

### Concrete C++ Code with liburcu QSBR

```cpp
#define _LGPL_SOURCE
#include <urcu-qsbr.h>
#include <urcu/rculist.h>
#include <atomic>

struct Config {
    int max_connections;
    int timeout_ms;
};

static std::atomic<Config*> g_config{nullptr};

void worker_loop() {
    rcu_register_thread();
    while (running.load(std::memory_order_relaxed)) {
        rcu_read_lock();
        Config* c = static_cast<Config*>(rcu_dereference(g_config.load(std::memory_order_acquire)));
        do_work(c->max_connections, c->timeout_ms);
        rcu_read_unlock();
        rcu_quiescent_state();
    }
    rcu_unregister_thread();
}

void update_config(int max_conn, int timeout) {
    Config* fresh = new Config{max_conn, timeout};
    Config* old = g_config.exchange(fresh, std::memory_order_acq_rel);
    synchronize_rcu();
    delete old;
}
```

The `rcu_quiescent_state` call after each work unit is what enables the QSBR flavor's zero-cost read path. The grace period detector waits until each registered thread has called quiescent_state at least once after the swap, which proves no reader can still hold the old pointer.

### call_rcu for Asynchronous Reclamation

`synchronize_rcu` blocks the writer. `call_rcu` does not.

```c
struct rcu_head {
    struct rcu_head* next;
    void (*func)(struct rcu_head* head);
};

void free_callback(struct rcu_head* h) {
    Config* c = caa_container_of(h, Config, rcu);
    delete c;
}

struct Config {
    int max_connections;
    int timeout_ms;
    struct rcu_head rcu;
};

void update_config_async(int mc, int tm) {
    Config* fresh = new Config{mc, tm, {}};
    Config* old = g_config.exchange(fresh, std::memory_order_acq_rel);
    call_rcu(&old->rcu, free_callback);
}
```

`call_rcu` enqueues the head on a per-thread or global call_rcu queue processed by a dedicated thread. The caller returns immediately. Production systems prefer call_rcu for write-heavy paths because synchronize_rcu blocks for milliseconds in the worst case.

### defer_rcu and Bulk Reclamation

liburcu also offers `defer_rcu` which batches frees across a single grace period. Useful when a writer needs to free many nodes after one update (for example, replacing an entire array).

```c
defer_rcu(free_callback, old);
```

Internally `defer_rcu` uses a per-thread bag and triggers a single `synchronize_rcu` when the bag fills.

### Junior to FAANG: rcu_dereference Is Not Optional

The dangerous bug junior engineers write:

```cpp
Node* n = head.load(std::memory_order_relaxed);
int v = n->value;
```

Without `rcu_dereference` (which on Alpha emits a memory barrier and on every other architecture is a consume-load), the compiler can speculate the load of `n->value` past the load of `head`. On a weakly-ordered platform, the speculated value can be stale and disagree with the pointer. The fix is `rcu_dereference` or `std::memory_order_acquire`.

A FAANG engineer also knows that `rcu_assign_pointer` is not interchangeable with a relaxed store. The release store ensures that initialization writes to the new node are visible before the pointer that exposes them.

### Senior at FAANG: RCU and Reference Counting Together

Pure RCU does not let a reader extract a long-lived reference outside the read-side critical section. If a reader needs to hand a node off to another thread, RCU plus refcount is the pattern.

```cpp
rcu_read_lock();
Node* n = rcu_dereference(head);
n->refcount.fetch_add(1, std::memory_order_acq_rel);
rcu_read_unlock();
// safe to use n outside the critical section, must release later
```

The acquire on the increment serializes with the writer's check before freeing. The writer must `synchronize_rcu` and then check `refcount == 0` before freeing. Linux's dcache and inode cache use this pattern.

### Standardization

P0461 (Paul McKenney) proposed adding RCU primitives to C++ but stalled. P1122 (also McKenney) is the current draft for `std::rcu_obj_base` and `std::rcu_domain`. Folly's `folly/synchronization/Rcu.h` ships a near-complete implementation that mirrors the proposed standard surface.

```cpp
#include <folly/synchronization/Rcu.h>

struct Entry : folly::rcu_obj_base<Entry> {
    int value;
};

folly::rcu_domain<>& domain = folly::rcu_default_domain();

void writer(std::atomic<Entry*>& slot, int v) {
    Entry* fresh = new Entry{{}, v};
    Entry* old = slot.exchange(fresh, std::memory_order_acq_rel);
    if (old) old->retire();
}

int reader(std::atomic<Entry*>& slot) {
    folly::rcu_reader g;
    Entry* e = slot.load(std::memory_order_acquire);
    return e ? e->value : -1;
}
```

`folly::rcu_reader` is the C++ scope guard equivalent of `rcu_read_lock`/`rcu_read_unlock`. `retire()` does a `call_rcu`-style enqueue. The default domain runs a background reclaimer thread.
