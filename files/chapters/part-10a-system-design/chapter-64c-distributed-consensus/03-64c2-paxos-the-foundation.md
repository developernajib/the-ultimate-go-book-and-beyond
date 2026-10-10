## 64C.2 Paxos - The Foundation

### The Classic Paxos Algorithm

Paxos was invented by Leslie Lamport and first described (informally) in 1989. It is the theoretical foundation upon which almost all practical consensus algorithms are built. Understanding Paxos is essential for understanding why Raft made the design choices it did.

**Roles in Paxos:**

| Role | Responsibility |
|---|---|
| **Proposer** | Proposes values, drives the protocol |
| **Acceptor** | Votes on proposals, maintains persistent state |
| **Learner** | Learns the decided value, takes action |

In practice, a single node usually plays all three roles simultaneously.

**The Single-Decree Paxos Protocol (choosing one value):**

```
PHASE 1: PREPARE / PROMISE
═══════════════════════════

Step 1a - Prepare:
  Proposer chooses a unique proposal number n (must be higher than any seen before).
  Proposer sends Prepare(n) to a majority of Acceptors.

Step 1b - Promise:
  Each Acceptor receiving Prepare(n):
    IF n > highest_promised:
      SET highest_promised = n
      RESPOND Promise(n, accepted_n, accepted_val)
        where accepted_n = highest proposal number this acceptor has accepted (null if none)
        and   accepted_val = value associated with that proposal (null if none)
    ELSE:
      IGNORE (or send Nack)

PHASE 2: ACCEPT / ACCEPTED
═══════════════════════════

Step 2a - Accept:
  If Proposer receives Promise from majority:
    IF any promise contained an (accepted_n, accepted_val):
      SET value = accepted_val from the promise with the HIGHEST accepted_n
      (The proposer MUST propose the previously accepted value, not its own)
    ELSE:
      SET value = proposer's own desired value
    SEND Accept(n, value) to majority of Acceptors

Step 2b - Accepted:
  Each Acceptor receiving Accept(n, value):
    IF n >= highest_promised:  (haven't promised to ignore n)
      SET accepted_n = n
      SET accepted_val = value
      RESPOND Accepted(n, value) to Proposer AND all Learners
    ELSE:
      IGNORE

DECISION:
  A Learner learns value v is decided when it receives
  Accepted(n, v) from a majority of Acceptors.
```

**ASCII diagram of a successful Paxos round:**

```
Proposer          Acceptor A       Acceptor B       Acceptor C
   │                  │                │                │
   │─── Prepare(5) ──→│                │                │
   │─── Prepare(5) ───────────────────→│                │
   │─── Prepare(5) ──────────────────────────────────→  │
   │                  │                │                │
   │←── Promise(5,null,null) ─────────│                │
   │←── Promise(5,null,null) ──────────────────────────│
   │←── Promise(5,null,null) ─────────────────────────────
   │  (got majority - can proceed to Phase 2)
   │                  │                │                │
   │─── Accept(5,"X") ───────────────→│                │
   │─── Accept(5,"X") ──────────────────────────────→  │
   │                  │                │                │
   │←── Accepted(5,"X") ──────────────│                │
   │←── Accepted(5,"X") ──────────────────────────────│
   │  (got majority - value "X" is decided)
   │                  │                │                │
```

**Why Paxos Is Correct**

The key insight is the **Phase 1 constraint**: if a proposer with number n learns that any acceptor has already accepted value v with some proposal number m < n, the proposer must adopt v. This ensures that:

1. If a value v is chosen (accepted by majority), any future proposer that reaches Phase 2 will discover v and re-propose it
2. The decision is permanent - no other value can be decided in the future

The safety proof relies on the fact that any two majorities share at least one acceptor (quorum intersection). If a value v was accepted by majority M1, and a new proposer polls majority M2, M1 and M2 share at least one acceptor who accepted v with proposal m. The new proposer will see m and adopt v.

**Why Paxos Is Hard to Implement**

As Google's Chandra, Griesemer, and Redstone wrote in their 2007 paper "Paxos Made Live": "There is a huge gap between the description of the Paxos algorithm and the needs of a real-world system."

Problems Paxos leaves unspecified:
- How are proposal numbers generated uniquely across nodes?
- How does a new leader efficiently recover the committed log?
- How do you handle multi-Paxos (replicated state machine)?
- How do cluster membership changes work?
- What happens during leader dueling (two proposers keep preempting each other)?
- How do you compact the log?
- How do you handle disk failures while persisting state?

Each of these requires significant engineering judgment, and small mistakes lead to subtle correctness bugs.

### Multi-Paxos - Extending to a Replicated Log

Single-decree Paxos chooses one value. A **replicated state machine** (like a database or a distributed log) requires deciding a sequence of values. Multi-Paxos extends Paxos by:

1. Electing a stable leader (using Paxos Phase 1)
2. The leader skips Phase 1 for subsequent log entries - it already has promises from a majority
3. Only Phase 2 (Accept/Accepted) is needed per log entry as long as the leader is stable

