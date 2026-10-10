## 37D.2 Go Driver Setup & Connection Management

### v1 to v2 Migration Notes

The Go driver v2 (released 2024) is a breaking release. When porting v1 code, expect these changes:

- **Import path**: `go.mongodb.org/mongo-driver/...` becomes `go.mongodb.org/mongo-driver/v2/...`
- **Package removals**: `primitive`, `description`, `gridfs`, `bsonrw`, `bsonoptions` are gone. `primitive.ObjectID` is now `bson.ObjectID`, and `primitive.NewObjectID()` is `bson.NewObjectID()`.
- **`mongo.Connect` signature**: no longer takes `ctx`. The ping is the connectivity check: `client, err := mongo.Connect(opts); err = client.Ping(ctx, nil)`.
- **Unacknowledged writes**: the `mongo.ErrUnacknowledgedWrite` sentinel is gone. Inspect `result.Acknowledged` instead.
- **Option builders**: several `options.Client().Set...` methods changed signatures. Compile errors will flag them.
- **GridFS**: moved under `mongo.Client.GridFSBucket(...)` convenience helpers rather than a separate package.

If you maintain a large v1 codebase, gate the upgrade on CI and run the MongoDB-provided migration guide's search-and-replace first to accelerate the transition.

### Production-Grade Client Configuration

Configuring a production-grade MongoDB client requires careful tuning of connection pool sizes, timeouts, and write concerns to match workload characteristics. The following setup integrates OpenTelemetry monitoring, TLS enforcement, and compression, all essential for operating MongoDB reliably in a production environment.

```go
package mongodb

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
	"go.opentelemetry.io/contrib/instrumentation/go.mongodb.org/mongo-driver/v2/mongo/otelmongo"
)

// Config holds MongoDB connection configuration
type Config struct {
	URI             string
	Database        string
	MaxPoolSize     uint64
	MinPoolSize     uint64
	MaxConnIdleTime time.Duration
	ConnectTimeout  time.Duration
	ServerTimeout   time.Duration
	TLSEnabled      bool
	AppName         string
}

// DefaultConfig returns production-ready defaults
func DefaultConfig(uri, database string) Config {
	return Config{
		URI:             uri,
		Database:        database,
		MaxPoolSize:     100,
		MinPoolSize:     10,
		MaxConnIdleTime: 5 * time.Minute,
		ConnectTimeout:  10 * time.Second,
		ServerTimeout:   30 * time.Second,
		AppName:         "go-app",
	}
}

// Client wraps the MongoDB client with observability
type Client struct {
	client *mongo.Client
	db     *mongo.Database
	cfg    Config
	log    *slog.Logger
}

// NewClient creates a production MongoDB client
func NewClient(ctx context.Context, cfg Config, log *slog.Logger) (*Client, error) {
	opts := options.Client().
		ApplyURI(cfg.URI).
		SetMaxPoolSize(cfg.MaxPoolSize).
		SetMinPoolSize(cfg.MinPoolSize).
		SetMaxConnIdleTime(cfg.MaxConnIdleTime).
		SetConnectTimeout(cfg.ConnectTimeout).
		SetServerSelectionTimeout(cfg.ServerTimeout).
		SetAppName(cfg.AppName).
		// OpenTelemetry command monitoring
		SetMonitor(otelmongo.NewMonitor()).
		// Compression: zstd preferred
		SetCompressors([]string{"zstd", "snappy", "zlib"}).
		// Read preference: primary preferred for reads
		SetReadPreference(readpref.PrimaryPreferred()).
		// Write concern: majority for durability
		SetWriteConcern(writeConcernMajority())

	if cfg.TLSEnabled {
		tlsCfg := &tls.Config{
			MinVersion: tls.VersionTLS13,
		}
		opts.SetTLSConfig(tlsCfg)
	}

	client, err := mongo.Connect(opts)
	if err != nil {
		return nil, fmt.Errorf("mongo connect: %w", err)
	}

	// Verify connectivity
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx, readpref.Primary()); err != nil {
		_ = client.Disconnect(ctx)
		return nil, fmt.Errorf("mongo ping: %w", err)
	}

	log.Info("mongodb connected",
		"uri", sanitizeURI(cfg.URI),
		"database", cfg.Database,
		"maxPool", cfg.MaxPoolSize,
	)

	return &Client{
		client: client,
		db:     client.Database(cfg.Database),
		cfg:    cfg,
		log:    log,
	}, nil
}

// Close gracefully disconnects
func (c *Client) Close(ctx context.Context) error {
	return c.client.Disconnect(ctx)
}

// Collection returns a typed collection helper
func (c *Client) Collection(name string) *mongo.Collection {
	return c.db.Collection(name)
}

func writeConcernMajority() *writeconcern.WriteConcern {
	return writeconcern.Majority()
}

func sanitizeURI(uri string) string {
	// Remove credentials from URI for logging
	parsed, err := url.Parse(uri)
	if err != nil {
		return "[invalid-uri]"
	}
	parsed.User = nil
	return parsed.String()
}
```

