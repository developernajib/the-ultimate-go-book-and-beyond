## 37G.4 Query Patterns

### Queries, Scans, and Pagination

`Query` returns items for a fixed partition key and optionally narrows the result by a sort key expression. It is always efficient because it reads a single partition. `Scan` reads every partition in the table and should be avoided in hot paths. The exception is a parallel scan with `Segment`/`TotalSegments` for large batch exports. Pagination uses the `LastEvaluatedKey` from each response as the `ExclusiveStartKey` for the next page.

```go
package dynamodb

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// OrderRepository handles order queries
type OrderRepository struct {
	client *Client
}

// GetOrdersByUser retrieves paginated orders for a user
// Uses sort key begins_with to filter ORDER# items from USER# partition
func (r *OrderRepository) GetOrdersByUser(ctx context.Context, userID string, limit int32, lastKey map[string]types.AttributeValue) ([]Order, map[string]types.AttributeValue, error) {
	result, err := r.client.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(r.client.table),
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: "USER#" + userID},
			":prefix": &types.AttributeValueMemberS{Value: "ORDER#"},
		},
		ScanIndexForward:  aws.Bool(false), // descending by SK (newest first)
		Limit:             aws.Int32(limit),
		ExclusiveStartKey: lastKey, // pagination token
	})
	if err != nil {
		return nil, nil, fmt.Errorf("query orders: %w", err)
	}

	var orders []Order
	for _, item := range result.Items {
		var o OrderItem
		if err := attributevalue.UnmarshalMap(item, &o); err != nil {
			return nil, nil, err
		}
		orders = append(orders, fromOrderItem(o))
	}

	// result.LastEvaluatedKey is the next page token (nil if last page)
	return orders, result.LastEvaluatedKey, nil
}

// GetOrdersByStatus retrieves orders by status using GSI2
func (r *OrderRepository) GetOrdersByStatus(ctx context.Context, status string, limit int32) ([]Order, error) {
	result, err := r.client.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(r.client.table),
		IndexName:              aws.String("GSI2"),
		KeyConditionExpression: aws.String("GSI2PK = :pk"),
		FilterExpression:       aws.String("TotalCents > :minTotal"), // post-filter on non-key attr
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":       &types.AttributeValueMemberS{Value: "STATUS#" + status},
			":minTotal": &types.AttributeValueMemberN{Value: "1000"}, // 1000 cents ($10.00)
		},
		ScanIndexForward: aws.Bool(true), // ascending by GSI2SK (oldest first)
		Limit:            aws.Int32(limit),
	})
	if err != nil {
		return nil, err
	}

	var orders []Order
	for _, item := range result.Items {
		var o OrderItem
		if err := attributevalue.UnmarshalMap(item, &o); err != nil {
			return nil, err
		}
		orders = append(orders, fromOrderItem(o))
	}
	return orders, nil
}

// GetOrderWithUser retrieves order + user in a single BatchGetItem
func (r *OrderRepository) GetOrderWithUser(ctx context.Context, orderID, userID string) (*OrderWithUser, error) {
	result, err := r.client.ddb.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{
		RequestItems: map[string]types.KeysAndAttributes{
			r.client.table: {
				Keys: []map[string]types.AttributeValue{
					// Order
					{
						"PK": &types.AttributeValueMemberS{Value: "USER#" + userID},
						"SK": &types.AttributeValueMemberS{Value: "ORDER#" + orderID},
					},
					// User profile
					{
						"PK": &types.AttributeValueMemberS{Value: "USER#" + userID},
						"SK": &types.AttributeValueMemberS{Value: "PROFILE"},
					},
				},
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("batch get: %w", err)
	}

	var order OrderItem
	var user UserItem

	for _, item := range result.Responses[r.client.table] {
		sk := item["SK"].(*types.AttributeValueMemberS).Value
		switch {
		case strings.HasPrefix(sk, "ORDER#"):
			attributevalue.UnmarshalMap(item, &order)
		case sk == "PROFILE":
			attributevalue.UnmarshalMap(item, &user)
		}
	}

	return &OrderWithUser{
		Order: fromOrderItem(order),
		User:  *fromUserItem(user),
	}, nil
}

// Parallel Scan: for ETL/analytics, scan table in parallel
func (r *Client) ParallelScan(ctx context.Context, segments, totalSegments int, process func([]map[string]types.AttributeValue) error) error {
	result, err := r.ddb.Scan(ctx, &dynamodb.ScanInput{
		TableName:     aws.String(r.table),
		Segment:       aws.Int32(int32(segments)),
		TotalSegments: aws.Int32(int32(totalSegments)),
		// Filter only a specific entity type
		FilterExpression: aws.String("EntityType = :et"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":et": &types.AttributeValueMemberS{Value: "ORDER"},
		},
	})
	if err != nil {
		return err
	}

	if err := process(result.Items); err != nil {
		return err
	}

	// Handle pagination within segment
	for result.LastEvaluatedKey != nil {
		result, err = r.ddb.Scan(ctx, &dynamodb.ScanInput{
			TableName:         aws.String(r.table),
			Segment:           aws.Int32(int32(segments)),
			TotalSegments:     aws.Int32(int32(totalSegments)),
			ExclusiveStartKey: result.LastEvaluatedKey,
		})
		if err != nil {
			return err
		}
		if err := process(result.Items); err != nil {
			return err
		}
	}
	return nil
}

type OrderWithUser struct {
	Order Order
	User  User
}
```

