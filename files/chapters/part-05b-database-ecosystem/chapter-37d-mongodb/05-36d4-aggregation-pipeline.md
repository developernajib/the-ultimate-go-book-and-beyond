## 37D.4 Aggregation Pipeline

### Complete Pipeline Examples

MongoDB's aggregation pipeline processes documents through a sequence of stages, enabling complex analytics directly on the database without pulling raw data into Go. The example below chains `$match`, `$unwind`, `$group`, and `$project` stages to produce a daily sales report, demonstrating how to push computation closer to the data.

```go
package mongodb

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// SalesAnalytics demonstrates complex aggregation pipeline
type SalesAnalytics struct {
	collection *mongo.Collection
}

// DailySalesReport generates a daily sales report
func (s *SalesAnalytics) DailySalesReport(ctx context.Context, start, end time.Time) ([]DailySales, error) {
	pipeline := mongo.Pipeline{
		// Stage 1: Filter by date range and completed status
		{{Key: "$match", Value: bson.D{
			{Key: "status", Value: "completed"},
			{Key: "created_at", Value: bson.D{
				{Key: "$gte", Value: start},
				{Key: "$lt", Value: end},
			}},
		}}},

		// Stage 2: Unwind items array to process each item
		{{Key: "$unwind", Value: "$items"}},

		// Stage 3: Group by date and calculate metrics
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{
				{Key: "$dateToString", Value: bson.D{
					{Key: "format", Value: "%Y-%m-%d"},
					{Key: "date", Value: "$created_at"},
				}},
			}},
			{Key: "total_revenue_cents", Value: bson.D{{Key: "$sum", Value: bson.D{
				{Key: "$multiply", Value: bson.A{"$items.price_cents", "$items.quantity"}},
			}}}},
			{Key: "order_count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "item_count", Value: bson.D{{Key: "$sum", Value: "$items.quantity"}}},
			{Key: "avg_order_value_cents", Value: bson.D{{Key: "$avg", Value: "$total_cents"}}},
			{Key: "unique_customers", Value: bson.D{{Key: "$addToSet", Value: "$user_id"}}},
		}}},

		// Stage 4: Project and reshape
		{{Key: "$project", Value: bson.D{
			{Key: "date", Value: "$_id"},
			{Key: "total_revenue_cents", Value: 1},
			{Key: "order_count", Value: 1},
			{Key: "item_count", Value: 1},
			{Key: "avg_order_value_cents", Value: bson.D{{Key: "$round", Value: bson.A{"$avg_order_value_cents", 0}}}},
			{Key: "customer_count", Value: bson.D{{Key: "$size", Value: "$unique_customers"}}},
			{Key: "_id", Value: 0},
		}}},

		// Stage 5: Sort by date
		{{Key: "$sort", Value: bson.D{{Key: "date", Value: 1}}}},
	}

	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("daily sales aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var results []DailySales
	if err := cursor.All(ctx, &results); err != nil {
		return nil, err
	}
	return results, nil
}

type DailySales struct {
	Date               string `bson:"date"`
	TotalRevenueCents  int64  `bson:"total_revenue_cents"`
	OrderCount         int64  `bson:"order_count"`
	ItemCount          int64  `bson:"item_count"`
	AvgOrderValueCents int64  `bson:"avg_order_value_cents"`
	CustomerCount      int    `bson:"customer_count"`
}

// TopProducts finds best-selling products with faceted results
func (s *SalesAnalytics) TopProducts(ctx context.Context, limit int) (*ProductReport, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "status", Value: "completed"}}}},
		{{Key: "$unwind", Value: "$items"}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$items.product_id"},
			{Key: "name", Value: bson.D{{Key: "$first", Value: "$items.name"}}},
			{Key: "total_sold", Value: bson.D{{Key: "$sum", Value: "$items.quantity"}}},
			{Key: "revenue_cents", Value: bson.D{{Key: "$sum", Value: bson.D{
				{Key: "$multiply", Value: bson.A{"$items.price_cents", "$items.quantity"}},
			}}}},
		}}},
		{{Key: "$sort", Value: bson.D{{Key: "total_sold", Value: -1}}}},
		// Facet: get top products and summary in one query
		{{Key: "$facet", Value: bson.D{
			{Key: "top_products", Value: bson.A{
				bson.D{{Key: "$limit", Value: limit}},
			}},
			{Key: "summary", Value: bson.A{
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: nil},
					{Key: "total_products", Value: bson.D{{Key: "$sum", Value: 1}}},
					{Key: "total_revenue_cents", Value: bson.D{{Key: "$sum", Value: "$revenue_cents"}}},
				}}},
			}},
		}}},
	}

	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var raw []struct {
		TopProducts []ProductSales `bson:"top_products"`
		Summary     []struct {
			TotalProducts     int   `bson:"total_products"`
			TotalRevenueCents int64 `bson:"total_revenue_cents"`
		} `bson:"summary"`
	}

	if err := cursor.All(ctx, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return &ProductReport{}, nil
	}

	report := &ProductReport{Products: raw[0].TopProducts}
	if len(raw[0].Summary) > 0 {
		report.TotalProducts = raw[0].Summary[0].TotalProducts
		report.TotalRevenueCents = raw[0].Summary[0].TotalRevenueCents
	}
	return report, nil
}

type ProductSales struct {
	ID           bson.ObjectID `bson:"_id"`
	Name         string        `bson:"name"`
	TotalSold    int64         `bson:"total_sold"`
	RevenueCents int64         `bson:"revenue_cents"`
}

type ProductReport struct {
	Products          []ProductSales
	TotalProducts     int
	TotalRevenueCents int64
}

// Employee represents an organizational hierarchy node
type Employee struct {
	ID        bson.ObjectID `bson:"_id"`
	Name      string        `bson:"name"`
	ManagerID bson.ObjectID `bson:"manager_id,omitempty"`
	Level     int           `bson:"level"`
}

// EmployeeRepository manages employee documents
type EmployeeRepository struct {
	collection *mongo.Collection
}
```

