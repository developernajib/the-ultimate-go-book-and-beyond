## Part 10: Complete Working Example

Now it is time to wire everything together into a runnable application. This part shows the main entry point that initializes all services, the Docker Compose file for spinning up dependencies locally, the Dockerfile for building a production container, and the Kubernetes manifests for deploying to a cluster. By the end, you will be able to run the entire ML platform on your local machine with a single `docker compose up` command.

### 10.1 Main Application

The `main.go` file is the composition root of the platform. It reads configuration from environment variables, connects to PostgreSQL and Redis, initializes each service with its dependencies, registers HTTP and gRPC handlers, and starts the server with graceful shutdown support. This is where dependency injection happens in practice -- each service receives the interfaces it needs through constructor arguments rather than creating its own dependencies.

```go
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

	httpapi "ml-platform/internal/api/http"
	"ml-platform/internal/service/experiment"
	"ml-platform/internal/service/featurestore"
	"ml-platform/internal/service/monitoring"
	"ml-platform/internal/service/pipeline"
	"ml-platform/internal/service/registry"
	"ml-platform/internal/service/serving"
	"ml-platform/internal/storage"
	"ml-platform/internal/storage/migrations"
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
	pipelineService := pipeline.NewExecutor(pipelineStore, cfg.PipelineWorkers)
	monitoringService := monitoring.NewService(monitoringStore)

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
```

### 10.2 Docker Compose for Local Development

Docker Compose lets you run the platform and all its dependencies -- PostgreSQL, Redis, and MinIO -- in isolated containers with a single command. This eliminates the need to install and configure each dependency on your local machine. The configuration below maps container ports to localhost so you can access each service directly, and uses named volumes to persist data across restarts.

```yaml
# docker-compose.yml
name: ml-platform

services:
  postgres:
    image: timescale/timescaledb:latest-pg14
    environment:
      POSTGRES_USER: mlplatform
      POSTGRES_PASSWORD: password
      POSTGRES_DB: mlplatform
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mlplatform"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  mlplatform:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://mlplatform:password@postgres:5432/mlplatform?sslmode=disable
      REDIS_ADDR: redis:6379
      S3_ENDPOINT: minio:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin
      S3_BUCKET: ml-platform
      S3_USE_SSL: "false"
      HTTP_ADDR: ":8080"
      GRPC_ADDR: ":9090"
    ports:
      - "8080:8080"
      - "9090:9090"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

### 10.3 Dockerfile

The Dockerfile uses a multi-stage build to keep the final image small and secure. The first stage compiles the Go binary using the full Go toolchain image, while the second stage copies only the compiled binary into a minimal Alpine image. This reduces the final image size from several hundred megabytes down to roughly 20-30 MB, which speeds up deployments and reduces the attack surface in production.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git gcc musl-dev

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build application
RUN CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo -o mlplatform ./cmd/mlplatform

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/mlplatform .

# Expose ports
EXPOSE 8080 9090

CMD ["./mlplatform"]
```

### 10.4 Kubernetes Deployment

For production, Kubernetes provides automated scaling, self-healing, and rolling updates. The manifests below define a Deployment that runs multiple replicas of the platform behind a load balancer, with resource limits to prevent any single pod from consuming too much CPU or memory. Liveness and readiness probes tell Kubernetes when a pod is healthy and ready to receive traffic, ensuring that unhealthy instances are automatically restarted.

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mlplatform
  namespace: ml-platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mlplatform
  template:
    metadata:
      labels:
        app: mlplatform
    spec:
      containers:
      - name: mlplatform
        image: mlplatform:latest
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: grpc
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: mlplatform-secrets
              key: database-url
        - name: REDIS_ADDR
          value: redis-service:6379
        - name: S3_ENDPOINT
          value: minio-service:9000
        - name: S3_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: mlplatform-secrets
              key: s3-access-key
        - name: S3_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: mlplatform-secrets
              key: s3-secret-key
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5

---
apiVersion: v1
kind: Service
metadata:
  name: mlplatform-service
  namespace: ml-platform
spec:
  selector:
    app: mlplatform
  ports:
  - name: http
    port: 80
    targetPort: 8080
  - name: grpc
    port: 9090
    targetPort: 9090
  type: LoadBalancer

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: mlplatform-hpa
  namespace: ml-platform
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: mlplatform
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

---