### Junior to FAANG: Query vs Scan and the filter expression trap

The single most important sentence in DynamoDB operations: `FilterExpression` is applied after items are read, so you pay RCU for every item that matches the key condition, not for the smaller set returned after filtering. This surprises every junior who comes from SQL where `WHERE` magically narrows the search. In DynamoDB, the key condition is the index seek, and the filter is a post-processing step on already-charged bytes. A Query that reads 10000 items and filters to 10 is charged for 10000.

Worked example. The `GetOrdersByStatus` function above uses `FilterExpression: "TotalCents > :minTotal"`. If the GSI partition `STATUS#pending` has 100000 items and only 500 have `TotalCents > 1000`, the Query costs 100000 item reads worth of RCU (roughly 25000 RCUs for eventually consistent 4KB items) and returns 500. The correct fix is to model "high-value pending orders" as a sparse GSI or use a composite sort key like `GSI2SK=AMOUNT#00000002500#ORDER#id` so the key condition itself can range-scan `AMOUNT#` with a threshold. The filter becomes a key condition. Cost drops 200x.

Pagination. `LastEvaluatedKey` is a map of attribute values that the client must echo back as `ExclusiveStartKey` on the next request. It is not a stable cursor across schema changes, and it is opaque. Treat it as a blob, base64-encode it when sending to HTTP clients, and never parse it in application logic. A response with no `LastEvaluatedKey` means end of data. A response with a `LastEvaluatedKey` but zero items returned is normal and means the page was entirely filtered out by a FilterExpression. Naive pagination loops that stop on "zero items returned" have a bug that silently truncates results. The correct condition is "LastEvaluatedKey is nil".

Interview entry point. "When would you use Scan?" Answer: almost never in a hot path. Acceptable uses are one-time data exports, analytics via parallel scan, and table-wide migrations. Everything else should be a Query on the base table or a GSI. "What does ConsistentRead do on a Query?" Answer: routes to the leader, costs 2x, and is only valid on base table queries or LSI queries, never on GSI queries. "How does `ScanIndexForward` work?" Answer: false means descending by sort key, which is the right default for "newest first" timelines.

### Senior at FAANG: query cost engineering and the limits of eventual consistency

Query cost is predictable only if you measure. Turn on `ReturnConsumedCapacity: INDEXES` in every production Query and log both `ConsumedCapacity.Table` and `ConsumedCapacity.GlobalSecondaryIndexes` per call. Build a dashboard that graphs RCU per access pattern label (a string the application sets). Every access pattern should have a documented RCU budget per request, and an alert should fire when the actual RCU exceeds budget by 2x. This is how you catch regressions: a change that adds a projection, a widened filter, or a schema bloat that increases item size all show up as a cost regression before they show up as a latency regression.

Projection expressions are the second cost lever. By default, Query returns every attribute of every matched item, which means a 4KB item with 3KB of rarely-used attributes still costs a full 4KB RCU. Adding `ProjectionExpression: "PK, SK, Status, TotalCents"` reduces the network payload but does not reduce RCU, because RCU is charged on the stored item size, not the returned size. To reduce RCU, project only the needed attributes into a GSI (`Projection: KEYS_ONLY` or `INCLUDE`), which creates a physically smaller index and therefore fewer RCUs to read. The tradeoff: any query that needs a non-projected attribute must do a second GetItem against the base table, doubling latency. Staff engineers choose projections by measuring the access pattern frequency weighted by the attribute needs.

Sparse GSIs for filtered queries. The canonical optimization for "find all items in state X" when X is rare. Set the GSI partition key attribute only when the item enters state X, delete it when the item leaves. The GSI contains only the rare items, queries are O(rare set size), and the base table is untouched. Implementation detail: use `UpdateItem` with `SET GSI2PK = :val` on state entry and `REMOVE GSI2PK` on state exit. The REMOVE is critical. Setting the attribute to empty string or null keeps it in the GSI. The attribute must be absent.

GSI write amplification. Every write to the base table that touches a projected attribute incurs a corresponding write to every affected GSI. A table with 5 GSIs, each projecting the changed attribute, incurs 6 WCUs per base write (1 + 5). Under write-heavy workloads this multiplier is the dominant cost. Staff engineers audit every GSI quarterly and delete GSIs that serve low-volume access patterns, migrating those patterns to either a Scan (for analytics) or a zero-ETL Redshift export (for reporting). The 2026 zero-ETL to Redshift feature specifically exists to take reporting-grade GSIs out of the OLTP cost structure.

