// cmd/mlplatform/main.go
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-redis/redis/v8"
	_ "github.com/lib/pq"

	httpapi "github.com/example/ml-platform/internal/api/http"
	"github.com/example/ml-platform/internal/service/experiment"
	"github.com/example/ml-platform/internal/service/featurestore"
	"github.com/example/ml-platform/internal/service/monitoring"
	"github.com/example/ml-platform/internal/service/pipeline"
	"github.com/example/ml-platform/internal/service/registry"
	"github.com/example/ml-platform/internal/service/serving"
	"github.com/example/ml-platform/internal/storage"
	"github.com/example/ml-platform/internal/storage/migrations"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("Application failed: %v", err)
	}
}

func run() error {
	// Load configuration
	cfg := loadConfig()

	// Initialize database
	db, err := initDatabase(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("initializing database: %w", err)
	}
	defer db.Close()

	// Run migrations
	if err := migrations.RunMigrations(db); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}

	// Initialize Redis
	redisClient := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       0,
	})
	defer redisClient.Close()

	// Initialize S3/MinIO for artifact storage
	artifactStore, err := storage.NewS3ArtifactStore(
		cfg.S3Endpoint,
		cfg.S3AccessKey,
		cfg.S3SecretKey,
		cfg.S3Bucket,
		"ml-artifacts",
		cfg.S3UseSSL,
	)
	if err != nil {
		return fmt.Errorf("initializing artifact store: %w", err)
	}

	// Initialize storage layers
	experimentStore := storage.NewPostgresExperimentStore(db)
	metricStore := storage.NewPostgresMetricStore(db)
	modelStore := storage.NewPostgresModelStore(db)
	featureStore := storage.NewPostgresFeatureStore(db)
	pipelineStore := storage.NewPostgresPipelineStore(db)
	monitoringStore := storage.NewPostgresMonitoringStore(db)

	// Initialize event bus (could be Kafka, NATS, etc.)
	eventBus := &SimpleEventBus{}

	// Initialize services
	experimentService := experiment.NewService(experimentStore, artifactStore, metricStore)
	registryService := registry.NewService(modelStore, artifactStore, eventBus)
	servingService := serving.NewService(modelStore, artifactStore)
	featureStoreService := featurestore.NewService(featureStore, redisClient, nil)
	_ = pipeline.NewExecutor(pipelineStore, cfg.PipelineWorkers)
	_ = monitoring.NewService(monitoringStore)

	// Initialize HTTP server
	httpServer := httpapi.NewServer(
		experimentService,
		registryService,
		servingService,
		featureStoreService,
	)

	// Start HTTP server
	srv := &http.Server{
		Addr:    cfg.HTTPAddr,
		Handler: httpServer,
	}

	// Start server in goroutine
	go func() {
		log.Printf("Starting HTTP server on %s", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server failed: %v", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("server shutdown failed: %w", err)
	}

	log.Println("Server stopped")
	return nil
}

type Config struct {
	DatabaseURL     string
	RedisAddr       string
	RedisPassword   string
	S3Endpoint      string
	S3AccessKey     string
	S3SecretKey     string
	S3Bucket        string
	S3UseSSL        bool
	HTTPAddr        string
	GRPCAddr        string
	PipelineWorkers int
}

func loadConfig() Config {
	return Config{
		DatabaseURL:     getEnv("DATABASE_URL", "postgres://mlplatform:password@localhost:5432/mlplatform?sslmode=disable"),
		RedisAddr:       getEnv("REDIS_ADDR", "localhost:6379"),
		RedisPassword:   getEnv("REDIS_PASSWORD", ""),
		S3Endpoint:      getEnv("S3_ENDPOINT", "localhost:9000"),
		S3AccessKey:     getEnv("S3_ACCESS_KEY", "minioadmin"),
		S3SecretKey:     getEnv("S3_SECRET_KEY", "minioadmin"),
		S3Bucket:        getEnv("S3_BUCKET", "ml-platform"),
		S3UseSSL:        getEnv("S3_USE_SSL", "false") == "true",
		HTTPAddr:        getEnv("HTTP_ADDR", ":8080"),
		GRPCAddr:        getEnv("GRPC_ADDR", ":9090"),
		PipelineWorkers: 10,
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func initDatabase(connString string) (*sql.DB, error) {
	db, err := sql.Open("postgres", connString)
	if err != nil {
		return nil, err
	}

	// Configure connection pool
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	return db, nil
}

// SimpleEventBus is a basic in-memory event bus
type SimpleEventBus struct{}

func (e *SimpleEventBus) Publish(event any) error {
	// In production, this would publish to Kafka, NATS, etc.
	log.Printf("Event published: %T", event)
	return nil
}
