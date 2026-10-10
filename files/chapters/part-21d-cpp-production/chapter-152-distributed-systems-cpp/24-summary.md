## Summary

Distributed systems in C++ is the deepest stack in the industry. The systems you build at L5+ define the latency, throughput, and reliability of every product on top. These architectural principles define the design vocabulary an engineer at that level must speak fluently.

### Key Takeaways

**Failure is the default**. The eight fallacies of distributed computing describe assumptions that always fail in production. Design for partial failure, gray failure, and partial knowledge from day one. Idempotency keys, fence tokens, and end-to-end acknowledgment are not optional.

**Time is hard**. Wall-clock time can step. Monotonic time cannot. Use `steady_clock` for everything that involves duration. Use HLC when you need wall-clock approximation across nodes. Use TrueTime (or pay for the equivalent hardware via PTP) when you need bounded uncertainty.

**Causality matters more than time**. Vector clocks, version vectors, and dotted version vectors detect concurrent updates. Last-write-wins on top of a wall-clock timestamp is the wrong default for any system that values data integrity.

**Consensus is one tool, not the only one**. Raft and Paxos give you linearizable replicated state machines. Quorum protocols (Dynamo) give you availability over consistency. CRDTs give you both for workloads where merges are well-defined. Choose by workload.

**Determinism is the foundation of replication**. A replicated state machine diverges silently if any apply step is nondeterministic. Wall-clock reads, RNG, hash-map iteration order, and parallel apply are the four most common silent killers. Stamp every nondeterministic input into the command before consensus.

**Leases are necessary but not sufficient**. Every lease-based leader election needs fence tokens at the resources it protects. Without fence tokens, process pauses or clock skew can produce undetectable split-brain. With them, split-brain becomes impossible by construction.

**Sharding is the inverse of consensus**. Consensus replicates each shard, sharding partitions across them. Range sharding gives you scans, hash sharding gives you balance, consistent-hash variants give you minimal disruption on reshard. Choose the variant that matches your workload, and budget for the resharding code path.

**Storage is an LSM problem**. The LSM tree is the dominant pattern: WAL, memtable, SSTables with bloom filters, level or tiered compaction. RocksDB is the production reference. Roll your own only if you have a specific reason RocksDB does not fit.

**Test by simulation**. The FoundationDB methodology (deterministic event loop, fault injection, seeded reproducibility) catches bugs that production rarely surfaces. Building a simulator is a multi-month project, not building one defers the bugs to 3 AM in production.

**Production reliability is a system**. Adaptive concurrency limits, token-bucket rate limits, hedge requests, locality-aware load balancing, and fence-token-protected locks are individually useful. Combined, they are the difference between a service that degrades gracefully and a service that collapses under load.

### The Reading List

- "The Part-Time Parliament" (Lamport, 1998), "Paxos Made Simple" (2001).
- "In Search of an Understandable Consensus Algorithm" (Ongaro & Ousterhout, 2014).
- "The Google File System" (Ghemawat et al., 2003).
- "Bigtable: A Distributed Storage System for Structured Data" (Chang et al., 2006).
- "Spanner: Google's Globally-Distributed Database" (Corbett et al., 2012).
- "Dynamo: Amazon's Highly Available Key-Value Store" (DeCandia et al., 2007).
- "How to do distributed locking" (Kleppmann, 2016).
- "Gray Failure: The Achilles' Heel of Cloud-Scale Systems" (Huang et al., 2017).
- "The Tail at Scale" (Dean & Barroso, 2013).
- "Designing Data-Intensive Applications" (Kleppmann, 2017): the textbook.

### What Comes Next

The remaining chapters of part 21d cover adjacent specialties: kernel-bypass networking (chapter 153), ML inference engines (154), NUMA and cache coherence (155), query optimizers (156), search ranking (157), and production reliability (158). Each takes a slice of distributed C++ and goes deeper. By the end of part 21d you have the full senior-engineer toolkit for any FAANG infrastructure team.

---

| [◀ Chapter 151: C++ Interview Preparation](../chapter-151-cpp-interview-prep/00-introduction.md) | [Chapter 152: Distributed Systems in C++](00-introduction.md) | [Chapter 153: Kernel-Bypass and Userspace Networking in C++](../chapter-153-kernel-bypass-networking/00-introduction.md) ▶ |

