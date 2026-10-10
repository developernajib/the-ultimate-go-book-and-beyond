// cmd/api-gateway/main.go
package main

import (
    "context"
    "encoding/json"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "github.com/go-chi/cors"
    "github.com/example/saas-platform/internal/auth"
    "github.com/example/saas-platform/internal/billing"
    "github.com/example/saas-platform/internal/isolation"
    "github.com/example/saas-platform/internal/quota"
    "github.com/example/saas-platform/internal/tenant"
    "github.com/example/saas-platform/pkg/logger"
    "github.com/example/saas-platform/pkg/ratelimit"
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
