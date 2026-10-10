## ETL Pipeline Architecture

A well-structured ETL pipeline in Go is built around a typed channel-based stage model where each stage is an independent goroutine communicating through typed channels. The foundation below defines the `Stage`, `Pipeline`, and `Record` interfaces that subsequent extractor, transformer, and loader implementations depend on.

```
Data Sources          Transform Layer          Destinations
┌──────────┐         ┌─────────────────┐      ┌──────────────┐
│ Postgres │──────► │   Validate       │ ───► │  Data        │
│ MySQL    │         │   Enrich         │      │  Warehouse  │
│ Kafka    │──────► │   Deduplicate    │ ───► │  (BigQuery,  │
│ S3/GCS   │         │   Aggregate      │      │   Redshift) │
│ REST API │──────► │   Transform      │ ───► │  S3/GCS      │
└──────────┘         └─────────────────┘      └──────────────┘
                           │
                    ┌──────▼──────────┐
                    │  Dead Letter    │
                    │  Queue (DLQ)    │
                    └─────────────────┘

Pipeline Execution Model:
┌────────┐    ┌────────────┐    ┌──────────┐    ┌──────┐
│Extract │───►│ Transform  │───►│Aggregate │───►│ Load │
│        │    │            │    │          │    │      │
│chan    │    │chan        │    │chan      │    │batch │
│source  │    │record      │    │batch     │    │sink  │
└────────┘    └────────────┘    └──────────┘    └──────┘
    Goroutine pool at each stage + backpressure via bounded channels
```

### Junior to FAANG: reading the architecture diagram

The diagram above compresses a lot of vocabulary into a small picture. Work through it slowly. The left column is the source layer. Each source has its own extraction semantics. Postgres and MySQL can be read by plain SQL queries, by logical replication (Postgres) or binlog (MySQL) for change-data capture, or by database-specific tools like `pg_dump`. Kafka is a distributed log that you read by committing offsets per consumer group. S3 and GCS are object stores that you read by listing prefixes and fetching files. REST APIs are read by paginated HTTP requests. Each of these sources has a different failure mode. Postgres queries can run out of memory if you forget `LIMIT`. Kafka consumers can fall behind retention and lose data. S3 list operations are eventually consistent within a region. REST APIs rate-limit you. A useful exercise for a first-year engineer is to pick one source from the diagram and write down its three most common failure modes before looking them up.

The middle column is the transform layer. Validate means rejecting records that violate a schema (missing required fields, wrong type, out-of-range values). Enrich means joining with a reference table (looking up a country name from an ISO code, or a user tier from a customer ID). Deduplicate means dropping records the pipeline has already seen, typically by hashing the primary key and checking a Bloom filter or a small Redis set. Aggregate means combining many records into one (hourly sums, daily counts). Transform is the catch-all for shape changes like flattening nested JSON or renaming fields. The dead-letter queue is where records that fail validation go so that the pipeline does not stall on one bad row. A production pipeline without a DLQ will be stopped by a single malformed event at two in the morning.

Worked example. Imagine building the pipeline `Postgres orders to BigQuery analytics`. Extract stage runs a goroutine that queries `SELECT id, user_id, amount_cents, created_at FROM orders WHERE id > $cursor ORDER BY id LIMIT 1000` and pushes rows onto a channel. Transform stage is a goroutine pool that reads from that channel, validates `amount_cents >= 0`, enriches with `user_tier` from a cached lookup map, and pushes valid rows to the next channel. Invalid rows go to a DLQ channel that writes to an `orders_dlq` table. Load stage batches 500 rows at a time and calls BigQuery's `InsertAll` API with a deduplication key. Each stage has a bounded buffer of, say, 2000 records. When BigQuery is slow the load buffer fills, which blocks the transform stage, which blocks the extract stage, which slows the Postgres queries. That is backpressure, and in Go it is free because unbuffered and bounded channels block when full.

Interview entry point. A classic interview ask is "walk me through an ETL pipeline you have worked on and explain where it failed". A junior who answers "it ran every night and wrote to a table" is not yet ready. A stronger answer identifies the cursor (what made it incremental), the failure mode that actually occurred (schema drift, duplicate load, upstream outage), and the fix (idempotent upsert, retry with backoff, schema registry). Interviewers are probing for whether you have operated a pipeline, not just written one.

### Senior at FAANG: architectural choices behind the picture

