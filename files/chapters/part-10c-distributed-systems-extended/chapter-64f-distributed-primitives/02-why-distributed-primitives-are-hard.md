## Why Distributed Primitives Are Hard

Single-machine primitives (mutex, semaphore, counter) are easy - they rely on shared memory and OS guarantees. Distributed primitives must handle:

```
┌───────────────────────────────────────────────────────────────────┐
│               Distributed Primitives Challenges                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Single Node              Distributed                             │
│  ──────────               ────────────                            │
│  Mutex → Lock()           Distributed Lock:                       │
│  Guaranteed exclusive     - Network partition = two holders       │
│  No TTL needed            - TTL required (process may die)        │
│  No split-brain           - Fencing tokens prevent split-brain    │
│                                                                   │
│  Counter: i++             Distributed Counter:                    │
│  Atomic on one core       - Concurrent writes → conflicts         │
│  Zero latency             - Quorum writes → high latency          │
│  Never lost               - Replica may be lost                   │
│                                                                   │
│  Leader Election:         Distributed Leader Election:            │
│  Thread with lock         - Multiple leaders possible (split)     │
│  Instant promotion        - Election takes 100ms-1s               │
│  No term concept          - Term number prevents stale leaders    │
│                                                                   │
│  Key Tool: etcd           etcd guarantees:                        │
│  (Uses Raft)              - Linearizable reads/writes             │
│                           - Watch notifications                   │
│                           - Lease TTLs                            │
│                           - Transactions (compare-and-swap)       │
└───────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Comparison Table to Reason About Failure Modes

The diagram's three-column comparison (single-node primitive, distributed primitive, what breaks it) is the reasoning pattern you need to apply in every distributed systems design question. When an interviewer describes a system that uses a mutex, a counter, or a leader, your first instinct should be to mentally translate each to its distributed equivalent and identify the specific failure mode that does not exist in the single-node version.

"Mutex: lock held forever if holder dies" is the failure mode that does not exist for kernel mutexes (the OS automatically releases all locks held by a dead process) but does exist for distributed locks (the lock backend has no way to know if the holder process crashed or is just slow). The fix (TTL on the lock) creates a new failure mode (lock expires while holder is still alive, two concurrent holders). The fix for that (fencing tokens) is the correct production answer.

"Counter: concurrent writes cause conflicts" is the failure mode that does not exist for atomic CPU operations but does for distributed counters. The fix depends on the use case: if you need an exact count (inventory quantity), you need coordination (compare-and-swap or a serializing lock). If you can tolerate approximate counts (analytics event count, view counter), you can use CRDTs or probabilistic counting.

"Leader election: term number prevents stale leaders" is the key insight that transforms a leader election from a single-machine concept to a distributed one. The term number (or epoch number) is the distributed system's equivalent of the OS's notion of process identity: a leader in term 5 that reconnects after a partition and discovers that term 6 has been running knows it is stale and must step down.

Commit this pattern: for every single-machine primitive you know, ask "what is the distributed failure mode, what is the fix, and what new failure mode does the fix introduce?" This iterative question chain is the standard design interview progression for distributed primitives.

### Senior @ FAANG: Modeling the Failure Space Before Building the Primitive

At the senior level, "why distributed primitives are hard" is not a conceptual understanding problem: it is a prerequisite for correctly specifying the system before implementation begins. Building a distributed lock without first enumerating the failure space leads to implementations that handle the happy path but fail in production under real failure conditions.

The failure space for a distributed lock has at least four dimensions that must be analyzed before implementation: process failure (lock holder crashes before releasing), network partition (lock holder cannot communicate with the lock backend but is still running), clock skew (lock TTL expires from the backend's perspective but not from the holder's), and backend failure (the lock backend crashes or becomes unavailable). Each dimension produces a different failure mode and requires a different fix.

A rigorous specification for a distributed lock should document: (1) what safety property is guaranteed (at most one holder at a time, with fencing), (2) what liveness property is guaranteed (the lock will eventually be acquirable after a holder failure, bounded by TTL), (3) what assumptions the implementation makes (clock skew is bounded by X ms, TTL is greater than maximum GC pause, etc.), and (4) what happens when each assumption is violated. An implementation without this specification is unreviable: you cannot tell whether it is correct or not without re-deriving the requirements.

etcd's guarantee list in the diagram (linearizable reads/writes, watch notifications, lease TTLs, transactions) maps directly to which failure modes it handles. Linearizable reads mean the lock acquisition is always based on the current state, not a stale replica. Lease TTLs mean the lock auto-releases on holder crash. Transactions (compare-and-swap) mean the lock acquisition is atomic. Watch notifications mean waiters are notified immediately when the lock is released. A Redis SETNX implementation has none of these properties except TTL (and even TTL has the GC-pause race). This is why the correct recommendation for correctness-critical locking is etcd, not Redis.

---
