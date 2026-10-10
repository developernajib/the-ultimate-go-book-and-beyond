## 37H.8 Interview Questions & Answers

**Q1: When would you use ClickHouse instead of PostgreSQL for analytics?**

A: Use ClickHouse when: (1) queries scan billions of rows with aggregations (GROUP BY, SUM, COUNT) - columnar storage reads only the needed columns, not full rows. (2) you need sub-second response for dashboards on large datasets. (3) data is append-mostly with occasional bulk updates (ReplacingMergeTree for deduplication). (4) compression efficiency matters, ClickHouse typically achieves 5-15x compression on analytical data. Use PostgreSQL when data volumes are manageable (under roughly 100M rows per table), you need frequent point updates, or you want OLTP + light OLAP in one system (or reach for TimescaleDB, which adds time-series on PostgreSQL).

**What FAANG expects:** A clear articulation of OLTP vs OLAP workload characteristics (row vs columnar layout, point updates vs bulk scans, ACID vs eventual-consistent downstream projections), a pragmatic threshold rather than a dogmatic "always use X", and awareness that you usually *keep* PostgreSQL as the source of truth and *add* ClickHouse via CDC for analytics - not replace it.

Follow-ups:
- How would you keep ClickHouse in sync with PostgreSQL without dual writes? (Debezium -> Kafka -> ClickHouse Kafka engine, or transactional outbox.)
- What if you need mutable rows in ClickHouse? (`ReplacingMergeTree` with a version column and `FINAL`, or `CollapsingMergeTree` with sign column, or lightweight updates/deletes on a recent-only table.)
- How do you bound ClickHouse query cost per tenant? (`max_memory_usage`, `max_execution_time`, quotas per user.)

**Q2: How does ClickHouse's MergeTree engine achieve fast queries?**

A: Several mechanisms compound: (1) **columnar storage** reads only the columns the query references. (2) a **sparse primary index** stores one entry per granule (8192 rows by default), so the index fits in memory and binary search skips irrelevant granules. (3) **partition pruning** skips entire partitions by partition key. (4) **vectorised execution** uses SIMD to process whole column chunks per instruction. (5) **block-level compression** (LZ4 / ZSTD) shrinks I/O since adjacent similar values compress well (run-length, delta, delta-of-delta). (6) **parallel execution** distributes work across CPU cores and shards. On top of that, **projections** and **materialized views** let you pre-aggregate hot query shapes so dashboards never touch raw rows.

**What FAANG expects:** Knowing the difference between the sorting key (physical order on disk) and the primary key (sparse index entries) - in ClickHouse they default to the same but can diverge. Being able to explain *why* granule-level skipping plus column pruning is what makes aggregates sub-second, not "because it's fast".

Follow-ups:
- Why is `index_granularity = 8192` the default, and when would you change it? (Smaller = more index entries, finer skipping, more memory. Larger = less index, coarser skipping.)
- Projection vs materialized view - when would you choose each? (Projection = owned by the table, auto-consistent, hidden from writer. MV = separate table, can target a different engine like `AggregatingMergeTree`, composable.)
- What happens if your `ORDER BY` key does not match your query predicates? (Full column scan, partition pruning still helps, but granule skipping does not.)

**Q3: What is a continuous aggregate in TimescaleDB?**

A: A continuous aggregate is an incrementally maintained materialized view over a hypertable. Unlike vanilla PostgreSQL materialized views (which require a full `REFRESH` that rescans everything), continuous aggregates track which time buckets have changed and recompute only those buckets. Queries against the aggregate read pre-computed rows rather than scanning raw data, and the `add_continuous_aggregate_policy` function schedules a background refresher with configurable `start_offset` / `end_offset` / `schedule_interval`. Use them for hourly/daily averages, rolling windows, and downsampled series for long-range charts.

**What FAANG expects:** Understanding *why* the `end_offset` exists (you do not want to refresh the newest bucket on every tick - let late-arriving events settle first), and recognizing that continuous aggregates are themselves hypertables (so they can be compressed, indexed, and queried with `time_bucket_gapfill`).

