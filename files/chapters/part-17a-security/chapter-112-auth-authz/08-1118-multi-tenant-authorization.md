## 112.8 Multi-Tenant Authorization

Multi-tenant authorization must enforce tenant isolation at the data access layer, not just at the API layer: every repository query must include a `WHERE tenant_id = $1` clause derived from the verified `TenantContext` in the request context, never from user-supplied parameters. The `TenantContext` struct carries both the verified tenant ID and the user's roles within that tenant, allowing middleware to populate it once from the JWT `tenant_id` claim and all downstream handlers to read it without re-parsing the token. A service-level guard that rejects any request reaching a handler without a valid `TenantContext` makes a missing tenant check an immediate, loud failure rather than a silent security regression.

```go
package multitenant

import (
    "context"
    "database/sql"
    "errors"
    "net/http"
)

type CustomClaims struct {
    TenantID string
    UserID   string
    Roles    []string
}

type Document struct {
    ID      string
    Title   string
    Content string
}

type TenantContext struct {
    TenantID string
    UserID   string
    Roles    []string
}

func (tc *TenantContext) HasRole(role string) bool {
    for _, r := range tc.Roles {
        if r == role {
            return true
        }
    }
    return false
}

// Middleware to enforce tenant isolation
func TenantIsolationMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract tenant from JWT claims
        claims, ok := r.Context().Value("jwt_claims").(*CustomClaims)
        if !ok {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }

        tenantCtx := &TenantContext{
            TenantID: claims.TenantID,
            UserID:   claims.UserID,
            Roles:    claims.Roles,
        }

        ctx := context.WithValue(r.Context(), "tenant", tenantCtx)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Database query with tenant isolation
func GetDocuments(ctx context.Context, db *sql.DB) ([]Document, error) {
    tenant, ok := ctx.Value("tenant").(*TenantContext)
    if !ok || tenant == nil {
        return nil, errors.New("no tenant context")
    }

    query := `SELECT id, title, content FROM documents WHERE tenant_id = $1`
    rows, err := db.QueryContext(ctx, query, tenant.TenantID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var documents []Document
    // ... scan rows into documents

    return documents, nil
}
```

### Junior → FAANG: Multi-Tenant Authorization as a High-Stakes Problem

Multi-tenant authorization failures are the most catastrophic authorization bugs because they expose one customer's data to another. They are among the most commonly reported SaaS security incidents and a frequent topic in FAANG backend interviews.

**Gap to close:** Understand the three layers where tenant isolation must be enforced: (1) API layer: the authenticated user's tenant ID is verified against the requested resource's tenant ID, (2) service layer: all service method calls include the tenant context, (3) data layer: all database queries filter by `tenant_id`. Missing any layer creates a cross-tenant data access vulnerability. The defense-in-depth principle applies here: enforce tenant isolation at all three layers, not just the API layer.

**First-job habit:** For every new database query you write in a multi-tenant service, verify that it includes `WHERE tenant_id = ?`. If the query is missing this filter, it is a critical security defect. Make this a code review checklist item.

**Interview framing:** When asked "how do you design a multi-tenant SaaS service to prevent cross-tenant data access?", describe the three-layer approach with the context propagation pattern: the JWT contains the tenant ID, middleware extracts it into a typed `TenantContext` value in the request context, all handlers and service methods require the context, all repository methods apply the tenant filter. This structured answer demonstrates production-level multi-tenant thinking.

### Senior @ FAANG: Multi-Tenant Architecture Decisions and Isolation Models

At senior level, multi-tenancy is an architectural decision with multiple isolation models, each with different security and operational properties.

**Isolation model spectrum:** There are three common isolation models: (1) Shared database, shared schema: all tenants in the same tables, distinguished by `tenant_id`. Lowest cost, highest risk of cross-tenant bugs. Requires defense-in-depth at every data access layer. (2) Shared database, separate schema: each tenant has their own database schema. Schema-level isolation prevents cross-tenant queries but adds migration complexity. (3) Separate database per tenant: complete data isolation. Highest cost and operational complexity, but the strongest isolation guarantee. The choice depends on sensitivity of tenant data, compliance requirements, and scale.

**Tenant isolation testing:** Write cross-tenant penetration tests: log in as Tenant A's user and attempt to access Tenant B's resources using Tenant A's valid JWT. These tests should always return 403. Run them as part of your integration test suite. If any cross-tenant test returns 200, that is a critical finding. Schedule monthly cross-tenant penetration testing sessions and track the results over time.

**Compliance and data residency:** Multi-tenant architectures must address data residency for regulated customers. Some customers (EU companies under GDPR, healthcare organizations under HIPAA) may require that their data never leaves a specific geographic region. This requirement conflicts with a shared global database model. Design your multi-tenant architecture with data residency as a first-class concern: define which tenants have residency requirements, map them to specific database instances in specific regions, and verify that your data access layer respects these boundaries. Document the residency model for compliance auditors.

---
