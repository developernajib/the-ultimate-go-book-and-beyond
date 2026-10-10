## 37D.3 Document Modeling: Embedding vs Referencing

### Schema Design Patterns

MongoDB schema design centers on a single question: will this data always be read together? Embedding subdocuments optimizes for read performance at the cost of document growth, while referencing keeps documents small but requires `$lookup` aggregation for joins. The bucket and outlier patterns address the 16 MB document size limit for unbounded time-series and high-fan-out relationships.

**Decision rule of thumb:**

- **Embed** for *1:one* and *1:few with bounded growth* (addresses on a user, line items on an order, metadata on a blog post). Lifecycle of the child is tied to the parent, and the child is always fetched with the parent. Typical upper bound: a few hundred subdocuments, and the combined document stays well under 16 MB.
- **Reference** for *1:many unbounded* (comments on a viral post, events for a user), *many:many* (tags, roles), or when the child is an independent aggregate root accessed on its own (orders queried without the user, products used across many orders). Use `$lookup` for server-side joins, or resolve in the application where caching helps.
- **Hybrid** (Extended Reference): embed a snapshot of the fields you need for display (`user.name`, `user.avatar`) alongside the `user_id`. This eliminates the lookup for the common read path but requires a denormalization strategy (accept staleness, or fan out updates via change streams) when the source fields change.

```go
// Pattern 1: Embedded Documents (1:few, read-heavy)
// Best when: data is always accessed together, subdocs < 16MB limit

type BlogPost struct {
	BaseDocument `bson:",inline"`
	Title        string    `bson:"title"`
	Slug         string    `bson:"slug"`
	Content      string    `bson:"content"`
	Author       Author    `bson:"author"`   // embedded
	Tags         []string  `bson:"tags"`
	Comments     []Comment `bson:"comments"` // embedded array (dangerous if unbounded!)
	Stats        PostStats `bson:"stats"`
}

type Author struct {
	ID       bson.ObjectID `bson:"id"`
	Name     string        `bson:"name"`
	Avatar   string        `bson:"avatar"`
}

type Comment struct {
	ID        bson.ObjectID `bson:"id"`
	AuthorID  bson.ObjectID `bson:"author_id"`
	Text      string        `bson:"text"`
	CreatedAt time.Time     `bson:"created_at"`
}

type PostStats struct {
	Views    int64 `bson:"views"`
	Likes    int64 `bson:"likes"`
	Shares   int64 `bson:"shares"`
}

// Pattern 2: Referenced Documents (1:many, write-heavy)
// Best when: related docs are large, accessed independently, updated frequently

type User struct {
	BaseDocument `bson:",inline"`
	Email        string `bson:"email"`
	Name         string `bson:"name"`
	// orders stored separately - could be millions
}

type Order struct {
	BaseDocument `bson:",inline"`
	UserID       bson.ObjectID `bson:"user_id"` // reference
	Items        []OrderItem   `bson:"items"`    // embedded (bounded)
	TotalCents   int64         `bson:"total_cents"`
	Status       string        `bson:"status"`
}

type OrderItem struct {
	ProductID  bson.ObjectID `bson:"product_id"`
	Name       string        `bson:"name"`
	PriceCents int64         `bson:"price_cents"`
	Quantity   int           `bson:"quantity"`
}

// Pattern 3: Bucket Pattern (time-series, IoT)
// Groups many small documents into one bucket document

type SensorBucket struct {
	BaseDocument `bson:",inline"`
	SensorID     string        `bson:"sensor_id"`
	Date         time.Time     `bson:"date"`      // bucket date (day)
	Count        int           `bson:"count"`     // readings in bucket
	Readings     []SensorReading `bson:"readings"`
	Summary      BucketSummary  `bson:"summary"`
}

type SensorReading struct {
	Timestamp time.Time `bson:"ts"`
	Value     float64   `bson:"v"`
}

type BucketSummary struct {
	Min float64 `bson:"min"`
	Max float64 `bson:"max"`
	Avg float64 `bson:"avg"`
}

// Pattern 4: Outlier Pattern
// Handle the rare huge document differently

type Post struct {
	BaseDocument `bson:",inline"`
	Title        string        `bson:"title"`
	CommentCount int           `bson:"comment_count"`
	HasExtraComments bool      `bson:"has_extra_comments"` // flag
	Comments     []Comment     `bson:"comments"`            // first 100
}
// Comments beyond 100 stored in separate CommentOverflow collection
```

