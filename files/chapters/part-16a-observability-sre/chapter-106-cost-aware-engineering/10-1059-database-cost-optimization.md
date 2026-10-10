## 106.10 Database Cost Optimization

Database costs often dominate cloud bills. Optimizing database usage is critical for cost-aware engineering.

### Database Cost Strategies

Database costs break down into compute (CPU for query execution), storage (data at rest), I/O (reads and writes), and transfer (cross-region replication). The diagram below maps each cost category to its primary optimization lever.

```
┌──────────────────────────────────────────────────────────────────┐
│               DATABASE COST OPTIMIZATION                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  COST DRIVERS:                                                   │
│  ├── Provisioned capacity (IOPS, storage, compute)               │
│  ├── Data transfer (cross-region, internet egress)               │
│  ├── Backup storage                                              │
│  ├── Read replicas                                               │
│  └── Connection overhead                                         │
│                                                                  │
│  OPTIMIZATION STRATEGIES:                                        │
│  ├── Right-size instance type                                    │
│  ├── Use reserved capacity (1-3 year)                            │
│  ├── Implement connection pooling                                │
│  ├── Use read replicas wisely                                    │
│  ├── Optimize queries (reduce scans)                             │
│  ├── Archive old data to cheaper storage                         │
│  └── Consider serverless options                                 │
│                                                                  │
│  GO-SPECIFIC CONSIDERATIONS:                                     │
│  ├── Connection pool sizing (Go handles many connections well)   │
│  ├── Prepared statement caching                                  │
│  ├── Batch operations to reduce round trips                      │
│  └── Use pgx for PostgreSQL (more efficient than database/sql)   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Connection Pooling Optimization

Every idle database connection costs memory on both the client and the database server, and the server-side cost often forces a larger instance class. The examples below show cost-conscious pool settings for both `database/sql` and pgx, plus the pool metrics that reveal whether a pool is over- or under-sized.

```go
// Efficient database connection management
package database

import (
    "context"
    "database/sql"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    connectionPoolSize = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "db_connection_pool_size",
        Help: "Total connections in the pool",
    })
    connectionPoolIdle = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "db_connection_pool_idle",
        Help: "Idle connections in the pool",
    })
    connectionPoolInUse = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "db_connection_pool_in_use",
        Help: "Acquired connections in use",
    })
    connectionPoolUtilization = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "db_connection_pool_utilization",
        Help: "Ratio of acquired connections to total connections",
    })
)

// Standard library approach with cost-optimized settings
func NewCostOptimizedSQLDB(dsn string) (*sql.DB, error) {
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, err
    }

    // Cost optimization: minimize idle connections
    // Each connection costs memory on both client and server

    // MaxOpenConns: Match to your database's max_connections / number of pods
    // Too high = resource contention, potential costs
    // Too low = connection wait time
    db.SetMaxOpenConns(25)

    // MaxIdleConns: Keep some warm for burst traffic
    // Lower = less memory, higher = faster response to traffic spikes
    db.SetMaxIdleConns(5)

    // ConnMaxLifetime: Force connection refresh
    // Helps with load balancer connection distribution
    db.SetConnMaxLifetime(5 * time.Minute)

    // ConnMaxIdleTime: Close idle connections
    // Important for serverless where you pay for connections
    db.SetConnMaxIdleTime(1 * time.Minute)

    return db, nil
}

// pgx pool with advanced cost optimization
func NewCostOptimizedPgxPool(ctx context.Context, connString string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(connString)
    if err != nil {
        return nil, err
    }

    // Minimal connections to reduce database load
    config.MinConns = 2
    config.MaxConns = 25

    // Health check to detect stale connections
    config.HealthCheckPeriod = 30 * time.Second

    // Connection lifetime management
    config.MaxConnLifetime = 5 * time.Minute
    config.MaxConnIdleTime = 1 * time.Minute

    return pgxpool.NewWithConfig(ctx, config)
}

// Connection pool metrics for cost monitoring
type PoolMetrics struct {
    pool *pgxpool.Pool
}

func (m *PoolMetrics) Record() {
    stats := m.pool.Stat()

    // Track for right-sizing
    connectionPoolSize.Set(float64(stats.TotalConns()))
    connectionPoolIdle.Set(float64(stats.IdleConns()))
    connectionPoolInUse.Set(float64(stats.AcquiredConns()))

    // High wait time = need more connections
    // High idle = too many connections (wasting money)
    connectionPoolUtilization.Set(
        float64(stats.AcquiredConns()) / float64(stats.TotalConns()),
    )
}
```

### Query Optimization for Cost

Reducing database costs starts with reducing the work the database performs per request. The techniques below, eliminating N+1 query patterns with a join, batching inserts inside a single transaction, and using PostgreSQL COPY for bulk loads, each target a different cost driver.

```go
// Query patterns that reduce database costs
package database

