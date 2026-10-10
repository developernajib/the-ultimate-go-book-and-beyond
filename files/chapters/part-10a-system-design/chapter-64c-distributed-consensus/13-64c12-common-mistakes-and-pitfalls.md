## Common Mistakes and How to Avoid Them

### Mistake 1: Using Consensus When You Don't Need It

Most application-level coordination problems can be solved with simpler mechanisms: idempotency keys, optimistic locking, or event sourcing. Consensus (etcd, ZooKeeper) adds significant operational complexity and performance cost. Profile your actual needs before adding a consensus dependency.

### Mistake 2: Holding a Distributed Lock Too Long

Distributed locks with TTLs are a compromise: you want a short TTL for fast failure recovery, but a long TTL to survive transient delays. Holding a lock for minutes is a design smell - it means your critical section is too long, or you should be using a different mechanism (e.g., saga pattern for long-running transactions).

**Rule of thumb:** Lock TTL should be 10x the expected critical section duration, with an alarm if the critical section takes longer than TTL/2.

### Mistake 3: Not Using Fencing Tokens

Implementing a distributed lock without fencing tokens gives you false safety. The lock prevents two holders from running simultaneously under normal conditions, but provides no safety under failure scenarios (GC pauses, network delays). Always use fencing tokens when the lock protects external state.

### Mistake 4: Misconfiguring etcd Timeouts

etcd's election timeout (`--election-timeout`) must be at least 5x the heartbeat interval (`--heartbeat-interval`). The default is 1000ms election timeout and 100ms heartbeat. If you reduce these (for faster failover), watch for spurious elections on loaded systems or under periodic GC pauses.

### Mistake 5: Not Persisting All Three Raft State Variables

The three variables that MUST be persisted to stable storage before responding to any RPC:
1. `currentTerm` - losing this causes a node to accept old leaders
2. `votedFor` - losing this can cause a node to vote for two candidates in the same term (violating election safety)
3. `log` - losing this can cause committed entries to be forgotten

Missing any one of these can lead to safety violations. Every state change to these variables must be followed by an fsync before the RPC response is sent.

### Mistake 6: Treating etcd as a General-Purpose Database

etcd is optimized for small values (configuration, coordination). Storing large blobs or many millions of keys causes:
- High memory usage (all data is kept in memory)
- Slow snapshot/restore operations
- Write amplification

Keep etcd lean - store only coordination data, not application data.

### Mistake 7: Running an Even Number of Raft Nodes

A 4-node Raft cluster requires 3 nodes to form a quorum, but can only tolerate 1 failure (same as a 3-node cluster). A 4-node cluster is strictly worse than a 3-node cluster: it has higher write latency (due to more nodes to poll), worse fault tolerance (still loses quorum with 2 failures), and more operational complexity. Always run an **odd** number of nodes (3, 5, 7).

### Mistake 8: Assuming Linearizability Without Confirmation

In etcd, reads are linearizable by default (they confirm with the leader). But if you use serializable reads for performance (`clientv3.WithSerializable()`), you may receive stale data. Using a serializable read to decide whether to acquire a lock, then acquiring the lock, is not safe - the condition you read may have changed between the read and the lock acquisition. Use a transaction to combine the read and the conditional write atomically.

### Mistake 9: Not Handling Leader Changes Gracefully

When the etcd leader changes, in-flight requests to the old leader may receive `ErrLeaderChanged` or connection errors. Clients must retry these requests. The etcd Go client handles retry automatically for some operations, but not all (e.g., watches need to be re-established after an error). Always test your etcd client code for behavior during leader elections.

### Mistake 10: Ignoring Clock Skew in Distributed Systems

Raft and Paxos are designed to be correct regardless of clock skew - they use logical clocks (term numbers), not wall clocks. However, many higher-level systems built on top of Raft (lease-based optimizations, distributed crons) assume bounded clock skew. Always configure NTP with hardware time sources, monitor clock skew (it should be < 1ms in a well-configured cluster), and design systems to tolerate some degree of skew.

### Junior → FAANG: Building a Mistake-Avoidance Reflex

These ten mistakes fall into two categories: conceptual mistakes (using consensus when you don't need it, not using fencing tokens) and operational mistakes (even-number clusters, missing persist calls). Build a reflex for each.

**Conceptual mistakes need a decision framework.** Before adding an etcd dependency, ask: "Do I need linearizable coordination, or does idempotent processing with a message queue give me the same correctness?" If you cannot answer this question, you have not understood your consistency requirements. Write the answer down before writing any code.

**Operational mistakes need a checklist.** Before deploying any Raft-based system, run through: odd number of nodes (check), SSD storage (check), election timeout at least 5x heartbeat (check), all three persistent state variables written before RPC response (check), etcd compaction configured (check). These are not things to remember under pressure: they are a printed checklist that becomes a team standard.

**Mistake 4 (etcd timeout misconfiguration) is the most common production trigger.** The default etcd election timeout is 1000ms with a 100ms heartbeat. On a system where disk I/O occasionally spikes (due to compaction or noisy neighbors), a 100ms heartbeat may occasionally take 150ms, which with the default 1000ms election timeout gives plenty of margin. If someone reduces the heartbeat to 20ms and the election timeout to 200ms "for faster failover," a disk I/O spike of 250ms will trigger a spurious election. This causes a brief write unavailability (typically 50-200ms) and then re-stabilization. During high load, this pattern can become a loop.

**Mistake 5 (missing persist) is the hardest to catch.** A missing persist call will not cause visible bugs in normal testing. It will only manifest when the specific node crashes between the state change and the RPC response, which requires both a process crash and unfortunate timing. The only reliable way to catch this is: property-based testing with injected crashes at random points in the RPC handler, or a code reviewer who checks every mutation of currentTerm, votedFor, and log for a corresponding persist call.

### Senior @ FAANG: Mistake Prevention as Platform Policy

**Platform policy: consensus dependency approval.** Mistake 1 (using consensus when you don't need it) is preventable at the organizational level. Require a brief architecture review before any team adds a new dependency on etcd or another consensus system. The review asks: what is the consistency requirement? Is there a simpler mechanism that satisfies it? What is the expected write rate, and does the team understand the etcd write latency floor? This review is a 30-minute conversation, not a heavyweight process, but it prevents the most expensive class of over-engineering.

**Governance: lock TTL policy.** Mistake 2 (holding locks too long) becomes a platform risk when multiple teams hold long locks in the same etcd cluster. Define a platform policy: distributed locks may not have a TTL greater than 120 seconds, critical sections must be designed to complete within 30% of the TTL, and any lock held for more than 60 seconds must be reviewed by the platform team. Enforce this in code review.

**Operational runbook for Mistake 8 (linearizability assumptions).** The serializable read footgun (using a serializable read to gate a linearizable decision) is subtle and recurring. Document it as a platform known issue: "Do not use `clientv3.WithSerializable()` for reads that are used to make coordination decisions (lock acquisition, configuration updates, leader election). Use it only for informational reads where staleness is explicitly acceptable." Include this in the team's etcd usage guide with a concrete bad/good example.

**L6/L7 concern: mistake patterns as organizational signals.** When the same mistake recurs across multiple teams (e.g., three teams independently discovering that they have even-number Raft clusters), it is not a people problem: it is a documentation and review process gap. Staff engineers track recurring mistake patterns across the organization and address them systematically: update the platform documentation, add a code review checklist item, create a lint rule that flags even-number cluster configurations, or give a tech talk. Individual correction is L4 work. Systematic prevention is staff work.

---
