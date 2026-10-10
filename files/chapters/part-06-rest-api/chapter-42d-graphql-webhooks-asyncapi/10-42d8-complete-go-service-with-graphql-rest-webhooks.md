## 42D.8 Complete: Go Service with GraphQL + REST + Webhooks

This section ties together everything from the chapter into a single `main.go` that exposes GraphQL, REST, and webhook endpoints from one Go service. The router dispatches to each handler, background workers process webhook deliveries, and graceful shutdown drains in-flight requests before exiting.

```go
// main.go - unified multi-API service
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/99designs/gqlgen/graphql/handler/lru"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	"github.com/99designs/gqlgen/graphql/playground"
	coderws "github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/vektah/gqlparser/v2/ast"
)

// Origins permitted to open a GraphQL subscription. WebSockets are not
// covered by the same-origin policy and no CORS preflight guards them, so
// this list is the only thing standing between a cookie-authenticated
// socket and Cross-Site WebSocket Hijacking.
var allowedOrigins = []string{"app.example.com"}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Infrastructure
	db := mustConnectDB()
	defer db.Close()

	// Repositories
	userRepo := repo.NewUserRepository(db)
	orderRepo := repo.NewOrderRepository(db)

	// Webhook service
	webhookSvc := webhook.NewWebhookService(db, 20)
	if err := webhookSvc.LoadSubscriptions(context.Background()); err != nil {
		logger.Error("loading subscriptions", "error", err)
		os.Exit(1)
	}

	// GraphQL server
	gqlResolver := &graph.Resolver{
		UserRepo:   userRepo,
		OrderRepo:  orderRepo,
		WebhookSvc: webhookSvc,
	}

	// handler.New, not handler.NewDefaultServer: the latter is deprecated as
	// "not suitable for production use", and it silently pre-registers its
	// own transports. Since gqlgen dispatches to the FIRST transport that
	// Supports() the request, anything you add afterwards that duplicates a
	// built-in one is dead code.
	gqlSrv := handler.New(
		generated.NewExecutableSchema(generated.Config{
			Resolvers: gqlResolver,
		}),
	)

	gqlSrv.AddTransport(transport.Options{})
	gqlSrv.AddTransport(transport.POST{})
	gqlSrv.AddTransport(transport.Websocket{
		KeepAlivePingInterval: 10 * time.Second,
		InitTimeout:           10 * time.Second,
		Implementation: transport.CoderWebsocketImplementation{
			AcceptOptions: coderws.AcceptOptions{
				OriginPatterns: allowedOrigins,
			},
		},
	})

	gqlSrv.SetQueryCache(lru.New[*ast.QueryDocument](1000))
	gqlSrv.Use(extension.FixedComplexityLimit(200))

	// extension.Introspection is an empty struct with no Enabled field:
	// you enable it by registering it, and disable it by not registering it.
	if os.Getenv("ENV") != "production" {
		gqlSrv.Use(extension.Introspection{})
	}

	// REST handlers
	userHandler := rest.NewUserHandler(userRepo)
	orderHandler := rest.NewOrderHandler(orderRepo, webhookSvc)
	webhookMgmtHandler := webhook.NewManagementHandler(webhookSvc)

	// Router
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(securityHeadersMiddleware)

	// REST v2
	r.Route("/api/v2", func(r chi.Router) {
		r.Use(authMiddleware)
		r.Use(DeprecationMiddleware)
		r.Mount("/users", userHandler.Routes())
		r.Mount("/orders", orderHandler.Routes())
	})

	// Legacy v1 - deprecated, sunset September 2026
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(authMiddleware)
		r.Use(DeprecationMiddleware)
		r.Mount("/users", legacyUserHandler.Routes())
	})

	// GraphQL API
	r.Route("/graphql", func(r chi.Router) {
		r.Use(dataloader.Middleware(userRepo, orderRepo))
		r.Use(authMiddleware)
		r.Handle("/", gqlSrv)
	})

	// GraphQL Playground (dev only)
	if os.Getenv("ENV") != "production" {
		r.Handle("/playground", playground.Handler("GraphQL Playground", "/graphql"))
	}

	// Webhook management API
	r.Route("/webhooks", func(r chi.Router) {
		r.Use(authMiddleware)
		r.Mount("/", webhookMgmtHandler.Routes())
	})

	// Inbound webhook receivers (from third parties)
	inboundHandler := webhook.NewInboundHandler(
		os.Getenv("STRIPE_WEBHOOK_SECRET"),
		os.Getenv("GITHUB_WEBHOOK_SECRET"),
	)
	r.Post("/inbound/stripe", inboundHandler.HandleStripe)
	r.Post("/inbound/github", inboundHandler.HandleGitHub)

	// Health checks
	r.Get("/health/live", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.Get("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := db.PingContext(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start background workers
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		if err := webhookSvc.StartDeliveryWorker(ctx); err != nil && err != context.Canceled {
			logger.Error("webhook delivery worker error", "error", err)
		}
	}()

	// Refresh subscriptions every 30 seconds
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := webhookSvc.LoadSubscriptions(ctx); err != nil {
					logger.Error("refreshing subscriptions", "error", err)
				}
			}
		}
	}()

	// Start HTTP server
	go func() {
		logger.Info("server starting", "addr", srv.Addr, "env", os.Getenv("ENV"))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutdown signal received")
	cancel() // Stop background workers

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("server forced shutdown", "error", err)
	}
	logger.Info("server exited cleanly")
}

// Security headers middleware
func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}
```

---

