## 37.10 Common Mistakes

### Mistake 1: Setting MaxOpenConns Too High

Setting `MaxOpenConns` per instance without accounting for the total number of instances is the most common cause of "too many connections" errors. If PostgreSQL allows 100 connections and you run 10 pods each configured for 50, the sum (500) far exceeds the limit. Always divide the database's `max_connections` by the number of instances and subtract a buffer for admin and migration connections.

```go
// WRONG: More connections than database can handle
func BadPoolConfig(db *sql.DB) {
    // PostgreSQL default max_connections is 100
    // With 10 app pods, each sets 50 = 500 total = connection errors!
    db.SetMaxOpenConns(50)
    db.SetMaxIdleConns(50)
}

// CORRECT: Calculate based on actual limits
func GoodPoolConfig(db *sql.DB, dbMaxConns, appInstances, reserved int) {
    // Calculate per-instance limit
    perInstance := (dbMaxConns - reserved) / appInstances

    // Leave buffer for connection churn
    maxOpen := int(float64(perInstance) * 0.8)
    maxIdle := maxOpen / 2

    db.SetMaxOpenConns(maxOpen)
    db.SetMaxIdleConns(maxIdle)
    db.SetConnMaxLifetime(5 * time.Minute)
    db.SetConnMaxIdleTime(1 * time.Minute)
}
```

### Mistake 2: Not Setting Connection Lifetimes

Without `ConnMaxLifetime`, connections persist until the database server kills them, at which point the pool hands a dead connection to a goroutine, which sees an unexpected I/O error. Setting a lifetime shorter than the database's `idle_in_transaction_session_timeout` ensures the pool recycles connections proactively. `ConnMaxIdleTime` closes connections that have been sitting unused, freeing server memory during low-traffic periods.

```go
// WRONG: Connections live forever, hit database timeouts
func BadLifetime(db *sql.DB) {
    db.SetMaxOpenConns(25)
    // No lifetime set - connections may be terminated by DB
    // PostgreSQL idle_in_transaction_session_timeout, statement_timeout
}

// CORRECT: Set lifetime shorter than database timeouts
func GoodLifetime(db *sql.DB) {
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(10)

    // PostgreSQL default wait_timeout is often 8 hours
    // Set shorter to prevent using stale connections
    db.SetConnMaxLifetime(5 * time.Minute)

    // Close idle connections to release resources
    db.SetConnMaxIdleTime(1 * time.Minute)
}
```

### Mistake 3: Cross-Shard Joins

SQL `JOIN` only works when both tables are on the same database server. In a sharded setup, users might live on shard A and orders on shard B, making a direct join impossible. The fix is to either query each shard separately and join the results in application code, or denormalize by storing the data you need for joins (like `user_name`) directly in the orders table.

```go
// WRONG: Joining data across shards (doesn't work!)
func BadCrossShardJoin(shards []*sql.DB, userID, orderID int64) {
    // Users on shard A, orders on shard B - can't join!
    query := `
        SELECT u.name, o.total
        FROM users u
        JOIN orders o ON u.id = o.user_id
        WHERE o.id = $1
    `
    // This fails because tables are on different servers
}

// CORRECT: Denormalize or query sequentially
func GoodCrossShardQuery(shards []*sql.DB, userID, orderID int64) (*Result, error) {
    // Option 1: Query each shard separately
    userShard := shards[userID%int64(len(shards))]
    orderShard := shards[orderID%int64(len(shards))]

    var user User
    userShard.QueryRow("SELECT name FROM users WHERE id = $1", userID).Scan(&user.Name)

    var order Order
    orderShard.QueryRow("SELECT total FROM orders WHERE id = $1", orderID).Scan(&order.Total)

    // Join in application
    return &Result{UserName: user.Name, OrderTotal: order.Total}, nil

    // Option 2: Denormalize - store user_name in orders table
}
```

### Mistake 4: Not Using Read Replicas

Sending every query to the primary wastes replica capacity and limits your read throughput to a single node. If your workload is 90% reads, routing those reads to replicas lets the primary focus on writes and reduces its CPU and I/O load. Use the primary for writes and for reads that need immediate consistency (read-after-write), and send everything else to replicas.

