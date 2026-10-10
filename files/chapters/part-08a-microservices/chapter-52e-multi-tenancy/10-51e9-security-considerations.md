## 52E.9 Security Considerations

### Tenant Data Isolation Verification

The most critical test in a multi-tenant system verifies that one tenant cannot access another tenant's data. Write explicit cross-tenant access tests for every repository method, especially direct-ID lookups where a user might guess or obtain another tenant's record UUID:

```go
func TestTenantIsolation(t *testing.T) {
    ctx := context.Background()
    db := testDB(t)

    // Create two tenants
    tenant1 := createTestTenant(t, db, "tenant-one")
    tenant2 := createTestTenant(t, db, "tenant-two")

    // Create a project for tenant1
    ctx1 := tenant.WithTenant(ctx, tenant1)
    project, err := projectRepo.Create(ctx1, CreateProjectParams{Name: "Secret Project"})
    require.NoError(t, err)

    // Tenant2 should NOT be able to access tenant1's project
    ctx2 := tenant.WithTenant(ctx, tenant2)

    // Direct ID lookup (most dangerous path)
    _, err = projectRepo.Get(ctx2, project.ID)
    require.Error(t, err, "tenant2 should not be able to access tenant1's project")
    require.True(t, errors.Is(err, tenant.ErrNotFound))

    // List should not include tenant1's project
    projects, err := projectRepo.List(ctx2)
    require.NoError(t, err)
    for _, p := range projects {
        require.NotEqual(t, project.ID, p.ID, "tenant2's list should not include tenant1's project")
    }
}
```

### PostgreSQL Row-Level Security

Row-Level Security (RLS) makes PostgreSQL enforce tenant isolation at the database level. With RLS enabled, every query is automatically filtered by the tenant ID stored in a session variable, even if the application code omits a `WHERE tenant_id = ...` clause. This provides a defense-in-depth layer that catches bugs the application layer misses:

```sql
-- Enable Row-Level Security on every tenant-scoped table
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see rows for their tenant
-- The app sets current_setting('app.tenant_id') at the start of each session
CREATE POLICY tenant_isolation ON projects
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON tasks
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Superuser/admin bypass (for migrations, admin panel)
CREATE POLICY admin_bypass ON projects
    USING (current_setting('app.is_admin', true) = 'true');
```

On the Go side, the application must call `set_config('app.tenant_id', ...)` at the start of each database operation. The `withTenantRLS` helper below acquires a connection, sets the tenant context, and passes the configured connection to a callback. The third argument `true` to `set_config` makes the setting local to the current transaction, which is critical when using connection pools:

```go
// Set tenant ID at the start of each database operation
func (r *ProjectRepo) withTenantRLS(ctx context.Context, action func(conn *pgxpool.Conn) error) error {
    t := tenant.MustFromContext(ctx)

    conn, err := r.pool.Acquire(ctx)
    if err != nil {
        return err
    }
    defer conn.Release()

    // Set tenant context for RLS
    _, err = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, t.ID.String())
    if err != nil {
        return fmt.Errorf("setting tenant context: %w", err)
    }

    return action(conn)
}

func (r *ProjectRepo) ListWithRLS(ctx context.Context) ([]Project, error) {
    var projects []Project

    err := r.withTenantRLS(ctx, func(conn *pgxpool.Conn) error {
        // RLS policy automatically filters to current tenant
        // No WHERE tenant_id = $1 needed!
        rows, err := conn.Query(ctx, `SELECT id, name, description, created_at FROM projects`)
        if err != nil {
            return err
        }
        defer rows.Close()

        projects, err = pgx.CollectRows(rows, pgx.RowToStructByName[Project])
        return err
    })

    return projects, err
}
```

The key benefit: even if application code omits the `tenant_id` filter, PostgreSQL silently applies the RLS policy. The database becomes the last line of defense against cross-tenant data leaks.

**The caution**: RLS adds overhead (policy evaluation per row). Benchmark carefully on hot paths. Also: `set_config` with `true` as the third argument (equivalent to `SET LOCAL app.tenant_id = ...`) makes it local to the transaction, not the connection - critical when using connection pools. If you `SET` without `LOCAL` in a pooled connection, the next request to borrow that connection inherits the previous tenant's context and reads the wrong rows. Always wrap RLS-scoped queries in an explicit transaction, or use `set_config(..., true)` on every acquisition.

**Tenant-leak is the worst failure mode**. A bug that returns 500 errors is a bad day. A bug that returns tenant A's data to tenant B is a breach, a disclosure filing, and potentially a company-ending event. Treat every repository method as security-critical:

- **Never trust a client-sent `tenant_id`**. The tenant must come from the authenticated session (JWT claim, verified subdomain, or server-side lookup against the user ID), never from a request body or query parameter the client can tamper with.
- **Reject, don't coerce, mismatched tenant context**. If a request's JWT says tenant A but the subdomain says tenant B, return `403 Forbidden` immediately. Do not pick one and proceed.
- **Defense in depth**: application-layer `WHERE tenant_id = $1` + PostgreSQL RLS + repository-level cross-tenant tests. Each layer assumes the others might fail.

