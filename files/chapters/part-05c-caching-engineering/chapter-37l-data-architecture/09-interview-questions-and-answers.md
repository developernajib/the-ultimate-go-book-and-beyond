## Interview Questions and Answers

**Q: What is the key difference between Lambda and Kappa architecture, and which would you pick in 2026?**

A: Lambda has two separate processing paths: a batch layer (correct, high-latency) and a speed layer (approximate, low-latency), merged at query time. Kappa eliminates the batch layer. Stream processing handles both historical and real-time data, and reprocessing is done by replaying the Kafka log from offset zero. In 2026 the default is Kappa. Modern Flink jobs replay at 10x to 100x ingestion rate, which removes the last practical argument for keeping a batch plane. The reason Lambda fell out of favour is not cost, it is drift: teams wrote the same business rule twice (once in Spark SQL, once in Flink) and the two versions silently diverged over months. I would still pick Lambda in one case: when the batch engine offers a capability streaming cannot match (large shuffle-heavy ML training, vendor-specific SQL warehouses), and I accept the drift tax consciously.

**What FAANG expects:** Name Nathan Marz and Jay Kreps. Reference Flink replay performance. Articulate drift as the killer, not cost. Identify when Lambda still wins (ML training on Snowflake or BigQuery). Avoid saying "Kappa is always better", that is a junior answer.

**Follow-ups:**
1. If you are on Kappa and a business rule changes, walk me through the reprocessing procedure end to end. Include state store migration and the atomic view swap.
2. How does Flink's two-phase commit protocol give exactly-once semantics to external sinks, and what fails when the sink is not transactional?
3. You have a Kappa pipeline processing 2M events per second with 5 TB of operator state in RocksDB. What goes wrong at checkpoint time, and how do you mitigate?

---

**Q: How does optimistic concurrency in event sourcing prevent data corruption?**

A: Every aggregate tracks its version, the count of committed events. When writing new events, you specify `expectedVersion`. The event store checks the current max version for that aggregate. If the actual version differs from expected, another writer committed in between, and you get a concurrency error. The caller retries by reloading the aggregate and replaying their command. This is enforced at the database level with a `UNIQUE(aggregate_id, version)` constraint, making it impossible to insert two events at the same version. The approach avoids distributed locks and scales because each aggregate is its own serialization boundary.

**What FAANG expects:** Mention the UNIQUE constraint explicitly. Explain why this is better than a SELECT FOR UPDATE (no lock held across network round-trip, no risk of deadlock across aggregates). Discuss the retry loop and command idempotency.

**Follow-ups:**
1. Your command handler retries on concurrency conflict. What happens if the command itself was not idempotent (for example, "add 10 to balance" re-applied twice)? How do you make commands idempotent?
2. At what aggregate size does loading all events become too slow, and what do you do about it? Discuss snapshotting trade-offs.
3. Two aggregates must update atomically (for example, a money transfer). Event sourcing says aggregates are the consistency boundary. How do you reconcile?

---

**Q: What is the dual-write problem in CDC, and how do you solve it?**

A: When you need to write to both a primary database and a message broker (Postgres plus Kafka, say), you cannot do both atomically. If Postgres commits but the Kafka publish fails, you have inconsistency that will corrupt downstream projections. The three canonical solutions are: (1) **Transactional Outbox**: write events to an `outbox` table in the same Postgres transaction as the business data, then a separate process reads the outbox and publishes to Kafka. The outbox is atomic with the business write. (2) **Debezium CDC**: let the database be the source of truth, and Debezium reads the WAL to publish changes, no application-level dual write needed. (3) **Saga / compensating transactions**: accept eventual consistency, use compensating actions to roll back if the second write fails. Outbox is the default for greenfield Go services. CDC is the default when you are integrating legacy systems that you cannot change.

**What FAANG expects:** Name all three patterns. Know that Debezium is the reference implementation, running on Kafka Connect. Mention Postgres replication slot monitoring (restart_lsn lag fills the disk if a consumer dies). Know that outbox requires an idempotent consumer on the Kafka side.

**Follow-ups:**
1. Your outbox table grows without bound. What is your retention and cleanup strategy, and how do you avoid deleting events that have not yet been consumed?
2. You use Debezium for MySQL binlog. A DBA runs `ALTER TABLE` to add a column. What happens to your downstream consumers, and how do you detect it?
3. Compare the Transactional Outbox pattern with using Kafka's transactional producer (`isolation.level=read_committed`). When is each preferred?

---

**Q: You are designing a real-time analytics system. Walk me through your choice of stream processor.**