### Manual Lookup (equivalent of JOIN)

The `$lookup` aggregation stage performs a server-side join between collections, avoiding N+1 query patterns. Using `$unwind` after `$lookup` flattens the resulting array into individual documents, and `$project` limits the returned fields to reduce network payload.

```go
// Manual lookup using aggregation $lookup
func (r *OrderRepository) FindOrdersWithUser(ctx context.Context, userID bson.ObjectID) ([]OrderWithUser, error) {
	pipeline := mongo.Pipeline{
		// Match orders for user
		{{Key: "$match", Value: bson.D{{Key: "user_id", Value: userID}}}},
		// Lookup user details
		{{Key: "$lookup", Value: bson.D{
			{Key: "from", Value: "users"},
			{Key: "localField", Value: "user_id"},
			{Key: "foreignField", Value: "_id"},
			{Key: "as", Value: "user"},
		}}},
		// Unwind single user
		{{Key: "$unwind", Value: bson.D{
			{Key: "path", Value: "$user"},
			{Key: "preserveNullAndEmptyArrays", Value: false},
		}}},
		// Project required fields
		{{Key: "$project", Value: bson.D{
			{Key: "items", Value: 1},
			{Key: "total_cents", Value: 1},
			{Key: "status", Value: 1},
			{Key: "user.name", Value: 1},
			{Key: "user.email", Value: 1},
		}}},
		{{Key: "$sort", Value: bson.D{{Key: "created_at", Value: -1}}}},
		{{Key: "$limit", Value: 20}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregate lookup: %w", err)
	}
	defer cursor.Close(ctx)

	var results []OrderWithUser
	if err := cursor.All(ctx, &results); err != nil {
		return nil, err
	}
	return results, nil
}

type OrderWithUser struct {
	ID         bson.ObjectID `bson:"_id"`
	Items      []OrderItem   `bson:"items"`
	TotalCents int64         `bson:"total_cents"`
	Status     string        `bson:"status"`
	User       struct {
		Name  string `bson:"name"`
		Email string `bson:"email"`
	} `bson:"user"`
}
```

### Junior → FAANG: making the embedding call

The question a junior engineer should ask before writing any document schema is: "What is the bounded cardinality of this relationship?" If the answer is "a handful" (the author of a post, the shipping address of an order, the line items of a single checkout), embed. If the answer is "thousands or unbounded" (comments on a viral post, hits on a short URL, events for a user over time), reference. If the answer is "unknown but we think it will stay small," still reference, because the cost of migrating from embedded to referenced under production load is much higher than the cost of a `$lookup` from day one.

The sixteen megabyte document size cap is the enforcement mechanism. A document cannot grow past sixteen megabytes, period. If your embedded array design permits unbounded growth, you will hit this limit in production and the write will fail with a `DocumentTooLarge` error. The junior mistake here is to treat the cap as a distant concern and embed comments on posts. The senior move is to assume any array that grows with time will eventually violate the cap, and to use referencing or the bucket pattern from the start.

Work through this example end to end. A product catalog has products and reviews. Product detail page needs: the product, the top five reviews sorted by helpfulness, the total review count, and the average rating. The design is: embed `top_reviews` (array of five snapshot documents), store `review_count` and `review_average` as computed fields on the product, and keep full reviews in a separate `reviews` collection keyed by `product_id`. On review write, the service updates the full review document, recomputes the top five via aggregation, and updates the product's `top_reviews`, `review_count`, and `review_average` in a single `$set`. This is the extended reference pattern combined with the computed pattern, and it is the canonical shape of a read-optimized document model.