Consistent reads revisited. `ConsistentRead: true` on a Query doubles the cost and routes to the leader. It is the only way to guarantee read-your-write on the base table within a single region. On GSIs it is not available because the GSI is asynchronously replicated. The practical failure mode: an application writes to the base table, immediately queries a GSI, and gets a stale or empty result because the GSI has not yet caught up. The propagation is typically sub-second but can be seconds under load. The staff-grade fix is to return the written item from the write path (using `ReturnValues: ALL_NEW` on UpdateItem) so the caller does not need a follow-up read, or to use a read-your-writes strategy that caches the write in the session until GSI propagation is confirmed by retry with exponential backoff.

Pagination at scale. `LastEvaluatedKey` tokens can grow large (hundreds of bytes) because they encode the partition key, sort key, and GSI keys. HTTP APIs that pass the token in the URL must base64-url encode it and handle URL length limits. For user-facing paginated APIs with deep pagination (page 500 of 1000), the right pattern is often to switch from offset pagination to keyset pagination using an application-visible cursor (e.g., `after=ORDER#2026-04-22T10:00:00Z#abc`) that the application translates into a Query key condition. This avoids token opacity and lets the frontend handle browser back/forward naturally.

Parallel Scan for ETL, done right. The `ParallelScan` implementation above has a subtle bug: it processes one segment sequentially inside a function that claims to be parallel. The real pattern spawns N goroutines, each scanning its assigned segment from 0 to `TotalSegments-1`, with bounded concurrency and per-segment error handling. For tables at TB scale, choose TotalSegments such that each segment covers roughly 1GB: with a 10TB table, use 10000 segments and 100 concurrent workers. Rate-limit the scan itself using a token bucket sized at 50 percent of the table's available RCU, leaving headroom for production traffic. The alternative for large tables is to export to S3 using DynamoDB's native export-to-S3 feature, which reads from the continuous backup and costs nothing in RCU.

Query vs GetItem vs BatchGetItem economics. GetItem is cheapest per item but one network round trip per item. BatchGetItem batches up to 100 items and 16MB, with automatic sharding across partitions. Query returns items from one partition with one round trip and is the most economical shape when you need more than a few items from the same partition. The decision table. Need one specific item by PK+SK: GetItem. Need multiple specific items with known keys: BatchGetItem. Need a range of items from one partition: Query. Need items across many partitions matching a condition: GSI Query. Need items with no natural partition: probably a design smell, consider Scan with extreme prejudice or add a GSI.

Transactional reads and writes. `TransactGetItems` gives strongly consistent, point-in-time atomic reads across up to 100 items at 2x cost. Use it when you need consistent snapshots across items that can change independently, like reading a user's account balance and their open orders without the balance changing mid-read. `TransactWriteItems` gives atomic all-or-nothing writes with per-item conditions, used for debit-credit workflows, uniqueness enforcement across multiple entities, and state machine transitions that must not partially apply. Transactions are not free: they serialize through a transaction coordinator, have higher latency than individual writes, and can fail with `TransactionCanceledException` listing per-item reasons (condition failure, conflict, throttle). Always log the `CancellationReasons` array because it tells you exactly which item rejected.

Write-ahead patterns for hot partition avoidance on writes. When a single partition is a write hotspot (popular post, popular product inventory), the pattern is to shard writes across N pseudo-partitions and aggregate reads. For inventory: keep inventory counters at `PK=PRODUCT#id#INV#<shard>` for shard in 0..9, decrement a random shard on purchase with a conditional write, and sum across all shards when reading remaining stock. For likes: append-only write to `PK=POST#id#LIKES#<shard>#<timestamp>`, periodic Lambda aggregates into `PK=POST#id#LIKES#TOTAL`. The decision on N depends on peak write rate: target no more than 700 WCU per shard to leave headroom for adaptive capacity.

The economics of DynamoDB vs alternatives at query pattern level. For key-value lookup at 10ms p99, DynamoDB is the most cost-efficient managed option at up to roughly 10TB and 100K QPS workloads, where on-demand pricing is predictable. Above that, self-managed ScyllaDB on reserved instances is typically 40 to 70 percent cheaper, at the cost of operational burden (backup, upgrades, capacity planning). For complex analytics on top of operational data, DynamoDB plus zero-ETL to Redshift (2026 feature) eats the cost of Cassandra plus Spark plus its orchestration. For workloads that need SQL plus horizontal scale, CockroachDB Serverless or Spanner are cheaper than DynamoDB once the query shape no longer fits a single-partition Query. Staff engineers run quarterly cost reviews comparing actual DynamoDB spend against projected alternative spend, and trigger re-platforming conversations when the delta crosses 30 percent for sustained periods.

---
