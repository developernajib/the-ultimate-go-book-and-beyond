## Overview

Lock-free programming is one of the most demanding disciplines in systems engineering. Where mutexes serialize access to shared data, creating bottlenecks and risking deadlocks, lock-free algorithms allow multiple threads to make progress simultaneously without ever acquiring a lock. The trade-off is complexity: lock-free code is notoriously difficult to write correctly, debug, and reason about.

This chapter builds directly on Chapter 134's coverage of atomics and memory model. We move from individual atomic operations to composing them into complete data structures and algorithms that guarantee system-wide progress. We will implement lock-free stacks and queues, confront the infamous ABA problem, explore wait-free algorithms, and examine Read-Copy-Update (RCU) patterns. Along the way, we compare C++ approaches with Go's channel-based concurrency model.

A word of caution: lock-free programming is rarely the right first choice. Mutexes are simpler, well-understood, and sufficient for the vast majority of applications. Reach for lock-free techniques only when profiling proves that lock contention is your bottleneck, or when you need guarantees about forward progress that locks cannot provide.

### Progress Guarantees: A Hierarchy

Before diving in, let us define the progress guarantees precisely:

- **Blocking (mutex-based):** If a thread holding a lock is suspended, all other threads waiting for that lock are also blocked. No progress guarantee if the scheduler is adversarial.
- **Obstruction-free:** A thread makes progress if it runs in isolation (no contention). The weakest non-blocking guarantee. Useful as a building block.
- **Lock-free:** At least one thread in the system completes its operation in a finite number of steps, regardless of what other threads do. Individual threads may starve, but the system as a whole always moves forward.
- **Wait-free:** Every thread completes its operation in a bounded number of steps, regardless of contention. The strongest guarantee. No thread ever starves.

Each level is strictly stronger than the one above it. Most "lock-free" data structures in practice provide the lock-free guarantee. True wait-free structures are rare outside academic literature and highly specialized systems.

### Junior → FAANG: Progress Guarantees as Interview Vocabulary

Knowing the three progress levels, obstruction-free, lock-free, and wait-free, is table stakes for FAANG systems interviews. More important is knowing when each applies.

Obstruction-free is rarely used in practice. Lock-free is the standard goal for production lock-free data structures. Wait-free is required in hard real-time systems where every thread must complete in bounded time regardless of what other threads do (e.g., a flight control system's sensor update loop).

For most FAANG interview contexts: "lock-free" is what they want. If asked to implement a stack or queue that is lock-free, the answer involves a CAS loop where at least one thread succeeds per round even under contention.

### Senior @ FAANG: Progress Guarantees as System-Level SLA Inputs

At L5+, the choice between lock-free and wait-free is a system-level SLA decision. Lock-free guarantees system-wide progress but not individual thread progress. A single thread can theoretically starve forever if it always loses the CAS race. In a high-concurrency server, this is the source of p99.99 latency outliers: the "unlucky" thread that retried 100 times before succeeding.

The senior analysis: if your p99.99 latency SLA requires bounded worst-case operation time, you need wait-free or a lock-based approach with priority inheritance. Lock-free with backoff narrows the distribution but does not bound it. This distinction matters when writing SLA commitments for internal platform services.

Platform-level implication: Folly's `MPMCQueue` is lock-free (not wait-free). Under extreme contention (>256 producers hitting one queue simultaneously), you will see p99.9 outliers. The solution is queue sharding: N queues, each producer assigned to one. Sharding converts a high-contention lock-free structure into N low-contention lock-free structures, each with better practical tail latency.

---
