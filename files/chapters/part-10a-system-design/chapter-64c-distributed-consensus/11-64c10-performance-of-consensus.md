## 64C.10 Performance of Consensus

### Write Latency

The minimum latency for a committed write in Raft is one network round trip:

```
Client → Leader: command
Leader → Majority of Followers: AppendEntries
Majority of Followers → Leader: Success (one RTT from leader)
Leader commits, responds to client

Minimum latency = max(RTT to quorum members) + 2x disk fsync

Typical numbers:
  Same datacenter: 1-5ms
  Cross-region (US East → US West): 70-80ms
  Cross-continent (US → Europe): 140-160ms
```

This is why **geographic replication is expensive for writes** - you cannot get below the speed of light.

### Read Performance

Three modes of reads in Raft, with different consistency/latency trade-offs:

| Read Mode | Consistency | Latency | Notes |
|---|---|---|---|
| **Leader read** (linearizable) | Linearizable | 1 RTT (confirm still leader) | Requires leader to confirm it hasn't been deposed |
| **Leader read** (local, lease-based) | Linearizable | <1ms | Leader reads from local state if lease is valid |
| **Follower read** (serializable) | Serializable (potentially stale) | <1ms | May return stale data |

etcd defaults to **linearizable reads** (requires leader confirmation). You can opt into **serializable reads** for lower latency if stale data is acceptable.

### Throughput Optimization

**Batching:** Group multiple client commands into a single Raft log entry or replicate multiple entries per AppendEntries call. etcd and TiKV both use batching aggressively.

**Pipelining:** The leader does not need to wait for an AppendEntries response before sending the next batch. It can pipeline multiple AppendEntries calls and track which have been acknowledged.

**Parallel commits:** In Parallel Raft (used in PolarFS/AlibabaCloud), the leader can commit entries in any order as long as dependencies are respected.

### Geographic Replication

For multi-datacenter setups, the Raft quorum must span datacenters to survive datacenter failure:

```
Option A: 3 nodes, each in a different datacenter
  - Tolerates 1 datacenter failure
  - Write latency = RTT to any 1 of the other 2 DCs
  - Simple

Option B: 5 nodes, 2+2+1 across 3 datacenters
  - Tolerates 2 node failures or 1 datacenter failure
  - Write latency = RTT to quorum (3 nodes from any 2 DCs)
  - Slightly higher latency, more fault tolerant

Option C: Hierarchical Raft (Flexible Paxos)
  - Separate quorum sizes for fast and slow path
  - E.g., write quorum = {DC1+DC2}, read quorum = {any 3 of 5}
  - More complex but lower write latency
```

### Junior → FAANG: Consensus Performance as an Interview Differentiator

Understanding consensus performance at a quantitative level is what separates an L4 answer from an L5 answer in a system design interview.

**Write latency floor.** The minimum write latency in a consensus system is one network round trip from the leader to a quorum member, plus the fsync time on both the leader and the quorum member. In the same datacenter, this is approximately 1-5ms. Cross-region (US East to US West), it is 70-80ms. This means a Raft-based system with cross-region replication cannot serve writes in less than 70ms, regardless of application-layer optimizations. If your design requires sub-10ms write latency for a globally replicated store, Raft is the wrong choice, and you should consider an AP system with eventual consistency.

**Read performance and the linearizability tax.** Linearizable reads in etcd require the leader to confirm it is still the leader before serving the read (a network round trip). Serializable reads (from any node) require no network round trip but may return stale data. The choice between them is not always obvious: for a distributed lock check ("is key X held?"), linearizability is required. For a configuration value that changes rarely and where slight staleness is acceptable, serializable reads reduce latency by 1-5ms and reduce load on the leader.

**Batching as the primary throughput optimization.** If your service writes to etcd at 1,000 RPS, each write incurring one Raft round trip, the leader processes 1,000 Raft round trips per second. If you batch 10 writes into a single Raft entry, you process 100 Raft round trips per second with 10x the throughput. etcd does internal batching automatically (it groups writes received within a batch window). For your own Raft implementation, explicit batching is the most impactful throughput optimization before any other tuning.

### Senior @ FAANG: Consensus Performance Engineering

**ADR: lease-based reads vs. ReadIndex reads.** Two mechanisms allow a Raft leader to serve reads without a full quorum round trip. Lease-based reads rely on the fact that a leader with a valid lease has not been displaced: if the lease was granted at time T and the lease duration is D, the leader is guaranteed to still be the leader until at least T+D, assuming bounded clock skew. ReadIndex reads send a heartbeat to confirm quorum before serving the read, without committing a log entry. Lease-based reads have lower latency (no network round trip) but require bounded clock skew. ReadIndex reads are correct regardless of clock skew but add one heartbeat RTT per read. etcd supports both modes. The ADR should document which mode is enabled and why, with a reference to the clock skew guarantee from your infrastructure provider.

**Geographic write latency and design implications.** A Raft cluster spanning three datacenters (US East, US West, EU) commits a write once a majority acknowledges. In a 3-node cluster the majority is two nodes, the leader plus one follower, so the leader waits for the NEAREST follower, not the farthest. If the leader is in US East, writes to US West (70ms RTT) and EU (90ms RTT) mean the commit latency is min(70, 90) = 70ms per write. The 90ms EU node only enters the critical path when the US West node is unavailable and its ack is needed to reach quorum. A service architecture that requires writes to this cluster in the critical path of user requests adds 90ms of irreducible latency. Staff engineers design around this by: (1) keeping the Raft cluster within a single region and using eventual replication for cross-region reads, (2) using a single-datacenter write path with cross-region replication for durability only, or (3) accepting the latency and designing the UI/UX to hide it (optimistic updates, async feedback).

**Platform concern: consensus and tail latency.** In a high-traffic system, the p99 write latency to etcd matters more than the median. Sources of p99 tail latency in a Raft system: (1) disk I/O spikes on etcd nodes (NVMe SSD with proper I/O scheduling is essential, HDD is unacceptable). (2) leadership changes (a new leader must commit a no-op entry before serving writes, adding one round-trip of latency during the transition). (3) GC pressure on the etcd server (Go's GC can pause for milliseconds, so etcd nodes should be tuned with GOGC=off and manual GC triggering or with a large heap to minimize GC frequency). Staff engineers monitor the p99.9 write latency to etcd and set alerts that trigger before the tail latency affects dependent services.

**L6/L7 concern: Flexible Paxos and the quorum size tradeoff.** Standard Raft uses N/2+1 as both the write quorum and the read quorum. Flexible Paxos shows that you can use different quorum sizes for reads and writes as long as they overlap: write quorum W and read quorum R must satisfy W + R > N. With N=5, a write quorum of 4 and a read quorum of 2 satisfies 4+2 > 5. This allows faster reads (only two nodes must respond) at the cost of slower writes (four nodes must acknowledge). For read-heavy metadata systems, this is a meaningful performance gain. The tradeoff: larger write quorum reduces write availability (losing 2 of 5 nodes makes writes impossible, vs. 3 of 5 for standard quorum). The ADR for adopting Flexible Paxos must document this availability tradeoff explicitly and get sign-off from the service owner.

---
