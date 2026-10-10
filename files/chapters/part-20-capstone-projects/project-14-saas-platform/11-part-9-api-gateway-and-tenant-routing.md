## Part 9: API Gateway and Tenant Routing

The API gateway is the single entry point for all client requests to your SaaS platform. It handles cross-cutting concerns like tenant identification, authentication, rate limiting, and request routing before forwarding requests to the appropriate backend service. By centralizing these concerns in the gateway, you avoid duplicating logic across every microservice. The gateway also enforces tenant-specific rate limits and routes requests to the correct service based on the URL path and tenant configuration.

```go
// cmd/api-gateway/main.go
package main

import (
    "context"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "github.com/go-chi/cors"
    "github.com/yourorg/tenantflow/internal/isolation"
    "github.com/yourorg/tenantflow/internal/auth"
    "github.com/yourorg/tenantflow/internal/quota"
    "github.com/yourorg/tenantflow/pkg/logger"
    "github.com/yourorg/tenantflow/pkg/ratelimit"
)

func main() {
    // Initialize logger
    log := logger.New()

    // Initialize dependencies
    db := initDatabase()
    cache := initCache()
    tenantRepo := tenant.NewRepository(db)
    userRepo := auth.NewUserRepository(db)

    // Initialize services
    jwtService := auth.NewJWTService(
        os.Getenv("JWT_ACCESS_SECRET"),
        os.Getenv("JWT_REFRESH_SECRET"),
        15*time.Minute,  // access token expiry
        7*24*time.Hour,  // refresh token expiry
    )

    tenantResolver := isolation.NewSubdomainResolver(tenantRepo, "tenantflow.io")
    usageTracker := billing.NewUsageTracker(usageRepo, cache, log)
    quotaEnforcer := quota.NewEnforcer(tenantRepo, usageTracker, cache, log)

    // Initialize middleware
    tenantMiddleware := isolation.NewTenantMiddleware(tenantResolver, tenantRepo, log)
    authMiddleware := auth.NewAuthMiddleware(jwtService, userRepo, sessionRepo, log)
    usageMiddleware := billing.NewUsageMiddleware(usageTracker, log)
    quotaMiddleware := quota.NewQuotaMiddleware(quotaEnforcer, log)
    rateLimiter := ratelimit.NewMiddleware(cache, log)

    // Create router
    r := chi.NewRouter()

    // Global middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.Timeout(60 * time.Second))

    // CORS
    r.Use(cors.Handler(cors.Options{
        AllowedOrigins:   []string{"*"},
        AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
        AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
        ExposedHeaders:   []string{"Link"},
        AllowCredentials: true,
        MaxAge:           300,
    }))

    // Health check (no tenant required)
    r.Get("/health", healthCheckHandler)

    // Public routes (no auth required, but tenant required)
    r.Group(func(r chi.Router) {
        r.Use(tenantMiddleware.Handler)

        r.Post("/auth/register", registerHandler)
        r.Post("/auth/login", loginHandler)
        r.Post("/auth/forgot-password", forgotPasswordHandler)
        r.Post("/auth/reset-password", resetPasswordHandler)
    })

    // Protected routes (auth + tenant required)
    r.Group(func(r chi.Router) {
        r.Use(tenantMiddleware.Handler)
        r.Use(authMiddleware.Handler)
        r.Use(rateLimiter.Handler)
        r.Use(usageMiddleware.Handler)
        r.Use(quotaMiddleware.Handler)

        // User routes
        r.Get("/users/me", getCurrentUserHandler)
        r.Patch("/users/me", updateCurrentUserHandler)

        // Tenant routes
        r.Get("/tenant", getTenantHandler)
        r.Patch("/tenant", updateTenantHandler)
        r.Get("/tenant/quotas", getQuotasHandler)

        // Billing routes
        r.Get("/billing/subscription", getSubscriptionHandler)
        r.Post("/billing/subscription", createSubscriptionHandler)
        r.Patch("/billing/subscription", updateSubscriptionHandler)
        r.Delete("/billing/subscription", cancelSubscriptionHandler)
        r.Get("/billing/invoices", listInvoicesHandler)
        r.Get("/billing/usage", getUsageHandler)

        // White-label routes
        r.Get("/branding", getBrandingHandler)
        r.Patch("/branding", updateBrandingHandler)
        r.Post("/branding/logo", uploadLogoHandler)
        r.Post("/domain", setupCustomDomainHandler)
    })

    // Admin routes (admin users only)
    r.Group(func(r chi.Router) {
        r.Use(authMiddleware.Handler)
        r.Use(requireAdminMiddleware)

        r.Get("/admin/dashboard", adminDashboardHandler)
        r.Get("/admin/tenants", listTenantsHandler)
        r.Get("/admin/tenants/{id}", getTenantDetailsHandler)
        r.Post("/admin/tenants/{id}/suspend", suspendTenantHandler)
        r.Post("/admin/tenants/{id}/reactivate", reactivateTenantHandler)
    })

    // Start server
    srv := &http.Server{
        Addr:         ":8080",
        Handler:      r,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Graceful shutdown
    go func() {
        sigint := make(chan os.Signal, 1)
        signal.Notify(sigint, os.Interrupt, syscall.SIGTERM)
        <-sigint

        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()

        log.Info("shutting down server...")
        if err := srv.Shutdown(ctx); err != nil {
            log.Error("server shutdown error", "error", err)
        }
    }()

    log.Info("starting API gateway", "addr", srv.Addr)
    if err := srv.ListenAndServe(); err != http.ErrServerClosed {
        log.Fatal("server error", "error", err)
    }
}

func healthCheckHandler(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]string{
        "status": "healthy",
        "time":   time.Now().UTC().Format(time.RFC3339),
    })
}
```

