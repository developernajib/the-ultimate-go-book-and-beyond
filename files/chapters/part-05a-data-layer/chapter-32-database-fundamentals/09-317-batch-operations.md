## 32.7 Batch Operations

### Batch Insert

Batch inserts use PostgreSQL's `COPY` protocol via `pgx.Conn.CopyFrom`, which streams rows to the server in binary format and is orders of magnitude faster than individual `INSERT` statements for bulk loads. For databases without `COPY` support, the batch is assembled into a single `INSERT INTO ... VALUES ($1,$2), ($3,$4), ...` query with the parameter slice built dynamically, bounding the batch size to avoid exceeding the server's parameter limit. Batch reads use `WHERE id = ANY($1)` with a `pq.Array` or `pgx` array parameter rather than issuing one query per ID, reducing the N+1 pattern to a single round trip.

```go
type User struct {
    Name  string
    Email string
}

type UserUpdate struct {
    ID    int64
    Name  string
    Email string
}

func batchInsertUsers(db *sql.DB, users []User) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.Prepare(`INSERT INTO users (name, email) VALUES ($1, $2)`)
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, user := range users {
        _, err := stmt.Exec(user.Name, user.Email)
        if err != nil {
            return err
        }
    }

    return tx.Commit()
}

// Using CopyIn for PostgreSQL (bulk insert)
func bulkInsertUsers(db *sql.DB, users []User) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.Prepare(pq.CopyIn("users", "name", "email"))
    if err != nil {
        return err
    }

    for _, user := range users {
        _, err := stmt.Exec(user.Name, user.Email)
        if err != nil {
            return err
        }
    }

    _, err = stmt.Exec()
    if err != nil {
        return err
    }

    err = stmt.Close()
    if err != nil {
        return err
    }

    return tx.Commit()
}
```

### Batch Update

Batch updates follow the same prepared-statement-in-a-transaction pattern as batch inserts. Preparing the `UPDATE` statement once and executing it in a loop avoids reparsing the query for each row. Wrapping the loop in a transaction ensures that either all updates apply or none do. A partial update in production data is often worse than a complete failure.

```go
func batchUpdateUsers(db *sql.DB, updates []UserUpdate) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.Prepare(`UPDATE users SET name = $1, email = $2 WHERE id = $3`)
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, update := range updates {
        _, err := stmt.Exec(update.Name, update.Email, update.ID)
        if err != nil {
            return err
        }
    }

    return tx.Commit()
}
```

### Junior → FAANG: Why Looping One-Row Inserts Is a Career-Limiting Move

Junior engineers inserting ten thousand rows in a `for` loop that calls `db.Exec` once per row will measure thirty seconds of wall time on a local database and forty-five minutes on a cloud database across a region boundary. Each call is a full round trip with its own network latency, parameter parse, statement plan lookup, and durability wait on the WAL. At 1ms network round trip plus 0.5ms server work per statement, ten thousand rows is fifteen seconds before the server even saturates CPU. The first-job fix is to wrap the loop in a single transaction so commit cost is paid once, not ten thousand times. The second fix is to replace the loop with a single multi-row `INSERT INTO t (a, b) VALUES ($1,$2), ($3,$4), ...` batched in groups of a few hundred rows to stay under the parameter limit. Postgres caps at 65535 bind parameters per statement, so with three columns per row your safe batch size is about 20000 rows per statement, and a prudent default is 1000 for latency predictability. Interview entry point: "You need to load one million rows into a table. Walk me through the options from slowest to fastest." A good answer lists loop-of-inserts, transaction-wrapped loop, multi-row `INSERT`, `COPY FROM`, and finally `COPY FROM` in binary format with an unlogged staging table, and explains the round-trip and WAL cost at each step. Worked example: for a signup import job processing a CSV, the junior writes a `for` loop, the mid-level uses `pq.CopyIn`, and the FAANG-trained new grad reaches for `pgx.CopyFromRows` with binary encoding because the interview prep material covered it.

### Senior @ FAANG: COPY vs Multi-Row INSERT vs pgx.Batch, UPSERT Semantics, and MERGE

Staff-level engineers pick the batch primitive per workload profile and defend the choice in an ADR. The three Postgres-native options for Go are `COPY FROM` via the binary protocol, multi-row `INSERT ... VALUES (...), (...)`, and `pgx.Batch` which pipelines many statements over a single round trip using the extended query protocol. Benchmarks published by the pgx maintainers and reproduced in production at large shops consistently show `COPY FROM` in binary format is roughly ten times faster than multi-row `INSERT` for pure bulk loads, because binary `COPY` skips text encoding and decoding, skips plan lookup per row, and streams straight into the tuple insertion path. Multi-row `INSERT` wins when you need `RETURNING` columns, ON CONFLICT handling, or per-row validation against constraints that you want surfaced as individual errors. `pgx.Batch` wins for heterogeneous workloads where you have a mix of inserts, updates, and deletes that must execute together and you want a single network round trip instead of one per statement. The decision tree a staff engineer keeps in their head: pure append-only bulk load use binary COPY to an unlogged staging table and then `INSERT INTO target SELECT FROM staging ON CONFLICT DO UPDATE`, mixed DML in a transaction use `pgx.Batch`, ORM-shaped per-request writes of two or three rows stick with parameterized multi-row INSERT.

UPSERT semantics are the next senior topic. `INSERT ... ON CONFLICT (col) DO UPDATE SET ...` is not a free lunch. It requires a unique index or primary key on the conflict target, and it acquires a row-level lock on the conflicting row. Under concurrent writers the `EXCLUDED` pseudo-row gives you the would-be-inserted values, and you use `WHERE` on the DO UPDATE to avoid pointless writes that still bump the transaction ID and bloat the table. The race you must explicitly reason about is that `ON CONFLICT DO NOTHING` returns zero rows without indicating whether the row existed before or a conflicting concurrent insert blocked you, so if you need the row back you always use `ON CONFLICT DO UPDATE ... RETURNING` even when the update is a no-op assignment like `SET col = EXCLUDED.col`. Postgres 15 added SQL standard `MERGE`, which is more expressive for the match-multiple-sources case but notably does not support `RETURNING` until 17, and its conflict semantics differ from `ON CONFLICT` in subtle ways. Principal-level nuance: `ON CONFLICT` uses the unique index to detect conflicts atomically, while `MERGE` uses a serializable snapshot, so under repeatable-read isolation `MERGE` can raise `could not serialize access` errors that `ON CONFLICT` does not, forcing you into retry loops.

Production bulk-load patterns you should be able to draw on a whiteboard: binary `COPY` into an UNLOGGED staging table (no WAL, ten times faster ingest), then a single atomic `INSERT INTO target SELECT ... FROM staging ON CONFLICT DO UPDATE WHERE target.updated_at < EXCLUDED.updated_at RETURNING id` so late-arriving data does not overwrite newer rows, then `TRUNCATE staging` for the next batch. Observability contract on this path includes rows per second, bytes per second, p99 commit latency, WAL bytes generated per batch, and the percentage of `ON CONFLICT` updates versus fresh inserts, all emitted as OTEL metrics with a `batch_id` trace attribute. Load shedding rule: if pool wait time exceeds 100ms, halve the batch size and retry with jittered backoff, because the bottleneck has shifted from Postgres to pool contention. These are the decisions that get cited in a promo packet.

---
