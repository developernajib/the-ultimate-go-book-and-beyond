## 37F.1 Elasticsearch Architecture

### Distributed Inverted Index

Elasticsearch distributes an index across shards, each of which is a self-contained Lucene inverted index that maps terms to the documents containing them. Replicas of each primary shard provide both fault tolerance and additional read throughput, while the routing layer hashes each document's ID to determine which shard holds it.

```
Elasticsearch Architecture
═══════════════════════════════════════════════════════════════════

  Cluster: 3-node setup
  ┌───────────────────────────────────────────────────────────┐
  │                   Elasticsearch Cluster                   │
  │                                                           │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
  │  │   Node 1     │  │   Node 2     │  │   Node 3     │     │
  │  │ Master+Data  │  │ Data+Ingest  │  │ Data+Coord   │     │
  │  │              │  │              │  │              │     │
  │  │ Shard P0 ●── │──│ ──Shard R0   │  │              │     │
  │  │ Shard R1 ←── │──│ ──Shard P1 ● │ │              │      │
  │  │              │  │ Shard R2 ←── │──│ ──Shard P2 ● │     │
  │  └──────────────┘  └──────────────┘  └──────────────┘     │
  │                                                           │
  │  P = Primary Shard  R = Replica Shard                     │
  └───────────────────────────────────────────────────────────┘

  Inverted Index (per shard):
  ┌──────────────────────────────────────────────────────┐
  │  Term Dictionary:          Postings List:            │
  │  "golang"    → ──────────→ [doc1, doc3, doc7]        │
  │  "microserv" → ──────────→ [doc2, doc3, doc9]        │
  │  "docker"    → ──────────→ [doc1, doc5]              │
  │                                                      │
  │  Each posting also stores:                           │
  │  - Term frequency (for TF/IDF scoring)               │
  │  - Field positions (for phrase queries)              │
  │  - Document offsets (for highlighting)               │
  └──────────────────────────────────────────────────────┘

  Query Execution:
  Client → Coordinator → Scatter to N shards (parallel)
                       ← Gather + merge results (reduce)
                       → Return top-K to client

  Segment Merge (like Cassandra compaction):
  Many small segments → fewer large segments
  Tombstones removed, deleted docs purged
```

### Lucene Segment Architecture

Each Elasticsearch shard is a Lucene index containing multiple **segments** (immutable files). When you index a document:
1. Written to in-memory buffer + translog (write-ahead log for durability)
2. `refresh` (default 1s): buffer flushed to a new segment → document becomes searchable
3. `flush`/`fsync`: translog checkpointed, segments committed to disk
4. Merges: small segments merged into larger ones by the merge scheduler

### Junior → FAANG: Mental model, worked example, interview entry-point

The first confusion a junior hits is that an "index" in Elasticsearch is not what an index is in Postgres. A Postgres index is a secondary structure attached to a table. An Elasticsearch index is the table. It is a logical namespace that owns a mapping, a settings block, and a set of primary shards and replicas. Reading documentation without internalising that word overload is the source of half the early confusion.

Worked example. Create an index `products` with three primary shards and one replica on a three-node cluster. Elasticsearch places P0, P1, P2 as primaries on any nodes it chooses, then places R0, R1, R2 as replicas on different nodes than their primaries. When you index a document with `_id = "abc123"`, the coordinator computes `shard = hash("abc123") % 3` and routes the write to the primary that owns that shard, which replicates to the replica before acking. When you search, the coordinator fans out to one copy of each shard (primary or replica, round-robin by default), each shard returns its top K, and the coordinator merges. If you kill Node 2, Elasticsearch promotes any replica on a surviving node to primary within seconds, and the cluster goes from green to yellow until a new replica is allocated.

Interview entry-point questions you should be able to answer cold: What is the refresh interval and what does it control? (Default one second, the cadence at which the in-memory buffer becomes a searchable segment. Elasticsearch is near real time, not real time, because of this.) What is the translog for? (Write-ahead durability so an un-flushed buffer can be replayed after a crash.) Why are segments immutable? (To enable lock-free concurrent reads and simple replication. Deletes are tombstones reconciled at merge time.) What does the `_refresh` API do, and why should you not call it per write? (Forces an immediate refresh, breaks the batching that keeps indexing throughput up, guaranteed to crater a cluster if wired into a hot path.)

### Senior @ FAANG: Cluster topology, shard economics, and failure modes

