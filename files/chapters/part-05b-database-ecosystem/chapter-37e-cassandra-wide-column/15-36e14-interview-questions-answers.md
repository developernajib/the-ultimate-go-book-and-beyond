## 37E.14 Interview Questions & Answers

**Q1: Why can't you do JOINs in Cassandra?**

A: Cassandra is a distributed system where data is spread across many nodes. A JOIN would require fetching data from multiple partitions potentially on different nodes, coordinating across them, and merging results, this breaks the linear scalability model. Instead, Cassandra uses denormalization: you store the data in multiple tables, each optimized for a specific query pattern. This is the "query-first" data modeling approach, you design your schema around the queries you need to answer.

*What FAANG expects:* a candidate who can articulate the coordinator-round-trip cost of a hypothetical cross-node JOIN, then immediately pivot to materialized-view / fan-out-on-write as the standard Cassandra workaround, and note when a separate analytics engine (Spark, Presto, Trino) is the right tool for ad-hoc joins instead of fighting the data model.

*Follow-ups:*
- How would you handle a report that genuinely needs a join across 3 tables?
- When would you introduce Spark-on-Cassandra vs a separate OLAP store (ClickHouse, BigQuery)?
- What changes in 5.0 (SAI) relax this, and what still does not?

**Q2: What is the difference between partition key and clustering key?**

A: The partition key determines which node(s) store the data, it's hashed to find the partition. All rows with the same partition key are stored together on the same node (and its replicas). The clustering key determines the sort order of rows within a partition, you can do range queries on clustering columns (e.g., `WHERE created_at > X AND created_at < Y`). Together: `PRIMARY KEY ((partition_key), clustering_key)`. A wide row = one partition key with many clustering key values.

*What FAANG expects:* that you can size a partition in rows and bytes (target ≤100 MB / ≤100k rows), design a composite partition key to spread load (`(tenant_id, day_bucket)`), and explain why clustering order affects on-disk layout and therefore range-scan performance.

*Follow-ups:*
- Design the primary key for a chat app where "load last 50 messages in a channel" must be O(1) disk seeks.
- What happens if a single partition grows to 1 GB? Which operational symptoms show up first?
- Why does `ALLOW FILTERING` rescue a missing clustering predicate but not a missing partition key?

**Q3: What happens during a Cassandra node failure?**

A: With RF=3 and `QUORUM` consistency (requires 2/3 nodes): if 1 node fails, writes and reads continue with 2 replicas satisfying quorum. The failed node's data is "hinted" by coordinators (hinted handoff), pending mutations are stored and replayed when the node recovers. If a node is down longer than `max_hint_window` (default 3 hours), a repair is needed after recovery. Cassandra uses gossip protocol to detect failures (typically within seconds).

*What FAANG expects:* knowledge of the failure-detection layers (phi-accrual gossip, snitch topology, coordinator timeout) and the read-repair / anti-entropy repair interplay. You should be able to diagram what "eventually consistent" means operationally and what `nodetool repair -pr` does.

*Follow-ups:*
- A node has been down 24 hours and you bring it back up. What do you run, in what order?
- Why is `max_hint_window` tuning a trade-off between disk use and repair cost?
- What changes if two nodes fail simultaneously in the same rack vs in different racks?

**Q4: Explain Cassandra's write path.**

A: (1) Write arrives at coordinator node. (2) Coordinator identifies target replicas using the consistent hash ring. (3) Coordinator sends write to replicas in parallel. (4) Each replica writes to the commit log (sequential disk write for durability). (5) Data written to memtable (in-memory sorted structure, trie-indexed in Cassandra 5.0). (6) Coordinator waits for required number of acknowledgments (based on consistency level). (7) When memtable is full, it's flushed to an immutable SSTable on disk. (8) Compaction (UCS by default in 5.0) merges SSTables periodically.

*What FAANG expects:* ability to contrast the LSM-tree write path with a B-tree (Postgres), why writes are cheap (sequential) but reads can fan out across SSTables, and how the bloom filter + key cache + partition summary + partition index reduce that fanout.

*Follow-ups:*
- Why does Cassandra scale writes linearly with cluster size but reads do not always?
- Where can a write be lost? (Hint: commit log fsync policy, periodic vs batch.)
- What role does `memtable_flush_writers` play under write bursts?

**Q5: What is the CAP theorem implication for Cassandra?**

A: Cassandra is tunable between AP (Availability + Partition Tolerance) and CP (Consistency + Partition Tolerance) based on consistency level. With `ONE`, it's AP, always available, may return stale data. With `QUORUM`, it approaches CP, consistent within failure bounds. With `ALL`, it's fully CP but loses availability if any node is down. For most use cases, `LOCAL_QUORUM` provides strong consistency within a DC while remaining available under single-node failures. Cassandra's default design philosophy favours availability.

