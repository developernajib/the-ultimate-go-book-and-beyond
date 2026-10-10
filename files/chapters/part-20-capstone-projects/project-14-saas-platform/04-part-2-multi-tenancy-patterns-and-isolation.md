## Part 2: Multi-Tenancy Patterns and Isolation

Multi-tenancy means that many customers share the same application infrastructure, but each customer's data must remain completely invisible to every other customer. Getting isolation wrong is not just a bug. It is a security breach that can destroy trust and violate regulations. This section covers three critical layers of tenant isolation: propagating tenant identity through Go's `context.Context`, enforcing tenant boundaries in HTTP middleware, and partitioning data at the database level using strategies ranging from shared schemas with row-level security to fully separate databases.

### Tenant Context
In a multi-tenant application, every operation needs to know which tenant it is acting on behalf of. Go's `context.Context` is the natural place to carry this information, because it flows automatically through your entire call chain, from HTTP handlers down to database queries. The code below defines helper functions to store and retrieve tenant information from the context. Once the tenant is set in the context (typically by middleware), every downstream function can access it without needing extra parameters.

```go
// internal/isolation/context.go
package isolation

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/yourorg/tenantflow/internal/tenant"
)

type contextKey string

const tenantContextKey contextKey = "tenant_context"

var (
	ErrTenantNotFound = errors.New("tenant not found in context")
)

// TenantContext holds tenant metadata stored in request context
type TenantContext struct {
	TenantID          uuid.UUID
	Slug              string
	Subdomain         string
	PlanID            uuid.UUID
	Features          tenant.FeatureFlags
	IsolationStrategy string
	DatabaseName      string
}

// WithTenant injects TenantContext into context
func WithTenant(ctx context.Context, tc *TenantContext) context.Context {
	return context.WithValue(ctx, tenantContextKey, tc)
}

// FromContext extracts TenantContext from context
func FromContext(ctx context.Context) (*TenantContext, bool) {
	tc, ok := ctx.Value(tenantContextKey).(*TenantContext)
	return tc, ok
}

// TenantID extracts the tenant UUID from context
func TenantID(ctx context.Context) (uuid.UUID, error) {
	tc, ok := FromContext(ctx)
	if !ok || tc == nil {
		return uuid.Nil, ErrTenantNotFound
	}
	return tc.TenantID, nil
}
```

### Tenant Middleware

Middleware is where tenant identification actually happens for every incoming HTTP request. The middleware inspects the request to figure out which tenant is making the call, typically by looking at a custom header, a subdomain, or a JWT claim. Once identified, it loads the tenant from the database, verifies the tenant is in an active state, and injects the tenant into the request context so all downstream handlers can use it. If the tenant cannot be identified or is suspended, the request is rejected immediately.

