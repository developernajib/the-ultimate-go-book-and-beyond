## 37G.6 DynamoDB Streams & CDC

### Event-Driven Architecture with Streams

DynamoDB Streams deliver an ordered, 24-hour log of item changes (INSERT, MODIFY, REMOVE) that can drive Lambda functions, event-driven projections, or CDC pipelines. Delivery is at-least-once and ordered per partition key, which means consumers must be idempotent and handle occasional duplicates. For higher retention (up to 365 days) or fan-out to multiple consumers, use Kinesis Data Streams for DynamoDB instead, which exposes the same change log via the Kinesis API. The consumer below is shaped as a Lambda handler (the most common deployment), but the same logic works from a long-running Go process using the `dynamodbstreams` client.

> **Senior track**: The FAANG-favourite followup on streams is "how do you back-fill a new downstream consumer for existing data?" The answer is not the stream. Streams only capture changes from the moment they are enabled forward. For existing data you need a one-time export (S3 export to a Parquet dataset, processed by Athena or Glue) merged with the stream, using a cutover sequence number. Treat this as Kappa-architecture initial-state-plus-log, not pure CDC.

```go
package dynamodb

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

// DynamoDB Streams: captures item-level changes (INSERT/MODIFY/REMOVE)
// Delivered to Lambda or via Kinesis Data Streams

// StreamEvent processes DynamoDB stream events (Lambda handler)
func StreamEventHandler(ctx context.Context, event events.DynamoDBEvent) error {
	log := slog.Default()

	for _, record := range event.Records {
		if err := processRecord(ctx, record, log); err != nil {
			log.Error("process stream record",
				"event_id", record.EventID,
				"err", err,
			)
			// Return error to retry the batch
			return err
		}
	}
	return nil
}

func processRecord(ctx context.Context, record events.DynamoDBEventRecord, log *slog.Logger) error {
	switch record.EventName {
	case "INSERT":
		return handleInsert(ctx, record, log)
	case "MODIFY":
		return handleModify(ctx, record, log)
	case "REMOVE":
		return handleRemove(ctx, record, log)
	}
	return nil
}

func handleInsert(ctx context.Context, record events.DynamoDBEventRecord, log *slog.Logger) error {
	newImage := record.Change.NewImage

	// Determine entity type from PK prefix
	pk := newImage["PK"].String()

	switch {
	case strings.HasPrefix(pk, "USER#"):
		var user UserItem
		if err := unmarshalStreamImage(newImage, &user); err != nil {
			return err
		}
		log.Info("user created", "user_id", user.UserID, "email", user.Email)
		// Trigger: send welcome email, sync to search index

	case strings.HasPrefix(pk, "ORDER#"), strings.Contains(pk, "ORDER"):
		var order OrderItem
		if err := unmarshalStreamImage(newImage, &order); err != nil {
			return err
		}
		if order.SK == "METADATA" {
			log.Info("order created", "order_id", order.OrderID, "total_cents", order.TotalCents)
			// Trigger: send confirmation email, start fulfillment
		}
	}
	return nil
}

func handleModify(ctx context.Context, record events.DynamoDBEventRecord, log *slog.Logger) error {
	newImage := record.Change.NewImage
	oldImage := record.Change.OldImage

	// Detect order status change
	if sk := newImage["SK"].String(); strings.Contains(sk, "ORDER#") {
		oldStatus := oldImage["Status"].String()
		newStatus := newImage["Status"].String()

		if oldStatus != newStatus {
			orderID := newImage["OrderID"].String()
			userID := strings.TrimPrefix(newImage["PK"].String(), "USER#")
			log.Info("order status changed",
				"order_id", orderID,
				"user_id", userID,
				"from", oldStatus,
				"to", newStatus,
			)
			// Trigger: push notification to user
		}
	}
	return nil
}

func handleRemove(ctx context.Context, record events.DynamoDBEventRecord, log *slog.Logger) error {
	oldImage := record.Change.OldImage
	pk := oldImage["PK"].String()
	log.Info("item deleted", "pk", pk)
	// Trigger: cleanup related data
	return nil
}

// unmarshalStreamImage converts DynamoDB stream image to a struct
func unmarshalStreamImage(image map[string]events.DynamoDBAttributeValue, v any) error {
	// Convert DynamoDB stream format to regular AttributeValue map
	m := make(map[string]any)
	for k, v := range image {
		m[k] = convertStreamAttr(v)
	}
	b, _ := json.Marshal(m)
	return json.Unmarshal(b, v)
}

func convertStreamAttr(v events.DynamoDBAttributeValue) any {
	switch v.DataType() {
	case events.DataTypeString:
		return v.String()
	case events.DataTypeNumber:
		n := v.Number()
		if i, err := strconv.ParseInt(n, 10, 64); err == nil {
			return i
		}
		if f, err := strconv.ParseFloat(n, 64); err == nil {
			return f
		}
		return n
	case events.DataTypeBoolean:
		return v.Boolean()
	case events.DataTypeNull:
		return nil
	case events.DataTypeList:
		list := make([]any, len(v.List()))
		for i, item := range v.List() {
			list[i] = convertStreamAttr(item)
		}
		return list
	case events.DataTypeMap:
		m := make(map[string]any)
		for k, val := range v.Map() {
			m[k] = convertStreamAttr(val)
		}
		return m
	}
	return nil
}
```

