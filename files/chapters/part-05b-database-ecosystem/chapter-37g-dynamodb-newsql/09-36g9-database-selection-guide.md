## 37G.9 Database Selection Guide

### Decision Framework

Choosing the right database requires matching workload characteristics (access patterns, consistency needs, latency budget, and operational constraints) against each system's trade-offs. The matrix below maps each database to the scenarios where its strengths align with the requirements, and flags anti-patterns that indicate the wrong choice.

```
Database Selection Matrix
═══════════════════════════════════════════════════════════════════

  Use DynamoDB when:
  ✓ Single-digit millisecond latency required at any scale
  ✓ Operational simplicity (fully managed, no tuning)
  ✓ Predictable access patterns (key-value, entity-hierarchy)
  ✓ AWS ecosystem deeply integrated
  ✓ Serverless (on-demand scaling, Lambda-native)
  ✗ Complex relational queries or joins
  ✗ Ad-hoc reporting or analytics
  ✗ Full-text search

  Use CockroachDB when:
  ✓ PostgreSQL compatibility needed (migrate easily)
  ✓ Multi-region with geo-partitioning for data residency
  ✓ ACID transactions across distributed shards
  ✓ Self-hosted option with cloud version
  ✗ Extreme write throughput (Cassandra is faster)
  ✗ Column-family access patterns

  Use Google Spanner when:
  ✓ Global ACID transactions with external consistency
  ✓ Google Cloud ecosystem
  ✓ Petabyte-scale globally distributed data
  ✓ Financial/banking (TrueTime guarantees)
  ✗ Cost-sensitive (most expensive option)
  ✗ Non-GCP deployments

  Use TiDB when:
  ✓ MySQL compatibility (zero-code-change migration)
  ✓ HTAP: mixed OLTP + OLAP on same cluster
  ✓ Self-hosted on-prem or cloud
  ✓ Strong China/Asia support (PingCAP)

  Use YugabyteDB when:
  ✓ PostgreSQL + CQL dual compatibility
  ✓ Multi-cloud or on-prem deployment
  ✓ Open-source alternative to Spanner
  ✓ Kubernetes-native deployment

  Comparison:
  ┌───────────────┬──────────┬────────────┬──────────┬──────────┬──────────┐
  │ Feature       │ DynamoDB │ CockroachDB│  Spanner │   TiDB   │Yugabyte  │
  ├───────────────┼──────────┼────────────┼──────────┼──────────┼──────────┤
  │ SQL           │    ✗     │     ✓      │    ✓     │    ✓     │    ✓     │
  │ ACID Txn      │    ✓     │     ✓      │    ✓     │    ✓     │    ✓     │
  │ Auto-sharding │    ✓     │     ✓      │    ✓     │    ✓     │    ✓     │
  │ Multi-region  │    ✓     │     ✓      │ Global   │    ✓     │    ✓     │
  │ Managed       │ AWS only │ Cloud+DIY  │ GCP only │  TiDB   │    ✓      │
  │ Write perf    │  ★★★★★  │   ★★★★    │  ★★★    │  ★★★★   │  ★★★★        │
  │ Query flex    │   ★★     │  ★★★★★   │ ★★★★★   │ ★★★★★  │ ★★★★★         │
  └───────────────┴──────────┴────────────┴──────────┴──────────┴──────────┘
```

### Junior to FAANG: Database Selection Entry Point

The hardest part of database selection for a junior engineer is resisting the urge to pick the most impressive option. The default answer for a new service at most companies is Postgres (single-region) or DynamoDB (if you are deep in AWS and the access pattern is key-value). Everything else is a special case that needs justification. Starting from that default and earning your way into a more complex choice is the discipline that gets you trusted with the decision.

Work through the shape of your workload before you look at the vendor list. Five questions answer 80 percent of selection problems.

1. What is the read-to-write ratio? Read-heavy workloads (10:1 or more) favor databases with strong caching, materialized views, or follower reads. Write-heavy favors append-friendly systems (Cassandra, DynamoDB, time-series DBs).
2. What is the access pattern? Point lookups by ID favor key-value. Range scans within a parent entity favor document stores or interleaved tables. Ad-hoc queries across joins favor SQL. Full-text search favors a search engine. Vector similarity favors a vector database.
3. What is the consistency requirement? Eventual consistency is cheapest. Single-region strong consistency is Postgres or MySQL. Cross-region strong consistency is Spanner or CockroachDB and costs accordingly.
4. What is the scale? Under 1 TB and under 10K QPS fits on a single managed Postgres or MySQL instance. Over that you need either vertical scaling (bigger instance), read replicas, or a distributed system.
5. What is the operational budget? A team without a dedicated database operator should default to fully managed services. A team with one can run self-hosted systems with better cost efficiency.

