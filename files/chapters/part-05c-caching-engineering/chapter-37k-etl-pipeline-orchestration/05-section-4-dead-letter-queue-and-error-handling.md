## Section 4: Dead Letter Queue and Error Handling

Dead-letter queues preserve records that fail after all retries so they can be inspected and reprocessed without blocking pipeline progress. The first design decision is **error classification**: every failure is either `retriable` (network timeout, 5xx from a sink, lock conflict, rate limit) or `permanent` (validation failed, schema mismatch, deserialization error, referential-integrity violation). Retriable errors go back into a bounded retry loop with exponential backoff plus jitter (3 attempts, 100ms to 10s is a typical envelope), while permanent errors go straight to the DLQ without wasting retries on a record that will never succeed. Conflating the two is the most common cause of poison records looping forever while real transient failures exhaust their budget.

The DLQ payload must contain enough context to debug and replay: the **raw bytes** of the original message (not the parsed struct - a future schema fix needs to re-parse), the failure reason, the pipeline version, attempt count, first-failed-at timestamp, and the source offset or primary key. Kafka dead-letter topics keyed by error type are the standard in streaming stacks. S3 JSONL works for batch. Alert on **rate-of-change** (DLQ grew 10x in 5 minutes) rather than absolute size, and ship a replay tool alongside the pipeline from day one - a DLQ without replay tooling is a log file, not a recovery mechanism.

The error-handling infrastructure below routes failed records to a dead-letter channel, persists them with failure context, and exposes a reprocessing API.

```go
package etl

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

// DLQRecord wraps a failed record with error context.
type DLQRecord struct {
	Record    Record
	Reason    string
	FailedAt  time.Time
	Attempts  int
	PipelineID string
}

// FileDLQ writes failed records to a JSONL file for manual inspection.
type FileDLQ struct {
	path string
	mu   sync.Mutex
	f    *os.File
}

func NewFileDLQ(path string) (*FileDLQ, error) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	return &FileDLQ{path: path, f: f}, nil
}

func (q *FileDLQ) Send(ctx context.Context, record Record, reason string) error {
	dlq := DLQRecord{
		Record:   record,
		Reason:   reason,
		FailedAt: time.Now(),
	}
	data, err := json.Marshal(dlq)
	if err != nil {
		return err
	}

	q.mu.Lock()
	defer q.mu.Unlock()
	q.f.Write(data)
	q.f.Write([]byte("\n"))
	return nil
}

func (q *FileDLQ) Close() error {
	return q.f.Close()
}

// KafkaDLQ sends failed records to a Kafka dead letter topic.
type KafkaDLQ struct {
	writer *kafka.Writer
}

func NewKafkaDLQ(brokers []string, topic string) *KafkaDLQ {
	return &KafkaDLQ{
		writer: &kafka.Writer{
			Addr:     kafka.TCP(brokers...),
			Topic:    topic,
			Balancer: &kafka.LeastBytes{},
		},
	}
}

func (q *KafkaDLQ) Send(ctx context.Context, record Record, reason string) error {
	dlq := DLQRecord{
		Record:   record,
		Reason:   reason,
		FailedAt: time.Now(),
	}
	data, err := json.Marshal(dlq)
	if err != nil {
		return err
	}
	return q.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(record.ID),
		Value: data,
	})
}

// RetryableStage wraps a stage with retry logic.
type RetryableStage struct {
	inner      Stage
	maxRetries int
	backoff    time.Duration
}

func NewRetryableStage(inner Stage, maxRetries int, backoff time.Duration) *RetryableStage {
	return &RetryableStage{inner: inner, maxRetries: maxRetries, backoff: backoff}
}

func (s *RetryableStage) Name() string { return s.inner.Name() + "[retry]" }

func (s *RetryableStage) Process(ctx context.Context, in <-chan Record) <-chan Record {
	out := make(chan Record, 256)
	go func() {
		defer close(out)
		for record := range in {
			var processed Record
			for attempt := 0; attempt <= s.maxRetries; attempt++ {
				ch := s.inner.Process(ctx, singleChannel(record))
				processed = <-ch
				if processed.Err == nil {
					break
				}
				if attempt < s.maxRetries {
					select {
					case <-time.After(s.backoff * time.Duration(1<<attempt)):
					case <-ctx.Done():
						return
					}
				}
			}
			select {
			case out <- processed:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func singleChannel(r Record) <-chan Record {
	ch := make(chan Record, 1)
	ch <- r
	close(ch)
	return ch
}
```

