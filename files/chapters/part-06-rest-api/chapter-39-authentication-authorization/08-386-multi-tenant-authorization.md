## 39.6 Multi-Tenant Authorization

### Tenant-Aware Authorization

Multi-tenant systems must resolve which tenant a request belongs to before any authorization check runs. The `TenantResolver` interface abstracts the resolution strategy (subdomain-based `acme.api.com`, header-based `X-Tenant-ID`, or token-claim-based) so the middleware works regardless of how tenants are identified. After resolution, `TenantAccessMiddleware` verifies the authenticated user actually belongs to that tenant, preventing cross-tenant data access.

```go
// ... imports omitted for brevity (context, errors, net/http)

// TenantContextKey for context values
type contextKey string

const TenantContextKey contextKey = "tenant"

// Tenant represents a tenant
type Tenant struct {
    ID     string `json:"id"`
    Name   string `json:"name"`
    Plan   string `json:"plan"` // free, pro, enterprise
    Active bool   `json:"active"`
}

// TenantResolver resolves tenant from request
type TenantResolver interface {
    Resolve(r *http.Request) (*Tenant, error)
}

// SubdomainTenantResolver resolves tenant from subdomain
type SubdomainTenantResolver struct {
    store TenantStore
}

func (r *SubdomainTenantResolver) Resolve(req *http.Request) (*Tenant, error) {
    host := req.Host
    // Extract subdomain: tenant.example.com
    // Implementation depends on your domain structure
    tenantSlug := extractSubdomain(host)
    if tenantSlug == "" {
        return nil, errors.New("no tenant in request")
    }

    return r.store.GetBySlug(req.Context(), tenantSlug)
}

// HeaderTenantResolver resolves tenant from header
type HeaderTenantResolver struct {
    store      TenantStore
    headerName string
}

func (r *HeaderTenantResolver) Resolve(req *http.Request) (*Tenant, error) {
    tenantID := req.Header.Get(r.headerName)
    if tenantID == "" {
        return nil, errors.New("no tenant header")
    }

    return r.store.GetByID(req.Context(), tenantID)
}

// TenantMiddleware extracts tenant and adds to context
func TenantMiddleware(resolver TenantResolver) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            tenant, err := resolver.Resolve(r)
            if err != nil {
                http.Error(w, "Tenant not found", http.StatusNotFound)
                return
            }

            if !tenant.Active {
                http.Error(w, "Tenant is inactive", http.StatusForbidden)
                return
            }

            ctx := context.WithValue(r.Context(), TenantContextKey, tenant)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// GetTenant extracts tenant from context
func GetTenant(ctx context.Context) *Tenant {
    tenant, _ := ctx.Value(TenantContextKey).(*Tenant)
    return tenant
}

// TenantAccessMiddleware ensures user belongs to tenant
func TenantAccessMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        user := GetUser(r.Context())
        tenant := GetTenant(r.Context())

        if user == nil || tenant == nil {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }

        // Verify user belongs to tenant
        if user.TenantID != tenant.ID {
            http.Error(w, "Access denied to this tenant", http.StatusForbidden)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

### Resource-Level Authorization

Resource-level authorization goes beyond role checks to verify the user's relationship with the specific object being accessed. The `OwnershipAuthorizer` first checks if the user owns the resource, then falls back to a shared-access lookup. This two-tier check supports collaboration features: a document owner has full access, while shared users have only the permissions explicitly granted to them.

```go
// ... imports omitted for brevity (context, errors, net/http, chi)

// ResourceAuthorizer checks resource-level permissions
type ResourceAuthorizer interface {
    CanAccess(ctx context.Context, userID, resourceType, resourceID, action string) (bool, error)
}

// OwnershipAuthorizer checks if user owns the resource
type OwnershipAuthorizer struct {
    store ResourceStore
}