A: The question to answer first is: is the workload stateless or stateful, and how big is the state? Stateless transforms (filter, enrich, route) fit Benthos or Redpanda Connect, which is a Go-native declarative pipeline tool, good operational profile, no JVM. Small stateful aggregations (under a few GB) can be hand-written in Go with a Redis or RocksDB state store. Large stateful workloads (multi-TB state, complex joins, event-time windows with strict exactly-once) want Flink. Kafka Streams is a fine choice if your application is already JVM, because it embeds in-process and avoids a separate cluster. For SQL-first teams, incremental-view systems like Materialize or RisingWave let you write streaming SQL over Kafka with Postgres wire protocol on the read side. I would not hand-roll a stateful stream processor in Go for anything that Flink does well, the watermark and checkpoint logic is subtle enough that reinventing it loses more time than the JVM ops overhead costs.

**What FAANG expects:** Clear decision tree driven by state size and exactly-once requirements. Mention event time versus processing time. Know Flink's checkpoint mechanism at a high level (distributed snapshots via Chandy-Lamport). Name Benthos/Redpanda Connect as the Go-native choice.

**Follow-ups:**
1. Your Flink job has a watermark stuck because one Kafka partition has no traffic. The window never closes. What do you do?
2. Explain the difference between tumbling, sliding, and session windows, and give a business use case where only session windows work.
3. A Flink job with 5 TB of RocksDB state needs to be rescaled from 20 to 40 task managers. Walk me through the rescale procedure.

---

**Q: Your team wants to adopt Data Mesh. Walk me through whether that is a good idea, and how you would stage it.**

A: Data Mesh is an organizational pattern, not a technical one. The first question is not about tooling, it is about org chart. Do you have five or more distinct data-producing domains, each with its own engineering team that can credibly own a data product including its SLOs? Do you have executive backing to hold those teams accountable for data quality the same way they are accountable for service uptime? If the answer to either is no, a mesh will fail, regardless of tooling. Dehghani's own 2026 retrospective admits most adoptions have implemented the tooling without the organizational change and reduced "data products" to clean datasets with metadata. If yes, I would stage it: (1) pick one or two domains as pilots, define their data products with schema, SLOs, and typed output ports, (2) build a thin Go platform for registry, contract validation, and SLO monitoring, the self-serve platform principle, (3) establish a federated governance council with representation from each domain to set global rules on PII, retention, and identity resolution, (4) expand domain by domain. Skip step three at your peril, it is where meshes turn into swamps.

**What FAANG expects:** Frame it as organizational, not technical. Name Zhamak Dehghani and the four principles (domain ownership, data as product, self-serve platform, federated governance). Know the 2026 adoption reality, most claimed adoptions have not implemented the governance layer. Recommend against Data Mesh for small organizations.

**Follow-ups:**
1. Two domain teams define "customer" differently. Whose definition wins, and how do you enforce it across the mesh?
2. A data product's freshness SLO is 5 minutes. The consumer needs 30 seconds. How do you resolve this contract conflict?
3. How does Data Mesh relate to (or contradict) Conway's Law?

---

**Q: Explain CQRS and when to use it without Event Sourcing.**

A: CQRS (Command Query Responsibility Segregation) separates the write model from the read model. Writes go through a command handler that enforces business rules against a normalized schema. Reads go through a query handler that returns data from one or more denormalized views optimized for specific query patterns. CQRS and Event Sourcing are often taught together but they are independent. You can adopt CQRS over a plain CRUD Postgres database by projecting writes to denormalized read tables with zero event sourcing. This is Oskar Dudycz's pragmatic framing: start with CRUD, move to CQRS when read and write patterns genuinely diverge (for example, when you need a dashboard that joins five tables and the JOIN is too slow), only then consider event sourcing if temporal queries are a core requirement. The trap in CQRS, whether or not it sits on event sourcing, is reconciliation lag. The write succeeds, the projection is a few seconds behind, the user refreshes and sees stale data. You solve this with read-your-own-writes caching on the session or by making the projection update synchronous for specific high-value queries.

**What FAANG expects:** Clean separation of "CQRS is read/write model split" from "Event Sourcing is events as system of record". Name Greg Young (coined both terms) and Oskar Dudycz (pragmatic modern advocate). Discuss reconciliation lag as a concrete problem and at least one mitigation.

**Follow-ups:**
1. Your read model is async-updated 3 seconds behind writes. A user places an order, then hits the "my orders" page and sees nothing. What are three different ways to fix this?
2. The write model uses Postgres, the read model uses Elasticsearch. The Elasticsearch projection goes down for an hour. What is the recovery procedure, and what does the user experience during that hour?
3. When would you split a monolithic CQRS system into multiple bounded contexts, and how does that change your event flow?

### Junior → FAANG: The L3 and L4 Signal Ladder for Data Architecture Questions

At L3 the bar is "can you name the patterns and draw a correct box-and-arrow diagram." At L4 the bar is "can you pick between two patterns and defend the choice with a concrete tradeoff." The questions above cover both rungs, but the signals interviewers listen for are different. For L3 the signal is vocabulary precision. If you say "exactly-once" without qualifying whether you mean broker delivery, processing, or end-to-end effect, you have lost the signal. For L4 the signal is tradeoff articulation. "I picked Kappa because reprocessing is faster than rewriting batch logic" is L3. "I picked Kappa knowing we pay for 3x the stream capacity during replay windows and that our finance team still runs quarterly reconciliation in batch because the auditors want it, so we budgeted for a small batch plane purely for compliance output" is L4.

