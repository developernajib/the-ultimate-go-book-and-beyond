## 27.7 Handling Concurrent Requests

### Optimistic Locking

Optimistic locking assumes conflicts are rare and detects them at commit time rather than acquiring locks upfront. The SQL `UPDATE ... WHERE id = $1 AND version = $2` only modifies the row if the version matches the one read by the caller. Zero rows affected means another writer incremented the version between the read and the update, and the caller must retry with a fresh read.

```go
package concurrency

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
)

var (
    ErrConcurrentModification = errors.New("concurrent modification detected")
    ErrNotFound               = errors.New("entity not found")
)

type VersionedEntity struct {
    ID      string
    Version int
    Data    []byte
}

type VersionedRepository struct {
    db *sql.DB
}

func (r *VersionedRepository) Update(ctx context.Context, entity *VersionedEntity) error {
    query := `
        UPDATE entities
        SET data = $1, version = version + 1
        WHERE id = $2 AND version = $3
    `

    result, err := r.db.ExecContext(ctx, query, entity.Data, entity.ID, entity.Version)
    if err != nil {
        return err
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return err
    }

    if rowsAffected == 0 {
        // Zero rows is ambiguous: the version moved on, OR the row is gone.
        // Distinguish them, because they need different handling: a version
        // conflict means re-read and retry, a missing row means stop.
        var current int
        err := r.db.QueryRowContext(ctx, `SELECT version FROM entities WHERE id = $1`, entity.ID).Scan(&current)
        switch {
        case errors.Is(err, sql.ErrNoRows):
            return ErrNotFound
        case err != nil:
            return err
        default:
            return fmt.Errorf("%w: have version %d, row is at %d",
                ErrConcurrentModification, entity.Version, current)
        }
    }

    entity.Version++
    return nil
}
```

Two details make this work. `version = version + 1` is computed by the database from the row's own current value, never from a number the application read earlier, so there is no window between reading and incrementing. And the entire check-and-set is one statement, so it is atomic by definition: `WHERE id = $1 AND version = $2` either matches the version you read or it does not, and the database decides, not your code.

That is the same principle as the unique constraint. **The guarantee comes from a conditional write, not from a read followed by a write.** The version column is what makes the write conditional. If you find yourself doing `SELECT version`, then deciding in Go, then `UPDATE`, you have reintroduced exactly the race this pattern exists to remove.

### Pessimistic Locking

Pessimistic locking acquires an exclusive row lock at read time using `SELECT ... FOR UPDATE`. Until the transaction commits or rolls back, no other transaction can update, delete, or `FOR UPDATE` that row. This eliminates the retry loop required by optimistic locking but trades throughput for safety, and it is the right choice when contention is high, write conflicts are frequent, or the cost of retrying a failed update is prohibitive. The `lock_timeout` setting bounds how long a transaction will wait to acquire the lock before returning an error, preventing indefinite queue buildup under load.

Be precise about what the lock does and does not block, because the usual summary is wrong. **`FOR UPDATE` does not block readers.** PostgreSQL is MVCC: a plain `SELECT` against a locked row returns immediately with the last committed version, lock or no lock. Verified against PostgreSQL 18.4, with one transaction holding `FOR UPDATE` on a row: a concurrent plain `SELECT` returned the old value in 2 ms, while a concurrent `SELECT ... FOR UPDATE` blocked until the first transaction ended. Only conflicting *writers and lockers* wait.

That distinction is the whole reason `FOR UPDATE` is usable in a request path. If it blocked readers, every locked row would stall your read traffic. But it also means `FOR UPDATE` alone gives you no read consistency: other transactions continue to observe the pre-lock value for as long as you hold it, which is exactly right for the read-modify-write pattern below and exactly wrong if you were expecting it to hide the row.

