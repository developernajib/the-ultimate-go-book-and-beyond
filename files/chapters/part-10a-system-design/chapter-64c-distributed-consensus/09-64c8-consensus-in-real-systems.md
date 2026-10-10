## 64C.8 Consensus in Real Systems

### Google Spanner - Paxos with TrueTime

Spanner is Google's globally distributed SQL database (Corbett et al., *Spanner: Google's Globally-Distributed Database*, OSDI 2012). It uses Paxos per **shard** (each tablet group runs Paxos). What makes Spanner exceptional is its use of **TrueTime** - a global time API that provides a time interval `[earliest, latest]` with a bounded uncertainty (typically ±7ms).

TrueTime allows Spanner to implement **external consistency** (stronger than serializable, equivalent to linearizability) across a global, multi-datacenter deployment:
- Transactions commit only after `TT.now().latest` passes the commit timestamp
- This wait (usually <14ms) ensures all replicas have caught up to the commit time

### CockroachDB - Multi-Raft

CockroachDB is a distributed SQL database (Taft et al., *CockroachDB: The Resilient Geo-Distributed SQL Database*, SIGMOD 2020) that uses **multi-Raft** - it runs a separate Raft group per range (each range is a 64MB contiguous key range). A CockroachDB cluster with 1TB of data might have ~16,000 Raft groups running simultaneously.

Key design decisions:
- Ranges are automatically split when they exceed 64MB and merged when they fall below 32MB
- Each range's Raft group has replicas on 3 or 5 nodes
- The node acting as Raft leader for a range also serves as the **leaseholder** (handles reads/writes)
- Clock skew is bounded using **hybrid logical clocks (HLC)**

### Apache Kafka - KRaft (Removing ZooKeeper)

Kafka historically relied on ZooKeeper (ZAB protocol) for controller election and metadata management. Since Kafka 3.3, **KRaft mode** (Kafka Raft Metadata mode) replaced ZooKeeper:

- The controller quorum runs Raft directly in Kafka brokers
- Metadata (topic configs, partition assignments, ACLs) is stored in an internal `__cluster_metadata` topic
- A dedicated controller process (or co-located with brokers) runs the Raft election
- Benefits: simplified operations, faster controller failover, support for millions of partitions

### HashiCorp Consul/Vault - Raft via go-raft

HashiCorp built and open-sourced `hashicorp/raft`, a production-grade Raft library in Go. Both Consul and Vault use it:

- **Consul** stores service discovery, health check results, KV data, and ACLs in Raft
- **Vault** (integrated storage) uses Raft to store secrets, policies, and authentication backends
- The `hashicorp/raft` library provides the core Raft state machine. The application provides the FSM (finite state machine) interface

### TiKV - Raft for Distributed KV

TiKV (written in Rust) is the storage engine for TiDB (Huang et al., *TiDB: A Raft-based HTAP Database*, VLDB 2020). Like CockroachDB, it uses multi-Raft - one Raft group per region (96MB key range). TiKV innovations:
- **Raft learners**: read-only replicas that receive log entries but do not vote (used for cross-region read replicas)
- **Joint consensus** for membership changes
- **Raft engine**: a purpose-built WAL for Raft log storage

### Junior → FAANG: Learning from Production Consensus Systems

The systems in this section are the ones you will reference in interviews. Each one represents a deliberate engineering choice, and understanding those choices is more valuable than memorizing the system names.

**Spanner's TrueTime is not magic.** TrueTime works because Google deploys atomic clocks and GPS receivers in every datacenter and because the uncertainty bound (typically +/-7ms) is known and enforced in the protocol. The commit-wait (transactions wait until TrueTime.now() is definitely after the commit timestamp) sounds expensive but is only 7-14ms per transaction. For a global database serving financial transactions, 14ms of latency is entirely acceptable for the guarantee it provides. The lesson for interviews: timestamp-based ordering of distributed transactions is possible when you control the time source and can bound the uncertainty.

**CockroachDB's range splits are a concrete example of distributed coordination.** When a range exceeds 64MB, CockroachDB must coordinate a range split: create two new Raft groups, migrate data, update the range descriptor in the metadata, and notify all nodes of the new layout. This split itself must be linearizable (no client should see the range in both its old and new form simultaneously). The implementation uses a Raft write to the metadata range to commit the split description before migrating data. Understanding this concrete example helps in interviews: "how would you shard a distributed database?" is often answered by describing something similar to CockroachDB's range-based sharding.

**Kafka's move from ZooKeeper to KRaft is an architectural simplification.** ZooKeeper ran a separate consensus cluster (ZAB protocol) that Kafka depended on for controller election and metadata. KRaft replaces ZooKeeper by running Raft directly in Kafka controller nodes. The motivation was operational simplicity (one fewer cluster to manage), faster failover (direct Raft is faster than ZooKeeper's ZAB in Kafka's specific usage patterns), and the ability to scale to millions of partitions (ZooKeeper's memory model was a bottleneck). The lesson: consensus is infrastructure, and reducing the number of consensus clusters in your stack reduces operational burden.

### Senior @ FAANG: Multi-Raft and Platform Architecture Patterns

**ADR: single Raft group vs. multi-Raft for a metadata service.** etcd runs one Raft group for the entire cluster. This is correct for a metadata store with bounded key count: all metadata fits in one Raft group, and the simplicity of a single group makes it easier to reason about consistency and operationalize. CockroachDB and TiKV run multi-Raft because user data is unbounded: you cannot fit all user data in one Raft group without it becoming a write bottleneck. The ADR for a new distributed storage system should specify: what is the expected key count and growth rate? If it is bounded and small (configuration, metadata, coordination), use a single Raft group. If it is unbounded and large (user data, logs, analytics), use multi-Raft with range-based sharding.

**Operational concern: multi-Raft leadership imbalance.** In a CockroachDB cluster, each range has a Raft leader. Ideally, leaders are evenly distributed across nodes. In practice, node failures, hardware heterogeneity, and uneven write patterns cause leader imbalance: some nodes have many more leaders than others and receive disproportionate write traffic. CockroachDB's leaseholder rebalancer periodically moves Raft leaders to balance load. Staff engineers operating a multi-Raft system must monitor leader distribution per node and trigger rebalancing when imbalance exceeds a threshold (e.g., any node has more than 1.5x the average leader count).

**Platform thinking: consensus protocol selection for new infrastructure.** When a new infrastructure component requires coordination, the protocol selection decision is an ADR, not a default. The options and their tradeoffs: (1) etcd/Raft: strong consistency, CP, suitable for metadata and coordination. (2) Cassandra/Dynamo-style: tunable consistency, AP, suitable for high-throughput user data. (3) single-leader PostgreSQL: strong consistency for small scale, no partition tolerance. (4) Kafka with at-least-once delivery: durable ordering, not linearizable, suitable for event streams. The choice is driven by consistency requirements, throughput requirements, partition tolerance requirements, and operational complexity tolerance.

**L6/L7 concern: Raft learners for geographic distribution.** TiKV's Raft learners receive log entries but do not vote. This allows adding read-only replicas in new regions without increasing the quorum size (and thus the write latency). A write quorum still involves the three voting replicas in the primary region. The learner in the secondary region catches up asynchronously and serves reads with potentially bounded staleness. This is a real architectural tradeoff: you get read scalability in a new region without paying the cross-region write latency penalty. A staff engineer evaluating geographic expansion for a distributed database must model this tradeoff: how stale can secondary region reads be, what write amplification does a learner add, and what is the failover behavior if the primary region becomes unavailable?

---