import (
    "context"
    "database/sql"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
    ID   int64
    Name string
}

type Order struct {
    ID         int64
    UserID     int64
    TotalCents int64
}

type UserWithOrders struct {
    User   User
    Orders []Order
}

// BAD: N+1 query pattern, expensive!
func GetUsersWithOrdersBad(ctx context.Context, db *sql.DB) ([]UserWithOrders, error) {
    users, _ := db.QueryContext(ctx, "SELECT id, name FROM users LIMIT 100")

    var results []UserWithOrders
    for users.Next() {
        var u User
        users.Scan(&u.ID, &u.Name)

        // N additional queries! Each costs IOPS
        orders, _ := db.QueryContext(ctx,
            "SELECT id, total_cents FROM orders WHERE user_id = $1", u.ID)
        // ... process orders
        _ = orders
        results = append(results, UserWithOrders{User: u})
    }
    return results, nil
}

// GOOD: Single query with JOIN, much cheaper
func GetUsersWithOrdersGood(ctx context.Context, db *sql.DB) ([]UserWithOrders, error) {
    rows, err := db.QueryContext(ctx, `
        SELECT u.id, u.name, o.id, o.total_cents
        FROM users u
        LEFT JOIN orders o ON o.user_id = u.id
        LIMIT 1000
    `)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    // Process in single pass
    userMap := make(map[int64]*UserWithOrders)
    for rows.Next() {
        var userID int64
        var userName string
        var orderID sql.NullInt64
        var orderTotalCents sql.NullInt64

        rows.Scan(&userID, &userName, &orderID, &orderTotalCents)

        if _, exists := userMap[userID]; !exists {
            userMap[userID] = &UserWithOrders{
                User: User{ID: userID, Name: userName},
            }
        }
        if orderID.Valid {
            userMap[userID].Orders = append(userMap[userID].Orders,
                Order{ID: orderID.Int64, UserID: userID, TotalCents: orderTotalCents.Int64})
        }
    }

    results := make([]UserWithOrders, 0, len(userMap))
    for _, u := range userMap {
        results = append(results, *u)
    }
    return results, nil
}

// Batch inserts to reduce IOPS costs
func BatchInsertOrders(ctx context.Context, db *sql.DB, orders []Order) error {
    // BAD: Individual inserts
    // for _, order := range orders {
    //     db.ExecContext(ctx, "INSERT INTO orders...", order.ID, order.TotalCents)
    // }
    // Cost: N round trips, N transaction commits

    // GOOD: Batch insert
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.PrepareContext(ctx,
        "INSERT INTO orders (id, user_id, total_cents) VALUES ($1, $2, $3)")
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, order := range orders {
        if _, err := stmt.ExecContext(ctx, order.ID, order.UserID, order.TotalCents); err != nil {
            return err
        }
    }

    return tx.Commit()
    // Cost: 1 round trip, 1 transaction commit, batched IOPS
}

// Use COPY for bulk loads (PostgreSQL)
func BulkLoadOrders(ctx context.Context, pool *pgxpool.Pool, orders []Order) error {
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return err
    }
    defer conn.Release()

    _, err = conn.Conn().CopyFrom(
        ctx,
        pgx.Identifier{"orders"},
        []string{"id", "user_id", "total_cents"},
        pgx.CopyFromSlice(len(orders), func(i int) ([]any, error) {
            return []any{
                orders[i].ID,
                orders[i].UserID,
                orders[i].TotalCents,
            }, nil
        }),
    )
    return err
    // Cost: Single COPY operation, minimal IOPS
}
```

### Serverless Database Cost Comparison

Serverless databases (Aurora Serverless, DynamoDB, PlanetScale) charge per request or per ACU-second rather than per provisioned instance, which shifts the cost model from fixed to variable. The calculator below compares monthly costs across providers given a known request volume, average payload size, and storage footprint.

```go
// Serverless database cost calculator
package cost

type ServerlessDBWorkload struct {
    ReadsPerMonth     int64   // Number of read operations
    WritesPerMonth    int64   // Number of write operations
    StorageGB         float64 // Data storage
    PeakRCU           int64   // Peak read capacity units
    PeakWCU           int64   // Peak write capacity units
    ActiveHoursPerDay float64 // Hours with traffic
}

