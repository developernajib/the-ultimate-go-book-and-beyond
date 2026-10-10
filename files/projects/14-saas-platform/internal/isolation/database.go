// internal/isolation/database.go
package isolation

import (
    "context"
    "fmt"
    "sync"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

// TenantService is a minimal interface for querying tenant isolation strategy
type TenantService interface {
    GetIsolationStrategy(ctx context.Context, tenantID string) (string, error)
}

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

    db, err := sqlx.Connect("pgx", connStr)
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