### Junior to FAANG: Streams and CDC Entry Point

The first thing to internalize about DynamoDB Streams is that they are not a message queue and not a durable event store. They are a 24-hour change log with at-least-once delivery and per-partition-key ordering. Every design choice downstream follows from those three facts.

At-least-once means your consumer will occasionally see the same record twice. Junior code that inserts a row into a search index on every `INSERT` event will produce duplicates in production the first time a shard iterator retries. The fix is idempotency, and the cheapest form is to use the event's composite key (`EventID` plus item primary key) as the deduplication token. Store it in a small "processed events" table with a TTL of 48 hours (double the stream retention), and skip any event whose token is already there. For very high throughput, use a Bloom filter in front of the table to cut reads.

Per-partition-key ordering means you will see events for a single item in the order they happened, but events for different items can interleave arbitrarily across shards. Junior engineers sometimes try to reconstruct global ordering from the stream and then wonder why their projections drift. If your downstream consumer needs causal ordering across items (for example, an order event must land after the user creation event), you need a different mechanism, typically a secondary index or a join in the consumer.

The 24-hour retention is the biggest operational trap. If your Lambda consumer is broken for more than 24 hours (failed deploy, permission error, throttling), records fall off the end of the stream and are gone. You detect this only by watching the `IteratorAge` CloudWatch metric. Any on-call runbook for a stream-consuming service must have `IteratorAge > 6h` as a paging alert, with a documented recovery procedure that includes the S3 export backfill mentioned above.

For first-job CDC work, the pattern you will build most often is DynamoDB to OpenSearch or DynamoDB to an analytics warehouse. The worked example above is the basic shape. What makes it production-grade is three additions:

1. Dead letter queue. Configure the Lambda event source mapping with `OnFailure` pointing at an SQS DLQ. Records that fail after the configured retry count land there for manual inspection, instead of blocking the shard forever.
2. Batch size tuning. The default batch size of 100 is usually wrong. For heavy per-record work, drop to 10 to limit the blast radius of a poison message. For light work, raise to 500 with `MaximumBatchingWindowInSeconds` of 5 to improve throughput.
3. Bisect on error. Enable `BisectBatchOnFunctionError` so a bad record does not fail its entire batch. The service will split and retry, isolating the poison pill.

Interview framing at entry level: "Design a real-time feed that updates a leaderboard when users score points." The junior answer is "DynamoDB Streams to Lambda to ElastiCache." The bar-raiser upgrade is "and here is how I handle duplicates (idempotency key on the processed-events table), here is how I alert on stream lag (`IteratorAge`), and here is how I back-fill the leaderboard if the consumer is broken (S3 export plus replay from the last known sequence number)."

### Senior at FAANG: CDC Architecture, Exactly-Once, and the Zero-ETL Decision

At staff level, the conversation about DynamoDB change data capture is about which of four options you choose and why. The options are (1) DynamoDB Streams plus Lambda, (2) Kinesis Data Streams for DynamoDB, (3) EventBridge Pipes, and (4) zero-ETL to Redshift or OpenSearch. Each has a distinct cost model, retention window, fan-out behavior, and operational burden. A senior design doc names the option, names the alternatives rejected, and names the invariants that drove the choice.

DynamoDB Streams plus Lambda is the default and the cheapest at low volume. The stream itself is free, you pay only for Lambda invocations and GB-seconds. Retention is fixed at 24 hours, fan-out is limited to two concurrent consumers per shard, and there is no way to replay beyond the window. Use it when you have one or two well-known consumers and the cost of a 24-hour outage is tolerable.

