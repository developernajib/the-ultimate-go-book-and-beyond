# Scaling from One Server to Millions

Every production system you will ever work on started as something simple. The skill is knowing when to evolve each layer, not over-engineering it from day one. This chapter walks the stages in order and shows the Go-specific mechanics at each step.

---

## Stage 0: The Single Server

Your first deployment puts everything on one machine: the web process, the database, and any in-process cache. A user hits your domain, DNS resolves to the machine's IP, and a single Go binary handles the request, queries the local database, and responds.

```go
// main.go, simplest possible Go server
package main

import (
    "database/sql"
    "net/http"

    _ "github.com/lib/pq"
)

func main() {
    db, _ := sql.Open("postgres", "host=localhost dbname=app sslmode=disable")
    http.HandleFunc("/products/", makeProductHandler(db))
    http.ListenAndServe(":8080", nil)
}
```

This setup is correct for early traffic. It is fast to deploy, trivial to debug, and costs almost nothing.

**When it breaks:** CPU or memory on the box pegs at 100%, response times climb, and you have no failover. One restart takes your whole site down.

---

## Stage 1: Separate Web Tier and Data Tier

The first split moves the database to its own machine. Web servers become stateless compute, the database server owns persistent state.

Why this split first? Web servers are CPU and memory consumers. Databases are I/O consumers with very different tuning requirements (buffer pools, WAL, connection limits). Mixing them on one machine means they fight for the same resources.

```go
// Connect to a remote Postgres instance
dsn := "host=db.internal port=5432 user=app password=secret dbname=app sslmode=require"
db, err := sql.Open("postgres", dsn)
db.SetMaxOpenConns(25)
db.SetMaxIdleConns(10)
```

You can now scale web VMs independently of the database. Traffic spikes? Add another web VM. Database slow? Tune or upgrade the DB box without touching web servers.

**Go note:** `database/sql` uses a connection pool by default. Set `SetMaxOpenConns` to avoid overwhelming Postgres with connections from many web replicas.

---

## Stage 2: Horizontal Scaling with a Load Balancer

With multiple web servers sharing a single database, you need a component in front to distribute requests. That component is the load balancer.

```
Client --> Load Balancer --> [Web-1, Web-2, Web-3] --> DB
```

Your Go services must be stateless. Any server must be able to handle any request. This means:

- No in-process session state. Move sessions to Redis or encode them in a signed cookie.
- No local file writes during a request. Write to object storage (S3) instead.

```go
// Session stored in a signed cookie, not in-process memory
import "github.com/gorilla/sessions"

var store = sessions.NewCookieStore([]byte(os.Getenv("SESSION_KEY")))

func loginHandler(w http.ResponseWriter, r *http.Request) {
    session, _ := store.Get(r, "session")
    session.Values["user_id"] = 42
    session.Save(r, w)
}
```

Load balancer algorithms to know: round-robin works when all servers are identical. Least-connections is better when request durations vary widely. IP hashing pins a user to one server, useful only when you cannot eliminate local state.

**Go note:** Behind AWS ALB or nginx, your `net/http` server sees the real client IP via the `X-Forwarded-For` header. Read it explicitly, do not use `r.RemoteAddr` for rate limiting.

---

## Stage 3: Database Read Replicas

After separating web and DB tiers, writes still funnel to one primary. Reads, which are usually 80-90% of traffic, can go to replicas.

Postgres streaming replication sends WAL changes to replicas asynchronously. Reads from replicas are slightly behind the primary (replication lag). This is acceptable for most reads (product listings, user profiles) but not for reads that must reflect a just-completed write (reading your own post immediately after posting it).

```go
// Route reads to replica, writes to primary
type DB struct {
    primary *sql.DB
    replica *sql.DB
}

func (d *DB) QueryReplica(query string, args ...any) (*sql.Rows, error) {
    return d.replica.Query(query, args...)
}

func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
    return d.primary.Exec(query, args...)
}
```

Add multiple replicas to spread read load further. AWS RDS and Cloud SQL both support read replicas with a single connection string change.

**When writes become the bottleneck:** Replica routing stops helping. Look at Stage 6 (sharding) or move write-heavy workloads into a queue (see Stage 7).

---

## Stage 4: Caching Layer

Caching trades memory for latency. A cache hit avoids a round trip to the database entirely.

### Cache-Aside (Lazy Loading)

The application checks the cache first. On a miss, it reads from the database and populates the cache.