Interview entry-points: "When would you embed versus reference?" (bounded cardinality plus always-read-together equals embed), "Why can you not just embed everything?" (sixteen megabyte cap, write amplification as the document grows, working set pressure), and "What is the bucket pattern?" (shard an unbounded array across documents keyed by a time or count boundary).

### Senior @ FAANG: schema patterns, ADRs, and the cost of a bad embedding decision

The six patterns every staff-level MongoDB engineer should be able to enumerate on a whiteboard: Embedded Document, Extended Reference, Subset, Computed, Bucket, and Outlier. To these add three supporting patterns that appear frequently in production: Schema Versioning (every document carries a `_schema_version` field for online migration), Approximation (store pre-aggregated counts that drift slightly to avoid expensive recomputation), and Tree (materialized paths, arrays of ancestors, or nested sets for hierarchies). MongoDB University's "Building with Patterns" series is the canonical reference and should be treated as required reading before a staff interview.

The ADR template for a new collection should document: expected document count, expected document size distribution (p50, p95, p99), read-to-write ratio, the top three read access patterns with frequency, the top three write access patterns, the embedding decision for each relationship with cardinality analysis, the indexing plan, the retention policy, and the migration story when the schema inevitably needs to evolve. The migration story is where many staff engineers underinvest. Online schema migration in MongoDB happens via a `_schema_version` field and application-side lazy rewrites, not via an offline migration window. Document a policy: "any read of a document with `_schema_version < N` triggers an async upgrade write, and a nightly sweep fills in the tail." This lets schemas evolve forever without downtime, at the cost of application-side branching during the transition window.

The cost model for `$lookup` is nontrivial and deserves explicit consideration. Foreign-collection `$lookup` is implemented as an index-nested-loop join. The driver sends one aggregation command, and the server performs the lookup for each input document by querying the foreign collection. If the foreign key is indexed, the per-document cost is roughly one B-tree seek. If it is not, it is a collection scan per input, which is catastrophic. Staff-level code review always checks for `$lookup` on unindexed foreign fields. The 5.0+ `$lookup` with correlated subqueries and `$lookup` from sharded collections introduces additional cost: sharded-collection lookups are scatter-gather and should be avoided on hot paths. Prefer denormalization via the extended reference pattern whenever the `$lookup` is on a read path with high QPS, and use `$lookup` for analytical pipelines where per-query latency is less critical.

Unbounded array anti-patterns deserve a standing detection story. Use `$indexStats`, `currentOp`, and `mongotop` to surface the problem, but the proactive approach is to cap arrays in the schema validator. MongoDB supports JSON Schema validation via `validator` on the collection (`$jsonSchema` since 3.6), and a rule like `{ comments: { $lt: ['$size: $comments', 1000] } }` will reject writes that push past the cap. Pair this with a write-time check in application code and a nightly sweep that moves overflowed documents to an `_overflow` collection. The Outlier pattern, mentioned above, is the canonical solution for the "ninety-nine percent of posts have fewer than a hundred comments but the one percent have a million" case.

Computed and Approximation patterns interact subtly. A `view_count` field on a popular document, updated on every read, becomes a write hotspot that dominates the oplog. The fix is either to batch view increments in a cache layer (Redis counter, flushed every ten seconds) or to use the Approximation pattern (increment only one in N reads and multiply). Both trade accuracy for throughput. Document the chosen trade-off in the ADR. For highly contended counters, consider storing the counter as an array of shards (`counters: [{shard: 0, value: 123}, {shard: 1, value: 456}]`) and summing on read. This is a classic sharded-counter pattern and scales linearly with the shard count.

For polymorphism, MongoDB has no native discriminated-union type, but the convention is a `_type` discriminator field plus application-side dispatch. In Go, use a custom `UnmarshalBSON` on a sum-type struct that switches on `_type` and delegates to the concrete type's decoder. This pattern keeps the domain model clean while preserving MongoDB's ability to index and query across the mixed collection. Avoid using `bson.M` as a catch-all. It works, but it erases type safety and drags the rest of the codebase toward dynamic typing.

---