```
Multi-Paxos log replication (stable leader):

Index:    1        2        3        4
Leader:   Accept → Accept → Accept → Accept
          │        │        │        │
Replicas: Accepted Accepted Accepted ...
```

This optimization makes Multi-Paxos look more like Raft's normal operation. The difference is that Paxos's recovery protocol (when a leader fails and a new one takes over) requires careful handling of "holes" in the log and uncommitted entries.

### Where Paxos Is Used

| System | Algorithm |
|---|---|
| Google Chubby | Paxos |
| Google Spanner | Paxos per shard |
| Apache ZooKeeper | ZAB (Zookeeper Atomic Broadcast, Paxos-like) |
| Apache Cassandra | Paxos for lightweight transactions |
| Microsoft Azure | Paxos variants |

### Junior → FAANG: Understanding Paxos Well Enough to Explain Raft

Most engineers using Raft-based systems (etcd, CockroachDB, Consul) have never read the Paxos paper. Knowing Paxos at the level required for FAANG interviews does not require implementing it. It requires being able to answer: "Why did Raft exist if Paxos already solved the problem?"

**The two-phase structure as the key insight.** Phase 1 (Prepare/Promise) is where a proposer establishes that it has the right to propose by learning about any prior accepted values. Phase 2 (Accept/Accepted) is where the value is actually committed. The safety guarantee comes from the Phase 1 constraint: if any acceptor has already accepted a value, the proposer must adopt that value rather than proposing its own. This is the quorum intersection property in action: any two majorities share at least one acceptor, so any prior commitment will be discovered.

**Why Paxos is notoriously hard to implement.** The original Paxos paper specifies single-decree consensus (choosing one value). Multi-Paxos (choosing a sequence of values, i.e., a replicated log) requires all the following additions that the paper leaves unspecified: leader stabilization to skip Phase 1, recovery protocol for in-flight entries, cluster membership changes, log compaction, and handling of leader dueling (two proposers repeatedly preempting each other). Google's "Paxos Made Live" paper describes the gap between the algorithm and a production implementation as "enormous." Raft exists specifically because the Paxos-to-production gap is so large that teams consistently make safety-violating mistakes during the gap-filling process.

**Interview entry point for Paxos.** The most common Paxos question in FAANG interviews is: "What happens if two proposers compete simultaneously?" The answer: they can livelock, with each proposer's Prepare invalidating the other's prior promises. Multi-Paxos solves this by electing a stable leader who runs Phase 1 once and then uses only Phase 2 for subsequent entries, exactly as Raft does with its term-based leader model.

### Senior @ FAANG: Paxos Variants and Production Tradeoffs

**EPaxos and flexible quorums.** The standard Paxos quorum is a majority of nodes. Flexible Paxos (Heidi Howard, 2016) shows that you can use a smaller read quorum and a larger write quorum, or vice versa, as long as every read quorum and every write quorum overlap. A write quorum of four out of five nodes and a read quorum of two out of five guarantees overlap (4+2 > 5). This allows read-heavy workloads to serve from a smaller quorum at the cost of slower writes. Understanding this tradeoff is the kind of nuance that L7 interviewers probe: "Could you reduce read latency in a Spanner shard by using a smaller read quorum?" Yes, but you would then need to increase write quorum size to maintain overlap, increasing write latency and write amplification.

**Spanner's Paxos-per-shard architecture and its ADR implications.** Spanner runs one Paxos group per tablet (a range of rows). A single global Spanner deployment has millions of Paxos groups, each with three to five replicas. The key architectural decision is that each Paxos group is independent: a write to tablet A does not need coordination with tablet B. Cross-tablet transactions use two-phase commit with a Paxos-based coordinator. The ADR implication: you get horizontal scalability (more tablets = more throughput) at the cost of cross-tablet transaction overhead. Services designed for Spanner should minimize cross-shard transactions by collocating related data in the same tablet range.

**Governance: when to trust Paxos-based systems.** Chubby, Spanner, and ZooKeeper have been production-hardened for decades. A staff engineer evaluating whether to build on one of these systems should ask: what is the version of the library being used, what are the known correctness issues in that version, and is the team using it in a way that respects its consistency guarantees? ZooKeeper used as a metadata store with serializable reads (reading from followers) does not provide the linearizability guarantee teams often assume. This misuse is a class of correctness bug that only appears under specific failure conditions and is nearly impossible to reproduce in testing.

**Bar-raiser signal: tracing Paxos invariants through a real incident.** A common L6/L7 question is: "Tell me about a time you debugged a consistency issue in a distributed system." The expected depth is: identifying which consistency guarantee was violated, tracing it to a specific invariant in the consensus algorithm or its usage, and explaining what change would prevent it. "We had a split-brain and fixed it by restarting the cluster" is L4. "We had a split-brain caused by using serializable reads to gate a lock acquisition, replaced it with a linearizable read inside a transaction, and added a test for this specific failure mode" is L6.

---
