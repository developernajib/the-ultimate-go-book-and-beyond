## 33.3 Arrays

### Working with PostgreSQL Arrays

PostgreSQL arrays map directly to Go slices under `pgx` v5: pass `[]int64`, `[]string`, or `[]time.Time` as query parameters and the driver encodes them in the binary array format. No `pq.Array` wrapper is needed (that belonged to `database/sql` with `lib/pq`). Under `pgx` v5 it is handled by the built-in `pgtype` codecs. `WHERE id = ANY($1)` accepts a slice directly, letting you avoid building a dynamic `IN (?,?,?)` clause with per-element parameters. GIN indexes on array columns (`CREATE INDEX ... USING GIN (tags)`) answer `@>` (contains), `&&` (overlaps), and `<@` (is contained) from the index instead of scanning every row's array.

> **Senior track**: For very short fixed-cardinality tag sets, a normalized `post_tags(post_id, tag)` join table with a composite B-tree index often outperforms arrays on analytics workloads because it permits index-only joins and per-tag statistics. Arrays win when membership is the dominant access pattern and tags are rarely queried on their own.

```go
package main

import (
    "context"

    "github.com/jackc/pgx/v5/pgxpool"
)

type Post struct {
    ID    int64
    Title string
    Tags  []string
}

// Insert array
func createPost(ctx context.Context, pool *pgxpool.Pool, title string, tags []string) (int64, error) {
    query := `
        INSERT INTO posts (title, tags)
        VALUES ($1, $2)
        RETURNING id
    `

    var id int64
    err := pool.QueryRow(ctx, query, title, tags).Scan(&id)
    return id, err
}

// Query array
func getPost(ctx context.Context, pool *pgxpool.Pool, id int64) (*Post, error) {
    query := `SELECT id, title, tags FROM posts WHERE id = $1`

    var post Post
    err := pool.QueryRow(ctx, query, id).Scan(&post.ID, &post.Title, &post.Tags)
    return &post, err
}

// Array contains
func getPostsByTag(ctx context.Context, pool *pgxpool.Pool, tag string) ([]Post, error) {
    query := `SELECT id, title, tags FROM posts WHERE $1 = ANY(tags)`

    rows, err := pool.Query(ctx, query, tag)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var posts []Post
    for rows.Next() {
        var post Post
        if err := rows.Scan(&post.ID, &post.Title, &post.Tags); err != nil {
            return nil, err
        }
        posts = append(posts, post)
    }

    return posts, rows.Err()
}

// Array overlap
func getPostsByTags(ctx context.Context, pool *pgxpool.Pool, tags []string) ([]Post, error) {
    query := `SELECT id, title, tags FROM posts WHERE tags && $1`

    rows, err := pool.Query(ctx, query, tags)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var posts []Post
    for rows.Next() {
        var post Post
        if err := rows.Scan(&post.ID, &post.Title, &post.Tags); err != nil {
            return nil, err
        }
        posts = append(posts, post)
    }

    return posts, rows.Err()
}
```

### Junior → FAANG: Arrays, `ANY`, and the N+1 Fix You Were Missing

The single most useful Postgres-plus-pgx pattern for a junior to internalize is `WHERE id = ANY($1)` with a Go slice as the parameter. It replaces the "build a dynamic `IN (?, ?, ?)` clause" anti-pattern and fixes roughly half of the N+1 query problems that reviewers flag in first-month code. The driver encodes the slice using the binary array protocol in a single parameter slot, Postgres plans it once, and the query uses an index seek per element. No string concatenation, no parameter fanout, no prepared-statement cache explosion from varying parameter counts.

Worked example. You are told to implement "batch get users by id list" after a peer flagged the naive version as N+1. The failing version runs `SELECT ... WHERE id = $1` in a loop. The passing version is:

```go
func GetUsers(ctx context.Context, pool *pgxpool.Pool, ids []int64) ([]User, error) {
    rows, err := pool.Query(ctx,
        `SELECT id, name, email FROM users WHERE id = ANY($1)`, ids)
    if err != nil { return nil, err }
    defer rows.Close()
    return pgx.CollectRows(rows, pgx.RowToStructByName[User])
}
```

This is one query, one round trip, one plan. The pattern extends to overlaps (`&&`), containment (`@>`), and `<@` for your tag and permission style lookups.

Prerequisite gaps to close. Array literals in Postgres are `'{a,b,c}'` in text form and `ARRAY['a','b','c']` in constructor form. Indexes are 1-based. `array_length(arr, 1)` returns the length of the first dimension. `unnest(arr)` explodes an array into rows, and `SELECT unnest(tags) AS tag, count(*) FROM posts GROUP BY tag` is the canonical "tag frequency" query without a join table. Know these before you try to use GIN.

Interview entry-point. What is the difference between `tags @> ARRAY['go','postgres']` and `tags && ARRAY['go','postgres']`. The first returns rows where `tags` contains BOTH "go" AND "postgres". The second returns rows where `tags` contains EITHER. Both are GIN-indexable with `array_ops`. A junior who mixes these up ships a bug that looks like a feature regression ("why are we showing posts that are only tagged `go`?") and gets paged.

