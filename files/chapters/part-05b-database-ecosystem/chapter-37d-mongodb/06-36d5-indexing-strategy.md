## 37D.5 Indexing Strategy

### Index Types and Creation

MongoDB supports several index types, each optimized for a different access pattern: unique indexes enforce constraints, compound indexes cover multi-field queries, partial indexes reduce storage by indexing only matching documents, TTL indexes auto-expire data, text indexes support keyword search, and 2dsphere indexes handle geospatial queries. The `EnsureIndexes` function below creates all of these idempotently at application startup.

### The ESR Rule for Compound Index Ordering

Compound index field order is load-bearing: the wrong order forces a scan, the right order yields an IXSCAN with no in-memory sort. MongoDB's canonical guidance is **ESR: Equality, Sort, Range**.

1. **Equality** fields first (`{status: "active"}`, `{tenant_id: ObjectId(...)}`) - the query filters to an exact value, narrowing the index scan most aggressively.
2. **Sort** fields next (`created_at: -1`), in the direction the query requires. If the sort direction matches the index direction (or its exact reverse), MongoDB walks the index in order and skips the blocking in-memory sort (default cap 100 MB).
3. **Range** fields last (`price: {$gte: 10, $lte: 100}`, `created_at: {$gte: ...}`). Range predicates cannot further narrow the index for subsequent fields, so they belong at the end.

Example: a query `find({tenant_id, status: "active", price: {$gte: 10}}).sort({created_at: -1})` is served optimally by `{tenant_id: 1, status: 1, created_at: -1, price: 1}`.

**Covered queries:** if every field the query reads (filter, sort, and projection) lives in the index, MongoDB returns results straight from the index without touching the collection. Add projected fields to the index tail (after ESR) and use `.SetProjection(bson.D{{"_id", 0}, {"field", 1}})` to opt out of `_id` when it is not in the index.

```go
package mongodb

import (
	"context"
	"log/slog"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// IndexManager handles index lifecycle
type IndexManager struct {
	db  *mongo.Database
	log *slog.Logger
}

// EnsureIndexes creates all required indexes (idempotent)
func (m *IndexManager) EnsureIndexes(ctx context.Context) error {
	indexes := map[string][]mongo.IndexModel{
		"users": {
			// Unique index on email
			{
				Keys:    bson.D{{Key: "email", Value: 1}},
				Options: options.Index().SetUnique(true).SetName("idx_email_unique"),
			},
			// Compound index for authentication query
			{
				Keys:    bson.D{{Key: "email", Value: 1}, {Key: "active", Value: 1}},
				Options: options.Index().SetName("idx_email_active"),
			},
			// Sparse index: only index docs where field exists
			{
				Keys:    bson.D{{Key: "google_id", Value: 1}},
				Options: options.Index().SetSparse(true).SetName("idx_google_id"),
			},
			// TTL index: auto-delete expired sessions
			{
				Keys:    bson.D{{Key: "expires_at", Value: 1}},
				Options: options.Index().SetExpireAfterSeconds(0).SetName("idx_expires_ttl"),
			},
		},
		"orders": {
			// Compound index for common query pattern
			{
				Keys: bson.D{
					{Key: "user_id", Value: 1},
					{Key: "status", Value: 1},
					{Key: "created_at", Value: -1},
				},
				Options: options.Index().SetName("idx_user_status_date"),
			},
			// Partial index: only index active orders
			{
				Keys: bson.D{{Key: "total_cents", Value: 1}},
				Options: options.Index().
					SetPartialFilterExpression(bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"pending", "processing"}}}}}).
					SetName("idx_active_orders_total_cents"),
			},
		},
		"products": {
			// Text index for search
			{
				Keys: bson.D{
					{Key: "name", Value: "text"},
					{Key: "description", Value: "text"},
					{Key: "tags", Value: "text"},
				},
				Options: options.Index().
					SetWeights(bson.D{
						{Key: "name", Value: 10},
						{Key: "tags", Value: 5},
						{Key: "description", Value: 1},
					}).
					SetDefaultLanguage("english").
					SetName("idx_product_search"),
			},
			// 2dsphere index for geospatial queries
			{
				Keys:    bson.D{{Key: "location", Value: "2dsphere"}},
				Options: options.Index().SetName("idx_location_geo"),
			},
		},
		"events": {
			// Hashed index for even sharding
			{
				Keys:    bson.D{{Key: "user_id", Value: "hashed"}},
				Options: options.Index().SetName("idx_user_id_hashed"),
			},
		},
	}

	for collName, idxModels := range indexes {
		coll := m.db.Collection(collName)
		names, err := coll.Indexes().CreateMany(ctx, idxModels)
		if err != nil {
			return fmt.Errorf("create indexes for %s: %w", collName, err)
		}
		m.log.Info("indexes ensured", "collection", collName, "count", len(names))
	}
	return nil
}

// ExplainQuery explains query execution plan
func (m *IndexManager) ExplainQuery(ctx context.Context, collName string, filter bson.D) (bson.M, error) {
	coll := m.db.Collection(collName)

	command := bson.D{
		{Key: "explain", Value: bson.D{
			{Key: "find", Value: collName},
			{Key: "filter", Value: filter},
		}},
		{Key: "verbosity", Value: "executionStats"},
	}

	var result bson.M
	if err := m.db.RunCommand(ctx, command).Decode(&result); err != nil {
		return nil, fmt.Errorf("explain: %w", err)
	}
	return result, nil
}

// Geospatial query example
func FindNearbyStores(ctx context.Context, coll *mongo.Collection, lng, lat, maxDistMeters float64) ([]Store, error) {
	filter := bson.D{
		{Key: "location", Value: bson.D{
			{Key: "$near", Value: bson.D{
				{Key: "$geometry", Value: bson.D{
					{Key: "type", Value: "Point"},
					{Key: "coordinates", Value: bson.A{lng, lat}},
				}},
				{Key: "$maxDistance", Value: maxDistMeters},
			}},
		}},
		{Key: "active", Value: true},
	}

	cursor, err := coll.Find(ctx, filter, options.Find().SetLimit(10))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var stores []Store
	return stores, cursor.All(ctx, &stores)
}

type Store struct {
	BaseDocument `bson:",inline"`
	Name         string  `bson:"name"`
	Location     GeoPoint `bson:"location"`
	Active       bool    `bson:"active"`
}

// Full-text search
func SearchProducts(ctx context.Context, coll *mongo.Collection, query string, limit int64) ([]Product, error) {
	filter := bson.D{
		{Key: "$text", Value: bson.D{{Key: "$search", Value: query}}},
	}
	projection := bson.D{
		{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}},
	}
	sort := bson.D{
		{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}},
	}

	opts := options.Find().
		SetProjection(projection).
		SetSort(sort).
		SetLimit(limit)

	cursor, err := coll.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var products []Product
	return products, cursor.All(ctx, &products)
}

type Product struct {
	BaseDocument `bson:",inline"`
	Name         string   `bson:"name"`
	Description  string   `bson:"description"`
	Tags         []string `bson:"tags"`
	PriceCents   int64    `bson:"price_cents"`
	Score        float64  `bson:"score,omitempty"` // text search score
}
```

