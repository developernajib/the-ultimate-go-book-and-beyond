## Exercises

1. **Implement a Kafka-based Order Pipeline**: Create producer and consumer services that process orders through creation, payment, and fulfillment stages.

2. **Build an Event Store**: Implement a PostgreSQL-backed event store with optimistic concurrency and snapshots.

3. **Create CQRS Read Models**: Design projections for order analytics (total sales, popular products, customer lifetime value).

4. **Add Event Versioning**: Implement schema evolution with automatic upgraders for breaking changes.

5. **Implement Dead Letter Queue Processing**: Build a service that monitors DLQs and provides manual retry/discard functionality.

6. **Build a Projection Rebuilder**: Create a CLI tool that can rebuild projections from the event store on demand.

7. **Add Distributed Tracing**: Integrate OpenTelemetry to trace events across multiple services.

8. **Implement Exactly-Once with Outbox**: Create a service using the outbox pattern with a background poller for reliable event publishing.

### Junior → FAANG: How to Approach These Exercises for Maximum Learning

The eight exercises in this section are ordered roughly by complexity, not by importance. If you have limited time, prioritize exercises 1, 2, 5, and 8, as they cover the patterns most frequently evaluated in FAANG systems design and coding interviews.

**Exercise sequencing for a first-time learner.** Do exercise 8 (outbox pattern) before exercise 1 (full pipeline), because the pipeline exercise assumes the outbox is working. Do exercise 2 (event store) before exercise 6 (projection rebuilder), because the rebuilder depends on being able to load events from the store. Exercise 3 (CQRS read models) depends on exercise 2 being complete.

**How to validate your exercise implementations.** For each exercise, write at least three tests before implementing: a happy path test, a failure injection test (what happens when the database fails mid-operation, or Kafka is unavailable), and an idempotency test (what happens when the same event is processed twice). If your implementation passes all three, it is ready for a code review. If it passes only the happy path, it is not production-ready, regardless of how the code looks.

**Exercise 5 (DLQ processing) is often underestimated.** A DLQ monitor is not just a consumer that reads from the DLQ. A production DLQ monitor shows: the event type and aggregate ID for each failed message, the error that caused the failure, the number of retries already attempted, the time the message first entered the DLQ, and a UI for inspecting the full payload. Requeue functionality must be idempotent (requeuing the same message twice should not produce two side effects). Build the full monitor, not just the reader.

**Exercise 7 (distributed tracing) should not be last.** Tracing is most valuable when added from the start, not retrofitted. As you complete each earlier exercise, add OTel spans to the key operations: outbox write, relay publish, consumer process. By the time you reach exercise 7, you will have a complete trace of an order event from producer to consumer.

### Senior @ FAANG: Extending These Exercises to Staff-Level Concerns

The eight exercises as stated are correct for demonstrating pattern competency. Here are the extensions that make each exercise staff-level.

**Exercise 1 (Kafka pipeline):** Add consumer lag alerting. Define the alerting threshold based on the processing rate of the consumer (messages per second) and the acceptable lag in time (e.g., 5 minutes of backlog). Implement a Prometheus gauge for lag and a test that verifies the gauge increases when a slow handler is injected and decreases when the handler recovers.

**Exercise 2 (event store):** Add a concurrent write test that launches 100 goroutines, each trying to append to the same aggregate at the same expected version. Verify that exactly one succeeds and the rest receive a concurrency conflict error. This tests the `UNIQUE(aggregate_id, version)` constraint under real concurrent load.

**Exercise 3 (CQRS read models):** Measure the projection lag (time from event commit to projection update) under load. Introduce a synthetic delay in the projection handler and verify that the lag measurement increases correspondingly. Define an SLO for projection lag (e.g., P99 under 500ms) and build a test that verifies the projection meets the SLO under your expected event rate.

**Exercise 4 (event versioning):** Add a CI step that runs a golden corpus of old-format events through the current consumer and verifies that deserialization succeeds. The golden corpus is a set of serialized event JSON files committed to the repository, one per historical schema version. Adding this to CI ensures that upcasters are never broken by future code changes.

**Exercise 6 (projection rebuilder):** Add the `IsReplay` flag to the event context during rebuilds. Write a test that rebuilds a projection that contains a handler with an email side effect, and verify that no emails were sent during the rebuild. This is the most important correctness property of the projection rebuilder.

**Exercise 8 (outbox):** Replace the polling relay with a Debezium simulation (a goroutine that reads from a Postgres logical replication slot using `pglogrepl`). Compare the end-to-end latency (time from outbox row insert to Kafka consumer receiving the message) between the polling approach and the WAL approach. Document the tradeoffs in a short ADR.

---