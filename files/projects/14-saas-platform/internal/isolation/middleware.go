// internal/isolation/middleware.go
package isolation

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    "github.com/google/uuid"
    "github.com/example/saas-platform/internal/tenant"
    "github.com/example/saas-platform/pkg/logger"
)

// TenantServicer provides tenant lookup for middleware
type TenantServicer interface {
    GetByID(ctx context.Context, id uuid.UUID) (*tenant.Tenant, error)
}

// TenantResolver is an interface for resolving tenant from HTTP requests
type TenantResolver interface {
    Resolve(r *http.Request) (*TenantContext, error)
}

// TenantMiddleware extracts tenant context from the request
type TenantMiddleware struct {
    resolver      TenantResolver
    tenantService TenantServicer
    logger        logger.Logger
}

func NewTenantMiddleware(resolver TenantResolver, tenantService TenantServicer, logger logger.Logger) *TenantMiddleware {
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
