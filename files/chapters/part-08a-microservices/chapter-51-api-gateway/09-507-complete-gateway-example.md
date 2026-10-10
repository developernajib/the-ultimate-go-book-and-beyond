## 51.7 Complete Gateway Example

### Main Application

The gateway `main` function wires together all subsystems (router, middleware chain, TLS configuration, and graceful shutdown) in a single binary that starts in under 100ms. The `http.Server` is configured with explicit read, write, and idle timeouts to prevent slow clients from holding connections indefinitely and exhausting the gateway's file descriptors. Graceful shutdown captures `SIGTERM` and calls `server.Shutdown` with a deadline, allowing in-flight requests to complete before the process exits and avoiding dropped connections during Kubernetes rolling updates.

```go
// cmd/gateway/main.go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"example.com/gateway/pkg/gateway"
	"example.com/gateway/pkg/gateway/middleware"
	"github.com/redis/go-redis/v9"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Redis for rate limiting
	redisClient := redis.NewClient(&redis.Options{
		Addr: os.Getenv("REDIS_URL"),
	})

	// Service registry (Consul)
	registry, err := gateway.NewConsulRegistry(os.Getenv("CONSUL_URL"))
	if err != nil {
		logger.Error("Failed to create registry", "error", err)
		os.Exit(1)
	}

	// Create gateway
	config := gateway.DefaultGatewayConfig()
	config.ListenAddr = os.Getenv("LISTEN_ADDR")
	if config.ListenAddr == "" {
		config.ListenAddr = ":8080"
	}

	gw := gateway.NewGateway(config, registry, logger)

	// Add middleware
	gw.Use(middleware.NewTracingMiddleware().Middleware)
	gw.Use(middleware.NewLoggingMiddleware(logger).Middleware)
	gw.Use(middleware.NewRateLimitMiddleware(
		middleware.NewSlidingWindowLimiter(redisClient),
		100, // 100 requests
		60,  // per 60 seconds
	).Middleware)
	gw.Use(middleware.NewAuthMiddleware(
		middleware.AuthMiddlewareConfig{
			JWTSecret:    os.Getenv("JWT_SECRET"),
			ExcludePaths: []string{"/health", "/metrics", "/auth"},
		},
		NewRedisAPIKeyStore(redisClient),
	).Middleware)

	// Configure routes
	setupRoutes(gw)

	// Create HTTP server
	server := &http.Server{
		Addr:         config.ListenAddr,
		Handler:      gw,
		ReadTimeout:  config.ReadTimeout,
		WriteTimeout: config.WriteTimeout,
		IdleTimeout:  config.IdleTimeout,
	}

	// Start server
	go func() {
		logger.Info("Starting API Gateway", "addr", config.ListenAddr)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			logger.Error("Server error", "error", err)
		}
	}()

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	logger.Info("Shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Error("Shutdown error", "error", err)
	}
}

func setupRoutes(gw *gateway.Gateway) {
	// User service routes
	gw.Route("GET", "/api/v1/users/:id", "user-service",
		gateway.WithPathRewrite("/users/:id"),
		gateway.WithTimeout(5000),
	)
	gw.Route("POST", "/api/v1/users", "user-service",
		gateway.WithPathRewrite("/users"),
		gateway.WithRateLimit(10, 60),
	)
	gw.Route("PUT", "/api/v1/users/:id", "user-service",
		gateway.WithPathRewrite("/users/:id"),
	)

	// Order service routes
	gw.Route("GET", "/api/v1/orders/:id", "order-service",
		gateway.WithPathRewrite("/orders/:id"),
	)
	gw.Route("POST", "/api/v1/orders", "order-service",
		gateway.WithPathRewrite("/orders"),
		gateway.WithAuth("jwt"),
	)
	gw.Route("GET", "/api/v1/users/:user_id/orders", "order-service",
		gateway.WithPathRewrite("/users/:user_id/orders"),
	)

	// Product service routes
	gw.Route("GET", "/api/v1/products", "product-service",
		gateway.WithPathRewrite("/products"),
		gateway.WithCache(300), // 5 minute cache
	)
	gw.Route("GET", "/api/v1/products/:id", "product-service",
		gateway.WithPathRewrite("/products/:id"),
		gateway.WithCache(60),
	)

	// Search service
	gw.Route("GET", "/api/v1/search", "search-service",
		gateway.WithPathRewrite("/search"),
		gateway.WithTimeout(10000),
	)

	// Auth service (excluded from auth middleware)
	gw.Route("POST", "/auth/login", "auth-service")
	gw.Route("POST", "/auth/register", "auth-service")
	gw.Route("POST", "/auth/refresh", "auth-service")

	// Health check
	gw.Route("GET", "/health", "gateway",
		gateway.WithHandler(healthHandler),
	)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"healthy"}`))
}