func CompareServerlessDBCosts(w ServerlessDBWorkload) map[string]float64 {
    costs := make(map[string]float64)

    // DynamoDB On-Demand (us-east-1, after the Nov 2024 price cut)
    // ~$0.125 per million read request units
    // ~$0.625 per million write request units
    // $0.25 per GB-month storage
    dynamoDBCost := float64(w.ReadsPerMonth)/1000000*0.125 +
        float64(w.WritesPerMonth)/1000000*0.625 +
        w.StorageGB*0.25
    costs["DynamoDB On-Demand"] = dynamoDBCost

    // DynamoDB Provisioned (with reserved capacity)
    // Assume 1 year reserved, ~50% discount
    dynamoProvisionedCost := (float64(w.PeakRCU)*0.00013 +
        float64(w.PeakWCU)*0.00065) * 730 * 0.5 +
        w.StorageGB*0.25
    costs["DynamoDB Provisioned"] = dynamoProvisionedCost

    // Aurora Serverless v2
    // $0.12 per ACU-hour, min 0.5 ACU
    // $0.10 per GB-month storage
    avgACU := float64(w.PeakRCU+w.PeakWCU) / 1000 // Rough conversion
    if avgACU < 0.5 {
        avgACU = 0.5
    }
    auroraServerlessCost := avgACU * 0.12 * w.ActiveHoursPerDay * 30 +
        w.StorageGB*0.10
    costs["Aurora Serverless v2"] = auroraServerlessCost

    // Cloud Spanner
    // $0.90 per node-hour (minimum 1 node)
    // $0.30 per GB-month storage
    spannerCost := 1 * 0.90 * 730 + w.StorageGB*0.30 // Minimum 1 node
    costs["Cloud Spanner"] = spannerCost

    // PlanetScale (MySQL serverless, illustrative usage-based rates)
    // ~$0.25 per 1B row reads
    // ~$0.50 per 1M row writes
    // ~$1.25 per GB storage
    planetScaleCost := float64(w.ReadsPerMonth)/1000000000*0.25 +
        float64(w.WritesPerMonth)/1000000*0.50 +
        w.StorageGB*1.25
    costs["PlanetScale"] = planetScaleCost

    return costs
}
```

### Junior → FAANG: Database Cost Is Driven by Queries, Not Just Storage

Junior engineers typically think of database cost in terms of storage: more data means higher cost. At scale, the dominant database cost drivers are query volume (reads and writes), connection count (which determines instance class requirements), and cross-AZ replication traffic. Understanding this changes how you think about optimization: a service that reduces its read query count by 50% through caching often reduces database cost more than one that deletes 50% of old data.

The connection pool sizing is the most underestimated cost lever. Each database connection holds memory on the database server. A PostgreSQL connection with typical session state uses 5-10 MB. A service with 200 pods each holding 10 connections is maintaining 2,000 database connections consuming 10-20 GB of database server memory. This forces a larger instance class than the query volume alone would require. Using PgBouncer or a connection pooler at transaction mode can reduce actual server connections by 10x without changing application-level connection pool behavior.

### Senior @ FAANG: Database Cost as an Architecture Decision

At L6, the database cost comparison code in this chapter is a starting point for a larger architectural decision: when does the operational cost of self-managed PostgreSQL on RDS justify the additional engineering overhead compared to a serverless database (Aurora Serverless, PlanetScale, Neon)? The break-even depends on traffic pattern predictability, team operational expertise, and query latency requirements.

Aurora Serverless v2 can scale from zero (auto-pause, supported since late 2024) up to 256 ACUs (Aurora Capacity Units) in fine-grained increments, making it cost-optimal for workloads with high variability (bursty traffic, development environments, staging). However, Aurora Serverless costs 1.5-2x per ACU compared to provisioned Aurora at the same capacity level, making it more expensive for steady-state workloads above 40% utilization. The crossover point is specific to each workload's traffic shape.

The data tiering strategy is the highest-value database cost optimization at scale. Data more than 90 days old is rarely accessed in most production databases, but it occupies expensive provisioned storage and slows full-table operations. Archiving cold data to S3 with Athena or Redshift Spectrum for analytical queries, and implementing soft deletes with a background archiving job, can reduce primary database storage by 50-80% for applications with data retention requirements measured in years. The engineering investment in building the archive pipeline is typically recovered in storage cost savings within 6-12 months at database sizes above 1 TB.

---
