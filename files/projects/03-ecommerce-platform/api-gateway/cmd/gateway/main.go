// Package main is the entry point for the e-commerce platform API gateway.
// Run this to start the REST API gateway that routes requests to backend gRPC services.
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

	"github.com/example/ecommerce-platform/api-gateway/internal/clients"
	"github.com/example/ecommerce-platform/api-gateway/internal/handlers"
	"github.com/example/ecommerce-platform/api-gateway/internal/router"
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

	// Initialize clients
	productServiceAddr := getEnv("PRODUCT_SERVICE_ADDR", "localhost:50051")
	productClient := clients.NewProductClient(productServiceAddr)

	// Initialize handlers
	productHandler := handlers.NewProductHandler(productClient, logger)
	cartHandler := handlers.NewCartHandler(logger)
	orderHandler := handlers.NewOrderHandler(logger)
	paymentHandler := handlers.NewPaymentHandler(logger)

	// Create router
	r := router.NewRouter(productHandler, cartHandler, orderHandler, paymentHandler, logger)

	// Start HTTP server
	port := getEnv("HTTP_PORT", "8080")
	server := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("starting API gateway", zap.String("port", port))
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
