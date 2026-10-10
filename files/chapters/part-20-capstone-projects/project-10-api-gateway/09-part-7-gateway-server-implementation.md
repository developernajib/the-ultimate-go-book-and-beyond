## Part 7: Gateway Server Implementation

The gateway server is the central component that ties everything together. It accepts incoming HTTP requests, runs them through the plugin chain, resolves the matching route, selects a healthy backend target via the load balancer, and proxies the request to that target. Internally, it uses Go's built-in `httputil.ReverseProxy` to handle the actual proxying, which efficiently copies request and response bodies without loading them entirely into memory. The server also handles path stripping (removing a route prefix before forwarding), host preservation, and error recovery so that a panic in one request does not crash the entire gateway.

```go
// internal/gateway/server.go
package gateway

import (
    "context"
    "fmt"
    "net/http"
    "net/http/httputil"
    "net/url"
    "time"

    "github.com/yourusername/gatewaygo/internal/plugin"
    "github.com/yourusername/gatewaygo/internal/router"
    "github.com/yourusername/gatewaygo/internal/upstream"
    "go.uber.org/zap"
)

// Server is the main gateway server
type Server struct {
    config          *Config
    router          *router.Router
    upstreamManager *upstream.Manager
    pluginRegistry  *plugin.Registry
    httpServer      *http.Server
    logger          *zap.Logger
}

// NewServer creates a new gateway server
func NewServer(config *Config, logger *zap.Logger) (*Server, error) {
    s := &Server{
        config:          config,
        router:          router.NewRouter(),
        upstreamManager: upstream.NewManager(),
        pluginRegistry:  plugin.NewRegistry(),
        logger:          logger,
    }

    // Initialize upstreams
    for i := range config.Upstreams {
        if err := s.upstreamManager.AddUpstream(&config.Upstreams[i]); err != nil {
            return nil, fmt.Errorf("add upstream %s: %w", config.Upstreams[i].ID, err)
        }
    }

    // Initialize routes
    for i := range config.Routes {
        if err := s.router.AddRoute(&config.Routes[i]); err != nil {
            return nil, fmt.Errorf("add route %s: %w", config.Routes[i].ID, err)
        }
    }

    // Create HTTP server
    addr := fmt.Sprintf("%s:%d", config.Server.Host, config.Server.Port)
    s.httpServer = &http.Server{
        Addr:           addr,
        Handler:        s,
        ReadTimeout:    config.Server.ReadTimeout,
        WriteTimeout:   config.Server.WriteTimeout,
        IdleTimeout:    config.Server.IdleTimeout,
        MaxHeaderBytes: config.Server.MaxHeaderBytes,
    }

    return s, nil
}

// ServeHTTP implements http.Handler
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    start := time.Now()

    // Match route
    route, params, err := s.router.Match(r)
    if err != nil {
        s.logger.Debug("no route match",
            zap.String("path", r.URL.Path),
            zap.Error(err),
        )
        http.Error(w, "Not Found", http.StatusNotFound)
        return
    }

    // Add route info to context
    ctx := router.WithRoute(r.Context(), route, params)
    r = r.WithContext(ctx)

    // Get upstream
    upstreamState, err := s.upstreamManager.GetUpstream(route.UpstreamID)
    if err != nil {
        s.logger.Error("get upstream failed",
            zap.String("upstream_id", route.UpstreamID),
            zap.Error(err),
        )
        http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
        return
    }

    // Create plugin chain
    chain, err := s.createPluginChain(route)
    if err != nil {
        s.logger.Error("create plugin chain failed",
            zap.String("route_id", route.ID),
            zap.Error(err),
        )
        http.Error(w, "Internal Server Error", http.StatusInternalServerError)
        return
    }

    // Process request through plugins
    r, result := chain.ProcessRequest(ctx, r)
    if result.Error != nil {
        s.handlePluginError(w, result.Error)
        return
    }

    // Select target
    target, err := s.upstreamManager.SelectTarget(ctx, route.UpstreamID)
    if err != nil {
        s.logger.Error("select target failed",
            zap.String("upstream_id", route.UpstreamID),
            zap.Error(err),
        )
        http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
        return
    }

    // Create reverse proxy
    proxy := s.createReverseProxy(target, route)

    // Wrap response writer to capture response
    rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

    // Proxy request
    proxy.ServeHTTP(rw, r)

    // Log access
    duration := time.Since(start)
    s.logger.Info("request",
        zap.String("method", r.Method),
        zap.String("path", r.URL.Path),
        zap.Int("status", rw.statusCode),
        zap.Duration("duration", duration),
        zap.String("route_id", route.ID),
        zap.String("target", target.URL()),
    )
}

func (s *Server) createPluginChain(route *Route) (*plugin.Chain, error) {
    var plugins []plugin.Plugin

    // Add global plugins
    for _, pc := range s.config.GlobalPlugins {
        if !pc.Enabled {
            continue
        }

        p, err := plugin.Create(pc.Name)
        if err != nil {
            return nil, fmt.Errorf("create plugin %s: %w", pc.Name, err)
        }

        if err := p.Init(pc.Config); err != nil {
            return nil, fmt.Errorf("init plugin %s: %w", pc.Name, err)
        }

        plugins = append(plugins, p)
    }

    // Add route-specific plugins
    for _, pc := range route.Plugins {
        if !pc.Enabled {
            continue
        }

        p, err := plugin.Create(pc.Name)
        if err != nil {
            return nil, fmt.Errorf("create plugin %s: %w", pc.Name, err)
        }

        if err := p.Init(pc.Config); err != nil {
            return nil, fmt.Errorf("init plugin %s: %w", pc.Name, err)
        }

        plugins = append(plugins, p)
    }

    return plugin.NewChain(plugins), nil
}

func (s *Server) createReverseProxy(target *upstream.TargetState, route *Route) *httputil.ReverseProxy {
    targetURL, _ := url.Parse(target.URL())

    proxy := httputil.NewSingleHostReverseProxy(targetURL)

    // Customize director
    defaultDirector := proxy.Director
    proxy.Director = func(req *http.Request) {
        defaultDirector(req)

        // Strip path if configured
        if route.StripPath {
            req.URL.Path = stripPathPrefix(req.URL.Path, route.Paths)
        }

        // Preserve host if configured
        if !route.PreserveHost {
            req.Host = targetURL.Host
        }

        // Add forwarding headers
        if clientIP := req.RemoteAddr; clientIP != "" {
            req.Header.Set("X-Forwarded-For", clientIP)
        }
        req.Header.Set("X-Forwarded-Proto", "http")
        req.Header.Set("X-Forwarded-Host", req.Host)
    }

    // Error handler
    proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
        s.logger.Error("proxy error",
            zap.String("target", target.URL()),
            zap.Error(err),
        )
        http.Error(w, "Bad Gateway", http.StatusBadGateway)
    }

    return proxy
}

func (s *Server) handlePluginError(w http.ResponseWriter, err error) {
    // Check for specific error types
    switch e := err.(type) {
    case *ratelimit.RateLimitError:
        w.Header().Set("Retry-After", fmt.Sprintf("%.0f", e.RetryAfter.Seconds()))
        http.Error(w, "Rate Limit Exceeded", http.StatusTooManyRequests)
    case *circuit.CircuitBreakerError:
        w.Header().Set("Retry-After", fmt.Sprintf("%.0f", e.RetryAfter.Seconds()))
        http.Error(w, "Service Temporarily Unavailable", http.StatusServiceUnavailable)
    case *cors.CORSError:
        http.Error(w, err.Error(), http.StatusForbidden)
    default:
        s.logger.Error("plugin error", zap.Error(err))
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
    }
}

// Start starts the server
func (s *Server) Start() error {
    s.logger.Info("starting gateway server",
        zap.String("addr", s.httpServer.Addr),
    )
    return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown(ctx context.Context) error {
    s.logger.Info("shutting down gateway server")
    return s.httpServer.Shutdown(ctx)
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func stripPathPrefix(path string, prefixes []string) string {
    for _, prefix := range prefixes {
        if strings.HasPrefix(path, prefix) {
            return strings.TrimPrefix(path, prefix)
        }
    }
    return path
}
```
