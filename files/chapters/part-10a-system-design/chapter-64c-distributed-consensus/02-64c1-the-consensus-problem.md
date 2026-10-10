## 64C.1 The Consensus Problem

### What Is Distributed Consensus?

Distributed consensus is the problem of getting multiple independent processes to agree on a single value (or a sequence of values), even in the presence of failures.

More formally: given N processes, each with an initial proposed value, a consensus algorithm must satisfy:

| Property | Definition |
|---|---|
| **Agreement** | No two correct processes decide different values |
| **Validity** | The decided value must have been proposed by some process |
| **Termination** | Every correct process eventually decides |

This sounds simple. It is not. The moment you introduce the possibility of process crashes, network partitions, or message delays, the problem becomes extraordinarily difficult.

### Why Consensus Is Hard

Consider a simple scenario: you have three database replicas. A client writes value `X`. The primary receives the write and needs to tell the replicas. Now:

- What if the primary sends the write to replica 1, then crashes before sending to replica 2?
- What if the network partitions - replica 1 is in one partition, replica 2 in another?
- What if a message is delayed and arrives after a leadership change?
- What if the client cannot tell whether its write succeeded (the primary crashed after writing but before acknowledging)?

Each of these scenarios can lead to a different replica having a different value - violating agreement. Consensus algorithms are specifically designed to handle all of these cases.

The fundamental difficulties:

```
DIFFICULTY 1: Network partitions
┌─────────────────────────────────────────────┐
│  Node A ←──────── PARTITION ────────→ Node B│
│     │                                    │  │
│  Node C ←─────────────────────────────→ │   │
└─────────────────────────────────────────────┘
Nodes A and C can communicate. Node B is isolated.
Who is the "truth"? How do we prevent A and B from
both thinking they are the leader?

DIFFICULTY 2: Message loss
 Send(msg) → [NETWORK] → ???
The sender does not know if the message was lost,
delayed, or delivered but the response was lost.

DIFFICULTY 3: Process crashes
A process can crash at ANY point - even in the
middle of writing to disk. How do we know if a
crashed node had committed a value before crashing?

DIFFICULTY 4: Byzantine failures (harder, out of scope)
A malicious or buggy process can send contradictory
messages to different nodes. BFT algorithms handle
this; CFT (Crash Fault Tolerant) algorithms like Raft
and Paxos assume nodes are honest but may crash.
```

### CAP Theorem Revisited Through Consensus

The CAP theorem states that a distributed system can provide at most two of:
- **Consistency** - every read receives the most recent write
- **Availability** - every request receives a response
- **Partition Tolerance** - the system continues operating despite network partitions

Since network partitions are a fact of life (you cannot prevent them), the real trade-off is **CP vs AP** during a partition:

| Choice | During Partition | Example Systems |
|---|---|---|
| **CP** | Refuse requests to avoid inconsistency | etcd, ZooKeeper, CockroachDB |
| **AP** | Serve stale data rather than refusing | Cassandra, DynamoDB (eventually consistent) |

**Consensus algorithms choose CP.** This is the correct choice when correctness is more important than availability - for leader election, distributed locks, configuration storage, and coordination. Raft and Paxos-based systems will become unavailable (stop accepting writes) if they cannot reach a quorum. This is intentional: it prevents split-brain scenarios.

The key insight: **a consensus system with N nodes tolerates `floor((N-1)/2)` failures.** With 3 nodes, it tolerates 1 failure. With 5 nodes, 2 failures. With 7 nodes, 3 failures.

```
Fault Tolerance Table:
┌─────────┬──────────┬─────────────────┐
│ Cluster │  Quorum  │ Max Failures    │
│  Size   │ Required │ Tolerated       │
├─────────┼──────────┼─────────────────┤
│    1    │    1     │ 0 (no HA)       │
│    2    │    2     │ 0 (no HA)       │
│    3    │    2     │ 1               │
│    5    │    3     │ 2               │
│    7    │    4     │ 3               │
│    9    │    5     │ 4               │
└─────────┴──────────┴─────────────────┘
RECOMMENDATION: 3 nodes for most production systems.
5 nodes if you need to tolerate 2 simultaneous failures.
More than 7 nodes: write performance degrades significantly.
```

### FLP Impossibility - What It Means in Practice

In 1985, Fischer, Lynch, and Paterson published a landmark result: **in a purely asynchronous distributed system (where message delays are unbounded), it is impossible to solve consensus, even with just one faulty process.**

This is known as the FLP impossibility result. It is not a bug. It is a fundamental theorem of distributed computing.

**What does "asynchronous" mean here?** It means you cannot distinguish between a process that has crashed and a process that is running slowly. If you cannot tell whether a message recipient has crashed or is just slow, you can never be sure whether to wait for its response or move on.

**Does this mean consensus is impossible?** No - it means you must relax one of the assumptions:
1. Introduce **timeouts** (assume that if a node does not respond in T milliseconds, it has crashed) - this is what Raft and Paxos do. Timeouts are a form of synchrony.
2. Use **randomization** - by randomly choosing retry intervals, processes can break symmetry (used in some BFT algorithms).
3. Accept that **termination** (liveness) is not always guaranteed - the algorithm is always safe (consistent) but may not always make progress.

**Practical implication for Go engineers:** Every consensus system you use (Raft, Paxos, ZAB) uses timeouts to break the FLP impossibility. This means:
- **During a partition**, the minority side will time out on the leader and stop making progress (correct)
- **Under high latency**, election timeouts may fire spuriously, causing unnecessary elections
- **Tuning timeouts** is a critical operational concern - too low and you get false elections. Too high and failover is slow

