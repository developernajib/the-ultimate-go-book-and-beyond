## Summary

Distributed consensus is one of the foundational challenges in distributed systems engineering. Core concepts include:

**Foundations:**
- The consensus problem requires agreement, validity, and termination under partial failures
- FLP impossibility means consensus in a fully asynchronous system is impossible - practical systems use timeouts
- CAP theorem: consensus systems choose CP (consistency over availability during partitions)

**Algorithms:**
- **Paxos**: the theoretical foundation. Phase 1 (Prepare/Promise) and Phase 2 (Accept/Accepted), plus Multi-Paxos for replicated logs
- **Raft**: designed for understandability. decomposes into leader election, log replication, and safety. uses terms, election timeouts, and strict quorum rules

**Raft Key Invariants:**
- At most one leader per term (quorum intersection)
- A leader has all committed entries (election restriction on log up-to-dateness)
- Committed entries are never overwritten (Log Matching Property + majority commit)

**Production Usage:**
- **etcd**: production Raft in Go. powers Kubernetes. provides KV, watch, lease, and election APIs
- **Leader election**: use etcd's `concurrency.Election` and handle leadership transitions gracefully
- **Distributed locks**: use etcd's `concurrency.Mutex`, always with fencing tokens to prevent split-brain

**Performance:**
- Minimum write latency = quorum RTT + disk fsync. geographic replication adds inter-DC latency
- Linearizable reads require leader confirmation. serializable reads can be stale
- Optimize with batching, pipelining, and read leases

**Operational:**
- Run odd numbers of nodes (3, 5, 7)
- Persist currentTerm, votedFor, and log before responding to any RPC
- Configure etcd for SSD-backed storage. compact and defragment regularly
- Do not use etcd as a general-purpose database

### Junior → FAANG: Consolidating the Chapter into Interview Readiness

The summary above is your interview preparation checklist. Before any FAANG system design interview that might touch consensus, verify you can answer each of these from memory without looking at notes.

**The invariants are the hard part.** "At most one leader per term" and "a leader has all committed entries" are not just facts to memorize. They are correctness properties with proofs. Understanding the proof for "at most one leader per term" (quorum intersection: any two majorities share at least one node, and each node votes at most once per term) is what allows you to extend the argument when an interviewer asks a variant: "What if two nodes vote for themselves simultaneously?" Answer: they are in the same term, so each can get at most one vote from each other node. At most one can reach majority.

**The production points are what distinguish your answer.** Saying "use etcd" is L3. Saying "use etcd, with SSD-backed storage, three nodes, periodic compaction, fencing tokens on distributed locks, and session TTL set to 3x the expected critical section duration" is L5. Each of the operational points in the summary represents a production failure mode that someone has encountered and written up. Knowing them demonstrates operational maturity beyond pure algorithm knowledge.

**First job to-do after reading this chapter:** Find the etcd (or ZooKeeper, or Consul) cluster your team uses. Check: how many nodes, what TTL settings, when was the last compaction, is defrag scheduled, are there any services using even-number clusters? Make one improvement based on what you find.

### Senior @ FAANG: From Summary to Team Practice

At senior level, the summary is not a personal study guide. It is the minimum acceptable state for every consensus-adjacent system your team owns.

**Converting each summary bullet to a team practice.** "Run odd numbers of nodes" becomes: add an automated check in your infrastructure-as-code repository that fails the pull request if any Raft cluster is configured with an even number of nodes. "Persist currentTerm, votedFor, and log before responding to any RPC" becomes: a code review checklist item for any Raft implementation review. "Configure etcd for SSD-backed storage. compact and defragment regularly" becomes: a Terraform module that provisions etcd nodes with NVMe SSD volumes and a scheduled Lambda function that runs compaction weekly. Converting individual knowledge into automated enforcement is the staff-level multiplier.

**Ownership of the consensus layer.** The most important question for a team that depends on etcd is: who owns it? If the answer is "platform engineering owns the cluster, we just use it," the team must know: what is the SLA, who do we page if it degrades, and what is our fallback if it is unavailable for 5 minutes? If the answer is "we run our own etcd cluster," the team must have: a runbook for every failure mode in the operational section of this summary, a chaos experiment schedule that exercises those failure modes quarterly, and a capacity plan showing runway at current growth rates. Neither answer is wrong: what is wrong is not having the answer at all.

**ADR for sunsetting etcd dependencies.** As services mature, some etcd dependencies that were added as the right tool at the time become candidates for removal. A singleton worker pattern for a service that now runs as a single replica (because it is stateful and sharded) may not need etcd leader election anymore. A distributed lock on a resource that is now owned by a single service may be replaceable with an in-process mutex. Staff engineers audit etcd dependencies annually, identify candidates for removal, and drive simplification. Fewer consensus dependencies means lower operational risk and lower complexity for the teams that maintain those services.

---
