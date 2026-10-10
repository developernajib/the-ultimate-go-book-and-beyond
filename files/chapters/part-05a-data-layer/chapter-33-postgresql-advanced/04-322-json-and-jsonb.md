## 33.2 JSON and JSONB

### Working with JSONB

JSONB columns in PostgreSQL store JSON in a binary decomposed format that supports GIN indexing on specific paths, enabling sub-millisecond lookups on `metadata->>'tenant_id'` without scanning every row. Always prefer `JSONB` over `JSON` unless you need exact whitespace and key-order preservation: `JSON` is stored as text and re-parsed on every access. In Go, `pgx` v5 scans JSONB into `[]byte` (or `json.RawMessage`), and any `json.Marshaler`-compatible struct passed as a parameter is serialized by the driver. This lets you defer JSON unmarshaling to the caller rather than paying the cost on every row in a result set. The `@>` containment operator checks whether a JSONB column contains a JSON sub-document. `@?` tests a JSONPath predicate. `@@` evaluates a boolean JSONPath. All three are GIN-indexable.

Index strategy:

```sql
-- General-purpose GIN index (supports @>, ?, ?&, ?|, @@, @?)
CREATE INDEX idx_users_prefs ON users USING GIN (preferences);

-- Smaller and faster for containment-only workloads (@>)
CREATE INDEX idx_users_prefs_ops ON users USING GIN (preferences jsonb_path_ops);

-- Expression index for a single hot attribute
CREATE INDEX idx_users_tenant ON users ((preferences->>'tenant_id'));
```

Use `jsonb_path_ops` when every query uses `@>`. It is roughly half the size and faster to maintain than the default `jsonb_ops`.

```go
package main

import (
    "context"
    "encoding/json"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

type UserPreferences struct {
    Theme         string   `json:"theme"`
    Language      string   `json:"language"`
    Notifications bool     `json:"notifications"`
    Tags          []string `json:"tags"`
}

type User struct {
    ID          int64
    Name        string
    Preferences UserPreferences
}

// Insert with JSONB
func createUser(ctx context.Context, pool *pgxpool.Pool, user *User) error {
    prefsJSON, err := json.Marshal(user.Preferences)
    if err != nil {
        return err
    }

    query := `
        INSERT INTO users (name, preferences)
        VALUES ($1, $2)
        RETURNING id
    `
    return pool.QueryRow(ctx, query, user.Name, prefsJSON).Scan(&user.ID)
}

// Query JSONB
func getUserByID(ctx context.Context, pool *pgxpool.Pool, id int64) (*User, error) {
    query := `SELECT id, name, preferences FROM users WHERE id = $1`

    var user User
    var prefsJSON []byte

    err := pool.QueryRow(ctx, query, id).Scan(&user.ID, &user.Name, &prefsJSON)
    if err != nil {
        return nil, err
    }

    if err := json.Unmarshal(prefsJSON, &user.Preferences); err != nil {
        return nil, err
    }

    return &user, nil
}

func collectUsers(rows pgx.Rows) ([]User, error) {
    var users []User
    for rows.Next() {
        var user User
        var prefsJSON []byte
        if err := rows.Scan(&user.ID, &user.Name, &prefsJSON); err != nil {
            return nil, err
        }
        if err := json.Unmarshal(prefsJSON, &user.Preferences); err != nil {
            return nil, err
        }
        users = append(users, user)
    }
    return users, rows.Err()
}

// Query within JSONB
func getUsersByTheme(ctx context.Context, pool *pgxpool.Pool, theme string) ([]User, error) {
    query := `
        SELECT id, name, preferences
        FROM users
        WHERE preferences->>'theme' = $1
    `

    rows, err := pool.Query(ctx, query, theme)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    return collectUsers(rows)
}

// Update JSONB field. Build the patch in Go and let the driver send it as
// JSONB. Never interpolate user strings into the query text.
func updateUserTheme(ctx context.Context, pool *pgxpool.Pool, userID int64, theme string) error {
    patch, err := json.Marshal(theme) // quotes the string safely
    if err != nil {
        return err
    }
    const query = `
        UPDATE users
        SET preferences = jsonb_set(preferences, '{theme}', $1::jsonb, true)
        WHERE id = $2
    `
    _, err = pool.Exec(ctx, query, patch, userID)
    return err
}

// Containment query that hits a GIN index with jsonb_path_ops.
func findUsersWithPrefs(ctx context.Context, pool *pgxpool.Pool, match map[string]any) ([]User, error) {
    payload, err := json.Marshal(match)
    if err != nil {
        return nil, err
    }
    const query = `SELECT id, name, preferences FROM users WHERE preferences @> $1`
    rows, err := pool.Query(ctx, query, payload)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    return collectUsers(rows)
}

// Query with JSONB operators
func searchUsers(ctx context.Context, pool *pgxpool.Pool, tag string) ([]User, error) {
    query := `
        SELECT id, name, preferences
        FROM users
        WHERE preferences->'tags' ? $1
    `
    rows, err := pool.Query(ctx, query, tag)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    return collectUsers(rows)
}
```

