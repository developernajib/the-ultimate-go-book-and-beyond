## Exercises

1. **Resumable S3 Extractor**: Implement an `S3Extractor` that lists all `.jsonl` files in a prefix, tracks which files have been processed in a checkpoint store, and reads new files incrementally.

2. **Schema Validation with JSON Schema**: Replace `ValidateStage` with one that accepts a JSON Schema string and validates records using `github.com/santhosh-tekuri/jsonschema/v5`.

3. **Pipeline DAG**: Extend the pipeline to support branching: one stage can send records to multiple downstream stages. Implement a `RoutingStage` that routes based on record fields (e.g., send payment events to one branch, click events to another).

4. **Backfill Mode**: Add a `--backfill-from=2024-01-01` flag to the Postgres extractor that resets the checkpoint and re-processes all records since the given date.

5. **Pipeline Observability**: Add OpenTelemetry tracing to each stage. Each record should carry a trace context (span ID), and each stage should create a child span. Export traces to Jaeger and visualize pipeline latency per stage.

### Junior to FAANG: Warm-Up Drills and First-Job Exercises

These exercises build the reflexes a new grad or mid-level engineer needs before attempting the senior extensions. Each one isolates a single failure mode that will otherwise surprise you in production.

6. **Watermark-After-Commit Drill**. Build a toy pipeline that reads from a Postgres `events` table with an `updated_at` column, writes to a local JSONL file, and checkpoints the watermark in a second Postgres table. Now inject a crash (`os.Exit(1)`) at three points: before the sink write, between sink write and watermark update, and after both. Run the pipeline, restart it, and verify that no events are lost and none are duplicated when the sink is made idempotent via upsert keyed on event id. Document which crash sites cause duplicates versus losses under which ordering of the two writes. This single exercise internalises the checkpoint-after-commit invariant better than any reading.

7. **Row-Count Reconciliation Harness**. Given an extractor that pulls from a source API, implement a reconciliation job that runs fifteen minutes after each load. It queries source-of-truth for the just-loaded window, counts rows, compares against the warehouse row count for the same window, and fails loud if the difference exceeds zero point one percent. Treat the reconciliation as a second pipeline with its own alerts. Junior engineers ship pipelines. FAANG engineers ship pipelines with reconciliation.

8. **DLQ Triage First Touch**. Write a CLI that reads from a DLQ Kafka topic, groups failures by error class and source, prints a summary table (count, first-seen, last-seen, sample payload), and offers three actions per class: retry now, retry with a fix expression, or archive. This is a warm-up for the senior DLQ triage UI exercise below. Build the CLI first, then graduate to a web UI.

9. **Intentional Schema Break**. Set up a producer and a consumer with an Avro schema registry. Publish a breaking change (rename a field). Watch the consumer fail. Now fix it by making the rename a two-step (add new field, dual-write, migrate consumer, drop old field) and verify zero consumer errors across the migration. Practise this until the sequence is muscle memory.

### Senior at FAANG: Staff Extensions, Platform-Scope Exercises, ADR Drills

These exercises are the practical homework for a staff or principal interview loop. Each one should produce an artifact (code, ADR, design doc, runbook) that you would be comfortable sharing with a hiring committee.

10. **CDC Replicator with Exactly-Once Semantics**. Build a service that tails Postgres logical replication (via `pgx` and a replication slot) and replicates to a second Postgres instance. Requirements: survive replicator restart without loss or duplication, survive source failover (wal receiver reconnect and LSN reset), survive target unavailability with bounded buffering and backpressure to the slot, handle DDL by pausing and alerting, and emit OpenTelemetry traces that span from source commit LSN to target commit. Measure throughput on a one-billion-row synthetic workload. Document the trade-off between slot lag and replicator memory. Extension: add a second target (Kafka) with a transactional outbox so downstream consumers see the same events in the same order.

11. **Design a DLQ Triage UI**. Produce a design document (not code) for a web UI that supports DLQ triage across one hundred pipelines with ten million failed records per day. Requirements: filter by pipeline, error class, source, and time window. drill down to a single failed record with full payload and stack. Batch-replay with a rate limit. "fix expression" support (a small DSL to repair common mistakes like a renamed field). Audit log of who replayed what. RBAC so only pipeline owners can replay their DLQ. SLOs on triage latency. The document should include a data model, an API sketch, a permission model, and a rollout plan. This is the kind of artifact a staff engineer produces before writing any code.

12. **Data Quality Checks in a Pipeline**. Integrate Great Expectations or equivalent declarative checks as a pipeline stage. For a simulated `orders` stream, declare expectations: `order_id` is unique within a rolling 24-hour window, `total_amount` is between zero and ten million, `currency` is one of a known enum, `customer_id` is not null, `created_at` is within plus-or-minus one hour of ingest time. Fail open (route to DLQ) for validation failures, fail closed (halt pipeline) for schema violations. Add a dashboard showing pass rate per expectation over time, and alert on regression. Extension: implement a contract CI step that runs these expectations against a producer test harness so a schema or semantic regression is caught before deploy.

13. **Migration Plan ADR: Batch to Streaming**. Write an ADR for migrating a batch pipeline (daily `SELECT * FROM orders` into Snowflake) to a streaming CDC pipeline (Debezium to Kafka to Snowflake via Snowpipe Streaming). Context, three options with trade-offs (stay batch, move to micro-batch every fifteen minutes, move to full CDC streaming), decision, consequences (cost, operational burden, team skill gap), migration sequence (dual-run for four weeks, reconcile, cut over, sunset batch after eight weeks), rollback plan, review date. This ADR should be eight to twelve pages and should read like something a principal engineer would sign off on.

14. **Platform Team Charter Drill**. Draft a charter for a new data platform team forming inside a Series D company with eighty engineers and thirty-five data pipelines currently built on cron plus Python scripts. Sections: mission, scope (what platform owns), non-goals (what platform does not own), interfaces offered in year one versus year two, SLOs (platform availability, time-to-first-pipeline, cost per TB), success metrics, staffing plan (five engineers over four quarters), and sequenced deliverables. The drill is to produce something the CTO would approve. Peer-review it with a senior engineer and revise based on their pushback.

15. **Cost Optimization Audit**. Given a synthetic warehouse bill of one hundred thousand dollars per month (provided as a CSV of queries, tables, and storage), identify the top ten optimization opportunities ranked by dollar impact and effort. Produce a prioritized list with estimated savings, required code changes, and risk. Implement the top three and measure actual savings against estimate. This exercise is identical in shape to the work a staff engineer does during a quarterly cost review.

16. **Lineage and Contract Retrofit**. Take an existing pipeline (use the sample Go pipeline from earlier sections of this chapter) and retrofit OpenLineage emission at each stage, plus a data contract declaration in the form of a YAML file in a separate repo. Wire a CI check that refuses pipeline deploys if the contract file changes without a corresponding version bump and compatibility annotation. Document how you would scale this pattern to fifty pipelines across ten teams, including how you handle contract ownership transfer when a team reorganizes.

17. **Write the Runbook**. For one of the exercises above (CDC replicator is the richest choice), write the on-call runbook. Sections: the five alerts this service fires and the first response for each, the five most common failure modes ranked by frequency with diagnostic queries and mitigations, the escalation path, the post-incident template, and the quarterly game-day scenarios. A runbook is the most undervalued artifact in senior engineering. Interviewers at Google SRE and Meta PE routinely ask candidates to produce one from memory.

---
