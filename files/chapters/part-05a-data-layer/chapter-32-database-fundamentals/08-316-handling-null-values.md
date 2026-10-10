## 32.6 Handling NULL Values

### Using sql.Null Types

Nullable database columns are represented with `sql.NullString`, `sql.NullInt64`, and `sql.NullTime` rather than pointer types, because pointer fields complicate JSON serialization and nil-dereference safety. The `Valid` field on each `sql.Null*` type is checked before using the `Value` field, matching the database's three-valued logic where NULL is distinct from both true and false. For the JSON API layer, nullable values are converted to pointer types or `omitempty`-tagged fields so null columns serialize as `null` in JSON rather than the zero value of the Go type.

```go
type User struct {
    ID        int64
    Name      string
    Email     sql.NullString  // Nullable
    Age       sql.NullInt64   // Nullable
    UpdatedAt sql.NullTime    // Nullable
}

func getUser(db *sql.DB, id int64) (*User, error) {
    query := `SELECT id, name, email, age, updated_at FROM users WHERE id = $1`

    var user User
    err := db.QueryRow(query, id).Scan(
        &user.ID,
        &user.Name,
        &user.Email,
        &user.Age,
        &user.UpdatedAt,
    )
    if err != nil {
        return nil, err
    }

    return &user, nil
}

// Using the values
func printUser(user *User) {
    fmt.Printf("ID: %d\n", user.ID)
    fmt.Printf("Name: %s\n", user.Name)

    if user.Email.Valid {
        fmt.Printf("Email: %s\n", user.Email.String)
    } else {
        fmt.Println("Email: (not set)")
    }

    if user.Age.Valid {
        fmt.Printf("Age: %d\n", user.Age.Int64)
    }
}
```

### Custom Nullable Types

The standard `sql.Null*` types do not implement `json.Marshaler`, so they serialize as `{"String":"...", "Valid":true}` rather than a plain value or `null`. A custom nullable type can implement both `sql.Scanner`/`driver.Valuer` for the database layer and `json.Marshaler`/`json.Unmarshaler` for the API layer, producing clean JSON output without a separate conversion step.

```go
type NullString struct {
    String string
    Valid  bool
}

func (ns *NullString) Scan(value any) error {
    if value == nil {
        ns.String, ns.Valid = "", false
        return nil
    }
    ns.Valid = true
    switch v := value.(type) {
    case string:
        ns.String = v
    case []byte:
        ns.String = string(v)
    default:
        return fmt.Errorf("cannot convert %T to string", value)
    }
    return nil
}

func (ns NullString) Value() (driver.Value, error) {
    if !ns.Valid {
        return nil, nil
    }
    return ns.String, nil
}

// JSON marshaling
func (ns NullString) MarshalJSON() ([]byte, error) {
    if !ns.Valid {
        return []byte("null"), nil
    }
    return json.Marshal(ns.String)
}

func (ns *NullString) UnmarshalJSON(data []byte) error {
    if string(data) == "null" {
        ns.Valid = false
        return nil
    }
    ns.Valid = true
    return json.Unmarshal(data, &ns.String)
}
```

### Pointer Approach

An alternative to `sql.Null*` types is using Go pointers: `*string`, `*int`, `*time.Time`. The `database/sql` `Scan` method handles pointer fields natively. A NULL column sets the pointer to `nil`. This approach works well with `encoding/json` out of the box, since `nil` pointers serialize as `null` and `omitempty` skips them entirely. The trade-off is that pointer fields require nil checks everywhere they are accessed, and they add heap allocations that `sql.Null*` value types avoid.

> **Senior track**: Go 1.22 added generics-friendly `sql.Null[T]` (e.g. `sql.Null[int64]`, `sql.Null[time.Time]`), which deprecates the need for the per-type wrappers in new code. If you use `pgx` natively (`pgxpool.Pool`), nullable columns scan directly into `*T` pointer fields without any wrapper - pgx handles NULL by setting the pointer to nil. And if you use `sqlc`, the generator picks the right nullable representation for you based on the column definition (pointer vs. `sql.Null*` vs. custom type), and the type flows through to your application code automatically.

```go
type User struct {
    ID        int64
    Name      string
    Email     *string    // nil if NULL
    Age       *int       // nil if NULL
    UpdatedAt *time.Time // nil if NULL
}

func getUserWithPointers(db *sql.DB, id int64) (*User, error) {
    query := `SELECT id, name, email, age, updated_at FROM users WHERE id = $1`

    var user User
    err := db.QueryRow(query, id).Scan(
        &user.ID,
        &user.Name,
        &user.Email,
        &user.Age,
        &user.UpdatedAt,
    )
    if err != nil {
        return nil, err
    }

    return &user, nil
}
```

