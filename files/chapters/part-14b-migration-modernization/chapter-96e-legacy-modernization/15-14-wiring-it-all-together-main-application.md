## 14. Wiring It All Together: Main Application

This final section shows how all the components from the previous sections are assembled into a running application. The `main` function initializes the feature flag engine, defines routing rules that map URL patterns to flags, creates the strangler proxy with both legacy and new service URLs, and wires up the rollback controller for emergency use. The HTTP server exposes the proxy on the root path, a health check at `/healthz`, and a metrics endpoint. Graceful shutdown ensures that in-flight requests complete before the process exits.

```go
// file: cmd/migration-proxy/main.go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"syscall"
	"time"

	"github.com/example/gobook/internal/featureflags"
	"github.com/example/gobook/internal/metrics"
	"github.com/example/gobook/internal/proxy"
	"github.com/example/gobook/internal/rollback"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	m := metrics.NewMigrationMetrics()

	flagEngine, err := featureflags.NewEngine(
		os.Getenv("FLAG_CONFIG_PATH"),
		logger,
		m,
	)
	if err != nil {
		logger.Error("failed to initialize feature flags", "error", err)
		os.Exit(1)
	}

	userPathPattern := regexp.MustCompile(`^/v\d+/users/([^/]+)`)

	rules := []proxy.RouteRule{
		{
			Pattern:  regexp.MustCompile(`^/v\d+/users`),
			Methods:  []string{"GET", "POST", "PUT", "PATCH", "DELETE"},
			FlagName: featureflags.FlagNewUserService,
			EntityExtractor: proxy.ExtractUserIDFromPath(userPathPattern),
		},
		{
			Pattern:  regexp.MustCompile(`^/v\d+/orders`),
			Methods:  []string{"GET", "POST", "PUT"},
			FlagName: featureflags.FlagNewOrderService,
			EntityExtractor: proxy.ExtractUserIDFromHeader("X-User-ID"),
		},
	}

	stranglerProxy, err := proxy.NewStranglerProxy(
		proxy.Config{
			LegacyURL: mustEnv("LEGACY_SERVICE_URL"),
			NewURL:    mustEnv("NEW_SERVICE_URL"),
			Timeout:   30 * time.Second,
		},
		flagEngine,
		rules,
		logger,
		m,
	)
	if err != nil {
		logger.Error("failed to create strangler proxy", "error", err)
		os.Exit(1)
	}

	rollbackCtrl := rollback.NewController(flagEngine, logger, func(event rollback.RollbackEvent) {
		logger.Error("ROLLBACK ALERT",
			"flag", event.FlagName,
			"trigger", event.Trigger,
			"from_pct", event.FromPct,
			"notes", event.Notes,
		)
	})
	_ = rollbackCtrl // wire to admin endpoints in production

	mux := http.NewServeMux()
	mux.Handle("/", stranglerProxy)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		snapshot := m.Snapshot()
		logger.Info("migration metrics snapshot", "metrics", snapshot)
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         ":" + getEnv("PORT", "8080"),
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		logger.Info("strangler proxy started", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down proxy...")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
	logger.Info("proxy stopped")
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Default().Error("required environment variable not set", "key", key)
		os.Exit(1)
	}
	return v
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

### Junior → FAANG: The Main Function as Composition Root

The `main` function in a production Go application serves as the composition root: the single place where all dependencies are instantiated and wired together. The pattern in this implementation (construct each component, pass it to the next, wire into the HTTP server, register shutdown hooks) is the correct Go idiom for dependency injection without a framework. Understanding this pattern is a prerequisite for working on any non-trivial Go service.

The `getEnv` helper with a fallback value is a common pattern that deserves attention. Environment variables are the standard configuration mechanism for containerized services. Using fallback values means the application can run locally without any configuration, which lowers the barrier to running the service during development. For production, all configuration should be injected via environment variables, not hardcoded. This pattern is the simplest implementation of the twelve-factor app configuration principle.

For Go engineers: the `gracefulShutdown` goroutine pattern (listen for OS signal, then call `server.Shutdown`) is the correct way to handle graceful shutdown in Go HTTP servers. `server.Close()` immediately drops all connections. `server.Shutdown(ctx)` waits for in-flight requests to complete. Always use `Shutdown` with a timeout context in production, and ensure that all background goroutines (like the dual-write async processor) are also stopped during shutdown.

### Senior @ FAANG: Composition Root Governance and the Dependency Wiring Review

At senior level, the composition root is a governance document as much as code. Every dependency in the composition root represents an architectural decision: which implementation of an interface is used, how components are connected, and what happens when a dependency fails to initialize.

The governance concerns in the composition root: first, initialization order. Dependencies must be initialized in the correct order (stores before repositories, repositories before services, services before handlers). A composition root that fails to initialize should exit with a clear error message identifying which component failed and why. Using `log.Fatalf` for initialization failures is correct. Using `panic` is acceptable for programming errors (nil interface implementation) but not for configuration errors (missing environment variable).

Second, the composition root should make the migration state observable at startup. Logging the current feature flag values, the dual-write mode, and the traffic split percentage at startup ensures that every deployment's configuration is captured in the startup log. This makes it possible to reconstruct the exact configuration of any past deployment from log archives, which is required for post-incident analysis.

Third, the composition root is where the migration runbook lives in code. If a senior engineer reads only the `main` function, they should be able to understand: which components are active, how traffic is being split, which store is primary, and what the rollback mechanism is. If the `main` function is so abstracted that a senior engineer cannot answer these questions from reading it, it is over-engineered. The composition root should be explicit, readable, and representative of the system's current migration state.

At L6 and above, the composition root is often the artifact reviewed during architecture reviews and incident retrospectives because it is the authoritative description of how the system is assembled. Keeping it explicit and well-commented is not a style preference. It is an operational requirement.

---