```go
import "github.com/redis/go-redis/v9"

func getProduct(ctx context.Context, rdb *redis.Client, db *sql.DB, id int) (*Product, error) {
    key := fmt.Sprintf("product:%d", id)

    val, err := rdb.Get(ctx, key).Result()
    if err == nil {
        var p Product
        json.Unmarshal([]byte(val), &p)
        return &p, nil
    }

    // Cache miss: query the database
    var p Product
    row := db.QueryRowContext(ctx, "SELECT id, name, price_cents FROM products WHERE id = $1", id)
    row.Scan(&p.ID, &p.Name, &p.PriceCents)

    data, _ := json.Marshal(p)
    rdb.Set(ctx, key, data, 5*time.Minute) // TTL discipline
    return &p, nil
}
```

### Write-Through

On every write, update the database and the cache together. The cache is never stale but writes are slightly slower.

### TTL Discipline

Always set a TTL on cached entries. A cache without TTLs is a memory leak waiting to happen. Choose TTLs based on how often the underlying data changes: session tokens (15 minutes), product prices (5 minutes), static content (24 hours or more).

**Go note:** `go-redis/v9` uses `context.Context` for all operations. Pass the request context through so cache operations respect cancellation and deadlines.

---

## Stage 5: CDN for Static Assets

A Content Delivery Network places copies of your static files (JS, CSS, images, fonts) at edge nodes around the world. Users download assets from the closest node rather than from your origin servers.

Benefits:
- Reduced origin load (static assets account for most of a page's bytes)
- Lower latency globally
- Automatic DDoS absorption at the edge

In Go, you are not serving CDN traffic directly. Your job is to set correct cache headers on responses to static assets so the CDN and browsers cache aggressively.

```go
func staticHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
    // serve the file
    http.ServeFile(w, r, "public"+r.URL.Path)
}
```

Use content-hashed filenames (`app.a3f9c1.js`) so you can set a one-year max-age without worrying about stale assets after deployments.

---

## Stage 6: Database Sharding

Sharding splits data across multiple database instances, each owning a subset of rows. This is a last resort for write scale. It adds significant operational complexity.

### Sharding strategies

- **Range-based:** user IDs 1-1M go to shard A, 1M-2M to shard B. Simple but hot-spot prone.
- **Hash-based:** `shard_id = hash(user_id) % num_shards`. Even distribution, but rebalancing when adding shards requires data migration.

```go
func shardDB(userID int, shards []*sql.DB) *sql.DB {
    idx := userID % len(shards)
    return shards[idx]
}
```

### When NOT to reach for sharding

- You have not yet tried connection pooling (PgBouncer).
- You have not added read replicas.
- You have not optimized slow queries and added proper indexes.
- Your dataset fits in a well-tuned single Postgres instance (up to several TB with SSDs).

Cross-shard queries (joins across shards) require application-level aggregation. Foreign key constraints across shards do not exist. Transactions spanning shards require distributed transaction protocols (two-phase commit), which are slow and complex.

---

## Stage 7: Microservices Split

A microservices split breaks a monolith into separate deployable services. Each service owns its own database. Services communicate over HTTP, gRPC, or a message queue.

### Costs

- Network calls replace in-process function calls. Latency increases.
- Distributed tracing is mandatory to debug failures.
- Data consistency across services requires eventual consistency patterns or sagas.
- Teams must coordinate API contracts and versioning.

### When it is justified

- A single part of the system (say, video transcoding or payment processing) has fundamentally different scaling requirements from the rest.
- Multiple teams own different domains and coupling is slowing releases.
- A service needs a different technology (e.g., a Python ML service alongside a Go API).

```go
// gRPC client calling a separate inventory service
import (
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

conn, err := grpc.NewClient("inventory:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
client := inventorypb.NewInventoryClient(conn)
resp, err := client.CheckStock(ctx, &inventorypb.StockRequest{ProductId: productID})
```

Start with a modular monolith. Extract services only when you have a concrete reason. The monolith is not the enemy, the coupling inside it is.

---

## Summary: The Decision Ladder

| Traffic signal | Action |
|---|---|
| Single server at capacity | Separate web and DB tiers |
| Web servers at capacity | Add servers behind a load balancer, make servers stateless |
| DB reads slow | Add read replicas, route reads to replicas |
| Repeated DB reads for same data | Add a Redis caching layer with TTL |
| Static assets load slowly globally | Put assets behind a CDN |
| DB writes at capacity (after all else tried) | Consider sharding |
| Scaling a specific domain independently | Extract a microservice |

Each stage adds operational complexity. Add complexity only when you have data showing the current stage is the bottleneck.

**Watch:** [System Design Course](https://www.youtube.com/watch?v=C842vFY5kRo)
