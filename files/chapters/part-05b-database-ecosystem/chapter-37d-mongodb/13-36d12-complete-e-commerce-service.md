## 37D.12 Complete E-Commerce Service

### Full Production Implementation

This e-commerce service wires together the patterns from earlier sections (embedded order items, referenced user documents, optimistic locking for inventory, and `$lookup` aggregation for reporting) into a single cohesive implementation. Each repository method propagates `context.Context` to support deadline and cancellation budgets that span multiple MongoDB operations.

```go
package mongodb

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Domain models
type Product struct {
	BaseDocument `bson:",inline"`
	SKU          string          `bson:"sku"`
	Name         string          `bson:"name"`
	Description  string          `bson:"description"`
	Category     string          `bson:"category"`
	PriceCents   int64           `bson:"price_cents"`
	Stock        int             `bson:"stock"`
	Tags         []string        `bson:"tags"`
	Images       []string        `bson:"images"`
	Attributes   bson.M          `bson:"attributes,omitempty"`
	Active       bool            `bson:"active"`
	Location     *GeoPoint       `bson:"location,omitempty"`
}

type User struct {
	BaseDocument `bson:",inline"`
	Email        string    `bson:"email"`
	Name         string    `bson:"name"`
	PasswordHash string    `bson:"password_hash"`
	Role         string    `bson:"role"`
	Active       bool      `bson:"active"`
	LastLoginAt  time.Time `bson:"last_login_at,omitempty"`
}

// ProductService handles product business logic
type ProductService struct {
	repo *Repository[Product]
	log  *slog.Logger
}

func NewProductService(db *mongo.Database, log *slog.Logger) *ProductService {
	return &ProductService{
		repo: NewRepository[Product](db, "products"),
		log:  log,
	}
}

func (s *ProductService) Create(ctx context.Context, p Product) (bson.ObjectID, error) {
	if p.SKU == "" {
		return bson.ObjectID{}, errors.New("SKU is required")
	}
	if p.PriceCents < 0 {
		return bson.ObjectID{}, errors.New("price cannot be negative")
	}
	p.Active = true
	return s.repo.InsertOne(ctx, &p)
}

func (s *ProductService) Update(ctx context.Context, id bson.ObjectID, updates bson.D) error {
	return s.repo.UpdateByID(ctx, id, updates)
}

func (s *ProductService) Search(ctx context.Context, query string, category string, page, limit int64) ([]Product, int64, error) {
	filter := bson.D{{Key: "active", Value: true}}

	if query != "" {
		filter = append(filter, bson.E{Key: "$text", Value: bson.D{{Key: "$search", Value: query}}})
	}
	if category != "" {
		filter = append(filter, bson.E{Key: "category", Value: category})
	}

	// Count total (for pagination)
	total, err := s.repo.collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, fmt.Errorf("count: %w", err)
	}

	products, err := s.repo.Find(ctx, filter, &FindOptions{
		Limit: limit,
		Skip:  (page - 1) * limit,
		Sort:  bson.D{{Key: "created_at", Value: -1}},
	})
	if err != nil {
		return nil, 0, err
	}

	return products, total, nil
}

func (s *ProductService) DecrementStock(ctx context.Context, id bson.ObjectID, quantity int) error {
	filter := bson.D{
		{Key: "_id", Value: id},
		{Key: "stock", Value: bson.D{{Key: "$gte", Value: quantity}}},
	}
	update := bson.D{
		{Key: "$inc", Value: bson.D{{Key: "stock", Value: -quantity}}},
		{Key: "$currentDate", Value: bson.D{{Key: "updated_at", Value: true}}},
	}

	result, err := s.repo.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("stock decrement: %w", err)
	}
	if result.MatchedCount == 0 {
		return errors.New("insufficient stock or product not found")
	}
	return nil
}

// UserRepository with specific methods
type UserRepository struct {
	*Repository[User]
	collection *mongo.Collection
}

func NewUserRepository(db *mongo.Database) *UserRepository {
	coll := db.Collection("users")
	return &UserRepository{
		Repository: NewRepository[User](db, "users"),
		collection: coll,
	}
}

func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
	filter := bson.D{{Key: "email", Value: email}, {Key: "active", Value: true}}
	var user User
	err := r.collection.FindOne(ctx, filter).Decode(&user)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (r *UserRepository) UpdateLastLogin(ctx context.Context, userID bson.ObjectID) error {
	_, err := r.collection.UpdateOne(ctx,
		bson.D{{Key: "_id", Value: userID}},
		bson.D{{Key: "$currentDate", Value: bson.D{{Key: "last_login_at", Value: true}}}},
	)
	return err
}

// Aggregation: get user activity summary
func (r *UserRepository) GetActivitySummary(ctx context.Context, since time.Time) ([]UserActivity, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "last_login_at", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		{{Key: "$lookup", Value: bson.D{
			{Key: "from", Value: "orders"},
			{Key: "localField", Value: "_id"},
			{Key: "foreignField", Value: "user_id"},
			{Key: "as", Value: "orders"},
			{Key: "pipeline", Value: bson.A{
				bson.D{{Key: "$match", Value: bson.D{
					{Key: "created_at", Value: bson.D{{Key: "$gte", Value: since}}},
				}}},
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: nil},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
					{Key: "total_spent_cents", Value: bson.D{{Key: "$sum", Value: "$total_cents"}}},
				}}},
			}},
		}}},
		{{Key: "$addFields", Value: bson.D{
			{Key: "order_summary", Value: bson.D{{Key: "$arrayElemAt", Value: bson.A{"$orders", 0}}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "name", Value: 1},
			{Key: "email", Value: 1},
			{Key: "last_login_at", Value: 1},
			{Key: "order_count", Value: "$order_summary.count"},
			{Key: "total_spent_cents", Value: "$order_summary.total_spent_cents"},
		}}},
		{{Key: "$sort", Value: bson.D{{Key: "total_spent_cents", Value: -1}}}},
		{{Key: "$limit", Value: 100}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var activities []UserActivity
	return activities, cursor.All(ctx, &activities)
}

type UserActivity struct {
	ID              bson.ObjectID `bson:"_id"`
	Name            string        `bson:"name"`
	Email           string        `bson:"email"`
	LastLoginAt     time.Time     `bson:"last_login_at"`
	OrderCount      int           `bson:"order_count"`
	TotalSpentCents int64         `bson:"total_spent_cents"`
}
```