### Repository Pattern with Generics

Go 1.18 generics allow a single repository implementation to serve any document type that satisfies the `Entity` interface. The `BaseDocument` struct provides `_id`, `created_at`, and `updated_at` fields that every collection needs, and embedding it with `bson:",inline"` flattens these into the parent document rather than nesting them.

```go
package mongodb

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Entity is the base interface all MongoDB documents must implement
type Entity interface {
	GetID() bson.ObjectID
	SetID(bson.ObjectID)
	SetTimestamps(createdAt, updatedAt time.Time)
}

// BaseDocument provides common fields for all documents
type BaseDocument struct {
	ID        bson.ObjectID `bson:"_id,omitempty"`
	CreatedAt time.Time     `bson:"created_at"`
	UpdatedAt time.Time     `bson:"updated_at"`
}

func (b *BaseDocument) GetID() bson.ObjectID { return b.ID }
func (b *BaseDocument) SetID(id bson.ObjectID) { b.ID = id }
func (b *BaseDocument) SetTimestamps(createdAt, updatedAt time.Time) {
	b.CreatedAt = createdAt
	b.UpdatedAt = updatedAt
}

// Repository is a generic MongoDB repository
type Repository[T Entity] struct {
	collection *mongo.Collection
}

// NewRepository creates a typed repository
func NewRepository[T Entity](db *mongo.Database, collName string) *Repository[T] {
	return &Repository[T]{
		collection: db.Collection(collName),
	}
}

// InsertOne inserts a single document
func (r *Repository[T]) InsertOne(ctx context.Context, doc T) (bson.ObjectID, error) {
	now := time.Now().UTC()
	if doc.GetID().IsZero() {
		doc.SetID(bson.NewObjectID())
	}
	doc.SetTimestamps(now, now)

	result, err := r.collection.InsertOne(ctx, doc)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return bson.ObjectID{}, fmt.Errorf("duplicate key: %w", ErrDuplicate)
		}
		return bson.ObjectID{}, fmt.Errorf("insert: %w", err)
	}

	return result.InsertedID.(bson.ObjectID), nil
}

// InsertMany inserts multiple documents efficiently
func (r *Repository[T]) InsertMany(ctx context.Context, docs []T) ([]bson.ObjectID, error) {
	now := time.Now().UTC()
	ifaces := make([]any, len(docs))
	for i, doc := range docs {
		if doc.GetID().IsZero() {
			doc.SetID(bson.NewObjectID())
		}
		doc.SetTimestamps(now, now)
		ifaces[i] = doc
	}

	opts := options.InsertMany().SetOrdered(false) // continue on error
	result, err := r.collection.InsertMany(ctx, ifaces, opts)
	if err != nil {
		// Partial success possible with unordered inserts
		var bulkErr mongo.BulkWriteException
		if errors.As(err, &bulkErr) {
			ids := make([]bson.ObjectID, len(result.InsertedIDs))
			for i, id := range result.InsertedIDs {
				ids[i] = id.(bson.ObjectID)
			}
			return ids, fmt.Errorf("partial insert (%d errors): %w", len(bulkErr.WriteErrors), err)
		}
		return nil, fmt.Errorf("insert many: %w", err)
	}

	ids := make([]bson.ObjectID, len(result.InsertedIDs))
	for i, id := range result.InsertedIDs {
		ids[i] = id.(bson.ObjectID)
	}
	return ids, nil
}

// FindByID retrieves a document by its ObjectID
func (r *Repository[T]) FindByID(ctx context.Context, id bson.ObjectID) (T, error) {
	var zero T
	filter := bson.D{{Key: "_id", Value: id}}

	var result T
	err := r.collection.FindOne(ctx, filter).Decode(&result)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return zero, ErrNotFound
		}
		return zero, fmt.Errorf("find by id: %w", err)
	}
	return result, nil
}

// Find retrieves documents matching a filter with pagination
func (r *Repository[T]) Find(ctx context.Context, filter bson.D, opts *FindOptions) ([]T, error) {
	findOpts := options.Find()
	if opts != nil {
		if opts.Limit > 0 {
			findOpts.SetLimit(opts.Limit)
		}
		if opts.Skip > 0 {
			findOpts.SetSkip(opts.Skip)
		}
		if opts.Sort != nil {
			findOpts.SetSort(opts.Sort)
		}
		if opts.Projection != nil {
			findOpts.SetProjection(opts.Projection)
		}
	}

	cursor, err := r.collection.Find(ctx, filter, findOpts)
	if err != nil {
		return nil, fmt.Errorf("find: %w", err)
	}
	defer cursor.Close(ctx)

	var results []T
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("cursor decode: %w", err)
	}
	return results, nil
}

// UpdateByID updates fields of a document
func (r *Repository[T]) UpdateByID(ctx context.Context, id bson.ObjectID, update bson.D) error {
	filter := bson.D{{Key: "_id", Value: id}}
	updateDoc := bson.D{
		{Key: "$set", Value: update},
		{Key: "$currentDate", Value: bson.D{{Key: "updated_at", Value: true}}},
	}

	result, err := r.collection.UpdateOne(ctx, filter, updateDoc)
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	if result.MatchedCount == 0 {
		return ErrNotFound
	}
	return nil
}

// Upsert inserts or updates a document
func (r *Repository[T]) Upsert(ctx context.Context, filter bson.D, doc T) error {
	now := time.Now().UTC()
	doc.SetTimestamps(now, now)

	opts := options.Update().SetUpsert(true)
	update := bson.D{
		{Key: "$set", Value: doc},
		{Key: "$setOnInsert", Value: bson.D{{Key: "created_at", Value: now}}},
	}

	_, err := r.collection.UpdateOne(ctx, filter, update, opts)
	if err != nil {
		return fmt.Errorf("upsert: %w", err)
	}
	return nil
}

// DeleteByID soft-deletes or hard-deletes
func (r *Repository[T]) DeleteByID(ctx context.Context, id bson.ObjectID) error {
	filter := bson.D{{Key: "_id", Value: id}}
	result, err := r.collection.DeleteOne(ctx, filter)
	if err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	if result.DeletedCount == 0 {
		return ErrNotFound
	}
	return nil
}

// FindOptions controls query behavior
type FindOptions struct {
	Limit      int64
	Skip       int64
	Sort       bson.D
	Projection bson.D
}

// Errors
var (
	ErrNotFound  = errors.New("document not found")
	ErrDuplicate = errors.New("duplicate document")
)
```

