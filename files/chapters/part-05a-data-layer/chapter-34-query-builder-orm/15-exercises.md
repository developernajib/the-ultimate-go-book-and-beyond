## Exercises

### Exercise 1: Build a Type-Safe Repository with sqlc

Create a complete user management system using sqlc.

**Solution**:

```yaml
# sqlc.yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "queries/"
    schema: "schema/"
    gen:
      go:
        package: "db"
        out: "internal/db"
        sql_package: "pgx/v5"
        emit_json_tags: true
        emit_prepared_queries: true
        emit_interface: true
```

```sql
-- schema/001_users.sql
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_status ON users(status) WHERE deleted_at IS NULL;
```

```sql
-- queries/users.sql

-- name: CreateUser :one
INSERT INTO users (email, name, password_hash, status, role)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL;

-- name: ListUsersByStatus :many
SELECT * FROM users
WHERE status = $1 AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: UpdateUserLastLogin :exec
UPDATE users SET last_login = NOW() WHERE id = $1;

-- name: UpdateUserPassword :exec
UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1;

-- name: SoftDeleteUser :exec
UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL;

-- name: CountActiveUsers :one
SELECT COUNT(*) FROM users WHERE status = 'active' AND deleted_at IS NULL;

-- name: GetUserStats :one
SELECT
    COUNT(*) FILTER (WHERE status = 'active') as active_count,
    COUNT(*) FILTER (WHERE status = 'inactive') as inactive_count,
    COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '24 hours') as daily_active
FROM users WHERE deleted_at IS NULL;
```

### Exercise 2: Build a Dynamic Search API with squirrel

Create a search endpoint that handles complex filtering.

**Solution**:

```go
package search

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	sq "github.com/Masterminds/squirrel"
)

type SearchFilter struct {
	Query         string     `json:"query"`
	Status        []string   `json:"status"`
	Role          []string   `json:"role"`
	CreatedAfter  *time.Time `json:"created_after"`
	CreatedBefore *time.Time `json:"created_before"`
	HasOrders     *bool      `json:"has_orders"`
	MinSpentCents *int64     `json:"min_spent_cents"`
	Tags          []string   `json:"tags"`
	SortBy        string     `json:"sort_by"`
	SortDir       string     `json:"sort_dir"`
	Page          int        `json:"page"`
	PageSize      int        `json:"page_size"`
}

type SearchResult struct {
	Users      []UserSearchResult `json:"users"`
	Total      int64              `json:"total"`
	Page       int                `json:"page"`
	PageSize   int                `json:"page_size"`
	TotalPages int                `json:"total_pages"`
}

type UserSearchResult struct {
	ID              int64     `json:"id"`
	Email           string    `json:"email"`
	Name            string    `json:"name"`
	Status          string    `json:"status"`
	OrderCount      int       `json:"order_count"`
	TotalSpentCents int64     `json:"total_spent_cents"`
	CreatedAt       time.Time `json:"created_at"`
	Highlight       string    `json:"highlight,omitempty"`
}

type SearchService struct {
	db      *sql.DB
	builder sq.StatementBuilderType
}

func NewSearchService(db *sql.DB) *SearchService {
	return &SearchService{
		db:      db,
		builder: sq.StatementBuilder.PlaceholderFormat(sq.Dollar),
	}
}

func (s *SearchService) SearchUsers(ctx context.Context, filter SearchFilter) (*SearchResult, error) {
	// Base query with aggregations
	baseSelect := s.builder.Select(
		"u.id", "u.email", "u.name", "u.status", "u.created_at",
		"COUNT(o.id) as order_count",
		"COALESCE(SUM(o.total_cents), 0) as total_spent_cents",
	).
		From("users u").
		LeftJoin("orders o ON u.id = o.user_id").
		Where("u.deleted_at IS NULL").
		GroupBy("u.id")

	// Apply filters
	if filter.Query != "" {
		baseSelect = baseSelect.Where(sq.Or{
			sq.ILike{"u.name": "%" + filter.Query + "%"},
			sq.ILike{"u.email": "%" + filter.Query + "%"},
		})
	}

	if len(filter.Status) > 0 {
		baseSelect = baseSelect.Where(sq.Eq{"u.status": filter.Status})
	}

	if len(filter.Role) > 0 {
		baseSelect = baseSelect.Where(sq.Eq{"u.role": filter.Role})
	}

	if filter.CreatedAfter != nil {
		baseSelect = baseSelect.Where(sq.GtOrEq{"u.created_at": *filter.CreatedAfter})
	}

	if filter.CreatedBefore != nil {
		baseSelect = baseSelect.Where(sq.Lt{"u.created_at": *filter.CreatedBefore})
	}

	if filter.HasOrders != nil {
		if *filter.HasOrders {
			baseSelect = baseSelect.Having(sq.Gt{"COUNT(o.id)": 0})
		} else {
			baseSelect = baseSelect.Having(sq.Eq{"COUNT(o.id)": 0})
		}
	}

	if filter.MinSpentCents != nil {
		baseSelect = baseSelect.Having(sq.GtOrEq{"COALESCE(SUM(o.total_cents), 0)": *filter.MinSpentCents})
	}

	// Count total (need subquery)
	countSQL, countArgs, err := baseSelect.ToSql()
	if err != nil {
		return nil, fmt.Errorf("building count query: %w", err)
	}

	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM (%s) as subq", countSQL)
	var total int64
	if err := s.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, fmt.Errorf("counting results: %w", err)
	}

	// Apply sorting
	sortBy := s.validateSortColumn(filter.SortBy)
	sortDir := "DESC"
	if filter.SortDir == "asc" {
		sortDir = "ASC"
	}
	baseSelect = baseSelect.OrderBy(fmt.Sprintf("%s %s", sortBy, sortDir))

	// Apply pagination
	pageSize := filter.PageSize
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 20
	}
	page := filter.Page
	if page < 1 {
		page = 1
	}
	offset := (page - 1) * pageSize
	baseSelect = baseSelect.Limit(uint64(pageSize)).Offset(uint64(offset))

	// Execute query
	sql, args, err := baseSelect.ToSql()
	if err != nil {
		return nil, fmt.Errorf("building query: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("executing query: %w", err)
	}
	defer rows.Close()

	var users []UserSearchResult
	for rows.Next() {
		var u UserSearchResult
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Status, &u.CreatedAt, &u.OrderCount, &u.TotalSpentCents); err != nil {
			return nil, fmt.Errorf("scanning result: %w", err)
		}

		// Add search highlight
		if filter.Query != "" {
			u.Highlight = s.highlightMatch(u.Name, filter.Query)
		}

		users = append(users, u)
	}

	totalPages := int(total) / pageSize
	if int(total)%pageSize > 0 {
		totalPages++
	}

	return &SearchResult{
		Users:      users,
		Total:      total,
		Page:       page,
		PageSize:   pageSize,
		TotalPages: totalPages,
	}, nil
}

func (s *SearchService) validateSortColumn(col string) string {
	allowed := map[string]string{
		"name":              "u.name",
		"email":             "u.email",
		"created_at":        "u.created_at",
		"order_count":       "order_count",
		"total_spent_cents": "total_spent_cents",
	}
	if mapped, ok := allowed[col]; ok {
		return mapped
	}
	return "u.created_at"
}

func (s *SearchService) highlightMatch(text, query string) string {
	lower := strings.ToLower(text)
	lowerQuery := strings.ToLower(query)
	idx := strings.Index(lower, lowerQuery)
	if idx == -1 {
		return text
	}
	return text[:idx] + "<mark>" + text[idx:idx+len(query)] + "</mark>" + text[idx+len(query):]
}
```

