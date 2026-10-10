## Learning Objectives

By the end of this chapter, you will be able to do the following at a senior or staff engineer level on any FAANG distributed systems team.

### 1. Reason About Failure Models

Identify which of the eight fallacies of distributed computing a given C++ service violates. Distinguish fail-stop, crash-recovery, omission, timing, and Byzantine failure models, and choose the correct model for a given workload. Recognize gray failures (the kind your monitoring misses) and design probes that detect them.

### 2. Build Production-Grade RPC

Write a gRPC C++ async service using the completion-queue API and the newer callback API. Compare gRPC, brpc, Cap'n Proto, and Thrift on the dimensions of latency, throughput, schema evolution, and operational complexity. Build a minimal RPC framework on Asio plus Protobuf when the production frameworks do not fit.

### 3. Synchronize Clocks Correctly

Pick the right clock for the job: NTP, chrony, PTP, hybrid logical clocks, or TrueTime. Integrate `std::chrono` with wall-clock and monotonic sources without confusing the two. Detect clock skew at runtime and refuse to accept stale leases. Explain why Spanner's TrueTime uncertainty interval is what makes external consistency possible.

### 4. Track Causality

Implement Lamport timestamps, vector clocks, version vectors, and dotted version vectors in C++. Explain when a single Lamport counter is sufficient and when you need a full vector. Reason about the trade-off between vector size (O(N) per write) and the granularity of conflict detection.

### 5. Implement Raft Consensus

Implement Raft from scratch in modern C++23: leader election with randomized timeouts, log replication with the AppendEntries RPC, the commit-index advancement rule, snapshots and InstallSnapshot, joint consensus for membership changes, and the pre-vote optimization that avoids disruption from partitioned servers. Identify the production gotchas that the Raft paper does not emphasize.

### 6. Compare Paxos Variants

Distinguish basic Paxos, Multi-Paxos, Fast Paxos, and EPaxos. Explain why Chubby uses Multi-Paxos and Spanner uses Paxos rather than Raft. Identify the workloads where Paxos's flexibility (out-of-order commits, leaderless variants) is worth the implementation complexity.

### 7. Use Lease-Based Leadership

Build Chubby-style lease-based leader election. Implement fence tokens to prevent split-brain. Reason about the relationship between session timeout, clock drift bound, and lease duration. Integrate leases with a long-running C++ daemon process so that loss of leadership immediately stops issuing writes.

### 8. Replicate State Machines Deterministically

Apply Schneider's state machine replication (1990) to a production C++ service. Eliminate sources of nondeterminism: wall clock reads, random number generation, hash map iteration order, threading. Order side effects after log commit, never before. Implement snapshot installation including the file transfer protocol.

### 9. Choose and Implement CRDTs

Pick between state-based and operation-based CRDTs based on transport semantics. Implement G-Counter, PN-Counter, OR-Set, RGA, and LSEQ in C++23 using concepts and ranges. Compare delta-CRDTs against full state shipping. Recognize the workloads where CRDTs replace consensus (collaborative editing, presence) and the ones where they do not (financial transactions).

### 10. Build Gossip and Anti-Entropy

Implement SWIM-style failure detection in C++ on top of Asio. Build merkle-tree-based anti-entropy for two replicas to detect divergence in O(log N) bandwidth. Compare epidemic dissemination patterns: HyParView for membership, Plumtree for broadcast, push-pull gossip for convergence.

### 11. Design Distributed Transactions

Trace a 2PC transaction through coordinator and participant state machines. Identify the exact failure modes that hang 2PC and the recovery protocols that unhang it. Implement the Saga pattern as a sequence of compensating actions. Walk through Percolator (the transactional layer over Bigtable) and Calvin (deterministic transactions).

### 12. Shard Data Correctly

Choose between range sharding (Bigtable, Spanner) and hash sharding (Cassandra, DynamoDB) for a given workload. Implement consistent hashing with virtual nodes, rendezvous hashing, and jump hash. Plan an online resharding migration that preserves consistency. Explain why Maglev hashing is the load balancer hash of choice at Google.

### 13. Tune Quorum Systems

Configure R, W, and N for a Dynamo-style quorum to meet a target durability and latency. Implement sloppy quorums with hinted handoff. Run read repair and active anti-entropy. Compare quorum-based replication against Raft on the latency/durability/operational simplicity axes.

### 14. Architect Like Google

Explain Spanner, Bigtable, GFS, Chubby, Borg, Stubby, and Megastore at a level sufficient to defend each design choice in a system design interview. Use the right Google reference when designing a new system: TrueTime for global ordering, Chubby for coarse coordination, Bigtable for sparse map storage, and so on.

### 15. Build Bigtable-Style Storage

Implement an LSM tree from scratch in C++23. Write a skip list memtable, an SSTable file format with bloom filters, level-vs-tiered compaction, and a write-ahead log. Analyze write amplification and read amplification for each compaction strategy. Map ScyllaDB's per-shard architecture onto this design.

### 16. Test Distributed Code Deterministically

Apply FoundationDB's simulation-driven testing methodology to a pure C++ codebase. Build a deterministic event loop that wraps Asio. Inject faults at message send, message receive, disk write, and clock advance. Drive simulation with a single seed so that every bug is bisectable and reproducible.

### 17. Engineer Production Reliability

Implement adaptive concurrency limiting (Netflix concurrency-limits), token-bucket and leaky-bucket rate limiting, and request hedging. Design distributed locks that are correct under network partition (use fence tokens). Choose between rejection and queueing under overload, and prove the choice with a queueing-theory model.

By the end, you should be able to walk into a Spanner-class design interview and produce a defensible architecture in 45 minutes.

---