### Junior → FAANG: JSONB is Not a License to Skip Schema Design

The most common junior mistake with JSONB is treating it as a schema-free escape hatch. It is not. JSONB is a structured type, and every field in it is still part of your contract with the rest of the system. The discipline is that you make the schema explicit at the application layer because Postgres will not enforce it for you.

Prerequisite gap. You need to understand how `->`, `->>`, `#>`, `#>>`, `@>`, `?`, `?|`, and `?&` differ before writing any query. The compact version. `->` returns JSON. `->>` returns text. `#>` walks a path and returns JSON. `#>>` walks a path and returns text. `@>` is "contains" for indexable subdocument matching. `?` tests for a top-level key. `?|` and `?&` test any or all of a list of keys. Memorize this table. You will use it every day.

Worked example of the shape-of-data decision. A junior is told to store "user activity events." The default instinct is a single JSONB column `event_data`. That works for writes but fails queries. The senior refactor is a hybrid: typed columns for `user_id`, `event_type`, `occurred_at`, `session_id` (all indexable, all filterable, all joinable), plus a `properties JSONB` column for the event-type-specific long tail. The typed columns carry the queries. The JSONB carries the flexibility. This hybrid is the FAANG default for event ingestion.

Schema validation at the app layer. If you store `{"theme": "dark", "language": "en"}`, nothing prevents a future writer from storing `{"themee": "drak"}`. The fix is a JSON Schema file committed in the repo, checked at the boundary of your service with `github.com/xeipuuv/gojsonschema` (or the newer `github.com/santhosh-tekuri/jsonschema/v6` with draft 2020-12 support). This is not optional in production code. The rule is: every JSONB column has either (a) a JSON Schema, (b) a CUE spec, or (c) a documented free-form exception approved by the schema-review team. Without one of the three, you will eventually inherit a dataset nobody can query.

First-job interview entry-point. Given a JSONB column `metadata`, write a query that finds rows where `metadata` contains `{"source": "web", "country": "US"}` and also has a non-null `campaign_id`. The expected answer is `WHERE metadata @> '{"source":"web","country":"US"}' AND metadata ? 'campaign_id'`. The `@>` uses the GIN `jsonb_path_ops` index. The `?` also uses the default `jsonb_ops` index. A single column cannot have both operator classes on the same index, so the reviewer will ask which operator class you chose and why. The answer for mostly-containment workloads is `jsonb_path_ops` plus an expression index on `(metadata ? 'campaign_id')` only if that key-existence predicate is on a hot path.

Trap. `preferences->>'tenant_id' = $1` does not use the GIN index. It uses an expression index on `((preferences->>'tenant_id'))` if you create one. Juniors often create a GIN index, see that their per-key-equality queries are still slow, and escalate. The fix is either (a) rewrite to containment `preferences @> jsonb_build_object('tenant_id', $1)`, or (b) add the expression index. Know both paths.

### Senior @ FAANG: JSONB Physics, Index Economics, and the Schema Governance Problem

JSONB storage physics. JSONB is stored as a binary tree with keys deduplicated and values tagged with type. For values above the `TOAST_TUPLE_THRESHOLD` (roughly 2KB), the value is moved out-of-line to the TOAST table and optionally compressed. PG14 added LZ4 as an opt-in TOAST compression alongside the default PGLZ (LZ4 is roughly 2x faster to decompress with comparable ratios on JSON), selectable per column or via `default_toast_compression`. The practical implication: a JSONB column under 2KB lives inline and reads are free. Above 2KB, every SELECT that touches the column pays a detoast cost measured in tens of microseconds per row. That cost is invisible until it isn't.

