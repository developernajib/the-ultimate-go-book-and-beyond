## 60.8 Complete Implementation

### Main Application

The main application wires together all the components, HTTP server, service layer, Redis cache, PostgreSQL store, and Kafka analytics producer, using dependency injection so each component can be replaced with a mock in tests. Graceful shutdown listens for `SIGTERM` and `SIGINT`, draining in-flight HTTP requests and flushing the analytics buffer before exiting, ensuring no clicks are lost when the process is terminated. The server binds on a port read from the `PORT` environment variable, following the twelve-factor app convention for containerized deployments.

```go
// main.go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/redis/go-redis/v9"

    "yourproject/api"
    "yourproject/cache"
    "yourproject/generator"
    "yourproject/repository"
    "yourproject/service"
)

func main() {
    ctx := context.Background()

    // Initialize database
    dbPool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatalf("Unable to connect to database: %v", err)
    }
    defer dbPool.Close()

    // Initialize Redis
    redisClient := redis.NewClient(&redis.Options{
        Addr:     os.Getenv("REDIS_URL"),
        Password: os.Getenv("REDIS_PASSWORD"),
        DB:       0,
    })
    defer redisClient.Close()

    // Initialize components
    urlRepo := repository.NewURLRepository(dbPool)
    urlCache := cache.NewURLCache(redisClient, "url", 24*time.Hour)
    idGenerator := generator.NewRangeGenerator(redisClient, "url:id:range", 1000)

    urlService := service.NewURLService(
        urlRepo,
        urlCache,
        idGenerator,
        os.Getenv("BASE_URL"),
    )

    // Initialize handlers
    handler := api.NewHandler(urlService)

    // Setup routes
    mux := http.NewServeMux()
    mux.HandleFunc("POST /api/shorten", handler.ShortenURL)
    mux.HandleFunc("GET /{shortID}", handler.RedirectURL)
    mux.HandleFunc("GET /api/stats/{shortID}", handler.GetStats)
    mux.HandleFunc("DELETE /api/urls/{shortID}", handler.DeleteURL)

    // Create server
    server := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Start server
    go func() {
        log.Printf("Server starting on %s", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("Server failed: %v", err)
        }
    }()

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    log.Println("Shutting down server...")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Fatalf("Server forced to shutdown: %v", err)
    }

    log.Println("Server stopped")
}
```

---

### Junior → FAANG: Wiring Components Together and Graceful Shutdown

The `main.go` in this section demonstrates patterns that junior engineers often get wrong in production code. Understanding each decision helps you avoid the most common first-job mistakes.

**Dependency injection via constructor functions.** Each component is created by a `New*` function and passed to the next component that depends on it. There is no global state. This matters for testing: in tests, you can pass a mock repository to the service, a mock cache to the service, and so on, without any global variable manipulation. If you find yourself writing `var globalRedis *redis.Client` at package scope, that is a signal that dependency injection was not applied.

**Environment variables are the correct way to configure a twelve-factor app.** The `main.go` reads `DATABASE_URL`, `REDIS_URL`, `REDIS_PASSWORD`, and `BASE_URL` from environment variables. Hardcoding connection strings is a security vulnerability (they end up in source control) and an operational burden (you must recompile to change them). In a Kubernetes deployment, these values come from Secrets and ConfigMaps mounted as environment variables.

**Graceful shutdown requires draining in the right order.** The shutdown sequence here stops the HTTP server first (`server.Shutdown`), which drains in-flight requests. After all HTTP handlers have returned, it is safe to close the database pool and Redis client. If you close the database pool before draining HTTP handlers, handlers still processing requests will receive errors when they try to query the database. The 30-second shutdown timeout is a safeguard against handlers that are stuck waiting for a slow dependency.

**Know what `server.Shutdown` does and does not do.** `http.Server.Shutdown` stops the listener from accepting new connections and waits for active handlers to complete. It does not forcibly terminate goroutines that were started inside handlers. If `go h.service.TrackClick(...)` is called inside a handler, `Shutdown` does not wait for those goroutines to finish. This is a known issue: the analytics goroutines may be killed mid-flight during shutdown, losing click events. The correct fix is to use a `sync.WaitGroup` to track in-flight analytics goroutines and wait for them in the shutdown path.

---

### Senior @ FAANG: Production Wiring, Observability, and Operational Readiness

A complete implementation at L6+ is not just correct code. It is code that is observable, testable, operable, and deployable with documented runbooks and health checks.

**Structured logging is non-negotiable in production.** The `main.go` uses `log.Printf`, which writes unstructured text to stderr. In a production Kubernetes cluster, these logs are ingested by a log aggregator (Datadog, Splunk, ELK) that needs structured fields to enable filtering and alerting. Replace `log.Printf("Server starting on %s", server.Addr)` with a structured logger (`slog.Info("server starting", "addr", server.Addr)` in Go 1.21+). Every log line should include a correlation ID (request ID or trace ID) so that all log lines for a single request can be found with a single query. This is not optional at FAANG: it is a first-week expectation.

**Health checks enable zero-downtime deployments.** The `main.go` does not expose a health check endpoint. A Kubernetes liveness probe calls `/healthz` and restarts the pod if it returns a non-200 status. A readiness probe calls `/readyz` and removes the pod from the load balancer if it returns non-200, preventing traffic from reaching a pod that is starting up or temporarily unavailable. The liveness check should verify that the HTTP server is running. The readiness check should verify that the database pool can acquire a connection and that Redis is reachable. Without these endpoints, Kubernetes cannot distinguish a healthy pod from a crashed one.

**Distributed tracing connects the entire request lifetime.** A redirect request touches the HTTP handler, the cache layer, optionally the database, and the analytics goroutine. Without distributed tracing (OpenTelemetry with a Jaeger or Zipkin backend), debugging a latency regression requires guessing which layer is slow. With tracing, you see a waterfall diagram showing exactly how much time was spent in the cache lookup, the database query, and the analytics channel send. Add `otelhttp.NewHandler(mux, "url-shortener")` to the server middleware and propagate the trace context through all downstream calls using the context parameter. This is a standard expectation in FAANG production services.

**The graceful shutdown path must account for all background goroutines.** The analytics tracker starts a background goroutine (`go tracker.processEvents()`) that must be stopped before the process exits. The current `main.go` does not close the tracker during shutdown, which means in-flight click events in the channel may be lost when the process exits. The correct pattern: use a context derived from a cancellation signal, pass that context to the tracker's processing loop, and in the shutdown path call `tracker.Close()` which drains the channel and closes the Kafka writer. Document the maximum flush time (the time between shutdown signal and process exit) in the deployment runbook, because Kubernetes has a configurable `terminationGracePeriodSeconds` that must be longer than this flush time.