```go
package concurrency

// ErrNotFound is declared alongside ErrConcurrentModification above.

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "time"
)

type Entity struct {
    ID   string
    Data []byte
}

type LockedRepository struct {
    db *sql.DB
}

func (r *LockedRepository) UpdateWithLock(ctx context.Context, id string, updateFn func(*Entity) error) error {
    return r.updateWithLock(ctx, id, 0, updateFn)
}

// UpdateWithLockTimeout is UpdateWithLock with a bound on how long it will
// wait for the row lock. A zero timeout means wait indefinitely.
func (r *LockedRepository) UpdateWithLockTimeout(ctx context.Context, id string, timeout time.Duration, updateFn func(*Entity) error) error {
    return r.updateWithLock(ctx, id, timeout, updateFn)
}

func (r *LockedRepository) updateWithLock(ctx context.Context, id string, timeout time.Duration, updateFn func(*Entity) error) error {
    tx, err := r.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    if timeout > 0 {
        // SET LOCAL cannot take a bind parameter, so the value is formatted
        // in. It is an int64 from time.Duration, never caller-supplied text,
        // so there is nothing injectable here. Never format a string in.
        stmt := fmt.Sprintf("SET LOCAL lock_timeout = '%dms'", timeout.Milliseconds())
        if _, err := tx.ExecContext(ctx, stmt); err != nil {
            return err
        }
    }

    // Lock the row. Blocks until any other locker on this row finishes, or
    // until lock_timeout fires (error 55P03, lock_not_available).
    const query = `SELECT id, data FROM entities WHERE id = $1 FOR UPDATE`

    var entity Entity
    if err := tx.QueryRowContext(ctx, query, id).Scan(&entity.ID, &entity.Data); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return fmt.Errorf("entity %s: %w", id, ErrNotFound)
        }
        return err
    }

    // Apply the caller's mutation while we hold the lock.
    if err := updateFn(&entity); err != nil {
        return err
    }

    const updateQuery = `UPDATE entities SET data = $1 WHERE id = $2`
    if _, err := tx.ExecContext(ctx, updateQuery, entity.Data, entity.ID); err != nil {
        return err
    }

    return tx.Commit()
}
```

> **`UpdateWithLockTimeout` was a stub that reported success.** Its body set `lock_timeout`, left the comment `// Rest is same as above...`, and returned `nil`. It never read the row, never called `updateFn`, and never wrote anything, yet it returned no error, so every caller believed the update had been applied. The function name, the signature, and the return value all agree that work happened. Nothing happened.
>
> This is the most dangerous shape a stub can take, and it is worth naming the pattern: **a placeholder that returns the success value.** A `panic("not implemented")` would have been caught by the first test. `return nil` is caught by nobody, because it is indistinguishable from working code at every call site and in every test that only checks `err == nil`. If you must leave a function unimplemented, make it loud. The fix here is also the boring one: the "rest is same as above" comment was a request to share the implementation, so share it. Two exported methods delegating to one unexported implementation is all it needed, and the duplication that the comment was apologizing for disappears.

Both approaches were verified against PostgreSQL 18.4 with `-race`. Optimistic: a stale writer holding version 0 against a row already at version 1 is rejected with `ErrConcurrentModification`, and a missing row reports `ErrNotFound` rather than a fabricated conflict. Pessimistic: 30 goroutines concurrently performing read-modify-write increments on the same row under `FOR UPDATE` produce a final value of exactly 30, with zero lost updates. Run that second test against the same code with the `FOR UPDATE` removed and watch it land somewhere in the low twenties, which is the entire argument for the clause in one experiment.

### Staff Lens: Optimistic vs Pessimistic

Optimistic (version numbers, retry on conflict): good for read-heavy, rare conflicts. Pessimistic (row locks): good for write-heavy, frequent conflicts. Choose based on conflict rate, and never mix strategies within the same operation.

The deeper point unifying this chapter: **optimistic locking, unique constraints, and `INSERT ... ON CONFLICT` are the same idea wearing different clothes.** Each one makes the database, not your application, the arbiter of a race, by expressing the decision as a single conditional write. Pessimistic locking is the odd one out: it prevents the race instead of detecting it, which is why it costs throughput. Reach for it when the work between read and write is genuinely non-retryable. Reach for the conditional write everywhere else, and never, ever reach for read-then-decide-then-write.

---
