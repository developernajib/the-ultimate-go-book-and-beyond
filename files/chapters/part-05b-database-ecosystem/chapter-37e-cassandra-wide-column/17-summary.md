## Summary

Cassandra's distributed architecture makes it uniquely suited for write-heavy, globally-distributed workloads requiring linear scalability. Key architecture pillars:

- **Architecture**: ring topology, consistent hashing, vnodes, write path (commit log → memtable → SSTable → compaction), read path (bloom filter → key cache → index → data)
- **Data modeling**: query-first design, denormalization, partition key vs clustering key, bucket patterns for unbounded growth
- **Go driver**: production gocql configuration with token-aware routing, DC-aware policy, observer pattern for metrics
- **CRUD with gocqlx**: type-safe queries, generic repository pattern, pagination with page state tokens
- **LWT**: compare-and-swap operations, Paxos consensus, saga pattern for multi-step operations
- **Batches**: logged (atomic, single partition) vs unlogged (performance, same partition) vs counter
- **Time-series pipeline**: batched async writer, parallel multi-partition queries, TWCS compaction
- **Consistency levels**: tunable from eventual (ONE) to strong (QUORUM/ALL), LWT for linearizability
- **Compaction**: STCS vs TWCS vs LCS - choosing based on read/write ratio and data TTL
- **Case studies**: Netflix play history (100B events), Apple iCloud, Discord messages, Uber surge pricing

### Junior → FAANG: What to Internalise from This Chapter

If you only remember five things from the chapter, remember these.

First, query-first schema design. You do not model entities, you model queries. Every table is a single query path. This is the opposite of what a relational database teaches you, and it is the single biggest mindset shift for a Cassandra junior.

Second, partition sizing. 100MB and 100k rows are the soft caps. Every schema decision is a question about how you keep partitions inside those caps for the data's lifetime. If you cannot answer "how big will this partition be after a year of growth" on a whiteboard, you do not understand the table.

Third, LOCAL_QUORUM. It is the default consistency level for a multi-DC cluster. Plain QUORUM silently crosses DCs and destroys latency. If an interviewer asks about consistency, the default answer is LOCAL_QUORUM with a justification, not ONE or QUORUM.

Fourth, TWCS for TTL workloads. UCS is the Cassandra 5.0 default for mixed workloads, but TWCS is still the right call for append-only TTL data. Knowing when to reject the default is senior thinking.

Fifth, LWT is a scalpel. If your design uses LWT on a hot path, redesign. Paxos is 4 to 10x more expensive than a normal write and serializes per partition.

Worked reflex. When a new requirement lands on your desk, in order: write the access patterns, size the partitions, pick the consistency level, pick the compaction strategy, then write the CQL. Five steps. If an interviewer asks you to design a Cassandra schema and you start with CQL, you have already lost a point.

### Senior @ FAANG: Staff Takeaways and Long-Horizon Investments

At staff level the chapter is a map of where wide-column fits in the storage landscape. The takeaways are governance, not trivia.

Governance takeaways. Schema lint in CI. Per-table observability for partition size, tombstone rate, and LWT QPS. ADR-driven schema change. A maturity model that the org can advance along deliberately. These are not optional. They are the difference between a cluster that scales to Netflix size and one that does not scale past a hundred nodes.

Long-horizon investments to consider as a staff engineer owning a wide-column platform.

Repair orchestration. Reaper or ScyllaDB Manager. Custom cron is technical debt.

Backup and restore. Medusa for Cassandra, ScyllaDB's backup for Scylla. Test restore monthly, not yearly.

Capacity planning. Per-keyspace forecasting using six months of growth data. Tombstone accumulation is a capacity signal, not just a latency signal.

Driver standardization. One blessed driver config per language. Token-aware routing, DC-aware host policy, retry policy that distinguishes idempotent from non-idempotent, tracing hooks wired to OpenTelemetry. Ship this as a library and version it.

Migration readiness. Keep a one-page runbook for migrating a table to a new schema without downtime. The team that has the runbook ready migrates in a week. The team that does not takes a quarter.

Cassandra versus ScyllaDB versus alternatives. The 2026 landscape has Cassandra 5.0 with UCS, SAI, and vector search GA, ScyllaDB 6.0 with tablets and Alternator GA, DynamoDB with its usual managed-service tradeoffs, and Bigtable for GCP-native workloads. Principal engineers should own a living ADR that documents the choice, reviews it annually, and flags when a re-evaluation is warranted.

Maturity model for wide-column platform ownership.

L1 Cluster exists. Nobody owns it.
L2 Someone owns it. Tooling is ad hoc.
L3 Platform team owns it. Schema review exists. Dashboards exist.
L4 Platform is productised. Self-service for teams with guardrails. ADR culture. Runbooks tested.
L5 Platform influences the org's architecture. Teams design around the platform's strengths, and the platform team publishes case studies and upstreams patches.

Staff engineers drive the move from L3 to L4. Principal engineers drive the move from L4 to L5. That is the long-horizon trajectory of a wide-column investment, and it is the frame through which everything else in this chapter should be read.

---
