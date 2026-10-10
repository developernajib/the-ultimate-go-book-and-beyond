## 58.1 Distributed Systems Basics

### The CAP Theorem

The CAP theorem, conjectured by Eric Brewer in 2000 and formally proved by Gilbert and Lynch in 2002, states that a distributed system can only guarantee two of three properties simultaneously: consistency (every read receives the most recent write), availability (every request receives a non-error response), and partition tolerance (the system continues operating despite network failures between nodes). Since network partitions are unavoidable in any real distributed system, the practical choice is between CP (sacrifice availability during a partition) and AP (sacrifice consistency during a partition). The diagram below shows where common systems fall:

```
                    ┌─────────────────┐
                    │   Consistency   │
                    │                 │
                    │  All nodes see  │
                    │   same data at  │
                    │    same time    │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
    ┌───────────┐    ┌───────────┐    ┌───────────┐
    │    CA     │    │    CP     │    │    AP     │
    │           │    │           │    │           │
    │  Single   │    │  MongoDB  │    │ Cassandra │
    │   Node    │    │   Consul  │    │  DynamoDB │
    │  (RDBMS)  │    │   etcd    │    │   Riak    │
    └───────────┘    └───────────┘    └───────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
    ┌─────────────────┐         ┌─────────────────┐
    │   Availability  │         │   Partition     │
    │                 │         │   Tolerance     │
    │  Every request  │         │                 │
    │  gets response  │         │  System works   │
    │  (success/fail) │         │  despite network│
    │                 │         │    failures     │
    └─────────────────┘         └─────────────────┘
```

### PACELC Theorem

CAP only describes behavior during a partition, but most of the time the network is healthy. PACELC extends CAP by adding a second axis: when there is no partition (the "else" case), the system must still choose between latency and consistency. A system classified as PA/EL prioritizes availability during partitions and low latency during normal operation (good for social feeds), while PC/EC prioritizes consistency in both cases (necessary for financial records).

```
IF Partition:
    Choose between Availability and Consistency (CAP)
ELSE (normal operation):
    Choose between Latency and Consistency

Examples:
┌──────────────┬───────────────────────────────────────────┐
│   System     │            PACELC Classification          │
├──────────────┼───────────────────────────────────────────┤
│ DynamoDB     │ PA/EL - Availability + Low Latency        │
│ Cassandra    │ PA/EL - Availability + Low Latency        │
│ MongoDB      │ PA/EC - Availability + Consistency        │
│ HBase        │ PC/EC - Consistency + Consistency         │
│ PNUTS        │ PC/EL - Consistency + Low Latency         │
└──────────────┴───────────────────────────────────────────┘
```

These classifications follow Abadi's original PACELC paper. MongoDB illustrates why the two frameworks can disagree: it is conventionally called CP because reads and writes go through the primary, but Abadi classified it PA/EC based on failover behavior in which a partitioned primary could accept writes that were later rolled back. Classifications describe default configurations, and tuning (read concerns, write concerns, quorum settings) moves a system along these axes.

### Consistency Models

Not all data requires the same consistency guarantees, and choosing the wrong model forces unnecessary latency or operational complexity. Strong consistency achieves linearizability by routing all reads through the primary replica or using consensus protocols like Raft, which means every read reflects the most recent committed write, at the cost of cross-datacenter round trips on every operation. Eventual consistency allows replicas to diverge temporarily and converge in the background, enabling local reads with single-digit millisecond latency, but requires the application to tolerate stale reads. Causal and read-your-writes consistency sit between these extremes, preserving logical ordering without requiring global synchronization, making them well-suited for collaboration tools and user-facing profile updates where a user must see their own changes immediately but doesn't need to see every other user's writes in real time.

