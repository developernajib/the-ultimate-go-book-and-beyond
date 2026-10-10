## 52E.3 Implementing Tenant Context in Go

### Tenant ID in Context

The tenant context flows from the HTTP request through every layer of the application. Define a `TenantContext` struct that carries the tenant's identity, plan, feature flags, and resource limits. Store it in `context.Context` using an unexported key type to prevent collisions with other packages:

```go
package tenant

import (
    "context"
    "github.com/google/uuid"
)

type contextKey string

const tenantContextKey contextKey = "tenant"

// TenantContext carries all tenant-specific information
type TenantContext struct {
    ID              uuid.UUID
    Slug            string
    Plan            string
    IsolationTier   string
    Features        map[string]bool
    Limits          TenantLimits
    IsActive        bool
}

type TenantLimits struct {
    MaxProjects   int
    MaxUsers      int
    MaxAPIReqMin  int
    StorageGB     int
}

func WithTenant(ctx context.Context, t *TenantContext) context.Context {
    return context.WithValue(ctx, tenantContextKey, t)
}

func FromContext(ctx context.Context) (*TenantContext, bool) {
    t, ok := ctx.Value(tenantContextKey).(*TenantContext)
    return t, ok && t != nil
}

// MustFromContext panics if tenant is not in context - use in internal code where
// the middleware guarantees tenant context is present
func MustFromContext(ctx context.Context) *TenantContext {
    t, ok := FromContext(ctx)
    if !ok {
        panic("tenant context not found: ensure TenantMiddleware is applied")
    }
    return t
}
```

### Middleware for Tenant Extraction

HTTP middleware extracts the tenant identifier from incoming requests and populates the context before the request reaches any handler. The two most common extraction strategies are subdomain-based (for user-facing applications) and JWT-claim-based (for authenticated API calls). Both resolve the tenant slug or ID against a `TenantResolver` interface, which abstracts the database lookup and allows caching.

```go
package middleware

import (
    "net/http"
    "strings"

    "github.com/yourorg/app/internal/tenant"
    "github.com/yourorg/app/internal/apierror"
)

type TenantResolver interface {
    ResolveBySlug(ctx context.Context, slug string) (*tenant.TenantContext, error)
    ResolveByID(ctx context.Context, id uuid.UUID) (*tenant.TenantContext, error)
    ResolveByJWTClaim(ctx context.Context, tenantID string) (*tenant.TenantContext, error)
}

// SubdomainTenantMiddleware extracts tenant from subdomain: acme.app.com → "acme"
func SubdomainTenantMiddleware(resolver TenantResolver, baseDomain string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            host := r.Host
            // Strip port if present
            if before, _, ok := strings.CutLast(host, ":"); ok {
                host = before
            }

            // Extract subdomain: acme.app.com → "acme"
            suffix := "." + baseDomain
            if !strings.HasSuffix(host, suffix) {
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusBadRequest,
                    Title:  "Invalid Host",
                    Detail: "Request must be made to a valid tenant subdomain.",
                })
                return
            }

            slug := strings.TrimSuffix(host, suffix)
            if slug == "" || strings.Contains(slug, ".") {
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusNotFound,
                    Title:  "Tenant Not Found",
                })
                return
            }

            tenantCtx, err := resolver.ResolveBySlug(r.Context(), slug)
            if err != nil {
                if errors.Is(err, tenant.ErrNotFound) {
                    apierror.Write(w, r, &apierror.ProblemDetail{
                        Status: http.StatusNotFound,
                        Title:  "Tenant Not Found",
                        Detail: fmt.Sprintf("No tenant with slug %q exists.", slug),
                    })
                    return
                }
                apierror.Write(w, r, apierror.InternalError())
                return
            }

            if !tenantCtx.IsActive {
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusForbidden,
                    Title:  "Tenant Suspended",
                    Detail: "This organization's account has been suspended. Contact support.",
                })
                return
            }

            ctx := tenant.WithTenant(r.Context(), tenantCtx)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// JWTTenantMiddleware extracts tenant from JWT claim
func JWTTenantMiddleware(resolver TenantResolver) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            claims := GetJWTClaims(r.Context())  // set by JWT auth middleware
            if claims == nil {
                apierror.Write(w, r, apierror.Unauthorized())
                return
            }

            tenantID := claims.TenantID
            if tenantID == "" {
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusBadRequest,
                    Title:  "Missing Tenant",
                    Detail: "JWT token does not contain a tenant_id claim.",
                })
                return
            }

            tenantCtx, err := resolver.ResolveByJWTClaim(r.Context(), tenantID)
            if err != nil {
                apierror.Write(w, r, apierror.InternalError())
                return
            }

            ctx := tenant.WithTenant(r.Context(), tenantCtx)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Database Query Scoping: Automatic Tenant ID Injection

The riskiest pattern in a shared-table multi-tenant system is forgetting to add `WHERE tenant_id = $1`. The defense: wrap the database layer so that `tenant_id` is always injected automatically:

```go
package db

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/yourorg/app/internal/tenant"
)