### Aggregation with $graphLookup (Graph Traversal)

`$graphLookup` performs recursive traversal within a single collection, making it useful for hierarchical data like org charts, category trees, or bill-of-materials structures. The `maxDepth` parameter caps recursion to prevent runaway queries, and `depthField` annotates each result with its distance from the starting document.

```go
// FindSubordinates traverses org hierarchy using $graphLookup
func (r *EmployeeRepository) FindSubordinates(ctx context.Context, managerID bson.ObjectID) ([]Employee, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "_id", Value: managerID}}}},
		{{Key: "$graphLookup", Value: bson.D{
			{Key: "from", Value: "employees"},
			{Key: "startWith", Value: "$_id"},
			{Key: "connectFromField", Value: "_id"},
			{Key: "connectToField", Value: "manager_id"},
			{Key: "as", Value: "subordinates"},
			{Key: "maxDepth", Value: 5}, // max org levels
			{Key: "depthField", Value: "level"},
		}}},
		{{Key: "$unwind", Value: "$subordinates"}},
		{{Key: "$replaceRoot", Value: bson.D{{Key: "newRoot", Value: "$subordinates"}}}},
		{{Key: "$sort", Value: bson.D{
			{Key: "level", Value: 1},
			{Key: "name", Value: 1},
		}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var employees []Employee
	return employees, cursor.All(ctx, &employees)
}
```

### Junior → FAANG: reading a pipeline like a SQL query

Think of the aggregation pipeline as SQL turned into a data-flow graph. `$match` is `WHERE`. `$group` is `GROUP BY`. `$project` is `SELECT`. `$sort` is `ORDER BY`. `$limit` is `LIMIT`. `$lookup` is `JOIN`. `$unwind` is the flatten operation you use when a document has an array and you want one output row per array element. Once you internalise this mapping, ninety percent of pipelines become readable.

The ordering of stages matters for performance. Put `$match` and `$project` as early as possible to shrink the working set before expensive stages run. Put `$sort` before `$limit` whenever you can leverage an index on the sort field, because otherwise the server has to buffer the full result set to sort it. Put `$lookup` late so it runs against the filtered document count, not the full collection. The rule of thumb is: filter first, transform second, join third, reshape last.

The `bson.D` versus `bson.M` distinction shows up hard in pipelines. `$group` stage keys must be ordered so `_id` appears first in the stage, which means you write `bson.D` with explicit key order. `bson.M` is a Go map and iteration order is not stable, which produces pipelines that appear to work in tests and fail randomly in production. The rule in Go is: pipeline stages are always `bson.D`, filter documents that are logically unordered can be `bson.M`.

