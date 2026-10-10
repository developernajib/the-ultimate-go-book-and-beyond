## Part 1: Project Setup and Foundation

> **Why `github.com/google/uuid` and not the Go 1.27 stdlib `uuid` package?** This project stores `uuid.UUID` values in struct fields that are scanned from the database and passed as query arguments. That path requires the `sql.Scanner` and `driver.Valuer` interfaces, which the standard library type deliberately does not implement. The third-party package remains the right choice wherever UUIDs cross a `database/sql` boundary. Projects in this book whose UUIDs stay in memory or serialize as strings (the URL shortener, API gateway, and ML platform) use the stdlib package instead.

Before writing any business logic, you need a solid foundation for your microservices project. This means establishing a clear directory structure, defining shared protobuf types that multiple services will use, and creating reusable Go packages for common concerns like logging and database connections. A well-organized project structure makes it much easier to navigate the codebase as it grows, and shared packages prevent you from duplicating code across services.

### 1.1 Project Structure

The project structure establishes the layered package organization (handlers, services, repositories, domain) that enforces separation of concerns and prevents business logic from leaking into HTTP handler code. This architecture makes it straightforward to add new features without touching cross-cutting infrastructure.

```
ecommerce-platform/
├── api-gateway/
│   ├── cmd/
│   │   └── gateway/
│   │       └── main.go
│   ├── internal/
│   │   ├── router/
│   │   ├── middleware/
│   │   ├── aggregator/
│   │   └── clients/
│   ├── go.mod
│   └── Dockerfile
├── services/
│   ├── product/
│   │   ├── cmd/
│   │   │   └── server/
│   │   │       └── main.go
│   │   ├── internal/
│   │   │   ├── domain/
│   │   │   ├── repository/
│   │   │   ├── service/
│   │   │   └── grpc/
│   │   ├── proto/
│   │   │   └── product.proto
│   │   ├── migrations/
│   │   ├── go.mod
│   │   └── Dockerfile
│   ├── cart/
│   ├── order/
│   ├── payment/
│   ├── user/
│   └── notification/
├── pkg/
│   ├── events/
│   ├── tracing/
│   ├── logging/
│   ├── circuitbreaker/
│   └── database/
├── proto/
│   └── common/
│       └── types.proto
├── docker-compose.yml
├── docker-compose.dev.yml
├── k8s/
└── README.md
```

### 1.2 Shared Proto Definitions **proto/common/types.proto**

```protobuf
syntax = "proto3";

package common;
option go_package = "github.com/yourusername/ecommerce/pkg/proto/common";

import "google/protobuf/timestamp.proto";

// Money represents a monetary value with currency
message Money {
  // Currency code (ISO 4217)
  string currency_code = 1;

  // Amount in smallest currency unit (e.g., cents)
  int64 units = 2;

  // Fractional amount (for sub-cent precision)
  int32 nanos = 3;
}

// Address represents a physical address
message Address {
  string street_address = 1;
  string city = 2;
  string state = 3;
  string postal_code = 4;
  string country = 5;
}

// Pagination for list requests
message PageRequest {
  int32 page = 1;
  int32 page_size = 2;
}

message PageResponse {
  int32 total_count = 1;
  int32 page = 2;
  int32 page_size = 3;
  int32 total_pages = 4;
}

// Error details
message ErrorDetail {
  string code = 1;
  string message = 2;
  map<string, string> metadata = 3;
}
```

### 1.3 Shared Go Packages **pkg/logging/logger.go**