`jsonb_path_ops` vs `jsonb_ops` economics. Benchmark data on a 10M row table with average JSONB size 800 bytes shows `jsonb_path_ops` indexes at roughly 1.2GB vs `jsonb_ops` at roughly 3.5GB. Query latency on `@>` lookups is roughly 1.8x faster with `jsonb_path_ops`. Build time is roughly 2x faster. The tradeoff is exclusively the operators you give up: `?`, `?|`, `?&`, `@?`, and `@@` all require `jsonb_ops`. If you need key-existence queries on the same column, the correct pattern is two indexes (one per operator class) or, better, a stored generated boolean column plus a btree index on it. The latter is faster, smaller, and more observable.

Hybrid schema pattern. The canonical FAANG shape for any document-flexible table is:

```sql
CREATE TABLE events (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    UUID NOT NULL,
    event_type   TEXT NOT NULL,
    occurred_at  TIMESTAMPTZ NOT NULL,
    properties   JSONB NOT NULL,
    -- Generated columns for hot query paths
    user_id      UUID GENERATED ALWAYS AS (properties->>'user_id')::uuid STORED,
    source       TEXT GENERATED ALWAYS AS (properties->>'source') STORED
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ON events (tenant_id, event_type, occurred_at DESC);
CREATE INDEX ON events USING GIN (properties jsonb_path_ops);
CREATE INDEX ON events (user_id) WHERE user_id IS NOT NULL;
```

Generated columns give you typed access to hot JSONB paths without duplicating storage at the application layer, and they are transparent to the writer. The tradeoff is rewriting a generated column on every UPDATE that touches `properties`, so avoid them for write-heavy columns.

JSONB vs hstore vs normalized. hstore is the legacy predecessor to JSONB and is mostly obsolete in 2026. It only stores flat string-to-string maps, does not support nested structures, and its GIN index is strictly inferior to `jsonb_path_ops`. The only remaining defensible use case is legacy migrations. Normalized (relational) storage beats JSONB when (a) you need referential integrity on a nested field, (b) queries filter on nested fields with selectivity, or (c) you need ORDER BY on a nested field at scale. JSONB beats normalized when the shape is genuinely sparse, per-tenant-variable, or write-once-read-shaped.

JSONPath (SQL/JSON standard, stable in PG12, expanded through PG17). `@?` and `@@` operators run JSONPath predicates. Example: `data @? '$.items[*] ? (@.price_cents > 10000)'` finds rows where any item has `price_cents` over 10000. JSONPath is indexable via `jsonb_ops` GIN but not `jsonb_path_ops`. PG17 added the SQL-standard `JSON_TABLE` for flattening JSONB into relational rows at query time, plus the `JSON_EXISTS`, `JSON_QUERY`, and `JSON_VALUE` functions (the `jsonb_path_exists` and `jsonb_path_query` functions themselves date to PG12). `JSON_TABLE` is the right tool for ad-hoc reports against JSONB, not for hot paths.

JSONB bloat and detoasting cost. A JSONB column updated in place rewrites the entire TOAST chunk on every update, even if you only changed one key. `jsonb_set` returns a new JSONB value and Postgres rewrites the row (HOT update if no indexed column changed, otherwise a full row rewrite). For hot-update JSONB columns, the write amplification is significant. The mitigation is (a) split hot keys into typed columns, (b) use `FILLFACTOR = 70` on the table to enable HOT updates, (c) batch updates in one statement rather than N separate updates. Above roughly 10 writes per second per row with a JSONB column, reconsider whether JSONB is the right shape.

Schema validation at app layer. `gojsonschema` is the reference implementation for JSON Schema draft 4/6/7 and is battle-tested. For draft 2020-12 features (unevaluatedProperties, dynamic refs) use `santhosh-tekuri/jsonschema/v6`. The staff deliverable is a registry: every JSONB column has a path in `/schemas/` and a CI check that fails any migration adding a JSONB column without a matching schema file or an explicit `@free-form` tag. CUE is the nicer alternative for teams that can invest in it, because CUE schemas compose and constrain better than JSON Schema.

Staff ADR for any new JSONB column. Required answers: (1) which GIN operator class and why, (2) what fields are also generated columns or typed columns, (3) what is the expected p50 and p99 size, (4) what is the write frequency per row, (5) where is the schema enforced, (6) what is the reversal trigger (size, write rate, query pattern) that would push this column back to normalized storage. Without these six answers the column should not merge.

---