### Junior → FAANG: connection management essentials

Connection pooling is where most junior MongoDB bugs live. The driver maintains a pool of TCP connections per `mongo.Client`, sized by `MaxPoolSize` (default 100) and kept warm by `MinPoolSize`. You create one `mongo.Client` per process and share it across goroutines. Creating a client per request is the single most common beginner mistake, and it shows up in production as connection storms and slow page loads. The client is goroutine-safe by design. Treat it as a long-lived singleton in your DI container.

Three gotchas every first-year Go engineer will eventually hit. First, `context.Context` is mandatory on every call, and the driver honors cancellation. If your HTTP handler uses a thirty-second context and the query takes forty, the driver cancels the in-flight command cleanly and returns `context.DeadlineExceeded`. Set per-operation timeouts derived from the request budget, not server-global ones. Second, `mongo.ErrNoDocuments` is the only way to tell "the document does not exist" from a real error on `FindOne`. Always wrap with `errors.Is`. Third, `InsertMany` with `SetOrdered(false)` returns a partial success as a `BulkWriteException`, not as a clean error, so you have to inspect `result.InsertedIDs` and the exception together. The repository code above demonstrates this pattern.

The generic repository in this section is production-ready for simple CRUD, but think about what it hides. Any time you want a query that is not `FindByID` or `Find(filter)`, you will reach past the repository to the raw collection. This is fine. Do not extend the generic repository into a leaky abstraction that recreates every query method of the driver. Keep the repository thin and let domain services compose aggregations directly on the collection when needed.

