## 52I.6 Exactly-Once CDC Processing

> **Senior track**: Debezium and Kafka's default delivery is at-least-once. End-to-end exactly-once is achieved by idempotent sinks, not by a magic flag. Prefer `source.lsn` (Postgres) or `source.file + source.pos` (MySQL binlog) as the dedup key. they are stable across reprocessing and re-snapshots. `topic:partition:offset` changes if the connector re-snapshots, so it's a weaker key. For Kafka-to-Kafka stages you can use Kafka transactions (`transactional.id` + `isolation.level=read_committed`) to get Kafka's own EOS, but external sinks (ClickHouse, Elasticsearch, HTTP) sit outside that transaction and must still be idempotent.

### Idempotent Sink Strategies

An exactly-once CDC pipeline requires idempotent sinks: applying the same change event twice must produce the same result as applying it once. The `ElasticsearchSink` below achieves idempotency by indexing with an explicit document ID (overwriting with identical data is a no-op). For sinks that lack built-in upsert semantics, the `DeduplicationStore` uses Redis `SETNX` with the Kafka `topic:partition:offset` triple as a globally unique key to reject already-processed events.

```go
package sink

import (
    "context"
    "fmt"

    "github.com/elastic/go-elasticsearch/v8"
    "github.com/elastic/go-elasticsearch/v8/esapi"
    "github.com/redis/go-redis/v9"
)

// ElasticsearchSink upserts documents - inherently idempotent
type ElasticsearchSink struct {
    client *elasticsearch.Client
    index  string
}

// Upsert uses the document ID as the idempotency key
// If the same CDC event is processed twice, ES will just overwrite with same data
func (s *ElasticsearchSink) Upsert(ctx context.Context, docID string, doc any) error {
    // Index request with explicit ID = idempotent upsert
    body := esapi.IndexRequest{
        Index:      s.index,
        DocumentID: docID,
        // Body: encode doc as JSON reader
    }
    _ = body
    return nil
}

// DeduplicationStore prevents reprocessing CDC events
type DeduplicationStore struct {
    redis *redis.Client
    ttl   int // seconds, should be >= kafka retention
}

func NewDeduplicationStore(r *redis.Client, ttlSeconds int) *DeduplicationStore {
    return &DeduplicationStore{redis: r, ttl: ttlSeconds}
}

// IsDuplicate returns true if this CDC event was already processed
// Key format: topic:partition:offset (globally unique in Kafka)
func (d *DeduplicationStore) IsDuplicate(ctx context.Context, topic string, partition int32, offset int64) (bool, error) {
    key := fmt.Sprintf("cdc:dedup:%s:%d:%d", topic, partition, offset)
    result, err := d.redis.SetNX(ctx, key, "1", 0).Result()
    if err != nil {
        return false, fmt.Errorf("redis setnx: %w", err)
    }
    // SetNX returns true if key was SET (first time), false if it already existed
    return !result, nil
}
```

### Junior -> FAANG: Exactly-Once Is a Contract, Not a Flag

The most common misconception junior engineers have about exactly-once processing is that it is something you enable, like a configuration toggle. In reality, exactly-once is a contract between every component in the pipeline, and each component must uphold its part of the contract.

Debezium is at-least-once. If Debezium crashes after publishing a change event to Kafka but before flushing its offset to the `connect-offsets` topic, it will re-emit that event on restart. This is not a bug. It is the documented behavior of at-least-once delivery.

Kafka's idempotent producer and consumer transactions give exactly-once within Kafka. If you are consuming from one Kafka topic and producing to another, you can use Kafka transactions to ensure that a consumed record is atomically committed and a produced record is sent, with no duplicates and no gaps. But this only works when both source and destination are Kafka. The moment you write to an external sink (ClickHouse, Elasticsearch, PostgreSQL, Redis, an HTTP API), you step outside the Kafka transaction and you are back to at-least-once.

