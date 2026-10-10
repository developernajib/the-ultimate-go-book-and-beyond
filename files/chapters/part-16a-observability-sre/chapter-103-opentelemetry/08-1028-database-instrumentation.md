## 103.8 Database Instrumentation

### SQL Tracing with otelsql

The `otelsql` library wraps Go's `database/sql` driver to create spans for every query, transaction, and connection acquisition. Each span captures the SQL operation type, table name, and execution duration, giving you per-query visibility in your trace waterfall without modifying application query code.

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "github.com/XSAM/otelsql"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"

    _ "github.com/lib/pq"
)

var tracer = otel.Tracer("database")

// Config holds database configuration
type Config struct {
    Host         string
    Port         int
    User         string
    Password     string
    Database     string
    MaxOpenConns int
    MaxIdleConns int
}

// NewDB creates an instrumented database connection
func NewDB(cfg Config) (*sql.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
        cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database,
    )

    // Register the driver with OpenTelemetry
    db, err := otelsql.Open("postgres", dsn,
        otelsql.WithAttributes(
            semconv.DBSystemPostgreSQL,
            semconv.DBName(cfg.Database),
            semconv.ServerAddress(cfg.Host),
            semconv.ServerPort(cfg.Port),
        ),
        otelsql.WithSpanOptions(otelsql.SpanOptions{
            Ping:             true,
            RowsNext:         false, // Disable per-row tracing
            DisableErrSkip:   true,
            OmitConnResetSession: true,
            OmitRows:         true,
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("open database: %w", err)
    }

    // Configure connection pool
    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(time.Hour)

    // Register metrics
    if err := otelsql.RegisterDBStatsMetrics(db,
        otelsql.WithAttributes(
            attribute.String("db.name", cfg.Database),
        ),
    ); err != nil {
        return nil, fmt.Errorf("register metrics: %w", err)
    }

    return db, nil
}

// UserRepository demonstrates traced database operations
type UserRepository struct {
    db *sql.DB
}

func NewUserRepository(db *sql.DB) *UserRepository {
    return &UserRepository{db: db}
}

// FindByID retrieves a user with tracing
func (r *UserRepository) FindByID(ctx context.Context, id string) (*User, error) {
    ctx, span := tracer.Start(ctx, "UserRepository.FindByID",
        trace.WithAttributes(
            attribute.String("db.operation", "SELECT"),
            attribute.String("db.table", "users"),
            attribute.String("user.id", id),
        ),
    )
    defer span.End()

    query := `SELECT id, email, name, created_at, updated_at FROM users WHERE id = $1`

    span.SetAttributes(
        attribute.String("db.statement", query),
    )

    var user User
    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &user.ID, &user.Email, &user.Name, &user.CreatedAt, &user.UpdatedAt,
    )
    if err != nil {
        if err == sql.ErrNoRows {
            span.SetAttributes(attribute.Bool("db.not_found", true))
            return nil, ErrNotFound
        }
        span.RecordError(err)
        return nil, err
    }

    return &user, nil
}

// Create inserts a user with tracing
func (r *UserRepository) Create(ctx context.Context, user *User) error {
    ctx, span := tracer.Start(ctx, "UserRepository.Create",
        trace.WithAttributes(
            attribute.String("db.operation", "INSERT"),
            attribute.String("db.table", "users"),
        ),
    )
    defer span.End()

    query := `
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
    `

    result, err := r.db.ExecContext(ctx, query,
        user.ID, user.Email, user.Name, user.CreatedAt, user.UpdatedAt,
    )
    if err != nil {
        span.RecordError(err)
        return err
    }

    rowsAffected, _ := result.RowsAffected()
    span.SetAttributes(attribute.Int64("db.rows_affected", rowsAffected))

    return nil
}