### Junior → FAANG: ESR and the five indexes you actually need

The ESR rule is the single most important thing a junior engineer can memorize about MongoDB indexing. Write it on a sticky note on your monitor. Equality fields first, Sort field next, Range fields last. Every interview will ask some variation of this, and every slow query review will come down to an index that violated ESR. A worked example: the query `find({tenant_id: X, status: "active"}).sort({created_at: -1}).limit(20)` requires an index of `{tenant_id: 1, status: 1, created_at: -1}`. The sort is served from the index walk, the filter narrows to a single tenant, and the limit truncates after twenty matches. Without the sort field in the index, the server reads every matching document, buffers them, sorts in memory, then returns twenty. At a hundred thousand matching documents per tenant, this is the difference between one millisecond and one second.

The five indexes you actually need for most applications. First, the unique index on natural keys (email, username, external ID). Second, compound indexes on the top two or three query access patterns per collection. Third, TTL indexes for any time-bound data (sessions, nonces, rate limit counters, email verification tokens). Fourth, partial indexes when the query always filters by a field that has only a few possible values (`status in ("pending", "processing")` where ninety-five percent of documents are `completed`). Fifth, text or 2dsphere indexes when the product needs search or location features.

The prefix rule for compound indexes is the other thing juniors forget. An index on `{a: 1, b: 1, c: 1}` can serve queries on `{a}`, `{a, b}`, and `{a, b, c}`, but it cannot serve a query on just `{b}` or `{c}`. You need a separate index for that. This is why compound indexes are designed around the most-selective prefix, not around "every field I might query." Many junior engineers reflexively create ten single-field indexes, which wastes write throughput and memory. Two or three compound indexes covering the real access patterns is almost always the better answer.

Interview entry-points: "What is ESR?" (Equality, Sort, Range, the order for fields in a compound index), "What is a covered query?" (a query where every needed field is in the index, so the server never touches the collection), and "When would you use a partial index?" (when the query always filters on a predicate that excludes most documents, partial indexes shrink the index to the matching subset).