### Junior -> FAANG: Working the Exercises for Real Learning

The two exercises above are worth your time only if you type them out yourself, run them against a local Postgres, and break them deliberately. Read-only completion teaches nothing. Work the exercises with a failure-first mindset: after each section compiles, introduce one of the five common mistakes from section 34.9 and verify you can diagnose it.

Worked extension for Exercise 1. After the sqlc code compiles, do four things. First, drop the `email` column in the schema file and rerun `sqlc generate`. Observe that the generated code now fails `go build`. That is the compile-time safety this chapter has been selling. Second, add a new query with a nullable column and observe the `pgtype.Text` that recent sqlc versions generate for the pgx/v5 driver. Convince yourself that `pgtype.Text` marshals better than `sql.NullString`. Third, wrap `CreateUser` in a transaction using `queries.WithTx(tx)` and verify that rollback restores the pre-insert state. Fourth, benchmark 10000 calls to `GetUserByID` against the same with `emit_prepared_queries: false` and measure the latency difference on prepared vs ad-hoc statements.

Worked extension for Exercise 2. After the search service runs, do three things. First, pass `sort_by=name; DROP TABLE users--` and verify your whitelist rejects it. If it does not, you wrote the whitelist wrong. Second, create 100000 users and time the `OFFSET 10000 LIMIT 20` query, then replace it with keyset pagination and time it again. You will see a 100x improvement, which is the "why OFFSET breaks at scale" lesson made concrete. Third, wrap the query execution in a `sqlmw` interceptor that counts queries per request and prove the endpoint issues exactly two queries (count plus select) regardless of filter shape.

The "why did this fail?" reflex applied to exercises. When your code does not compile, read the sqlc error first, then the Go error. sqlc errors usually say "column X does not exist" which points at a schema mismatch. When your query returns wrong data, turn on `pgx` tracing and read the actual SQL. When your test is slow, count queries before looking at anything else. These reflexes are built by working exercises, not by reading about them.