Worked example of an L4 answer to "design a real-time fraud detection pipeline." Start with the SLO. Fraud decisions must return in under 100ms at P99, and the false-positive rate must stay under 0.5 percent. Ingestion is 50K transactions per second peak. Architecture: Kafka for transaction ingress with 30-day retention, Flink for stateful feature computation with 15-minute tumbling windows over account history, a feature store like Feast for online lookups, and a model server for scoring. The decision boundary you defend is why Flink and not a hand-rolled Go service. Answer: the state per account grows to multiple GB across a long tail of accounts, event-time windowing with watermarks is non-trivial to reimplement, and the checkpoint-and-replay story for exactly-once feature computation is what Flink does well. That answer hits L4 because it names the SLO, the scale, the state size, and the specific capability that rules out the simpler option.

First-job reflex list. When a pipeline misbehaves, do not guess. Run through: is the consumer lag growing, is the watermark advancing, are checkpoints completing, is the schema registry reporting compatibility errors, is the CDC replication slot lag within bounds. Those five checks cover most incidents and they build the mental model interviewers expect you to have by L4. Naming the checks out loud in an interview is a strong signal even if you do not know the exact Prometheus metric name.

### Senior @ FAANG: The L5 Through L7 Bar-Raiser Ladder and Platform Charters

At L5 the interviewer is testing whether you can make a call that binds a team for two years. At L6 the interviewer is testing whether you can make a call that binds an org for five. At L7 the interviewer is testing whether you can shape industry or set company strategy. The questions above are L4 and L5. The bar-raiser variants push into L6 and L7 territory, and the signal shifts from technical tradeoff to organizational design.

L6 bar-raiser one. "Design an event-sourced audit system for a bank that must satisfy SOX, PCI-DSS, and jurisdictional regulators in 14 countries." The L6 answer covers immutable storage with cryptographic chaining, key management with HSM integration, retention policies that differ by jurisdiction and account type, projection rebuild SLOs that tie to regulator response windows, and a governance model that names the compliance officer as the product owner of the audit stream. It also names the failure mode you are designing against: a regulator subpoena that lands on a Tuesday and demands full account history by Friday. Your architecture either meets that or it does not, and naming the scenario is the L6 signal.

L6 bar-raiser two. "Migrate a 7-year-old Lambda pipeline to Kappa over 12 months with zero downtime and no data loss." Strong answer names the phased approach: deploy Kappa in shadow mode for 3 months, reconcile outputs daily, cut over consumer by consumer starting with internal dashboards and ending with regulator-facing reports, retire the batch plane only after 90 days of clean shadow runs. Name the rollback plan at each phase. Name the reconciliation tolerance: exact match on transaction counts, under 0.01 percent drift on monetary aggregates, zero drift on regulator-reportable fields. Name the communication plan: weekly steerco with the data governance board, monthly reports to the CDO.

L7 bar-raiser. "Architect the data platform for a Series B startup that will scale to 1000 engineers in 3 years." The L7 answer is a charter, not an architecture. The charter names the products the platform will offer (ingestion, storage, compute, serving, lineage, catalog, access control), the SLAs per product, the governance board composition, the escalation path, the contract DSL, the incident response runbook structure, and the capacity plan in headcount and dollars for each of the next 12 quarters. It also names what the platform explicitly will not do in year one, such as real-time ML feature serving or federated query across clouds, and the criteria that would unlock those capabilities later. An L7 candidate who describes Kafka topics instead of a charter has failed the rubric.

Exactly-once Flink at 1M events per second. This is a concrete L6 question that tests whether the candidate has actually run a large Flink job. The correct answer walks through RocksDB state backend sizing, incremental checkpoints to S3 with multipart upload tuning, checkpoint interval tuned against the recovery SLO rather than a default, aligned versus unaligned checkpoints with the tradeoff named, Kafka transactional sink with a producer pool matched to parallelism, and the monitoring story with checkpoint duration histograms and backpressure metrics. Candidates who have only read the documentation name aligned checkpoints by default. Candidates who have run the system in production name unaligned checkpoints with a retention bound, because alignment stalls under backpressure at that scale.

Data platform charter template for staff scope. Section one lists the data products with owners and SLOs. Section two lists the contracts enforced at the platform boundary with examples. Section three lists the governance board members, meeting cadence, and decision rights. Section four lists the incident response tiers with pager rotations. Section five lists the lineage and catalog coverage targets per quarter. Section six lists the deprecation policy for old datasets. Section seven lists the cost model and chargeback policy. Any staff-level data architecture interview that reaches the 45-minute mark should end with the candidate sketching at least three of these sections on the whiteboard unprompted.

---
