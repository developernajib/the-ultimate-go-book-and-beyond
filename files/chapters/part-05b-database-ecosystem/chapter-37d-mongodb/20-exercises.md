## Exercises

1. **Social Feed Document Schema**: Design a MongoDB document schema for a social feed supporting posts, comments, reactions, and follows. Model the schema so that fetching a user's home feed (posts from followed users, sorted by recency, with top-level comment counts) requires at most two queries. Define all collection indexes, justify embedding vs referencing decisions for comments, and demonstrate how the schema handles posts with more than 1,000 comments without unbounded document growth. Expected outcome: a schema diagram, index definitions, and a Go struct set with BSON tags.

2. **Aggregation Pipeline for Analytics**: Build a MongoDB aggregation pipeline in Go that computes weekly cohort retention for a mobile app. Input is a `events` collection with fields `user_id`, `event_type` (`signup`, `session_start`), and `occurred_at`. The pipeline must group users by signup week, then calculate the percentage who returned in each of the following 8 weeks. Use `$bucket`, `$group`, `$lookup`, and `$project` stages. Expected outcome: a Go function returning a `[]CohortRetention` slice and a benchmark showing pipeline execution under 2 seconds for 5M event documents with proper indexes.

3. **Change Streams for Real-Time Sync**: Implement a Go service that consumes a MongoDB change stream on a `products` collection and propagates every insert, update, and delete to a Redis cache within 500ms. The service must store resume tokens in a separate `checkpoints` collection so it can restart without reprocessing events. Handle network interruptions with exponential backoff and verify exactly-once cache updates using Redis `SET NX`. Expected outcome: a resilient streaming worker with unit tests covering resume-token persistence and Redis idempotency logic.

4. **Atlas Search for Full-Text**: Using MongoDB Atlas Search (or a local Lucene-backed search index via `mongot`), create a compound index on a `articles` collection that supports: full-text search across `title` and `body` with title boosted 3x, autocomplete on `title` using edge n-grams, and faceted counts by `category` and `published_year`. Write a Go function that accepts a search query string and returns paginated results with highlights and facet buckets. Expected outcome: working Go search handler, index definition JSON, and latency measurements showing p99 under 100ms for a 1M-document corpus.

5. **Transactions Across Collections**: Implement a funds-transfer feature between two `accounts` documents using a multi-document ACID transaction. The operation must debit the sender, credit the receiver, and append a record to a `ledger` collection atomically. Introduce a simulated failure mid-transaction to verify rollback correctness. Then extend the solution with an optimistic-locking retry loop to handle `WriteConflict` errors under concurrent load. Expected outcome: a Go `TransferFunds` function with integration tests that verify balance invariants hold under 50 concurrent goroutines each performing 100 transfers.

6. **Index Strategy for Compound Queries**: Given a `orders` collection with fields `customer_id`, `status`, `created_at`, `region`, and `total_amount`, profile five representative query patterns using `explain("executionStats")` and design a minimal compound index set (at most four indexes) that satisfies all patterns with IXSCAN execution plans and no in-memory sorts. Document ESR rule application for each index. Then use the Go driver's `IndexView.CreateMany` to create the indexes programmatically and write a test that asserts each query uses the expected index via the `hint` option. Expected outcome: index definitions with ESR justification, Go index-creation code, and passing query-plan assertion tests.

The key insight: **data that is accessed together should be stored together**. Optimize your schema for your most common read patterns, not for write normalization as in relational databases.

### Junior to FAANG: How To Approach These Exercises In Your First Year

A junior completing these six exercises is preparing for an L4 promotion case. Attack them in this order and with this discipline.

Exercise order for learning efficiency: 6, 1, 2, 5, 3, 4. Start with indexing (6) because every other exercise depends on index fluency. Then schema design (1). Then aggregation (2) because aggregations layer on top of indexes. Then transactions (5) because they are the hardest correctness exercise. Then change streams (3) because they layer on top of both writes and indexes. Finally Atlas Search (4) because it is a separate subsystem and distracts from core MongoDB fluency.

Worked example. Exercise 6 step by step for a junior.
1. Write the five queries in code first. Do not think about indexes yet.
2. For each query, mark the fields used in `filter`, `sort`, and `range predicate`.
3. Apply ESR per query. For example `find({customerId, status}).sort({createdAt: -1})` yields index `{customerId: 1, status: 1, createdAt: -1}`.
4. Look for common prefixes across queries. Collapse indexes that share a prefix. Example: `{customerId: 1, status: 1, createdAt: -1}` also serves `find({customerId, status})` and `find({customerId}).sort({createdAt: -1})` (the last only if the planner skips `status`, which it does via index bounds).
5. After collapse, you should have three to four indexes, not five. Verify each query via `explain` with `hint(indexName)` in a test.

Acceptance checklist for any exercise before you claim done.
- Does every write path use `bson.NewObjectID()` client-side?
- Does every read path have a projection?
- Does every query show IXSCAN (not COLLSCAN) in `explain`?
- Are there no unbounded arrays in the schema?
- Does every financially or legally material write use `w:"majority"`?
- Is there a unit test that asserts on index usage via `hint`?
- Is there an integration test that simulates a primary step-down?

