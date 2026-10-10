## Part 8: Admin API

A production API gateway needs a way to be managed at runtime without restarting the process. The admin API provides a RESTful interface (typically running on a separate port like 9090) that lets operators list, create, update, and delete routes and upstreams while the gateway is running. This is how tools like Kong allow you to configure routing rules through HTTP calls instead of editing config files. The admin API uses the `chi` router for clean URL handling and returns JSON responses, making it easy to integrate with monitoring dashboards and automation scripts.

```go
// internal/admin/api.go
package admin

import (
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/yourusername/gatewaygo/internal/gateway"
    "github.com/yourusername/gatewaygo/internal/router"
    "github.com/yourusername/gatewaygo/internal/upstream"
    "go.uber.org/zap"
)

// API provides the admin REST API
type API struct {
    config          *gateway.Config
    router          *router.Router
    upstreamManager *upstream.Manager
    httpServer      *http.Server
    logger          *zap.Logger
}

// NewAPI creates a new admin API
func NewAPI(config *gateway.Config, r *router.Router, um *upstream.Manager, logger *zap.Logger) *API {
    api := &API{
        config:          config,
        router:          r,
        upstreamManager: um,
        logger:          logger,
    }

    // Create HTTP server
    addr := fmt.Sprintf("%s:%d", config.Admin.Host, config.Admin.Port)
    muxRouter := api.setupRoutes()

    api.httpServer = &http.Server{
        Addr:         addr,
        Handler:      muxRouter,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
    }

    return api
}

func (a *API) setupRoutes() *chi.Mux {
    r := chi.NewRouter()

    // Middleware
    r.Use(a.authMiddleware)
    r.Use(a.loggingMiddleware)

    // Health check
    r.Get("/health", a.handleHealth)

    // Routes
    r.Get("/routes", a.handleListRoutes)
    r.Post("/routes", a.handleCreateRoute)
    r.Get("/routes/{id}", a.handleGetRoute)
    r.Put("/routes/{id}", a.handleUpdateRoute)
    r.Delete("/routes/{id}", a.handleDeleteRoute)

    // Upstreams
    r.Get("/upstreams", a.handleListUpstreams)
    r.Post("/upstreams", a.handleCreateUpstream)
    r.Get("/upstreams/{id}", a.handleGetUpstream)
    r.Put("/upstreams/{id}", a.handleUpdateUpstream)
    r.Delete("/upstreams/{id}", a.handleDeleteUpstream)

    // Targets
    r.Get("/upstreams/{id}/targets", a.handleListTargets)
    r.Post("/upstreams/{id}/targets", a.handleAddTarget)
    r.Delete("/upstreams/{upstream_id}/targets/{target_id}", a.handleRemoveTarget)

    // Metrics
    r.Get("/metrics", a.handleMetrics)

    // Configuration
    r.Get("/config", a.handleGetConfig)
    r.Post("/config/reload", a.handleReloadConfig)

    return r
}

// Middleware
func (a *API) authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if a.config.Admin.APIKey == "" {
            next.ServeHTTP(w, r)
            return
        }

        apiKey := r.Header.Get("X-API-Key")
        if apiKey != a.config.Admin.APIKey {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func (a *API) loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        a.logger.Info("admin request",
            zap.String("method", r.Method),
            zap.String("path", r.URL.Path),
            zap.Duration("duration", time.Since(start)),
        )
    })
}

// Handlers
func (a *API) handleHealth(w http.ResponseWriter, r *http.Request) {
    response := map[string]any{
        "status": "healthy",
        "time":   time.Now(),
    }
    json.NewEncoder(w).Encode(response)
}

func (a *API) handleListRoutes(w http.ResponseWriter, r *http.Request) {
    routes := a.router.ListRoutes()
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(routes)
}

func (a *API) handleCreateRoute(w http.ResponseWriter, r *http.Request) {
    var route gateway.Route
    if err := json.NewDecoder(r.Body).Decode(&route); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    route.CreatedAt = time.Now()
    route.UpdatedAt = time.Now()

    if err := a.router.AddRoute(&route); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(route)
}

func (a *API) handleGetRoute(w http.ResponseWriter, r *http.Request) {
    routeID := chi.URLParam(r, "id")

    route, err := a.router.GetRoute(routeID)
    if err != nil {
        http.Error(w, err.Error(), http.StatusNotFound)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(route)
}

func (a *API) handleUpdateRoute(w http.ResponseWriter, r *http.Request) {
    routeID := chi.URLParam(r, "id")

    var route gateway.Route
    if err := json.NewDecoder(r.Body).Decode(&route); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    route.ID = routeID
    route.UpdatedAt = time.Now()

    if err := a.router.UpdateRoute(&route); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(route)
}

func (a *API) handleDeleteRoute(w http.ResponseWriter, r *http.Request) {
    routeID := chi.URLParam(r, "id")

    if err := a.router.RemoveRoute(routeID); err != nil {
        http.Error(w, err.Error(), http.StatusNotFound)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleListUpstreams(w http.ResponseWriter, r *http.Request) {
    // Implementation similar to routes
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (a *API) handleCreateUpstream(w http.ResponseWriter, r *http.Request) {
    var upstream gateway.Upstream
    if err := json.NewDecoder(r.Body).Decode(&upstream); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    upstream.CreatedAt = time.Now()
    upstream.UpdatedAt = time.Now()

    if err := a.upstreamManager.AddUpstream(&upstream); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(upstream)
}

func (a *API) handleGetUpstream(w http.ResponseWriter, r *http.Request) {
    upstreamID := chi.URLParam(r, "id")

    upstream, err := a.upstreamManager.GetUpstream(upstreamID)
    if err != nil {
        http.Error(w, err.Error(), http.StatusNotFound)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(upstream)
}

func (a *API) handleUpdateUpstream(w http.ResponseWriter, r *http.Request) {
    // Similar to handleUpdateRoute
    w.WriteHeader(http.StatusOK)
}

func (a *API) handleDeleteUpstream(w http.ResponseWriter, r *http.Request) {
    upstreamID := chi.URLParam(r, "id")

    if err := a.upstreamManager.RemoveUpstream(upstreamID); err != nil {
        http.Error(w, err.Error(), http.StatusNotFound)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleListTargets(w http.ResponseWriter, r *http.Request) {
    // Implementation
    w.WriteHeader(http.StatusOK)
}

func (a *API) handleAddTarget(w http.ResponseWriter, r *http.Request) {
    // Implementation
    w.WriteHeader(http.StatusCreated)
}

func (a *API) handleRemoveTarget(w http.ResponseWriter, r *http.Request) {
    // Implementation
    w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleMetrics(w http.ResponseWriter, r *http.Request) {
    // Return Prometheus metrics
    w.Header().Set("Content-Type", "text/plain")
    w.Write([]byte("# Metrics endpoint\n"))
}

func (a *API) handleGetConfig(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(a.config)
}

func (a *API) handleReloadConfig(w http.ResponseWriter, r *http.Request) {
    // Implementation for hot reload
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{"status": "reloaded"})
}

// Start starts the admin API server
func (a *API) Start() error {
    a.logger.Info("starting admin API",
        zap.String("addr", a.httpServer.Addr),
    )
    return a.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the admin API
func (a *API) Shutdown(ctx context.Context) error {
    a.logger.Info("shutting down admin API")
    return a.httpServer.Shutdown(ctx)
}
```