```go
// internal/isolation/middleware.go
package isolation

import (
    "context"
    "net/http"
    "strings"

    "github.com/google/uuid"
    "github.com/yourorg/tenantflow/internal/tenant"
    "github.com/yourorg/tenantflow/pkg/logger"
)

// TenantResolver is an interface for resolving tenant from HTTP requests
type TenantResolver interface {
    Resolve(r *http.Request) (*TenantContext, error)
}

// TenantMiddleware extracts tenant context from the request
type TenantMiddleware struct {
    resolver      TenantResolver
    tenantService tenant.Service
    logger        logger.Logger
}

func NewTenantMiddleware(resolver TenantResolver, tenantService tenant.Service, logger logger.Logger) *TenantMiddleware {
    return &TenantMiddleware{
        resolver:      resolver,
        tenantService: tenantService,
        logger:        logger,
    }
}

func (m *TenantMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Resolve tenant from request
        tenantCtx, err := m.resolver.Resolve(r)
        if err != nil {
            m.logger.Error("failed to resolve tenant", "error", err, "path", r.URL.Path)
            http.Error(w, "Tenant not found", http.StatusNotFound)
            return
        }

        // Validate tenant status
        t, err := m.tenantService.GetByID(ctx, tenantCtx.TenantID)
        if err != nil {
            m.logger.Error("failed to get tenant", "error", err, "tenant_id", tenantCtx.TenantID)
            http.Error(w, "Internal server error", http.StatusInternalServerError)
            return
        }

        if t.Status != tenant.TenantStatusActive {
            m.logger.Warn("inactive tenant attempted access", "tenant_id", t.ID, "status", t.Status)
            http.Error(w, "Tenant is not active", http.StatusForbidden)
            return
        }

        // Populate full tenant context
        tenantCtx.PlanID = t.PlanID
        tenantCtx.Features = t.Features
        tenantCtx.IsolationStrategy = string(t.IsolationStrategy)

        if t.DatabaseName != nil {
            tenantCtx.DatabaseName = *t.DatabaseName
        }

        // Add tenant context to request
        ctx = WithTenant(ctx, tenantCtx)

        m.logger.Debug("tenant resolved", "tenant_id", tenantCtx.TenantID, "subdomain", tenantCtx.Subdomain)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// SubdomainResolver resolves tenant from subdomain
type SubdomainResolver struct {
    tenantRepo tenant.Repository
    baseDomain string // e.g., "tenantflow.io"
}

func NewSubdomainResolver(tenantRepo tenant.Repository, baseDomain string) *SubdomainResolver {
    return &SubdomainResolver{
        tenantRepo: tenantRepo,
        baseDomain: baseDomain,
    }
}

func (r *SubdomainResolver) Resolve(req *http.Request) (*TenantContext, error) {
    host := req.Host

    // Remove port if present
    if idx := strings.Index(host, ":"); idx != -1 {
        host = host[:idx]
    }

    // Check if custom domain
    if !strings.HasSuffix(host, r.baseDomain) {
        // Look up tenant by custom domain
        t, err := r.tenantRepo.GetByCustomDomain(req.Context(), host)
        if err != nil {
            return nil, fmt.Errorf("tenant not found for custom domain: %s", host)
        }

        return &TenantContext{
            TenantID:     t.ID,
            CustomDomain: host,
            Subdomain:    t.Subdomain,
        }, nil
    }

    // Extract subdomain
    subdomain := strings.TrimSuffix(host, "."+r.baseDomain)
    if subdomain == "" || subdomain == host {
        return nil, fmt.Errorf("invalid subdomain: %s", host)
    }

    // Look up tenant by subdomain
    t, err := r.tenantRepo.GetBySubdomain(req.Context(), subdomain)
    if err != nil {
        return nil, fmt.Errorf("tenant not found for subdomain: %s", subdomain)
    }

    return &TenantContext{
        TenantID:  t.ID,
        Subdomain: subdomain,
    }, nil
}

// HeaderResolver resolves tenant from a custom header
type HeaderResolver struct {
    tenantRepo tenant.Repository
    headerName string // e.g., "X-Tenant-ID"
}

func NewHeaderResolver(tenantRepo tenant.Repository, headerName string) *HeaderResolver {
    return &HeaderResolver{
        tenantRepo: tenantRepo,
        headerName: headerName,
    }
}

func (r *HeaderResolver) Resolve(req *http.Request) (*TenantContext, error) {
    tenantIDStr := req.Header.Get(r.headerName)
    if tenantIDStr == "" {
        return nil, fmt.Errorf("missing %s header", r.headerName)
    }

    tenantID, err := uuid.Parse(tenantIDStr)
    if err != nil {
        return nil, fmt.Errorf("invalid tenant ID: %s", tenantIDStr)
    }

    t, err := r.tenantRepo.GetByID(req.Context(), tenantID)
    if err != nil {
        return nil, fmt.Errorf("tenant not found: %s", tenantID)
    }

    return &TenantContext{
        TenantID:  t.ID,
        Subdomain: t.Subdomain,
    }, nil
}

// CompositeResolver tries multiple resolvers in order
type CompositeResolver struct {
    resolvers []TenantResolver
}

func NewCompositeResolver(resolvers ...TenantResolver) *CompositeResolver {
    return &CompositeResolver{
        resolvers: resolvers,
    }
}

func (r *CompositeResolver) Resolve(req *http.Request) (*TenantContext, error) {
    var lastErr error

    for _, resolver := range r.resolvers {
        tenantCtx, err := resolver.Resolve(req)
        if err == nil {
            return tenantCtx, nil
        }
        lastErr = err
    }

    return nil, fmt.Errorf("all resolvers failed: %w", lastErr)
}
```

### Database Isolation Strategies