Follow-ups:
- How would you chain continuous aggregates - an hourly rollup feeding a daily rollup? (Yes, Timescale supports hierarchical CAs since 2.10. daily reads from hourly instead of raw.)
- What is `real-time aggregation` in TimescaleDB? (When enabled, queries union pre-materialized buckets with a live aggregate over the tail, trading a little latency for freshness.)
- How do you handle backfills that rewrite an old bucket? (Invalidation log - Timescale detects the raw change and re-materializes that bucket on the next refresh.)

**Q4: How does Neo4j's Cypher query language differ from SQL?**

A: Cypher uses **ASCII-art pattern matching** - `(n:Node)-[:REL]->(m:Node)` - where SQL uses `JOIN ... ON`. Concrete differences: (1) Cypher traverses relationships as pointer chases, so it does not need to explicitly name join keys. (2) variable-length paths like `[:FOLLOWS*1..6]` are a first-class construct but require recursive CTEs in SQL. (3) `shortestPath()` and `allShortestPaths()` are built-in. (4) `MERGE` provides idempotent upsert semantics. (5) because Neo4j stores related nodes adjacently on disk, the physical layout is optimized for the logical traversal - something relational adjacency tables cannot replicate.

**What FAANG expects:** The ability to point at *why* graph traversals beat SQL joins at depth - each SQL join multiplies intermediate cardinality and re-scans an index, whereas a graph pointer-chase is O(neighbors) per hop. Plus awareness that the advantage only materializes at 2+ hops. For 1-hop lookups, a well-indexed relational table is often faster.

Follow-ups:
- When would you *not* pick a graph database? (Aggregates over billions of flat rows, pure key-value lookups, strong cross-entity transactional constraints.)
- How would you model a recommendation system using Cypher? (Users purchase products, walk 2 hops via `:FOLLOWS` or shared purchases, exclude already-purchased.)
- What is the property graph model vs RDF triples? (Property graph = labeled nodes and edges with arbitrary key-value props. RDF = subject-predicate-object triples. Neo4j is property graph. Jena/Blazegraph are RDF.)

**Q5: What is the N+1 query problem in graph databases?**

A: The same pathology as relational ORMs, but in a graph: instead of one traversal that walks the needed neighborhood, the caller issues one query per node. In Neo4j this often comes from application code that reads a node, then loops over its relationships issuing a fresh `tx.Run` per neighbor. The fix is a single Cypher query that expresses the full pattern - `MATCH (u:User {id: $id})-[:FRIENDS_WITH]->(f:User)-[:PURCHASED]->(p:Product) RETURN u, collect(DISTINCT p)` - so one round-trip does the whole thing. For very deep traversals, use `WITH` to pipe intermediate results and `COLLECT` to aggregate.

**What FAANG expects:** Recognizing N+1 as a general anti-pattern (not Neo4j-specific), and proposing tooling-level fixes - trace middleware that counts `tx.Run` calls per request, query plan inspection with `EXPLAIN` / `PROFILE` in Cypher, or a repository layer that forces traversals into single queries.

Follow-ups:
- How do you detect N+1 in production? (Tracing spans per request, alert on request-to-db-call ratio, sampled `PROFILE` runs.)
- What is the Cypher equivalent of SQL `EXPLAIN ANALYZE`? (`PROFILE <query>` shows per-operator rows and DB hits.)
- When is it actually fine to issue many small queries? (When they are independent and parallelisable with bounded fan-out - but even then, one `UNWIND $ids` query is usually better.)

**Q6: How would you design a real-time leaderboard using a time-series database?**

A: Two-tier: Redis Sorted Sets for the hot ranking surface (O(log n) updates, O(range) top-K reads under 1ms), TimescaleDB for the historical raw events. Architecture: (1) game events write to TimescaleDB as raw rows with timestamp + player + score-delta. (2) a continuous aggregate computes per-period scores (hourly/daily/weekly). (3) on period rollover, batch-copy the current-period scores into the corresponding Redis Sorted Set. (4) the application reads live rankings from Redis and historical rankings from TimescaleDB. (5) `time_bucket_gapfill` handles periods with no activity so charts do not have missing buckets. If scale demands it, partition Redis Sorted Sets by shard (e.g., region) and merge on read.

**What FAANG expects:** Separating the *access pattern* of "top 100 right now" (Redis) from the *access pattern* of "my rank across the all-time leaderboard" (requires a persistent indexed store), and understanding why a single data store rarely serves both well. Also, a story for consistency - what happens if Redis is flushed (rebuild from TimescaleDB)?