### Junior to FAANG: Prerequisite Gaps and First-Job Context

An e-commerce service is the most common take-home project and on-site system-design prompt in the industry. Before you write any code, internalise the four aggregates: catalog (products), users, cart, and order. Each has a different read-write profile. Catalog is read-heavy, updated infrequently, and benefits from aggressive caching. Users are low-volume and access-controlled. Cart is high-write, short-lived, often keyed by session, and a great fit for a TTL index. Order is write-once for the happy path, append-only for status changes, and the single most audited collection.

A first-job worked example: you are asked to build `POST /cart/:id/items`. The naive approach is to load the cart, append the item in Go, write it back. That has a lost-update race if two tabs add items at once. The correct approach is a single `$push` with a filter that enforces business rules (cart not expired, item not already present or increment quantity):

```go
filter := bson.D{
    {"_id", cartID},
    {"expires_at", bson.D{{"$gt", time.Now()}}},
}
update := bson.D{
    {"$push", bson.D{{"items", item}}},
    {"$currentDate", bson.D{{"updated_at", true}}},
}
res, _ := coll.UpdateOne(ctx, filter, update)
```

Entry-level interviewers then ask "how do you decrement stock when an order is placed". The naive answer is two writes (decrement product, insert order). The correct answer acknowledges the race (oversell) and reaches for either a conditional update (`stock: { $gte: qty }` with `$inc`) or a multi-document transaction. Either is acceptable. Knowing both and when to pick which is the signal of a strong mid-level candidate.

### Senior at FAANG: Staff and Principal Material

This section walks through the ADRs a staff engineer writes for a production e-commerce MongoDB service.

**ADR 1: Product catalog schema. Accepted. Embed variants in the product document up to 100 variants, reference beyond.** Rationale: most products have under 20 variants (size, color), which fit comfortably under the 16 MB document cap. Fashion and configurable-electronics products occasionally exceed 100 variants, at which point query performance on the embedded array degrades and update amplification hurts. The threshold is driven by measured p99 read latency, not a fixed number. Consequence: the application layer hides the distinction behind a repository method that fetches variants transparently.

