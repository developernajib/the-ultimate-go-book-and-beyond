## 33.9 Upserts and Conflicts

### ON CONFLICT DO UPDATE

PostgreSQL's `INSERT ... ON CONFLICT DO UPDATE` atomically inserts a row or updates it if the specified unique constraint is violated, avoiding the read-modify-write race condition of a `SELECT` followed by `INSERT` or `UPDATE`. The `DO UPDATE SET` clause can reference the `EXCLUDED` pseudo-table to access the values that would have been inserted, enabling patterns like incrementing a counter or taking the maximum of the existing and incoming values. `ON CONFLICT DO NOTHING` is used when duplicate inserts should be silently ignored (e.g., idempotent event recording), returning zero rows affected rather than an error for the caller to handle.

> **Senior track**: `ON CONFLICT` requires a unique constraint or unique index on the target. For partial uniqueness, create a partial unique index and reference it by constraint name with `ON CONFLICT ON CONSTRAINT idx_name`, or by predicate with `ON CONFLICT (col) WHERE ...`. A `WHERE` filter on the `DO UPDATE` branch (last-write-wins versioning, see `upsertIfNewer` below) prevents older writes from clobbering newer ones. On PostgreSQL 15+, `MERGE` is an alternative that supports multiple match branches, but `INSERT ... ON CONFLICT` remains the idiomatic choice for single-target upserts because `MERGE` does not yet guarantee the same concurrency behavior.

```go
package main

import (
    "context"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
    ID    int64
    Email string
    Name  string
}

type Record struct {
    ID      int64
    Data    string
    Version int64
}

type Product struct {
    SKU        string
    Name       string
    PriceCents int64
}

func upsertUser(ctx context.Context, pool *pgxpool.Pool, user *User) error {
    query := `
        INSERT INTO users (email, name, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (email)
        DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = NOW()
        RETURNING id
    `

    return pool.QueryRow(ctx, query, user.Email, user.Name).Scan(&user.ID)
}

// Conditional upsert
func upsertIfNewer(ctx context.Context, pool *pgxpool.Pool, record *Record) error {
    query := `
        INSERT INTO records (id, data, version)
        VALUES ($1, $2, $3)
        ON CONFLICT (id)
        DO UPDATE SET
            data = EXCLUDED.data,
            version = EXCLUDED.version
        WHERE records.version < EXCLUDED.version
    `

    _, err := pool.Exec(ctx, query, record.ID, record.Data, record.Version)
    return err
}

// Bulk upsert
func bulkUpsertProducts(ctx context.Context, pool *pgxpool.Pool, products []Product) error {
    query := `
        INSERT INTO products (sku, name, price_cents)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku)
        DO UPDATE SET
            name = EXCLUDED.name,
            price_cents = EXCLUDED.price_cents
    `

    batch := &pgx.Batch{}
    for _, p := range products {
        batch.Queue(query, p.SKU, p.Name, p.PriceCents)
    }

    br := pool.SendBatch(ctx, batch)
    defer br.Close()

    for range products {
        if _, err := br.Exec(); err != nil {
            return err
        }
    }

    return nil
}
```

### Junior → FAANG: upsert without the race

The classic junior mistake is the read-check-write pattern: `SELECT` to see if the row exists, then `INSERT` or `UPDATE` depending on the result. Under concurrency this always races. Two clients see "not present", both `INSERT`, one succeeds and the other raises a unique-violation error. You then write retry logic. This is wrong from the start. `INSERT ... ON CONFLICT` is the correct primitive.

Worked example. You receive webhook events from Stripe and want to record each event exactly once, keyed by the Stripe event ID.

```sql
INSERT INTO stripe_events (id, type, payload, received_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (id) DO NOTHING
RETURNING id;
```

If the row is new, `RETURNING` produces one row and you enqueue processing. If the event was already seen, `RETURNING` produces zero rows and your handler is a no-op. This is the idempotent-ingest pattern every webhook endpoint should use.

What `EXCLUDED` is. Inside the `DO UPDATE` branch, `EXCLUDED` is a pseudo-table holding the row you tried to insert. `users.email` is the existing row, `EXCLUDED.email` is the incoming value. This lets you write things like `counter = users.counter + EXCLUDED.counter` to accumulate.

Interview entry-point. Know the difference between `DO NOTHING` and `DO UPDATE`. Know that `ON CONFLICT` needs a unique constraint or unique index on the specified columns or it is a syntax error. Know that the conflict target can be a constraint name (`ON CONFLICT ON CONSTRAINT users_email_key`) or a column list (`ON CONFLICT (email)`). Know that `RETURNING` returns the final row (inserted or updated), not the pre-state.

### Senior @ FAANG: concurrency anomalies, MERGE, and real race conditions