### Junior → FAANG: Tenant Isolation Testing as a Security Invariant

Security in a multi-tenant system is not a checklist. It is a set of invariants that must hold for every repository method, every API endpoint, and every background job. FAANG interviews test whether you treat these invariants as engineering discipline, not as an afterthought.

Common junior gaps:

- Writing tenant isolation tests only for the "happy path" (tenant A can read their own data) without testing the "cross-tenant access" case (tenant A cannot read tenant B's data by providing tenant B's UUID).
- Not understanding the difference between `SET` and `SET LOCAL` in PostgreSQL session variables. `SET search_path = ...` persists for the lifetime of the connection. `SET LOCAL search_path = ...` persists only for the current transaction. In a connection pool, `SET` without `LOCAL` leaks the configuration to the next tenant who borrows the same connection.
- Trusting `tenant_id` from the request body or query parameters. The tenant must always come from the server-verified session (JWT claim or DNS-verified subdomain), never from a client-controlled field.

The `withTenantRLS` pattern above is the correct production implementation because it uses `set_config(..., true)` which is equivalent to `SET LOCAL`, making the setting transaction-local rather than connection-persistent.

Worked example: "A user from tenant A finds a UUID that belongs to tenant B's project and tries to access it via the API. What stops them?"

Answer: three layers. First, the application layer: `GetProject` always includes `AND tenant_id = $2` even for primary key lookups, so the query returns zero rows for a cross-tenant UUID. Second, PostgreSQL RLS: even if the application code omitted the tenant filter, the RLS policy would filter out the row. Third, the cross-tenant isolation test catches this at development time, not in production.

First-job habits:

- For every new repository method, write a cross-tenant isolation test before the method is merged. This takes five minutes and is a non-negotiable PR requirement on security-sensitive codebases.
- Add a CI check that verifies RLS is enabled on every tenant-scoped table. A migration that adds a new table without `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` should fail CI.

### Senior @ FAANG: Defense in Depth, Threat Modeling, and Compliance Controls

At staff level, security in a multi-tenant system is a threat-modeled, auditable discipline. The implementation details in this section are correct, but the senior-level concern is making sure the implementation is complete, verified, and evidenced for compliance audits.

**Threat model for tenant data leakage:**

The primary threat vectors in a multi-tenant system, in order of likelihood and severity:

1. Application code forgets `WHERE tenant_id = $1`. Mitigated by RLS and cross-tenant tests.
2. Shared connection pools leak `SET search_path` or RLS configuration between tenants. Mitigated by `SET LOCAL` and transaction-scoped configuration.
3. JWT token from tenant A is replayed against a subdomain for tenant B. Mitigated by cross-validating JWT tenant claim against resolved subdomain tenant, rejecting mismatches with `403`.
4. Admin panel lacks tenant scoping. Mitigated by a separate admin authentication flow that requires explicit `bypass_rls` privilege, logged on every use.
5. Background jobs run without a tenant context, querying across all tenants. Mitigated by requiring `MustFromContext` in all database calls, including background workers.
6. Logging middleware inadvertently logs another tenant's data in error messages. Mitigated by structured logging with opaque identifiers, never logging row data in error paths.

**RLS operational considerations:**

PostgreSQL RLS adds a policy evaluation step to every row access. The performance cost is typically under 5% on indexed tables, but can be significant on sequential scans or when the `current_setting('app.tenant_id')` lookup is called millions of times. Benchmark critical paths with RLS enabled. If performance impact is unacceptable on a specific hot path, use explicit `WHERE tenant_id = $1` and document the exemption with a justification comment. Never disable RLS silently.

The admin bypass policy (`app.is_admin = 'true'`) must be guarded at the authentication layer. The admin setting should only be enabled for connections authenticated with a separate admin role and credential, not for the application's standard database user. A compromise of the application database user should not grant admin bypass.

**Compliance evidence for SOC 2 and GDPR audits:**

An auditor reviewing your SOC 2 Type II report will look for evidence that tenant isolation controls are implemented and tested. The evidence chain:

- Schema: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statements in migration history (proves the control exists).
- Tests: CI artifacts showing cross-tenant isolation tests pass on every build (proves the control is verified continuously).
- Monitoring: alerts on cross-tenant access attempts (proves the control is monitored in production).
- Incident history: any past cross-tenant access incidents with root cause and remediation (proves the control fails detectably when it fails).

A staff engineer owning the security architecture is responsible for ensuring this evidence chain is complete and queryable by the compliance team without requiring an engineering investigation.

**Zero-trust architecture for internal service calls:**

In a microservices deployment, service-to-service calls must also carry tenant identity. An internal service should not trust a tenant ID from another internal service's HTTP header without verification, because a compromised service could forge it. The zero-trust pattern: every internal service call includes a signed service-to-service JWT that contains the tenant ID. The receiving service verifies the JWT signature using the issuing service's public key before accepting the tenant claim.

This is overhead for small systems but is required for compliance at enterprise scale, where a single compromised internal service must not be able to access all tenants' data.

---
