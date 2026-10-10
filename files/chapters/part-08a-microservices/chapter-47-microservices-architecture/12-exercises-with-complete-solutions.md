## 47.10 Exercises with Complete Solutions

### Exercise 1: Build a Complete Microservice

Build a production-ready user service that integrates gRPC and HTTP transport, Consul service discovery, Kafka event publishing, and OpenTelemetry observability. The solution is split into three parts: the `main.go` entry point that wires all components together and manages graceful shutdown, the `UserService` implementation that handles business logic and event publishing, and a `docker-compose.yml` that provisions the required infrastructure.

```go
// Solution: cmd/user-service/main.go
package main

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"

    "github.com/myapp/internal/config"
    "github.com/myapp/internal/discovery"
    "github.com/myapp/internal/events"
    "github.com/myapp/internal/observability"
    "github.com/myapp/internal/repository"
    "github.com/myapp/internal/service"
    userv1 "github.com/myapp/gen/user/v1"
)

func main() {
    // Load configuration
    cfg, err := config.Load()
    if err != nil {
        slog.Error("failed to load config", "error", err)
        os.Exit(1)
    }

    // Setup structured logging
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
    slog.SetDefault(logger)

    // Setup observability
    shutdown, err := observability.Setup(cfg.ServiceName, cfg.OTELEndpoint)
    if err != nil {
        slog.Error("failed to setup observability", "error", err)
        os.Exit(1)
    }
    defer shutdown(context.Background())

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Initialize database
    db, err := repository.NewPostgresDB(cfg.DatabaseURL)
    if err != nil {
        slog.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    // Initialize event publisher
    publisher, err := events.NewKafkaPublisher(cfg.KafkaBrokers, cfg.ServiceName)
    if err != nil {
        slog.Error("failed to create publisher", "error", err)
        os.Exit(1)
    }
    defer publisher.Close()

    // Create repositories
    userRepo := repository.NewUserRepository(db)

    // Create service
    userService := service.NewUserService(userRepo, publisher)

    // Setup gRPC server
    grpcServer := setupGRPCServer(userService, logger)

    // Setup HTTP gateway
    httpServer := setupHTTPGateway(ctx, cfg, logger)

    // Setup service discovery
    serviceRegistry, err := discovery.NewConsulRegistry(cfg.ConsulAddr)
    if err != nil {
        slog.Error("failed to create service registry", "error", err)
        os.Exit(1)
    }

    // Register service
    instanceID := fmt.Sprintf("%s-%s", cfg.ServiceName, cfg.InstanceID)
    if err := serviceRegistry.Register(ctx, discovery.ServiceInstance{
        ID:      instanceID,
        Name:    cfg.ServiceName,
        Address: cfg.HostAddress,
        Port:    cfg.GRPCPort,
        Tags:    []string{"grpc", "user"},
        Meta: map[string]string{
            "version": cfg.Version,
        },
    }); err != nil {
        slog.Error("failed to register service", "error", err)
        os.Exit(1)
    }
    defer serviceRegistry.Deregister(instanceID)

    // Start servers
    go func() {
        lis, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.GRPCPort))
        if err != nil {
            slog.Error("failed to listen", "port", cfg.GRPCPort, "error", err)
            return
        }
        slog.Info("gRPC server starting", "port", cfg.GRPCPort)
        if err := grpcServer.Serve(lis); err != nil {
            slog.Error("gRPC server error", "error", err)
        }
    }()

    go func() {
        slog.Info("HTTP server starting", "port", cfg.HTTPPort)
        if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
            slog.Error("HTTP server error", "error", err)
        }
    }()

    // Wait for shutdown signal
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    <-sigCh

    slog.Info("shutting down")

    // Graceful shutdown
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    grpcServer.GracefulStop()
    httpServer.Shutdown(shutdownCtx)

    slog.Info("shutdown complete")
}

func setupGRPCServer(userService *service.UserService, logger *slog.Logger) *grpc.Server {
    // Create server with interceptors
    server := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            observability.UnaryServerInterceptor(),
            LoggingUnaryInterceptor(logger),
            RecoveryUnaryInterceptor(logger),
        ),
        grpc.ChainStreamInterceptor(
            observability.StreamServerInterceptor(),
            LoggingStreamInterceptor(logger),
        ),
    )

    // Register services
    userv1.RegisterUserServiceServer(server, userService)

    // Register health check
    healthServer := health.NewServer()
    grpc_health_v1.RegisterHealthServer(server, healthServer)
    healthServer.SetServingStatus("user.v1.UserService", grpc_health_v1.HealthCheckResponse_SERVING)

    // Enable reflection for debugging
    reflection.Register(server)

    return server
}

func setupHTTPGateway(ctx context.Context, cfg *config.Config, logger *slog.Logger) *http.Server {
    mux := runtime.NewServeMux()

    opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
    if err := userv1.RegisterUserServiceHandlerFromEndpoint(
        ctx, mux, fmt.Sprintf("localhost:%d", cfg.GRPCPort), opts,
    ); err != nil {
        logger.Error("failed to register gateway", "error", err)
    }

    // Create root mux with additional endpoints
    rootMux := http.NewServeMux()
    rootMux.Handle("/", mux)
    rootMux.Handle("/metrics", promhttp.Handler())
    rootMux.HandleFunc("/health", healthHandler)
    rootMux.HandleFunc("/ready", readyHandler)

    // Apply middleware
    var handler http.Handler = rootMux
    handler = observability.HTTPMiddleware(handler)
    handler = LoggingMiddleware(logger)(handler)
    handler = RecoveryMiddleware(logger)(handler)

    return &http.Server{
        Addr:         fmt.Sprintf(":%d", cfg.HTTPPort),
        Handler:      handler,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
    }
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status": "healthy"}`))
}