"Why did this fail?" reflex. If Exercise 5 deadlocks under load the cause is almost always the transaction touching too many collections or the retry loop lacking jittered backoff. If Exercise 3 drops events the cause is almost always saving the resume token before processing instead of after. If Exercise 2 OOMs the cause is almost always a `$group` on a high-cardinality field without `allowDiskUse`. Memorize these three failure modes.

Interview entry point. If an interviewer asks you to whiteboard any of these six exercises, start by writing the collections, then the indexes, then the query set, then the code. In that order. Candidates who open with code fail. Candidates who open with collections and indexes pass.

### Senior at FAANG: Staff-Level Extensions, Platform Deliverables, and ADR Portfolio

At staff and principal level, each of the six exercises becomes a platform deliverable. Below are the extensions with the artifacts a senior engineer ships, organized as an ADR portfolio.

Exercise 1 extension. "Multi-tenant social feed at a billion DAU."
- Shard-key ADR covering `posts` and `feeds`. Defend against three alternatives. Include a one-week production-log simulation.
- Fan-out service ADR. Celebrity threshold as a tuned dial. Cost curve attached. Fan-out to Kafka with batched writes to `feeds` through a Connect sink.
- Feed materialization runbook. Regenerating a user's feed from `posts` plus `follows` in under five minutes after a corruption event.
- Cost model. Per-DAU cost target with chargeback tags. Revisit quarterly.

Exercise 2 extension. "Analytics pipeline at petabyte scale."
- Storage tier ADR. Hot tier in MongoDB time-series collections. Warm tier in Atlas Online Archive. Cold tier in S3 Parquet via Atlas Data Federation. Queries routed by date range.
- Schema registry integration. Every event type declared in Avro. Breaking changes require an ADR.
- Cost model. Compare MongoDB time-series plus Online Archive against BigQuery, Snowflake, and ClickHouse for the workload. Document the crossover point.

Exercise 3 extension. "Debezium-to-Kafka change-stream pipeline as a platform capability."
- Multi-tenant connector operation. One Kafka Connect cluster, many tenant connectors. Quota per tenant.
- Schema registry enforcement. Every MongoDB collection sending events has an Avro schema. Backward-compatible evolution only.
- Offset and resume-token persistence. Primary in Kafka, secondary in a metadata collection, tertiary in S3 for long-term replay.
- Game-day. Kill the Kafka cluster. Verify the connector resumes cleanly. Kill the Mongo primary. Verify no duplicates beyond the dedup window. Kill the consumer. Verify exactly-once delivery via Kafka transactions plus idempotent processing.

Exercise 4 extension. "Atlas Search at enterprise scale."
- Index lifecycle ADR. Creation, warming, rollover, and deprecation. Search indexes are not cheap, so the ADR bounds the count per cluster.
- Query-shape catalog. Every search endpoint declares its query shape in a repository file. The platform validates that the right index exists.
- Cost model. Atlas Search billing per shard-hour. Compare against self-hosted Elasticsearch and against OpenSearch Serverless for the workload.
- Relevance tuning. A staff engineer owns the relevance dashboard (NDCG, MRR, click-through) and adjusts boosts quarterly.

Exercise 5 extension. "Financial ledger at FAANG scale."
- Correctness ADR. Multi-document transactions with `w:"majority"` and `readConcern:"snapshot"`. Retry on `TransientTransactionError` and `UnknownTransactionCommitResult` with jittered backoff and a cap.
- Idempotency ADR. Every transfer carries a client-generated idempotency key. Deduplication in a `transfer_keys` collection with a TTL of ninety days.
- Reconciliation. A nightly job that sums all `accounts.balance` and the net of `ledger.amount`. Drift triggers a paging incident. This is how real financial systems catch bugs that tests missed.
- Regulatory posture. SOX, PCI, or the relevant regime documented. Audit retention seven years.

Exercise 6 extension. "Indexing governance for a fleet."
- Index review board. Every new index requires a PR with an ESR justification and a planner `explain` output attached. A principal engineer is on the reviewers.
- `indexStats` weekly job. Unused indexes dropped after two reviews. Saves fleet IOPS and storage.
- Plan-cache ADR. Document when to call `planCacheClear` and why. Usually never, but the team must know the escape hatch.
- Query-shape registry. Every named query shape in a repository file, every shape linked to its supporting index. This prevents the "mystery query" that appears in the slow log and nobody claims.

ADR portfolio. A principal engineer who has completed all six extensions holds an ADR portfolio including: shard-key choice, fan-out threshold, storage tiering, change-stream pipeline, Atlas Search lifecycle, transaction retry and idempotency, reconciliation job, index review board, plan-cache policy, and cost model per service. This portfolio IS the staff-level artifact. It is what a promotion committee looks for, and it is what an acquirer looks at during due diligence.

Maturity model note. An org that completes exercises 1 through 6 with these extensions, and that has all ten ADRs reviewed by a principal engineer, is at L5 on the MongoDB maturity ladder for the services concerned. An org that shipped the code without the ADRs is at L3 regardless of the code quality. The artifact, not the code, is the gate.