```go
// WRONG: All traffic to primary
func BadReadPattern(primary *sql.DB) {
    // Read-heavy workload overwhelming primary
    for _, userID := range userIDs {
        primary.QueryRow("SELECT * FROM users WHERE id = $1", userID)
    }
}

// CORRECT: Route reads to replicas
func GoodReadPattern(replicaSet *ReplicaSet) {
    for _, userID := range userIDs {
        // Use replica for reads
        replica := replicaSet.Replica()
        replica.QueryRow("SELECT * FROM users WHERE id = $1", userID)
    }

    // Use primary only for writes
    primary := replicaSet.Primary()
    primary.Exec("INSERT INTO users ...")
}
```

### Mistake 5: Ignoring Pool Exhaustion

Calling `pool.Acquire(context.Background())` blocks indefinitely when every connection is in use. In a web server, this means the HTTP handler hangs, the load balancer retries, and the cascading requests consume even more goroutines, all waiting for a connection that never arrives. Always pass a context with a timeout and instrument the failure path with metrics so you can alert before users notice.

```go
// WRONG: No timeout on connection acquisition
func BadAcquire(pool *pgxpool.Pool) {
    // Blocks forever if pool exhausted
    conn, err := pool.Acquire(context.Background())
    if err != nil {
        // Error only on connection failure, not exhaustion
    }
}

// CORRECT: Set timeout and monitor
func GoodAcquire(pool *pgxpool.Pool) (*pgxpool.Conn, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    conn, err := pool.Acquire(ctx)
    if err != nil {
        if ctx.Err() == context.DeadlineExceeded {
            // Pool exhausted - log and alert
            slog.Error("connection pool exhausted",
                "total", pool.Stat().TotalConns(),
                "acquired", pool.Stat().AcquiredConns(),
            )
            metrics.PoolExhaustion.Inc()
        }
        return nil, fmt.Errorf("acquire connection: %w", err)
    }

    return conn, nil
}
```

### Junior → FAANG: Prerequisite Gaps and the "Why Did This Fail?" Reflex

If you are reading this chapter for the first time, the most common prerequisite gap is not Go. It is understanding that a database connection is a TCP socket plus a server-side process or thread plus negotiated session state. When you call `db.SetMaxOpenConns(50)`, you are not setting a Go thing. You are promising the database that this process will open up to 50 long-lived sockets, and each of those sockets pins memory and a backend worker on the database host. Junior engineers miss this and treat the pool like an in-process object cache. It is not. It is a reservation against a shared multi-tenant resource.

Worked example. You ship a service with `MaxOpenConns=100` and it works in staging. In production you horizontally scale to 20 pods and the database starts returning `FATAL: sorry, too many clients already`. The failure is not your Go code. It is arithmetic. 20 times 100 is 2000. Postgres default `max_connections` is 100. You oversubscribed the shared resource by 20x. Fix by computing per-pod budget from the database side down, not the pod side up.

First-job context. In your first year you will inherit a service that has all five mistakes above simultaneously. The review reflex that gets you promoted is asking, in this order, (1) what is the database `max_connections`, (2) how many replicas of this service exist, (3) what is `ConnMaxLifetime` set to, (4) is there a timeout on acquire, and (5) are reads routed to replicas. If you can answer these five before writing any code, you are already operating above L4 at most big companies.

Interview entry point. The canonical phone screen is "we run 10 instances of a Go service, each configured with a pool of 50 connections, against a Postgres with `max_connections=200`. What happens under load?" The answer is connection refusal at roughly 40 percent saturation because 10 times 50 is 500, which is 2.5x the server limit. The follow-up is "how would you fix it without scaling Postgres vertically?" Answer with connection multiplexing via PgBouncer in transaction pooling mode, a per-pod budget of roughly 15 connections reserving 50 for admin and replication, and backpressure on acquire with a context deadline.

"Why did this fail?" reflex. When a query errors with `driver: bad connection` or `EOF`, do not retry blindly. The pool just handed you a socket the server had already closed. Lower `ConnMaxLifetime` below the server's `idle_in_transaction_session_timeout`, `wait_timeout`, and any load balancer idle cutoff (AWS NLB is 350 seconds, GCP internal LB is 600 seconds). The rule is client lifetime strictly less than the shortest server-side or network-side timeout.

### Senior @ FAANG: Governance, ADRs, and the Maturity Model for Pool and Shard Mistakes

At staff and principal level these five mistakes are not code bugs. They are governance failures. The question changes from "how do I avoid this" to "how do I make it structurally impossible for any of the 400 services in my org to ship this mistake." This section captures the ADRs and maturity model I have seen hold up across three platform rebuilds.