// BulkInsert demonstrates batch operations with tracing
func (r *UserRepository) BulkInsert(ctx context.Context, users []*User) error {
    ctx, span := tracer.Start(ctx, "UserRepository.BulkInsert",
        trace.WithAttributes(
            attribute.String("db.operation", "BULK_INSERT"),
            attribute.String("db.table", "users"),
            attribute.Int("batch.size", len(users)),
        ),
    )
    defer span.End()

    tx, err := r.db.BeginTx(ctx, nil)
    if err != nil {
        span.RecordError(err)
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.PrepareContext(ctx, `
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
    `)
    if err != nil {
        span.RecordError(err)
        return err
    }
    defer stmt.Close()

    for i, user := range users {
        _, err := stmt.ExecContext(ctx, user.ID, user.Email, user.Name, user.CreatedAt, user.UpdatedAt)
        if err != nil {
            span.RecordError(err)
            span.SetAttributes(attribute.Int("batch.failed_at", i))
            return err
        }
    }

    if err := tx.Commit(); err != nil {
        span.RecordError(err)
        return err
    }

    span.SetAttributes(attribute.Int("batch.inserted", len(users)))
    return nil
}

// Search demonstrates traced queries with multiple results
func (r *UserRepository) Search(ctx context.Context, query string, limit, offset int) ([]*User, int, error) {
    ctx, span := tracer.Start(ctx, "UserRepository.Search",
        trace.WithAttributes(
            attribute.String("db.operation", "SELECT"),
            attribute.String("search.query", query),
            attribute.Int("pagination.limit", limit),
            attribute.Int("pagination.offset", offset),
        ),
    )
    defer span.End()

    // Get total count
    var total int
    countQuery := `SELECT COUNT(*) FROM users WHERE name ILIKE $1 OR email ILIKE $1`
    searchPattern := "%" + query + "%"

    err := r.db.QueryRowContext(ctx, countQuery, searchPattern).Scan(&total)
    if err != nil {
        span.RecordError(err)
        return nil, 0, err
    }

    // Get paginated results
    selectQuery := `
        SELECT id, email, name, created_at, updated_at
        FROM users
        WHERE name ILIKE $1 OR email ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `

    rows, err := r.db.QueryContext(ctx, selectQuery, searchPattern, limit, offset)
    if err != nil {
        span.RecordError(err)
        return nil, 0, err
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.UpdatedAt); err != nil {
            span.RecordError(err)
            return nil, 0, err
        }
        users = append(users, &u)
    }

    span.SetAttributes(
        attribute.Int("result.total", total),
        attribute.Int("result.returned", len(users)),
    )

    return users, total, nil
}
```

### MongoDB Instrumentation

The official MongoDB driver exposes a command monitor hook, and `otelmongo.NewMonitor` plugs into it to create a span for every command the driver sends. The repository methods below then layer business-level spans and attributes on top of that automatic per-command instrumentation.

```go
package mongodb