*What FAANG expects:* the formal rule `R + W > N` for strong consistency (so QUORUM+QUORUM with RF=3 gives strong consistency. ONE+ONE is eventual), and awareness that PACELC (latency vs consistency even without partitions) is often the more useful framing in production.

*Follow-ups:*
- Compute: with RF=3, is `R=ONE, W=ALL` strongly consistent? What is its availability profile?
- When would you choose `EACH_QUORUM` over `LOCAL_QUORUM`?
- How does LWT escape the CAP compromise for a specific operation?

**Q6: How do you handle hot partitions?**

A: Hot partitions occur when one partition receives disproportionate traffic. Solutions: (1) **Time bucketing**: add a time component to the partition key (daily/hourly buckets) to spread load. (2) **Salting**: add a random prefix (0-N) to partition key and query all N partitions at read time. (3) **Improve partition key cardinality**: use compound partition keys with high-cardinality fields. (4) **Caching**: cache hot reads in Redis to reduce Cassandra load. (5) **ScyllaDB tablets**: ScyllaDB's tablet-based sharding automatically splits hot partitions, whereas Cassandra vnodes are static.

*What FAANG expects:* recognition that hot partitions are almost always a data-model bug, not an infrastructure problem. You should be able to diagnose one from `nodetool tablehistograms` / SAI histogram output and propose a migration path (double-write, backfill, cut over) without downtime.

*Follow-ups:*
- Walk through a zero-downtime migration from `(user_id)` to `(user_id, month)` partition key.
- How do you pick the salt cardinality N? What's the cost at read time?
- Why doesn't "just add more nodes" fix a hot partition?

**Q7: What is the compaction overhead and how do you minimize it?**

A: Compaction reads and rewrites SSTables to remove tombstones and merge duplicate data. STCS can temporarily use 2x disk space during compaction. Minimize overhead: (1) Use UCS (Cassandra 5.0 default), its density-aware shard-parallel compaction amortises overhead better than the old strategies. (2) Use TWCS for time-series + TTL data, closed windows are dropped whole without tombstone scanning. (3) Schedule compaction during off-peak hours with `concurrent_compactors` tuning. (4) Use TTL instead of explicit deletes to avoid tombstone accumulation. (5) Ensure `gc_grace_seconds` is shorter than your backup/repair window so tombstones actually get collected.

*What FAANG expects:* you can explain when UCS's scaling_parameter should be tuned toward `T4` (write-heavy, STCS-like) vs `L10` (read-heavy, LCS-like), and why TWCS is still correct for append-only TTL workloads in 5.0 even though UCS is the new default.

*Follow-ups:*
- Reading a partition returns 10k tombstones and slows down. What are the three root causes you investigate?
- Why is setting `gc_grace_seconds = 0` dangerous in a multi-DC deployment?
- When would you choose `L10` UCS over TWCS for a time-series table?

**Q8: How does Cassandra's consistency level interact with replication factor?**

A: Consistency level = number of replicas that must acknowledge an operation. For strong consistency: W + R > RF. With RF=3: QUORUM (2) + QUORUM (2) > 3 → consistent. ONE (1) + ONE (1) = 2 ≯ 3 → eventual. For maximum availability and write throughput: ANY (even hints acceptable) for writes, ONE for reads. For strict linearizability: use LWT with `SERIAL` consistency (Paxos), this requires majority of all replicas to agree.

*What FAANG expects:* beyond the formula, awareness of the DC-local variants (`LOCAL_QUORUM`, `LOCAL_SERIAL`) as the production default to avoid cross-region latency, and the trap that `SERIAL` without `LOCAL_` causes a global Paxos round that can be 100x slower.

*Follow-ups:*
- Two DCs, RF=3 each. Which consistency level gives strong consistency globally? What's its latency cost?
- Why is `LOCAL_ONE + LOCAL_ONE` sometimes acceptable in practice even though R+W ≯ N?
- What is `read_repair_chance` and why was it removed in modern Cassandra?

**Q9: What are the limitations of Cassandra LWT (lightweight transactions)?**

A: LWT uses Paxos consensus: (1) **Performance**: 4 round-trips instead of 1 → ~5-10x slower than regular writes. (2) **Scope**: only works within a single partition, cannot do cross-partition CAS. (3) **Contention**: high contention on the same key degrades performance as Paxos rounds abort and retry. (4) **Availability**: requires majority of replicas alive (like a CP system for that partition). (5) **Timeouts**: LWT operations are more likely to time out under load. Use LWT only for specific cases: initial creation (`IF NOT EXISTS`), state machine transitions, reservation systems.

