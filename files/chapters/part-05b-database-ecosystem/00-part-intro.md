# Part VB: Database Ecosystem

*The right database for the right job. Polyglot persistence isn't optional, it's how modern systems are built.*

---

No single database handles every workload optimally, and FAANG companies understood this years ago. Google operates Spanner, Bigtable, Firestore, and BigQuery simultaneously. Amazon built DynamoDB, Redshift, Neptune, and ElastiCache as distinct services because each solves a different class of problem. Meta uses MySQL for social graph storage, TAO for caching, and HBase for messaging history. In a typical FAANG backend, a single user request might touch PostgreSQL for account data, Elasticsearch for search results, Redis for cached recommendations, and ClickHouse for analytics, all within a few hundred milliseconds.

As a senior Go engineer, you are expected to choose the right database for each component of your system and implement the data access layer with production-quality code. This means understanding the fundamental architecture of each database type - why document databases excel at flexible schemas, why wide-column stores handle write-heavy workloads, why search engines invert the index, and why NewSQL databases can provide global consistency that traditional relational databases cannot. Making the wrong database choice at the design phase creates technical debt that takes years to unwind.

This part teaches you when and how to use each major database type, with production-ready Go implementations for every one. You will not just learn the API - you will understand the storage engine, consistency model, scaling characteristics, and failure modes that determine whether a database is the right fit for your workload.

**What this part covers:**
- Chapter 37D: MongoDB & Document Databases - document modeling, aggregation pipelines, sharding, change streams, and Go driver patterns
- Chapter 37E: Cassandra & Wide-Column Stores - partition key design, consistency levels, ScyllaDB, time-series modeling, and write-optimized patterns
- Chapter 37F: Elasticsearch & Search Engineering - inverted indexes, BM25 scoring, aggregations, vector search, and building search features in Go
- Chapter 37G: DynamoDB & NewSQL - single-table design, CockroachDB, TiDB, globally distributed SQL, and serverless database patterns
- Chapter 37H: Analytics, Time-Series & Graph - ClickHouse for OLAP, TimescaleDB for time-series, Neo4j for graph queries, and analytical workloads in Go

**How to use this part:**
Each chapter is relatively self-contained, so you can start with the database type most relevant to your current work or interview preparation. However, reading them in order from 37D through 37H builds cumulative understanding of how different storage engines solve different problems. If you are preparing for system design interviews, focus especially on chapters 37D (document stores), 37F (search), and 37G (NewSQL/DynamoDB), as these appear most frequently in design problems.

**FAANG relevance:**
System design interviews require you to justify database choices for every component of your design. Interviewers will challenge you - "Why not Cassandra here?" or "What happens when your Elasticsearch cluster loses a node?" - and they expect answers grounded in understanding of storage engines and consistency models, not just API familiarity. On the job, you will participate in database selection decisions, design data models for new services, and operate multi-database architectures. This part gives you the depth to make those decisions confidently and defend them under scrutiny.

---