Trap. `ANY(ARRAY[...])` is semantically equivalent to `IN (...)` for equality but does not always produce the same plan. For small constant lists Postgres converts `IN` to `ANY` internally. For dynamic parameterized lists with pgx, always use `= ANY($1)`. Never try to build `IN ($1, $2, $3, ...)` dynamically with `fmt.Sprintf` or string concatenation, both because it is vulnerable to injection if the list items are user-controlled and because it blows up the prepared-statement cache.

### Senior @ FAANG: The Arrays vs 1NF Debate, GIN Economics, and When Arrays Are Wrong

The arrays-vs-normalized debate is older than JSONB and the answer depends on three axes: selectivity, mutation rate, and cross-row analytics. Arrays win for (a) small fixed-size collections where the whole array is read together on every access, (b) append-only or rarely-mutated sets, and (c) workloads where queries are primarily membership tests on known elements. Arrays lose when (a) you need a unique constraint per element, (b) you need per-element attributes (created-at, score, source), (c) analytics queries group by element across rows at scale, or (d) elements are mutated independently.

The 1NF purist objection. "Repeating groups violate first normal form." This is technically correct and practically irrelevant in 2026. Postgres arrays are a well-supported typed composite and work with GIN indexes and the array operators. The reviewer objection that survives is not about normalization theology but about concrete failure modes: can you uniquely constrain elements (no, not natively), can you maintain per-element metadata (no), can you enforce a referential foreign key per element (no, array-element foreign keys have been a proposed patch for years but are not in core Postgres), can you do a large IN-scan with index support (yes, via GIN with `array_ops`).

GIN index economics for arrays. `CREATE INDEX ... USING GIN (tags)` with the default `array_ops` operator class supports `@>`, `&&`, `<@`, and `=`. Index size scales with the number of distinct elements across the table, not total element occurrences. On a 10M row table with an average of 5 tags per row and 10,000 distinct tags, expect roughly 150 to 250MB of index. Query latency for `@>` and `&&` is sub-millisecond on cold cache for indexes that fit in memory. The pathology to watch is pending-list growth with `fastupdate = on` (default). For read-heavy array indexes, set `fastupdate = off` or run `gin_pending_list_limit` low enough that merges happen frequently. For arrays with very high element cardinality (tens of thousands distinct per row), GIN index size can exceed the base table and the query plan still prefers a sequential scan. At that point you are past the crossover to a normalized `post_tags` table.

Binary protocol details under pgx v5. A `[]int64` parameter is encoded with a single array OID (`_int8` = 1016), a one-dimensional header, and a packed binary payload. No per-element quoting, no text parsing. For large parameter lists (10K+ elements), the binary array is significantly faster than building an equivalent multi-VALUES or temp-table alternative. The ceiling to be aware of is the 1GB Postgres protocol message size and the implicit work_mem usage on the planner side. For lists over roughly 100K elements, build a temp table from a `CopyFrom` and join instead.

Staff pattern: the "array parameter or temp table" decision. Under roughly 10K elements, pass an array with `= ANY($1)`. From 10K to 1M elements, build an unlogged temp table via `CopyFrom` and join. Over 1M elements, the query is doing a bulk scan and the array question is a distraction. Know the thresholds for your workload and document them in the team's query guidelines.

Array normalization reversal triggers. Move from array to a join table when any one of these hits: (a) you need a unique constraint on elements across rows, (b) you need per-element attributes added, (c) analytics queries against element frequency exceed 5 percent of total query time in `pg_stat_statements`, (d) GIN index size exceeds 30 percent of the base table size, or (e) writes to the array column exceed 100 per second per row. Write these in the ADR when you introduce the array column.

Common mistakes. First, assuming `ANY(array)` is always indexable. It is only indexable via GIN and only for the operators GIN supports. A plain `= ANY(...)` on an unindexed array will seq-scan. Second, using arrays for ordered lists and relying on array order as a semantic (e.g., "user's top 3 choices in ranking order"). This works but is fragile because `array_append`, `array_prepend`, and `||` all produce new arrays and common ORM mutations quietly reorder. If ordering is semantic, an ordered join table with a `position` column is safer. Third, using arrays of composite types (records) to dodge a join table. This is syntactically legal, indexable only via expression GIN with pain, and almost always a sign that JSONB or a normalized table would serve you better.

Hybrid pattern with JSONB. When element metadata is genuinely open-ended, consider a JSONB array `items JSONB` rather than `items text[]` or a separate table. This lets each element carry its own attributes and indexes well with `jsonb_path_ops` containment. The tradeoff is losing per-element type safety, so validate with JSON Schema.

Staff ADR items for any new array column. Required: (1) expected cardinality distribution, (2) expected mutation rate per row, (3) index choice (GIN `array_ops`, GIN with a custom operator class, or no index), (4) reversal triggers to normalize, (5) schema validation if element type is not primitive.

---
