## 52E.2 Data Isolation Models

### Shared Table (Row-Level Tenant ID)

In the shared-table model, every tenant's data lives in the same tables. A `tenant_id` column on each row identifies which tenant owns that record. The schema below shows a typical setup with an `organizations` table as the tenant registry and a `projects` table that references it via foreign key:

```sql
CREATE TABLE organizations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text UNIQUE NOT NULL,
    name       text NOT NULL,
    plan       text NOT NULL DEFAULT 'free',
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Every tenant-scoped table has tenant_id
CREATE TABLE projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Critical: index on tenant_id on every shared table
CREATE INDEX idx_projects_tenant ON projects (tenant_id);
CREATE INDEX idx_projects_tenant_created ON projects (tenant_id, created_at DESC);
```

**Pros**:
- Simplest schema (no schema proliferation)
- Easy cross-tenant analytics (admin queries without UNION ALL)
- Lowest operational overhead

**Cons**:
- Tenant data leakage if `tenant_id` filter is forgotten in any query
- Noisy neighbor: one tenant's large query affects all tenants
- Cannot scale individual tenants independently
- Compliance/audit harder to demonstrate isolation

**When to use**: Your primary model. Default choice for 90% of SaaS applications. Add PostgreSQL Row-Level Security (see section 52E.9) to make isolation enforcement automatic.

### Shared Database, Separate Schema

In this model, each tenant gets their own PostgreSQL schema within a shared database. Tables are duplicated per schema, so `tenant_abc.projects` and `tenant_xyz.projects` are physically separate tables. This eliminates the need for a `tenant_id` column but requires the application to set the correct `search_path` on every database connection:

```sql
-- Schema per tenant: tenant_abc, tenant_xyz
CREATE SCHEMA tenant_abc;
CREATE SCHEMA tenant_xyz;

-- Tables created in each schema
CREATE TABLE tenant_abc.projects (LIKE public.projects INCLUDING ALL);
CREATE TABLE tenant_xyz.projects (LIKE public.projects INCLUDING ALL);

-- Tenant_id column not needed: the schema IS the isolation
-- But search_path must be set correctly for every connection
```

Every query must run in the correct schema context. The `withTenantSchema` method acquires a connection, sets the `search_path` to the tenant's schema, and returns a cleanup function. This ensures all subsequent queries on that connection target the right schema:

```go
func (r *ProjectRepo) withTenantSchema(ctx context.Context, tenantSlug string) (*pgxpool.Conn, func(), error) {
    conn, err := r.pool.Acquire(ctx)
    if err != nil {
        return nil, nil, err
    }

    schemaName := "tenant_" + sanitizeSlug(tenantSlug)
    _, err = conn.Exec(ctx, fmt.Sprintf("SET search_path TO %s, public", schemaName))
    if err != nil {
        conn.Release()
        return nil, nil, fmt.Errorf("setting search_path: %w", err)
    }

    return conn, conn.Release, nil
}

func (r *ProjectRepo) ListProjects(ctx context.Context, tenantSlug string) ([]Project, error) {
    conn, release, err := r.withTenantSchema(ctx, tenantSlug)
    if err != nil {
        return nil, err
    }
    defer release()

    rows, err := conn.Query(ctx, `SELECT id, name, description, created_at FROM projects`)
    // ... handle rows
}
```

Schema-per-tenant introduces a migration challenge: every schema change must run against every tenant schema. A single `ALTER TABLE ADD COLUMN` becomes N operations, one per tenant. The function below iterates all tenants and applies migrations to each schema in sequence:

```go
func RunMigrationsForAllTenants(ctx context.Context, db *pgxpool.Pool) error {
    tenants, err := listAllTenants(ctx, db)
    if err != nil {
        return err
    }

    for _, tenant := range tenants {
        schemaName := "tenant_" + tenant.Slug
        if err := runMigrationsForSchema(ctx, db, schemaName); err != nil {
            return fmt.Errorf("migrating schema %s: %w", schemaName, err)
        }
        slog.Info("migrated tenant schema", "schema", schemaName)
    }

    return nil
}
```