Worked example for a first-job context. You are asked to build an e-commerce backend. The product catalog is read-heavy with occasional writes, fits comfortably under 100 GB, and needs full-text search on product names. The order system is write-heavy, needs ACID across order plus inventory plus payment, and must handle spikes during flash sales. The user session system is ephemeral, latency-sensitive, and massive in volume.

The right answer is three databases, not one. Postgres (or Aurora) for the catalog with an OpenSearch index alongside for search. Postgres or CockroachDB for orders, depending on whether you need multi-region. Redis or DynamoDB for sessions. Junior engineers often try to force one database to do all three and then spend a quarter refactoring when the session load tips the order database over. The polyglot persistence pattern is the right default in 2026, and the operational cost of running multiple databases is a fraction of the cost of shoehorning everything into one.

Interview framing. "How would you choose between DynamoDB and Postgres for a URL shortener?" is a canonical early-career prompt. The junior answer is "DynamoDB because scale." The bar-raiser answer is "DynamoDB if I expect billions of URLs with a known access pattern (by short code), Postgres if I expect millions with analytics queries (top URLs by domain, click-through by campaign). Both can do the job at typical scale, so the deciding factor is the secondary access patterns and the operational context."

### Senior at FAANG: The Full Database Landscape and Staff-Level Decision Doctrine

At staff and principal level, database selection is a portfolio decision across a workload family, not a single choice. A typical large-scale system touches 8 to 12 distinct database technologies, each chosen for a specific access pattern. A senior architect needs a mental map of the full landscape to make those choices coherently, and to defend them in review against "why not one database for everything" pushback.

The landscape in 2026, by workload shape:

OLTP row-oriented. Postgres (and Aurora Postgres, AlloyDB) is the default. MySQL remains strong where team expertise or tooling dictates. For cross-region ACID, Spanner, CockroachDB, Aurora DSQL, and YugabyteDB compete. For HTAP (transactional plus analytical on the same data), TiDB and AlloyDB are the main choices. For single-region serverless, Neon and Supabase Postgres are the lightweight options.

OLAP columnar. BigQuery, Snowflake, and Redshift are the cloud data warehouses. ClickHouse is the open-source option that has matured into production-grade for real-time analytics. Databricks SQL (Lakehouse) overlaps with the warehouses and is pulling share. For self-hosted, DuckDB is the embedded option that has changed the ETL landscape in the last two years.

Key-value. DynamoDB on AWS, Bigtable on GCP, Cosmos DB on Azure. Redis for in-memory. ScyllaDB and Cassandra for high-write open-source. FoundationDB for ordered key-value with transactions (used internally by Snowflake, Apple, and others).

Document. MongoDB remains dominant. DocumentDB (AWS) and Cosmos DB provide managed alternatives. For embedded, SQLite with JSON1 covers many cases. For Postgres-native document workloads, JSONB plus GIN indexes removes the need for a separate store.

Wide-column. Cassandra and ScyllaDB for write-heavy log and time-series. Bigtable for GCP. HBase for Hadoop-adjacent stacks. These have a narrow sweet spot (huge writes, simple access patterns) and should not be defaults.

Graph. Neo4j is the reference implementation. Amazon Neptune provides managed graph on AWS. ArangoDB covers multi-model. TigerGraph for analytics at scale. For graph workloads under 10M edges, a relational database with recursive CTEs is often adequate and avoids a specialized system.

Search. OpenSearch (AWS fork of Elasticsearch), Elasticsearch, Meilisearch (lightweight, Rust), Typesense (fast, Go-adjacent), and Algolia (managed, expensive). For Postgres shops, pg_search and Zombodb provide in-database full-text for small corpora. For hybrid keyword plus vector, Weaviate and Qdrant are the 2024-2026 answers.

Vector. Pinecone, Weaviate, Qdrant, Milvus are the dedicated vector stores. Postgres with pgvector, Redis with vector types, and Elasticsearch with dense vectors cover the "vector as a feature of an existing database" case, which is increasingly the right choice for RAG systems under 100M vectors. At larger scale, dedicated vector stores with specialized ANN indexes (HNSW, IVF) pull ahead.

Time-series. InfluxDB, TimescaleDB (Postgres extension), QuestDB (fast, open-source), ClickHouse (columnar, doubles as time-series), Prometheus (metrics-native, not a general-purpose store). The 2024-2026 trend is toward ClickHouse eating TimescaleDB's market share for observability workloads.

Ledger. QLDB (AWS, deprecated in 2024, migration to Aurora Postgres with immutability triggers is the current AWS guidance) and Azure Confidential Ledger are the managed options. For most ledger use cases, Postgres with an append-only table and cryptographic hash chaining covers the requirement without a specialized product.

Streaming. Kafka and Kinesis for ingest. Redpanda as the Kafka-compatible alternative. Pulsar for multi-tenant. Flink and Spark Structured Streaming for processing. Materialize and RisingWave for streaming SQL.

