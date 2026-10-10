## 52E.4 Tenant Routing

### Subdomain Routing

Each tenant gets their own subdomain, which provides clear tenant identity in the URL and a clean user experience. This requires a wildcard SSL certificate and DNS configuration at the infrastructure level.

```
acme.yourapp.com        → tenant: acme
globalcorp.yourapp.com  → tenant: globalcorp
```

Infrastructure setup (nginx/Caddy):

```nginx
# Wildcard SSL certificate: *.yourapp.com
server {
    listen 443 ssl;
    server_name *.yourapp.com;
    ssl_certificate /etc/ssl/wildcard.yourapp.com.crt;
    ssl_certificate_key /etc/ssl/wildcard.yourapp.com.key;

    location / {
        proxy_pass http://app_servers;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        # Extract subdomain and forward as header for app servers
        # App extracts tenant from Host header
    }
}
```

Enterprise tenants often want custom domains like `crm.acme.com` pointing to their workspace. This requires a domain verification flow (typically DNS TXT record) and a lookup table mapping verified custom domains to tenant IDs:

```go
// Custom domain resolution: look up tenant by custom domain
func (r *TenantResolver) ResolveByDomain(ctx context.Context, domain string) (*tenant.TenantContext, error) {
    // Check cache first
    if cached := r.cache.Get(domain); cached != nil {
        return cached, nil
    }

    var t TenantContext
    err := r.db.QueryRow(ctx, `
        SELECT t.id, t.slug, t.plan, t.is_active
        FROM organizations t
        JOIN custom_domains cd ON cd.organization_id = t.id
        WHERE cd.domain = $1 AND cd.verified = true
    `, domain).Scan(&t.ID, &t.Slug, &t.Plan, &t.IsActive)

    if errors.Is(err, pgx.ErrNoRows) {
        return nil, tenant.ErrNotFound
    }
    if err != nil {
        return nil, err
    }

    r.cache.Set(domain, &t, 5*time.Minute)
    return &t, nil
}
```

### Path Routing

Path-based routing encodes the tenant identifier in the URL path. This is simpler to set up than subdomain routing since it requires no DNS or wildcard certificate configuration, but it changes every URL in the application:

```
yourapp.com/t/acme/dashboard
yourapp.com/t/globalcorp/settings
```

```go
// chi router with tenant path parameter
r.Route("/t/{tenantSlug}", func(r chi.Router) {
    r.Use(PathTenantMiddleware(tenantResolver))
    r.Get("/dashboard", dashboardHandler.Get)
    r.Route("/projects", projectRoutes)
})

func PathTenantMiddleware(resolver TenantResolver) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            slug := chi.URLParam(r, "tenantSlug")
            if slug == "" {
                http.Error(w, "missing tenant", http.StatusBadRequest)
                return
            }

            tenantCtx, err := resolver.ResolveBySlug(r.Context(), slug)
            if err != nil {
                http.NotFound(w, r)
                return
            }

            ctx := tenant.WithTenant(r.Context(), tenantCtx)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Header Routing

Header-based routing is the standard choice for API-first products and internal service-to-service communication. The client passes the tenant identifier in a custom header, keeping URLs clean and tenant identity explicit:

```
POST /api/projects
X-Tenant-ID: 550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer token
```

```go
func HeaderTenantMiddleware(resolver TenantResolver) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            tenantIDStr := r.Header.Get("X-Tenant-ID")
            if tenantIDStr == "" {
                // Fall back to JWT claim if present
                if claims := GetJWTClaims(r.Context()); claims != nil {
                    tenantIDStr = claims.TenantID
                }
            }

            if tenantIDStr == "" {
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusBadRequest,
                    Title:  "Missing Tenant",
                    Detail: "Provide tenant via X-Tenant-ID header or JWT tenant_id claim.",
                })
                return
            }

            tenantID, err := uuid.Parse(tenantIDStr)
            if err != nil {
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusBadRequest,
                    Title:  "Invalid Tenant ID",
                    Detail: "X-Tenant-ID must be a valid UUID.",
                })
                return
            }

            tenantCtx, err := resolver.ResolveByID(r.Context(), tenantID)
            if err != nil {
                if errors.Is(err, tenant.ErrNotFound) {
                    apierror.Write(w, r, &apierror.ProblemDetail{
                        Status: http.StatusNotFound,
                        Title:  "Tenant Not Found",
                    })
                    return
                }
                apierror.Write(w, r, apierror.InternalError())
                return
            }

            ctx := tenant.WithTenant(r.Context(), tenantCtx)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Tenant Resolver with Caching

Tenant resolution happens on every request, so it must be fast. Wrapping the resolver in a TTL cache backed by an in-memory store avoids a database query on every HTTP request. The implementation below cross-indexes by both slug and ID so that either lookup path benefits from the cache:

