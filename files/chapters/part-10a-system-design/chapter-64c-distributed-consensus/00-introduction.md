# Chapter 64C: Distributed Consensus - Raft, Paxos, and Leader Election

*Distributed systems are hard because they fail in partial, unpredictable ways. Consensus algorithms exist to make a cluster of unreliable machines behave like a single reliable one.*

Every strongly consistent database, distributed lock manager, cluster coordinator, and replicated state machine
rests on a consensus algorithm. Without consensus, there is no reliable primary election, no fault-tolerant log
replication, no distributed transaction coordinator. Any system where multiple nodes must agree on a value despite
network partitions and crashes needs a consensus protocol.

Go's concurrency model maps naturally onto consensus implementations. Leader election uses goroutines racing to
acquire a lease. Log replication uses channels and synchronous RPC. Heartbeat and election timers are idiomatic
`time.Ticker` patterns. The entire etcd codebase, the most widely deployed Raft implementation in production, is
written in Go, and using it correctly requires understanding the guarantees Raft provides.

This chapter covers both theory and production implementation: the FLP impossibility result, the Paxos and Raft
algorithms in detail, a simplified Raft node in Go with persistent state and RPC, and etcd's Go client for
leader election, distributed locking with fencing tokens, configuration distribution, and service registration.

**What you'll learn in this chapter:**
- The distributed consensus problem: agreement, validity, and termination properties, and why network asynchrony
  makes all three simultaneously unachievable in the general case (FLP impossibility result)
- Paxos phase-by-phase: the Prepare/Promise/Accept/Accepted protocol, multi-Paxos for log replication, and why
  Paxos is notoriously difficult to implement correctly without introducing subtle safety violations
- Raft's design philosophy and its three subproblems: leader election with randomized timeouts, log replication
  with commitment rules, and safety guarantees enforced through term numbers
- Implementing a Raft node in Go: persistent state (`currentTerm`, `votedFor`, log), RPC handlers for
  `RequestVote` and `AppendEntries`, and the apply loop that delivers committed entries to the state machine
- The etcd Go client: KV operations with compare-and-swap, watch streams, lease-based TTLs, and the concurrency
  package for leader election and distributed mutual exclusion
- Fencing tokens: why distributed locks alone are insufficient for safety and how to prevent split-brain actions
  using monotonically increasing tokens that storage systems can validate
- When consensus is the wrong tool: the performance cost of quorum writes and the coordination patterns that
  achieve correctness without consensus overhead
- FAANG interview questions on consensus: Raft vs Paxos trade-offs, consistency guarantees, and split-brain prevention

**Why this matters at scale:**
Google's Chubby lock service, the direct inspiration for ZooKeeper and etcd, underpins Bigtable, Spanner, and
most other distributed systems at Google. Cloudflare, Uber, and Netflix rely on etcd for service discovery,
configuration, and leader election across thousands of nodes. Understanding the consensus layer beneath these
systems is essential for debugging their failure modes.

**Prerequisites:** Chapter 58 (system design fundamentals), Chapter 59 (distributed systems theory), Chapter 11 (goroutines and channels)

### Junior → FAANG: Getting Your Bearings in Consensus Land

Distributed consensus is one of the topics that separates engineers who have only worked on single-node systems from those who have operated multi-node clusters. Before your first FAANG interview, close the gap on three foundational gaps.

**Gap 1: Not knowing why consensus is hard.** The FLP impossibility result exists, but the practical lesson is simpler: you cannot distinguish a crashed node from a slow one over an asynchronous network. Every consensus algorithm you will encounter either uses timeouts (Raft, Paxos) or randomization to break the deadlock. Know this cold.

**Gap 2: Treating etcd as a black box.** Many junior engineers use etcd as a configuration store without understanding that every write goes through a Raft log, requires a quorum acknowledgment, and has a minimum latency equal to the round-trip time to the quorum. If you say "store X in etcd" in a design interview without understanding why that adds latency, you will be probed until you admit you do not know.