*What FAANG expects:* you can design a saga / outbox pattern for multi-partition "transactional" flows, and know the Accord protocol (Cassandra's in-development multi-partition transaction layer) and why it is not yet GA for production use.

*Follow-ups:*
- Implement a ticket-reservation workflow for a concert with 50k seats without LWT contention.
- How would you bound p99 latency for a hot LWT key?
- When is an outbox + Debezium pattern preferable to LWT for cross-service consistency?

**Q10: How do you implement pagination in Cassandra?**

A: Use Cassandra's built-in page state mechanism (not OFFSET). Each query returns a `PageState` token that represents the position in the result set. Pass this token to the next query: `query.PageState(previousToken)`. Token-based pagination is efficient because Cassandra maintains the cursor position on the coordinator. Unlike SQL OFFSET which rescans skipped rows, PageState resumes from where it left off. Limitation: no random access pagination, you can only go forward.

*What FAANG expects:* that you can serialize the opaque PageState token safely to the client (base64, signed if user-facing), and design a schema where pagination is a clustering-column range scan rather than a 2i scan, because SAI pagination has subtly different semantics.

*Follow-ups:*
- How do you paginate a SAI-indexed query? What breaks if the index is updated between pages?
- Why should PageState tokens be signed if returned to untrusted clients?
- Design a "jump to page 50" feature when Cassandra only supports forward cursors.

**Q11: Explain the difference between a counter table and a regular table.**

A: Counter tables use distributed counter columns that support `counter = counter + N` operations, these use a special algorithm to ensure eventual accuracy even with concurrent increments across replicas. Limitations: (1) counter columns can't be in the same table as regular columns (except primary key). (2) no TTL on counter columns. (3) can't SET a counter (only increment/decrement). (4) `DELETE` resets counter to 0 but a tombstone remains. (5) counter writes are not idempotent, a retried increment can double-count.

*What FAANG expects:* awareness that counters are the single least-idempotent primitive in Cassandra, and that for metrics/analytics a pre-aggregation pipeline (Kafka → Flink → Cassandra with regular INSERTs of hourly sums) is almost always safer than live counter columns.

*Follow-ups:*
- How would you build an exactly-once view counter across 1000 servers?
- What failure mode causes a counter to drift, and how do you detect it?
- When is HyperLogLog (approximate) the right answer over a Cassandra counter?

**Q12: How would you design a Cassandra schema for a messaging app?**

A: Key tables: (1) `messages_by_conversation ((conv_id), message_id UUID, sender_id, content, created_at)`, TWCS compaction, TTL for old messages. (2) `conversations_by_user ((user_id), last_activity, conv_id, unread_count)`, sorted by last_activity DESC. (3) `conversation_members ((conv_id), user_id)`. Fan-out writes: when sending a message, write to `messages_by_conversation` once, then update each member's `conversations_by_user` row. Use `message_id = TimeUUID()` for natural time ordering. Add read receipts as separate counter table (or pre-aggregate).

*What FAANG expects:* Discord-level thinking, why Discord migrated to ScyllaDB for message storage (tablet-based rebalancing of hot channels), how to bound the fan-out on a 100k-member group, and how to handle message edits without blowing up tombstones.

*Follow-ups:*
- A channel has 100k members. Does the fan-out pattern still apply?
- How do you handle "mark all as read" without N individual writes?
- What schema change would you make to support SAI-indexed full-text search on messages in 5.0?

### Junior → FAANG: Interview Signal Ladder from L3 to L7

Interviewers score wide-column questions on a ladder, not a checklist. Knowing the ladder lets you aim your answer at the level you are targeting.

L3 (new grad). Can recite the CQL basics, define partition key versus clustering key, and write a simple `CREATE TABLE`. Will fail a hot-partition question but will recognize `ALLOW FILTERING` as bad. Target: answer Q1, Q2, Q5 cleanly.

L4 (SDE). Can design a query-first schema for a well-known problem (chat, activity feed, session store), picks TWCS for TTL workloads, knows `LOCAL_QUORUM` as the default. Can walk the write path and name commit log, memtable, SSTable. Target: answer Q1-Q8 cleanly, volunteer partition sizing numbers.

L5 (Senior). Can design a schema from ambiguous requirements, drives the conversation toward access patterns before CQL, picks compaction strategy with justification, and knows LWT is almost always the wrong answer. Can do zero-downtime migration (double-write, backfill, cut over). Target: answer Q6, Q9, Q12 with operational depth.

L6 (Staff). Thinks in ADRs. Evaluates Cassandra versus ScyllaDB versus DynamoDB versus Bigtable on decision criteria. Knows when to push back on the problem statement ("you don't need wide-column for this, Postgres is fine"). Designs multi-region topology with partition-aware routing and disaster recovery. Target: turn any question into a tradeoff discussion.

L7 (Principal). Governance and org-level decisions. "Should we standardize on Cassandra or ScyllaDB across the company?" "What is the cost of our wide-column investment?" "Who owns schema review at 2000 engineers?" Answers reference maturity models, organizational topology, and long-horizon cost curves.

Worked example on Q6 (hot partitions). An L4 answer says "add a time bucket." An L5 answer says "add a time bucket, but the cut-over needs double-write for one read-window duration plus a reconciliation job, and I need to check that the new key still preserves the primary query's clustering order." An L6 answer says all of that plus "and here is why ScyllaDB's tablets would fix this without a schema change, but a schema change is still the right answer because we need the new partition to enforce the 100MB governance rule."

Entry-point reflex. For every question in the section above, force yourself to state one number (partition size, QPS threshold, latency target, RF, GC pause budget). Numbers are the difference between a memorized answer and an engineered one.

### Senior @ FAANG: Bar-Raiser Questions, ADR Patterns, and Staff Signal

Bar-raiser questions go beyond the canned list. These are the ones principal engineers ask to separate L5 from L6 and L6 from L7.

BR1. "Migrate a 5TB Postgres orders table to Cassandra with zero downtime. Walk me through the plan."

Staff-level answer. (1) Inventory access patterns from the Postgres query log, not from the schema. (2) Design Cassandra tables per query, not per entity. (3) Stand up dual-write at the service layer with a feature flag per query path. (4) Backfill historical data using a batched reader and idempotent writes keyed by `order_id`. (5) Validate with a reconciliation job that diffs row counts and sample hashes. (6) Shift reads per query path, leaving Postgres as the write-of-record until every read path is validated. (7) Cut writes over, keep Postgres in read-only mode for one `gc_grace_seconds` window as a rollback. (8) Decommission. Document every step as an ADR with a rollback trigger per phase.

BR2. "Debug a partition skew where one node is doing 10x the work."

Staff-level answer. Start with the token ring. `nodetool status` for ownership, `nodetool tablehistograms` for partition size distribution. If ownership is uneven, check vnode config and whether a bootstrap went wrong. If ownership is even but load is not, the problem is a hot partition. Find it with `nodetool toppartitions`. Then decide: tactical fix (application-layer cache, request coalescing) versus strategic fix (schema change with double-write). Never stop at the tactical fix in an interview answer.

BR3. "Shard a time-series at petabyte scale without losing query locality."

Staff-level answer. Composite partition key of `(source_id, day_bucket)`, TWCS with one-day windows, `default_time_to_live` tied to retention policy, secondary query tables for rollups computed by a Flink pipeline. Discuss the re-sharding cost if the bucket granularity proves wrong. Name the metric you would watch to trigger a re-shard (p99 partition size over 100MB for a week).

BR4. "Cassandra versus ScyllaDB. Write the ADR."

Staff-level answer. Do not pick a winner in the first minute. Lay out axes: JVM operational surface, tablet-based rebalancing, feature parity (SAI in Cassandra 5.0, Alternator in ScyllaDB 6.0), migration cost, support ecosystem, talent availability. State your org's constraints. Then pick, with a rollback trigger.

BR5. "Design a multi-region messaging system with Cassandra."

Staff-level answer. Three DCs, RF=3 per DC, `LOCAL_QUORUM` reads and writes, async cross-DC replication for durability. Keys include a region hint so routing is DC-local. For "mark as read" which must be globally consistent, either accept eventual consistency with a cross-DC read-repair, or use a separate metadata store with stronger semantics (Spanner, FoundationDB). Discuss the failure mode of a region outage and the cost of `EACH_QUORUM` for the handful of paths that truly need global consistency.

ADR pattern for schema evolution. Every non-trivial Cassandra schema change is an ADR. Template.

Context. What query pattern drives the change? What is the current operational pain?
Decision. The new schema, as CQL, with partition key sizing numbers.
Migration. Double-write window, backfill strategy, reconciliation, cut-over, rollback trigger.
Consequences. Operational cost, compaction impact, capacity change, who owns the runbook.

Staff signal in interviews is consistency in applying this template to any schema question.

Maturity model for interview performance.

L1 Recites. Knows vocabulary but cannot reason.
L2 Applies. Can pick the right strategy for a textbook problem.
L3 Designs. Can design a schema from requirements.
L4 Tradeoffs. Surfaces tradeoffs without being asked.
L5 Governance. Answers in ADR form, including rollback, observability, and ownership.

---