func (a *OwnershipAuthorizer) CanAccess(ctx context.Context, userID, resourceType, resourceID, action string) (bool, error) {
    resource, err := a.store.Get(ctx, resourceType, resourceID)
    if err != nil {
        return false, err
    }

    // Owner has full access
    if resource.OwnerID == userID {
        return true, nil
    }

    // Check shared access
    access, err := a.store.GetAccess(ctx, resourceType, resourceID, userID)
    if err != nil {
        return false, nil // No access record = no access
    }

    return access.HasPermission(action), nil
}

// ResourceAccess represents shared access to a resource
type ResourceAccess struct {
    UserID      string
    ResourceID  string
    Permissions []string // read, write, delete, admin
}

func (a *ResourceAccess) HasPermission(action string) bool {
    for _, p := range a.Permissions {
        if p == action || p == "admin" {
            return true
        }
    }
    return false
}

// AuthorizeResource middleware checks resource access
func AuthorizeResource(authorizer ResourceAuthorizer, resourceType, action string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := GetUser(r.Context())
            if user == nil {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            resourceID := chi.URLParam(r, "id")
            if resourceID == "" {
                http.Error(w, "Resource ID required", http.StatusBadRequest)
                return
            }

            canAccess, err := authorizer.CanAccess(r.Context(), user.ID, resourceType, resourceID, action)
            if err != nil {
                http.Error(w, "Authorization error", http.StatusInternalServerError)
                return
            }

            if !canAccess {
                http.Error(w, "Access denied", http.StatusForbidden)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Junior → FAANG: Multi-Tenant Fundamentals and First-Job Framing

Multi-tenant authorization has one rule: data belonging to tenant A must never leak to tenant B, under any code path, under any bug, under any refactor. Every design decision below flows from that single invariant.

If this is your first multi-tenant system, the mental model is two nested checks. Outer check: resolve the tenant from the request and verify the authenticated user is a member of that tenant. Inner check: on every data access, filter by `tenant_id = current_tenant.id` and assert the filter is applied. The middleware in the code above does the outer check. The inner check is the responsibility of the data layer, and forgetting it is the single most common cause of real production breaches in B2B SaaS.

Three resolution strategies, with trade-offs you should be able to recite:

1. Subdomain (`acme.api.com`). Humans can read it, DNS routes it, TLS wildcard certs cover it. Downside: a SaaS with 50k tenants has 50k DNS records unless you wildcard, and wildcard TLS has its own key-sharing risks.
2. Header (`X-Tenant-ID`). Easiest to implement, easiest to spoof in logs and CORS misconfigs. Requires strict bind-to-session validation.
3. JWT claim (`tid`). Tenant is cryptographically bound to the token, cannot be spoofed. Downside: tenant switches require token refresh.

For a first B2B product the right default is JWT claim plus subdomain for branding. The claim is the authority, the subdomain is cosmetic.

Worked example. Your team ships a document app. The first bug report in production is "a user sees another tenant's document in their list." Nine times out of ten the cause is a query like `SELECT * FROM documents WHERE owner_id = ?` where someone forgot the tenant filter. The fix is not to add the filter in that one query. The fix is to make it impossible to write a query without the filter. Two approaches junior engineers should know:

1. A repository layer that requires a tenant context on construction and injects the filter. The handler cannot call `repo.Get(id)` without having resolved a tenant first.
2. PostgreSQL Row-Level Security (RLS) policies that enforce `tenant_id = current_setting('app.current_tenant')::uuid` at the database layer. The middleware sets the session variable, and no query can bypass it.

RLS is the stronger guarantee because it enforces even when the application has a bug. Take it if your DB is Postgres. For MySQL you fall back to the repository pattern with aggressive linting.

Interview entry-points:

1. What is BOLA and why is it the number one API risk? Because a role check passes but the specific object belongs to another tenant or user. The fix is always instance-level authorization keyed on the session-bound tenant ID.
2. How do you migrate a single-tenant DB to multi-tenant? Add `tenant_id` column with a non-null constraint after backfill, add composite indexes on (`tenant_id`, existing key), add RLS policies, shadow-check every query in staging.
3. How do you handle a user who belongs to multiple tenants? Either one session per tenant (active tenant switch requires re-auth) or a `tenant_memberships` table and a per-request active tenant claim. Pick the second for SaaS.

Common junior mistake: trusting a tenant ID from the request body or URL path as authority. The tenant authority must come from the verified session, not from client input. The URL may carry a tenant slug for routing, but validate it matches the session claim before trusting it.

### Senior @ FAANG: Isolation Models, Postgres RLS, and Tenancy at Snowflake/Salesforce Scale

At staff level the multi-tenant authorization design is chosen before a line of code is written because it constrains schema, deployment, DR, billing, and compliance. The three classic isolation models are shared-schema, schema-per-tenant, and database-per-tenant, and each has a narrow window where it is correct.

**Shared-schema with `tenant_id` column.** Single database, single schema, every tenant-scoped table carries a `tenant_id` column that participates in every index. Lowest operational overhead, highest density, cheapest to scale. Tenant isolation depends entirely on application and database-level guards. This is the default for most B2B SaaS. Scale ceiling is roughly "until one tenant's working set no longer fits in your hottest index" which for Postgres on modern hardware is tens of millions of tenants before partitioning matters. Failure mode: noisy-neighbor on compute and IO. Defense: per-tenant connection pools with `pg_bouncer` transaction pooling, statement timeouts scaled by plan tier, and query-cost budgets enforced at the gateway.

**Schema-per-tenant.** One schema per tenant inside a shared database. Logical separation, easier per-tenant backup and restore, per-tenant schema evolution. Breaks down at a few thousand schemas because Postgres catalog scans become expensive, connection-pool warmup times explode, and migrations become a fan-out problem. Used by some long-lived B2B products and some healthcare SaaS where per-tenant schema drift is a compliance requirement. Avoid for greenfield.

**Database-per-tenant (or cluster-per-tenant).** Maximum isolation. Per-tenant encryption keys, per-tenant backups, per-tenant regions (data residency for GDPR, Schrems II, India DPDP). This is how Salesforce Hyperforce provisions enterprise customers, how Snowflake isolates accounts (each Snowflake account is effectively its own compute-storage boundary with shared control plane), and how AWS provisions dedicated-tenancy services. Cost per tenant is high, so the model is reserved for enterprise tier or regulated workloads. Often combined with shared-schema for the free and pro tiers in the same product, with a migration path as a tenant upgrades.

Real FAANG-scale systems mix all three. Salesforce runs shared-schema within a Hyperforce "instance" (called a POD historically) and then provisions many instances across regions. Snowflake runs per-account compute warehouses over shared storage with account-scoped IAM. The decision matrix is: regulatory requirement for physical isolation, blast radius tolerance, per-tenant revenue, and migration cost. Write the matrix in the design doc.

**Postgres Row-Level Security in depth.** RLS is the staff-grade answer to shared-schema isolation. The pattern:

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

`FORCE ROW LEVEL SECURITY` matters because without it the table owner (often the application role) bypasses policies. The application sets the session variable at the start of each transaction:

```go
// set_config(..., true) is the parameterizable equivalent of SET LOCAL
// (SET itself cannot take bind parameters)
tx.ExecContext(ctx, "SELECT set_config('app.current_tenant', $1, true)", tenant.ID)
```

`SET LOCAL` scopes the variable to the current transaction so a pooled connection cannot leak the setting to the next checkout. This is the single most important line in an RLS deployment. If you use `SET` without `LOCAL`, a pgbouncer transaction-pooled connection will carry tenant A's setting into tenant B's next query. That is a data breach waiting to happen. Assert `SET LOCAL` in code review and in a repository-layer test.

**Performance implications of RLS.** Policies become predicates Postgres injects into every query. The query planner treats them as leak-proof predicates and will not push them below a function call without `LEAKPROOF`. Composite indexes starting with `tenant_id` are essential. Expect 5 to 15 percent overhead on hot queries in exchange for a strong invariant. Benchmark with `EXPLAIN (ANALYZE, BUFFERS)` before and after, not by looking at the policy text.

**Bypass and admin paths.** Internal tools, analytics, and cross-tenant features (abuse investigation, enterprise support) need controlled bypass. The correct pattern is a dedicated `app_admin` role with `BYPASSRLS` and a loud audit trail on every session opened with that role. Never grant `BYPASSRLS` to the main application role. Put the admin role behind an MFA gate and a break-glass approval workflow for anything that touches customer data.

**Cross-tenant sharing.** Enterprise features increasingly require cross-tenant relationships: partner workspaces, federated search, shared channels (Slack Connect), cross-org repositories. Pure RLS cannot express "tenant A can read this specific row in tenant B's table." The correct architecture is a relationship table (`shared_resources (source_tenant, target_tenant, resource_id, scope, expires_at)`) evaluated through a Zanzibar-style PDP, with the RLS policy extended to `tenant_id = current_tenant OR EXISTS (SELECT 1 FROM shared_resources ...)`. Keep the join predicate indexed and bounded.

**ABAC and ReBAC in the multi-tenant layer.** The middleware above checks `user.TenantID == tenant.ID`. That is RBAC-style flat membership. At scale you need: membership with a role scoped to the tenant, delegated admin roles (enterprise admin can impersonate workspace admin), guest access with narrowed scopes, and service principals belonging to the tenant. Model these as relationships in SpiceDB or OpenFGA, not as columns. The schema:

```
definition tenant {
    relation owner: user
    relation admin: user
    relation member: user
    relation guest: user
    permission view = owner + admin + member + guest
    permission manage = owner + admin
}
definition document {
    relation tenant: tenant
    relation editor: user
    relation viewer: user
    permission read = viewer + editor + tenant->view
    permission write = editor + tenant->manage
}
```

The `tenant->view` userset rewrite is the Zanzibar primitive that makes multi-tenant ReBAC scale. Your PEP calls `Check(user, read, document:X)` and the PDP walks the graph.

**OWASP API Top 10 2023 alignment.** API1 BOLA, API3 Broken Object Property Level Authorization, and API5 Broken Function Level Authorization all apply. BOLA is object-level (this specific document). BOPLA is property-level (this user can read the document but not the `salary` field). BFLA is function-level (this user can hit `/admin/*`). Multi-tenant systems must address all three. Property-level is the one junior designs miss: a response serializer that returns every column is a BOPLA risk when the viewer should only see a subset. Field-level masking in the serializer, driven by the same PDP, is the fix.

**Tenant isolation testing.** Three mandatory test layers. First, unit tests that construct a request for tenant A with a session for tenant B and assert 403. Second, RLS tests that run a query as a non-bypass role without setting `app.current_tenant` and assert zero rows, proving the policy is default-deny. Third, chaos testing: randomly replay production request bodies with swapped tenant IDs and assert no response body contains data belonging to the original tenant. This last test catches more real bugs than any amount of code review.

**Observability contract.** Every data access should emit `tenant_id_session`, `tenant_id_resource`, and `match` fields. A mismatch is a SEV1 signal even if the response was a 403, because it proves the application attempted a cross-tenant read. Dashboard the mismatch rate per service. Zero tolerance.

**Common production breach patterns.** (1) Analytics pipelines running as `BYPASSRLS` and writing denormalized outputs without tenant filtering. (2) Backup-restore flows that load a snapshot into a shared staging environment and expose cross-tenant data to support engineers. (3) Full-text search indexes (Elasticsearch, OpenSearch) that ingest all tenants into a single index without a tenant filter clause, and a buggy query that omits the filter returns cross-tenant results. (4) Caches keyed on resource ID without tenant ID, causing tenant A's cached response to serve tenant B. All four have shipped to production at companies you use every day. Write explicit architecture decision records (ADRs) addressing each.

---
