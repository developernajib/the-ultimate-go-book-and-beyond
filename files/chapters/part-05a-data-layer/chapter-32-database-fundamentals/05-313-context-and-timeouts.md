## 32.3 Context and Timeouts

### Using Context

Passing a `context.Context` to database calls allows the Go runtime to cancel an in-flight query the moment the upstream HTTP request is abandoned or its deadline expires. Without context propagation, a slow query continues consuming a database connection and CPU even after the caller has given up. Under load this exhausts the connection pool. `QueryRowContext` ties the query lifetime directly to the caller's context, so cancellation is immediate and automatic.

```go
func getUserByIDWithContext(ctx context.Context, db *sql.DB, id int64) (*User, error) {
    query := `SELECT id, name, email, created_at FROM users WHERE id = $1`

    var user User
    err := db.QueryRowContext(ctx, query, id).Scan(
        &user.ID, &user.Name, &user.Email, &user.CreatedAt,
    )

    if err == sql.ErrNoRows {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }

    return &user, nil
}

// With timeout
func getUserWithTimeout(db *sql.DB, id int64) (*User, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    return getUserByIDWithContext(ctx, db, id)
}
```

### All Context-Aware Methods

Every `database/sql` method that touches the network has a `*Context` variant. Using the non-context versions (`Query`, `Exec`, `Prepare`) bypasses cancellation entirely. Those calls block indefinitely regardless of what the caller's context says. In production code every database call should go through its context-aware counterpart so that request deadlines, graceful shutdown signals, and client disconnects propagate correctly down to the connection level.

> **Senior track**: Cancellation semantics depend on the driver. `pgx` sends a Postgres `CancelRequest` message on a new connection when `ctx` is canceled, which interrupts the running query server-side within milliseconds. Older drivers (notably legacy `lib/pq`) close the TCP connection instead - fast for the client but wastes the connection and can leave the query running on the DB until it finishes. This is one more reason to prefer `pgx` in 2026. Also: the context deadline applies to each individual round-trip, not the cumulative transaction time, so a long-running `tx` with many statements needs a deadline large enough to cover the whole sequence.

```go
// Prefer Context methods for production code
db.QueryContext(ctx, query, args...)
db.QueryRowContext(ctx, query, args...)
db.ExecContext(ctx, query, args...)
db.PrepareContext(ctx, query)
db.BeginTx(ctx, opts)
```

### Junior to FAANG: why context is not optional

If you remember one rule from this chapter, remember this one. Every database call in every production Go service must take a `context.Context`. No exceptions. The reason is a scenario you will encounter in your first year: a user's HTTP request times out or the user closes the browser, but the database query keeps running because nothing told it to stop. Multiply by traffic and you have an outage driven entirely by unaware code.

The context propagates from the HTTP server. `net/http` gives your handler `r.Context()`, which is already wired to cancel when the client disconnects or when the server's `ReadTimeout`/`WriteTimeout` fires. Take that context, pass it down through your service layer, and hand it to every `QueryContext`, `ExecContext`, `BeginTx` call. When the request dies, the chain unwinds and the query is canceled.

The second rule: do not create context timeouts everywhere blindly. If the handler has a 10-second deadline and your repository sets its own 5-second `context.WithTimeout`, you have reduced the caller's budget without explanation. Set timeouts only at layer boundaries where the policy belongs, typically in the handler or in a middleware that applies service-level SLAs.

Worked example: take your `UserRepository` from the previous section and change every method signature to accept `ctx context.Context` as the first parameter. Propagate `ctx` into every database call. Write a test that cancels the context and verifies the query returns `context.Canceled` promptly. That test is your proof that cancellation works end-to-end.

First-job interview entry-point on context: "what happens if I do not pass a context and the user hangs up?" Answer: the goroutine keeps running, the connection stays checked out, the pool drains, and the service degrades. That is a competent first-year answer.

### Senior at FAANG: context timeouts, statement_timeout, and the idle-in-transaction killer

Context cancellation is a client-side policy. The database has its own server-side policies that you must align with at an ADR level. Three server-side settings matter.