```go
package logging

import (
	"context"
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

type contextKey string

const (
	loggerKey       contextKey = "logger"
	requestIDKey    contextKey = "request_id"
	correlationIDKey contextKey = "correlation_id"
)

var defaultLogger *zap.Logger

func init() {
	config := zap.NewProductionConfig()
	config.EncoderConfig.TimeKey = "timestamp"
	config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	var err error
	defaultLogger, err = config.Build()
	if err != nil {
		panic(err)
	}
}

// Logger returns a logger with context fields
func Logger(ctx context.Context) *zap.Logger {
	if logger, ok := ctx.Value(loggerKey).(*zap.Logger); ok {
		return logger
	}

	logger := defaultLogger

	if requestID, ok := ctx.Value(requestIDKey).(string); ok {
		logger = logger.With(zap.String("request_id", requestID))
	}

	if correlationID, ok := ctx.Value(correlationIDKey).(string); ok {
		logger = logger.With(zap.String("correlation_id", correlationID))
	}

	return logger
}

// WithLogger adds a logger to the context
func WithLogger(ctx context.Context, logger *zap.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, logger)
}

// WithRequestID adds a request ID to the context
func WithRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, requestIDKey, requestID)
}

// WithCorrelationID adds a correlation ID to the context
func WithCorrelationID(ctx context.Context, correlationID string) context.Context {
	return context.WithValue(ctx, correlationIDKey, correlationID)
}

// Default returns the default logger
func Default() *zap.Logger {
	return defaultLogger
}

// Sync flushes any buffered log entries
func Sync() error {
	return defaultLogger.Sync()
}
```

**pkg/tracing/tracing.go**

```go
package tracing

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// Config holds tracing configuration
type Config struct {
	ServiceName    string
	ServiceVersion string
	JaegerEndpoint string // OTLP collector endpoint
	Environment    string
}

// InitTracer initializes OpenTelemetry tracing
func InitTracer(cfg Config) (func(context.Context) error, error) {
	exporter, err := otlptracehttp.New(context.Background(),
		otlptracehttp.WithEndpointURL(cfg.JaegerEndpoint),
	)
	if err != nil {
		return nil, fmt.Errorf("creating OTLP exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			attribute.String("environment", cfg.Environment),
		)),
	)

	otel.SetTracerProvider(tp)

	return tp.Shutdown, nil
}

// StartSpan starts a new span with the given name
func StartSpan(ctx context.Context, spanName string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	tracer := otel.Tracer("")
	return tracer.Start(ctx, spanName, opts...)
}

// AddEvent adds an event to the current span
func AddEvent(ctx context.Context, name string, attrs ...attribute.KeyValue) {
	span := trace.SpanFromContext(ctx)
	span.AddEvent(name, trace.WithAttributes(attrs...))
}

// SetAttributes sets attributes on the current span
func SetAttributes(ctx context.Context, attrs ...attribute.KeyValue) {
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(attrs...)
}

// RecordError records an error on the current span
func RecordError(ctx context.Context, err error) {
	span := trace.SpanFromContext(ctx)
	span.RecordError(err)
}
```

**pkg/circuitbreaker/breaker.go**

