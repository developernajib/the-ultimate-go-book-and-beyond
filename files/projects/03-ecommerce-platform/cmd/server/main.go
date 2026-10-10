// Package main is the root entry point for the e-commerce platform.
// It starts all services in a single process for development/demo purposes.
// In production, each service would be run as its own binary.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/example/ecommerce-platform/pkg/logging"
)

func main() {
	logger := logging.Default()
	defer logging.Sync()

	if err := run(logger); err != nil {
		logger.Fatal("application failed", zap.Error(err))
	}
}

func run(logger *zap.Logger) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	port := getEnv("HTTP_PORT", "8080")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"status":"healthy","service":"ecommerce-platform"}`)
	})

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("starting server", zap.String("port", port))
		serverErrors <- server.ListenAndServe()
	}()

	shutdownCh := make(chan os.Signal, 1)
	signal.Notify(shutdownCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serverErrors:
		return fmt.Errorf("server error: %w", err)
	case sig := <-shutdownCh:
		logger.Info("shutdown signal received", zap.String("signal", sig.String()))

		shutdownCtx, shutdownCancel := context.WithTimeout(ctx, 30*time.Second)
		defer shutdownCancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("server shutdown: %w", err)
		}

		logger.Info("server stopped gracefully")
	}

	return nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