Interview entry point. At L3 and L4 interviews you may be asked to sketch Exercise 1 on a whiteboard in 30 minutes. Practice the flow from empty directory to working `GetUserByID` call at least three times before your interview. The sqlc config, the schema file, the query file, the generate command, the pool setup, and the handler wiring should be muscle memory.

### Senior @ FAANG: Staff-Level Exercise Extensions

The exercises above are L3 to L4 material. Staff-level extensions take the same scaffold and add the dimensions that distinguish senior work: cross-cutting concerns, observability, scale, and governance. Each extension below is a one to three week project suitable for a self-directed senior engineer or a scoped deliverable for a tech lead.

Staff extension 1: repository decorator for caching, metrics, and audit. Take the sqlc-generated `Querier` interface from Exercise 1 and wrap it with three composable decorators. The cache decorator reads from Redis with a per-query TTL policy, writes through on mutations, and invalidates related keys via a dependency map maintained in a sidecar. The metrics decorator emits OpenTelemetry spans, records p50 and p99 latency per query name, and exports query counts as Prometheus counters tagged by tenant and query name. The audit decorator writes a row to an append-only audit table inside the same transaction as the mutation, stamped with request id and actor id from context. Success criteria: the decorators compose in any order, no decorator knows about any other, and feature code uses `Querier` without changes. Bonus: benchmark the overhead of the full stack at p99 and prove it is under 5% at 10k RPS.

Staff extension 2: N+1 detection via sqlc query analysis. Build a static analyzer that reads sqlc-generated code, builds a call graph of `Querier` method calls, and flags call sites where a `Find` or `Get` is called inside a range loop over the result of another `Find`. Output a JSON report with file, line, and suggested fix (`IN` query, JOIN, or dataloader). Integrate as a `go vet` shim and a CI step that fails the build when severity is "high." Success criteria: zero false positives on a 100k-line reference codebase, catches 90% of manually planted N+1s in a test corpus, runs in under 10 seconds per thousand files. Ship as an internal tool, then open source if review clears.

Staff extension 3: migrate 50 endpoints from GORM to sqlc. Pick a service with 50 handlers using GORM. Write a migration plan with five phases. Phase 1, introduce sqlc alongside GORM with shared pool and transaction interleave via `tx` passed through context. Phase 2, port read endpoints in order of traffic volume, with shadow-read comparison in production: both paths execute, sqlc result is compared to GORM result byte-for-byte, divergences alert. Phase 3, port mutation endpoints one at a time, with feature flag per endpoint and one-hour bake time. Phase 4, remove GORM from the handler path, keep only in the migration tool. Phase 5, delete GORM from go.mod. Success criteria: zero customer-visible incidents attributable to migration, p99 latency drops or holds, code review latency drops because sqlc queries are easier to review than GORM chains. Write the postmortem as if it succeeded, then as if it failed, and present both to the architecture review board before starting.

Staff extension 4: tenant-isolation test harness for multi-tenant systems. Design and build a test harness that proves tenant isolation holds across the repository layer. Generate 100 synthetic tenants with overlapping data shapes, execute every repository method with a random tenant context, and assert that no method returns data belonging to another tenant. Run the harness in CI on every PR that touches the repository layer or the schema. Extend to mutation methods: assert that an update with tenant A context cannot affect tenant B rows even with crafted predicates. Bonus: add row-level security in Postgres with a policy that references a session variable set by the pool, and prove via the harness that RLS is defense in depth against bugs in the application-layer filter.

Staff extension 5: query plan regression detection at PR time. Build a CI step that captures `EXPLAIN (FORMAT JSON, BUFFERS)` for every sqlc query against a production-representative schema with realistic statistics, diffs the plan against the baseline stored in the repo, and fails the PR when the plan regresses on dimensions that matter: sequential scan introduced where an index scan existed, cost increases by more than 2x, estimated rows change by more than an order of magnitude. Store baselines as generated artifacts reviewed at PR time. Success criteria: every plan regression in the last year of service incidents would have been caught by the tool, false positive rate under 5%, PR feedback latency under 2 minutes.

Governance hooks. For each staff extension, write the ADR that accompanies deployment. The ADR covers: what the tool enforces, who owns it, what the deprecation path is if it is replaced, what the kill criteria are if it fails to pay rent, and what metric proves it is working. ADRs without kill criteria are commitments without exits. Senior engineers write exits into every policy they ship.

Promotion signal. At L5 the exercises build the thing for the candidate's own service. At L6 the candidate ships extension 1 or 2 as a shared library for the platform. At L7 the candidate scopes extensions 3 through 5 as an organizational program, recruits the team, negotiates the timeline with engineering leadership, and owns the outcome. The progression is from individual contribution to organizational capability, and it is legible in the scope of exercise extensions the candidate can credibly claim to have led.

---
