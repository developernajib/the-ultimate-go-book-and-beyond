## Consistency Models Overview

Distributed systems offer a spectrum of consistency models, from eventual consistency to linearizability, each trading correctness guarantees for performance and availability. The following comparison maps the models covered in this chapter to their real-world database implementations, helping you match consistency requirements to the right storage primitive.

```
┌───────────────────────────────────────────────────────────────────────┐
│                    Consistency Model Hierarchy                        │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Strongest    ┌─────────────────────────────────────┐                 │
│               │ Strict Serializability              │                 │
│               │ (Linearizable + Serializable)       │                 │
│               │ Example: Spanner, FoundationDB      │                 │
│               └────────────────┬────────────────────┘                 │
│                                │                                      │
│               ┌────────────────▼────────────────────┐                 │
│               │ Linearizability (External Consistency)│               │
│               │ Single-object, real-time ordering    │                │
│               │ Example: etcd, Zookeeper             │                │
│               └────────────────┬────────────────────┘                 │
│                                │                                      │
│               ┌────────────────▼────────────────────┐                 │
│               │ Sequential Consistency               │                │
│               │ All nodes see same order             │                │
│               │ Not tied to real time                │                │
│               └────────────────┬────────────────────┘                 │
│                                │                                      │
│               ┌────────────────▼────────────────────┐                 │
│               │ Causal Consistency                   │                │
│               │ Cause before effect                  │                │
│               │ Example: MongoDB sessions            │                │
│               └────────────────┬────────────────────┘                 │
│                                │                                      │
│               ┌────────────────▼────────────────────┐                 │
│               │ Eventual Consistency                 │                │
│               │ Replicas converge given time         │                │
│               │ Example: Cassandra, DynamoDB         │                │
│  Weakest      └─────────────────────────────────────┘                 │
│                                                                       │
│  Availability vs Consistency (CAP):                                   │
│  - Strong consistency (Raft/Paxos): Sacrifice availability            │
│  - Eventual consistency (Dynamo-style): Sacrifice consistency         │
│  - PACELC: Latency also matters: CA→L, PL→E                           │
└───────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading the Consistency Hierarchy for Practical Database Selection

The consistency hierarchy diagram is the single most useful tool for database selection interviews. When an interviewer describes a system (e.g., "design an e-commerce inventory system") and asks you to pick a storage layer, working top-down through the hierarchy lets you reason about requirements rather than reciting database marketing copy.

Start at the top: does the system require strict serializability? That is, does a transaction's timestamp need to respect real-world time ordering across data centers? For most systems the answer is no. Move down: does each individual operation need to appear instantaneous from the perspective of every observer, bounded by real time? That is linearizability. etcd and ZooKeeper provide this for coordination primitives, but at the cost of latency and partition sensitivity. For the inventory system: a user seeing a slightly stale count is acceptable, but double-selling the last unit is not. This maps to a transactional model with serializable isolation, not necessarily full linearizability.

Common junior mistake: choosing linearizability because it "sounds safest." At scale, linearizability for high-read-throughput paths (product listing, search) is prohibitively expensive. The right answer is to apply the strongest model only where correctness demands it (inventory decrement, payment charge) and the weakest acceptable model everywhere else (product description display).

PACELC is the refinement to CAP that junior engineers often underweight: even when there is no partition, you still face a latency vs consistency tradeoff. A system that always does a quorum read has higher consistency but higher latency, and that latency cost exists on every request, not just during failures.

### Senior @ FAANG: Governing Consistency Model Choices at Organization Scale

The consistency hierarchy diagram encodes choices that should be made once at the platform level and then enforced, not re-litigated by each feature team. The practical governance problem is that most engineers pick "eventual consistency" because it is the default in whatever framework they are using, not because they analyzed the requirements. The result is systems that have both stronger and weaker consistency than they need: stronger in places where the performance cost is paid unnecessarily, weaker in places where data correctness is violated silently.

An effective platform approach is to define consistency tiers and bind storage choices to tiers by data classification. Tier 1 (financial, identity, access control): serializable or strict serializable, specific approved databases, audit logging mandatory. Tier 2 (user-generated content, order state): causal or sequential consistency acceptable, specific approved databases. Tier 3 (analytics, recommendations, feeds): eventual consistency acceptable, widest choice. Every new service declares its tier in a service manifest, and infra tooling validates that the declared tier matches the actual storage choice.

The PACELC framing matters for SLO budgeting. A system operating within a single region on linearizable storage will have higher steady-state latency than the same system on eventually consistent storage, and that shows up in p99 numbers even during normal operations with no partitions. When a team owns an SLO and their storage choice is contributing 5ms of latency on every read just to provide stronger consistency than the use case requires, that is a cost that should be justified by the data classification, not by inertia.

Bar-raiser observation: strong candidates can name the consistency model provided by each database they have worked with and explain the operational consequence of that choice (e.g., "DynamoDB's eventually consistent reads saved us 1ms per read at our scale, but we needed to add compensating logic in the application to detect and handle stale cache hits because the replica lag could exceed our cache TTL during high write throughput"). Candidates who say "we used DynamoDB for consistency" without being able to name which consistency level have not thought this through.

---
