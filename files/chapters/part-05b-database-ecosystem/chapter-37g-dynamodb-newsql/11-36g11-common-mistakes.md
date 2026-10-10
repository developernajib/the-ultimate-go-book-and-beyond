## 37G.11 Common Mistakes

### 1. Hot Partition Key in DynamoDB

Each DynamoDB partition is capped at 3,000 RCU and 1,000 WCU per second. Using a low-cardinality value like today's date as the partition key funnels all traffic to a single partition and causes throttling during spikes. Distributing by a high-cardinality key (order UUID) and placing the date in a GSI spreads the write load evenly while still supporting date-range queries.

```go
// BAD: using a low-cardinality value as partition key
// All orders for a given DATE go to the same partition
type OrderItem struct {
    PK string // "DATE#2026-03-13" ← ALL today's orders on one partition!
    SK string // order id
}
// DynamoDB limit: 3,000 RCU or 1,000 WCU per second per partition
// On Black Friday: thousands of orders/second → throttled

// GOOD: distribute by order ID (high cardinality)
type OrderItem struct {
    PK string // "ORDER#<uuid>"
    SK string // "METADATA"
    // Use GSI for date-based queries
    GSI1PK string // "DATE#2026-03-13" (GSI can absorb moderate load)
    GSI1SK string // timestamp + order_id
}
```

### 2. Ignoring DynamoDB Item Size Limit

DynamoDB enforces a hard 400 KB item limit. Exceeding it causes a `ValidationException` at write time, not a silent truncation. Large binary payloads (PDFs, images, HTML content) should be stored in S3 with the DynamoDB item holding only the bucket name, object key, size, and a content hash for integrity verification.

```go
// BAD: storing large blobs in DynamoDB
type Document struct {
    PK      string
    SK      string
    Content string // could be megabytes of content
}
// DynamoDB: 400KB per item - content exceeding this causes ValidationException

// GOOD: store large content in S3, reference in DynamoDB
type Document struct {
    PK        string
    SK        string
    S3Bucket  string
    S3Key     string
    SizeBytes int64
    ContentHash string // for integrity verification
}
```

### 3. Scan Instead of Query in DynamoDB

`Scan` reads every item in the table regardless of any `FilterExpression`. Filters are applied after the read, so you pay for capacity consumed on all items even when only a fraction match. Creating a GSI with the desired filter attribute as its partition key converts a full-table `Scan` into an efficient `Query` against the GSI.

```go
// BAD: Scan reads the ENTIRE table - O(n) and expensive
result, _ := client.Scan(ctx, &dynamodb.ScanInput{
    TableName: aws.String(table),
    FilterExpression: aws.String("Status = :s"),
    ExpressionAttributeValues: map[string]types.AttributeValue{
        ":s": &types.AttributeValueMemberS{Value: "pending"},
    },
})
// For 1M items: reads all 1M items even if only 100 match

// GOOD: create a GSI for the query pattern
// GSI: PK=STATUS#<status>, SK=<timestamp>
// Then use Query instead of Scan
result, _ := client.Query(ctx, &dynamodb.QueryInput{
    TableName: aws.String(table),
    IndexName: aws.String("StatusIndex"),
    KeyConditionExpression: aws.String("GSI_PK = :pk"),
    ExpressionAttributeValues: map[string]types.AttributeValue{
        ":pk": &types.AttributeValueMemberS{Value: "STATUS#pending"},
    },
})
```

### 4. Not Using Connection Pooling in NewSQL

Opening a new database connection per request adds 10-100ms of TCP handshake and TLS negotiation overhead on every call. NewSQL databases like CockroachDB use the standard `database/sql` package, which provides built-in connection pooling. Configuring `MaxOpenConns`, `MaxIdleConns`, and `ConnMaxLifetime` on a shared `*sql.DB` instance lets goroutines reuse connections under high concurrency without exhausting resources.

```go
// BAD: creating a new connection per request
func GetOrders(ctx context.Context, dsn string) ([]Order, error) {
    db, err := sql.Open("postgres", dsn) // new connection every call!
    defer db.Close()
    // ...
}
// Creates new TCP connections → adds 10-100ms per request

// GOOD: share a pool across the application lifecycle
var globalDB *sql.DB

func init() {
    globalDB, _ = sql.Open("postgres", dsn)
    globalDB.SetMaxOpenConns(25)
    globalDB.SetMaxIdleConns(5)
    globalDB.SetConnMaxLifetime(5 * time.Minute)
}
```

### 5. Not Using Exponential Backoff for DynamoDB Throttling

When DynamoDB returns `ProvisionedThroughputExceededException`, immediately retrying at full rate worsens the throttle by hammering an already-overloaded partition. AWS SDK v2's `RetryModeAdaptive` adjusts the send rate dynamically based on observed throttling, spreading retries using exponential backoff with jitter without any manual implementation.

```go
// BAD: no retry on ProvisionedThroughputExceededException
result, err := client.PutItem(ctx, input)
if err != nil {
    return err // immediately fail
}

// GOOD: AWS SDK v2 has built-in retry with exponential backoff
// Configure at client creation:
cfg, _ := config.LoadDefaultConfig(ctx,
    config.WithRetryMaxAttempts(5),
    config.WithRetryMode(aws.RetryModeAdaptive), // adapts to throttling
)
// Adaptive retry mode automatically adjusts the rate to prevent throttling
```

