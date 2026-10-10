package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	"github.com/example/ecommerce-platform/pkg/database"
	"github.com/example/ecommerce-platform/pkg/logging"
	"github.com/example/ecommerce-platform/pkg/tracing"
	grpcserver "github.com/example/ecommerce-platform/services/product/internal/grpc"
	"github.com/example/ecommerce-platform/services/product/internal/repository"
	"github.com/example/ecommerce-platform/services/product/internal/service"
	pb "github.com/example/ecommerce-platform/services/product/proto"
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

	// Initialize tracing
	tracingShutdown, err := tracing.InitTracer(tracing.Config{
		ServiceName:    "product-service",
		ServiceVersion: "1.0.0",
		JaegerEndpoint: getEnv("JAEGER_ENDPOINT", "http://localhost:14268/api/traces"),
		Environment:    getEnv("ENVIRONMENT", "development"),
	})
	if err != nil {
		return fmt.Errorf("initializing tracer: %w", err)
	}
	defer tracingShutdown(ctx)

	// Connect to database
	dbConfig := database.Config{
		Host:     getEnv("DB_HOST", "localhost"),
		Port:     5432,
		User:     getEnv("DB_USER", "postgres"),
		Password: getEnv("DB_PASSWORD", "postgres"),
		Database: getEnv("DB_NAME", "product_db"),
	}

	pool, err := database.NewPostgresPool(ctx, dbConfig)
	if err != nil {
		return fmt.Errorf("connecting to database: %w", err)
	}
	defer pool.Close()

	logger.Info("connected to database",
		zap.String("host", dbConfig.Host),
		zap.String("database", dbConfig.Database),
	)

	// Initialize repositories
	productRepo := repository.NewProductRepository(pool)
	inventoryRepo := repository.NewInventoryRepository(pool)
	categoryRepo := repository.NewCategoryRepository(pool)

	// Initialize service
	productService := service.NewProductService(productRepo, inventoryRepo, categoryRepo)

	// Create gRPC server
	grpcServer := grpc.NewServer(
		grpc.UnaryInterceptor(loggingInterceptor(logger)),
	)

	// Register services
	pb.RegisterProductServiceServer(grpcServer, grpcserver.NewServer(productService))
	grpc_health_v1.RegisterHealthServer(grpcServer, health.NewServer())
	reflection.Register(grpcServer)

	// Start gRPC server
	port := getEnv("GRPC_PORT", "50051")
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return fmt.Errorf("creating listener: %w", err)
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("starting gRPC server", zap.String("port", port))
		serverErrors <- grpcServer.Serve(listener)
	}()

	// Start cleanup goroutine for expired reservations
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := inventoryRepo.CleanupExpiredReservations(ctx); err != nil {
					logger.Error("cleaning up expired reservations", zap.Error(err))
				}
			}
		}
	}()

	// Wait for shutdown signal
	shutdownCh := make(chan os.Signal, 1)
	signal.Notify(shutdownCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serverErrors:
		return fmt.Errorf("server error: %w", err)
	case sig := <-shutdownCh:
		logger.Info("shutdown signal received", zap.String("signal", sig.String()))
		grpcServer.GracefulStop()
		logger.Info("server stopped")
	}

	return nil
}

func loggingInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		duration := time.Since(start)
		logger.Info("gRPC request",
			zap.String("method", info.FullMethod),
			zap.Duration("duration", duration),
			zap.Error(err),
		)
		return resp, err
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
