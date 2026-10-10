## Common Mistakes and Anti-Patterns

Most ETL pipeline failures in production stem from missing operational features rather than incorrect business logic. The table below lists the mistakes that cause the most on-call incidents, along with their fixes.

| Mistake | Problem | Fix |
|---------|---------|-----|
| No checkpointing | Reprocesses entire dataset on restart | Save watermark after each batch |
| Unbounded channel buffers | OOM on backpressure | Use bounded channels (256-1024) |
| No DLQ | Failed records silently dropped | Route errors to dead letter queue |
| Loading without upsert | Duplicate rows on re-run | Use `ON CONFLICT DO UPDATE` |
| No deduplication | Duplicate records from retries | Hash-based dedup with TTL |
| Single goroutine per stage | CPU underutilization | FanOut for CPU-bound stages |
| No schema validation | Corrupt data in warehouse | Validate before loading |
| Committing Kafka offset before processing | At-least-once guarantee broken | Commit only after successful load |
| Unbounded retries on non-retriable errors | DLQ never fills, poison records loop forever | Classify errors: retry transient (network, 5xx), DLQ permanent (validation, 4xx, deserialization) |
| Alerting on absolute DLQ size | Noise from normal steady-state failures | Alert on rate-of-change (e.g. DLQ grew > 10x in 5m) or on error-per-source ratio |
| Schema-on-read only | Producers silently break consumers | Use a schema registry (Confluent, Apicurio) with Avro/Protobuf and enforce BACKWARD compatibility at publish time |
| Building orchestration from cron + shell | No retries, no backfill, no lineage | Use Airflow / Dagster / Prefect for batch DAGs, Temporal for durable code-first workflows |
| Transforming in the pipeline when ELT would do | Slow, hard to debug, duplicates warehouse SQL | Load raw into the warehouse, transform with dbt, reserve Go for custom extract and real-time enrichment |
| Logs without trace context | Impossible to follow a record across stages | Propagate W3C trace context in `Record.Metadata`, emit OpenTelemetry spans per stage |
| Using `time.Now()` as the event timestamp | Breaks event-time processing and late-arrival handling | Preserve source event time, carry ingest time separately |
| Tightly coupled extractor and loader | Cannot replay without re-extracting | Always stage raw data in S3/GCS/Kafka first so loads are replayable from durable storage |

### Junior to FAANG: Prerequisite Gaps and First-Job Context

New hires land on a data team and break production within a week because nobody taught them the reflexes that distinguish a working pipeline from a safe one. The first gap is treating ETL like a script. You write `SELECT * FROM orders`, stream to a CSV, load into Snowflake, and call it done. Then the source table hits fifty million rows, the connection drops at row thirty million, and the next run restarts from zero. The fix is a watermark. Store the max `updated_at` you have successfully loaded, and on restart resume from there. This single pattern is the difference between a pipeline that survives a weekend and one that pages you at 3am.

The second gap is confusing "my code ran" with "the data is correct". A junior engineer ships an extract that silently drops rows whose `customer_id` is NULL because the downstream warehouse column is NOT NULL and the insert fails. The pipeline logs a warning and moves on. Two weeks later finance asks why revenue reconciliation is off by 0.3 percent. The reflex you need is row-count reconciliation. After every load, query `COUNT(*)` from source for the window, compare to `COUNT(*)` loaded, and fail loud if the delta exceeds a threshold. Silent data loss is the most expensive bug in data engineering because it compounds across quarters before anyone notices.

Worked example. You are asked to load Stripe charges into a reporting warehouse hourly. The junior version calls the Stripe API, paginates, inserts. The FAANG version does five more things. It stages raw JSON to S3 keyed by `charges/dt=2026-04-22/hr=14/`. It loads from S3 with `COPY INTO ... ON_ERROR = CONTINUE` and captures rejected rows to a DLQ table. It reconciles by querying Stripe's `balance_transactions` endpoint for the hour and comparing count and sum. It emits a metric `pipeline_rows_loaded` tagged with `source=stripe, table=charges`. It writes a watermark row `(source=stripe, table=charges, watermark=1713798000)` inside the same transaction that commits the load so a crash cannot leave the watermark ahead of the data.

"Why did this fail?" reflex. When a pipeline alerts, you want a ladder of questions. Did the source return data? Did extract complete? Did transform produce the expected row count? Did load commit? Did the watermark advance? If you cannot answer each question from logs and metrics inside sixty seconds, your observability is broken, not your pipeline. Interviewers at Google, Meta, Stripe, and Databricks probe this ladder. A phone screen favourite is "your pipeline is six hours behind, walk me through your first ten minutes". Strong answers start at the queue depth metric and end at a specific SQL query. Weak answers restart the pipeline.

Interview entry-point. For an L3 or new-grad data engineering role the bar is: explain at-least-once versus exactly-once, write a SQL `MERGE` that is idempotent, describe why `time.Now()` is the wrong event timestamp, and sketch a retry policy that distinguishes 5xx from 4xx. If you can do those four things cleanly you pass the technical bar for every FAANG data team in 2026.

