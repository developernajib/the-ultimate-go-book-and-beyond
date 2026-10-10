## 37H.7 Common Mistakes

### 1. Using Graph DB for Non-Graph Problems

Neo4j's pointer-chase traversal pays off only when queries cross two or more relationship hops. A simple single-node lookup by ID has more overhead than a Redis `GET` or PostgreSQL primary key scan. Graph databases are the right choice when the relationships themselves carry semantics (fraud rings, social influence graphs, dependency trees), not when the queries are point lookups wearing a Cypher costume.

```
BAD: using Neo4j for a simple user profile lookup
Query: "Get user profile for id=123"
Graph traversal: MATCH (u:User {id: '123'}) RETURN u
→ Same as a key-value lookup, but with graph overhead

Graph DBs shine for: multi-hop traversals, pathfinding,
relationship-heavy queries. For simple lookups, use Redis/PostgreSQL.

GOOD use cases for graph:
✓ "Friends of friends who bought product X" (2+ hop)
✓ "Shortest career path from junior dev to CTO"
✓ "Fraud ring detection" (shared attributes across users)
✓ "Product dependency graph" (which libraries depend on this?)
```

### 2. ClickHouse Column Type Mistakes

ClickHouse stores each column's values contiguously, so the data type directly affects storage size, compression ratio, and query speed. Using plain `String` for a column with only a few hundred distinct values (countries, event types, status codes) wastes space because each row stores the full string. `LowCardinality(String)` applies dictionary encoding instead (storing an integer index per row and a single copy of each distinct value), which cuts storage by 5-10x and speeds up `GROUP BY` on those columns.

```sql
-- BAD: using String for low-cardinality columns
CREATE TABLE events (
    country String,    -- 200 countries, stored as full strings
    event_type String  -- 50 types, stored repeatedly
);
-- Each "US" stored as 2 bytes + length prefix = ~5 bytes per row
-- 1 billion rows × 5 bytes = 5GB for country alone

-- GOOD: use LowCardinality for < 10,000 distinct values
CREATE TABLE events (
    country    LowCardinality(String),  -- dictionary encoding: ~1-2 bytes
    event_type LowCardinality(String)   -- 10x storage reduction
);
-- Plus: better compression, faster GROUP BY on LowCardinality columns
```

### 3. TimescaleDB Without Proper Indexing

TimescaleDB partitions hypertables into time-ordered chunks. A query without a time filter must scan every chunk from the beginning of time, defeating the entire purpose of the time-series schema. Including a `time >= NOW() - INTERVAL '7 days'` bound lets TimescaleDB prune all older chunks and read only the seven relevant daily chunks.

```sql
-- BAD: querying without time-based filter (no chunk pruning)
SELECT avg(value) FROM metrics WHERE device_id = 'sensor-1';
-- Scans ALL chunks across ALL time → full table scan

-- GOOD: always include time bounds to enable chunk pruning
SELECT avg(value) FROM metrics
WHERE device_id = 'sensor-1'
  AND time >= NOW() - INTERVAL '7 days'; -- TimescaleDB skips old chunks
-- Only scans the 7 relevant daily chunks, not all 365
```

### 4. Neo4j Cartesian Products

A `MATCH` clause with two disconnected patterns like `(u:User), (p:Product)` produces the cross product of every User node with every Product node. With 1 million users and 10,000 products, that is 10 billion rows before any filtering happens. Always connect patterns through relationships so Neo4j traverses actual edges instead of materializing a full Cartesian product.

```cypher
-- BAD: MATCH without WHERE can create cartesian products
MATCH (u:User), (p:Product)
WHERE u.country = 'US' AND p.category = 'electronics'
RETURN u, p
-- If 1M US users and 10K electronics → 10 billion combinations!

-- GOOD: traverse relationships
MATCH (u:User {country: 'US'})-[:PURCHASED]->(p:Product {category: 'electronics'})
RETURN u, p
-- Only matches actual purchase relationships
```

### 5. ClickHouse Substring Search Without Indexes