### Rate Limiting

Rate limiting protects your platform from abuse and ensures fair resource sharing across tenants. Each tenant gets a request budget based on their subscription plan, and the rate limiter tracks how many requests they have made within a sliding time window. When a tenant exceeds their limit, subsequent requests receive a `429 Too Many Requests` response with a `Retry-After` header telling the client when to try again. The implementation below uses Redis for distributed rate limiting, which means limits are enforced consistently even when your API gateway runs across multiple instances.

```go
// pkg/ratelimit/middleware.go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/yourorg/tenantflow/internal/isolation"
    "github.com/yourorg/tenantflow/pkg/cache"
    "github.com/yourorg/tenantflow/pkg/logger"
)

// Middleware implements rate limiting
type Middleware struct {
    cache  cache.Cache
    logger logger.Logger
}

func NewMiddleware(cache cache.Cache, logger logger.Logger) *Middleware {
    return &Middleware{
        cache:  cache,
        logger: logger,
    }
}

func (m *Middleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tenantID, err := isolation.TenantID(r.Context())
        if err != nil {
            // No tenant context, skip rate limiting
            next.ServeHTTP(w, r)
            return
        }

        // Rate limit per tenant
        key := fmt.Sprintf("ratelimit:%s", tenantID)

        // Check rate limit (100 requests per minute)
        allowed, err := m.checkRateLimit(r.Context(), key, 100, time.Minute)
        if err != nil {
            m.logger.Error("rate limit check failed", "error", err)
            next.ServeHTTP(w, r)
            return
        }

        if !allowed {
            w.Header().Set("X-RateLimit-Limit", "100")
            w.Header().Set("X-RateLimit-Remaining", "0")
            w.Header().Set("Retry-After", "60")
            http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func (m *Middleware) checkRateLimit(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
    // Sliding window rate limiting using Redis
    now := time.Now().Unix()
    windowStart := now - int64(window.Seconds())

    // Remove old entries
    m.cache.ZRemRangeByScore(ctx, key, 0, float64(windowStart))

    // Count requests in window
    count, err := m.cache.ZCount(ctx, key, float64(windowStart), float64(now))
    if err != nil {
        return true, err // Fail open
    }

    if count >= int64(limit) {
        return false, nil
    }

    // Add current request
    m.cache.ZAdd(ctx, key, float64(now), fmt.Sprintf("%d", now))
    m.cache.Expire(ctx, key, window)

    return true, nil
}
```