The staff-level decision doctrine runs on four principles. First, optimize for the 95th percentile workload, not the peak. Databases that handle the peak but are slow on typical queries will disappoint users daily to handle one edge case. Second, prefer boring technology. Postgres in 2026 is not exciting but it is the most well-understood database in the industry, has the largest operator pool, and has the richest ecosystem of tools. Reach for exciting technology only when boring technology cannot meet a requirement. Third, budget for migrations. Every database choice has a 3 to 5 year half-life before workload growth, vendor changes, or better alternatives force a migration. Design the application to make migrations possible, with a repository layer that abstracts the database, schema-first contracts that do not leak database specifics into the domain, and event sourcing or CDC for replay-based migrations.

Fourth, cost model the full lifecycle. Day-one costs are only part of the story. Include (a) compute plus storage at expected scale in year two, (b) data transfer costs, especially cross-region and cross-cloud, (c) operational overhead measured in engineer-hours, (d) backup and disaster recovery, (e) licensing for enterprise features, (f) migration cost if the choice turns out wrong, and (g) training cost for the team. A Spanner deployment that costs $10K per month in infrastructure might be cheaper than a self-hosted CockroachDB deployment that costs $3K per month plus two engineer-weeks per month of operational overhead. The staff-level discipline is to put numbers on all seven and present a total cost of ownership, not a license cost.

Decision tree for common scenarios:

1. Read-heavy single-region OLTP under 10 TB. Postgres or Aurora Postgres. Cloud SQL if on GCP, Aurora if on AWS, Azure Database for Postgres if on Azure.
2. Write-heavy single-region OLTP under 10 TB. Same as above, with careful tuning of connection pooling (PgBouncer) and write-optimized schemas.
3. Any region, key-value, single-digit ms latency. DynamoDB on AWS, Bigtable on GCP, Cosmos DB on Azure. Redis as a cache in front.
4. Multi-region ACID. Spanner on GCP, CockroachDB cloud-agnostic, Aurora DSQL on AWS (wait for GA maturity), YugabyteDB for self-hosted.
5. Analytics at scale. BigQuery, Snowflake, Redshift, Databricks. Pick by ecosystem and pricing model (per-query, per-capacity, or hybrid).
6. HTAP. TiDB (MySQL-compatible) or AlloyDB (Postgres-compatible). Spanner with Data Boost for read-heavy analytical overlay.
7. Search. OpenSearch or Elasticsearch. Meilisearch if lightweight. Typesense for Go-native tooling.
8. Vector for RAG. Postgres with pgvector if under 10M vectors and already on Postgres. Dedicated vector store (Pinecone, Weaviate, Qdrant) over that.
9. Time-series observability. ClickHouse for self-hosted scale. InfluxDB for IoT. TimescaleDB if you want Postgres ergonomics at moderate scale.
10. Session or cache. Redis or Valkey (the open-source fork after Redis license change). DynamoDB with TTL as a managed alternative.
11. Event log or CDC sink. Kafka or Redpanda. Kinesis on AWS. Pulsar for multi-tenant.
12. Ledger with immutability. Postgres with append-only plus hash chaining. Specialized products rarely justify their premium.
13. Graph under 10M edges. Postgres with recursive CTEs.
14. Graph over 10M edges or with heavy traversal. Neo4j or Neptune.
15. Embedded or edge. SQLite or DuckDB. Redka for a Redis-compatible embedded option.

Cost comparison at a typical staff-level workload (100 GB, 5000 QPS read, 500 QPS write, single region) in 2026 pricing:

- Postgres on RDS db.r6g.xlarge multi-AZ: ~$600 per month
- Aurora Postgres Serverless v2 (4 ACUs average): ~$900 per month
- DynamoDB on-demand at that QPS: ~$750 per month
- Cloud SQL equivalent: ~$550 per month
- AlloyDB minimum deployment: ~$1500 per month
- CockroachDB Cloud 3-node: ~$3500 per month
- Spanner multi-region minimum: ~$6500 per month
- TiDB Cloud dedicated 3-node: ~$3000 per month
- MongoDB Atlas M30: ~$550 per month

The factor of 10 spread between cheapest and most expensive is real, and it is entirely explained by consistency guarantees and geographic distribution. A staff engineer who picks the expensive option without articulating the requirement that justifies it will lose the budget argument. One who picks the cheap option without understanding the limitation will lose the reliability argument. Naming the trade-off explicitly in the design doc is the only way to win either conversation.

Final staff-level principle: the best database for a workload in 2026 might be two databases. Polyglot persistence (dedicated database per service or per access pattern) is mature, well-tooled, and almost always cheaper than forcing a single database to cover every case. The real architectural question is not "which database" but "which databases, and how do they stay in sync." CDC pipelines (DynamoDB Streams, Debezium on Postgres, change streams on Spanner) are the connective tissue, and a staff engineer who can draw the full data flow across three databases and two streaming systems on a whiteboard is demonstrating the skill the role actually requires.

---