**ADR 2: Inventory model. Accepted. Separate `inventory` collection keyed by `sku`, one document per warehouse.** Rationale: a single `stock` field on the product document cannot represent per-warehouse availability, cannot be updated independently of catalog edits, and becomes a hot document under high-frequency decrement. Separating inventory lets us shard inventory on `sku` while keeping catalog lightly sharded or unsharded. Consequence: catalog reads do `$lookup` to inventory only when availability matters (product detail page), not on listing pages where a cached availability hint is sufficient.

**ADR 3: Cart model. Accepted. Session-keyed cart in a dedicated collection with a TTL index on `expires_at`.** Rationale: carts are transient, their write volume is orders of magnitude higher than orders, and stale carts clutter the collection. TTL indexes reap expired carts automatically. The cart document embeds items because a cart is a single aggregate and cart operations (`$push`, `$pull`, `$inc` on item quantity) are single-document atomic. Consequence: no cross-document consistency concern during cart edits. When checkout begins, we atomically move the cart to an order and flag it closed rather than deleting immediately, to support abandoned-cart analytics.

**ADR 4: Order lifecycle. Accepted. Orders are append-only with a status-history array, never mutated except through well-defined state transitions using `$set` with conditional filters.** Rationale: orders are the audit substrate. Any in-place status mutation without an audit trail is a compliance failure. The status array `[{status, at, actor, reason}]` is pushed on every transition with `$push`. The current status is denormalized on the document for indexing. Consequence: revert and reprocess flows are explicit state transitions, not destructive edits. A change stream on `orders` drives fulfilment, notifications, and analytics via the outbox pattern.

**ADR 5: Inventory reservation. Accepted. Two-phase reserve-then-commit using a `reservations` subcollection with TTL, not a long transaction.** Rationale: during a flash sale on a hot SKU, a multi-document transaction that holds the inventory document across payment processing serializes every buyer on that SKU. A TTL-bounded reservation (90 seconds) decrements available stock, creates a reservation document, and releases automatically if payment does not complete. Payment success transitions reservation to order. Consequence: we trade strict consistency for scalable throughput, and we accept a small oversell window if the reservation TTL and the payment SLA misalign. The gap is monitored and drives oversell-handling logic (customer apology plus refund).

**ADR 6: Transactions. Accepted. Used only for order creation (inventory reserve + order insert + outbox event) and for payment reconciliation (credit memo + refund). Rejected for cart edits and status updates.** Rationale: single-document atomicity suffices for cart and status flows. Transactions add latency and locking surface.

**ADR 7: Sharding. Deferred. Run as a PSS replica set until measured working-set exceeds RAM headroom or write throughput exceeds primary capacity at p99 under load test.** Rationale: sharding introduces balancer, config-server, and cross-shard-transaction complexity that is expensive to operate. We document the intended shard keys now (orders on `{tenant_id: "hashed", _id: 1}`, products on `{category: 1, sku: 1}`, inventory on `{sku: "hashed"}`) so that when we shard, the choice is not made under pressure.

**ADR 8: Encryption. Accepted. Queryable Encryption on PII fields (`email`, `phone`, `address.line1`, `address.postal_code`) and on stored payment-instrument identifiers.** Rationale: regulatory posture (GDPR, PCI DSS) mandates field-level protection. Equality queries on email (for login and dedup) and range queries on postal code (for shipping) are the only encrypted-field query shapes needed, and both are supported by QE in MongoDB 8.0. CMK resides in AWS KMS, rotated annually.

**ADR 9: Observability. Accepted. Structured logging with correlation ID propagated from HTTP middleware into MongoDB Command Monitoring, plus Prometheus metrics on pool, replication lag, and per-collection op latency.** Rationale: a failing order write must be traceable end to end from API gateway to `mongod`. Tag every log event with `order_id`, `tenant_id`, and `request_id`.

**ADR 10: Reporting. Accepted. Change-stream-fed analytics replica into a separate Atlas cluster or BigQuery, not ad-hoc aggregations on the primary.** Rationale: heavy aggregation on the OLTP primary steals cache and CPU from checkout traffic. The analytics path lags by seconds, which is acceptable for merchandising dashboards. For real-time seller dashboards we use an Atlas Search index with precomputed rollups maintained by the change-stream consumer.

These ten ADRs are the scaffolding a principal engineer would expect to see before a production launch. Each should be revisited annually or on significant workload change.

---
