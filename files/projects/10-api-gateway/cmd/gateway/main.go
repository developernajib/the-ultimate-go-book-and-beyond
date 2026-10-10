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

	"github.com/example/api-gateway/internal/config"
	"github.com/example/api-gateway/internal/gateway"
	"github.com/example/api-gateway/internal/observability"

	// Import plugins to register them
	_ "github.com/example/api-gateway/internal/plugins/auth"
	_ "github.com/example/api-gateway/internal/plugins/cache"
	_ "github.com/example/api-gateway/internal/plugins/circuit"
	_ "github.com/example/api-gateway/internal/plugins/cors"
	_ "github.com/example/api-gateway/internal/plugins/ratelimit"
	_ "github.com/example/api-gateway/internal/plugins/requestid"
	_ "github.com/example/api-gateway/internal/plugins/transform"

	"go.uber.org/zap"
)

var (
	configFile = flag.String("config", "configs/gateway.yaml", "Path to config file")
	version    = "1.0.0"
)

func main() {
	flag.Parse()

	cfg, err := gateway.LoadConfig(*configFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

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

	if cfg.Metrics.Enabled {
		metrics := observability.NewMetrics(cfg.Metrics.Namespace)
		logger.Info("metrics enabled", zap.String("namespace", cfg.Metrics.Namespace))
		_ = metrics
	}

	if cfg.Tracing.Enabled {
		tp, err := observability.InitTracing(
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

	server, err := gateway.NewServer(cfg, logger)
	if err != nil {
		logger.Fatal("failed to create server", zap.Error(err))
	}

	reloadFunc := func(newCfg *gateway.Config) error {
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

	errChan := make(chan error, 2)

	go func() {
		if err := server.Start(); err != nil {
			errChan <- fmt.Errorf("gateway server: %w", err)
		}
	}()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errChan:
		logger.Error("server error", zap.Error(err))
	case sig := <-sigChan:
		logger.Info("received signal", zap.String("signal", sig.String()))
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(
		context.Background(),
		cfg.Server.ShutdownTimeout,
	)
	defer shutdownCancel()

	logger.Info("shutting down gracefully...")

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("gateway shutdown error", zap.Error(err))
	}

	logger.Info("shutdown complete")
}