```go
package circuitbreaker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrCircuitOpen     = errors.New("circuit breaker is open")
	ErrTooManyRequests = errors.New("too many requests")
)

// State represents the circuit breaker state
type State int

const (
	StateClosed State = iota
	StateHalfOpen
	StateOpen
)

func (s State) String() string {
	switch s {
	case StateClosed:
		return "closed"
	case StateHalfOpen:
		return "half-open"
	case StateOpen:
		return "open"
	default:
		return "unknown"
	}
}

// Config holds circuit breaker configuration
type Config struct {
	// MaxRequests is the maximum number of requests allowed in half-open state
	MaxRequests uint32

	// Interval is the cyclic period in closed state to clear internal counts
	Interval time.Duration

	// Timeout is the period of the open state before switching to half-open
	Timeout time.Duration

	// ReadyToTrip is called when a request fails in closed state
	// If it returns true, the circuit breaker trips to open state
	ReadyToTrip func(counts Counts) bool

	// OnStateChange is called whenever the state changes
	OnStateChange func(name string, from State, to State)
}

// Counts holds the statistics of the circuit breaker
type Counts struct {
	Requests             uint32
	TotalSuccesses       uint32
	TotalFailures        uint32
	ConsecutiveSuccesses uint32
	ConsecutiveFailures  uint32
}

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	name          string
	maxRequests   uint32
	interval      time.Duration
	timeout       time.Duration
	readyToTrip   func(counts Counts) bool
	onStateChange func(name string, from State, to State)

	mu          sync.Mutex
	state       State
	generation  uint64
	counts      Counts
	expiry      time.Time
}

// New creates a new CircuitBreaker
func New(name string, cfg Config) *CircuitBreaker {
	cb := &CircuitBreaker{
		name:          name,
		maxRequests:   cfg.MaxRequests,
		interval:      cfg.Interval,
		timeout:       cfg.Timeout,
		readyToTrip:   cfg.ReadyToTrip,
		onStateChange: cfg.OnStateChange,
	}

	if cb.maxRequests == 0 {
		cb.maxRequests = 1
	}

	if cb.interval <= 0 {
		cb.interval = time.Second * 60
	}

	if cb.timeout <= 0 {
		cb.timeout = time.Second * 60
	}

	if cb.readyToTrip == nil {
		cb.readyToTrip = func(counts Counts) bool {
			return counts.ConsecutiveFailures > 5
		}
	}

	cb.toNewGeneration(time.Now())

	return cb
}

// Execute runs the given function if the circuit breaker is closed or half-open
func (cb *CircuitBreaker) Execute(fn func() error) error {
	generation, err := cb.beforeRequest()
	if err != nil {
		return err
	}

	defer func() {
		if r := recover(); r != nil {
			cb.afterRequest(generation, false)
			panic(r)
		}
	}()

	err = fn()
	cb.afterRequest(generation, err == nil)
	return err
}

// ExecuteCtx runs the given function with context support
func (cb *CircuitBreaker) ExecuteCtx(ctx context.Context, fn func(context.Context) error) error {
	generation, err := cb.beforeRequest()
	if err != nil {
		return err
	}

	defer func() {
		if r := recover(); r != nil {
			cb.afterRequest(generation, false)
			panic(r)
		}
	}()

	err = fn(ctx)
	cb.afterRequest(generation, err == nil)
	return err
}

// State returns the current state
func (cb *CircuitBreaker) State() State {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	now := time.Now()
	state, _ := cb.currentState(now)
	return state
}

// Counts returns a copy of the current counts
func (cb *CircuitBreaker) Counts() Counts {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	return cb.counts
}

func (cb *CircuitBreaker) beforeRequest() (uint64, error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	now := time.Now()
	state, generation := cb.currentState(now)

	if state == StateOpen {
		return generation, ErrCircuitOpen
	} else if state == StateHalfOpen && cb.counts.Requests >= cb.maxRequests {
		return generation, ErrTooManyRequests
	}

	cb.counts.Requests++
	return generation, nil
}

func (cb *CircuitBreaker) afterRequest(before uint64, success bool) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	now := time.Now()
	state, generation := cb.currentState(now)
	if generation != before {
		return
	}

	if success {
		cb.onSuccess(state, now)
	} else {
		cb.onFailure(state, now)
	}
}

func (cb *CircuitBreaker) onSuccess(state State, now time.Time) {
	cb.counts.TotalSuccesses++
	cb.counts.ConsecutiveSuccesses++
	cb.counts.ConsecutiveFailures = 0

	if state == StateHalfOpen && cb.counts.ConsecutiveSuccesses >= cb.maxRequests {
		cb.setState(StateClosed, now)
	}
}

func (cb *CircuitBreaker) onFailure(state State, now time.Time) {
	cb.counts.TotalFailures++
	cb.counts.ConsecutiveFailures++
	cb.counts.ConsecutiveSuccesses = 0

	if cb.readyToTrip(cb.counts) {
		cb.setState(StateOpen, now)
	}
}

func (cb *CircuitBreaker) currentState(now time.Time) (State, uint64) {
	switch cb.state {
	case StateClosed:
		if !cb.expiry.IsZero() && cb.expiry.Before(now) {
			cb.toNewGeneration(now)
		}
	case StateOpen:
		if cb.expiry.Before(now) {
			cb.setState(StateHalfOpen, now)
		}
	}
	return cb.state, cb.generation
}

func (cb *CircuitBreaker) setState(state State, now time.Time) {
	if cb.state == state {
		return
	}

	prev := cb.state
	cb.state = state

	cb.toNewGeneration(now)

	if cb.onStateChange != nil {
		cb.onStateChange(cb.name, prev, state)
	}
}

func (cb *CircuitBreaker) toNewGeneration(now time.Time) {
	cb.generation++
	cb.counts = Counts{}

	var zero time.Time
	switch cb.state {
	case StateClosed:
		if cb.interval == 0 {
			cb.expiry = zero
		} else {
			cb.expiry = now.Add(cb.interval)
		}
	case StateOpen:
		cb.expiry = now.Add(cb.timeout)
	default: // StateHalfOpen
		cb.expiry = zero
	}
}
```

