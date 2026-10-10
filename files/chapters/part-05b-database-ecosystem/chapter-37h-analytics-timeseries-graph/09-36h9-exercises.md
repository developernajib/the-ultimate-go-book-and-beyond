## 37H.9 Exercises

**Exercise 1: Real-Time Analytics Dashboard**

Build a real-time analytics dashboard for an e-commerce platform:
- Ingest 10K events/second into ClickHouse using Go batch writer
- Implement materialized views for: hourly revenue, user retention cohorts, funnel analysis
- Build REST API serving sub-100ms dashboard queries
- Implement 5-minute cache for expensive aggregations in Redis
- Add anomaly detection: alert when conversion rate drops > 20% vs prior day

**Exercise 2: IoT Fleet Management**

Build a fleet monitoring system for 10K vehicles:
- Use TimescaleDB for GPS position, speed, fuel level (60-second intervals)
- Implement continuous aggregate for hourly trip summaries
- Detect anomalies: excessive idling, speed violations
- Build geospatial queries: vehicles currently in a bounding box
- Implement data retention: raw data 30 days, hourly aggregates 1 year

**Exercise 3: Social Network Recommendations**

Build a product recommendation engine using Neo4j:
- Import user data, products, and purchase history into graph
- Implement: collaborative filtering (purchases by followed users)
- Implement: content-based filtering (similar products via graph)
- Implement: fraud detection (shared device/IP pattern detection)
- Run GDS PageRank to rank products by network influence
- Benchmark: compare graph traversal vs PostgreSQL JOIN approach

### Junior → FAANG: Prerequisite gaps, worked examples, and the "why did this fail?" reflex

The three exercises above are sized for a strong intermediate engineer. If they feel impossible, the gap is usually not Go. It is missing systems vocabulary. Work through the ramp below before tackling them.

**Ramp exercise A (prerequisite for Exercise 1).** Load 10 million rows of synthetic event data into a single Postgres table and write three dashboard queries: hourly revenue, 7-day retention, and funnel conversion. Measure the latency with `EXPLAIN ANALYZE`. Add a BRIN index on time and a composite btree on `(user_id, event_type, time)`. Re-measure. Add a materialized view that pre-aggregates hourly revenue, refresh it, and compare. Only once you have felt Postgres slow down at scale will the motivation for ClickHouse in Exercise 1 be obvious. Write up the "why did this fail?" notes: the funnel query scans the whole table twice because the planner cannot push the per-user window through a hash aggregate, so no index saves it.

**Ramp exercise B (prerequisite for Exercise 2).** Before touching TimescaleDB, emulate hypertables with plain Postgres partitions by day. Load 1M rows of fake GPS data, then try to run "average speed by hour for the last 24 hours". Watch the planner prune partitions (or fail to). Then install TimescaleDB, convert the table to a hypertable, and re-run. Write a one-page reflection on what Timescale automated. This is the FAANG reflex: know exactly which problem each extension solves, not just that it is "the time-series one".

**Ramp exercise C (prerequisite for Exercise 3).** Model a 1000-user, 10K-relationship social graph in *both* Postgres (two tables: `users`, `follows`) and Neo4j. Write the "friends-of-friends who bought product X" query in both. Measure latency at depth 2 and depth 4. At depth 4 the Postgres query will be three orders of magnitude slower or will OOM. That felt experience is what the interviewer is testing when they ask "when would you pick a graph database?"

**Worked example: Exercise 1 first pass, junior-grade.**

```go
// batch writer pattern - the minimum viable ClickHouse ingester
type BatchWriter struct {
    conn   driver.Conn
    buffer []Event
    mu     sync.Mutex
    flush  time.Duration
}

func (w *BatchWriter) Write(ctx context.Context, e Event) error {
    w.mu.Lock()
    w.buffer = append(w.buffer, e)
    shouldFlush := len(w.buffer) >= 10000
    w.mu.Unlock()
    if shouldFlush {
        return w.Flush(ctx)
    }
    return nil
}
```

That code passes a junior interview. It fails a senior interview because: no backpressure when ClickHouse is slow, no retry with idempotency key, no dead-letter queue, no metrics on buffer depth, no graceful shutdown that flushes on SIGTERM, and no bound on memory. The FAANG reflex is to write the junior version, then immediately list the five things wrong with it. Interviewers love the self-critique.

**The "why did this fail?" drill for exercises.** For each exercise, write a paragraph on the top three production incidents it could cause. Exercise 1: the Kafka consumer lagged for an hour, the batch writer buffered everything into OOM, the dashboard went blank. Exercise 2: a vehicle with a broken GPS spammed 1000 events/s, the continuous aggregate thrashed, the whole cluster slowed. Exercise 3: an influencer with 10M followers triggered a 3-hop traversal that touched a third of the graph, Neo4j locked up for 30 seconds. Interviewers ask these as the follow-up. Have the answer ready.

### Senior @ FAANG: Staff extensions, bar-raiser rubrics, and platform-scale exercises

The exercises below are staff-grade extensions. They are scored not on whether the code runs, but on the ADRs produced, the operational runbooks, and the cost model.