### Real-World: When Must You Have Consensus?

Use consensus when you need **strong consistency** (linearizability) for coordination:

```
MUST use consensus:
├── Leader election (who is the primary?)
├── Distributed locks (who holds the lock?)
├── Configuration management (what is the current config?)
├── Sequence number generation (what is the next unique ID?)
├── Distributed transactions (2PC coordinator election)
└── Cluster membership (which nodes are in the cluster?)

CAN AVOID consensus:
├── User data storage (eventual consistency may be fine)
├── Caches (staleness is acceptable)
├── Analytics / metrics (approximate is fine)
├── Read-heavy workloads (replicate with eventual consistency)
└── High-throughput writes (use conflict-free data structures)
```

The most important lesson for FAANG interviews: **most services do not need consensus**. Consensus is expensive (at minimum one network round-trip per operation). Reach for it only when you genuinely need linearizable coordination.

### Junior → FAANG: Building Intuition for the Consensus Problem

The formal properties (agreement, validity, termination) feel abstract until you tie them to concrete failure stories. Here is the worked intuition.

**Agreement violation in the wild.** Imagine a payment service with two replicas. The primary receives a charge request and writes to its local log. Before it can replicate to the secondary, it crashes. The secondary has no record of the charge. The client retries against the secondary, the charge goes through, and the customer is double-charged. This is an agreement violation: the two replicas decided on different states for the same sequence number. Consensus prevents this by requiring that a write is not acknowledged until a majority has recorded it.

**Termination and why it conflicts with the others.** The FLP result says you cannot guarantee all three properties simultaneously in a purely asynchronous system. The practical implication: Raft sacrifices guaranteed termination under adversarial conditions. During a network partition, the minority side stops making progress. This is a deliberate choice: correctness (agreement) is preserved at the cost of liveness (termination). In a FAANG interview, when asked "what happens if the etcd cluster loses quorum," the correct answer is not "it keeps serving stale data." It is "it stops accepting writes and returns errors, which is the correct behavior because stale data would violate agreement."

**CAP theorem framing for interviews.** The CP vs AP choice is not a global property of a system architecture. It is a per-operation property. A system can use a Raft-backed metadata store (CP) for configuration and a Cassandra cluster (AP) for user data. Distinguish these in interviews: "For the leader election subsystem I would use etcd (CP), but for the user activity feed I would use Cassandra with tunable consistency (AP for reads, LOCAL_QUORUM for writes)."

**Fault tolerance table as interview shorthand.** "We have a five-node cluster" should immediately make you say "we can tolerate two simultaneous failures." If an interviewer asks why you chose five nodes over three, the answer is: "three tolerates one failure, which means we cannot do a rolling upgrade and simultaneously absorb a hardware failure. Five gives us two-failure tolerance, which covers that case."

### Senior @ FAANG: The Consensus Problem as an Architectural Forcing Function

At senior level, the consensus problem is not a theory question. It is the forcing function that shapes every platform architecture decision involving coordination.

**ADR: when to introduce a consensus dependency.** The threshold question for any new service is: does this coordination problem require linearizability, or does it only require serializability or eventual consistency? Linearizability is the strongest guarantee and has the highest cost: one network round trip per operation, quorum writes, and full CP semantics. Services that use etcd for eventually-consistent key lookups are paying the linearizability tax without needing the guarantee. An architectural review process should require justification for any new etcd dependency.

**Governance: failure mode documentation.** Every service that depends on a consensus system must have documented failure modes in its runbook. At minimum: what happens when the consensus cluster is unavailable? Does the service return errors, serve stale data, or serve an empty fallback? Each choice has different implications for downstream services. A staff engineer ensures that these failure modes are explicit, tested with chaos experiments, and reflected in the service's SLA language.

**Platform thinking: consensus cluster as shared infrastructure.** In a large organization, a single etcd cluster may serve dozens of teams. The platform engineering team owns the cluster SLA, but every team that uses it contributes to cluster load. Watch streams are particularly expensive: each active watch stream holds a goroutine on the etcd server. A team that creates 10,000 watch streams for individual keys is degrading the cluster for everyone. Staff engineers define watch cardinality limits and enforce them through policy and code review.

**Maturity model: from "we use etcd" to "we own the consensus layer."** Level 1 teams know that etcd stores their configuration but cannot answer what happens when it is unavailable. Level 2 teams have circuit breakers around etcd calls but have not tested them. Level 3 teams have chaos experiments that verify behavior during etcd unavailability and have measured the recovery time. Level 4 teams have capacity plans for their etcd watch stream count, lease count, and key space growth, and they have a runbook for compaction, defragmentation, and certificate rotation. Driving your team from level 2 to level 4 is staff-level platform work.

**L6/L7 concern: the FLP impossibility in practice.** The most sophisticated interview candidates at L7 can articulate why the FLP result matters even when you are using a timeout-based system: the timeout parameters are tunable and have operational consequences. An election timeout of 150ms is aggressive: under heavy GC load or noisy-neighbor disk I/O, heartbeats can be delayed past 150ms and cause spurious elections. An election timeout of 1000ms means a leader failure takes up to one second to detect. The right timeout depends on your workload, your hardware, and your availability target. That is not a theoretical concern: it is an operational decision that a senior engineer must own.

---