// TenantScopedDB wraps pgxpool.Pool with automatic tenant_id injection
type TenantScopedDB struct {
    pool *pgxpool.Pool
}

// ScopedQuery wraps a query and automatically adds tenant_id as the first argument
// The query must use $tenant as a placeholder which will be replaced with the actual tenant_id
type TenantQuery struct {
    SQL    string
    Args   []any
    tenant *tenant.TenantContext
}

// Exec executes a query scoped to the current tenant
func (d *TenantScopedDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
    t := tenant.MustFromContext(ctx)

    // Prepend tenant_id to args and replace $tenant placeholder
    scopedSQL := strings.ReplaceAll(sql, "$tenant_id", fmt.Sprintf("$%d", len(args)+1))
    args = append(args, t.ID)

    return d.pool.Exec(ctx, scopedSQL, args...)
}

// Usage: queries use $tenant_id which gets automatically replaced
// SELECT * FROM projects WHERE id = $1 AND tenant_id = $tenant_id
// Becomes: SELECT * FROM projects WHERE id = $1 AND tenant_id = $2
// With args: [projectID, tenantID]
```

An alternative approach avoids the placeholder replacement by reading the tenant ID from context inside each query method. This is more explicit and works well with tools like sqlc:

```go
// Use a context-aware query wrapper
type TenantQuerier struct {
    pool *pgxpool.Pool
}