For external sinks, the only mechanism for exactly-once behavior is an idempotent sink operation. The sink must be designed so that applying the same change event twice produces the same result as applying it once. For Elasticsearch, this is a `PUT /<index>/_doc/<id>`, which overwrites. For PostgreSQL, this is `INSERT ... ON CONFLICT DO UPDATE`. For ClickHouse, this is `ReplacingMergeTree` with a version column. For a sink that has no native upsert mechanism, the `DeduplicationStore` in this section provides application-level deduplication using Redis `SETNX`.

The dedup TTL is a critical parameter that junior engineers often overlook. The TTL on the Redis dedup key must be at least as long as the Kafka topic retention. If the TTL is shorter, an old event can be replayed (because Kafka still has it) but the Redis key has expired, so the dedup check passes and the event is applied a second time.

### Senior @ FAANG: Designing Exactly-Once Contracts Across Team Boundaries

At the senior level, exactly-once is not just a technical problem in a single pipeline. It is a contract that must be negotiated and documented across team boundaries, because CDC pipelines cross team ownership boundaries by design.

**The dedup key stability problem.** The `DeduplicationStore` in this section uses `topic:partition:offset` as the dedup key. This key is stable as long as the Kafka topic configuration does not change. If Debezium re-snapshots (because the slot was invalidated), the snapshot events have new offsets, and the dedup store will not recognize them as duplicates of previously processed events. The consumer will apply them again. For an idempotent sink (upsert by primary key), this is fine: the re-application produces the same result. For a non-idempotent operation (sending a notification, charging a payment method), this is a serious bug. The correct dedup key for non-idempotent operations is `source.lsn` (PostgreSQL) or `source.file + source.pos` (MySQL binlog), because these values are stable across Debezium restarts and re-snapshots.

**The dedup TTL and Kafka retention alignment.** This alignment must be enforced at the platform level, not left to individual teams. If the Kafka topic retention is 7 days but the dedup TTL is 24 hours, any consumer reset that replays more than 24 hours of history will apply old events to non-idempotent sinks without triggering the dedup check. A platform-level policy should require that dedup TTLs are configured based on the corresponding topic's retention, with an explicit override process for cases where the TTL must be shorter for memory or cost reasons.

**Non-idempotent sinks: the hardest exactly-once problem.** Idempotent sinks (databases with upsert, key-value stores, search indexes) are straightforward. Non-idempotent sinks are where exactly-once becomes genuinely hard. Sending an email is the canonical example: you cannot "un-send" an email, and sending it twice is a user-facing bug. The engineering solution is to record the dedup key in a durable store (not Redis, which can lose data on restart, but a transactional database) inside the same transaction as any side effects that can be transactionally grouped. For operations that cannot be transactionally grouped with a database write (the email send itself, a payment capture), the pattern is: write a "pending notification" row to the database, commit, then publish the notification via a process that deduplicates on the "pending notification" row's ID. This adds a layer of indirection but provides durable deduplication without relying on Redis TTLs.

**Kafka transactions for Kafka-to-Kafka pipelines.** When a Go consumer reads from a Kafka topic and produces to another Kafka topic as part of the same logical operation, Kafka's transactional producer provides exactly-once semantics within Kafka. This requires configuring the producer with a `transactional.id` (stable across restarts for the same logical stream), using `BeginTransaction` / `CommitTransaction` around the consume-produce loop, and consuming from the source topic with `isolation.level=read_committed`. franz-go supports Kafka transactions, but the error handling is more complex than non-transactional production: a `TxnAbortNeeded` error requires the transaction to be aborted and retried from the last committed consumer offset. A senior engineer ensures that the transaction handling is correct before shipping a Kafka-to-Kafka EOS pipeline to production, because silent corruption from incorrect transaction handling is worse than acknowledged at-least-once delivery.

**Audit and reconciliation as a safety net.** Even with idempotent sinks and stable dedup keys, exactly-once is probabilistic at the system boundary. A periodic reconciliation job that counts rows in the source and sink, compares checksums on sampled records, and alerts on divergence is the production safety net. This is not an admission that the exactly-once design is wrong. It is the operational check that the design is behaving as expected under real-world conditions. For regulated workloads (payments, financial reporting), this reconciliation is not optional.

---