The boxes in the diagram hide the hardest decisions. A staff engineer reading that diagram should be asking, for each arrow, "what is the delivery guarantee, what is the retention window, what is the fan-out, and who owns the schema contract". Consider the Kafka arrow into the transform layer. Kafka gives you at-least-once by default. Exactly-once end-to-end requires the consumer to read with a transactional isolation level, process with idempotent state updates, and commit offsets in the same transaction as the sink write. If the sink is BigQuery, transactional commits are not available, so the correct model is to rely on deterministic primary keys and MERGE on load. If the sink is Snowflake, the same applies with MERGE or with Snowpipe Streaming which has its own idempotency contract via offset tokens. If the sink is another Kafka topic, you can get true exactly-once via Kafka transactions and the read-process-write pattern.

The choice of transform substrate is an organizational decision disguised as a technical one. In 2026 the ELT consensus says that the transform boxes in that diagram should collapse into dbt or SQLMesh models running inside the warehouse after a raw load. Move the validate, enrich, deduplicate, and aggregate logic into SQL and make Go responsible only for extract and load. The benefits are concrete. Analysts can read and modify the models without learning Go. Lineage is generated automatically. Tests (dbt `tests`) live next to the models. Version control maps to pull requests against a dbt project. The cost is that warehouse compute is more expensive per operation than Go, and latency rises from seconds to minutes. The right answer depends on whether the consumers of the data care about minute-level freshness or are happy with fifteen-minute batches. Most analytics workloads are happy with fifteen minutes. Fraud detection, ad bidding, and operational alerting are not.

The DLQ is not a bucket, it is a contract. A mature DLQ has four properties. First, it preserves the original payload byte-for-byte so reprocessing is deterministic. Second, it stores the failure reason, the pipeline version, and the stage where the failure occurred so that triage is possible without cross-referencing logs. Third, it has a replay tool that lets an operator re-enqueue DLQ records after a code fix, ideally with a filter so you can replay only the records that match a known failure signature. Fourth, it has alerting on rate rather than absolute count, because a pipeline processing 100 million records per day will always produce a few DLQ entries and a threshold alert on "any DLQ writes" will be ignored within a week. The alert that matters is "DLQ rate exceeded 0.1 percent of throughput for 15 minutes".

Backpressure via bounded channels is correct for a single-process pipeline but does not survive sharding. Once the pipeline runs on multiple workers reading from a partitioned source like Kafka, backpressure becomes a property of the consumer group and the partition assignment, not the channel buffer. A slow worker in a consumer group causes partition lag on the partitions it owns, not on all partitions. This changes how you alert. The metric to watch is per-partition lag, not aggregate lag. The metric to act on is the derivative, not the absolute value. A pipeline that runs at 50 percent of peak capacity will occasionally spike to 100 percent during a reprocess, and alerting on "lag greater than X" will page on every backfill. Alerting on "lag is increasing for more than 10 minutes" catches real incidents.

The boundary between the extract, transform, and load stages deserves a durable handoff rather than an in-memory channel when the pipeline crosses a failure domain. Landing extracts in S3 or GCS as Parquet files, with a manifest pointing to the current batch, lets you replay the transform and load stages independently of the source. This matters because sources are often the least reliable component. A third-party API that goes down for two hours should not force a reprocess. With landed extracts, the transform and load stages continue from S3 once the API recovers, and the extract stage catches up on its own schedule. This pattern is known as medallion architecture (bronze for raw, silver for validated, gold for modeled) when applied inside a lakehouse like Databricks or Iceberg on S3. The Go pipeline owns bronze and silver. The warehouse or lakehouse owns gold via dbt or SQLMesh.

Table formats deserve a paragraph of their own. Apache Iceberg, Delta Lake, and Apache Hudi turn S3 or GCS into a transactional data lake with schema evolution, time travel, partition evolution, and upsert support. As of 2026, Iceberg has won the standards race with AWS, Snowflake, BigQuery, Databricks (via Uniform), and Cloudera all supporting it as a first-class table format. When your load target is a lakehouse, the loader writes Parquet files and commits a manifest to Iceberg rather than inserting into a warehouse table. The operational implications are significant. Backfills become cheap because you can write new snapshots without rewriting history. Schema evolution is a metadata operation rather than a rewrite. Time travel (`AS OF TIMESTAMP`) lets you reproduce a pipeline's output at any point in the retention window, which is invaluable for debugging "why did the dashboard show a different number yesterday".

---
