## Google's Distributed Stack: Reference Material for Interviews

A senior engineer at any FAANG is expected to have a working mental model of Google's distributed stack. The systems below shaped the field. The papers are required reading. This section gives you the architectural sketch of each plus the talking points that demonstrate you have read the paper, not the marketing.

### Chubby (2006)

A coarse-grained lock service. Five replicas, Paxos for replication, lease-based locks. Clients hold locks for hours, not microseconds. The point is *availability of coordination*, not high lock throughput.

**Architecture**: five replicas in a "cell". One is the master (chosen by Paxos). All clients connect to the master. Locks are advisory, the application chooses to honor them.

**Use cases inside Google**: GFS master election, Bigtable tablet assignment, name resolution (Chubby files used as DNS), small-config distribution.

**Talking points**:
- Coarse-grained: hold for hours, hundreds of locks per cell, not millions.
- Sessions and KeepAlives, not raw heartbeats. Session timeout (typically tens of seconds) much shorter than typical lock duration.
- Cache consistency via invalidations: clients cache file contents, master invalidates on write. Eliminates polling.
- Why a service rather than a library: easier upgrades, isolation of fragile coordination logic, audit trail.

### GFS (2003) and Colossus (2010+)

GFS: append-mostly distributed file system, single master + many chunkservers, 64 MB chunks, three-way replication, optimized for multi-GB sequential reads.

Colossus: GFS successor, distributed metadata layer (no single master bottleneck), Reed-Solomon erasure coding (1.5x storage instead of 3x), smaller chunks, supports more workloads.

**Talking points**:
- GFS's single master was the architectural limit. Colossus made metadata sharded.
- The append semantics matched MapReduce's needs: writers append, readers scan. No random writes.
- Erasure coding trades CPU for storage. With (6+3) Reed-Solomon, you tolerate 3 failures with 1.5x overhead instead of 3x.
- Replication is per-chunk, not per-file. A 1 TB file is 16 thousand 64 MB chunks each replicated independently.

### Bigtable (2006)

A sparse, distributed, persistent multi-dimensional sorted map. Indexed by (row key, column, timestamp). Built on GFS for storage, Chubby for coordination, custom tablet servers for serving.

**Architecture**: tablets (contiguous row ranges) served by tablet servers, master for tablet assignment, GFS for SSTable and WAL storage. Reads served from in-memory memtable plus on-disk SSTables (LSM tree).

**Talking points**:
- Lexicographic row-key sort: cleverly designed keys (`com.example.www/page1`, `com.example.www/page2`) keep related data together.
- Column families for storage locality: each family stored as separate SSTable files. Lets you scan only the columns you need.
- Versioning by microsecond timestamp: same key + column + different timestamps coexist. Tombstones (a special "delete" version) replace deletes.
- Tablet split is the elasticity primitive. A tablet that grows beyond a threshold splits into two.

### Spanner (2012)

Globally distributed, externally consistent, semi-relational database. Combines Paxos for replication, 2PC for cross-shard transactions, and TrueTime for global ordering.

**Architecture**: zones (replication units), tablets within zones, Paxos groups across zones, transaction coordinator per cross-shard transaction (itself Paxos-replicated).

**Talking points**:
- TrueTime is what makes Spanner unique. The bounded uncertainty interval lets Spanner achieve external consistency without a global lock.
- Commit-wait: to commit at timestamp s, wait until `TT.now().earliest > s`. Roughly 7 ms wait per cross-region commit.
- Read-only transactions are lock-free: read at a chosen TrueTime timestamp from any replica.
- 2PC across Paxos groups gives ACID across shards. The coordinator log is itself Paxos-replicated, so coordinator failure does not stall participants.
- Schema changes are non-blocking via "schema change protocol" with explicit version timestamps.

### Borg / Omega / Kubernetes Ancestor (2015 paper)

Cluster manager. Schedules millions of jobs across hundreds of thousands of machines.

**Architecture**: cells (typically 10K machines), Borgmaster (Paxos-replicated), Borglet on every machine, scheduler queues.

