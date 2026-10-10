## 37.3 Connection Pool Patterns

### Acquire with Timeout

When the pool is fully utilized, `pool.Acquire` blocks until a connection becomes available or the context expires. Wrapping the call in a short deadline prevents a single slow consumer from stalling the entire request pipeline. The generic helper functions below also ensure that connections and transactions are always released or rolled back, even when the caller's function panics or returns early.

```go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// AcquireWithTimeout gets a connection with custom timeout
func AcquireWithTimeout(
    ctx context.Context,
    pool *pgxpool.Pool,
    timeout time.Duration,
) (*pgxpool.Conn, error) {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    conn, err := pool.Acquire(ctx)
    if err != nil {
        if ctx.Err() == context.DeadlineExceeded {
            return nil, fmt.Errorf("connection pool exhausted, timeout after %v", timeout)
        }
        return nil, err
    }

    return conn, nil
}

// WithConnection executes a function with a pooled connection
func WithConnection[T any](
    ctx context.Context,
    pool *pgxpool.Pool,
    fn func(conn *pgxpool.Conn) (T, error),
) (T, error) {
    var zero T

    conn, err := pool.Acquire(ctx)
    if err != nil {
        return zero, fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    return fn(conn)
}

// WithTransaction executes a function within a transaction
func WithTransaction[T any](
    ctx context.Context,
    pool *pgxpool.Pool,
    fn func(tx pgx.Tx) (T, error),
) (T, error) {
    var zero T

    tx, err := pool.Begin(ctx)
    if err != nil {
        return zero, fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback(ctx)

    result, err := fn(tx)
    if err != nil {
        return zero, err
    }

    if err := tx.Commit(ctx); err != nil {
        return zero, fmt.Errorf("committing transaction: %w", err)
    }

    return result, nil
}
```

### Connection Health Checking

A health checker runs periodic `PingContext` calls in a background goroutine and exposes the result through an atomic boolean. Kubernetes liveness and readiness probes can query `IsHealthy()` to decide whether to route traffic to the instance. The `Status()` method returns the full `sql.DBStats` snapshot so dashboards and alerting systems can track open connections, wait counts, and connections closed by lifetime limits.

```go
package database

import (
    "context"
    "database/sql"
    "sync/atomic"
    "time"
)

// HealthChecker monitors database connection health
type HealthChecker struct {
    db       *sql.DB
    healthy  atomic.Bool
    lastCheck time.Time
    interval time.Duration
}

func NewHealthChecker(db *sql.DB, interval time.Duration) *HealthChecker {
    hc := &HealthChecker{
        db:       db,
        interval: interval,
    }
    hc.healthy.Store(true)
    return hc
}

func (hc *HealthChecker) Start(ctx context.Context) {
    ticker := time.NewTicker(hc.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            hc.check(ctx)
        }
    }
}

func (hc *HealthChecker) check(ctx context.Context) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    err := hc.db.PingContext(ctx)
    hc.healthy.Store(err == nil)
    hc.lastCheck = time.Now()
}

func (hc *HealthChecker) IsHealthy() bool {
    return hc.healthy.Load()
}

// HealthStatus returns detailed health information
type HealthStatus struct {
    Healthy       bool
    LastCheck     time.Time
    OpenConns     int
    InUse         int
    Idle          int
    WaitCount     int64
    WaitDuration  time.Duration
    MaxIdleClosed int64
    MaxLifetimeClosed int64
}

func (hc *HealthChecker) Status() HealthStatus {
    stats := hc.db.Stats()
    return HealthStatus{
        Healthy:           hc.healthy.Load(),
        LastCheck:         hc.lastCheck,
        OpenConns:         stats.OpenConnections,
        InUse:             stats.InUse,
        Idle:              stats.Idle,
        WaitCount:         stats.WaitCount,
        WaitDuration:      stats.WaitDuration,
        MaxIdleClosed:     stats.MaxIdleClosed,
        MaxLifetimeClosed: stats.MaxLifetimeClosed,
    }
}
```

### Junior → FAANG: making acquire-with-timeout and health checks non-optional

Three patterns in this file are the minimum you carry into every production Go service. First, every call that takes a connection MUST have a context with a deadline. If your handler has a 2 second budget and your database call has no timeout, a saturated pool becomes an unbounded waiter that outlives the request. Second, `defer conn.Release()` and `defer tx.Rollback(ctx)` must be adjacent to the acquire/begin call, never later. If a panic fires between the `Acquire` and the `defer`, the connection leaks forever and over hours the pool drains to zero. Third, liveness probes and readiness probes are different. Liveness answers "is this process alive enough to not be restarted", readiness answers "should this pod receive traffic right now". A database outage should usually fail readiness (remove from LB rotation) but not liveness (do not restart, because restart will not fix an upstream database problem).

Worked example of the timeout layering you want. HTTP request context deadline: 2 seconds. Pool acquire timeout (via context): 500ms. Query statement_timeout on the connection: 1.5 seconds. Order matters: acquire short, execute up to the remaining budget. If acquire fails fast, you return a 503 and do not tie up a pool slot with a doomed query. If execute is slow, `statement_timeout` at Postgres kills the backend query so the connection returns to the pool clean, and your Go code sees `context.DeadlineExceeded` or `57014 (query_canceled)`.

