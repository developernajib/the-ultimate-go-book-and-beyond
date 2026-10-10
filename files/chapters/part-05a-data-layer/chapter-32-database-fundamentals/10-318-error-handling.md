## 32.8 Error Handling

### Common Errors

Database drivers return driver-specific error types that carry error codes, constraint names, and column details. Wrapping these into domain errors (like `ErrDuplicateKey` or `ErrForeignKey`) keeps driver details out of the service layer and lets callers handle specific failure modes without importing the `pq` or `pgx` package. The `handleDBError` function below uses `errors.As` to unwrap the driver error and maps PostgreSQL error codes to application-level sentinels.

```go
import (
    "database/sql"
    "errors"
    "fmt"
    "strings"
    "time"

    "github.com/lib/pq"
)

type User struct {
    ID    int64
    Email string
    Name  string
}

var (
    ErrNotFound      = errors.New("record not found")
    ErrDuplicateKey  = errors.New("duplicate key")
    ErrForeignKey    = errors.New("foreign key violation")
)

func handleDBError(err error) error {
    if err == nil {
        return nil
    }

    if err == sql.ErrNoRows {
        return ErrNotFound
    }

    // PostgreSQL specific errors
    var pqErr *pq.Error
    if errors.As(err, &pqErr) {
        switch pqErr.Code {
        case "23505": // unique_violation
            return ErrDuplicateKey
        case "23503": // foreign_key_violation
            return ErrForeignKey
        case "23502": // not_null_violation
            return fmt.Errorf("null constraint violation: %s", pqErr.Column)
        }
    }

    return err
}

// Usage
func createUser(db *sql.DB, user *User) error {
    query := `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`

    err := db.QueryRow(query, user.Email, user.Name).Scan(&user.ID)
    if err := handleDBError(err); err != nil {
        return fmt.Errorf("create user: %w", err)
    }

    return nil
}
```

### Retry Logic

Retrying failed requests with exponential backoff and jitter prevents retry storms during partial outages. Each attempt doubles the wait time with random jitter, and a maximum retry count or deadline prevents infinite retries from masking deeper failures.

```go
func withRetry(maxAttempts int, delay time.Duration, fn func() error) error {
    var err error
    for attempt := 1; attempt <= maxAttempts; attempt++ {
        err = fn()
        if err == nil {
            return nil
        }

        // Don't retry certain errors
        if !isRetryableError(err) {
            return err
        }

        if attempt < maxAttempts {
            time.Sleep(delay * time.Duration(attempt))
        }
    }
    return err
}

func isRetryableError(err error) bool {
    // Connection errors are retryable
    var pqErr *pq.Error
    if errors.As(err, &pqErr) {
        switch pqErr.Code.Class() {
        case "08": // Connection exception
            return true
        case "53": // Insufficient resources
            return true
        case "57": // Operator intervention
            return true
        }
    }

    // Deadlock is retryable
    if strings.Contains(err.Error(), "deadlock") {
        return true
    }

    return false
}
```

### Junior → FAANG: errors.Is, errors.As, and Driver Errors

Juniors often write `if err.Error() == "pq: duplicate key value violates unique constraint"` which is fragile, breaks across driver versions, and stops working if you switch from `pq` to `pgx`. The first-job upgrade is to use the Go 1.13 plus error chain with `errors.Is` for sentinel comparisons and `errors.As` for type assertions on wrapped errors. `errors.Is(err, sql.ErrNoRows)` survives any number of `fmt.Errorf("…: %w", err)` wrappings, while `errors.As(err, &pgErr)` walks the chain until it finds a `*pgconn.PgError`. Worked example for the interview panel: a junior writes a handler that returns 500 for every database error, a mid-level engineer maps `sql.ErrNoRows` to 404 and unique violation to 409, a FAANG-bound new grad also maps `pg_sleep`-like cancel errors to 504 and connection errors to 503 with a `Retry-After` header. The interview entry point is "Given a `create user` endpoint, enumerate every database error class and the correct HTTP response for each." A common gotcha juniors hit is forgetting that `sql.ErrNoRows` only fires from `QueryRow().Scan()`, not from `Query().Next()`, which simply returns false with no error at end of iteration. Another gotcha is confusing context cancellation errors (`context.Canceled`, `context.DeadlineExceeded`) with server-side errors, since a canceled client does not mean a failed server operation, and the row may still be inserted if the server completed before the cancel arrived.

### Senior @ FAANG: PgError Class Codes, Retry Classification, and Jittered Backoff

Staff engineers classify Postgres errors by SQLSTATE class code and route each class through a different policy. The SQLSTATE is a five-character code where the first two characters are the class and the last three the subclass. The classes you must internalize are class 08 connection exception (retryable after reconnect), class 23 integrity constraint violation (not retryable, surface to caller), class 40 transaction rollback (40001 serialization_failure is retryable, 40P01 deadlock_detected is retryable after short backoff), class 53 insufficient resources (53300 too_many_connections indicates pool or server pressure, shed load), class 57 operator intervention (57014 query_canceled due to statement_timeout, surface as 504 if client-driven or 500 if admin-driven), class 42 syntax error or access rule violation (programmer error, never retry, alert immediately). Each class deserves a distinct metric label and a distinct alert, because a spike in 40001 means contention you fix with query or schema changes, while a spike in 53300 means pool sizing or connection leaks.

Retry policy is where staff-level judgment shows. Naive `time.Sleep(delay * attempt)` as shown in the example above has two bugs that matter at scale. First, there is no jitter, so synchronized clients all retry at the same instant and create a thundering herd that knocks the database over again. The correct formula is full jitter `sleep = rand.Float64() * min(cap, base * 2^attempt)` per the AWS architecture blog, which decorrelates retries and provably minimizes total completion time under contention. Second, there is no budget for the overall operation. A three-attempt retry with 5-second waits is 15 seconds of tail latency on a request that may already be past its SLO. The correct shape is `context.WithTimeout` on the outer operation, and each retry checks `ctx.Err()` before sleeping, so budget exhaustion surfaces as a single deadline-exceeded error instead of a wall of retry noise. A serialization failure (40001) specifically deserves a re-run of the entire transaction, not just the failed statement, because the snapshot is gone and the application logic must read fresh data. Deadlocks (40P01) are the same story. A unique-violation on an INSERT (23505) should be reclassified only if you know it is an idempotent re-attempt of the same logical operation, otherwise it is a legitimate duplicate and surfacing it as 409 is correct.

Principal-level nuance includes distinguishing idempotent from non-idempotent operations for retry eligibility. A `SELECT` is always safe. An `INSERT` with a client-generated UUID and a unique index on that UUID is safe because the retry becomes a no-op duplicate that you catch and treat as success. An `INSERT` that relies on a serial primary key is not safe to retry after an unknown-outcome error because you may create a second row. `UPDATE` with an optimistic-lock `version` column is safe. `DELETE` is trivially idempotent. The staff-level pattern is to design every write as idempotent by construction using client-supplied idempotency keys or version columns, so retries become a policy decision rather than a correctness risk. Observability contract: each retry emits a span with attributes `db.sqlstate`, `retry.attempt`, `retry.reason`, and a terminal span marks `retry.exhausted = true` when budget runs out. Dashboards split retry rate by sqlstate class so on-call can tell serialization contention from connection churn from statement-timeout storms at a glance. Datadog Database Monitoring and pg_stat_statements sampled every 60 seconds close the loop by correlating retry spikes to the specific query fingerprints that triggered them.

---