```go
type CachedTenantResolver struct {
    underlying TenantResolver
    cache      *ttlcache.Cache[string, *tenant.TenantContext]
    metrics    TenantResolverMetrics
}

func NewCachedTenantResolver(underlying TenantResolver) *CachedTenantResolver {
    cache := ttlcache.New[string, *tenant.TenantContext](
        ttlcache.WithTTL[string, *tenant.TenantContext](5 * time.Minute),
        ttlcache.WithCapacity[string, *tenant.TenantContext](10_000),
    )
    go cache.Start()  // start cleanup goroutine

    return &CachedTenantResolver{
        underlying: underlying,
        cache:      cache,
    }
}

func (r *CachedTenantResolver) ResolveBySlug(ctx context.Context, slug string) (*tenant.TenantContext, error) {
    cacheKey := "slug:" + slug

    if item := r.cache.Get(cacheKey); item != nil {
        r.metrics.CacheHit("slug")
        return item.Value(), nil
    }

    r.metrics.CacheMiss("slug")
    t, err := r.underlying.ResolveBySlug(ctx, slug)
    if err != nil {
        return nil, err
    }

    r.cache.Set(cacheKey, t, ttlcache.DefaultTTL)
    r.cache.Set("id:"+t.ID.String(), t, ttlcache.DefaultTTL)

    return t, nil
}

// Invalidate tenant cache when tenant config changes
func (r *CachedTenantResolver) Invalidate(tenantID uuid.UUID) {
    // Note: in a multi-instance deployment, you need to publish an invalidation
    // event (via Redis pub/sub) so all instances evict their cache
    r.cache.Delete("id:" + tenantID.String())
    // Cannot delete by slug without knowing it - store a slug→id mapping
}
```

### Junior → FAANG: Routing Strategy Selection and Security Basics

Interviewers expect you to know the three routing strategies and to defend a choice in context. The common junior mistake is treating this as a pure UX decision. It is also a security decision.

Key gaps to close before an interview:

- Subdomain routing requires a wildcard TLS certificate and DNS A-record pointing all subdomains to the load balancer. If you cannot explain this infrastructure requirement, the interviewer knows you have only read about the pattern, not shipped it.
- The tenant identity in subdomain or header routing must be verified server-side against the authenticated user's session. A request to `acme.yourapp.com` with a JWT that belongs to `globalcorp` should return `403 Forbidden` immediately. Never silently pick one and proceed.
- Custom domain verification requires a DNS TXT record check to prove the customer controls the domain. Without this, an attacker can point any domain at your server and claim to be a different tenant.

Worked example for interviews: "Your SaaS supports both a web UI and a public API. How do you handle tenant routing for each?"

Answer: subdomain routing for the web UI because it gives clear visual identity and works naturally with wildcard TLS. Header routing (`X-Tenant-ID`) for the API because it keeps URLs clean, is explicit, and is easy for API clients to set programmatically. Both strategies resolve the tenant through the same `CachedTenantResolver` so the database lookup is shared and cached.

First-job habits:

- When you ship a new routing strategy, add a test that sends a request with a mismatched tenant in the JWT and the subdomain, and assert it returns `403`. This test documents the security invariant and prevents regressions.
- Never add a route that bypasses tenant resolution, even for admin or debug endpoints. Internal endpoints should use a separate admin tenant context, not skip tenancy entirely.

### Senior @ FAANG: Custom Domains, Certificate Automation, and Cache Invalidation at Scale

The `CachedTenantResolver` pattern in this section is correct for a single application instance. At platform scale, the cache invalidation problem becomes the dominant engineering challenge.

**Multi-instance cache invalidation:**

Each application instance has its own in-memory TTL cache. When a tenant's slug changes or a custom domain is verified, the change hits the database but the in-memory caches across all instances continue serving stale data until TTL expires. For tenant suspension (an active security action), a five-minute TTL means a suspended tenant can continue making requests for up to five minutes.

The fix is a Redis pub/sub channel for invalidation events. When the admin API suspends a tenant, it deletes the Redis key and publishes an invalidation event. Each instance subscribes, receives the event, and immediately evicts its local cache entry. The local TTL becomes the recovery window if a pub/sub message is missed, not the primary invalidation mechanism.

```go
// Admin action: suspend tenant
func (s *AdminService) SuspendTenant(ctx context.Context, tenantID uuid.UUID) error {
    _, err := s.db.Exec(ctx, `UPDATE organizations SET is_active = false WHERE id = $1`, tenantID)
    if err != nil {
        return err
    }
    // Publish invalidation event - all instances evict their cache entry immediately
    return s.redis.Publish(ctx, "tenant:cache:invalidate", tenantID.String()).Err()
}
```

**Custom domain TLS at scale:**

Enterprise tenants with custom domains require a TLS certificate for each domain. At tens or hundreds of custom domains, manual certificate management is not viable. The standard solution:

- Caddy or Traefik with on-demand TLS using ACME DNS-01 challenge. Each custom domain gets its certificate issued and renewed automatically.
- Cloudflare for SaaS if you are comfortable with a vendor dependency. It handles certificate issuance and edge routing per custom domain with minimal operational overhead.
- For self-managed: an ACME client (golang.org/x/crypto/acme) integrated into the routing layer, with certificate storage in a shared Redis or S3 bucket so all instances use the same certificate without re-issuing.

**Subdomain takeover prevention:**

When a tenant offboards, their subdomain mapping must be explicitly removed from the tenant registry. If an attacker re-registers the same slug after offboarding, they should see a `404 Not Found`, not a routing hit to their account. The fix is a slug tombstone table: when a slug is released, write it to the tombstone table. New tenant registration checks the tombstone before accepting a slug.

**ADR: routing strategy selection for a new service:**

At staff level, a new service in the platform should not independently choose a routing strategy. The platform should standardize on one strategy for internal services (header) and one for user-facing surfaces (subdomain). A service that deviates should document the deviation in an ADR with explicit sign-off from the platform team. This prevents the fragmentation that makes debugging cross-service tenant routing failures slow and expensive.

---