Interview entry-points: "How do you share a MongoDB client across a Go service?" (one `mongo.Client` per process, passed via DI, goroutine-safe), "What happens when the context deadline passes mid-query?" (driver cancels the server command via `killCursors` or the wire protocol's operation cancellation, returns `context.DeadlineExceeded`), and "Why `SetOrdered(false)`?" (so that a duplicate-key error on document three does not prevent documents four through ten from being inserted, improving throughput in idempotent backfills).

### Senior @ FAANG: pool sizing, observability, and the v2 driver's unstated rules

Connection pool sizing is a three-parameter problem, not a one-parameter problem. `MaxPoolSize` caps the total TCP connections to each server in the topology. `MinPoolSize` keeps a warm floor to avoid connection-establishment latency on the first query after an idle period. `MaxConnIdleTime` reclaims idle connections that survived the server's own `socketTimeoutMS`. The canonical formula for `MaxPoolSize` is `max(50, 2 * expected concurrent requests per process)`. For a Go service fronting an HTTP API with a thousand requests per second and a p99 query latency of twenty milliseconds, the concurrent query count is roughly twenty, so a pool of fifty is plenty. For a batch service running ten thousand parallel goroutines, you size to the database's ability to absorb connections, not the client's ability to open them. MongoDB 8.0 servers comfortably handle ten thousand connections per `mongod`, but the TCP kernel buffer memory becomes a real cost at that scale. The `waitQueueTimeoutMS` option (set via `SetWaitQueueTimeout` on the pool) controls how long a goroutine blocks waiting for a free connection before returning `context.DeadlineExceeded`. A value shorter than the request's context deadline allows fast failure under pool starvation rather than silent queueing.

Read preferences and write concerns deserve per-service thought. `readPreference:primary` is the default and is correct for any read where "read your own write" semantics matter. `primaryPreferred` falls back to secondaries if the primary is unreachable, which is appropriate for dashboards and non-critical reads. `nearest` picks the lowest-latency member regardless of role, which is the right default for globally distributed read-only analytics. Never use `secondary` without a causal consistency session because a stale secondary can return writes from seconds ago without warning. Write concerns are the dual. `w:majority, j:true` is the safe default but adds roughly one round trip of latency. For high-throughput write paths where durability is acceptable after a few hundred milliseconds, `w:1, j:false` with a background flusher is occasionally appropriate, but the ADR must document the data loss window.

Observability with `otelmongo` gives you a span per command, which is invaluable for cross-service tracing but expensive if you emit one span per document in a bulk write. Configure the span sampler to ratio-sample at the service level, and for batch services switch to a metric-only exporter to avoid flooding the trace backend. The v2 driver also exposes a `CommandMonitor` hook for structured logging of slow commands. Wire a threshold-based monitor (for example, log every command over two hundred milliseconds with the full filter and options) directly into your structured logger, redacting any fields flagged as PII. This is the lowest-effort high-value observability pattern in production MongoDB services.

TLS configuration for production should set `MinVersion: tls.VersionTLS13`, disable `InsecureSkipVerify`, and pin the CA certificate via `RootCAs` for mutual TLS to Atlas or a self-managed cluster. X.509 authentication is the production-grade alternative to SCRAM passwords and eliminates an entire class of credential-rotation headaches. Pair it with AWS IAM auth (`AUTH_MECHANISM=MONGODB-AWS`) on EKS workloads for short-lived credentials rotated by the IAM role itself. The URI format is `mongodb+srv://.../?authMechanism=MONGODB-AWS`, and the driver picks up the credential from the container's instance metadata.

One subtle v2 driver rule that catches staff engineers reviewing junior code: the `mongo.Connect` function no longer takes a context. Connectivity is confirmed asynchronously via `Ping`. Code that relies on `Connect` blocking until the server responds will silently proceed with an unhealthy client in v2. Always `Ping` with a bounded context after `Connect`, and fail fast on error rather than logging and continuing. This is in the v1-to-v2 migration notes but is often missed in mechanical ports.

---
