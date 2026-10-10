## 32.9 Connection Health

### Health Check

A ping alone only confirms the TCP connection is alive. Running `SELECT 1` after it verifies that the database process is actually ready to execute queries, catching scenarios where the server is up but rejecting new work (e.g., during a failover or when `max_connections` is exhausted). The pool monitoring loop reports `WaitCount` and `WaitDuration`, which are the most actionable metrics. Sustained wait counts indicate the pool ceiling is too low for the current query rate and should trigger a `SetMaxOpenConns` adjustment.

```go
type DBHealth struct {
    db *sql.DB
}

func (h *DBHealth) Check(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    if err := h.db.PingContext(ctx); err != nil {
        return fmt.Errorf("database ping failed: %w", err)
    }

    // Optional: Run a simple query
    var result int
    if err := h.db.QueryRowContext(ctx, "SELECT 1").Scan(&result); err != nil {
        return fmt.Errorf("database query failed: %w", err)
    }

    return nil
}

func (h *DBHealth) Stats() sql.DBStats {
    return h.db.Stats()
}

// Monitor connection pool
func monitorDBPool(db *sql.DB, logger *slog.Logger) {
    ticker := time.NewTicker(30 * time.Second)
    for range ticker.C {
        stats := db.Stats()
        logger.Info("database pool stats",
            "open", stats.OpenConnections,
            "in_use", stats.InUse,
            "idle", stats.Idle,
            "wait_count", stats.WaitCount,
            "wait_duration", stats.WaitDuration,
            "max_idle_closed", stats.MaxIdleClosed,
            "max_lifetime_closed", stats.MaxLifetimeClosed,
        )
    }
}
```

### Junior → FAANG: What a Health Check Actually Proves

Juniors often write a `/healthz` endpoint that returns 200 if the process started, and call it done. The on-call engineer then wonders why Kubernetes kept routing traffic to a pod whose database pool was fully saturated and returning errors for every request. A real health check proves the dependency chain the request path needs, not the fact that the Go binary is running. The minimum viable database health check is a context-bounded `PingContext` plus a `SELECT 1` with a short timeout, because a bare TCP ping passes even when Postgres is stuck in recovery or refusing new connections. The first-job rule is to separate liveness from readiness. Liveness answers "is the process dead and should it be restarted," so it should be cheap and tolerant of dependency blips, typically just a process heartbeat. Readiness answers "should the load balancer send me traffic right now," so it must actually exercise the dependencies you need to serve a request. Worked example: a new grad writes `/healthz` that returns the pool stats and fails readiness when `InUse / MaxOpen > 0.9`, proactively shedding load before clients see timeouts. Interview entry point: "Walk me through what happens when the database goes down for 30 seconds and comes back. What do your liveness and readiness probes do, and when does traffic return to the pod?" A good answer explains that liveness must not fail during the outage (or Kubernetes kills the pod and you lose in-memory state), while readiness should flip to unhealthy within seconds so the load balancer drains the pod.

### Senior @ FAANG: Dead Connections, Keepalives, idle_session_timeout, Load Shedding, and Circuit Breakers

Staff engineers know that the hardest connection-pool bug is the silent half-open socket. A NAT gateway, cloud load balancer, or firewall can reap an idle TCP connection after five minutes of silence without sending a RST. The client pool still thinks the connection is healthy, hands it to a request, and the request hangs for tens of seconds until the OS TCP retransmit timer gives up. The mitigation is layered. At the Postgres side set `tcp_keepalives_idle = 60`, `tcp_keepalives_interval = 10`, `tcp_keepalives_count = 6` so the server probes idle sockets and closes half-open ones within a minute. At the client side set `SetConnMaxIdleTime` shorter than the shortest NAT idle window you cross (commonly 4 minutes on AWS NLB, 5 minutes on GCP) so idle connections are reaped before the middlebox reaps them. `SetConnMaxLifetime` sits above that, commonly 30 minutes to an hour, to bound connection age for failover and DNS rotation. Postgres 14 introduced `idle_session_timeout`, complementing the older `idle_in_transaction_session_timeout` (available since 9.6), so the server can kill abandoned sessions, which is a safety net for long-lived worker pools that leak connections during panics. Principal nuance: `idle_in_transaction_session_timeout` is more urgent than `idle_session_timeout` because an idle-in-transaction session holds snapshots and row locks that block VACUUM and concurrent writers, so set the former to 60 seconds in production even if the latter is left unbounded.

Load shedding at pool exhaustion separates senior from staff. The default `database/sql` behavior when `MaxOpenConns` is reached is to block on `WaitCount` until a connection frees up or the context deadline fires. Under a traffic spike this turns into head-of-line blocking where every incoming request queues for a connection, timeout cascades outward, and upstream clients retry, doubling the load. The staff-level pattern is to set a short pool wait budget (perhaps 50ms) via `context.WithTimeout` that is distinct from the request deadline, and when the pool wait times out you return a fast 503 with `Retry-After` instead of continuing to the database. This preserves capacity for requests that can be served quickly and sheds the marginal load that caused the spike. Metrics you wire up: `db.pool.wait_ms` histogram per route, `db.pool.shed_count` counter per reason, and an SLO burn alert when shed count exceeds 0.1 percent of traffic over a rolling five minutes.

Circuit breakers are the next layer, and the right granularity is per database role (primary-writes, replica-reads, analytics-replica) because failure modes do not correlate. A replica lagging or failing should open only the read-breaker, routing reads either to another replica or to the primary with a degraded-mode flag, while writes continue unaffected. The breaker states are closed, open, half-open, with open flipping back to half-open after a cooldown and half-open permitting a small probe of traffic before closing. For Postgres fleets with read-replica failover orchestrated by a managed service (RDS Multi-AZ, Cloud SQL HA, Patroni), the breaker must react faster than the DNS TTL so traffic stops hitting the dead IP before the DNS flip propagates, which typically means a 1-second health check interval and a 3-failure trip threshold. Observability contract: every breaker state transition emits a log line with correlation ID, and a gauge `db.breaker.state{role}` feeds the SRE dashboard. Chaos testing in staging should include killing a replica mid-query and measuring time-to-recover as an SLO.

The staff-plus deep cut on connection health is distinguishing "connection is broken" from "query was canceled" from "query exceeded server-side statement_timeout." A broken connection returns a driver error of class 08, and `database/sql` marks the connection bad via `driver.ErrBadConn` so the pool discards it and retries once on a fresh connection, invisibly to the caller. A client-canceled query returns `context.Canceled`, and the driver sends a CancelRequest protocol message to Postgres that interrupts the running query. A server-side `statement_timeout` returns SQLSTATE 57014 `query_canceled` with a pg_terminate or statement cancel reason, and the connection is still good. Three different recovery paths, three different metrics, three different dashboards. Writing them up in an ADR with decision criteria and example incidents is the kind of artifact that gets you promoted to staff.

---
