# Chapter 64E: Advanced Consistency and Replication

> *"Distributed systems do not fail in the ways that single-machine systems fail. They fail in ways that are subtle, partial, and time-dependent - and the consistency model you choose determines whether your system tells users the truth, a plausible lie, or an outright contradiction."*

The CAP theorem established that a distributed system under network partition must choose between consistency and availability. But this binary framing obscures the rich spectrum of consistency models between strict linearizability and eventual consistency. Strong consistency guarantees that every read sees the most recent write, as if operations executed on a single machine. Causal consistency preserves the cause-and-effect ordering of operations that are related. Eventual consistency promises only that replicas will converge - eventually - leaving the precise ordering and timing of that convergence unspecified. Each model carries a different performance cost, a different failure mode, and a different set of application invariants that it can safely support.

Consensus algorithms are the machinery that turns a group of independent nodes into a system that can agree on a single value despite failures. Raft was designed explicitly for understandability, and its clear decomposition into leader election, log replication, and snapshotting has made it the algorithm of choice for production systems built in the last decade: etcd, CockroachDB, TiKV, and Consul all use it. Implementing Raft from scratch in Go, even a simplified version, forces you to confront what happens when a leader crashes mid-replication, how split-brain is prevented during network partitions, and why the commit index advances only after a majority acknowledges an entry. Paxos, Raft's predecessor, remains important because it underlies Google Spanner's TrueTime-based external consistency model and appears throughout the distributed systems literature.

Multi-leader replication abandons the simplicity of a single source of truth in exchange for write availability across data centers. The cost is conflicts: two leaders can accept concurrent writes to the same record, and the system must resolve the divergence. Last-write-wins based on wall-clock timestamps is simple but lossy and vulnerable to clock skew. Vector clocks track causal relationships between writes and allow the application to detect and resolve genuine conflicts. CRDTs (Conflict-free Replicated Data Types) go further by designing data structures whose merge operation is mathematically guaranteed to be commutative, associative, and idempotent - eliminating the conflict resolution problem entirely for suitable data types. This chapter implements all of these approaches in Go and shows precisely which consistency guarantees each provides.

**What you'll learn in this chapter:**

- Implementing and comparing consistency models: linearizability, sequential consistency, causal consistency, and eventual consistency
- Building a Raft consensus implementation in Go: leader election, log replication, term management, and snapshotting
- Vector clocks and hybrid logical clocks (HLC): tracking causality across distributed nodes and resolving write ordering
- Multi-leader replication patterns: last-write-wins, application-level conflict resolution, and operational transformation
- CRDTs in Go: G-Counter, PN-Counter, OR-Set, and LWW-Register implementations with proof of convergence
- Read repair, hinted handoff, and anti-entropy reconciliation for eventually consistent storage systems
- Linearizability testing with Jepsen-style history checking: verifying that your implementation actually provides the guarantees it claims
- Multi-region replication with geo-aware routing, replication lag monitoring, and automated failover

**Why this matters at scale:**

Amazon's Dynamo paper (the ancestor of today's DynamoDB) introduced the eventually consistent model and quorum reads/writes that now power billions of daily requests. CockroachDB's global transactions use a Raft-based replication layer with serializable isolation across data centers. Apple's published CloudKit paper describes how iCloud synchronizes structured data across devices while tolerating network partitions. Google Spanner's external consistency model, stronger than linearizability because it spans data centers, relies on TrueTime and Paxos consensus. This chapter builds the foundation needed to reason about all of these systems.

**Prerequisites:** Familiarity with Go concurrency primitives (goroutines, channels, mutexes), understanding of basic distributed systems concepts (replication, partitioning, network failures), and completion of the earlier distributed systems chapters in this book.

### Junior → FAANG: Getting Your Footing in Consistency Theory

Most engineers entering their first distributed systems role arrive with strong single-machine intuitions: mutex locks work, counters increment atomically, and if you write a value you can immediately read it back. Distributed systems violate all three of those intuitions, and the chapter introduction is where you need to absorb the mindset shift before touching any code.

The first concept to internalize is that consistency is not a binary property. The CAP theorem is a useful starting point, but treating it as a two-position switch ("consistent or available") leads to poor database selection decisions. When a FAANG interviewer asks you to design a system and you say "we need strong consistency," a follow-up will immediately test whether you can quantify what that costs. Linearizability costs latency (you must wait for a majority quorum to acknowledge every write). Eventual consistency trades correctness windows for availability. Causal consistency is a middle ground that preserves the intuitive "cause before effect" ordering without requiring global coordination.

Worked example to practice: take a social app where User A follows User B, and User B posts a photo. What consistency model do you need so that A's feed includes that photo? Causal consistency is sufficient: the follow event causally precedes the post being visible to A. Linearizability is overkill and would add latency to every feed load.

For your first job, the most important habit is reading the documentation of whatever database your team uses and identifying which consistency model it actually provides by default, not what the marketing page says. PostgreSQL defaults to Read Committed, not Serializable. DynamoDB's default reads are eventually consistent. Knowing this prevents subtle production bugs.

Interview entry point: be ready to explain why reading your own writes is not guaranteed by eventual consistency, and give one concrete scenario where that causes user-visible harm (user updates their profile picture, refreshes the page, sees the old picture because the read hits a stale replica).

### Senior @ FAANG: Architectural Decisions Around Consistency at Platform Scale

At the staff and principal level, consistency model selection is a platform governance decision, not a per-service implementation choice. The introduction to this chapter frames the spectrum from linearizability to eventual consistency as a tradeoff space, and your job at L6/L7 is to encode that tradeoff space into standards that other engineering teams can apply without having to re-derive the theory.

The ADR (Architecture Decision Record) for a consistency model should capture: the targeted consistency level and its formal definition, the specific failure modes the system will tolerate and which it will not, the measurable performance cost in tail latency (p99) at the expected write QPS, and the operational complexity of the consistency mechanism (Raft requires a leader election timeout during leader failure, which means a guaranteed window of unavailability that must appear in your SLO budget). An ADR that says "we chose eventual consistency" without specifying the convergence SLA and the conflict resolution policy is incomplete.

Platform thinking at this level means building abstractions that prevent teams from accidentally choosing the wrong model. A service mesh policy that enforces "all financial writes use strongly-consistent storage" and "all analytics reads may use eventually-consistent replicas" expressed as Kubernetes admission webhook policies scales better than per-team documentation.

Maturity model for consistency governance: Level 1 is each team choosing their own database independently. Level 2 is a shared set of approved databases with documented consistency characteristics. Level 3 is automatic enforcement via infrastructure policy and audit tooling. Level 4 is observability that detects consistency violations in production (linearizability checkers on sampled traffic, causal dependency tracking via distributed trace propagation).

Bar-raiser signal in a system design interview at L6: the candidate proactively identifies which operations in their design are consistency-sensitive, quantifies the cost of the chosen model in SLO terms, and proposes a verification strategy (chaos testing, Jepsen-style history checking) rather than just stating the model and moving on. The absence of a verification strategy is the most common gap in senior candidates.

---