### Senior @ FAANG: advanced index patterns, Atlas Search, and detection of inefficient queries

Staff-level indexing work adds a layer of instrumentation and trade-off analysis on top of ESR. The tools you use day-to-day: `$indexStats` aggregation stage to see how often each index is used since the `mongod` started, `currentOp` to catch long-running scans in real time, `mongotop` and `mongostat` for per-collection IO stats, and the Atlas Performance Advisor (or the self-hosted equivalent, `db.collection.getPlanCache()`) to discover missing indexes from the actual query profile. The detection rule is simple: any query that appears in the slow query log with `COLLSCAN` in the plan or a `totalKeysExamined / totalDocsExamined` ratio worse than one to ten is a candidate for indexing. Schedule a weekly review of the slow log in production services and treat missing indexes as bugs, not feature requests.

Partial indexes are the most under-used feature in MongoDB indexing. They let you index only the subset of documents matching a predicate, which shrinks the index dramatically for low-cardinality predicates and eliminates a class of "unique-per-tenant" constraint-modeling headaches. The canonical example: `{email: 1}` with a partial filter `{deleted: {$exists: false}}` lets you enforce email uniqueness among active users while allowing soft-deleted users to keep their email in the collection. Wildcard indexes (`{"attributes.$**": 1}`, introduced in 4.2) are the right answer for truly schema-flexible document fragments, but they produce unpredictable plans and should be used only after explicitly ruling out a compound index.

TTL indexes are deceptively subtle. The `expireAfterSeconds` value controls how long after the indexed date a document is eligible for deletion, and the actual deletion runs on a background thread that sweeps every sixty seconds. The gap between eligibility and actual deletion can be minutes under load. Do not rely on TTL for security-critical cleanup. For session expiry, use a short TTL (a few minutes past the logical expiry) plus an application-side check on read. For compliance-driven deletion, use an explicit deletion job with audit logging. The TTL index is for soft deadlines, not hard ones.

Text indexes versus Atlas Search in 2026. The server-side text index is adequate for simple keyword search with stemming and language-specific tokenization, but it has real limitations: one text index per collection, no per-field boost at query time (only at index time via weights), no faceted search, no fuzzy matching, and no autocomplete. Atlas Search (based on Apache Lucene) fixes all of these. It runs in a separate process on Atlas nodes, is defined via a JSON index definition, and integrates with the aggregation pipeline via the `$search` stage. For any product feature where search quality matters, Atlas Search is the correct answer. The lock-in is that Atlas Search is Atlas-only. Self-hosted deployments need Elasticsearch or OpenSearch for comparable capability.

Atlas Vector Search, GA in 2024 and widely adopted by 2026, adds HNSW-based approximate nearest neighbor retrieval for embedding-based use cases (semantic search, recommendations, RAG pipelines). The index definition specifies `numDimensions` (typically 1536 for OpenAI embeddings or 768 for smaller models) and the similarity metric (`cosine`, `euclidean`, or `dotProduct`). Query time parameters include `numCandidates` (pre-filter candidate count) and `limit` (final result count). The rule of thumb is `numCandidates = 10 * limit` for balanced recall versus latency. Combining `$vectorSearch` with a `$match` on metadata fields lets you build filtered vector search ("top ten similar products in category X"), which is the shape of most production vector queries. Pair with queryable encryption on the metadata fields for privacy-preserving vector retrieval if your use case demands it.

Columnstore indexes (Atlas-only, 6.3+) accelerate analytical aggregations by storing a columnar copy of specified fields. They are write-amplifying (roughly double the ingest cost) and appropriate only when a small set of fields is hammered by analytical queries over large document counts. The classic use case is time series collections with many measurement fields where only two or three are queried in a dashboard. Evaluate with benchmarks before enabling. Do not deploy a columnstore index speculatively.

The staff-level index ADR lists every index on a collection with its purpose, the query access pattern it serves, its size on disk (from `$indexStats` or `db.collection.stats()`), the last-used timestamp, and a deletion candidate flag. Stale indexes (no access in thirty days) should be dropped, because every write pays the full cost of every index. This review is the single most impactful operational activity for MongoDB performance after the initial design. Automate it with a monthly report and treat unused indexes as technical debt.

For sharded collections, the shard key must be a prefix of any unique index, which constrains the unique-constraint design. The workaround is either to make the shard key a prefix of the uniqueness constraint (for example, `{tenant_id: 1, email: 1}` unique, sharded on `tenant_id`), or to enforce uniqueness application-side via a transaction plus a lookup. The tenant-prefix pattern is the canonical multi-tenant shape on sharded clusters and deserves explicit documentation in the multi-tenancy ADR for any SaaS product.

---