**Pros**: Schema-level isolation (easier compliance story), can drop entire schema for offboarding.
**Cons**: Schema proliferation at scale (thousands of schemas = complexity), migrations touch every schema, PostgreSQL has limits on objects per database.

### Separate Database per Tenant

Each tenant gets their own PostgreSQL database, possibly on the same server cluster or on dedicated hardware for high-value customers. The application needs a router that maps tenant identifiers to connection pools. The implementation below uses a double-checked locking pattern to lazily initialize pools on first access:

```go
// TenantDatabaseRouter routes to the correct database
type TenantDatabaseRouter struct {
    configs map[string]*TenantDBConfig  // tenantSlug → db config
    pools   map[string]*pgxpool.Pool
    mu      sync.RWMutex
    loader  TenantConfigLoader
}

type TenantDBConfig struct {
    Host     string
    Port     int
    Database string
    User     string
    Password string
    MaxConns int32
}

func (r *TenantDatabaseRouter) GetPool(ctx context.Context, tenantSlug string) (*pgxpool.Pool, error) {
    r.mu.RLock()
    pool, ok := r.pools[tenantSlug]
    r.mu.RUnlock()

    if ok {
        return pool, nil
    }

    // Load config and create pool
    r.mu.Lock()
    defer r.mu.Unlock()

    // Double-check after acquiring write lock
    if pool, ok = r.pools[tenantSlug]; ok {
        return pool, nil
    }

    config, err := r.loader.Load(ctx, tenantSlug)
    if err != nil {
        return nil, fmt.Errorf("loading config for tenant %s: %w", tenantSlug, err)
    }

    connStr := fmt.Sprintf(
        "host=%s port=%d dbname=%s user=%s password=%s pool_max_conns=%d",
        config.Host, config.Port, config.Database, config.User, config.Password, config.MaxConns,
    )

    poolConfig, err := pgxpool.ParseConfig(connStr)
    if err != nil {
        return nil, err
    }

    pool, err = pgxpool.NewWithConfig(ctx, poolConfig)
    if err != nil {
        return nil, err
    }

    r.pools[tenantSlug] = pool
    return pool, nil
}
```

**Pros**: True database-level isolation, can place tenants on different servers, independent backups, simple compliance demonstration.
**Cons**: High operational overhead (hundreds of databases to manage), connection count explodes (each tenant needs a connection pool), migrations must run per database.

### Hybrid: Shared by Default, Isolated for Enterprise

Most production SaaS systems use a hybrid approach: free and pro tenants share tables, while enterprise customers get schema-level or database-level isolation. The `DataAccessLayer` below routes queries to the correct backend based on the tenant's isolation tier, keeping this routing transparent to the business logic above it:

```go
type TenantIsolationTier string

const (
    IsolationShared   TenantIsolationTier = "shared"    // shared table
    IsolationSchema   TenantIsolationTier = "schema"    // separate schema
    IsolationDatabase TenantIsolationTier = "database"  // separate database
)

type TenantContext struct {
    ID             uuid.UUID
    Slug           string
    IsolationTier  TenantIsolationTier
    DatabaseConfig *TenantDBConfig  // nil for shared
    SchemaName     string           // empty for shared
}

// DataAccessLayer routes to the right isolation model
type DataAccessLayer struct {
    sharedPool *pgxpool.Pool
    dbRouter   *TenantDatabaseRouter
}

func (d *DataAccessLayer) GetConnection(ctx context.Context) (*pgxpool.Pool, string, error) {
    tenant := GetTenantContext(ctx)

    switch tenant.IsolationTier {
    case IsolationDatabase:
        pool, err := d.dbRouter.GetPool(ctx, tenant.Slug)
        return pool, "public", err
    case IsolationSchema:
        return d.sharedPool, tenant.SchemaName, nil
    default:
        return d.sharedPool, "public", nil
    }
}
```

### Junior → FAANG: Choosing and Defending an Isolation Model

Interviewers at FAANG expect you to do more than describe these three models. They want you to reason through a scenario and commit to a choice with a defensible trade-off analysis.

Common junior mistakes in interviews:

