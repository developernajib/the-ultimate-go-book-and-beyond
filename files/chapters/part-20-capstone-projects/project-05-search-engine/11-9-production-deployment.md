## 9. Production Deployment

With every core component in place, it is time to wire everything together into a runnable binary. The main server initializes the English text analyzer, creates the inverted index and BM25 scorer, and starts the REST API. It also listens for OS interrupt signals (SIGINT/SIGTERM) so the process shuts down gracefully, flushing any buffered data before exiting. This pattern is standard for long-running Go services in production.

### 9.1 Main Server

The main entry point composes all application components, initializes dependencies in correct order, and starts the server. Graceful shutdown handling allows in-flight requests to complete and resources to be released cleanly when the process receives a termination signal.

```go
// cmd/server/main.go
package main

import (
    "context"
    "flag"
    "os"
    "os/signal"
    "syscall"

    "go.uber.org/zap"
    "github.com/yourorg/gosearch/internal/analyzer"
    "github.com/yourorg/gosearch/internal/api/rest"
    "github.com/yourorg/gosearch/internal/index/inverted"
    "github.com/yourorg/gosearch/internal/query/executor"
    "github.com/yourorg/gosearch/internal/ranking"
)

func main() {
    addr := flag.String("addr", ":8080", "HTTP server address")
    flag.Parse()

    // Setup logger
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    // Create index
    logger.Info("Initializing search engine")
    index := inverted.NewInvertedIndex(analyzer.NewEnglishAnalyzer())

    // Create scorer and executor
    scorer := ranking.NewBM25Scorer(index)
    exec := executor.NewExecutor(index, scorer)

    // Start REST API server
    server := rest.NewServer(*addr, exec, logger)

    // Handle graceful shutdown
    go func() {
        if err := server.Start(); err != nil {
            logger.Fatal("Server failed", zap.Error(err))
        }
    }()

    logger.Info("GoSearch server started", zap.String("addr", *addr))

    // Wait for interrupt signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    logger.Info("Shutting down server...")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        logger.Error("Server shutdown failed", zap.Error(err))
    }

    logger.Info("Server stopped")
}
```

### Junior → FAANG: Signal Handling as a Production Requirement

Graceful shutdown (listening for SIGTERM, completing in-flight requests, flushing buffered data) is a first-job discipline that separates a production-ready service from a development script. A search server that exits abruptly on SIGTERM may corrupt its index file if a write was in progress. A server that handles SIGTERM gracefully closes the HTTP listener (stops accepting new requests), waits for in-flight requests to complete, and then flushes and closes the index.

The standard Go pattern (`signal.NotifyContext` or `signal.Notify`) for signal handling is straightforward. Know it and use it for every long-running Go service. The common mistake is using `os.Exit(1)` in a signal handler, which bypasses defer functions and flush logic.

For deployment, the main entry point is also where you initialize all dependencies and handle startup failures. If the index file is corrupted, the server should exit with a non-zero exit code and a clear error message rather than starting in a degraded state.

### Senior @ FAANG: Production Entry Point as an Observability Hook

At senior level, the main function is the right place to initialize all observability infrastructure before anything else: structured logging (with service name, version, and environment), Prometheus metrics registration, and distributed tracing initialization (OpenTelemetry exporter configuration). These must be initialized before any business logic runs, so that all logs and metrics from startup are captured.

Startup probes (separate from readiness probes in Kubernetes) are useful for services with long initialization times: a search engine loading a large index from disk may take 30-60 seconds before it is ready to serve queries. A startup probe (with a longer timeout than a readiness probe) prevents Kubernetes from prematurely killing an initializing pod. Configure startup probes with a `failureThreshold * periodSeconds` that exceeds the expected maximum initialization time.

Hot standby for the search index enables zero-downtime index updates. Instead of reloading the index in-place (which would require taking the server offline), a hot standby approach runs two search server instances: one serving traffic, one loading the new index. When the new index is loaded and verified, traffic is shifted to the new instance and the old one is retired. Implementing this as a deployment strategy (Kubernetes blue-green deployment) requires the index file to be accessible to both instances (shared volume or object storage).

---