Choosing how to isolate tenant data in the database is one of the most important architectural decisions in a SaaS platform. The three main strategies are shared schema (all tenants in the same tables with a `tenant_id` column), separate schema (each tenant gets their own PostgreSQL schema within the same database), and separate database (each tenant gets a completely independent database). Shared schema is cheapest to operate but requires careful discipline to always filter by tenant. Separate databases offer the strongest isolation but are expensive to manage. The code below implements a strategy pattern that lets you support all three approaches and even mix them for different tenants.

```go
// internal/isolation/database.go
package isolation

import (
    "context"
    "database/sql"
    "fmt"
    "sync"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

// DatabaseIsolator provides database-level tenant isolation
type DatabaseIsolator interface {
    // GetConnection returns a database connection for the tenant in context
    GetConnection(ctx context.Context) (*sqlx.DB, error)

    // PrepareQuery modifies a query to include tenant isolation
    PrepareQuery(ctx context.Context, query string) (string, []any, error)

    // Close closes all tenant database connections
    Close() error
}

// SharedSchemaIsolator implements row-level isolation in a shared schema
type SharedSchemaIsolator struct {
    db *sqlx.DB
}

func NewSharedSchemaIsolator(db *sqlx.DB) *SharedSchemaIsolator {
    return &SharedSchemaIsolator{db: db}
}

func (i *SharedSchemaIsolator) GetConnection(ctx context.Context) (*sqlx.DB, error) {
    // Set tenant_id for Row-Level Security
    tenantID, err := TenantID(ctx)
    if err != nil {
        return nil, err
    }

    // PostgreSQL RLS: SET LOCAL app.current_tenant_id = '<tenant_id>'
    _, err = i.db.ExecContext(ctx, "SET LOCAL app.current_tenant_id = $1", tenantID)
    if err != nil {
        return nil, fmt.Errorf("failed to set tenant context: %w", err)
    }

    return i.db, nil
}

func (i *SharedSchemaIsolator) PrepareQuery(ctx context.Context, query string) (string, []any, error) {
    // With RLS enabled, queries are automatically scoped
    // No modification needed
    return query, nil, nil
}

func (i *SharedSchemaIsolator) Close() error {
    return i.db.Close()
}

// SeparateSchemaIsolator implements schema-level isolation
type SeparateSchemaIsolator struct {
    db *sqlx.DB
}

func NewSeparateSchemaIsolator(db *sqlx.DB) *SeparateSchemaIsolator {
    return &SeparateSchemaIsolator{db: db}
}

func (i *SeparateSchemaIsolator) GetConnection(ctx context.Context) (*sqlx.DB, error) {
    tenant, err := GetTenant(ctx)
    if err != nil {
        return nil, err
    }

    schemaName := fmt.Sprintf("tenant_%s", tenant.TenantID.String())

    // Set search_path to tenant's schema
    _, err = i.db.ExecContext(ctx, fmt.Sprintf("SET search_path TO %s", schemaName))
    if err != nil {
        return nil, fmt.Errorf("failed to set schema: %w", err)
    }

    return i.db, nil
}

func (i *SeparateSchemaIsolator) PrepareQuery(ctx context.Context, query string) (string, []any, error) {
    // Queries automatically use the schema set via search_path
    return query, nil, nil
}

func (i *SeparateSchemaIsolator) Close() error {
    return i.db.Close()
}

// SeparateDatabaseIsolator implements database-level isolation
type SeparateDatabaseIsolator struct {
    mu          sync.RWMutex
    connections map[string]*sqlx.DB // tenant_id -> connection
    baseConnStr string
}

func NewSeparateDatabaseIsolator(baseConnStr string) *SeparateDatabaseIsolator {
    return &SeparateDatabaseIsolator{
        connections: make(map[string]*sqlx.DB),
        baseConnStr: baseConnStr,
    }
}

func (i *SeparateDatabaseIsolator) GetConnection(ctx context.Context) (*sqlx.DB, error) {
    tenant, err := GetTenant(ctx)
    if err != nil {
        return nil, err
    }

    tenantIDStr := tenant.TenantID.String()

    // Check if connection already exists
    i.mu.RLock()
    conn, exists := i.connections[tenantIDStr]
    i.mu.RUnlock()

    if exists {
        return conn, nil
    }

    // Create new connection
    i.mu.Lock()
    defer i.mu.Unlock()

    // Double-check after acquiring write lock
    if conn, exists := i.connections[tenantIDStr]; exists {
        return conn, nil
    }

    // Build connection string for tenant database
    dbName := tenant.DatabaseName
    if dbName == "" {
        dbName = fmt.Sprintf("tenant_%s", tenantIDStr)
    }

    connStr := fmt.Sprintf("%s dbname=%s", i.baseConnStr, dbName)

    db, err := sqlx.Connect("postgres", connStr)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to tenant database: %w", err)
    }

    // Configure connection pool
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)

    i.connections[tenantIDStr] = db

    return db, nil
}

func (i *SeparateDatabaseIsolator) PrepareQuery(ctx context.Context, query string) (string, []any, error) {
    // No query modification needed - already using tenant's database
    return query, nil, nil
}

func (i *SeparateDatabaseIsolator) Close() error {
    i.mu.Lock()
    defer i.mu.Unlock()

    var errs []error
    for _, db := range i.connections {
        if err := db.Close(); err != nil {
            errs = append(errs, err)
        }
    }

    if len(errs) > 0 {
        return fmt.Errorf("failed to close %d connections", len(errs))
    }

    return nil
}

// HybridIsolator uses different strategies based on tenant size/plan
type HybridIsolator struct {
    sharedSchema    *SharedSchemaIsolator
    separateDB      *SeparateDatabaseIsolator
    tenantService   TenantService // To check tenant's isolation strategy
}

func NewHybridIsolator(sharedDB *sqlx.DB, baseConnStr string, tenantService TenantService) *HybridIsolator {
    return &HybridIsolator{
        sharedSchema:  NewSharedSchemaIsolator(sharedDB),
        separateDB:    NewSeparateDatabaseIsolator(baseConnStr),
        tenantService: tenantService,
    }
}

func (i *HybridIsolator) GetConnection(ctx context.Context) (*sqlx.DB, error) {
    tenant, err := GetTenant(ctx)
    if err != nil {
        return nil, err
    }

    // Determine isolation strategy for this tenant
    switch tenant.IsolationStrategy {
    case "shared_schema":
        return i.sharedSchema.GetConnection(ctx)
    case "separate_database":
        return i.separateDB.GetConnection(ctx)
    default:
        return i.sharedSchema.GetConnection(ctx)
    }
}

func (i *HybridIsolator) PrepareQuery(ctx context.Context, query string) (string, []any, error) {
    tenant, err := GetTenant(ctx)
    if err != nil {
        return "", nil, err
    }

    switch tenant.IsolationStrategy {
    case "shared_schema":
        return i.sharedSchema.PrepareQuery(ctx, query)
    case "separate_database":
        return i.separateDB.PrepareQuery(ctx, query)
    default:
        return i.sharedSchema.PrepareQuery(ctx, query)
    }
}

func (i *HybridIsolator) Close() error {
    if err := i.sharedSchema.Close(); err != nil {
        return err
    }
    return i.separateDB.Close()
}
```

