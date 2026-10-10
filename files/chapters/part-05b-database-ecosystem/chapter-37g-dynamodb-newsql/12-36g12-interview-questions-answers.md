## 37G.12 Interview Questions & Answers

**Q1: When would you choose DynamoDB over a relational database?**

A: Choose DynamoDB when: (1) you have well-defined, predictable access patterns that can be modeled with key-value or hierarchical queries. (2) you need guaranteed single-digit millisecond latency at any scale without operational overhead. (3) you need serverless/on-demand scaling for variable workloads. (4) you're heavily invested in AWS ecosystem (Lambda, AppSync, EventBridge). Choose RDBMS when: you need ad-hoc queries, complex reporting, frequent schema changes, or when access patterns are unknown/evolving.

*What FAANG expects:* Frame the decision around access patterns first, cost model second, consistency requirements third. Expect a bar-raiser followup that probes your understanding of the CAP trade-off. Do not say "DynamoDB is NoSQL so use it for unstructured data", this is a red flag.

Follow-ups:
- How would you model a leaderboard with top-N queries on DynamoDB, and where does it fall apart? (Answer: sparse GSI with rank buckets or a cache. pure DynamoDB is poor at global ordering.)
- Walk me through the monthly cost difference between on-demand and provisioned for a workload with 10k peak WCU and 500 baseline WCU.
- If access patterns are not fully known up front, what is a pragmatic middle-ground design? (Answer: prefer RDBMS, or use a flexible PK/SK with overloaded indexes and accept future table rebuilds via streams.)

**Q2: Explain DynamoDB's single-table design pattern.**

A: Instead of one table per entity (like relational DBs), single-table design stores all entities in one table using composite keys (PK+SK) to create hierarchical relationships. PK typically uses prefixed values (`USER#id`, `ORDER#id`) and SK stores entity type or sub-entity identifier. Benefits: (1) eliminates cross-table transactions for related data. (2) enables efficient retrieval of related items with a single Query. (3) reduces operational complexity (one table to manage). Downsides: complex to design, hard to query ad-hoc, requires knowing all access patterns upfront.

*What FAANG expects:* You should cite Rick Houlihan by name, show you have written an access-pattern list before any schema, and explain overloaded GSIs (`GSI1PK`/`GSI1SK`) as generic index attributes that different entities fill with different prefixes.

Follow-ups:
- Draw a single-table schema for users, organizations, and org memberships with the access patterns "get user by id", "get user's orgs", and "get org's members".
- What is a sparse GSI and when is it the right tool? (Answer: index attributes only present on a subset of items, ideal for filtering by rare states like "pending".)
- How do you evolve a single-table schema when a new access pattern appears? (Answer: add a new GSI, backfill via a stream-driven migration, then flip reads.)

**Q3: What is the difference between GSI and LSI in DynamoDB?**

A: **LSI** (Local Secondary Index): same partition key as the table, different sort key. Can only be created at table creation time. Uses the parent table's storage. Supports strongly consistent reads. Limited to 10GB per partition key value. **GSI** (Global Secondary Index): different partition key (and optional sort key). Can be created/deleted at any time. Has its own provisioned capacity (separate RCU/WCU). Eventually consistent reads only. No size limit per partition. Best practice: prefer GSI for most secondary access patterns. Use LSI only when you need strong consistency with alternate sort order.

*What FAANG expects:* You should mention that LSIs are almost never the right choice in modern designs because of the 10 GB per-partition-key cap. Know that the default quota is 20 GSIs per table now, up from the original 5.

Follow-ups:
- Why can you never add an LSI after table creation, but you can add a GSI? (Answer: LSIs share storage with the base table, so the range scan infrastructure must be provisioned upfront.)
- What is the replication lag you should budget for GSI eventual consistency? (Answer: usually single-digit milliseconds but not bounded, so never write to the base table then immediately read from the GSI in the same request.)
- How does GSI write amplification affect cost? (Answer: each base-table write propagates to every affected GSI, so heavy GSI fan-out multiplies WCU consumption.)

**Q4: How does CockroachDB achieve distributed ACID transactions?**