ClickHouse has no built-in inverted index for arbitrary substring matching. A `LIKE '%laptop%'` query scans the entire column, decompressing and testing every value. For exact-match filters, a bloom filter index (`tokenbf_v1`) works well. For substring or contains searches, the `ngrambf_v1` index splits values into trigrams and builds a bloom filter over them, allowing ClickHouse to skip granules that definitely do not contain the search term. For full-text search with ranking and fuzzy matching, offload to Elasticsearch instead.

```sql
-- BAD: using LIKE with leading wildcard
SELECT * FROM products WHERE name LIKE '%laptop%';
-- Full column scan, no index usage

-- GOOD: use full-text search (trigram index or external search)
-- Or: use bloom filter for exact value checks
-- For contains search: use Elasticsearch or ClickHouse's ngrambf_v1 index:
CREATE TABLE products (
    name String,
    INDEX name_bloom name TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 1
) ENGINE = MergeTree() ORDER BY name;
SELECT * FROM products WHERE name LIKE '%laptop%';
-- ngrambf_v1 provides bloom filter on trigrams for faster LIKE queries
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

Each of these mistakes has a diagnostic pattern you should learn to recognize in review. For the graph-for-non-graph mistake, the tell is a Cypher query with zero or one relationship arrow. If the pattern is `MATCH (n:Label {id: ...}) RETURN n` you are paying graph tax for a key-value lookup. Move it to Redis or Postgres and reserve Neo4j for queries with two or more hops. For the ClickHouse column-type mistake, inspect `system.columns` for any `String` column where `SELECT uniqExact(col) FROM table` is under ten thousand. Those are candidates for `LowCardinality(String)`. The rewrite cost is one `ALTER TABLE MODIFY COLUMN` and the storage savings are typically 5 to 10x. For the TimescaleDB mistake, run `EXPLAIN ANALYZE` on any query against a hypertable and confirm that "Chunks excluded" is non-zero. If every chunk is scanned, you are missing a time bound. For the Neo4j Cartesian mistake, `PROFILE` the query and look for `CartesianProduct` in the plan. If you see it, add a relationship between the patterns or split into two separate queries.

Worked example of the unbounded time-series cardinality problem, which the chapter hints at but is worth making concrete. A team decides to store Kubernetes pod metrics in TimescaleDB with labels as columns: `pod_name`, `namespace`, `node`, `container`, `trace_id`, `request_id`. Every unique combination creates a distinct series. In a cluster with 10k pods rotating daily, plus `request_id` as a label, you get millions of new series per hour. Every chunk now has millions of tuples, compression degrades (values within a segment are no longer similar), query planner times balloon because it tries to prune across millions of series keys, and you end up with a multi-TB hypertable that was supposed to be a few hundred GB. The fix is to **never put unbounded-cardinality fields as series-identifying labels.** `trace_id` and `request_id` belong in a logs table, not a metrics table. Label cardinality in a metrics table should be in the low thousands, total, not per day. This exact mistake crashes observability pipelines at every company that grows past a few hundred services. Prometheus, Mimir, VictoriaMetrics, and InfluxDB all have the same failure mode.

Interview entry-points. What is high cardinality and why does it kill time-series databases. (Each distinct label combination is a separate series, and storage structures are sized per series.) What is a bloom filter and when do you use one in ClickHouse. (Probabilistic set membership for skipping granules during point lookups.) Why is a Cartesian product in Cypher catastrophic. (It materializes the cross product of two node sets before filtering, and node sets are typically millions of rows.) When should you not use a graph database. (When queries are single-node lookups, when the data is flat and tabular, when relationship semantics do not drive the query, when write rates exceed a few tens of thousands per second on a single cluster.)

First-job context. The first time you are on-call for a system using any of these engines, you will debug at least one of these mistakes. Memorize the diagnostic commands: `EXPLAIN` and `PROFILE` in Cypher, `EXPLAIN (ANALYZE, BUFFERS)` in Postgres/TimescaleDB, `EXPLAIN indexes=1` in ClickHouse, `SHOW TABLE STATUS` and `system.parts` inspection for ClickHouse bloat. When a senior engineer asks "did you check the plan," they mean this. Running a query and observing it is slow is not a diagnosis. Reading the plan and identifying the offending operator is.

### Senior @ FAANG: Deeper Failure Modes and Production Governance

At staff level your job is not just to avoid these mistakes yourself but to build guardrails so your organization does not repeat them. Each of the five mistakes in this chapter has a systemic prevention story, and I will walk through each.

**Wrong engine for workload** is the most expensive mistake because it is discovered only after building on the wrong foundation. Prevention is an **architecture review checkpoint** before any new database is introduced. The review template: state the access pattern (QPS, latency SLO, read/write ratio, query complexity), the data shape (size, cardinality, mutation rate), the consistency requirement (strict, causal, eventual, none), the operational budget (team size, on-call rotation), and the exit strategy (how you migrate off if this choice fails). Any new engine request without all five answers is sent back. The review is performed by a platform team with data-engineering depth, not rubber-stamped by the requesting team. At FAANG scale the ADR is checked into the code repository and referenced in the service's runbook. Five years later when someone asks "why ClickHouse and not Druid," the answer is one commit away.

**Unbounded time-series cardinality** is the single most common observability outage cause across the industry. The systemic prevention is a **label governance policy** enforced at the ingestion layer. In Prometheus-world this means relabeling rules that drop high-cardinality labels at scrape time, alerts on `scrape_series_added` and `prometheus_tsdb_symbol_table_size_bytes` growth rate, and a hard cap on series per tenant. In VictoriaMetrics this means the `-maxLabelValueLen` and `-maxLabelsPerTimeseries` flags, plus `vm_rows_ignored_total{reason=...}` monitoring. In Mimir and Cortex this means per-tenant limits configured in the overrides file. In TimescaleDB, the equivalent is schema review before any new metric table is created, plus monitoring chunk count and average chunk size as red flags (10k+ chunks or sub-MB chunks both indicate trouble). The cultural piece is harder: teach every engineer who ships a metric that **label cardinality is a shared resource.** A `user_id` label in a metrics pipeline is almost always a mistake. Emit a log or trace instead.

**Graph for non-graph workload** often sneaks in through the side door. A team builds a knowledge graph for one use case (entity resolution, say), then someone decides to also serve user profiles from it because "we already have Neo4j and it has User nodes." Six months later the graph is doing 80% point lookups and the graph-specific queries are starved for resources. Prevention: **access-pattern isolation.** Graph databases should host queries that do at least two-hop traversal in their predominant access pattern, and point lookups should be served from a key-value store even if that means duplicating user records. Measure the ratio of (multi-hop queries) to (total queries) on your graph database. If it drops below 50%, you are using a graph for the wrong thing. Another tell is peak RPS: Neo4j tops out around 10k writes/sec per cluster and 50k reads/sec per read replica. If your workload wants 200k RPS, you either need a different engine or you need to move point lookups out.

**Polyglot sprawl** is the meta-mistake that contains all the others. A mature data platform has three to six engines: an OLTP database (Postgres or Spanner), a cache (Redis or Memcached), an analytical store (ClickHouse or BigQuery or Snowflake), a search index (Elasticsearch or OpenSearch), optionally a graph (Neo4j or Neptune), optionally a time-series (TimescaleDB or Prometheus). More than six engines signals sprawl. The governance pattern is a **centralized data platform team** that owns the short list, runs the shared clusters, and says "no" to new engines unless the requesting team can show that none of the existing engines solve the problem within 20% of optimal. The team that maintains this discipline avoids the fate of having 15 databases in production and nobody on call for half of them. The hardest conversation a staff engineer has is telling a team they cannot have the database they want, and justifying it with operational-cost numbers rather than preference. Have that conversation anyway.

**Write-amplification in graph databases** is the mistake not covered in the chapter but worth knowing. Neo4j's doubly-linked relationship lists mean that adding a relationship to a supernode rewrites the supernode's relationship chain. If the supernode has a million relationships, this is a million-record rewrite per new edge. At write rates above a few hundred edges per second touching supernodes, you will see latency spikes and page-cache thrash. Mitigations: **bucket node pattern** (interpose intermediate nodes so no single node has more than ~10k relationships), **relationship indexing** in Neo4j 5.x for filtering supernode traversals by relationship property, and **avoid supernodes by design** (model "user follows topic" where topic has millions of followers by inverting to "topic hasFollower user" and filtering, or by using a separate index).

**ClickHouse mutation anti-patterns.** Beyond the type mistakes, a common production failure is heavy use of `ALTER TABLE UPDATE` and `ALTER TABLE DELETE` on large MergeTree tables. These are mutations that rewrite entire parts asynchronously, and under sustained mutation load the merge queue saturates, `system.mutations` accumulates, and the table becomes unusable. ClickHouse is designed for append-only workloads. If you need updates, use `ReplacingMergeTree` with version columns, `CollapsingMergeTree` for cancellation semantics, or `AggregatingMergeTree` for streaming aggregation. If you need deletes for GDPR compliance, use `lightweight_delete` (Clickhouse 22.8+ with `_row_exists` column) with caution, or plan tombstone cycles through partition management. The architectural lesson: **design your schema around the engine's mutation model, not around the relational UPDATE/DELETE model.**

**TimescaleDB chunk-sizing mistakes.** The default chunk interval is 7 days, which is wrong for most workloads. High-write workloads (1M+ rows per day) want 1-day chunks so that compression and retention operate on manageable units. Low-write workloads (under 100k rows per day) want monthly chunks to avoid tiny-chunk overhead. Getting this wrong either blows up chunk count (too small) or produces multi-GB chunks that compression and query planning stumble on (too large). Compute target chunk size as roughly 25% of the RAM you are willing to spend on one chunk's working set during compression. For a node with 32 GB RAM reserved for TimescaleDB, chunks should be around 8 GB compressed, which is maybe 80 GB uncompressed, which at 1000 bytes per row is 80 million rows per chunk. Tune `chunk_time_interval` so that one chunk holds roughly that many rows at your write rate.

**Neo4j sharding misconceptions.** Neo4j's Fabric feature federates multiple databases under one Cypher endpoint, but it is not a transparent sharding solution. Cross-shard queries require explicit `USE` clauses and cannot do arbitrary pattern matching across shards efficiently. The canonical Fabric use case is **tenant isolation** (one shard per customer, never join across) or **weak-connectivity sharding** (shard by community detected offline, queries mostly stay within a shard). If your graph has no natural partition with low cross-edges, Neo4j does not shard well and you should consider TigerGraph, NebulaGraph, or a rethink of whether the workload needs to be on one engine at all. Do not design a multi-shard Neo4j architecture without first proving that the workload has a low cross-shard query rate (under 5% of queries).

**Observability for the engines themselves.** Every engine in this chapter needs first-class monitoring. For Neo4j: page cache hit ratio (>99%), bolt connection pool usage, transaction log rotation rate, GC pauses (JVM-based, so this matters), and GDS memory headroom. For ClickHouse: parts per partition (should be under 300 or merges are behind), pending mutations, zookeeper/keeper queue depth, query complexity percentiles. For TimescaleDB: chunk count, compression backlog, continuous aggregate refresh lag, WAL generation rate. For Druid and Pinot: segment load time, query broker latency, real-time ingestion lag. Build these dashboards the day you put the engine in production, not the day it breaks.

**The meta-rule for staff engineers**: the cost of a database mistake scales with how long the mistake lives undetected. Graph-for-non-graph caught in week 1 is a day of refactoring. Caught in year 3 is a multi-quarter migration. High-cardinality in observability caught in staging is an alert tuning. Caught in production is a page at 3 am when the metrics system is itself down. The preventive controls in this section are not bureaucratic overhead, they are the amortized cost of not paying the discovered-in-production bill. Your job is to set up the controls so junior engineers cannot make these mistakes without someone noticing, and so senior engineers have to justify exceptions in writing.

---