Follow-ups:
- How do you handle ties at the same score? (Secondary key - encode `score << 32 | -timestamp` so earlier players break ties consistently.)
- What if a player cheats and you need to retroactively remove points? (Write a compensating event, re-materialize the affected buckets, rebuild the Redis slice.)
- How would you shard once the leaderboard exceeds a single Redis node? (By league / region, or by score range with hot-range rebalancing.)

**Q7: What is ClickHouse's ReplicatedMergeTree and when do you need it?**

A: `ReplicatedMergeTree` synchronizes replicas of a shard using ZooKeeper or - preferably, since ClickHouse Keeper reached production quality - ClickHouse Keeper (a Raft-based coordinator maintained in-tree). Multiple replicas hold identical parts. inserts are deduplicated across replicas using an insert log, DDL propagates via distributed DDL, and a failed primary is replaced transparently. You need it for any production deployment where data loss or downtime on a single node is unacceptable. Pair with a `Distributed` table on top of multiple shards for horizontal scale-out. In development or single-node setups, plain `MergeTree` is fine.

**What FAANG expects:** Understanding that `Distributed` (routes queries to shards) and `ReplicatedMergeTree` (replicates a single shard) solve orthogonal problems, and that you usually need both. Also recognizing that ClickHouse Keeper has largely replaced ZooKeeper for new deployments.

Follow-ups:
- How does insert deduplication work in `ReplicatedMergeTree`? (Each insert block gets a hash recorded in the log. Duplicate hashes within the retention window are ignored.)
- What is the failure mode when Keeper/ZooKeeper is unavailable? (Writes block or fail. Reads continue. Replicas cannot fetch missing parts.)
- How do you add a new replica to an existing shard without downtime? (`CREATE TABLE ... ENGINE = ReplicatedMergeTree(...)` pointing at the same Keeper path. The new node fetches parts from peers.)

**Q8: How does InfluxDB's IOx differ from InfluxDB 1.x / 2.x?**

A: InfluxDB 3 (IOx) is a complete rewrite in Rust built on the **FDAP stack** - Apache Flight, Arrow DataFusion, Arrow, and Parquet - replacing the Go + TSM engine used in 1.x and 2.x. Concrete differences: (1) **SQL is now first-class** (InfluxQL still supported, Flux is being de-emphasized). (2) **data lives in Parquet files on object storage** (S3/GCS/Azure or local), separating compute from storage. (3) **Apache Arrow in-memory columnar format** drives vectorised execution and lets Flight SQL return Arrow record batches to clients. (4) **unlimited tag cardinality** - the old TSM engine collapsed under high-cardinality tags, IOx does not. (5) **better compression** from Parquet than from TSM. Three editions ship: Core (OSS, single-node), Enterprise (HA, multi-node), and Cloud Serverless.

**What FAANG expects:** Ability to explain the FDAP acronym and why it matters (it is becoming the de facto open analytics stack - Influx, Arroyo, DataFusion-based query engines, Iceberg readers), and to discuss trade-offs like object-storage latency vs local-disk throughput.

Follow-ups:
- What happens to old Flux scripts on v3? (Run in a compatibility shim or be rewritten to SQL. Flux is not the strategic direction.)
- How does v3 handle writes at the storage layer? (Line protocol -> in-memory Arrow buffers -> periodic flush to Parquet files on object storage, with a WAL for durability.)
- When would you still pick TimescaleDB over InfluxDB v3? (When you need full SQL joins with relational metadata, transactional writes alongside time-series, or the PostgreSQL ecosystem - extensions, tooling, ORMs.)

### Junior → FAANG: Prerequisite gaps, worked examples, and the "why did this fail?" reflex

If these questions felt like a firehose, the gap is rarely Go syntax. It is prerequisite data-systems literacy. Before your first analytics interview, you need five reflexes.

**Reflex 1: Identify the workload in the first sentence.** Interviewers phrase prompts ambiguously on purpose. "Build a product analytics dashboard" could be OLTP (users editing funnel definitions), OLAP (aggregating events), or streaming (live counters). The first clarifying question is always "point reads, bulk aggregates, or both, and at what freshness SLA?" If you cannot answer that, you cannot pick a database. Write this on an index card: *row store for point operations, column store for aggregates, time-series store for append-only temporal data, graph store for traversals of depth 2 or more, KV for sub-millisecond lookups by exact key*.