A: CockroachDB uses a two-phase commit (2PC) protocol with a coordinator node managing the transaction. For serializable isolation, it uses multi-version concurrency control (MVCC) and tracks timestamps of reads and writes. If concurrent transactions conflict (same key modified), one is aborted (serialization failure, error 40001) and must retry. CockroachDB's consensus protocol (Raft) ensures each range (default 512 MiB as of v25) is replicated with majority acknowledgment. TrueTime-inspired hybrid logical clocks (HLC) provide causality tracking across nodes without requiring special hardware.

*What FAANG expects:* Contrast CockroachDB's HLC approach with Spanner's TrueTime hardware approach. Explain why HLC is cheaper to deploy but cannot guarantee external consistency at the same quality bar as TrueTime-based commit-wait.

Follow-ups:
- Why do applications on CockroachDB have to handle `40001` retries when they do not on a single-node Postgres? (Answer: Postgres defaults to Read Committed which hides serialization conflicts, CockroachDB defaults to Serializable which surfaces them.)
- How does CockroachDB avoid hot ranges when a monotonically-increasing sequence is used as a primary key? (Answer: it does not, by design, use `UUID` or hash-prefixed keys.)
- What is the difference between "SURVIVE REGION FAILURE" and "SURVIVE ZONE FAILURE" zone configs?

**Q5: What is Google Spanner's TrueTime and why does it matter?**

A: TrueTime is Google's globally synchronized clock using GPS receivers and atomic clocks in each data center. It provides time as an interval `[earliest, latest]` with bounded uncertainty (typically under 7ms). Spanner uses TrueTime to assign commit timestamps: when committing a transaction, Spanner waits until the entire TrueTime interval has passed (commit wait) to ensure no future transaction can get an earlier timestamp. This provides **external consistency** (linearizability): if transaction T1 commits before T2 starts, T2 is guaranteed to see T1's writes, globally, without distributed locks.

*What FAANG expects:* You must be able to explain commit-wait and why it is a latency floor, not ceiling. Bonus points for noting that TrueTime uncertainty has tightened to under 1ms in newer deployments, which directly reduces global-write latency.

Follow-ups:
- What is the minimum write latency you would budget for a multi-region Spanner write? (Answer: the commit-wait plus Paxos round-trip, typically 30 to 100 ms globally.)
- When would you choose bounded-staleness reads over strong reads on Spanner?
- How does Spanner's PostgreSQL interface (GoogleSQL vs PG dialect) affect application portability in 2026?

**Q6: How do you handle DynamoDB capacity planning?**

A: (1) **On-demand mode**: for unpredictable or spiky workloads, AWS auto-scales and charges per request. Roughly 7x the per-request cost of a fully-utilized provisioned table, but no capacity management. (2) **Provisioned with Auto Scaling**: set target utilization (e.g., 70%), DynamoDB auto-scales between min/max. Scaling takes minutes, which is problematic for sudden spikes. (3) **Reserved capacity**: 1-year or 3-year reservation for predictable base load, combined with auto-scaling for peaks. Monitor: `ConsumedReadCapacityUnits`, `ConsumedWriteCapacityUnits`, `ThrottledRequests` metrics. Always size for peak load + 20% buffer. Since 2024 you can switch between on-demand and provisioned once every 24 hours with no migration penalty, which makes "start on-demand, switch to provisioned once traffic is predictable" a standard playbook.

*What FAANG expects:* A cost model that starts from access-pattern RCU/WCU arithmetic (a 4 KB eventually-consistent read = 0.5 RCU, a strongly-consistent read = 1 RCU, transactional = 2 RCU) and ends at a monthly dollar figure, not a vague "use on-demand".

Follow-ups:
- How do you prewarm a provisioned table before a known traffic spike like Black Friday? (Answer: schedule a scale-up ahead of time, or switch to on-demand for the duration.)
- What metric would tell you that you have a hot-partition problem even when total consumed capacity is below the table limit? (Answer: `ThrottledRequests` with non-zero values while `ConsumedCapacity` is low, or the per-partition heat map in CloudWatch Contributor Insights.)
- Describe a situation where provisioned auto-scaling can actually make latency worse.

**Q7: What is YugabyteDB's DocDB storage engine?**

A: YugabyteDB uses DocDB, a document storage engine built on RocksDB (LSM tree) with a custom sharding layer. DocDB encodes relational rows as key-value pairs where the key includes the table ID, partition key hash, and clustering columns, and the value contains non-key column data. This allows efficient range scans (clustering key range queries) while maintaining the write-optimized LSM structure of RocksDB. YugabyteDB's sharding uses a combination of hash partitioning (for uniform distribution) and range partitioning (for ordered scans), similar to CockroachDB but starting from a document store base rather than a relational base.