- Saying "separate database per tenant" is the right answer for all enterprise customers without acknowledging the connection-pool explosion. Each `pgxpool.Pool` holds idle connections even when the tenant is inactive. At a hundred silo tenants, connection pressure on the database server becomes the binding constraint.
- Proposing schema-per-tenant as a scalable default. PostgreSQL system catalogs experience measurable degradation above roughly ten thousand schemas in a single database. `pg_dump` time, DDL lock contention, and `information_schema` query performance all worsen.
- Underestimating migration complexity in the silo and schema models. The `RunMigrationsForAllTenants` function above looks simple, but if it fails halfway through, you have a split-brain: some schemas are on version N+1 and some are on version N. The migration runner must be idempotent and resumable.

Worked interview example: "A startup has 5,000 free tenants and just signed their first enterprise deal. The enterprise customer requires their data to be on a separate database. How do you implement this without rewriting the app?"

Answer: the bridge model with a `DataAccessLayer` that reads `IsolationTier` from the tenant context. Free tenants stay on the shared pool. The enterprise tenant gets a dedicated `pgxpool.Pool` via `TenantDatabaseRouter`. The repository interfaces are unchanged. The DAL's `GetConnection` method is the only place that knows about the distinction. Provisioning creates the enterprise database, runs migrations, and sets `isolation_tier = 'database'` in the tenant record.

First-job habits:

- When writing a new migration, test it against the migration runner for all isolation models in CI. A migration that works on shared tables must also work when applied schema-by-schema and database-by-database.
- Add an integration test that provisions a tenant with each isolation tier and verifies that a basic query returns correct results and no cross-tenant data.

### Senior @ FAANG: Connection Pool Economics and Migration Orchestration

The data isolation models described in this section each carry a cost structure that scales differently. Staff-level thinking requires you to model these costs precisely and make the trade-offs visible to the business.

**Connection pool economics:**

In PostgreSQL, every active connection consumes roughly 5-10 MB of memory on the server side plus a backend process. A shared pool model with one `pgxpool.Pool` and `MaxConns=50` is straightforward. The silo model breaks this constraint.

With fifty enterprise tenants, each holding a `pgxpool.Pool` with `MinConns=2`, you have one hundred persistent idle connections before any request arrives. At five hundred tenants, you have a thousand idle connections. PostgreSQL's default `max_connections=100` is exhausted before you hit fifty silo tenants. The solution requires one of:

- PgBouncer in transaction-pooling mode as a connection multiplexer, with the application pools sized to PgBouncer frontend slots, not to Postgres backends.
- Per-tenant lazy pool initialization with idle connection timeout and pool eviction when a tenant has been inactive for N minutes.
- A shared connection pool for small silo tenants (those below a usage threshold) with per-tenant credential rotation via `SET ROLE`, combined with dedicated pools only for high-usage enterprise tenants.

This is the kind of operational detail that separates a design that works in a demo from one that works in production.

**Migration orchestration for multi-model systems:**

The `RunMigrationsForAllTenants` function has several failure modes that must be handled:

- Partial failure: migration succeeds for tenants 1 through 47, then fails on tenant 48. The runner must record per-tenant migration state so the next run skips already-migrated tenants and retries only the failed ones. A `tenant_schema_versions` table in the shared database serves this purpose.
- Long-running migrations: an `ALTER TABLE` that rewrites rows on a tenant with fifty million records can take an hour. The migration runner must not hold the application deployment hostage. Use the expand/contract pattern: add columns as nullable (no rewrite), backfill in batches, enforce non-null in a second migration after backfill completes.
- Concurrent migration and traffic: schema migrations on a shared database run while requests are in flight. Lock contention between a migration DDL and a live query can cause request timeouts. Use `LOCK_TIMEOUT` and retry logic in migrations, not unbounded `ALTER TABLE` commands.

**Governance decision: who owns silo database provisioning?**

In a platform model, silo database provisioning should be automated and owned by the platform team, not the product team. The product team declares `isolation_tier = 'database'` in the tenant onboarding config. The platform's provisioning service reads this, creates the database in the correct region, runs the migration pipeline, validates the schema version, and sets the connection config in a secrets store that `TenantDatabaseRouter` reads at runtime.

This separation of concerns is the L7 design: product engineers never touch database credentials or connection strings. The platform enforces the isolation contract. Audit evidence is generated by the provisioning service, not by manual steps in a runbook.

---