**Talking points**:
- Two priority classes: production (latency-sensitive) and batch (best-effort). Batch backfills the gaps.
- Resource overcommit: production reservations stay protected, batch fills any unreserved capacity.
- Job pinning, anti-affinity, and rack-aware spreading: prevent correlated failures.
- The Borg paper is the architectural blueprint Kubernetes followed, with simplifications.

### Stubby (proprietary, 2003+) → gRPC (open, 2015)

Internal RPC framework. The features that did not make it into gRPC are illustrative.

**Talking points**:
- Stubby has automatic load balancing through a service mesh layer. gRPC needs an external mesh (Envoy, Istio).
- Deadline propagation tied into Google's tracing system: every RPC has a deadline derived from the originating client's deadline minus elapsed time.
- Quota enforcement at the framework layer. Internal services can set per-method QPS limits enforced by the RPC layer.
- Auth integration with internal LOAS (Low Overhead Authentication System).

### Pub/Sub (2015 product)

Publish/subscribe messaging at global scale. Built on Spanner and a global Paxos-replicated metadata layer.

**Talking points**:
- At-least-once delivery default, exactly-once via deduplication keys.
- Pull-based subscribers: subscribers pull batches at their own pace. Backpressure naturally handled.
- Per-subscription state stored in Spanner so subscribers can resume after failure without losing messages.
- Ack deadlines: messages held in-flight until ack'd or deadline expires. Lost subscribers cause redelivery.

### Megastore (2011)

Predecessor to Spanner. Paxos-replicated entity groups within a Bigtable. Provides ACID within an entity group, eventual consistency across.

**Talking points**:
- Entity group as the unit of locality and transactions. Pick your entity group boundary carefully (per-user, per-account).
- Cross-entity-group transactions via 2PC, with the coordinator running Paxos (Spanner refined this).
- Read latency was high (cross-data-center Paxos for every read). Spanner improved this with TrueTime-based read-only transactions and tighter Paxos rounds.

### Why These Systems Define the Field

Every modern open-source distributed system traces its lineage to one of these papers. HDFS is GFS. HBase is Bigtable. Cassandra borrows from Dynamo (Amazon, not Google) but the SSTable storage is Bigtable's. CockroachDB is Spanner without TrueTime. Kubernetes is Borg. etcd is Chubby. Reading these papers is not optional for a senior distributed systems engineer.

### Interview Talking Points

When asked "design a globally distributed database":
- Spanner is the reference. Mention TrueTime and explain why bounded uncertainty enables external consistency. Mention Paxos groups per shard, 2PC across shards, replicated coordinator log.

When asked "design a coordination service":
- Chubby is the reference. Mention coarse-grained locks, sessions, lease-based correctness, Paxos for replication. Mention etcd or ClickHouse Keeper as production-ready open-source equivalents.

When asked "design a distributed file system":
- GFS or Colossus. Mention chunks, master + chunkservers, append semantics. For a modern design, emphasize Colossus's distributed metadata layer and erasure coding.

When asked "design a sparse table store":
- Bigtable. Mention LSM (memtable + SSTable), row-key sort, column families, tablet split. Mention HBase, Cassandra, ScyllaDB as the open-source descendants.

When asked "design a cluster scheduler":
- Borg. Mention priority classes, resource overcommit, anti-affinity. Compare with Kubernetes.

The senior engineer is fluent in all five reference architectures. The L6 candidate connects them: "I would build my coordination on a Chubby-equivalent (etcd), my storage on a Bigtable-equivalent (HBase or my own LSM), my distributed transactions Spanner-style with replicated 2PC coordinators, my membership via gossip with Borg-style cluster manager."

### Junior at FAANG: The Reference Question

When asked "have you read the Spanner paper?", do not say yes generically. Say: "Yes. The TrueTime uncertainty interval (typically under 7 ms) plus commit-wait is what gives external consistency. Read-only transactions read at a chosen TT timestamp from any replica without locks. Cross-shard transactions use 2PC with a Paxos-replicated coordinator log so coordinator failure does not hang participants."

That level of specific recall is what separates a candidate who has read the paper from one who has read about it.

---