*What FAANG expects:* You can compare YugabyteDB's DocDB layer to Spanner's Colossus-backed storage and CockroachDB's Pebble (RocksDB fork). Know that YugabyteDB exposes two APIs (YSQL, Postgres-compatible, and YCQL, Cassandra-compatible) on the same storage.

Follow-ups:
- Why would a team choose YugabyteDB over CockroachDB in 2026? (Answer: dual API, tighter Postgres compatibility on YSQL, or multi-cloud portability without vendor managed service lock-in.)
- What are the LSM-tree write-amplification implications for a heavy-write workload?
- When does the LSM write path become a disadvantage versus a B-tree RDBMS?

**Q8: How would you migrate from DynamoDB to a relational database?**

A: (1) Enable DynamoDB Streams to capture all changes. (2) Write a Lambda/Go consumer that transforms DynamoDB items to relational rows based on entity type (PK prefix). (3) Perform initial bulk export via DynamoDB Export to S3, transform with Glue/Lambda, load into target DB. (4) Run dual-write: application writes to both DynamoDB and new DB simultaneously. (5) Verify consistency with checksums. (6) Switch reads to new DB incrementally by percentage. (7) Stop DynamoDB writes. Key challenge: transforming hierarchical single-table design to normalized relational schema, which requires careful mapping of PK/SK patterns to table foreign keys and often exposes implicit invariants the application was relying on.

*What FAANG expects:* A rollback plan at every step. Bonus points for naming strangler-fig pattern, shadow traffic comparison, and a kill switch that can revert reads to DynamoDB within minutes if the new store misbehaves.

Follow-ups:
- How do you verify data consistency between the two stores during dual-write? (Answer: async reconciler that samples keys, compares hashes, and alerts on drift.)
- What is the risk of writing to two stores synchronously from the application? (Answer: partial failures, no atomic commit, so a compensator or outbox pattern is required.)
- How would your approach change if the target is CockroachDB instead of Postgres? (Answer: similar pipeline but you can often skip heavy schema normalization because Cockroach handles the scale.)

### Junior to FAANG: Interview Signal Ladder L3 to L4

Interviewers grade these questions on a signal ladder. L3 (new grad or one year in) can correctly state what DynamoDB is, name one access pattern, and explain a partition key at a surface level. L4 (mid-level, two to four years) can draw a single-table schema for a small system, reason about GSI cost, and walk through capacity math without panicking.

Worked example at L4. "Design a DynamoDB single-table schema for Twitter." Start with access patterns, not tables. Get user profile by user_id. Get tweets by user_id newest first. Get a tweet by tweet_id. Get followers of a user. Get followees of a user. Get home timeline for a user. That last one is the trap. Home timeline cannot be answered by a single Query against this table for a celebrity with 100 million followers, because fan-out on write would cost too much, and fan-out on read would require scanning every followee. The L4 answer is "fan-out on write into a per-user timeline table for normal users, fallback to pull for celebrity accounts, and read-merge at query time." If you only answered the first five patterns and missed the celebrity trap, you scored L3. If you named the hybrid fan-out strategy unprompted, you scored L4.

Worked example of RCU arithmetic. "A user profile is 2 KB. You expect 5000 reads per second, strongly consistent. What is the provisioned RCU?" One strongly consistent read of up to 4 KB costs 1 RCU. 2 KB rounds up to 4 KB, so 1 RCU per read, times 5000 reads per second equals 5000 RCU. If the interviewer now changes it to 6 KB items, each read costs 2 RCU (rounded up), so 10000 RCU. If they change consistency to eventual, halve it. These three rules (4 KB unit, round up, eventual is half) get you through 90 percent of capacity questions.

First-job context. The questions in this chapter are the questions you will be asked in your screener and your on-site. You will not be asked to derive Paxos. You will be asked to pick between DynamoDB and Postgres for a described workload, justify the choice, and not embarrass yourself on a follow-up about hot partitions or GSI lag. Practice narrating the trade-offs out loud before you write any code, because the interviewer is listening for structure.

Entry-point answer template. Restate the workload in one sentence. List three access patterns. Name two candidate stores. Pick one with a one-sentence reason. Name the failure mode you are most worried about. Describe how you would measure it in production. This template is the difference between a noisy answer and a signal-carrying answer.