Upsert is not a single thing. It is a family of operations with different concurrency guarantees and different failure modes. The staff-level mental model is to understand what protects what.

The `DO UPDATE WHERE` race. `upsertIfNewer` above uses `WHERE records.version < EXCLUDED.version` to reject stale writes. This is a legitimate pattern but has a subtle bug: when the `WHERE` filters the update out, the statement affects zero rows but does not raise an error. If the caller expected their write to land, they have no signal that it did not. Return `xmax` to detect the case (`RETURNING (xmax <> 0) AS updated`), or use `RETURNING *` and check row count. Without this, silent last-write-loses bugs ship to production.

The INSERT vs UPDATE visibility ordering. `INSERT ... ON CONFLICT` under concurrent load can produce surprising serializable anomalies. Two transactions inserting the same key with different updates: one takes the `INSERT` path, the other takes `DO UPDATE` path and sees the inserted row. Under `READ COMMITTED` (the default), the second transaction's `DO UPDATE` sees the first's insert even though the first has not yet committed, because `ON CONFLICT` uses a different visibility rule to prevent duplicate-key errors. Under `SERIALIZABLE`, the second transaction may be aborted with a serialization error even though the individual statements look safe. Production code that runs upserts must be prepared to retry on `40001` errors.

`DO NOTHING RETURNING` caveats. `INSERT ... ON CONFLICT DO NOTHING RETURNING id` returns zero rows when the conflict path fires. That is not "I processed a duplicate event". That is "I performed no action". If you need to tell "already existed" apart from other reasons for no rows (for example a partial unique index's predicate did not match the incoming row so no conflict was detected and the insert landed), you need an explicit follow-up `SELECT` or the pattern `WITH ins AS (INSERT ... ON CONFLICT DO NOTHING RETURNING id) SELECT id FROM ins UNION ALL SELECT id FROM t WHERE key = $1 LIMIT 1`. The union form returns the existing ID even when the insert was a no-op.

Partial unique indexes. `ON CONFLICT` requires the inference to match a unique constraint or index. If your uniqueness is conditional (`CREATE UNIQUE INDEX ux_users_email_live ON users(email) WHERE deleted_at IS NULL`), you must specify both the target columns and the predicate: `ON CONFLICT (email) WHERE deleted_at IS NULL`. Otherwise PG rejects the statement because multiple indexes could match. This breaks many soft-delete schemes until the author adds the predicate.

`MERGE` in PG15+. `MERGE` was added in PG15 and improved in PG17/18 with `RETURNING` support and better concurrency semantics. It allows multiple `WHEN MATCHED` and `WHEN NOT MATCHED` branches against a join condition, which is strictly more expressive than `ON CONFLICT`. Legitimate cases: syncing a staging table into a target table where different source rows need different actions (insert new, update changed, delete missing). For simple single-row upserts, `INSERT ... ON CONFLICT` remains preferred because it uses unique-index inference for conflict detection, which is immune to the lost-update-under-concurrency class of bugs that plagued `MERGE` in other engines. PG's `MERGE` in PG17 documents its concurrency semantics, and under `READ COMMITTED` a concurrent insert can still cause `MERGE` to fail with a duplicate-key error that `ON CONFLICT` would have handled cleanly. Rule of thumb in 2026: use `MERGE` for bulk ETL sync jobs, keep `ON CONFLICT` for OLTP upserts.

Bulk upserts. The Batch-per-row pattern above is fine at small volume. At high volume, `INSERT ... SELECT FROM unnest($1::bigint[], $2::text[], $3::bigint[]) AS s(id, name, price_cents) ON CONFLICT (id) DO UPDATE SET ...` is an order of magnitude faster because it is a single statement with a single WAL record group and a single planner pass. For very large bulk upserts, `COPY` into a temp table and then `INSERT ... SELECT ... ON CONFLICT` outperforms everything else and keeps the WAL churn predictable.

Trigger interactions. Rules differ for the insert path and the update path. `BEFORE INSERT` triggers fire for the insert attempt. `BEFORE UPDATE` triggers fire when `ON CONFLICT DO UPDATE` takes the update path. If your trigger sets `updated_at` on update but not on insert, rows created via the insert path will have a null `updated_at` unless the column default covers it. Every upsert target must have its trigger behavior audited under both paths.

Code-review rules. No upsert ships without explicit conflict target columns (never rely on "the default"). No `DO UPDATE WHERE` ships without returning a success signal to the caller. No upsert on a soft-deletable table ships without the partial-index predicate. No bulk upsert uses per-row batches when `unnest` or `COPY` would do. No `MERGE` ships without a written rationale for why `ON CONFLICT` was insufficient.

---