func (q *TenantQuerier) ListProjects(ctx context.Context) ([]Project, error) {
    t := tenant.MustFromContext(ctx)

    rows, err := q.pool.Query(ctx, `
        SELECT id, name, description, created_at, updated_at
        FROM projects
        WHERE tenant_id = $1
        ORDER BY created_at DESC
    `, t.ID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    return pgx.CollectRows(rows, pgx.RowToStructByName[Project])
}

func (q *TenantQuerier) GetProject(ctx context.Context, projectID uuid.UUID) (*Project, error) {
    t := tenant.MustFromContext(ctx)

    // ALWAYS include tenant_id - even when looking up by primary key
    // This prevents a user from one tenant accessing another tenant's data
    // even if they somehow obtain the correct UUID
    row, err := q.pool.Query(ctx, `
        SELECT id, name, description, created_at, updated_at
        FROM projects
        WHERE id = $1 AND tenant_id = $2
    `, projectID, t.ID)
    if err != nil {
        return nil, err
    }
    defer row.Close()

    project, err := pgx.CollectExactlyOneRow(row, pgx.RowToStructByName[Project])
    if errors.Is(err, pgx.ErrNoRows) {
        return nil, tenant.ErrNotFound
    }
    return &project, err
}
```

### Junior → FAANG: Context Propagation as a Security Invariant

The patterns in this section are not optional conveniences. They are security invariants. Missing tenant context in a request that reaches a database query means you either panic (with `MustFromContext`) or silently query without a tenant filter. The second outcome is a data breach. FAANG interviewers probe this understanding directly.

Common junior gaps:

- Using `context.Background()` in middleware or helper functions instead of threading the request context through. Any goroutine that drops the incoming context loses the tenant identity and any downstream queries become unscoped.
- Trusting tenant identity from the request body. The tenant must come from the authenticated session, not from a field the client provides. The middleware examples above resolve tenant from the subdomain or JWT claim, both of which the server controls.
- Confusing `context.WithValue` keys: using a string literal like `"tenant"` instead of an unexported struct type allows any other package to accidentally overwrite the value with the same string key.

Worked example for interviews: "How do you ensure every database query in your application is scoped to the correct tenant?"

Answer structure: three layers. First, HTTP middleware extracts and verifies the tenant, storing `TenantContext` in the context using an unexported key type. Second, repository methods call `tenant.MustFromContext` at the top, which panics if context is absent. Third, PostgreSQL RLS provides the database-level enforcement as a catch for any query that somehow bypasses the application filter. Each layer assumes the others might fail.

First-job habits:

- Add a Go vet or staticcheck lint rule that flags any call to a repository method with `context.Background()` in non-test code. This is a zero-cost invariant enforcement.
- In every service you own, write a test that calls a repository method with an empty context and asserts that it panics. This documents the expected behavior and prevents future engineers from accidentally removing the `MustFromContext` call.

### Senior @ FAANG: Context Propagation Across Async Boundaries

The synchronous HTTP request path is the easy case. The senior-level challenge is propagating tenant context reliably across every async boundary in the system: message queues, background workers, gRPC streams, WebSocket connections, and scheduled jobs.

**Kafka/message queue pattern:**

When a request publishes a message to Kafka, the tenant context must travel with the message. The canonical approach embeds the tenant ID in the message header (not the payload), so it is available to any consumer without deserializing the business payload:

```go
// Producer side: embed tenant in message headers
func (p *EventPublisher) Publish(ctx context.Context, topic string, event any) error {
    t := tenant.MustFromContext(ctx)
    payload, _ := json.Marshal(event)
    return p.writer.WriteMessages(ctx, kafka.Message{
        Topic: topic,
        Value: payload,
        Headers: []kafka.Header{
            {Key: "tenant_id", Value: []byte(t.ID.String())},
            {Key: "tenant_slug", Value: []byte(t.Slug)},
        },
    })
}

// Consumer side: reconstruct context from message headers
func (c *EventConsumer) handle(msg kafka.Message) error {
    var tenantIDStr string
    for _, h := range msg.Headers {
        if h.Key == "tenant_id" {
            tenantIDStr = string(h.Value)
        }
    }
    tenantID, err := uuid.Parse(tenantIDStr)
    if err != nil {
        return fmt.Errorf("invalid tenant_id in message header: %w", err)
    }
    tenantCtx, err := c.resolver.ResolveByID(context.Background(), tenantID)
    if err != nil {
        return err
    }
    ctx := tenant.WithTenant(context.Background(), tenantCtx)
    return c.processor.Process(ctx, msg.Value)
}
```

Never pass `context.Background()` downstream without reconstructing the tenant context. Never use the publishing goroutine's context in the consumer.

**gRPC propagation:**

For gRPC, use metadata to carry tenant identity. A server interceptor reads the tenant ID from incoming metadata and stores it in the context. An outgoing interceptor on client calls reads it from context and writes it to outgoing metadata.

**Scheduled jobs:**

Cron jobs that process data across all tenants iterate the tenant list explicitly and construct a fresh context per tenant. They never run under a single shared context that implies a single tenant. A background reconciler that runs without a tenant context must use elevated privileges (bypass RLS) with explicit audit logging for every query.

**Staff-level concern: tenant context leakage under goroutine pools:**

Worker pools that reuse goroutines are a common source of tenant context leakage. If a goroutine processes tenant A's job and the worker pool recycles it immediately to tenant B's job without replacing the context, any deferred cleanup that runs against the original context reads tenant A's data in tenant B's request scope. The mitigation is always constructing a fresh context at the start of each job, never inheriting the previous job's context through the goroutine.

**Bar-raiser signal:** A candidate who can trace tenant identity from an HTTP request, through a Kafka message header, into a background worker, and explain the failure mode at each boundary has demonstrated production-system thinking. This is the level of detail that earns L5 and above at FAANG.

---