### Senior at FAANG: L5 to L7 Bar Raiser Questions and the Decision Framework

At staff (L6) and principal (L7), the questions stop being "what is a GSI" and start being "here is a 200 person organization running 14 services on 3 databases, tell me what you would change in the first 90 days." The ladder.

L5 (senior). "Design a rate limiter that survives a region failure." Expected depth. DynamoDB table with pk = customer_id, atomic counter via UpdateItem with ADD, TTL for window expiry, global tables for multi-region, acknowledgment that global-tables conflict resolution is last-write-wins so exact-enforcement is impossible and you must accept a small over-allow window during failover. Candidates who say "just use Redis" without naming the persistence and failover trade-offs lose the round.

L6 (staff). "When do you pick Spanner versus CockroachDB versus Aurora?" Framework. Spanner wins when you need external consistency across regions and you are in or near Google Cloud, or when you need global secondary indexes on a strongly consistent base. CockroachDB wins when you need Spanner semantics on your own cloud or on-prem, when you want Postgres wire compatibility, and when you are willing to operate the cluster or pay for CockroachDB Cloud. Aurora wins when a single primary fits your write throughput, when you need mature Postgres or MySQL feature parity (extensions, complex query planner), and when one region plus read replicas is enough. Bar-raiser follow-up: "what is the one workload where you would reject all three." Answer: ultra-low-latency single-key lookups at massive scale with no transactional guarantees, which belongs on DynamoDB or a key-value store.

L6 bar-raiser. "Migrate Postgres to DynamoDB. 2 TB, 500 tables, 200 queries. Six months. Go." Expected plan. Month 1, access-pattern inventory and kill list (drop unused queries, unused tables). Month 2, target schema in a design doc reviewed by three senior engineers. Month 3, shadow-write via outbox pattern, async reconciler. Month 4, read cutover by cohort behind a feature flag. Month 5, write cutover with Postgres as read-only standby. Month 6, decommission and postmortem. Explicit statement that the migration will fail if any query cannot be expressed in a DynamoDB access pattern, and the escape hatch is Aurora for the rejected queries.

L7 bar-raiser. "Pick Spanner or CockroachDB for a global bank ledger. Six regions. Regulatory requirement that EU customer data stays in EU. 10K transactions per second steady, 50K peak." Expected depth. Both meet the transactional requirement. Spanner's TrueTime gives external consistency with measurable commit-wait. CockroachDB's HLC gives linearizability with potentially higher tail latency at cross-region commit but cheaper cross-cloud deployment. Data residency: Spanner's leader placement controls and CockroachDB's geo-partitioning both can pin EU rows to EU nodes. Decision pivots on cloud strategy and operational maturity, not on the database. If the bank is multi-cloud or anti-Google, CockroachDB. If the bank is on GCP and wants managed, Spanner. Explicit statement that the real risk in a bank ledger is not the database, it is the double-entry invariant enforcement and the audit trail, both of which are application concerns.

L7 bar-raiser. "Estimate cost for a 10K WCU, 5 TB DynamoDB workload, provisioned mode, us-east-1, 2026 pricing." Expected. Provisioned WCU is roughly 0.00065 USD per WCU-hour, so 10000 times 0.00065 times 730 hours is about 4745 USD per month for write capacity. Storage at 0.25 USD per GB-month times 5000 GB is 1250 USD. Add GSI costs in proportion. Add PITR at roughly 20 percent of storage. Add data transfer egress if cross-region. Round to 7K to 10K USD per month. Candidates who say "it depends" without producing a number fail. Candidates who produce a number and then name the three biggest cost drivers to attack (GSI fan-out, on-demand versus provisioned, PITR window) pass.

Multi-region active-active ADR template. Context: read and write traffic in N regions, RPO under X seconds, RTO under Y minutes. Options: DynamoDB global tables (last-write-wins), Spanner multi-region (external consistency, commit-wait), CockroachDB multi-region (serializable, configurable survival goal). Decision: one choice. Consequences: for LWW, we accept conflict loss on concurrent writes to the same key. For Spanner, we accept commit-wait latency floor. For CockroachDB, we accept operational complexity and 40001 retries in the application. Validation: region-failure chaos drill once per quarter with measured RTO.

---