### Junior → FAANG: Reading a Multi-Protocol Service and What to Study First

A `main.go` that wires up GraphQL, REST, webhooks, and background workers in one binary is dense. Reading it effectively requires a mental model for what each section is responsible for and why those concerns are separated.

**The dependency initialization order matters.** Infrastructure (database connection) is initialized first. Repositories wrap the infrastructure and are initialized next. Services depend on repositories. Handlers depend on services. Background workers depend on services. This order is not accidental. It enforces the dependency inversion principle at startup time: high-level components (handlers) depend on abstractions (repository interfaces), not on concrete infrastructure. If your `main.go` initializes a handler before its repository, you have a wiring bug waiting to surface.

**Graceful shutdown is a correctness requirement, not a polish item.** The shutdown sequence in this example: stop accepting new requests, cancel background workers, wait for in-flight requests to complete, then exit. Skipping this on Kubernetes means pods killed during a rolling deploy leave in-flight webhook deliveries orphaned. The database connection pool closing before in-flight requests complete causes panics. Graceful shutdown is the difference between "this deploy was invisible to users" and "we saw a spike of 500s during every release."

**Health check distinction.** Liveness (`/health/live`) tells Kubernetes whether the process is alive. Readiness (`/health/ready`) tells it whether the process can serve traffic. The readiness check pings the database. If the database is unavailable, the pod is removed from the load balancer but not restarted. This is the correct behavior: restarting a pod cannot fix a database outage. Getting this wrong causes cascading restarts during database maintenance windows.

**Interview entry point.** Being able to walk through a `main.go` like this in a system design interview and explain each section's purpose, including why graceful shutdown is structured the way it is, is a strong signal of production experience. Interviewers listen for whether you understand the "why" behind each wiring decision.

**First-job habits.** When you add a new route, also add the corresponding readiness check dependencies and structured log fields. New routes that are invisible to health checks and monitoring are technical debt from their first deployment.

---

### Senior @ FAANG: Multi-Protocol Service Architecture and Operational Maturity

The `main.go` in this section is functional but represents a starting point, not an endpoint. Senior engineers evaluate it against operational requirements that only become visible after the service reaches production at scale.

**Architectural Decision Record: monolithic multi-protocol binary vs. protocol-per-service.**
Running GraphQL, REST, and webhook delivery in a single binary is operationally simpler: one deploy unit, one log stream, one set of Kubernetes manifests. The tradeoffs are: you cannot scale GraphQL independently of webhook delivery (a query storm forces you to over-provision delivery workers and vice versa), a panic in the webhook delivery goroutine brings down the REST and GraphQL paths, and the blast radius of a bad deploy covers all three protocols simultaneously. The counter-argument is that premature decomposition creates distributed systems overhead before the traffic justifies it. The correct decision depends on measured traffic ratios and the maturity of the team's operational tooling. Document this in an ADR and revisit when any single protocol's resource consumption exceeds 40% of the total.

**Context propagation and distributed tracing.** The middleware stack in this example uses `middleware.RequestID`, which generates a per-request ID. At FAANG scale, this is not enough. Every incoming request must extract an existing trace context (from `traceparent` headers per W3C Trace Context) or start a new trace, and that context must flow through every downstream database call, external HTTP call, and goroutine spawned from the handler. Without this, correlating a slow GraphQL query with the database queries it triggered requires log correlation by timestamp, which is fragile under concurrent load. Add OpenTelemetry instrumentation at the middleware layer and pass the context through every function that does I/O.

**Background goroutine supervision.** The delivery worker and subscription refresh goroutines in this example exit silently on error (after logging). In a production service, silent goroutine exit means the webhook delivery system stops working until the pod is restarted. Use a supervisor pattern: wrap background goroutines in a restart loop with exponential backoff and emit a metric on each restart. Alert when a goroutine has restarted more than N times in a window. The Go `golang.org/x/sync/errgroup` package gives you coordinated cancellation, but it does not give you restart semantics. You need a thin supervisor on top.

**Configuration management at scale.** The `main.go` reads configuration from environment variables directly. For a service running in multiple environments with dozens of configuration values, this becomes difficult to audit and validate at startup. A configuration struct populated from environment variables, with explicit validation (non-empty required values, valid URLs for external services, positive integers for worker counts) and logged at startup, gives you a startup-time failure rather than a runtime panic or silent misconfiguration. At L6, you move this to a typed config library with schema validation and vault integration for secrets.

**Zero-downtime deploy requirements.** Rolling deploys on Kubernetes require that the old and new version of the service can run simultaneously. For this service, that means: the GraphQL schema must be backward compatible across the deploy window, the webhook delivery table's schema must be compatible with both versions' code, and the subscription cache refresh interval must not cause a thundering herd when 10 new pods all refresh simultaneously. The 30-second refresh ticker does not add jitter. Under a rolling deploy with 10 pods, this means 10 simultaneous database queries every 30 seconds. Add `time.Sleep(time.Duration(rand.Intn(30)) * time.Second)` before the first tick to spread the load.

**Staff-level concern: service ownership and on-call ergonomics.** A service that combines GraphQL, REST, and webhook delivery in one binary has one on-call rotation. When a 3am alert fires, the on-call engineer must be familiar with all three protocols and their failure modes. At staff level, the architectural question is whether this is the right organizational boundary or whether the operational complexity justifies splitting protocols to match team ownership. This is not a purely technical decision: it involves team topology, on-call load distribution, and the cognitive overhead of context-switching between protocol failure modes at 3am.