```go
// Different consistency levels in distributed systems

// Strong Consistency - All reads see most recent write
// Example: Traditional RDBMS, etcd, Consul
type StrongConsistency struct {
    // Every read returns the most recent write
    // Highest latency, lowest throughput
    // Use when: Financial transactions, inventory counts
}

// Eventual Consistency - Reads may see stale data temporarily
// Example: DNS, Cassandra, DynamoDB (default)
type EventualConsistency struct {
    // Writes propagate asynchronously
    // Eventually all replicas converge
    // Lowest latency, highest throughput
    // Use when: Social media feeds, analytics
}

// Causal Consistency - Respects causality order
// Example: COPS, MongoDB (with read concern)
type CausalConsistency struct {
    // If A causes B, everyone sees A before B
    // Middle ground between strong and eventual
    // Use when: Collaborative editing, chat applications
}

// Read-Your-Writes Consistency
// Example: Session-based systems
type ReadYourWritesConsistency struct {
    // User always sees their own writes
    // Other users may see stale data
    // Use when: User profile updates
}
```

### Junior → FAANG: Making CAP Theorem Concrete

The CAP theorem is frequently misapplied because candidates treat it as a classification exercise rather than a design tool. Two misconceptions to eliminate before your first FAANG screen.

First, "partition tolerance is optional" is wrong. Network partitions happen in every distributed system, including ones running inside a single data center. The actual choice is between CP and AP, not between CA and everything else. CA only exists for a single-node system, which is not distributed.

Second, the CAP choice is not made once for a system: it is made per data type. A payment ledger within the same application can be CP (strong consistency, refuse writes during a partition) while a user activity feed in the same system is AP (accept writes from any region, converge later). Understanding this makes your interview answers significantly more nuanced.

Practice exercise: for each consistency model in the code above (strong, eventual, causal, read-your-writes), write down one feature at a company you know that uses it, explain why it makes sense for that feature, and name the user-visible failure that would occur if the wrong model were chosen instead. This forces you to move from abstract classification to concrete reasoning, which is exactly what FAANG interviewers want to see.

PACELC is often skipped by candidates who only studied CAP. Mentioning it unprompted in an interview, along with the observation that latency versus consistency during normal operation is often the more relevant trade-off than partition behavior, is a strong signal of senior-level thinking.

### Senior @ FAANG: Consistency Contracts and Organizational Governance

At staff level, the CAP theorem is not a discussion topic. It is an engineering contract that must be enforced across the services you own or influence. The challenge is not knowing the theory: it is preventing engineers from violating consistency guarantees silently, often because they use a database in a way the original designers did not intend.

**Consistency contracts as ADRs.** For each data store in your platform, the ADR should specify: the consistency model in use, the maximum acceptable replication lag (expressed as a p99 SLO, not just "eventual"), the behavior during a network partition (return error, return stale data, or queue writes), and which data types are allowed to use each store. Without these constraints documented, a new engineer will use a Cassandra table for financial records because it was the closest thing available, and you will discover the consistency problem during an audit.

**Replication lag as a first-class SLO.** At Netflix, DynamoDB Global Tables replication lag is monitored as a service-level metric, not just an infrastructure metric. If replication lag for user preference data exceeds a threshold, a dashboard alert fires and the on-call engineer investigates. Most teams treat replication lag as invisible infrastructure plumbing. A staff engineer treats it as a product SLO violation because stale data in an AP system is not a theoretical risk: it is a customer experience issue with a measurable frequency.

**PACELC in multi-region architecture reviews.** When reviewing a proposed multi-region design, ask: what is the latency penalty of the chosen consistency level during normal operation (the "else" branch of PACELC)? A team that answers "we don't know" has not made a deliberate consistency decision. The answer should be a specific number derived from the replication protocol round-trip time, not a shrug. For cross-region synchronous commits (PC/EC), that number is typically 50-150ms depending on geography, and it appears directly in the p99 latency of every write operation. If the write SLO is 100ms, synchronous multi-region commits are incompatible and the team must either accept asynchronous replication (PA/EL) or redesign the write path.

**Bar-raiser signal.** An L6 or L7 candidate who discusses PACELC unprompted and can name the specific latency cost of their chosen consistency model in milliseconds, not just "some overhead," is demonstrating the kind of precision that staff-level technical leadership requires.

---