func readyHandler(w http.ResponseWriter, r *http.Request) {
    // Check dependencies
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status": "ready"}`))
}
```

The service layer implements the gRPC-generated interface by embedding `UnimplementedUserServiceServer` for forward compatibility. It validates requests using gRPC status codes, persists through a repository interface, and publishes domain events to Kafka after successful writes. Event publishing failures are logged but do not fail the request, since event delivery is an eventually-consistent concern.

```go
// internal/service/user_service.go
package service

import (
    "context"
    "errors"
    "log/slog"
    "time"

    "github.com/google/uuid"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    "github.com/myapp/internal/events"
    "github.com/myapp/internal/repository"
    userv1 "github.com/myapp/gen/user/v1"
)

type UserService struct {
    userv1.UnimplementedUserServiceServer
    repo      repository.UserRepository
    publisher events.Publisher
}

func NewUserService(repo repository.UserRepository, publisher events.Publisher) *UserService {
    return &UserService{
        repo:      repo,
        publisher: publisher,
    }
}

func (s *UserService) CreateUser(ctx context.Context, req *userv1.CreateUserRequest) (*userv1.CreateUserResponse, error) {
    // Validate request
    if req.Email == "" {
        return nil, status.Error(codes.InvalidArgument, "email is required")
    }

    // Check if user exists
    existing, err := s.repo.GetByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, repository.ErrNotFound) {
        return nil, status.Error(codes.Internal, "failed to check existing user")
    }
    if existing != nil {
        return nil, status.Error(codes.AlreadyExists, "user with this email already exists")
    }

    // Create user
    user := &repository.User{
        ID:        uuid.New().String(),
        Email:     req.Email,
        Name:      req.Name,
        Status:    "active",
        CreatedAt: time.Now(),
    }

    if err := s.repo.Create(ctx, user); err != nil {
        return nil, status.Error(codes.Internal, "failed to create user")
    }

    // Publish event
    if err := s.publisher.Publish(ctx, "user.created", "users", user.ID, events.UserCreatedEvent{
        UserID:    user.ID,
        Email:     user.Email,
        Name:      user.Name,
        CreatedAt: user.CreatedAt,
    }); err != nil {
        // Log but don't fail - event publishing is async
        slog.Error("failed to publish user.created event", "error", err)
    }

    return &userv1.CreateUserResponse{
        User: toProtoUser(user),
    }, nil
}

func (s *UserService) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserResponse, error) {
    user, err := s.repo.Get(ctx, req.Id)
    if err != nil {
        if errors.Is(err, repository.ErrNotFound) {
            return nil, status.Error(codes.NotFound, "user not found")
        }
        return nil, status.Error(codes.Internal, "failed to get user")
    }

    return &userv1.GetUserResponse{
        User: toProtoUser(user),
    }, nil
}

func toProtoUser(u *repository.User) *userv1.User {
    return &userv1.User{
        Id:        u.ID,
        Email:     u.Email,
        Name:      u.Name,
        Status:    u.Status,
        CreatedAt: timestamppb.New(u.CreatedAt),
    }
}
```

The Docker Compose file provisions PostgreSQL for persistence, Kafka and Zookeeper for event streaming, Consul for service discovery, and an OpenTelemetry collector for traces. Environment variables connect the user service to each dependency. In production these would be managed infrastructure, but for local development and integration testing this stack provides a realistic approximation.

```yaml
# docker-compose.yml
version: '3.8'

