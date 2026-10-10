## Interview Questions

### Q1: What is the Raft leader election process?

**What FAANG expects:** The four election steps (timer fires, increment term, vote for self, send RequestVote), the three vote-granting rules, and the election-restriction ("candidate's log must be at least as up-to-date as the voter's"). Bonus for calling out randomized timeouts (150-300ms in the paper) as the anti-split-vote mechanism.

**Answer:** When a follower's election timer fires (no heartbeat received), it:
1. Increments its current term
2. Transitions to Candidate state
3. Votes for itself
4. Sends RequestVote RPCs to all other nodes

A node grants a vote if: (a) the candidate's term is at least as large as its own, (b) it has not already voted in this term (or already voted for this candidate), and (c) the candidate's log is at least as up-to-date as its own (compare last log term, then last log index).

A candidate that receives votes from a majority of nodes becomes leader and immediately sends heartbeats to assert its authority.

### Q2: How does Raft ensure only one leader exists at a time (per term)?

**Answer:** By requiring a majority quorum for election. Since any two majorities share at least one node (the quorum intersection property), and each node votes at most once per term, it is impossible for two candidates to each receive a majority vote in the same term. Therefore, at most one leader can exist per term. Since term numbers are monotonically increasing, there is at most one leader at any point in time (a later term's leader coexists with an earlier term's leader only temporarily, and the earlier term's leader will step down when it discovers the higher term).

### Q3: What is the difference between Raft and Paxos?

**What FAANG expects:** Correctness-first (Paxos) vs understandability-first (Raft). Both are correct. Raft constrains the protocol to simplify reasoning (strong leader, no log gaps). Most production systems built after 2014 use Raft. Bonus for citing the "In Search of an Understandable Consensus Algorithm" paper (Ongaro and Ousterhout, 2014) and for noting that Paxos variants (EPaxos, Flexible Paxos) keep being invented because basic Paxos is genuinely hard to implement.

**Answer:**

| Aspect | Paxos | Raft |
|---|---|---|
| Design goal | Correctness-focused | Understandability-focused |
| Leader model | Any proposer can propose | Strict single leader |
| Log holes | Can have uncommitted gaps | No gaps (sequential) |
| Leader recovery | Complex (must scan for prior values) | Simple (new leader has all committed entries) |
| Membership changes | Unspecified in original paper | Specified (joint consensus) |
| Cluster configuration | Not specified | Explicit log entries |
| Common use | Google Chubby, Spanner | etcd, CockroachDB, TiKV, Consul |

The fundamental algorithmic difference: Raft requires that the leader always have all committed entries (enforced by election restriction). Paxos allows any node to propose and requires the new proposer to "heal" incomplete rounds. This makes Raft's leader election simpler and leader recovery trivial.

### Q4: How does etcd use Raft?

**Answer:** etcd runs a single Raft group for the entire cluster. Every write operation (PUT, DELETE, TXN) is proposed as a Raft log entry by the leader. Once the entry is committed (acknowledged by a majority), etcd applies it to its in-memory B-tree (bbolt on disk). The Raft log is persisted to disk using WAL (write-ahead log) before responding to any RPC, ensuring crash safety. Reads are served linearizably by default: the leader confirms it is still the leader (by sending a heartbeat and waiting for acknowledgment) before serving the read from its local state.

### Q5: What is a fencing token and why is it needed?

**Answer:** A fencing token is a monotonically increasing number associated with a lock acquisition. When a lock holder writes to an external resource, it includes the fencing token. The external resource rejects any write with a token lower than the highest it has seen.

Without fencing tokens, a stale leader (one whose lock has expired due to a GC pause or network delay) could resume executing and write to external resources, conflicting with the new leader's writes. Fencing tokens prevent this: the stale leader's token is lower than the new leader's, so its writes are rejected.

In etcd, the fencing token is typically the `CreateRevision` of the lock key (a globally monotonically increasing number) or the lease ID.

### Q6: Explain CAP theorem in terms of Raft.

**Answer:** Raft chooses CP (Consistency + Partition Tolerance, sacrificing Availability during partitions). During a network partition:
- The majority partition continues to function normally (elects a leader, serves reads and writes)
- The minority partition's nodes timeout on the leader and transition to candidate state, but cannot elect a new leader (they cannot reach a majority). They refuse to serve writes, returning errors.

This is the correct behavior: the minority partition could contain the old leader, which might have committed entries the minority hasn't seen. Allowing the minority to serve writes would create a split-brain scenario where two independent leaders make divergent decisions.

### Q7: What happens when a Raft leader is partitioned from followers?

**Answer:**
1. The leader cannot replicate entries to followers, so new writes cannot be committed
2. The leader continues sending heartbeats, but followers in the majority partition do not receive them
3. Followers' election timers fire. They start an election and elect a new leader from the majority partition
4. The old leader is still in the minority partition, still thinking it is leader - but any client requests will not be committed (it cannot reach a quorum)
5. When the partition heals, the old leader receives a message with a higher term from the new leader (via heartbeat or AppendEntries), immediately steps down and becomes a follower
6. The old leader's uncommitted entries are overwritten by the new leader's log

### Q8: What is the Log Matching Property in Raft?

**Answer:** If two log entries in different nodes have the same index and term, then:
1. The commands they store are identical
2. All preceding log entries are identical

This is enforced by the consistency check in AppendEntries: the leader always sends `(PrevLogIndex, PrevLogTerm)` with new entries, and a follower only appends if its log matches at that point. This ensures that once two logs agree at a certain index, they agree for all preceding entries - by induction, the logs are identical up to that point.

### Q9: What is the difference between commitIndex and lastApplied in Raft?

**Answer:**
- `commitIndex`: the highest log index known to be committed (replicated to majority). Updated immediately when a quorum acknowledges an entry.
- `lastApplied`: the highest log index applied to the state machine. Updated asynchronously after the entry is committed.

`commitIndex >= lastApplied` always. The gap represents entries that are committed but not yet applied to the state machine. Applying committed entries is done asynchronously to avoid blocking the consensus protocol. In the implementation, a dedicated goroutine (`applyLoop`) watches for `commitIndex > lastApplied` and applies entries.

### Q10: How does Raft handle log compaction?

**Answer:** Raft's log grows unboundedly without compaction. The solution is snapshots:
1. The state machine periodically writes its entire current state to disk as a snapshot, recording the `lastIncludedIndex` and `lastIncludedTerm`
2. All log entries up to `lastIncludedIndex` are discarded
3. The in-memory and on-disk log begins at `lastIncludedIndex + 1`
4. When a follower is far behind (its `nextIndex` is less than the leader's `lastSnapshotIndex`), the leader sends the snapshot via `InstallSnapshot` RPC instead of trying to replay potentially missing log entries

### Q11: What is the difference between serializable and linearizable reads in distributed systems?

**Answer:**
- **Linearizable** (strong consistency): A read always reflects all writes that completed before the read started, from the perspective of a global clock. In Raft, this requires the leader to confirm it is still the leader before serving the read.
- **Serializable** (weaker): A read reflects a consistent snapshot of the database at some point in time, but not necessarily the most recent point. In Raft, a follower can serve a serializable read from its local state.

The difference matters for applications that need to see the latest write. A banking application that reads an account balance after a transfer must use linearizable reads. A reporting application that reads historical analytics can use serializable reads.

### Q12: What is Multi-Raft and when is it used?

**Answer:** Multi-Raft runs multiple independent Raft groups on the same set of nodes, where each group manages a subset of the data (a shard or range). Used in:
- CockroachDB: one Raft group per 64MB range
- TiKV: one Raft group per 96MB region
- Kafka KRaft: multiple topic partitions as Raft groups

Benefits:
- Parallelism: multiple groups can commit concurrently
- Load distribution: different ranges can have leaders on different nodes
- Scalability: adding data doesn't require a single Raft group to handle all writes

Challenges:
- Resource management: thousands of Raft groups = thousands of timers and goroutines
- Cross-shard transactions: requires distributed transaction protocol (2PC, Percolator)
- Rebalancing: moving a range from one Raft group to another is a complex operation

### Q13: What is joint consensus in Raft?

**Answer:** Joint consensus is Raft's mechanism for safely changing cluster membership (adding/removing nodes). A naive approach - switching from old to new configuration simultaneously - is dangerous because there could be two independent majorities during the transition.

Joint consensus transitions through an intermediate joint configuration `C_{old,new}`:
1. Leader appends `C_{old,new}` to log. Once committed, all decisions require majorities from both old and new configurations
2. Leader appends `C_new` to log. Once `C_new` is committed, only the new configuration is used
3. Nodes not in the new configuration can step down

At no point are two independent majorities possible: `C_{old,new}` requires agreement from both old and new majorities, preventing split decisions.

### Q14: How would you design a distributed leader election system for 1000 services?

**Answer:** Use etcd (or a similar Raft-based system) as the coordination backend, but do not create 1000 separate election campaigns in the same etcd cluster - that would create 1000 watches and leases.

Architecture:
- Group services by function (e.g., payment-processor, notification-sender)
- Each service group elects one leader using etcd's election API
- The elected leader registers itself and its capabilities in a service registry
- Workers poll the registry to find the current leader

For truly massive scale (10,000+ services):
- Use a hierarchical approach: elect a meta-leader per region, then region leaders manage local elections
- Or: use a gossip protocol (like Serf/memberlist) for weaker but more scalable leader tracking
- Or: for many independent services, just accept that etcd at 1000 clients is fine (etcd handles tens of thousands of connections)

### Q15: What is the Raft "no-op" entry and why is it needed?

**Answer:** When a new leader is elected, it does not immediately know which entries are committed. An entry is committed when the leader sees it replicated on a majority, but entries from previous terms can only be committed indirectly (via the Log Matching Property, not by counting replicas).

The no-op entry is a dummy log entry that the new leader appends at the start of its term. When this no-op entry is committed (which requires a Raft round trip), the leader knows:
1. Its log is up-to-date with the latest committed state
2. All previous entries (from prior terms) are implicitly committed (by log matching)

Without the no-op entry, a new leader might serve stale reads (responding to reads before it knows what is committed) or delay responses unnecessarily.

### Q16: What is the difference between at-most-once, at-least-once, and exactly-once delivery?

**Answer:**
- **At-most-once**: A message is delivered 0 or 1 times. Simple - just send and forget. Lost messages are not retried.
- **At-least-once**: A message is delivered 1 or more times. The sender retries until acknowledged. The receiver must handle duplicates (idempotent processing).
- **Exactly-once**: A message is delivered exactly once. Requires coordination between sender and receiver - typically implemented via:
  - Idempotency keys: receiver deduplicates based on a unique message ID
  - Distributed transactions: sender and receiver coordinate atomically (expensive)
  - Consensus: the delivery of the message is itself a consensus decision

In practice, **at-least-once + idempotent consumers** is the most practical pattern for most distributed systems. True exactly-once requires consensus and is expensive.

### Q17: How does Google Spanner achieve external consistency globally?

**Answer:** Spanner uses **TrueTime** - an API that returns a time interval `[earliest, latest]` with a bounded uncertainty (±4ms typical, ±7ms guaranteed). External consistency is achieved by the **commit wait**: a transaction with timestamp T cannot be reported as committed until TrueTime.now().earliest > T, ensuring T is in the past for every observer. Combined with Paxos-based replication per shard, this guarantees that if transaction T1 commits before T2 starts (from any observer's perspective), then T1's timestamp < T2's timestamp, providing a globally consistent order.

### Q18: What are the operational challenges of running etcd in production?

**Answer:**
- **Disk performance**: etcd requires fast, consistent disk I/O (SSD recommended). Disk latency spikes cause write latency spikes and can trigger leader elections.
- **Memory**: etcd stores all data in memory. Typical recommendation: 8GB RAM for clusters with <8GB of data.
- **Compaction**: etcd stores all historical revisions. Must compact periodically (`--auto-compaction-mode`).
- **Defragmentation**: After compaction, disk space is not automatically reclaimed - must defragment.
- **Backup**: Regular snapshots are essential. etcd's backup is a snapshot of the entire Raft state machine.
- **Certificate rotation**: etcd uses TLS for peer and client communication. certificate rotation must be done carefully.
- **Cluster size**: 3 nodes for most use cases. 5 nodes if you need to survive 2 simultaneous failures. More than 7 nodes degrades write performance.
- **Upgrade**: Rolling upgrades must follow semver (N to N+1 minor version only).

### Q19: When would you choose Kafka over etcd for distributed coordination?

**Answer:** Kafka and etcd solve different problems:

| Use case | etcd | Kafka |
|---|---|---|
| Leader election | Yes | No |
| Distributed locks | Yes | No |
| Config storage | Yes | No |
| High-throughput event streaming | No | Yes |
| Durable message queue | No | Yes |
| Small key-value store | Yes | No |
| Large data volumes | No | Yes |

Use etcd for coordination (who is the leader, what is the config, who holds the lock). Use Kafka for data streaming (events, logs, metrics). They are complementary: a common pattern is using etcd for service coordination and Kafka for data flow.

### Q20: Describe a scenario where a distributed lock implementation loses safety and how to fix it.

**What FAANG expects:** The canonical Kleppmann "How to do distributed locking" scenario: client GC pause longer than TTL, second client acquires, first client resumes and writes stale data. Fix with fencing tokens enforced at the storage layer. Bonus for recognizing that this is why Redlock alone is unsafe and why etcd/Zookeeper-based locks with lease-aware storage are production-grade.

**Answer:**

**Scenario (Redis lock with GC pause):**
1. Client A acquires lock with 30s TTL
2. Client A enters a full-GC pause lasting 35 seconds
3. Lock expires. Client B acquires the lock
4. Client B writes to the database (with its new state)
5. Client A resumes from GC pause, believes it still holds the lock
6. Client A writes to the database (with its old state), overwriting Client B's data

**Root cause:** The lock TTL is a wall-clock deadline, but the lock holder's process can be paused arbitrarily (GC, VM migration, OS preemption).

**Fix:**
1. Use fencing tokens (lock version numbers) when writing to external resources
2. The database (or storage service) tracks the highest fencing token it has seen and rejects writes with a lower token
3. Client A's write (with its old fencing token, lower than Client B's) is rejected

Additionally:
- Use etcd instead of Redis for stronger guarantees (etcd can detect stale clients via lease expiry + Raft)
- Design critical sections to be short enough that GC pauses are extremely unlikely to exceed the TTL
- Alert on long GC pauses and restart pods that exhibit them

### Q21: What is the Raft "prevote" optimization?

**Answer:** Without prevote, a partitioned follower repeatedly increments its term while trying to get elected. When it reconnects, it sends RequestVote RPCs with a very high term, disrupting the current leader.

The prevote optimization adds a preliminary phase: before incrementing its term and becoming a candidate, a node first checks if it can win an election (sends PreVote RPCs). Only if it receives a majority of positive responses does it increment its term and proceed with the real election.

This prevents disruptive elections caused by isolated nodes and makes Raft clusters more stable under flaky network conditions. Implemented in etcd's Raft library.

### Junior → FAANG: Using the Interview Questions as a Study Framework

These 21 questions cover the full scope of what FAANG interviewers probe in L4/L5 distributed systems interviews on consensus. Here is how to use them effectively.

**Prioritize correctness over completeness.** For Q1-Q3 (election, quorum, Raft vs. Paxos), the correct answer must be technically precise. "Majority" means N/2+1, not "more than half" without specifying the rounding. "Term" must be used correctly: a term is the logical clock unit, not a time period. Practice using the vocabulary from the Raft paper.

**Q5 (fencing tokens) is high-value.** It appears in system design interviews more than any other question in this chapter. The answer must cover: the GC pause scenario, the stale leader problem, the fencing token as a monotonically increasing number, and the storage-side validation. If you can tell the complete story in under 2 minutes, you are ready.

**Q12 (Multi-Raft) is an L5/L6 question.** Do not volunteer this topic at L4 interviews. When it comes up at L5/L6, the expected depth includes: one Raft group per shard, cross-shard transactions via 2PC, rebalancing complexity, and the resource management challenges at thousands of groups.

**Use Q14 (1000 services leader election) as a systems thinking exercise.** The question is not about knowing etcd's connection limits. It is about whether you naturally ask "do 1000 services each need their own election?" and propose a hierarchy. The ability to simplify a problem by questioning its premises is a strong L5/L6 signal.

**Q21 (prevote) is a depth signal.** Knowing prevote exists and why it matters (isolated nodes disrupting clusters on reconnect) demonstrates that you have read beyond the Raft paper to production Raft implementations. At L5 and above, knowing one "beyond the paper" detail like prevote, the no-op entry, or ReadIndex reads elevates your answer from "knows the algorithm" to "understands production Raft."

### Senior @ FAANG: Bar-Raising Through These Questions

At L6/L7 interviews, the same questions are asked but with a different bar: the interviewer is not evaluating whether you know the answer, but whether you can extend it, challenge it, or connect it to a system design decision.

**Extending Q6 (CAP and Raft).** A senior candidate does not stop at "Raft chooses CP." They extend to: "CP during partitions, but the specific availability guarantee depends on where the majority resides. If a datacenter with two of your three nodes is isolated, those two nodes can still elect a leader and continue serving writes. The minority node (in the other datacenter) stops serving writes but may still serve stale reads if configured to do so. Whether that is acceptable depends on whether your SLA distinguishes between read availability and write availability."

**Challenging Q17 (Spanner TrueTime).** A bar-raiser answer does not just explain TrueTime. It asks: "What are the assumptions that make this work, and when would they break?" Assumptions: atomic clocks and GPS in every datacenter, bounded uncertainty of +/-7ms, and the commit-wait enforces that the transaction timestamp is in the past before acknowledging. Would break if: the GPS signal is jammed (Google has fallback time sources), if the uncertainty bound increases beyond 7ms (Google monitors this and alerts when it approaches), if the commit-wait latency is unacceptable for the application (Spanner exposes it as an explicit tradeoff in the API). This level of critical analysis is the bar-raiser signal.

**Connecting Q20 (lock safety scenario) to a system design.** The canonical answer covers the GC pause and fencing tokens. The bar-raiser answer extends to: "In this specific payment coordinator, I would design the storage service to validate the fencing token in the same database transaction as the payment state update, using a conditional write. This makes the validation atomic with the write, preventing a race between validation and the actual write. I would also add a circuit breaker that monitors lock acquisition latency: if lock wait time exceeds 10 seconds, the payment coordinator should degrade gracefully rather than queuing indefinitely."

**Owning the problem space as a staff engineer.** At L7, the interviewer may ask: "How would you design the distributed lock infrastructure for a company of 500 engineers?" This is not a question about etcd mechanics. It is a question about platform engineering: how do you abstract the lock primitive so teams can use it safely without understanding etcd? What guardrails (naming conventions, TTL limits, fencing token enforcement) do you build into the platform? How do you measure lock usage across the organization and enforce policies? This is staff-level thinking: designing the system that makes it easy for other teams to make the right choice.

---
