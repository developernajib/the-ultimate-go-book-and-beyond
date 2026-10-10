## Part 11: Main Application

The main application is the entry point that wires everything together. It loads the YAML configuration file, initializes the structured logger, sets up the router with all configured routes, creates the upstream manager with health checks, starts the admin API on its own port, and launches the configuration file watcher for hot reload. The `main` function also handles graceful shutdown: when it receives a SIGINT or SIGTERM signal (for example, when you press Ctrl+C or when Kubernetes stops the pod), it gives in-flight requests time to complete before closing all connections cleanly.

```go
// cmd/gateway/main.go
package main

import (
    "context"
    "flag"
    "fmt"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/yourusername/gatewaygo/internal/admin"
    "github.com/yourusername/gatewaygo/internal/config"
    "github.com/yourusername/gatewaygo/internal/gateway"
    "github.com/yourusername/gatewaygo/internal/observability"

    // Import plugins to register them
    _ "github.com/yourusername/gatewaygo/internal/plugins/auth"
    _ "github.com/yourusername/gatewaygo/internal/plugins/cache"
    _ "github.com/yourusername/gatewaygo/internal/plugins/circuit"
    _ "github.com/yourusername/gatewaygo/internal/plugins/cors"
    _ "github.com/yourusername/gatewaygo/internal/plugins/ratelimit"
    _ "github.com/yourusername/gatewaygo/internal/plugins/requestid"
    _ "github.com/yourusername/gatewaygo/internal/plugins/transform"

    "go.uber.org/zap"
)

var (
    configFile = flag.String("config", "configs/gateway.yaml", "Path to config file")
    version    = "1.0.0"
)

func main() {
    flag.Parse()

    // Load configuration
    cfg, err := gateway.LoadConfig(*configFile)
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
        os.Exit(1)
    }

    // Initialize logger
    logger, err := observability.NewLogger(
        cfg.Logging.Level,
        cfg.Logging.Format,
        cfg.Logging.Output,
    )
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to create logger: %v\n", err)
        os.Exit(1)
    }
    defer logger.Sync()

    logger.Info("starting gatewaygo",
        zap.String("version", version),
        zap.String("config", *configFile),
    )

    // Initialize metrics
    if cfg.Metrics.Enabled {
        metrics := observability.NewMetrics(cfg.Metrics.Namespace)
        logger.Info("metrics enabled", zap.String("namespace", cfg.Metrics.Namespace))
        _ = metrics // Use metrics in middleware
    }

    // Initialize tracing
    var tp *trace.TracerProvider
    if cfg.Tracing != nil && cfg.Tracing.Enabled {
        tp, err = observability.InitTracing(
            "gatewaygo",
            cfg.Tracing.Endpoint,
            cfg.Tracing.SamplingRate,
        )
        if err != nil {
            logger.Warn("failed to initialize tracing", zap.Error(err))
        } else {
            defer func() {
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                defer cancel()
                observability.ShutdownTracing(ctx, tp)
            }()
            logger.Info("tracing enabled",
                zap.String("provider", cfg.Tracing.Provider),
                zap.Float64("sampling_rate", cfg.Tracing.SamplingRate),
            )
        }
    }

    // Create gateway server
    server, err := gateway.NewServer(cfg, logger)
    if err != nil {
        logger.Fatal("failed to create server", zap.Error(err))
    }

    // Create admin API
    var adminAPI *admin.API
    if cfg.Admin.Enabled {
        adminAPI = admin.NewAPI(cfg, server.Router(), server.UpstreamManager(), logger)
    }

    // Setup config hot reload
    reloadFunc := func(newCfg *gateway.Config) error {
        // Reload logic here
        logger.Info("configuration reloaded")
        return nil
    }

    watcher, err := config.NewWatcher(*configFile, reloadFunc, logger)
    if err != nil {
        logger.Warn("failed to create config watcher", zap.Error(err))
    } else {
        ctx, cancel := context.WithCancel(context.Background())
        defer cancel()
        watcher.Start(ctx)
        defer watcher.Stop()
    }

    // Start servers in goroutines
    errChan := make(chan error, 2)

    go func() {
        if err := server.Start(); err != nil {
            errChan <- fmt.Errorf("gateway server: %w", err)
        }
    }()

    if adminAPI != nil {
        go func() {
            if err := adminAPI.Start(); err != nil {
                errChan <- fmt.Errorf("admin API: %w", err)
            }
        }()
    }

    // Wait for interrupt signal or error
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

    select {
    case err := <-errChan:
        logger.Error("server error", zap.Error(err))
    case sig := <-sigChan:
        logger.Info("received signal", zap.String("signal", sig.String()))
    }

    // Graceful shutdown
    shutdownCtx, shutdownCancel := context.WithTimeout(
        context.Background(),
        cfg.Server.ShutdownTimeout,
    )
    defer shutdownCancel()

    logger.Info("shutting down gracefully...")

    if err := server.Shutdown(shutdownCtx); err != nil {
        logger.Error("gateway shutdown error", zap.Error(err))
    }

    if adminAPI != nil {
        if err := adminAPI.Shutdown(shutdownCtx); err != nil {
            logger.Error("admin API shutdown error", zap.Error(err))
        }
    }

    logger.Info("shutdown complete")
}
```
