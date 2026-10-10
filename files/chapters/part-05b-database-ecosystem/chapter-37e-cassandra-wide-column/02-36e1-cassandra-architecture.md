## 37E.1 Cassandra Architecture

### Ring Topology & Consistent Hashing

Cassandra distributes data across a ring of nodes using consistent hashing, so that adding or removing a node only remaps a fraction of the token range rather than reshuffling all data. Each node owns a set of virtual nodes (vnodes), small non-contiguous token ranges, which spread data more evenly and speed up rebalancing. Cassandra 5.0 (GA September 2024) introduced trie-indexed memtables and SSTable formats that reduce both memory footprint and read amplification, plus the Unified Compaction Strategy (UCS) that replaces the historical STCS/LCS/TWCS decision tree with a single density-aware strategy. ScyllaDB, a C++ rewrite that is wire- and CQL-compatible with Cassandra, uses the same ring/partition model but runs a shard-per-core thread-per-core architecture on Seastar, typically sustaining 2-5x the throughput per node with tablet-based (rather than vnode-based) sharding. Everything in this chapter about data modeling applies to both. The driver code uses `gocql` and `gocqlx`, which also work against ScyllaDB. The diagram below shows the token ring, replication, and write/read paths.

```
Cassandra Cluster Architecture
═══════════════════════════════════════════════════════════════════

  Token Ring (Murmur3 hash space: -2^63 to +2^63-1)

            Node A
           (0 - 25)
          /        \
    Node D          Node B
  (75 - 100)       (25 - 50)
          \        /
           Node C
          (50 - 75)

  Virtual Nodes (vnodes): each node owns 256 small token ranges
  → Better load distribution on add/remove
  → Faster repair and streaming

  Replication Factor = 3 (SimpleStrategy):
  Key "user123" → token 42 → Node B (primary)
                           → Node C (replica 1)
                           → Node D (replica 2)

  Multi-Datacenter (NetworkTopologyStrategy):
  ┌──────────────────┐    ┌──────────────────┐
  │    DC: us-east   │    │    DC: eu-west   │
  │  RF=3            │    │  RF=3            │
  │  N1  N2  N3      │    │  N4  N5  N6      │
  └──────────────────┘    └──────────────────┘
  Write to: LOCAL_QUORUM (2/3 in local DC)
  Read from: LOCAL_QUORUM

  Write Path:
  Client → Coordinator → Commit Log (sequential) → Memtable
                       → Replicas (async)
  Flush: Memtable → SSTable (immutable, sorted) when full

  Read Path:
  Client → Coordinator → Bloom Filter (SSTable membership)
                       → Key Cache → Partition Summary
                       → Partition Index → SSTable data
                       → Merge results (row merge)

  Compaction: SSTable1 + SSTable2 → SSTable3 (remove tombstones, deduplicate)
```

### Cassandra vs Traditional Databases

Cassandra occupies a different point in the design space than PostgreSQL or MongoDB. The table below highlights the key architectural differences that drive the choice between them, particularly around write scaling, query flexibility, and transaction support.

| Property | Cassandra | PostgreSQL | MongoDB |
|----------|-----------|------------|---------|
| CAP | AP (tunable) | CP | CP/AP |
| Write scaling | Linear horizontal | Vertical | Horizontal with shards |
| Read scaling | Linear horizontal | Read replicas | Read replicas |
| Data model | Wide-column | Relational | Document |
| JOINs | None | Yes | $lookup |
| Transactions | LWT (single partition) | Full ACID | Multi-doc ACID |
| Best for | Time-series, IoT, high write | OLTP, reporting | Flexible schema, nested docs |
| Query flexibility | Limited (query-first) | High | Medium |

### Junior → FAANG: Prerequisite Gaps and Worked Entry Points

The ring diagram hides four mechanisms a junior should be able to name before touching production. Gossip is a per second pairwise exchange of cluster state between nodes that carries heartbeat counters and schema versions. It is eventually consistent, so a freshly joined node is not immediately visible ring wide and a freshly down node is not immediately marked dead. Hinted handoff is the coordinator's local buffer of writes destined for a replica that is currently down. Hints are replayed when the replica returns, up to a window of three hours by default. Read repair runs on the read path when replicas return different values for the same row and synchronously reconciles them before responding to the client. Anti entropy repair is an offline or scheduled operation that builds a Merkle tree per SSTable range and streams only the divergent ranges to bring replicas back into sync. The junior level exam question is what happens if a node is down for longer than the hint window and you never run anti entropy repair. The answer is that tombstones past gc_grace_seconds get compacted away, and deleted data can resurrect when the dead node rejoins. You run repair weekly, always.