ADR 1: pool size equals CPUs, not "bigger is better." Record in the database-platform ADR repo that the default pool size is `min(server_cpu_cores * 2, (server_max_connections - reserved) / instance_count)`. The rationale, which must be in the ADR body, is that a Postgres backend is CPU-bound on query parsing and index walks, so beyond `2 * cores` you add context-switching cost without throughput gain. Brandur Leach's benchmarks from 2018 still hold in 2026. Ship this as a linter rule in your shared database client library so that `SetMaxOpenConns` above the computed ceiling fails CI.

ADR 2: pool-per-tenant is an anti-pattern. Teams will propose "let us give each tenant their own pool for isolation." Reject this in writing. The math does not work. 1000 tenants times 5 connections each is 5000 backends, which no single Postgres can sustain. The correct isolation primitive is a shared pool with per-tenant semaphores in application code, or a dedicated physical shard per large tenant (the Notion pattern, where enterprise customers get their own database block). Document the threshold, typically tenants consuming more than 5 percent of aggregate query cost get their own shard, everyone else shares.

ADR 3: bounded pools over unbounded, always. `MaxOpenConns=0` means unlimited, which means the pool becomes a DoS vector against your own database during traffic spikes. Set a hard ceiling and prefer acquire timeouts that return `503 Service Unavailable` over queuing forever. Queuing in the pool converts a latency problem into an availability problem because upstream load balancers timeout and retry, multiplying load. This is the core lesson from many published outages where pool queuing turned a latency blip into a full availability cascade.

ADR 4: shard key is a tattoo. Once you shard by `user_id`, that choice is embedded in every query, every cache key, every analytics pipeline, and every data export. Changing it requires rewriting application code and rebuilding every derived system. The ADR must require a written justification for the shard key, a signed-off list of all queries that will run against the sharded table, and an explicit statement of which queries become impossible (cross-shard joins, global aggregations, alternate-key lookups without a lookup table). Treat the shard key review like a schema review at Google: one reviewer from the owning team, one from the database-platform team, one from the analytics team.

ADR 5: cross-shard join cost is quadratic. The scatter-gather pattern scales poorly. A query against N shards has tail latency equal to the slowest shard's p99, and variance grows with N. For N above 8, tail latency is typically 3x to 5x single-shard p99. Document that any query requiring more than 4 shards must either be denormalized, precomputed into a materialized view on a separate analytics store, or served from a search index (Elasticsearch, OpenSearch).

ADR 6: replica-lag blindness is a correctness bug. Reading from a replica without checking `pg_last_xact_replay_timestamp()` or equivalent means you can observe stale data after your own write. The governance fix is a typed session primitive: `Session.RequireFresh()` routes to primary, `Session.AllowStale(maxLag time.Duration)` routes to replica and checks lag, and unannotated queries fail the linter. This is the pattern read-heavy shops adopt after a replica-lag incident where a user briefly sees their own just-committed write as missing.

Interview signal ladder for these mistakes. L3 spots mistake 1 and 2 given the code. L4 writes the correct version and explains `ConnMaxLifetime` rationale. L5 names the load balancer idle timeout interaction and proposes PgBouncer. L6 designs the shared client library with the linter rules above and writes the ADRs. L7 runs the migration program that moves 400 services onto it over 18 months and reports connection-count reduction as an OKR.

Bar-raiser prompt for staff candidates. "You discover that all 400 services in the company set `MaxOpenConns=100` with no lifetime. The database cluster is at 95 percent connection saturation and degrades weekly. You have two quarters. Plan the rollout." Strong answer covers shadow mode for the new defaults, per-service opt-in with SLA review, a runtime override flag for emergency tuning, a Grafana dashboard that flags non-compliant services, and a plan for the 5 percent of services that legitimately need higher limits (data-loading pipelines, batch jobs). Weak answer says "we will send an email."

Maturity model, common-mistakes dimension. L1, mistakes are shipped to production and caught by customer reports. L2, mistakes are caught in code review by memory. L3, mistakes are caught by a shared linter in CI. L4, mistakes are caught by a typed client library where the wrong call does not compile. L5, the database-platform team runs a control plane that sets pool sizes dynamically based on observed load and server capacity, and individual services do not configure pools at all.

---