### Junior to FAANG: The "Why Did This Fail" Reflex for DynamoDB

Every failure mode above has a shape. Learn the shapes first, the code second. Hot partition means one logical key absorbed the traffic the cluster expected to spread over thousands. Scan-instead-of-query means you paid linear cost for a logarithmic access pattern. Wrong PK means your single-table design cannot answer the question you actually need to answer without a scan or a migration. Eventually consistent GSI confusion means you wrote to the base table, read from the GSI 20 milliseconds later, and got stale data, then filed a bug against the wrong system.

Worked example of the GSI consistency trap. A junior engineer writes an OrderCreated item to the base table and in the same request reads back the order using a query on a GSI. The read returns empty. They add a retry loop. The retry loop masks the real issue, which is that GSIs are asynchronously replicated from the base table. The production fix is to read the item back using GetItem on the base table primary key if you need read-your-write, or to defer the GSI read into a later step of the workflow (for example, from a Streams consumer or a background lookup) where a 100 millisecond skew is acceptable. The interview signal is whether you name "GSI is eventually consistent" before the interviewer has to prompt you.

Worked example of transaction misuse. Engineer wraps a single-item conditional write in TransactWriteItems to feel safe. They now pay double the WCU (transactions cost 2x) and get worse tail latency for no added correctness, because a single PutItem with a ConditionExpression already provides atomic compare-and-set on one item. TransactWriteItems earns its cost only when you need all-or-nothing across two or more items or tables.

First-job context. On your first team you will inherit a table that someone designed before they understood partition keys. Your job is not to rewrite it on day one. Your job is to instrument it with CloudWatch metrics on ThrottledRequests, SystemErrors, UserErrors, and ConsumedReadCapacityUnits per GSI, then present a short memo listing the three most expensive access patterns, the two tables with hot partitions, and the one item class that should move to S3. That memo is how you graduate from a junior engineer to a trusted owner of the system.

Interview entry point. Name the mistake, name the metric that would have caught it, name the fix. For a hot partition, the metric is per-partition throttle plus ConsumedWriteCapacityUnits skew across partitions, and the fix is write sharding (suffix the PK with a hash bucket) or re-keying. For a scan, the metric is ConsumedReadCapacityUnits relative to ScannedCount versus Count returned, and the fix is a GSI or a rewrite to Query.

### Senior at FAANG: Mistakes as Governance Failures and Review Bars

At senior level, each of these mistakes is a signal that a review bar failed, not that an engineer failed. A hot partition in production means your schema review did not require a partition-distribution analysis. A Scan in a hot path means your query-review checklist does not require explaining why a GSI was rejected. Wrong capacity mode (on-demand for steady 80 percent utilized traffic, or provisioned for bursty unpredictable traffic) means your cost-review cadence is too loose. Ignoring PartiQL or Streams-to-analytics means your data platform has no paved road for analytical access and every team is reinventing export pipelines.

Bar-raiser-grade mistake taxonomy. Tier 1 (data loss or availability impact). Missing point-in-time recovery. Missing cross-region backup. No tested restore runbook. Un-versioned TTL attributes that delete live data because someone reused a field name. Tier 2 (cost blast). On-demand mode for a predictable 10K WCU steady workload (burn rate roughly 7x higher than provisioned with autoscaling). Over-provisioned GSIs that project ALL when KEYS_ONLY would serve the query. Full-table Scans running on a schedule from a reporting job that should read an export in S3. Tier 3 (correctness subtle). Condition expressions that use attribute_not_exists without a sort key, creating a race between two writers. TransactWriteItems used where idempotent upsert with a client-token would be cheaper and equally correct. Mixing strongly consistent reads on base table with eventual reads on a GSI in the same code path without documenting why.

ADR pattern for capacity mode. Context: workload X has a measured p50 and p99 WCU over 30 days. Options: on-demand, provisioned with autoscaling floor or ceiling, reserved capacity plus provisioned. Decision: provisioned with autoscaling at target 70 percent utilization, floor at measured p50, ceiling at 1.5x measured p99, with a monthly review. Consequences: we accept brief throttles during unusual spikes and we buy back cost predictability. Validation: run a 24 hour load test at p99 plus 25 percent and verify throttle count stays under budget.

Review bars worth codifying. No new table without a written access-pattern catalog (list every query, every write, and the key used). No new GSI without a projected-attributes justification. No new on-demand table above 1K sustained WCU without a cost comparison against provisioned. No Scan in a synchronous user request path without an exception granted in writing. Every production table has PITR enabled and a documented RTO and RPO. Every Streams-consuming lambda has a DLQ and an age-of-oldest-message alarm.

Migration playbook for Postgres to DynamoDB (the classic bar-raiser scenario). Phase 1 is access-pattern inventory. Phase 2 is dual-write behind a feature flag with async compare. Phase 3 is shadow-read with diff logging. Phase 4 is read cutover by cohort. Phase 5 is write cutover with Postgres kept read-only for 30 days as an escape hatch. Phase 6 is decommission. Skipping any phase is how you end up on an outage postmortem.

---