Interview entry-point. "What is the difference between canceling a context in Go and what Postgres sees?" Answer: when the Go context is canceled, pgx sends a protocol-level CancelRequest on a side connection. Postgres receives it, cancels the query, and returns error code 57014. If the cancel arrives after the query completed but before the result is read, you get the result normally. Context cancel is not instant, it is best-effort. This is why `statement_timeout` at the database is a necessary belt-and-suspenders addition, not a substitute.

### Senior @ FAANG: pool patterns at scale, noisy-neighbor isolation, and failure-mode matrix

At staff level, the patterns in this section expand into an architecture for pool governance. The key insight is that a single pool per service is the simplest thing that can work, but it is rarely the right thing at scale. Reasons to split pools: (1) OLTP versus analytics separation, where a slow analytical query should never starve user-facing queries, solved by two pools with different `statement_timeout` and different sizes against the same database, and (2) read versus write separation, where reads go to a replica pool with looser consistency and writes to a primary pool with stricter timeouts. (3) per-tenant quotas in multi-tenant systems, where each large tenant gets a slice of the connection budget so one tenant cannot monopolize the pool. (4) critical-path versus background-job separation, where batch work uses a smaller pool with a longer statement_timeout and lower scheduling priority. The anti-pattern is having eight pools that all point at the same primary and collectively allocate more connections than `max_connections` allows.

The `BeforeAcquire` hook deserves a warning: it runs on every acquire, so anything that blocks or does network I/O destroys throughput. A common mistake is adding `conn.Ping(ctx)` in `BeforeAcquire` to catch dead connections. This doubles every query's RTT. Use `HealthCheckPeriod` for idle-connection validation, which runs off the hot path, and trust the driver to detect dead connections on actual use (pgx will retry with a new connection if the first write fails, when configured with the correct error class handling).

`WithTransaction` has a subtle correctness trap worth naming. The `defer tx.Rollback(ctx)` after a successful `Commit` returns an error, but that error must be ignored because the transaction is already committed and rollback is a no-op. The pgx v5 pattern is that `Rollback` after `Commit` returns `pgx.ErrTxClosed`, which `WithTransaction` should swallow. If the caller's context is canceled mid-transaction and `Commit` never runs, the rollback sends a protocol Sync to Postgres to abort the backend's transaction. Without the rollback, Postgres leaves the backend in `idle in transaction` state, which `idle_in_transaction_session_timeout` (set at `AfterConnect`) will eventually kill, but the default is often too generous. Always set `idle_in_transaction_session_timeout` to 30 to 60 seconds at the connection level.

Noisy-neighbor mitigation in multi-tenant systems is where pool design gets interesting. Approach A, separate pools per tenant, works for tens of tenants but becomes operationally unwieldy at thousands. Approach B, single pool with a semaphore per tenant, scales better: wrap `pool.Acquire` in a per-tenant weighted semaphore (`golang.org/x/sync/semaphore`) sized to, say, 10 percent of pool capacity. A tenant that tries to acquire its 11th concurrent connection waits. The pool as a whole is never starved by one tenant. Approach C, PgCat per-tenant pool routing, pushes the concern into the pooler tier, which is cleaner for platform teams that already own a PgCat deployment. Approach D, separate Postgres databases per tenant, is the strongest isolation and also the most operationally heavy.

Health-check design at FAANG scale. A readiness probe that calls `db.PingContext` on every check adds load proportional to pod count times check frequency. At 1000 pods with 5-second readiness intervals, that is 200 pings per second against the database purely for readiness signal, which is wasteful. Better: run a single background goroutine in each pod that updates an atomic healthy flag at a reasonable cadence (say, 10 seconds), and the readiness endpoint reads the flag without touching the database. Pair this with a circuit breaker at the repository layer that trips on error-rate thresholds, so a pod does not keep hammering a dying database during an outage.

Failure-mode matrix every senior should have memorized. `context.DeadlineExceeded` during `Acquire` means pool saturation, look at `WaitCount` and `EmptyAcquireCount`. `context.DeadlineExceeded` during `Query` means slow query or network, check `pg_stat_activity` for long-running backends and correlate with query. `FATAL: terminating connection due to administrator command` means failover or DBA intervention, the pool should evict and reconnect. `ERROR: canceling statement due to statement timeout` (57014) means the database killed your query, investigate the query plan. `ERROR: prepared statement does not exist` means PgBouncer transaction-mode compatibility issue, see the prepared-statement fix in 37.2. `ERROR: too many clients already` means you violated the connection chain, reduce pool size or add a pooler tier. `write tcp ... use of closed network connection` after load balancer timeout means `MaxConnIdleTime` is longer than LB idle timeout. Each of these has a one-line diagnosis and a concrete action. Your runbook should have them all.

Pool draining during deploys is underappreciated. The correct pod shutdown sequence for a Go service with a Postgres pool: (1) SIGTERM arrives, (2) remove from LB rotation by failing readiness, wait `preStopHookDelay` (typically 15 to 30 seconds) for in-flight requests, (3) close the HTTP server with a grace period equal to your longest context timeout, (4) cancel outstanding request contexts, which propagates to pgx and aborts queries, (5) call `pool.Close()`, which waits for in-flight queries to unwind, (6) exit. `terminationGracePeriodSeconds` in the pod spec must exceed the sum of these steps. If it does not, Kubernetes SIGKILLs and you leave orphaned backend processes on Postgres until `tcp_keepalive` detects the dead client, which can be minutes with default kernel settings.

---
