## 49.7 Putting It All Together

### Complete Event-Driven Service Example

This `main.go` wires together the event store, Kafka producer/consumer, CQRS buses, and projections from the previous sections into a single order service. The service writes orders through event sourcing, publishes events to Kafka via the outbox pattern, consumes inventory events from other services, and serves read-optimized queries from projections. Graceful shutdown propagates context cancellation to all background goroutines so in-flight messages are processed before the pod terminates.

```go
// cmd/order-service/main.go
package main

import (
	"context"
	"database/sql"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"example.com/order-service/internal/app"
	"example.com/order-service/pkg/kafka"
	"example.com/order-service/pkg/eventsourcing"
	"example.com/order-service/pkg/cqrs"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Database connection
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		logger.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Event store
	eventStore, err := eventsourcing.NewEventStore(db)
	if err != nil {
		logger.Error("Failed to create event store", "error", err)
		os.Exit(1)
	}

	// Kafka producer for publishing events
	kafkaConfig := kafka.DefaultProducerConfig(
		[]string{os.Getenv("KAFKA_BROKERS")},
		"orders",
	)
	producer, err := kafka.NewProducer(kafkaConfig)
	if err != nil {
		logger.Error("Failed to create Kafka producer", "error", err)
		os.Exit(1)
	}
	defer producer.Close()

	// Projection manager for read models
	projectionManager, err := cqrs.NewProjectionManager(db, logger)
	if err != nil {
		logger.Error("Failed to create projection manager", "error", err)
		os.Exit(1)
	}

	// Register projections
	orderSummary, _ := cqrs.NewOrderSummaryProjection(db)
	projectionManager.Register(orderSummary)

	// Command bus
	commandBus := cqrs.NewCommandBus()

	// Query bus
	queryBus := cqrs.NewQueryBus()

	// Register handlers
	orderRepo := eventsourcing.NewRepository(
		eventStore,
		eventsourcing.NewOrderAggregate,
		100, // Snapshot every 100 events
	)

	orderHandler := app.NewOrderCommandHandler(orderRepo, producer, projectionManager)
	commandBus.Register("CreateOrder", orderHandler)
	commandBus.Register("AddOrderItem", orderHandler)
	commandBus.Register("ConfirmOrder", orderHandler)

	orderQueryHandler := app.NewOrderQueryHandler(cqrs.NewOrderSummaryQuery(db))
	queryBus.Register("GetOrder", orderQueryHandler)
	queryBus.Register("GetCustomerOrders", orderQueryHandler)

	// HTTP server
	server := app.NewHTTPServer(commandBus, queryBus, logger)

	// Kafka consumer for events from other services
	consumerConfig := kafka.DefaultConsumerConfig(
		[]string{os.Getenv("KAFKA_BROKERS")},
		"inventory-events",
		"order-service",
	)
	consumer, err := kafka.NewConsumer(consumerConfig, logger)
	if err != nil {
		logger.Error("Failed to create Kafka consumer", "error", err)
		os.Exit(1)
	}
	defer consumer.Close()

	// Register event handlers
	inventoryHandler := app.NewInventoryEventHandler(orderRepo)
	consumer.RegisterHandler("inventory.reserved", inventoryHandler.HandleInventoryReserved)
	consumer.RegisterHandler("inventory.released", inventoryHandler.HandleInventoryReleased)

	// Start components
	go func() {
		if err := consumer.Start(ctx); err != nil {
			logger.Error("Consumer error", "error", err)
		}
	}()

	go func() {
		if err := server.Start(":8080"); err != nil {
			logger.Error("Server error", "error", err)
		}
	}()

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	logger.Info("Shutting down...")
	cancel()
	server.Shutdown(ctx)
}
```

### Junior → FAANG: Reading a `main.go` as an Architecture Document

The `main.go` in this section is more than wiring code. It is the architecture of the service expressed as a dependency graph. Reading it carefully reveals the design decisions made by whoever wrote the service.

