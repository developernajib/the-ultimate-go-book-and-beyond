## Exercises

1. **Partition Key Design for Even Distribution**: You are building a multi-tenant messaging platform storing messages in a `messages` table. Analyze three candidate partition key strategies: `(tenant_id)`, `(tenant_id, channel_id)`, and `(tenant_id, channel_id, bucket)` where bucket is a time bucket (e.g., `YYYYMMDD-HH`). For each strategy, calculate the theoretical partition size after 90 days given 500 tenants, 200 channels per tenant, and 1,000 messages per channel per hour. Identify which strategies produce hot partitions and why. Implement the winning schema in Go using `gocqlx`, write a token-distribution test using `nodetool ring` output, and benchmark write throughput for each. Expected outcome: a comparative analysis document, schema DDL, and Go benchmarks showing writes-per-second per strategy.

2. **Time-Series Data Modeling with TTL**: Design a Cassandra schema for storing per-device sensor readings (device ID, metric name, timestamp, value) for an IoT platform with 500K devices, each emitting 10 metrics every 10 seconds. Requirements: raw data retained for 7 days using TTL, hourly rollups retained for 1 year stored in a separate table, and queries must retrieve the last 1 hour of a single metric for a single device in under 50ms. Implement a Go writer that uses `gocql`'s `USING TTL` clause, a background aggregator that computes hourly stats via `SELECT` + batch `INSERT`, and verify TTL expiry in an integration test using a local Cassandra cluster. Expected outcome: schema DDL with TTL annotations, Go writer and aggregator services, and integration tests confirming expiry behavior.

3. **Handling Tombstones and Compaction**: Set up a local Cassandra cluster, insert 1M rows into a `sessions` table with a 60-second TTL, wait for expiration, then measure read latency degradation caused by tombstone accumulation before and after a manual `nodetool compact`. Write a Go benchmark that issues 10K point reads while tombstone count is high versus after compaction, capturing p50/p95/p99 latencies. Explain the tombstone warning threshold (`tombstone_warn_threshold`), demonstrate configuring TWCS to reduce tombstone buildup for time-series workloads, and document the operational runbook for compaction monitoring. Expected outcome: benchmark results comparing latency profiles, updated schema using TWCS, and a written runbook.

4. **Multi-Datacenter Replication Setup**: Using Docker Compose, stand up a two-datacenter Cassandra cluster (3 nodes in `dc1`, 3 nodes in `dc2`) with `NetworkTopologyStrategy` replication factor 3 per DC. Write a Go application that: writes with `LOCAL_QUORUM` consistency in `dc1`, reads with `LOCAL_QUORUM` from `dc2`, and simulates a full `dc1` network partition by pausing its containers, verifying that `dc2` reads remain available. Measure replication lag under normal operation and document the consistency-availability trade-offs at each consistency level. Expected outcome: Docker Compose file, Go test suite with partition-simulation scenarios, and a written analysis of CAP trade-offs for each tested consistency level.

5. **Lightweight Transactions (LWT) Use Cases**: Implement a distributed job-claim system where multiple Go worker processes compete to claim jobs from a `pending_jobs` table using LWT (`IF claimed = false`). Measure the latency overhead of Paxos-backed LWT versus a non-LWT compare-and-swap approach using Redis. Identify three scenarios where LWT is the correct choice and three where it should be avoided, with justification. Then implement a saga pattern for a three-step order workflow (reserve_inventory → charge_payment → confirm_order) using LWT for each step and compensating transactions for rollback. Expected outcome: Go worker implementation, latency comparison benchmark, scenario analysis writeup, and saga implementation with rollback tests.

6. **Migrating from PostgreSQL to Cassandra**: Given a normalized PostgreSQL schema for a social network (`users`, `posts`, `follows`, `likes` tables with foreign keys), design the equivalent Cassandra schema driven by the top five query patterns identified from the PostgreSQL slow-query log. Write a Go migration tool that reads from PostgreSQL using `pgx`, transforms rows into Cassandra's denormalized model, and writes in parallel batches using `gocql`'s `BatchObserver` for progress tracking. Implement validation logic that counts rows in both databases and spot-checks 1,000 randomly sampled records for data integrity. Document schema trade-offs including data duplication ratios and eventual-consistency implications. Expected outcome: Cassandra DDL, Go migration tool with parallel batch writer, validation report, and a written trade-off analysis.

The golden rule: **design for your queries, not your data**. Every access pattern needs its own table.

### Junior → FAANG: A Worked Walk-Through of Exercise 1

The six exercises above are deliberately open-ended. At junior level the discipline is to do one of them end-to-end rather than all of them halfway. Pick Exercise 1 and walk it like an interview.