// RedisAPIKeyStore implements APIKeyStore using Redis
type RedisAPIKeyStore struct {
	client *redis.Client
}

func NewRedisAPIKeyStore(client *redis.Client) *RedisAPIKeyStore {
	return &RedisAPIKeyStore{client: client}
}

func (s *RedisAPIKeyStore) GetKey(ctx context.Context, key string) (*middleware.APIKey, error) {
	data, err := s.client.Get(ctx, "apikey:"+key).Bytes()
	if err != nil {
		return nil, err
	}

	var apiKey middleware.APIKey
	if err := json.Unmarshal(data, &apiKey); err != nil {
		return nil, err
	}

	return &apiKey, nil
}
```

### Junior -> FAANG: Reading Complete Examples as Study Material

The `main.go` in this section is the integration point where everything from the chapter comes together. When you study it, do not just read it linearly. Ask these questions about each section:

- Why is the `http.Server` configured with explicit timeouts instead of using the zero-value defaults? (Zero values mean no timeout, which allows slow clients to hold connections open indefinitely and eventually exhaust file descriptors.)
- Why does graceful shutdown use `context.WithTimeout(context.Background(), 30*time.Second)` rather than the request context? (Request context is canceled when the request ends. Shutdown needs its own deadline independent of any specific request.)
- Why are middleware registered in the order: tracing, logging, rate limiting, auth? (Outermost middleware runs first. Tracing must wrap everything so it captures total gateway time including auth and rate limit overhead. Auth must run before the handler to gate access.)

For interviews, be ready to walk through a request from when it hits the gateway to when the response is written. The `setupRoutes` function shows the per-route options pattern. A common interview follow-up is "how would you add a new middleware that only applies to certain routes?" The answer is: add a `RouteOption` that registers a route-level middleware list, then in `proxyRequest` run the route middleware after the global chain.

### Senior @ FAANG: Production Readiness Gaps in the Example

The `main.go` is a correct skeleton, but several production concerns are absent.

**Configuration management.** Service addresses, JWT secret, Redis URL, and listen address are read from environment variables. In production, secrets (JWT secret, Redis password, TLS keys) are injected via a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager) not plain environment variables. Plain env vars are visible in `ps aux` output and in many container inspection APIs. Use a secret manager client at startup to fetch secrets into memory, never write them to disk or log them.

**Health check depth.** The `healthHandler` returns a static JSON object. A production health check verifies connectivity to its own dependencies (Redis, Consul) and reports degraded status when they are unavailable. Kubernetes distinguishes liveness (is the process alive) from readiness (should traffic be sent). The gateway should return 200 to liveness always (if it is alive), but 503 to readiness when Redis or Consul is unreachable, so the load balancer removes it from rotation without killing the pod.

**TLS termination.** `server.ListenAndServe()` runs on plain HTTP. In production, `server.ListenAndServeTLS(certFile, keyFile)` terminates TLS at the gateway or, in a Kubernetes environment, TLS is terminated by an ingress controller or service mesh. If the gateway terminates TLS, use `crypto/tls` config with `MinVersion: tls.VersionTLS13` and `CurvePreferences` set to modern curves. Never use default `tls.Config` in production.

**Redis single-node dependency.** `redis.NewClient` connects to a single Redis node. If that node goes down, rate limiting fails. The `Allow` call falls back to permitting the request (fail open), which is correct but means the gateway has no rate limiting during Redis outages. Production uses Redis Cluster or Redis Sentinel for high availability. The `redis/go-redis/v9` package supports both modes transparently.

**Metrics cardinality.** The Prometheus counter labels include `r.URL.Path`. If clients send arbitrary paths (including path parameters like `/api/users/123456`), the metric has unbounded cardinality and will consume gigabytes of memory in the Prometheus server. Always normalize path labels to route patterns (`/api/users/:id`) before recording them. Store the matched route pattern in the request context during routing, and use that label value in metrics.

---