### Junior → FAANG: DLQ as a first-class pipeline output, not a log file

A dead-letter queue is not a debug dump. It is a durable, replayable, schema-aware record of every input that your pipeline refused to process, and it is treated as a first-class output of the system alongside the happy-path sink. If you show up to a FAANG interview describing the DLQ as "a file where I log errors," you will not pass the bar. Treat it the way you treat the main sink. It has a schema, it has retention, it has access control, and it has an SLO for the time between a record landing in DLQ and a human or automated replay resolving it.

Start by internalizing the error taxonomy. Transient errors are things that will succeed if retried later, such as a network timeout, a 503 from a downstream API, a Postgres deadlock, or a rate-limit rejection. Permanent errors are things that will never succeed no matter how many times you retry, such as a JSON parse failure on a malformed event, a foreign-key violation against a row that does not exist, or a schema mismatch between the producer and consumer. Semantic errors are a trickier third category. The record parses, the types line up, but the business meaning is wrong, for example a `currency` field set to `XYZ` or a `refund_amount` larger than the original `order_amount`. Data-quality errors are a fourth category, where the record is individually valid but violates a population-level invariant such as "daily row count must be within 20 percent of the 7-day median." Your retry policy maps directly onto this taxonomy. Retry transient errors with exponential backoff. Send permanent errors straight to DLQ without wasting retries. Route semantic errors to a human-review queue. Flag data-quality errors at the batch level, not the record level, because retrying a single row will not fix a population drift.

Worked example for your first job. Your pipeline ingests webhook events from a payment provider. On day one, 0.3 percent of events fail with "JSON field `amount` is a string, expected number." A junior engineer logs the error and moves on. A FAANG-track engineer does four things. First, classifies the error as permanent and routes to DLQ. Second, opens the DLQ file, sees that all failures come from one merchant who is sending `"amount": "12.50"` as a quoted string. Third, writes a schema-tolerant parser that accepts both, gated behind a feature flag and covered by a table-driven test. Fourth, replays the DLQ through the new parser and confirms zero residual failures. The entire loop from detection to replay should take under an hour once the tooling exists, and building that tooling is the point of this section.

Interview entry-points. "What is a poison pill and how do you handle it?" A poison pill is a record that causes the consumer to crash or loop forever, often because of an unexpected byte sequence or a code bug triggered by specific content. The handling pattern is a retry budget (say 3 attempts) followed by unconditional DLQ routing, plus a circuit breaker that stops the consumer if DLQ rate exceeds a threshold so one bad producer does not flood the queue. "How do you replay from DLQ safely?" Replay into the same pipeline with an idempotent sink so duplicate delivery is harmless, tag replayed records with a `replay_run_id`, and rate-limit replays so you do not DoS the destination. "Why not retry forever?" Because retries cost money, consume worker capacity, and mask real bugs. A bounded retry budget is what separates engineering from hope.

### Senior @ FAANG: DLQ semantics, retry budgets, and the economics of failure

At senior level, the DLQ is a contract between the pipeline and its operators, and the contract has to specify behavior under every combination of error class, retry state, and downstream availability. The Go code above implements the mechanics. What follows is the policy framework you must design before the mechanics matter.

Retry budget as an economic decision. Every retry costs CPU, network, downstream load, and calendar time against your freshness SLO. Model it as a budget. For a pipeline processing 100k records per second with a 2 percent transient error rate and 3 retries per failed record, you are spending an extra 6k requests per second on retries. If the downstream is a rate-limited API at 10k RPS, your retry budget alone consumes 60 percent of capacity and starves new traffic. The senior fix is a token bucket for retries that is separate from the main traffic bucket, sized at 10 to 20 percent of downstream capacity, with retries rejected (and routed to DLQ with `reason=retry_budget_exhausted`) when the bucket is empty. This is the pattern Google SRE calls "adaptive throttling" and Amazon calls "retry-after-throttle."