### Junior → FAANG: NULL Is Not Zero and Not Empty

Junior engineers learning SQL almost always trip over NULL. They write `WHERE email = NULL` and wonder why zero rows come back, then write `WHERE email != 'bob@x.com'` and wonder why the row with `email IS NULL` does not match. NULL in SQL means "unknown," and the correct comparisons are `IS NULL` and `IS NOT NULL`. Anything compared to NULL with `=`, `!=`, `<`, `>`, or `LIKE` returns NULL, which is neither true nor false, so the row is filtered out by the `WHERE` clause. This is called three-valued logic and it is the single most common SQL bug in junior-written code. Worked example: to find users without a verified email, you write `WHERE verified_at IS NULL`, not `WHERE verified_at = NULL`. On the Go side, the first-job rule is to match every nullable column to a nullable Go type. If the column is `email TEXT NULL` and you scan into a plain `string`, the driver returns a `Scan error on column index N: converting NULL to string is unsupported`. Interview entry point: "How do you represent a nullable integer in Go and why not just use 0 as a sentinel?" The honest answer covers that zero is a valid domain value for most integer columns, so a sentinel silently corrupts semantics. You either use `sql.NullInt64`, `sql.Null[int64]` from Go 1.22 plus, a pointer `*int64`, or a typed wrapper. A good junior can articulate the trade-off between heap allocation for pointers and ergonomic access for `Valid` checks on `sql.Null*`.

### Senior @ FAANG: Three-Valued Logic, NULL Propagation, and the Typed Nullable Debate

Staff engineers reason about NULL as a semantic hazard that propagates through every layer of the system. The three-valued logic trap extends beyond `WHERE`. Aggregates like `COUNT(column)` silently skip NULLs while `COUNT(*)` counts rows including those with NULL, so a change from `COUNT(email)` to `COUNT(*)` on a nullable column quietly changes dashboards and billing calculations. `SUM(nullable_col)` returns NULL if every row is NULL, which breaks downstream consumers expecting zero. `column NOT IN (subquery)` returns zero rows if the subquery contains a single NULL, because `x != NULL` is NULL and the `ALL` semantics of `NOT IN` require every comparison to be true. The staff mitigation is to always wrap nullable columns in `COALESCE` at aggregation boundaries, to prefer `NOT EXISTS` over `NOT IN` on nullable columns, and to add a schema-level review rule that any new `NULL`-able column must have a documented reason and a default behavior for analytics.

The `sql.Null*` versus pointer versus typed-wrapper debate is a recurring ADR in every Go shop above fifty engineers. The four real options are (1) `sql.Null[T]` generic wrappers from Go 1.22 plus, (2) pointer types like `*string`, (3) third-party typed helpers like `null.String` from `gopkg.in/guregu/null.v4`, and (4) domain-specific value objects like `EmailOpt` that wrap a `string` with semantic methods. Pointers are cheap in developer hours and play perfectly with `encoding/json`, but they force nil checks at every access site, they cause nil-pointer panics when someone forgets, and they allocate on the heap. `sql.Null[T]` avoids the nil panic risk and the allocation but serializes as an object `{"Valid":true,"V":"..."}` by default, forcing a DTO layer. The `guregu/null` family handles JSON and SQL symmetrically and is the pragmatic winner for API-facing structs, at the cost of a third-party dependency. Domain value objects are the principal-level answer when NULL carries real business meaning, for example a `Discount` type whose absence versus zero matters differently to billing. The ADR you will write compares these on five axes: nil-panic risk, JSON ergonomics, ORM compatibility, allocation cost, and semantic clarity, and the recommendation often differs between hot-path read models (pointer or `sql.Null[T]`) and write-side command DTOs (typed wrappers).

A principal-level nuance is distinguishing absence from zero across the network boundary. JSON `null` and a missing field are semantically different, and if your API client is TypeScript with `strictNullChecks`, the contract must be explicit. Teams commonly adopt a convention where `omitempty` plus pointer means "field may be omitted when NULL," while an explicit `null` in the JSON body on write means "set this column to NULL." Patch semantics (PATCH requests) need a tri-state: absent (do not touch), null (set to NULL), present (set to value), which no vanilla Go type models cleanly, forcing a custom `Patch[T]` wrapper. Interview screen for senior candidates: "Design a PATCH endpoint that distinguishes absent, null, and present for a nullable column, end to end from HTTP to Postgres, and explain how you would test it."

---