Start at the top: what external dependencies does the service require at startup? Here: a Postgres database, Kafka brokers. If either is unavailable at startup, the service exits with an error. This is a deliberate choice (fail fast rather than serve a degraded state). In some services, graceful degradation (start without Kafka, and buffer events locally) is the right choice. `main.go` reveals which choice was made.

Look at the goroutines: what runs concurrently? Here: the Kafka consumer and the HTTP server run concurrently, each in its own goroutine. Context cancellation from `cancel()` propagates to both. The `<-sigChan` line is the synchronization point: the main goroutine blocks until a shutdown signal arrives, then cancels the context and calls `server.Shutdown`. This is the correct graceful shutdown pattern for a Go service.

Look at what is registered: command handlers are registered by name to the command bus, query handlers to the query bus. Adding a new command requires registering a handler here. If you see a command handler registered but no corresponding consumer event handler, that command is only invoked by the HTTP API, not by events from other services.

**Dependency injection vs globals.** Everything in this `main.go` is constructed explicitly and passed to the types that need it. There are no package-level variables, no global logger, no `init()` functions with side effects. This is the correct pattern for testability: in tests, you substitute the real Kafka producer with a fake, the real database with a test database, and you can verify the wiring without running a real broker. Adopt this pattern from your first service.

**Interview habit.** When walking through a system design, describe the `main.go` flow explicitly: what dependencies are initialized, what goroutines are started, how shutdown is signaled and propagated. Demonstrating that you think about startup and shutdown sequences shows production maturity.

### Senior @ FAANG: Service Wiring as a Platform Contract

At the staff level, `main.go` is not just wiring for one service. It is a template that hundreds of services will follow, and the decisions made here become organizational defaults.

**The service factory pattern for consistency.** Rather than each service writing its own `main.go` from scratch, a platform team provides a service factory (sometimes called a service chassis or service template) that handles common concerns: structured logging with `log/slog`, OpenTelemetry initialization, health check endpoints at `/healthz` and `/readyz`, Prometheus metrics at `/metrics`, graceful shutdown with configurable drain timeout, and configuration loading from environment variables with typed validation. Service teams provide the business logic (command handlers, event handlers, projections) and the factory wires it into the standard chassis. This reduces the cognitive load for new services and ensures that every service in the fleet has consistent observability.

**Configuration management at startup.** The `main.go` in this section reads configuration from `os.Getenv`, which is correct for a containerized service. At platform scale, consider a configuration library that: validates all required environment variables at startup and fails fast with a clear error message listing every missing variable, supports structured configuration (not just strings) with type coercion, and integrates with a secrets manager (AWS Secrets Manager, HashiCorp Vault) for sensitive values. `viper` with a custom validation layer is a common Go choice. The key requirement is that a misconfigured service fails at startup with a useful error, not at the first request with a cryptic nil pointer dereference.

**Graceful shutdown budget.** The `server.Shutdown(ctx)` call in this section does not show a timeout. In production, the graceful shutdown must have an explicit deadline: long enough for in-flight requests to complete and for the Kafka consumer to finish processing its current message batch and commit offsets, but short enough that Kubernetes does not force-kill the pod before shutdown completes. A typical budget is 30 seconds: 5 seconds for the HTTP server to drain, 20 seconds for the Kafka consumer to finish and commit, and 5 seconds of margin. Kubernetes's `terminationGracePeriodSeconds` must be set longer than this budget, or the pod will be force-killed before the graceful shutdown completes. Document the expected shutdown duration in the service's deployment configuration.

**Observability wiring as a first-class concern.** A production service should expose: a `/readyz` endpoint that returns 200 only after all dependencies (database, Kafka connection) are established, a `/healthz` endpoint that returns 200 as long as the process is running (used by Kubernetes liveness probe), Prometheus metrics for every key operation (messages consumed, commands dispatched, projection events processed, consumer lag), and an OpenTelemetry trace exporter configured to the platform's tracing backend. The `main.go` in this section shows the tracer initialization implicitly (through the OTel-instrumented Kafka producer and consumer), but a production `main.go` would also show explicit OTLP exporter configuration and a metrics registry registration. Including these in the service template ensures new services have full observability from day one.

---