**pkg/database/postgres.go**

```go
package database

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config holds database configuration
type Config struct {
	Host            string
	Port            int
	User            string
	Password        string
	Database        string
	MaxConns        int32
	MinConns        int32
	MaxConnLifetime time.Duration
	MaxConnIdleTime time.Duration
}

// NewPostgresPool creates a new PostgreSQL connection pool
func NewPostgresPool(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	dsn := fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database,
	)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing pool config: %w", err)
	}

	// Set pool configuration
	poolConfig.MaxConns = cfg.MaxConns
	if poolConfig.MaxConns == 0 {
		poolConfig.MaxConns = 25
	}

	poolConfig.MinConns = cfg.MinConns
	if poolConfig.MinConns == 0 {
		poolConfig.MinConns = 5
	}

	poolConfig.MaxConnLifetime = cfg.MaxConnLifetime
	if poolConfig.MaxConnLifetime == 0 {
		poolConfig.MaxConnLifetime = time.Hour
	}

	poolConfig.MaxConnIdleTime = cfg.MaxConnIdleTime
	if poolConfig.MaxConnIdleTime == 0 {
		poolConfig.MaxConnIdleTime = time.Minute * 30
	}

	// Create pool
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", err)
	}

	// Verify connection
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	return pool, nil
}

// Transactor provides transaction support
type Transactor interface {
	WithTransaction(ctx context.Context, fn func(pgx.Tx) error) error
}

// PostgresTransactor implements Transactor
type PostgresTransactor struct {
	pool *pgxpool.Pool
}

// NewTransactor creates a new PostgresTransactor
func NewTransactor(pool *pgxpool.Pool) *PostgresTransactor {
	return &PostgresTransactor{pool: pool}
}

// WithTransaction executes a function within a database transaction
func (t *PostgresTransactor) WithTransaction(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := t.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(ctx)
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		if rbErr := tx.Rollback(ctx); rbErr != nil {
			return fmt.Errorf("rolling back transaction: %v (original error: %w)", rbErr, err)
		}
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	return nil
}
```

### Junior → FAANG: Protobuf as a First-Job Communication Standard

Protocol Buffers (protobuf) with gRPC is the standard inter-service communication protocol at FAANG. Knowing how to write a `.proto` file, generate Go code from it, and implement the server and client stubs is a practical requirement for any backend role at these companies.

The key advantage over REST+JSON is type safety and performance: protobuf messages are binary-encoded (3-10x smaller than equivalent JSON) and generated code prevents schema drift between client and server. The disadvantage is debuggability: you cannot read a protobuf payload with curl. Use gRPC reflection or tools like grpcurl for debugging.

Shared proto definitions (in a common `proto/` directory importable by all services) prevent the duplication that leads to inconsistency. Every service that references a `Product` message uses the same definition. This is the Go module organization equivalent of a shared library, but for data schemas.

### Senior @ FAANG: Proto Schema as an Organizational Contract

At senior level, a `.proto` file is a contract between teams. Every field addition is backward-compatible. Every field removal requires a deprecation period. Every field renaming requires both old and new names to coexist during migration. These rules must be enforced by tooling (buf lint, buf breaking) and code review, not just by convention.

Proto schema versioning (v1, v2 in the package name) is the mechanism for breaking changes. A v2 proto can introduce incompatible changes while v1 clients continue operating. The migration window (how long v1 is supported after v2 launch) is a governance decision that must be agreed with all consumer teams.

API design review for proto schemas is a platform engineering responsibility at FAANG. A dedicated API review council (or at least an API review channel) ensures that field naming is consistent, deprecation processes are followed, and new services do not reinvent types that already exist. This governance prevents the fragmentation that makes a microservices architecture harder to maintain over time.

---