import (
    "context"
    "time"

    "go.mongodb.org/mongo-driver/bson"
    "go.mongodb.org/mongo-driver/bson/primitive"
    "go.mongodb.org/mongo-driver/mongo"
    "go.mongodb.org/mongo-driver/mongo/options"
    "go.opentelemetry.io/contrib/instrumentation/go.mongodb.org/mongo-driver/mongo/otelmongo"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("mongodb")

// NewClient creates an instrumented MongoDB client
func NewClient(ctx context.Context, uri string) (*mongo.Client, error) {
    opts := options.Client().
        ApplyURI(uri).
        SetMonitor(otelmongo.NewMonitor(
            otelmongo.WithTracerProvider(otel.GetTracerProvider()),
            otelmongo.WithCommandAttributeDisabled(false),
        ))

    client, err := mongo.Connect(ctx, opts)
    if err != nil {
        return nil, err
    }

    // Verify connection
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    if err := client.Ping(ctx, nil); err != nil {
        return nil, err
    }

    return client, nil
}

// EventRepository demonstrates MongoDB operations with tracing
type EventRepository struct {
    collection *mongo.Collection
}

func NewEventRepository(client *mongo.Client, dbName string) *EventRepository {
    return &EventRepository{
        collection: client.Database(dbName).Collection("events"),
    }
}

// Create inserts an event with additional tracing
func (r *EventRepository) Create(ctx context.Context, event *Event) error {
    ctx, span := tracer.Start(ctx, "EventRepository.Create",
        trace.WithAttributes(
            attribute.String("db.mongodb.collection", "events"),
            attribute.String("event.type", event.Type),
        ),
    )
    defer span.End()

    event.CreatedAt = time.Now()

    result, err := r.collection.InsertOne(ctx, event)
    if err != nil {
        span.RecordError(err)
        return err
    }

    span.SetAttributes(
        attribute.String("db.mongodb.insert_id", result.InsertedID.(primitive.ObjectID).Hex()),
    )

    return nil
}

// FindByUserID retrieves events for a user
func (r *EventRepository) FindByUserID(ctx context.Context, userID string, opts QueryOptions) ([]*Event, error) {
    ctx, span := tracer.Start(ctx, "EventRepository.FindByUserID",
        trace.WithAttributes(
            attribute.String("user.id", userID),
            attribute.Int("query.limit", opts.Limit),
        ),
    )
    defer span.End()

    filter := bson.M{"user_id": userID}
    if !opts.StartTime.IsZero() {
        filter["created_at"] = bson.M{
            "$gte": opts.StartTime,
            "$lte": opts.EndTime,
        }
    }

    findOpts := options.Find().
        SetLimit(int64(opts.Limit)).
        SetSort(bson.M{"created_at": -1})

    cursor, err := r.collection.Find(ctx, filter, findOpts)
    if err != nil {
        span.RecordError(err)
        return nil, err
    }
    defer cursor.Close(ctx)

    var events []*Event
    if err := cursor.All(ctx, &events); err != nil {
        span.RecordError(err)
        return nil, err
    }

    span.SetAttributes(attribute.Int("result.count", len(events)))
    return events, nil
}

// Aggregate performs traced aggregation
func (r *EventRepository) AggregateByType(ctx context.Context, userID string) (map[string]int64, error) {
    ctx, span := tracer.Start(ctx, "EventRepository.AggregateByType",
        trace.WithAttributes(
            attribute.String("user.id", userID),
            attribute.String("db.operation", "aggregate"),
        ),
    )
    defer span.End()

    pipeline := mongo.Pipeline{
        {{Key: "$match", Value: bson.M{"user_id": userID}}},
        {{Key: "$group", Value: bson.M{
            "_id":   "$type",
            "count": bson.M{"$sum": 1},
        }}},
    }

    cursor, err := r.collection.Aggregate(ctx, pipeline)
    if err != nil {
        span.RecordError(err)
        return nil, err
    }
    defer cursor.Close(ctx)

    results := make(map[string]int64)
    for cursor.Next(ctx) {
        var result struct {
            Type  string `bson:"_id"`
            Count int64  `bson:"count"`
        }
        if err := cursor.Decode(&result); err != nil {
            span.RecordError(err)
            return nil, err
        }
        results[result.Type] = result.Count
    }

    span.SetAttributes(attribute.Int("result.types", len(results)))
    return results, nil
}
```

### Junior → FAANG: Database Spans Reveal the N+1 Problem in Production

Database instrumentation is one of the highest-value observability investments because database queries are the most common source of production performance regressions. When every query is wrapped in a span with `db.statement`, `db.operation`, and `db.name` attributes, a Jaeger flame chart immediately reveals N+1 query patterns: a parent span with dozens of sequential child database spans, each fetching one row, where a single JOIN query would suffice.

The key habit: always truncate `db.statement` before recording it as a span attribute. Full SQL statements can contain user-supplied values that include PII. Truncate to 200 characters and strip literal string values from WHERE clauses before setting the attribute.

Interview entry point: "What OTel semantic convention attributes would you add to a database span?" At minimum: `db.system` (e.g., "postgresql"), `db.name` (database name), `db.operation` (SELECT, INSERT, UPDATE), and `db.statement` (truncated, PII-scrubbed query). This answer demonstrates knowledge of the OTel semantic conventions spec, not just ad-hoc attribute naming. Mentioning that newer semconv versions rename these to `db.query.text`, `db.operation.name`, and `db.namespace` shows you track the spec's evolution.

### Senior @ FAANG: Database Observability, Query Attribution, and Connection Pool Telemetry

**Query attribution for capacity planning.** At FAANG scale, database capacity planning requires knowing which service and which query pattern consumes the most database CPU. Database spans enable this attribution: by aggregating span duration grouped by `service.name` and `db.statement`, you can identify the top five query patterns by database load. This data drives capacity decisions (increase read replicas, add an index, refactor the query) before the database becomes a bottleneck.

**Connection pool instrumentation.** Application-level database spans show query execution time, but they do not show time spent waiting for a connection from the pool. A service that appears slow in traces may actually be healthy at the query level but starved for connections. Instrumenting the connection pool (wrapping `sql.DB` to emit gauge metrics for `db.client.connections.usage`, `db.client.connections.wait_time`, and `db.client.connections.max`) is necessary to distinguish between slow queries and connection starvation. This is a platform-level instrumentation requirement, not an individual service concern.

**Transaction span boundaries.** A multi-statement database transaction should be represented as a single span (the transaction span) with child spans for each individual query. This makes it clear in the trace that the queries are atomic and their latency must be summed. A common mistake is treating each query independently, which hides the fact that long-running transactions hold locks and block concurrent writes.

**db.statement sanitization as a security control.** Recording full SQL statements including user-supplied values in traces creates a high-severity data leak: the tracing backend (often a third-party SaaS) stores PII and potentially authentication tokens embedded in LIKE clauses or IN lists. An L6 engineer ensures the shared database instrumentation wrapper scrubs all literal string and number values from SQL before recording the statement attribute, replacing them with placeholders, and documents this scrubbing in the security runbook.

---