Poison pill containment. A single malformed record that crashes the consumer process can halt a Kafka partition indefinitely, because the consumer restarts, re-reads the same offset, crashes again, and never advances. The fix is a per-offset attempt counter persisted outside the consumer (in Redis, Postgres, or a Kafka compacted topic keyed by `(topic, partition, offset)`). After N attempts the consumer commits the offset, routes the raw bytes to DLQ with `reason=poison_pill, attempts=N`, and pages oncall if the DLQ rate exceeds a threshold. Flink implements this natively through `RestartStrategies.failureRateRestart` plus a `DeadLetterSink`. Kafka Connect offers `errors.tolerance=all` with `errors.deadletterqueue.topic.name`. In a custom Go consumer you build it yourself, and the test you must write is an injection test that produces a record guaranteed to panic the processor and asserts the consumer advances past it within N attempts.

Human-review queue versus auto-replay policy. Not every DLQ record is safe to auto-replay. A record that failed with a schema-mismatch error can be auto-replayed after the schema is updated, because the retry is deterministic. A record that failed with "inventory reservation conflict" cannot be auto-replayed without a human deciding whether the business intent is still valid. Split the DLQ into two streams at write time based on the error class. Auto-replay eligible records go to `dlq.auto.{pipeline}` with a TTL of 7 days and a cron-driven replay job that runs after each deploy. Human-review records go to `dlq.review.{pipeline}` with no TTL, and a ticket is auto-filed against the data-owner team for each unique error signature. The signature is a hash of `(error_code, stack_top_frame, schema_version)` so you are not filing 10,000 tickets for the same bug.

Error taxonomy enforcement through types. The loose `reason string` field in the code above is a smell. At scale you want a typed error hierarchy that the classifier cannot forget to handle. Define `type ErrorClass int` with `Transient, Permanent, Semantic, DataQuality, PoisonPill` and require every processor to return an error that implements `Classifier interface { Class() ErrorClass; Code() string; Retryable() bool }`. Unknown errors default to `Transient` with a bounded retry budget and a metric `etl.errors.unclassified_total` that triggers an alert, because an unclassified error means a new failure mode your taxonomy does not cover yet.

Data-quality checks as part of the loader, not after it. Great Expectations (Python) and Soda Core (Python and SQL) are the two dominant open-source data-quality engines in 2026, and both expose JSON or YAML contract formats that a Go pipeline can evaluate through a sidecar or an embedded expression engine. DBT tests (`not_null`, `unique`, `accepted_values`, `relationships`) cover the warehouse side. For upstream checks inside your Go pipeline, define expectations as declarative rules (`row_count between 0.8x and 1.2x of 7-day median`, `null_rate(user_id) < 0.001`, `max(event_timestamp) - now() < 5m`) and evaluate them at batch boundaries. Violations route the entire batch to a quarantine sink, not DLQ, because the records are individually fine but the population is wrong. Quarantined batches require human approval to release. This is what protects you from the classic "upstream pushed a bad backfill and we silently loaded 40 million garbage rows" incident.

Data contracts and schema evolution. PayPal's `data-contract-cli`, `Odd Platform`, and the open-source `datacontract-specification` give you a YAML-first contract format that covers schema, quality expectations, SLA, and ownership. Your producer publishes a contract, your pipeline validates against it at ingest, and a breaking change forces a contract version bump that downstream consumers must accept before the producer can ship. In practice the enforcement point is a CI check on the producer repo plus a runtime check in your extractor that routes contract-violating records to DLQ with `reason=contract_violation, contract_version=X`. Without contracts you are building pipelines on an implicit handshake that breaks every time a product team renames a field.

Replay tooling as a first-class deliverable. A DLQ without a replay tool is a graveyard. The replay tool must support filtering by `(error_code, time_range, source_key)`, rate limiting to protect the destination, dry-run mode that reports how many records would be replayed without writing, idempotency so a partial replay can be resumed, and audit logging of who replayed what and when. Build this tool on day one alongside the pipeline, not after the first Sev2. The FAANG bar is that any oncall engineer can replay a DLQ segment within 15 minutes of being paged, without reading the pipeline source code.

---

