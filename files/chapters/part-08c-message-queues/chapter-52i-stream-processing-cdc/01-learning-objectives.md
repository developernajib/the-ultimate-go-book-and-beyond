## Learning Objectives

1. **Understand stream processing fundamentals** - windowing types (tumbling, sliding, session), watermarks, late data handling, and stateful vs stateless processing
2. **Implement stream processors in Go** - build tumbling and sliding window aggregators using generics and goroutines
3. **Understand CDC concepts** - log-based vs query-based CDC, PostgreSQL WAL, logical replication, and why CDC underpins modern data architectures
4. **Set up Debezium for production** - configure PostgreSQL logical replication, Debezium connector, and consume the CDC envelope format in Go
5. **Implement the outbox pattern** - solve the dual-write problem with transactional outbox and CDC-based relay
6. **Build exactly-once CDC pipelines** - idempotent sinks, deduplication, and offset checkpointing
7. **Design end-to-end CDC pipelines** - PostgreSQL → Debezium → Kafka → Go transformer → ClickHouse analytics

### Junior -> FAANG: Mapping Learning Objectives to Interview Signals

Each objective in this list corresponds to a predictable interview question. Knowing the objective is not enough. Knowing the interview signal is what gets you through the bar. Here is how each objective maps to what interviewers actually test.

Objective 1 (stream processing fundamentals) is tested by asking you to explain what a watermark is and why it exists. The failure mode is saying "it's a timestamp" without explaining that it is an estimate of completeness, that it can be wrong, and that setting allowed lateness too low drops valid events while setting it too high increases end-to-end latency. Be ready to draw a timeline showing event time versus processing time with a concrete example.

Objective 2 (Go stream processors) is tested by asking you to implement a tumbling window on a whiteboard. The key insight the interviewer wants is that you track window state in a map keyed by `(partitionKey, windowStart)`, advance the watermark by `maxEventTimeSeen - allowedLateness`, and emit windows when their end time is before the watermark. They also want to hear you acknowledge that in-memory state is lost on restart and that you'd back it with Redis or move to Flink for production.

Objective 3 (CDC concepts) is tested by the classic "how would you sync a database to Elasticsearch in real time?" question. The wrong answer is polling. The right answer is log-based CDC via Debezium, with a clear explanation of why: captures deletes, maintains order, adds no read load to the OLTP path.

Objectives 5 and 6 (outbox and exactly-once) are almost always paired. Interviewers will first ask you to explain the dual-write problem, then ask how the outbox solves it, then ask why the outbox alone isn't enough. The answer to the last question is: consumers must be idempotent, because the relay can crash after publishing but before marking the outbox row as sent, causing a republish on restart.

### Senior @ FAANG: Learning Objectives as a Competency Framework

Senior engineers use learning objectives not as a checklist for themselves but as a framework for evaluating and growing the engineers on their team. Each objective in this chapter represents a competency dimension that maps to a different type of operational risk.

Objective 1 (fundamentals) maps to the risk of building pipelines that produce silently wrong results under out-of-order delivery. A team that cannot explain watermarks will build pipelines that look correct in testing, where events arrive in order, and fail in production, where mobile clients reconnect with hours of buffered events.

Objectives 3 and 4 (CDC and Debezium) map to the risk of replication slot accumulation and disk-fill incidents. A team that treats Debezium as "fire and forget" infrastructure is a P0 incident waiting to happen. Senior engineers ensure the team owns slot lag monitoring as a first-class SLO, not as an afterthought.

Objective 5 (outbox pattern) maps to the risk of event loss in business-critical workflows. At FAANG, losing an OrderShipped event means a customer does not receive their shipping notification, a fulfillment partner does not get the pick instruction, and the analytics pipeline shows a gap. The outbox pattern eliminates this class of failure. A senior engineer decides when the outbox is required (business-critical events with a transactional source) versus when it is unnecessary overhead (metrics, non-critical notifications).

Objective 7 (end-to-end pipeline design) maps to architectural decision authority. At L6/L7, you are the person who decides whether the pipeline uses JSON or Avro, whether the ClickHouse sink uses `ReplacingMergeTree` or a staging-plus-dedup pattern, and whether the Debezium connector runs in Kafka Connect or Debezium Server. These decisions have multi-year consequences. The learning objectives in this chapter provide the vocabulary and context to make and document them defensibly.

---