**statement_timeout (Postgres GUC).** Sets a server-enforced ceiling on how long any single statement can run. Default is 0 (unlimited). Staff-level standard: set `statement_timeout = '30s'` cluster-wide with per-session overrides for legitimate long queries (`SET LOCAL statement_timeout = '5min'` inside an analytical transaction). Why server-side when you have context? Because a TCP pause, a misbehaving middlebox, or a driver bug can swallow the client's cancellation. The server-side timeout is the backstop. Postgres returns SQL state `57014 query_canceled`. Map that to a domain error and retry if appropriate.

**idle_in_transaction_session_timeout (Postgres GUC).** Forces Postgres to terminate any transaction that sits idle (between statements) longer than the threshold. An idle-in-transaction connection holds locks and prevents `VACUUM` from reclaiming tuples, which bloats tables and degrades plans. Set `idle_in_transaction_session_timeout = '60s'` as a cluster default. A single buggy `BEGIN` without `COMMIT` used to silently damage the cluster. With this GUC the damage is bounded to 60 seconds. The application sees `25P03 idle_in_transaction_session_timeout` and must handle it as a retryable transaction-aborted error.

**idle_session_timeout (Postgres 14 plus).** Terminates sessions idle outside a transaction. Useful when the pool has outlived its usefulness and connections are slowly leaking. Set to a value larger than `ConnMaxIdleTime` so the client reaps first and the server is a backstop.

**The incident pattern this prevents.** 2 a.m. page: Postgres CPU pinned at 100%, WAL not advancing, autovacuum making no progress. Root cause: a deploy shipped a code path with `tx, _ := db.Begin(); defer tx.Commit()`, the commit happens but some paths return early with errors that leave the tx idle. Even with clean `defer` patterns, a runaway goroutine can hold a transaction open indefinitely. The GUCs above contain the blast radius. Without them, the primary degrades until human intervention.

**Context deadline versus statement_timeout interaction.** When both are set, whichever fires first wins. Because context propagation over the network has its own latency, the effective client-side deadline is always slightly longer than the declared one. A defensible pattern: set context timeout at the handler to the full request budget (say 30 seconds), set per-statement budgets implicitly via `statement_timeout = '5s'` at the database so runaway queries fail fast even if the caller's deadline is generous. For batch jobs that legitimately need long queries, run them with a dedicated pool and a role that sets a higher `statement_timeout`.

**Cancellation semantics by driver.** pgx sends a Postgres CancelRequest on a side connection, which tells the backend to interrupt the running query. Within a millisecond the query returns `57014`. lib/pq (legacy) closes the TCP connection, which is faster to return to the caller but leaves Postgres running the query until it finishes, wasting CPU and disk. MySQL driver sends `KILL QUERY` on a side connection. For staff-level correctness, pick pgx and rely on CancelRequest semantics.

**Context as the right place for per-request tenant and user identity.** Beyond timeouts, `context.Context` is the canonical carrier for request-scoped values that must reach the database layer: tenant ID for RLS, user ID for audit, trace ID for correlation. Wrap the DB handle in a thin layer that reads these from context and issues `SET LOCAL app.tenant_id = $1, app.user_id = $2` at the start of every transaction. That pattern closes the multi-tenant isolation loop without leaking plumbing into every repository call site.

**Graceful shutdown and draining.** On SIGTERM the server stops accepting new requests, existing requests continue until their deadline, and the pool is drained after the server shuts down. The sequence is: close the HTTP server with `srv.Shutdown(ctx)` (context with the shutdown grace period), then `db.Close()`. `db.Close()` waits for in-flight queries to complete or their contexts to expire. If you close the DB first, in-flight queries fail mid-execution. Order matters.

**Context cancellation and autocommit transactions.** A subtle trap: if a query is canceled mid-execution on Postgres, the implicit autocommit transaction rolls back. If the query was an `INSERT` and the client retries, you get no duplicate. If the query was an `UPDATE` with side effects outside the database (publishing to Kafka via an AFTER trigger via `pg_notify`, say) the side effect either happened or did not, depending on where the cancellation fired. The outbox pattern (write the event to an `outbox` table in the same transaction, CDC streams it out) makes this deterministic. This is the kind of correctness question that separates staff candidates from senior candidates in system design interviews.

---