### Row-Level Security Setup

Row-Level Security (RLS) is a PostgreSQL feature that acts as a safety net for shared-schema multi-tenancy. Even if your application code forgets to include a `WHERE tenant_id = ?` clause, RLS policies at the database level will prevent one tenant from seeing another tenant's data. Think of it as a second layer of defense: your application filters by tenant, and the database enforces it independently. The SQL migration below enables RLS on all tenant-scoped tables and creates policies that restrict each database role to only the rows belonging to its tenant.

```sql
-- migrations/shared/001_row_level_security.sql

-- Enable RLS on all tenant tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Create policies for tenant isolation:
-- each role sees only the rows belonging to its tenant
CREATE POLICY tenant_isolation_policy ON users
    FOR ALL USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_policy ON sessions
    FOR ALL USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_policy ON subscriptions
    FOR ALL USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_policy ON usage_records
    FOR ALL USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_policy ON invoices
    FOR ALL USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Create a function to set tenant context
CREATE OR REPLACE FUNCTION set_tenant_id(tenant_uuid UUID)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id', tenant_uuid::text, false);
END;
$$ LANGUAGE plpgsql;

-- Create indexes on tenant_id for performance
CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_sessions_tenant_id ON sessions(tenant_id);
CREATE INDEX idx_subscriptions_tenant_id ON subscriptions(tenant_id);
CREATE INDEX idx_usage_records_tenant_id ON usage_records(tenant_id);
CREATE INDEX idx_invoices_tenant_id ON invoices(tenant_id);
```