Kinesis Data Streams for DynamoDB is the right answer when you need longer retention (up to 365 days), more than two consumers, or integration with a broader Kinesis-based analytics stack. You pay for shard-hours and PUT payload units on top of the DynamoDB capacity, which at scale can exceed the DynamoDB bill itself. The critical operational win is enhanced fan-out, which gives each consumer its own 2 MB/s per shard instead of sharing. For a data platform with five or more downstream consumers, this is non-negotiable.

EventBridge Pipes entered GA in 2023 and is now the integration of choice when your target is a specific AWS service (Step Functions, SQS, another EventBridge bus) and you want filtering and transformation without writing Lambda code. The filter runs before invocation, so you only pay for the events you actually process. The gotcha is that complex transformations still need an enrichment step, which is usually a Lambda, which erases most of the cost advantage. Use Pipes for simple routing and filtering, not for heavy transformation.

Zero-ETL to Redshift is the 2023-2024 feature that changed analytics architectures on DynamoDB. Writes replicate into Redshift tables within seconds with no customer-managed pipeline. For a reporting workload, this eliminates the entire Glue plus S3 plus Athena stack that used to sit in the middle. The caveats are important. Zero-ETL is one-way only (no Redshift-to-DynamoDB), requires the tables to be in the same AWS Organization, and incurs Redshift storage and compute costs that are separate from the DynamoDB bill. For HTAP-style workloads where you want the same table queried transactionally and analytically, zero-ETL is the right answer. For streaming CDC into a data lake outside AWS, it is not a fit and you are back to Kinesis.

Exactly-once semantics deserve their own paragraph. DynamoDB Streams are at-least-once, full stop. Exactly-once in your consumer is an application-level property built on three ingredients: a deterministic idempotency key derived from the event, an idempotent sink operation (upsert, not insert), and a dedup store with a TTL longer than the stream retention. The third is the one senior engineers get wrong most often. If your TTL is 24 hours and your stream retention is also 24 hours, a replay after a consumer outage will re-deliver events whose dedup records have just expired, and you will get duplicates. Set the TTL to at least 2x the retention, or use an idempotent sink (Redshift `MERGE`, OpenSearch `_update` with document versioning, S3 object key derived from the event ID) that is tolerant of exact re-delivery.

Global Tables and CDC interact in a way that surprises many senior engineers. When Global Tables replicate a write from region A to region B, the write appears in region B's local stream as a separate event, and any consumer attached to region B's stream will process it. If your consumer pushes to a shared downstream (say, a global Redshift cluster), you will get duplicates equal to the number of regions. The two mitigations are (a) run the consumer in one region only, with cross-region failover on the consumer itself, or (b) filter by the `aws:rep:updateregion` metadata attribute so each region only processes its own originations. The first is simpler, the second is necessary when you want active-active consumers.

Outbox pattern with streams is the staff-level design for reliable event publication across DynamoDB and an external broker like Kafka or MSK. Writes land in DynamoDB as part of a transaction that also writes an outbox record. A Lambda consumer of the stream reads the outbox record and publishes to Kafka, with idempotency keyed on the outbox record ID. The outbox record TTLs out after publication is confirmed. This gives you transactional integrity between the primary write and the event, without requiring XA or distributed transactions. When an interviewer asks "how do you publish an order-placed event atomically with the order write," this is the answer.

Cost modeling at scale. At 10,000 writes per second with a 1 KB average item, DynamoDB costs roughly $5K per month on-demand. The stream itself is free. A Lambda consumer at 100 ms per batch of 100 adds roughly $1K per month. Kinesis Data Streams for DynamoDB at the same volume adds roughly $3K per month in shard and PUT costs, plus another $1K per enhanced fan-out consumer. Zero-ETL to Redshift is billed as DynamoDB replicas with a flat per-table fee plus Redshift compute. Staff engineers who can sketch this cost envelope on a whiteboard without looking at the calculator get trusted with the architecture decision. Those who cannot tend to optimize the wrong component.

Finally, the operational discipline. Every stream consumer must have (a) an `IteratorAge` alert at 6 hours, (b) a DLQ with its own alert on depth greater than zero, (c) a `ProvisionedThroughputExceeded` alert on the source table that paginates into the consumer, (d) a documented runbook for a 24-hour outage including the S3 export plus replay procedure, and (e) a chaos test that kills the consumer for 25 hours and verifies the backfill procedure works end to end. Skip any of these and you will lose data, usually on a weekend.

---