Interview entry-points: "What does `$unwind` do?" (produces one output document per element of a specified array), "What is the difference between `$group` and `$bucket`?" (group bins by a discrete key, bucket bins by numeric ranges), and "Why is `$facet` useful?" (runs multiple sub-pipelines in parallel over the same input, letting you compute top-N and summary statistics in a single round trip).

### Senior @ FAANG: pipeline optimization, ETL stages, and the cost of the wrong stage order

Staff-level pipeline work starts with `explain`. Pass `options.Aggregate().SetExplain(true)` or call `db.collection.explain().aggregate(pipeline)` in the shell to see the executed plan. The critical fields are `queryPlanner.winningPlan` (shows whether `$match` pushed down to an index), `executionStats.totalKeysExamined` versus `totalDocsExamined` (ratio close to one means good index use), and the per-stage `executionTimeMillisEstimate`. If the first stage is a `COLLSCAN`, you have not pushed the filter down far enough or you do not have the right index. The 5.0+ slot-based execution engine (SBE) can change plan shapes substantively, so always re-explain after a major version upgrade.

The stage cost model every staff engineer should carry in their head:

- `$match` on an indexed field: O(log n) seek plus result fan-out. Cheap.
- `$match` without index: O(n) scan. Avoid or add index.
- `$sort` on an indexed field with preceding `$match` using the same prefix: O(k) where k is result size. Cheap.
- `$sort` without index: O(n log n) with a one hundred megabyte memory cap unless `allowDiskUse(true)` is set. Slow and potentially failing.
- `$group`: O(n) with hash table memory proportional to group cardinality. Watch for the hundred megabyte cap.
- `$lookup`: O(n_input * log n_foreign) with an indexed foreign field. O(n_input * n_foreign) without. Catastrophic if the foreign collection is unindexed or sharded.
- `$unwind`: linear in total array elements across input documents. A document with ten thousand array elements produces ten thousand pipeline rows.
- `$facet`: runs each sub-pipeline in parallel over the same input. Total memory is the sum of sub-pipeline peak memory. Avoid with large inputs.
- `$graphLookup`: O(n_visited) with depth-first traversal. The `maxDepth` cap is mandatory to prevent runaway.

The ETL stages that staff engineers reach for frequently. `$merge` is the canonical way to materialize an aggregation result back into a collection, replacing, upserting, or failing on key collision. This is how you build incrementally-maintained rollup tables without external orchestration. `$out` replaces the destination collection atomically and is appropriate for full rebuilds. `$unionWith` combines multiple source collections into a single pipeline, useful for cross-collection analytics. Chain these with change streams for a simple ELT architecture: change stream drives a worker, worker runs an incremental `$merge` pipeline, dashboards read the materialized collection. This avoids the operational burden of a separate streaming platform for most mid-scale rollup use cases.

Pipeline optimization on MongoDB 8.0 benefits from the `$expr` push-down into the index scan for certain predicates, and from the slot-based execution engine's improved group and lookup plans. Staff-level tuning checks `$indexStats` and the `$lookup` plan shape to confirm the server chose the expected index. For `$lookup` between sharded collections, prefer the `localField/foreignField` syntax over the `let`+`pipeline` form unless you need a correlated subquery, because the simpler form can be pushed down more aggressively on shards. For aggregation on time series collections, the bucket unpacking stage is inserted automatically and the window function stages (`$setWindowFields`) are heavily optimized for time-ordered data. Use `$setWindowFields` over hand-rolled `$group` plus `$unwind` whenever you need a moving average, lag, or rank computation.

The memory cap is the silent killer. Aggregation stages default to a hundred megabytes of memory each. `$group` with high cardinality, `$sort` over large inputs, and `$lookup` with `unwind` all hit this cap under load. The fix is either `allowDiskUse(true)` (spills to temp files, slower but correct) or restructuring the pipeline to reduce the working set before the expensive stage. Production pipelines that run on hot paths should never enable `allowDiskUse` silently. It converts a fast query into a slow one without alarms. Put disk-using pipelines behind a separate read preference or a dedicated analytics node, and monitor `serverStatus().metrics.aggStageCounters` for disk-use events.

For incremental analytics, the pattern of the decade is change-stream-driven `$merge`. A worker subscribes to the source collection, batches change events by key, and periodically runs a pipeline of the shape: `[match recent changes, group, merge into rollup collection with $merge]`. This pattern beats both naive recomputation and external stream processors for most workloads up to ten thousand events per second. Beyond that, move to Kafka plus Flink, but document in the ADR why the simpler pattern was insufficient.

---