Step 1. Access patterns. Write "load last N messages in a channel" and "list channels for a tenant." That is it. Do not invent queries.

Step 2. Size the partitions for each candidate.

`(tenant_id)` alone. 200 channels * 1000 msg/hr * 24 hr * 90 days = 432 million rows per tenant. At roughly 200 bytes per row, 86GB per partition. Fails the 100MB rule by 3 orders of magnitude. Reject.

`(tenant_id, channel_id)`. 1000 msg/hr * 24 * 90 = 2.16 million rows per partition. Roughly 432MB. Fails by 4x. Reject.

`(tenant_id, channel_id, day_bucket)`. 24,000 rows per partition. Roughly 4.8MB. Passes. Accept.

Step 3. Compaction. TWCS with a one-day window matches `day_bucket`. TTL 90 days if that is the retention.

Step 4. Consistency. LOCAL_QUORUM for writes, LOCAL_ONE for reads if the product tolerates occasional staleness, LOCAL_QUORUM for reads if it does not.

Step 5. Go implementation. `gocqlx` with a typed struct, token-aware routing, one query per access pattern. Benchmark with a synthetic workload that exercises the three candidate schemas. Report writes/sec, p99 latency, and partition size histogram.

Why did this fail reflex. If a teammate proposes `(tenant_id, channel_id)` because "it already isolates channels," the reflex answer is "the partition grows past 100MB in 23 days, we need a day bucket." Numbers, not vibes.

First-job deliverable. Commit the schema, the benchmark code, and a one-page writeup with the math above. That writeup is a better portfolio piece than any side project on GitHub.

### Senior @ FAANG: Staff Extensions and a Platform View of the Exercise Set

At staff level the exercises above compose into a wide-column platform. Treat the set as a scaffold for a real internal platform and extend each with governance, observability, and ADR material.

Extension to Exercise 1. Ship the winning schema plus a CI lint that rejects any message-like table without a time bucket. Document the ADR for the bucket granularity (day versus hour versus week) with explicit cost math. Add a runbook for re-bucketing a hot channel without downtime using double-write.

Extension to Exercise 2. Layer on a downsampling pipeline using Flink or Materialize that writes 1-minute, 5-minute, and hourly rollups into separate tables. ADR explains why the rollup pipeline is external rather than implemented as Cassandra materialized views (materialized views have known correctness issues and are not recommended at scale). Include a reconciliation job that sanity-checks rollup totals against raw data daily.

Extension to Exercise 3. Extend the benchmark into a regression test that runs in CI on every schema change affecting a TTL-tagged keyspace. Document the tombstone governance thresholds and the alerting rules.

Extension to Exercise 4. Add a third DC, model an asymmetric 60/30/10 split, and design a region-failover runbook that includes the reconciliation strategy when the failed region returns. Chaos-test it with a tool like Gremlin or Chaos Mesh. Document the RTO and RPO the runbook achieves.

Extension to Exercise 5. Reject LWT as the job-claim primitive and propose a Kafka-based work queue with idempotent consumers instead. ADR compares the two on throughput, latency, and operational complexity. Implement both for the benchmark and show the crossover point where Kafka wins.

Extension to Exercise 6. The migration tool is a one-off script. The staff deliverable is a migration framework: a library that takes a source-to-destination schema mapping, a chunk size, a parallelism budget, and a reconciliation spec, and produces a repeatable migration. Reuse it for the next migration. Open-source it if legal clears.

Additional staff exercises.

Exercise 7. Write a schema lint for Cassandra that enforces the governance rules from this chapter (no ALLOW FILTERING, bounded partitions, LOCAL_QUORUM in multi-DC, TTL-tagged keyspaces on TWCS, no new counter tables without sign-off). Ship as a pre-commit hook and CI check.

Exercise 8. Design the multi-region topology for a globally distributed product with LOCAL_QUORUM writes, region-local reads, and an explicit cross-region consistency path for the handful of flows that need it. Write the ADR.

Exercise 9. Build a Kafka-to-Cassandra ingest with exactly-once semantics. Idempotent keys, consumer offset management, reconciliation job, observability. Benchmark the throughput cost of idempotency.

Exercise 10. Migrate a production table from STCS to UCS without exceeding 30% extra disk or 10% read latency regression. Stage it, dry-run it, write the runbook, execute it, post-mortem it.

Maturity model for exercise portfolio.

L1 Completes one exercise.
L2 Completes several with tests.
L3 Adds observability and runbooks.
L4 Adds ADRs and governance hooks.
L5 Composes the exercises into a platform others use.

This is the ladder a staff engineer climbs by shipping a wide-column platform deliberately, one governance primitive at a time, until the org's junior engineers physically cannot ship the mistakes from section 37E.13.