**Reflex 2: Know the failure modes, not just the happy paths.** Juniors memorize "ClickHouse is fast". Seniors can explain why ClickHouse is slow: a point lookup without partition or sort-key match degrades to a full scan, cardinality explosion in a `GROUP BY` blows the memory budget, and tiny inserts create part fragmentation that triggers background merges until the node thrashes. For every system covered in this chapter, write one paragraph on "how would a careless team kill this?" That paragraph is what bar-raisers probe for.

**Reflex 3: The "why did this fail?" drill.** Take each question in this chapter and invert it. "Why would a ClickHouse query that was fast yesterday be slow today?" Candidates: a new projection was dropped, the `ORDER BY` no longer matches a WHERE clause that changed, a background merge is running, a replica is rebuilding, partition pruning stopped helping because the time filter was widened, a join now pulls from a distributed table without `GLOBAL`. Interviewers love this question because it separates candidates who have only read blog posts from candidates who have on-called for a columnar store.

**Reflex 4: Capacity math on a napkin.** Before picking a system, estimate three numbers: events per second, bytes per event, and retention. 100K events/s at 500 bytes is 50 MB/s or 4 TB/day raw. At 10x compression that is 400 GB/day in ClickHouse, or 146 TB/year. That tells you whether a single node is viable, whether you need tiered storage, and whether the cost envelope forces object storage. Practise this on every system design question.

**Reflex 5: The first-job version of polyglot persistence.** You will not design a 100M events/s pipeline on day one. Your first job is more likely "we have Postgres, marketing wants a dashboard that is slow, fix it". The junior-grade solution ladder is: (1) add an index, (2) add a materialized view, (3) add read replicas, (4) add a columnar extension like Citus or Hydra, (5) introduce a real columnar store with CDC. Starting at step 5 when the problem is step 1 is how juniors fail interviews. Always climb the ladder out loud.

Worked example, junior entry-point. Question: "Our Postgres `events` table has 2B rows and dashboards time out." Junior answer that passes: "First I would run `EXPLAIN ANALYZE` on the slow query. If it is a sequential scan, I would check indexes on the filter columns and the `time` predicate. If aggregates still scan billions of rows, a BRIN index on time plus partitioning by month gets us the next order of magnitude. Past that, we are outgrowing row storage and should evaluate TimescaleDB (same Postgres, adds hypertables and columnar compression) before moving to ClickHouse. I would not jump to ClickHouse before measuring the incumbent."

That answer hits SOLID-adjacent principles (measure first, minimize blast radius, prefer the least-invasive fix), shows cost awareness, and leaves room for the interviewer to escalate. That is the junior-to-FAANG reflex in one paragraph.

### Senior @ FAANG: Interview signal ladders L3 to L7, bar-raiser prompts, and governance

At staff and principal level, the analytics interview stops being a trivia quiz and becomes an architecture conversation. Signals are scored on a ladder.

**L3 (SDE I / new grad).** Expected: name the right category of database for a workload, write a correct SQL aggregation, know that indexes help point reads. Disqualifier: cannot explain OLTP vs OLAP. Typical prompt: "query is slow, what do you check first?"

**L4 (SDE II).** Expected: articulate trade-offs between row and columnar storage, describe a materialized view pipeline, reason about cardinality and partitioning. Disqualifier: proposes "just cache it" for every latency problem. Typical prompt: "design an ingestion path from Kafka to a dashboard".

**L5 (Senior SDE).** Expected: owns a polyglot design end to end, including schema evolution, CDC, backfill strategy, and capacity math. Can explain why they picked ClickHouse over Druid over Pinot or TimescaleDB. Disqualifier: no operational story (no backups, no replica failover plan, no tenancy isolation). Typical prompt: *"Design the data platform for a 100M-events/s observability pipeline. Budget is $2M/year infrastructure."* Winning answer sketches edge collectors, Kafka or Kinesis with partition-key math, tiered storage (hot ClickHouse for 7 days, Iceberg/Parquet on S3 for 90 days, Glacier for a year), downsampling policies, quota enforcement per tenant, and a cost model with per-terabyte scan budget.