**Gap 3: Confusing a distributed lock with a mutex.** A `sync.Mutex` in Go protects shared memory in a single process. A distributed lock protects shared external state across processes. They have completely different failure modes. A `sync.Mutex` is never held after a process crashes. A distributed lock held by a crashed process stays locked until its TTL expires. Building intuition around TTL, lease renewal, and fencing tokens is the entry-level work for distributed systems interviews.

**First-job habit:** When you see a service using etcd, ZooKeeper, or Consul, read the lease TTL and heartbeat interval configuration. Ask: what happens if the leader GC-pauses for longer than the TTL? If nobody on the team can answer that, you have found a hidden risk worth documenting.

**Interview entry point:** "Walk me through what happens when a Raft leader is network-partitioned." This question appears in L4/L5 interviews at AWS, Google, and Meta. The expected answer covers: followers time out and elect a new leader, the old leader cannot commit new entries, the partition heals, the old leader discovers a higher term and steps down. Practice that narrative until you can say it in under 90 seconds.

### Senior @ FAANG: Consensus as a Platform Primitive

At senior and staff level, the question is not "how does Raft work" but "when is the consensus layer the right abstraction boundary, and what does it cost to operate at scale."

**Architecture decision record: etcd cluster sizing.** The standard three-node etcd cluster tolerates one failure. The standard five-node cluster tolerates two. The cost of going from three to five is not just two more VMs: it is two more fsync targets per write, which increases p99 write latency by 20-40% on a loaded cluster. An ADR for "add two etcd nodes" must weigh the fault tolerance gain against the write latency regression for every Kubernetes API server call in the cluster. At Google's scale, Chubby's design paper explicitly notes that adding replicas beyond a quorum of five provides no additional correctness and increases latency. That tradeoff belongs in your team's ADR.

**Governance: who owns the consensus layer.** In platform engineering, the consensus cluster (etcd for Kubernetes, Consul for service mesh, ZooKeeper for Kafka) is infrastructure shared by dozens of product teams. Governance questions that staff engineers own: Who is on call for the etcd cluster? What is the SLA for etcd availability, and how does it propagate to every service that uses it? What is the compaction policy, and who gets paged if the database grows past 8 GB? What is the certificate rotation runbook, and who last tested it? If nobody owns these answers, the platform is fragile.

**Maturity model for consensus usage.** Teams move through predictable stages: (1) using etcd as a key-value store without understanding leases, (2) using leader election but without fencing tokens, (3) using fencing tokens but not validating them at the storage layer, (4) full fencing validation plus operational runbooks plus chaos testing of partition scenarios. A staff engineer's job is to assess where their team sits on this spectrum and drive them to level four before a production incident forces them there.

**Bar-raiser signal: questioning whether consensus is needed at all.** The strongest signal in a system design interview at L6/L7 is when a candidate stops and says "before we add etcd, let me check whether this coordination problem can be solved with idempotency keys and optimistic locking instead." Consensus has a write latency floor equal to one network round trip plus two fsyncs. For workloads doing more than a few hundred writes per second, that floor becomes a wall. Understanding the alternatives: CRDT-based eventual consistency, single-writer patterns, epoch-based coordination without a consensus system, is what separates staff-level candidates from senior candidates.

**L6/L7 concern: multi-Raft and resource management.** CockroachDB and TiKV run thousands of Raft groups per node. Each group has its own election timer goroutine, heartbeat goroutine, and log replication goroutine. At 10,000 Raft groups per node, goroutine overhead is non-trivial. Staff engineers working on multi-Raft systems must design goroutine pool scheduling, coalesce heartbeats across groups sharing the same peer set, and implement group consolidation when ranges shrink. Go's goroutine scheduler handles this well, but the scheduling decisions still require deliberate design at the platform level.

**Operational platform thinking: consensus and cloud-native infrastructure.** In AWS, the etcd cluster for a large EKS deployment is a managed service, but the product teams using it still bear responsibility for: watch stream carriage, compaction configuration, and the choice between linearizable and serializable reads for their specific controllers. A staff engineer defines the guardrails: which namespaces are allowed to use large values in etcd annotations, what the watch cardinality limit is per controller, and when a controller must switch from polling to watching. These are platform policies, not one-off code reviews.

---