### Senior at FAANG: Staff and Principal Material, ADRs, Maturity Models, Governance

Staff and principal data engineers are not measured on pipelines shipped. They are measured on the leverage of the platform they leave behind and the incidents they prevent across all teams. The anti-patterns in the table above are tactical. At staff level the anti-patterns are organizational.

Full-table extract when CDC is available. A team writes a nightly `SELECT *` from a two-billion-row Postgres orders table because "CDC is hard". The extract takes six hours, holds a long-running transaction that blocks autovacuum, and causes table bloat that eventually triggers a failover. The staff fix is not to optimize the extract. It is to stand up a CDC platform (Debezium to Kafka, or AWS DMS, or a managed service like Fivetran) and make full-table extract a policy exception that requires a written justification. The ADR captures that CDC is default, with bounded exceptions for dimension tables under one million rows.

Synchronous writes killing throughput. A pipeline inserts row-by-row into Snowflake and saturates at two hundred rows per second because each `INSERT` is a synchronous round trip. The senior fix is micro-batching with `COPY INTO` from staged files, targeting 100MB to 250MB per file, which lifts throughput into the tens of thousands of rows per second. The governance piece is a platform guardrail: any loader that issues single-row inserts against a columnar warehouse is blocked at code review. Publish the rule, automate the check with a lint rule on the internal SDK.

Missing watermark leading to data skip. The subtle version is a watermark advanced on wall-clock time rather than on the maximum event time successfully committed. A late-arriving record with `event_time = T-5m` is dropped because the watermark already moved to `T`. The fix is to separate event-time watermarks from processing-time progress, and to allow a configurable late-arrival window (commonly fifteen minutes to twenty-four hours) during which records update prior partitions. The governance piece is a platform-wide contract: every dataset declares its allowed lateness, and the compactor refuses to seal a partition before its lateness window expires.

No DLQ and no idempotency. Teams rediscover these every year. The platform charter should provide both as primitives. A shared DLQ table schema, a shared idempotency key convention (hash of source primary key plus event time plus payload version), and a shared replay tool. If each team builds their own, you get eighteen incompatible DLQs and a principal engineer spending a quarter consolidating them.

Schema drift unhandled. A producer adds a nullable column. A naive consumer deserializes with a strict schema and crashes. A slightly less naive consumer silently drops the column. The staff answer is a schema registry with enforced compatibility (BACKWARD for consumer-driven evolution, FORWARD for producer-driven), contract tests that run in CI on both producer and consumer repos, and a data contract object that lives in a central registry with owner, SLA, and change process. This is the heart of the "data contracts" movement that matured during 2023 to 2025.

Overloading the source OLTP database with ETL. A reporting team runs a full-table scan against the production orders database every hour. P99 write latency doubles. The staff fix is a read replica dedicated to analytics, or CDC into a warehouse so analytics never touches OLTP. The governance piece is a policy that production OLTP databases are not queryable by analytics tools. Enforcement is via network ACL and a published review process for exceptions.

Maturity model for data pipelines (L1 to L5):

- L1 Ad-hoc. Cron plus Python or Go scripts. No retries, no lineage, no alerting. One engineer knows how it works. Typical at seed-stage startups and inside engineering teams that do not yet see data as a product.
- L2 Orchestrated. Airflow, Dagster, or Prefect for DAGs. Retries and backfill exist. Alerts on failure. Still no data quality checks, still no lineage, still no contracts. Typical at Series B.
- L3 Observable. Metrics, distributed traces, and structured logs per stage. SLOs defined for freshness and completeness. DLQs exist per pipeline. Schema registry in place for streaming. Typical at Series D through pre-IPO.
- L4 Contract-driven. Data contracts enforced in CI. Lineage captured automatically (OpenLineage, Marquez, or DataHub). Cost attribution per pipeline. Self-service onboarding: a new team can ship a pipeline without platform intervention. Typical at FAANG and mature scale-ups.
- L5 Self-service platform. Pipelines as code with strong typing end to end. Exactly-once by default via idempotent loaders. Automated data quality (Great Expectations, Soda, or dbt tests) gating every load. Chargeback to the consuming team. Lineage covers column-level impact analysis. Automated pipeline generation from contract declarations. This is where Netflix, Airbnb, Uber, and Stripe aim.

Platform team charter. A staff engineer founding a data platform team should write a charter covering: scope (what is platform versus what is product team responsibility), interfaces (SDK, DSL, or declarative YAML), SLOs (platform uptime, time-to-first-pipeline, cost per TB processed), non-goals (we do not write your transformations, we do not own your schemas), and success metrics (adoption rate, incidents caused by platform versus by product teams, developer NPS). A charter without non-goals is a charter that accretes scope until the platform team becomes the bottleneck for every team.

ADR template for pipeline decisions. Context (what pipeline, what volume, what latency target), options considered (at minimum three, including "do nothing"), decision, consequences (cost, operational burden, lock-in), and review date (usually one year). File these in a versioned repo. Principals read ADRs to audit architectural drift. A pipeline that cannot point to an ADR for its orchestrator, its storage format, and its delivery guarantee is undocumented in a way that will cost you during the next migration.

---