services:
  user-service:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
      - "50051:50051"
    environment:
      - DATABASE_URL=postgres://user:password@postgres:5432/users?sslmode=disable
      - KAFKA_BROKERS=kafka:9092
      - CONSUL_ADDR=consul:8500
      - OTEL_ENDPOINT=otel-collector:4317
      - SERVICE_NAME=user-service
      - GRPC_PORT=50051
      - HTTP_PORT=8080
    depends_on:
      - postgres
      - kafka
      - consul

  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: users
    volumes:
      - postgres_data:/var/lib/postgresql/data

  kafka:
    image: confluentinc/cp-kafka:7.9.7
    environment:
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
    depends_on:
      - zookeeper

  zookeeper:
    image: confluentinc/cp-zookeeper:7.9.7
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181

  consul:
    image: hashicorp/consul:1.22
    ports:
      - "8500:8500"

  otel-collector:
    image: otel/opentelemetry-collector:latest
    ports:
      - "4317:4317"

volumes:
  postgres_data:
```

### Junior → FAANG: Building the Exercise into a Portfolio Project

The exercise in this section is a complete production-grade service template. For junior engineers preparing for FAANG interviews, the most valuable use of this exercise is not reading the solution but implementing it from scratch and then debugging the gaps.

Suggested progression: first, implement `main.go` without looking at the solution. Wire the gRPC server with reflection and health checks. Wire the HTTP gateway. Handle shutdown signals. Then check the solution and note what you missed (the OTel setup, the deferred Consul deregistration, the `30*time.Second` shutdown context timeout). Missing those details on your first attempt is expected. Knowing them exists and understanding why they matter is the goal.

The event publishing in `user_service.go` has an important comment: "Log but don't fail - event publishing is async." This is a design decision, not a shortcut. When you see this pattern, ask: what is the recovery mechanism if the event is never published? The answer is the transactional outbox. For a junior-level exercise, the current code is correct for a learning environment. In production, the outbox is the missing piece.

The `docker-compose.yml` gives you a runnable local environment. Run it. Create a user via gRPC. Check Consul's UI at `localhost:8500`. Check the OTel collector logs. Break Kafka and observe what happens to the event publishing error log. This hands-on experience is what makes the patterns memorable.

Interview narrative from this exercise: "I built a microservice that registers with Consul for service discovery, publishes domain events to Kafka, exposes both gRPC and HTTP interfaces via grpc-gateway, and instruments with OpenTelemetry for distributed tracing. The next step I identified is moving event publishing behind a transactional outbox." Each clause of that sentence is a conversation starter in an interview, and naming the outbox as the known gap is itself a signal. Know the details behind each one.

### Senior @ FAANG: Production Gap Analysis and Service Template Governance

The exercise solution is correct for a learning context. A staff engineer's contribution is to identify the gaps between this solution and a production-ready, governed service, and to close those gaps by building platform primitives that all services inherit.

**Gap 1: secret management.** The `DATABASE_URL` in the docker-compose is a plaintext password in an environment variable. In production, this is replaced by Vault dynamic credentials. The platform provides: a Vault role bound to the service's Kubernetes ServiceAccount, a Vault Agent sidecar that renders `DATABASE_URL` into a tmpfs-mounted file that the Go process reads via `os.ReadFile`, and an auto-rotation that renews before TTL expiry. The application code changes from `os.Getenv("DATABASE_URL")` to `os.ReadFile("/vault/secrets/database-url")`. The platform team owns the Vault policy and the Agent configuration. The application team provides the secret path in a declarative annotation.

**Gap 2: graceful shutdown ordering.** The solution calls `grpcServer.GracefulStop()` then `httpServer.Shutdown()`. The correct production ordering is: (1) stop accepting new connections from the load balancer (Kubernetes removes the pod from endpoint slice on SIGTERM, but there is a propagation delay), so sleep for the propagation delay (typically 5 to 10 seconds) before starting the drain. (2) stop the gRPC server (drains in-flight RPCs). (3) stop the HTTP server. (4) close the Kafka producer (flush pending messages). (5) deregister from Consul. (6) close the database connection pool. If these are out of order, you get dropped requests during rolling deployments.

**Gap 3: the service template.** Platform teams at FAANG companies provide a Cookiecutter or `gonew` template that generates a new service with the correct structure already in place: the `main.go` wiring, the OTel setup, the health check, the Consul registration, the graceful shutdown sequence, and the Makefile targets (`make build`, `make test`, `make docker-push`). New services are created by running `gonew github.com/org/service-template github.com/org/new-service`, not by copying files manually. The template is versioned, and platform updates (e.g., new OTel SDK version, new graceful shutdown ordering) are propagated to existing services through a coordinated bump PR rather than tribal knowledge.

**Gap 4: load testing and SLO baseline.** A service that ships without a load test has no SLO baseline. The platform requires that every new service run a k6 or Vegeta load test as part of the pre-production review: at the expected p95 RPS, what is the p99 latency and error rate? This becomes the SLO starting point. The SLO is reviewed quarterly and adjusted based on user journey requirements. Without the load test, the SLO is aspirational rather than grounded in observed system behavior.

---