Staff-level architecture starts with node roles. A production cluster has three dedicated master-eligible nodes with `node.roles: [master]`, sized small because they only own cluster state. Data nodes carry `[data_hot]`, `[data_warm]`, `[data_cold]`, or `[data_frozen]` depending on the tier. Coordinating-only nodes with `[]` (empty roles in older syntax, or explicit `[remote_cluster_client]` today) sit in front of query fan-out when the workload has many small shards or heavy aggregations that would otherwise burn heap on data nodes. Ingest-only nodes make sense when ingest pipelines are CPU-bound and you want to isolate that from search. The failure mode that takes clusters down is running master-eligible on the same nodes as hot data under memory pressure: a long GC pause on the master causes a leader election, cluster state churn pauses indexing, and the cascade produces a red cluster. Dedicated masters are cheap insurance.

Shard economics. The canonical target is 20 to 50 GB per primary shard on hot tier, which keeps segment merges bounded and recovery times reasonable. One shard per 30 million documents is the order-of-magnitude rule when average doc size is a few kilobytes. Heap to storage ratio should not exceed roughly 1 GB of heap per 20 GB of indexed data on search-heavy workloads, and heap is capped at around 30 GB to stay under the compressed-oops threshold on the JVM. The arithmetic that falls out of this: a 10 TB hot index at 30 GB per shard wants roughly 333 primary shards plus 333 replicas, wants roughly 500 GB of heap across the cluster, which means 17 data nodes at 30 GB heap each or 9 data nodes at 30 GB heap each with a 1:2 heap:data ratio if the workload is indexing-heavy. These numbers are a starting point for capacity planning, not a recipe, and they shift when you use frozen searchable snapshots because the hot footprint shrinks drastically.

Data tier design. Hot on NVMe with 1:20 heap to data. Warm on dense SSD with 1:40 heap to data and `index.codec: best_compression` for a further 15 percent reduction. Cold on spinning disk using fully mounted searchable snapshots that keep a shard-copy locally but back the bytes in object storage. Frozen using partially mounted searchable snapshots where the cluster keeps only a hot cache on disk and the full index lives in S3 or equivalent. Frozen can cut storage cost by an order of magnitude for time-series and log data, at the cost of cold-cache p99 latency in the seconds. ILM or the OpenSearch ISM equivalent automates the rollover and phase transitions. The single biggest cost mistake in log and observability clusters is keeping 90 days of data on hot when a hot-to-warm-to-cold-to-frozen policy with daily rollover would have the same retention for 10 to 20 percent of the cost.

Segment and translog tuning. Refresh interval is the single most important indexing knob. The default of `1s` is correct for near-real-time user-facing search. For bulk backfills and log ingestion, set `-1` (disabled) during the backfill and restore afterwards, or set 30s to 60s for steady-state throughput with relaxed freshness. The translog `durability` is `request` by default (fsync per request, full durability) and can be `async` with an interval for throughput at the cost of a sub-second durability window on node crash. Setting async on a user-facing OLTP projection is a correctness bug waiting to happen, setting async on a fire-and-forget log pipeline is often correct. Force-merging to one segment is beneficial for read-only warm or cold indices and actively harmful for hot indices: it produces one massive segment that blocks the natural merge policy and can take hours, during which indexing throughput collapses. The runbook rule is that force-merge only runs post-rollover when the index has been marked read-only, never on a live hot index.

Failure modes to internalise. Split-brain is prevented by requiring a majority quorum of master-eligible nodes (`discovery.zen.minimum_master_nodes` in old versions, automatic via `cluster.initial_master_nodes` and the Raft-style coordination in 7.x and later). Red cluster means at least one primary is unassigned, writes to the affected index fail, reads return partial results if not told otherwise. Yellow means all primaries assigned but some replicas unassigned, full availability with degraded fault tolerance. The `_cluster/allocation/explain` API is the first place to look when a shard will not allocate. Common causes include disk watermarks (85 percent low, 90 percent high, 95 percent flood-stage), a node restart leaving replicas unassigned pending the allocation delay, a version mismatch after an upgrade, or shard-awareness constraints like rack or zone allocation rules preventing placement. The cluster-state-fat antipattern, in which mapping explosion or too many shards per node produce a cluster state measured in hundreds of megabytes, manifests as slow master operations and node-join latency in the minutes. The discipline to avoid it is an ADR-level mapping policy enforcing strict dynamic, a shard-count budget per node (the recommended cap is 1,000 shards per node with 20 shards per GB of heap as a secondary ceiling), and rolling up or deleting indices before they pile up.

---