**Staff Extension 1: Build a polyglot migration framework.** Take a running Postgres-only application (pick any CRUD service with 50M rows and 20 tables) and design a framework that migrates selected tables into ClickHouse, Neo4j, and Elasticsearch simultaneously, driven by a single CDC stream, with zero downtime and a rollback path. Deliverables: (a) an architecture doc that selects Debezium vs pgoutput vs a custom WAL reader with trade-offs, (b) a schema mapping DSL that declares how each Postgres table projects into each target, (c) a backfill orchestrator that handles the "historical snapshot + live tail" handoff without duplicates or gaps, (d) a verification job that samples rows and compares across stores, (e) a runbook for the three most likely failure modes (Kafka lag, target store back-pressure, schema drift). Bar-raiser rubric: candidates who ship working code but no operational story score L5. Candidates who produce the ADR, the rollback plan, and the cost envelope score L6.

**Staff Extension 2: Design a ClickHouse sharding strategy for 100 tenants.** The tenants range from 100 MB to 50 TB. Some have spiky traffic, some are steady. Regulatory constraints require EU tenants on EU infrastructure. Deliverables: a tenancy model (shared tables with `tenant_id` in sort key vs database-per-tenant vs cluster-per-tier), a sharding key that balances data volume and query locality (hash of tenant_id vs consistent hash vs composite), a resharding plan for when a tenant outgrows its shard, a quota enforcement design (per-tenant `max_memory_usage`, `max_execution_time`, row-scan quotas), and a cost attribution model. Discuss when you would split a noisy-neighbor tenant onto a dedicated cluster, and how you would move them without downtime. Bar-raiser rubric: the correct answer is "it depends", expressed as a decision tree with named thresholds, not a single chosen design.

**Staff Extension 3: Implement a real-time CDC fan-out from Postgres to ClickHouse, Neo4j, and Elasticsearch.** Source: Postgres at 10K writes/s. Targets must all be fresh within 5 seconds p99. Deliverables: (a) a Kafka topic layout (one topic per table vs one topic per aggregate vs Debezium default), (b) an idempotency design so each target can safely replay (outbox pattern, dedup keys, target-side upsert semantics), (c) a schema registry integration with Avro or Protobuf and a breaking-change policy, (d) a fan-out service in Go that transforms and writes to all three targets with independent retry and back-pressure, (e) a lineage emitter so OpenLineage or DataHub sees every hop, (f) chaos tests that kill one target mid-flight and verify the other two continue. The rubric measures whether the candidate treats each target as an isolated bulkhead (one target down does not stall the others) and whether they propose a replay mechanism from Kafka when a target is restored.

**Staff Extension 4: InfluxDB v1 to v3 migration.** Given 400 services writing line protocol to a v1 cluster at 2M points/s, design a migration to v3 with no downtime, no data loss, and a two-week verification window where both clusters run in parallel. Deliverables: a dual-write proxy, a historical backfill plan from v1 TSM files to v3 Parquet on S3, a query-compatibility shim (Flux to SQL translation), a cutover runbook with named rollback triggers, and a communications plan for service owners. Rubric: does the candidate know that high-cardinality series will behave *differently* on v3 (which is why they want to migrate), and do they design a canary that exercises those cases before cutover?

**Staff Extension 5: Graph vs relational for identity resolution at 1B users.** Requirement: given any two signals (email, phone, device ID, cookie), return the canonical user within 50ms p99, with 99.99% availability, full audit trail, and GDPR right-to-erasure. Deliverables: (a) a data model (property graph with `:CANONICAL` nodes and `:ALIAS` edges, vs a relational union-find, vs a vector store for approximate matches), (b) a write path that merges identities atomically, (c) an erasure path that tombstones without orphaning the graph, (d) a capacity model, (e) a disaster-recovery plan. The rubric checks whether the candidate understands that graph stores are weak on point-in-time queries (audit) and designs a hybrid: property graph for the hot path, append-only event log for audit and erasure.

**Staff Extension 6: Cost optimization for ClickHouse at 10 PB.** Take a 10 PB, $18M/year cluster and cut cost by 40% without violating p99 SLOs. Deliverables: a written lever list in priority order (tiered storage, TTL and downsampling, codec tuning, projection cleanup, quota enforcement, multi-tenant consolidation, reserved capacity), a measurement plan (which queries to benchmark, how to attribute cost per dataset), and an organizational plan (who signs off on each lever, how to communicate SLO risk to dataset owners). Rubric: candidates who produce a spreadsheet with named percentages and a rollout schedule score higher than candidates who list techniques without sequencing.

**Grading rubric, general.** For every staff exercise, a bar-raiser scores on four axes: (1) Correctness, does the design actually solve the problem. (2) Operational maturity, is there a runbook, an SLO, a rollback. (3) Cost and governance, is there a dollar number and an owner. (4) Organizational fit, does the design name the teams, the review gates, and the deprecation path. A design that is technically brilliant but has no owner named is L5 at best. Designs that name owners, SLOs, costs, and sunset plans are L6+.

---
