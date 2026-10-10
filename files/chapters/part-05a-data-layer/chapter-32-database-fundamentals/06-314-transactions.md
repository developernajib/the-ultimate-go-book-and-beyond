## 32.4 Transactions

### Basic Transaction

A transaction groups multiple statements so they either all succeed or all roll back atomically. `defer tx.Rollback()` is a safety net. Once `tx.Commit()` has succeeded the deferred `Rollback` returns `sql.ErrTxDone`, which is harmless, because the connection is already back in the pool. If any statement returns an error and the function returns early, the deferred rollback closes the transaction cleanly.

> **Senior track**: In real code, call `db.BeginTx(ctx, &sql.TxOptions{...})` instead of `db.Begin()`. Plain `Begin` uses `context.Background()` internally, which means a canceled HTTP request will not abort the transaction: the goroutine holds the connection and row locks until the DB itself times out. The example below uses the bare `Begin` only to keep the introduction minimal. Everything that follows is context-aware.

```go
// Amounts are int64 minor units (cents), never float64: binary floating
// point cannot represent most decimal fractions exactly, so float money
// drifts by a cent at ledger scale. The accounts.balance column is BIGINT.
func transferMoney(db *sql.DB, fromID, toID int64, amountCents int64) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback() // Rollback if not committed

    // Debit from account
    _, err = tx.Exec(
        `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
        amountCents, fromID,
    )
    if err != nil {
        return err
    }

    // Credit to account
    _, err = tx.Exec(
        `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
        amountCents, toID,
    )
    if err != nil {
        return err
    }

    return tx.Commit()
}
```

### Transaction with Context

`BeginTx` accepts `sql.TxOptions` to set the isolation level and read-only mode. The example below uses `LevelSerializable` and a `SELECT ... FOR UPDATE` to lock the source row during a balance check, preventing two concurrent transfers from overdrawing the same account. All queries within the transaction use the `*Context` variants so the parent context's deadline applies to every statement, not just `BEGIN`.

```go
func transferMoneyWithContext(ctx context.Context, db *sql.DB, fromID, toID int64, amountCents int64) error {
    tx, err := db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelSerializable,
        ReadOnly:  false,
    })
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Check balance first (minor units, matching the BIGINT column)
    var balanceCents int64
    err = tx.QueryRowContext(ctx,
        `SELECT balance FROM accounts WHERE id = $1 FOR UPDATE`,
        fromID,
    ).Scan(&balanceCents)
    if err != nil {
        return err
    }

    if balanceCents < amountCents {
        return errors.New("insufficient balance")
    }

    // Perform transfer
    _, err = tx.ExecContext(ctx,
        `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
        amountCents, fromID,
    )
    if err != nil {
        return err
    }

    _, err = tx.ExecContext(ctx,
        `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
        amountCents, toID,
    )
    if err != nil {
        return err
    }

    return tx.Commit()
}
```

### Transaction Helper

A generic `withTransaction` helper eliminates repetitive begin/commit/rollback boilerplate across the codebase. The caller passes a function that receives a `*sql.Tx` and returns an error. If the function panics, the helper catches it, rolls back, and re-panics so the stack trace is preserved. This pattern keeps transaction lifecycle logic in one place and keeps business logic focused on the actual work inside the transaction.

> **Senior track**: Swallowing the `Rollback` error is usually fine (it is almost always `sql.ErrTxDone` after a successful commit, or the original error path will dominate), but log it at debug level - a real rollback failure can indicate a broken connection or a DB that dropped the transaction mid-flight, and you want that signal during incidents. Also do not nest this helper: Go's `database/sql` does not support nested transactions, only savepoints (`SAVEPOINT ...`, `ROLLBACK TO ...`), which must be issued manually.

```go
func withTransaction(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }

    defer func() {
        if p := recover(); p != nil {
            tx.Rollback()
            panic(p)
        }
    }()

    if err := fn(tx); err != nil {
        tx.Rollback()
        return err
    }

    return tx.Commit()
}

type Order struct {
    UserID     int64
    TotalCents int64
}

type OrderItem struct {
    ProductID int64
    Quantity  int
}

// Usage
func createOrder(ctx context.Context, db *sql.DB, order Order, items []OrderItem) error {
    return withTransaction(ctx, db, func(tx *sql.Tx) error {
        // Insert order
        var orderID int64
        err := tx.QueryRowContext(ctx,
            `INSERT INTO orders (user_id, total_cents) VALUES ($1, $2) RETURNING id`,
            order.UserID, order.TotalCents,
        ).Scan(&orderID)
        if err != nil {
            return err
        }

        // Insert items
        for _, item := range items {
            _, err := tx.ExecContext(ctx,
                `INSERT INTO order_items (order_id, product_id, quantity) VALUES ($1, $2, $3)`,
                orderID, item.ProductID, item.Quantity,
            )
            if err != nil {
                return err
            }
        }

        return nil
    })
}
```

### Junior to FAANG: transactions as an atomic unit of change

A transaction is the database's promise that a group of statements either all take effect or none do. Inside a transaction you see your own changes immediately. Other connections do not see them until `COMMIT`. If anything goes wrong you call `ROLLBACK` and the database pretends the work never happened.

The junior trap every engineer falls into once: forgetting to commit. You call `tx.Exec`, it succeeds, you return `nil`, and your function exits without calling `tx.Commit()`. The `defer tx.Rollback()` safety net fires, the change is thrown away, and your tests mysteriously pass on the next run because there is no persistent effect. Always end your transaction function with `return tx.Commit()`, or use the `withTransaction` helper above so the lifecycle is centralized.

The second trap: mixing `*sql.DB` calls and `*sql.Tx` calls in the same logical unit of work. If you call `db.Query` and then `tx.Exec`, the first query runs outside the transaction on a different connection. It will not see your uncommitted changes. Any helper called from inside a transaction must take a `*sql.Tx` (or an interface that both `*sql.DB` and `*sql.Tx` satisfy, commonly called `DBTX` in sqlc-generated code).

The third trap: long-running transactions. If you `BEGIN`, call an external HTTP API that takes 30 seconds, then `COMMIT`, you held a connection and whatever locks you acquired for 30 seconds. During those 30 seconds other writers block. Keep transactions short. Do external I/O before `BEGIN` or after `COMMIT`, never inside.

Worked example: write an `OrderService.Create(ctx, order, items)` method that uses `withTransaction` above. Insert the order header, insert the items, all inside the transaction. Test with a context that is canceled mid-way and verify that neither the order nor the items appear in the database afterward.

First-job interview entry-point on transactions: "what do ACID properties mean" and "what is the difference between READ COMMITTED and REPEATABLE READ." Know that READ COMMITTED (the default in Postgres and Oracle) lets you see committed changes from other transactions between statements, while REPEATABLE READ pins your view to the transaction start. That answer plus a worked transfer example puts you ahead of the pack.

### Senior at FAANG: isolation ADRs, retry loops, and distributed transaction realism

Transactions at scale are where database correctness becomes a design decision, not a mechanic. The senior's job is to own the ADRs.

**Isolation level ADR.** Postgres supports READ UNCOMMITTED (treated as READ COMMITTED), READ COMMITTED (default), REPEATABLE READ (implemented as snapshot isolation), and SERIALIZABLE (implemented as SSI, Serializable Snapshot Isolation). MySQL InnoDB supports the same four but with different semantics (REPEATABLE READ is the default and uses gap locks to prevent phantoms, SERIALIZABLE promotes reads to locking reads). The ADR for a new service answers: what isolation level do we use by default, and for which code paths do we escalate.

The working defaults at FAANG-tier Go shops are these. READ COMMITTED is the default for most OLTP writes. It is correct when a single statement makes the decision and the write (UPDATE ... WHERE ... AND version = ...). It is incorrect for read-then-write patterns where a concurrent writer can invalidate your read between SELECT and UPDATE. REPEATABLE READ (snapshot in Postgres) is the right choice for multi-statement reads that must see a consistent view: invoice totals from line items, report aggregations, cart snapshots. SERIALIZABLE (SSI) is the right choice when business correctness demands a serial schedule: inventory decrement with "no overselling," wallet debit with "no double spend," seat selection with "no double booking." SSI costs throughput because it aborts transactions that would violate serializability with `40001 serialization_failure`, and you must retry.

**Serialization failure retry loop.** Any SERIALIZABLE or REPEATABLE READ transaction at Postgres or SERIALIZABLE transaction at MySQL must be wrapped in a retry loop. The shape is bounded attempts (3 to 5), exponential backoff with jitter (start 10 ms, double each attempt, jitter plus or minus 50%), and retry only on `40001` and `40P01 deadlock_detected`. Deadlock is always retryable because the loser is chosen by the database to unblock the winner. Document the retry policy in the transaction helper, not at each call site.

```go
func withSerializable(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
    const maxAttempts = 5
    for attempt := 1; attempt <= maxAttempts; attempt++ {
        err := withTransactionAtLevel(ctx, db, sql.LevelSerializable, fn)
        if err == nil {
            return nil
        }
        if !isRetryable(err) || attempt == maxAttempts {
            return err
        }
        backoff := time.Duration(10<<attempt) * time.Millisecond
        jitter := time.Duration(rand.Int63n(int64(backoff) / 2))
        select {
        case <-time.After(backoff + jitter):
        case <-ctx.Done():
            return ctx.Err()
        }
    }
    return nil
}
```

**Savepoints and the nested-transaction anti-pattern.** Go's `database/sql` does not expose nested transactions because the underlying databases do not have them. What exists is savepoints: `SAVEPOINT sp1; ... ROLLBACK TO sp1`. Frameworks that fake "nested transactions" (including some Ruby and Python ORMs) issue savepoint commands under the hood. At staff level the recommended position is no savepoints in application code. If you need to attempt an operation and fall back on failure, structure the control flow around the transaction rather than inside it. Savepoints inside a service method make code hard to reason about and are a known source of correctness bugs where the developer expected nested atomicity and got partial rollback.

**Long-running transaction damage.** A transaction that lives for minutes holds back Postgres `VACUUM` for the duration. Specifically, the transaction's snapshot horizon prevents cleanup of any tuple newer than the transaction's start. In a hot table (sessions, events, audit) this causes multi-gigabyte bloat in under an hour. The autovacuum worker will wake up, see the old `xmin`, and skip cleanup. Plans degrade because dead tuples are still in the heap. The mitigation is `idle_in_transaction_session_timeout` (discussed in the context chapter) plus a policy: no business logic inside a transaction may issue network I/O, read from a queue, or block on user interaction. The transaction opens, executes within 100 ms, commits.

**Distributed transactions: why 2PC is dead.** Classical two-phase commit (XA, prepared transactions in Postgres via `PREPARE TRANSACTION`) requires a coordinator that is durable and available. If the coordinator fails after phase one but before phase two, resource managers are left holding locks indefinitely. No mainstream cloud Postgres offering enables `max_prepared_transactions` by default. No serious FAANG-tier service uses XA for cross-service consistency. The working alternatives are Sagas and the outbox pattern.

**Saga pattern.** Break a distributed operation into a sequence of local transactions, each with a compensating action. Order placement: reserve inventory (compensate: release), charge payment (compensate: refund), create shipment (compensate: cancel). On failure at step N, execute compensations for steps 1 through N minus 1 in reverse. Sagas tolerate partial failure and coordinator crashes because each step is durable. They require idempotency on every action because retries are expected. Document the saga as a state machine in the service's design doc.

**Outbox pattern.** Write the business change and an event row to the same local table in a single transaction. A separate worker (or CDC via Debezium) reads the outbox and publishes events to Kafka or another bus. This eliminates the dual-write problem: you can never have a business change without a corresponding event, and you can never have an event without the business change. The cost is one extra table and one worker. The benefit is exactly-once semantics from the database's perspective and at-least-once from the consumer's perspective, which composes with idempotent consumers into effectively-exactly-once delivery. This is the default cross-service transactional pattern across the industry, and the one engineering blogs at payment and commerce companies keep converging on.

**MVCC, WAL, and bloat.** Postgres stores every updated row as a new tuple with the old one marked dead. The write-ahead log records every change durably before the tuple is visible. `VACUUM` reclaims dead tuples. Heavy update workloads (status flags, counters) produce high bloat. The mitigations: HOT updates (if the update does not touch indexed columns and there is page space, Postgres can avoid index churn), partitioning (drop the partition instead of vacuuming), `pg_repack` for online table rebuild, and for extreme cases `UNLOGGED` tables for caches and queues where durability is not required. Know the trade-offs.

**Transaction ID wraparound.** Postgres uses a 32-bit XID. Every transaction consumes one. Without `VACUUM FREEZE` running regularly, the database approaches wraparound (2 billion transactions back) and must shut down to protect data. Monitor `age(datfrozenxid)` and `age(relfrozenxid)` in `pg_class`. Alert at 1 billion, page at 1.5 billion, panic at 1.8 billion. This has taken down production systems with public postmortems at Sentry (2015) and Mailchimp's Mandrill (2019), among others. It is preventable with autovacuum correctly configured and monitored.

**Deadlock debugging.** `pg_stat_activity` shows currently waiting queries. `pg_locks` shows who holds what. The classic deadlock pattern is two transactions updating the same two rows in opposite order. The fix is a consistent lock order (always update the smaller ID first) or a single atomic statement that the planner orders internally. Document the lock-order convention in the repository layer.

---