A worked entry point is to stand up a three node cluster with `docker compose`, kill one node with `docker kill`, run a hundred writes at QUORUM, confirm they succeed because two out of three replicas ack, then restart the dead node and watch `nodetool status` show it as UN (up, normal) after gossip converges. Run `nodetool repair -pr` on one node and watch the streams. This one exercise makes the abstract pieces concrete in a way no diagram can.

### Senior @ FAANG: Staff and Principal Framing

At staff level the architecture conversation splits along two axes. First, Cassandra 5.0 versus ScyllaDB 6.0 at the engine level. Cassandra 5.0's trie memtable cuts memory per cell by roughly forty percent and its trie SSTable format reduces the partition index lookup from three disk seeks to one in the common case, which directly improves p99 read latency on cold data. Unified Compaction Strategy (UCS) replaces STCS, LCS, and TWCS with a single strategy parameterised by a scaling factor and a maximum SSTable size, and for most workloads it is a strict improvement over STCS while approaching LCS read amplification. Storage Attached Indexes (SAI) replace the old SASI and 2i indexes with a per SSTable index that scales with data size and supports numeric range queries, which finally makes secondary indexes usable for moderate cardinality columns. Scylla 6.0 added tablets, which replace vnodes with dynamic range splits that rebalance automatically as data grows, eliminating the manual `num_tokens` tuning dance and dramatically speeding up scale out. Tablets plus shard per core plus the Seastar user space TCP stack are why Scylla benchmarks at ten to one hundred times the per node throughput of Cassandra on the same hardware. The principal level question is whether your workload can actually use that headroom or whether you are network bound or application bound before the engine is the bottleneck. On commodity three node clusters with mixed workloads, Cassandra 5.0 with SSDs and careful tuning gets you to about fifty thousand writes per second per node. Scylla on the same hardware gets you to three hundred to five hundred thousand. That gap funds or does not fund the migration cost.

Second, the managed service axis. ScyllaDB Cloud runs Scylla as a dedicated cluster in your VPC or theirs, with a per instance hour price that maps cleanly to capacity. AWS Keyspaces is serverless Cassandra compatible with provisioned or on demand billing per RU, and it trades the engine level tuning knobs for a simplified surface that hides replication factor, consistency levels beyond LOCAL_QUORUM and LOCAL_ONE, and all the compaction decisions. It is a good fit for teams that want CQL without running Cassandra, but it caps partition size at one megabyte, imposes a four kilobyte row size limit, does not support materialized views or UDTs, and LWT is rate limited per partition. Azure Cosmos DB with the Cassandra API wraps the Cosmos multi master engine behind a CQL compatible protocol. It offers five consistency levels that do not line up with Cassandra's tunability, and the request unit billing model makes cost prediction a capacity planning exercise of its own. For a staff engineer the decision matrix is workload shape (steady versus spiky), regulatory posture (BYOK, residency), multi region requirements (active active versus active passive), and operational budget (team size, on call rotation). There is no universally right answer, only a decision record that documents the tradeoffs.

Inside the architecture itself the details a staff engineer must know are Murmur3Partitioner as the only sensible choice, the 64 bit token space and how `initial_token` or vnode count maps to ownership, the gossip convergence time of roughly N seconds for N nodes which bounds how fast topology changes propagate, the hint window and its interaction with gc_grace_seconds which must be longer than the hint window to avoid resurrection, the read repair chance tunable which trades read latency for convergence, and the anti entropy repair mechanism built on Merkle trees where each SSTable range's hash is compared across replicas and only mismatched ranges are streamed. Repair scheduling tools like Cassandra Reaper (originally Spotify, now community maintained) should be a given in any production deployment. Commit log versus memtable versus SSTable flow is well understood, but the commit log's sync mode (batch versus periodic versus group) is the single biggest write durability versus throughput knob and should be set deliberately per workload. SSTable format in Cassandra 5 is `bti` (big trie indexed) by default, and the on disk layout matters when you are debugging compaction, sstableloader restores, or cross version upgrades. Tombstones remain the silent killer. A scan that crosses one thousand tombstones in a single partition raises a warning at that threshold, fails the query at one hundred thousand by default, and the correct response is never to raise the threshold but to redesign the data model to avoid tombstone accumulation, typically via TWCS and TTL with no explicit deletes.

---