**L6 (Staff).** Expected: cross-system design with explicit ADRs, migration plans with rollback, organizational implications (who owns the schema registry, who approves new data sources). Disqualifier: hand-waves governance. Typical bar-raiser prompts: *"Pick a database for a fraud-detection graph at 10B edges and 1M queries/s, with sub-50ms p99 for 3-hop traversals"* (expected: Neo4j Fabric or Dgraph or a bespoke property graph on RocksDB, with explicit discussion of why a relational adjacency table fails at depth, and a fallback to approximate answers via graph embeddings in a vector store when the traversal budget is blown), or *"Design a real-time dashboard over 1 PB of clickstream with 2-second freshness and 10K concurrent viewers"* (expected: pre-aggregated projections, Kafka-to-ClickHouse with async materialized views, a serving tier that caches the top 100 dashboards in Redis, plus a degradation plan when ingest lag exceeds SLO).

**L7 (Principal).** Expected: a multi-year platform charter that explains what NOT to build, how to deprecate legacy stores, and how the data platform interacts with ML, privacy, and finance. Disqualifier: treats the problem as pure technology. Typical prompts: *"Design polyglot persistence for a $50B e-commerce business"* or *"Migrate from InfluxDB v1 to v3 across 400 services without downtime"* or *"Graph vs relational for identity resolution at 1B users, with GDPR right-to-erasure"*. Winning answers include a written data contract standard, a schema registry governance model, a lineage tool selection, a tiered SLO framework (gold/silver/bronze datasets), and an explicit sunset plan for each deprecated system.

**Cost bar-raiser.** *"Your ClickHouse cluster is 10 PB and $18M/year. Cut it by 40% without breaking SLOs."* Expected levers in priority order: (1) move cold partitions to S3-backed disks with `storage_policy`, (2) re-evaluate TTL and downsampling (do you really need raw per-event data after 30 days?), (3) switch codecs (DoubleDelta + ZSTD for monotonic series, Gorilla for float gauges), (4) kill unused projections and MVs (most clusters have 30%+ dead weight), (5) enforce per-tenant scan quotas so runaway dashboards stop warming cold parts, (6) consolidate small tables into multi-tenant tables with tenant_id in the sort key, (7) negotiate reserved-instance or committed-use pricing. Candidates who jump to "rewrite in Rust" fail this question.

**Common-mistakes governance.** Staff+ candidates must articulate the failure modes organizationally, not just technically. The top five: (1) letting every team pick its own database with no central review, (2) no schema registry, so breaking changes ship to production unnoticed, (3) no data contracts between producers and consumers, (4) backfills that rewrite history without invalidating downstream caches, (5) tenant isolation gaps where one noisy neighbor degrades the cluster. The governance answer is a data-platform charter with a paved road (one sanctioned OLTP, one sanctioned OLAP, one sanctioned time-series, one sanctioned graph, one sanctioned search), an exception process, and a central team that owns the schema registry and the lineage tool.

**Maturity model L1 to L5.** L1: one OLTP database, analytics runs on a read replica at 2am, no streaming. L2: a nightly ETL into a warehouse (Redshift/BigQuery/Snowflake), dashboards refresh daily. L3: CDC from OLTP into a columnar store, materialized views for hot dashboards, sub-hour freshness. L4: streaming-first pipeline (Kafka, Flink or ClickHouse async MVs), multiple specialized stores (time-series, graph, search) fed by one event bus, schema registry enforced at the producer. L5: polyglot platform with data contracts, central schema registry, column-level lineage, unified query layer (Trino/DataFusion) for federation, per-dataset SLOs, cost attribution per team, privacy tags enforced at query time. The interviewer is checking whether you know which level your current employer is at and what the next level costs.

**Polyglot charter, one page.** Mission: serve every internal analytical workload with the smallest set of sanctioned systems. Principles: source of truth is always OLTP, analytical stores are derived. One event bus. Schema changes go through a registry with automated compatibility checks. Every dataset has an owner, an SLO, and a lineage graph. No new database category without an ADR. Deprecation is budgeted, not wishful. Bar-raisers score candidates on whether they can write this charter in five minutes on a whiteboard.

---
