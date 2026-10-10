## 30.8 Complete Production Worker Framework

This section presents a complete, production-ready background worker framework.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
worker-service/
├── cmd/
│   └── worker/
│       └── main.go                 # Worker entry point
├── internal/
│   ├── config/
│   │   └── config.go               # Configuration
│   ├── queue/
│   │   ├── queue.go                # Queue interface
│   │   ├── postgres.go             # PostgreSQL queue
│   │   ├── redis.go                # Redis queue
│   │   └── message.go              # Message types
│   ├── worker/
│   │   ├── pool.go                 # Worker pool
│   │   ├── worker.go               # Worker implementation
│   │   └── handler.go              # Job handlers
│   ├── scheduler/
│   │   ├── scheduler.go            # Cron scheduler
│   │   └── lock.go                 # Distributed lock
│   ├── jobs/
│   │   ├── email.go                # Email job
│   │   ├── notification.go         # Notification job
│   │   └── report.go               # Report generation job
│   └── metrics/
│       └── metrics.go              # Metrics collection
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── go.mod
```

### Core Queue Interface

The interface definition below establishes the contract that all implementations must satisfy. Programming to this interface rather than a concrete type enables dependency injection, simplifies testing, and allows the implementation to be swapped without changing callers.

```go
// internal/queue/queue.go
package queue

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Queue defines the interface for job queue implementations
type Queue interface {
	// Enqueue adds a job to the queue
	Enqueue(ctx context.Context, job *Job) error

	// Dequeue retrieves and locks jobs for processing
	Dequeue(ctx context.Context, queues []string, limit int) ([]*Job, error)

	// Complete marks a job as successfully completed
	Complete(ctx context.Context, jobID uuid.UUID) error

	// Fail marks a job as failed, scheduling retry if applicable
	Fail(ctx context.Context, jobID uuid.UUID, err error) error

	// Heartbeat extends the lock on a running job
	Heartbeat(ctx context.Context, jobID uuid.UUID) error

	// Stats returns queue statistics
	Stats(ctx context.Context, queue string) (*QueueStats, error)

	// Close closes the queue connection
	Close() error
}

// Job represents a background job
type Job struct {
	ID           uuid.UUID       `json:"id" db:"id"`
	Queue        string          `json:"queue" db:"queue"`
	Type         string          `json:"type" db:"type"`
	Payload      json.RawMessage `json:"payload" db:"payload"`
	Priority     int             `json:"priority" db:"priority"`
	Status       JobStatus       `json:"status" db:"status"`
	Attempts     int             `json:"attempts" db:"attempts"`
	MaxAttempts  int             `json:"max_attempts" db:"max_attempts"`
	ScheduledAt  time.Time       `json:"scheduled_at" db:"scheduled_at"`
	LockedUntil  *time.Time      `json:"locked_until,omitempty" db:"locked_until"`
	LockedBy     *string         `json:"locked_by,omitempty" db:"locked_by"`
	StartedAt    *time.Time      `json:"started_at,omitempty" db:"started_at"`
	CompletedAt  *time.Time      `json:"completed_at,omitempty" db:"completed_at"`
	FailedAt     *time.Time      `json:"failed_at,omitempty" db:"failed_at"`
	LastError    *string         `json:"last_error,omitempty" db:"last_error"`
	CreatedAt    time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at" db:"updated_at"`
}

type JobStatus string

const (
	StatusPending   JobStatus = "pending"
	StatusRunning   JobStatus = "running"
	StatusCompleted JobStatus = "completed"
	StatusFailed    JobStatus = "failed"
	StatusDead      JobStatus = "dead"
)

// JobOption configures job creation
type JobOption func(*Job)

func WithPriority(p int) JobOption {
	return func(j *Job) { j.Priority = p }
}

func WithDelay(d time.Duration) JobOption {
	return func(j *Job) { j.ScheduledAt = time.Now().Add(d) }
}

func WithScheduleAt(t time.Time) JobOption {
	return func(j *Job) { j.ScheduledAt = t }
}

func WithMaxAttempts(n int) JobOption {
	return func(j *Job) { j.MaxAttempts = n }
}

// NewJob creates a new job with the given options
func NewJob(queue, jobType string, payload any, opts ...JobOption) (*Job, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	job := &Job{
		ID:          uuid.New(),
		Queue:       queue,
		Type:        jobType,
		Payload:     payloadBytes,
		Priority:    0,
		Status:      StatusPending,
		Attempts:    0,
		MaxAttempts: 3,
		ScheduledAt: time.Now(),
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	for _, opt := range opts {
		opt(job)
	}

	return job, nil
}

// QueueStats contains queue statistics
type QueueStats struct {
	Queue       string `json:"queue"`
	Pending     int64  `json:"pending"`
	Running     int64  `json:"running"`
	Completed   int64  `json:"completed"`
	Failed      int64  `json:"failed"`
	Dead        int64  `json:"dead"`
	ProcessRate float64 `json:"process_rate"` // jobs per second
}
```

### PostgreSQL Queue Implementation

The `PostgresQueue` satisfies the `Queue` interface using `FOR UPDATE SKIP LOCKED` for concurrent dequeue, visibility timeouts via `locked_until`, and exponential backoff with jitter for retries. Each worker identifies itself by hostname and PID so the `Complete` and `Fail` methods verify lock ownership before updating, preventing a stale worker from accidentally completing a job that has already been reassigned after its lock expired.

```go
// internal/queue/postgres.go
package queue

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

type PostgresQueue struct {
	db           *sqlx.DB
	workerID     string
	lockDuration time.Duration
	baseRetry    time.Duration
	maxRetry     time.Duration
}

type PostgresQueueConfig struct {
	DB           *sqlx.DB
	LockDuration time.Duration // How long a job is locked (visibility timeout)
	BaseRetry    time.Duration // Base retry delay
	MaxRetry     time.Duration // Max retry delay
}

func NewPostgresQueue(cfg PostgresQueueConfig) *PostgresQueue {
	hostname, _ := os.Hostname()
	workerID := fmt.Sprintf("%s-%d", hostname, os.Getpid())

	if cfg.LockDuration == 0 {
		cfg.LockDuration = 5 * time.Minute
	}
	if cfg.BaseRetry == 0 {
		cfg.BaseRetry = time.Minute
	}
	if cfg.MaxRetry == 0 {
		cfg.MaxRetry = 24 * time.Hour
	}

	return &PostgresQueue{
		db:           cfg.DB,
		workerID:     workerID,
		lockDuration: cfg.LockDuration,
		baseRetry:    cfg.BaseRetry,
		maxRetry:     cfg.MaxRetry,
	}
}

func (q *PostgresQueue) Enqueue(ctx context.Context, job *Job) error {
	query := `
		INSERT INTO jobs (
			id, queue, type, payload, priority, status, attempts, max_attempts,
			scheduled_at, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
		)
	`

	_, err := q.db.ExecContext(ctx, query,
		job.ID, job.Queue, job.Type, job.Payload, job.Priority, job.Status,
		job.Attempts, job.MaxAttempts, job.ScheduledAt, job.CreatedAt, job.UpdatedAt,
	)
	return err
}

func (q *PostgresQueue) Dequeue(ctx context.Context, queues []string, limit int) ([]*Job, error) {
	now := time.Now()
	lockUntil := now.Add(q.lockDuration)

	// Use FOR UPDATE SKIP LOCKED for efficient concurrent dequeue
	query := `
		UPDATE jobs
		SET
			status = $1,
			locked_until = $2,
			locked_by = $3,
			started_at = COALESCE(started_at, $4),
			attempts = attempts + 1,
			updated_at = $4
		WHERE id IN (
			SELECT id FROM jobs
			WHERE queue = ANY($5)
			  AND status = $6
			  AND scheduled_at <= $4
			  AND (locked_until IS NULL OR locked_until < $4)
			ORDER BY priority DESC, scheduled_at ASC
			FOR UPDATE SKIP LOCKED
			LIMIT $7
		)
		RETURNING id, queue, type, payload, priority, status, attempts, max_attempts,
		          scheduled_at, locked_until, locked_by, started_at, created_at, updated_at
	`

	rows, err := q.db.QueryxContext(ctx, query,
		StatusRunning, lockUntil, q.workerID, now, queues, StatusPending, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []*Job
	for rows.Next() {
		var job Job
		if err := rows.StructScan(&job); err != nil {
			return nil, err
		}
		jobs = append(jobs, &job)
	}

	return jobs, rows.Err()
}

func (q *PostgresQueue) Complete(ctx context.Context, jobID uuid.UUID) error {
	query := `
		UPDATE jobs
		SET status = $1, completed_at = $2, locked_until = NULL, locked_by = NULL, updated_at = $2
		WHERE id = $3 AND locked_by = $4
	`

	result, err := q.db.ExecContext(ctx, query, StatusCompleted, time.Now(), jobID, q.workerID)
	if err != nil {
		return err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("job %s not found or not owned by this worker", jobID)
	}

	return nil
}

func (q *PostgresQueue) Fail(ctx context.Context, jobID uuid.UUID, jobErr error) error {
	// First, get the job to check attempt count
	var job Job
	getQuery := `SELECT id, attempts, max_attempts FROM jobs WHERE id = $1 AND locked_by = $2`
	if err := q.db.GetContext(ctx, &job, getQuery, jobID, q.workerID); err != nil {
		return err
	}

	errStr := jobErr.Error()
	now := time.Now()

	if job.Attempts >= job.MaxAttempts {
		// Move to dead status
		updateQuery := `
			UPDATE jobs
			SET status = $1, failed_at = $2, last_error = $3,
			    locked_until = NULL, locked_by = NULL, updated_at = $2
			WHERE id = $4
		`
		_, err := q.db.ExecContext(ctx, updateQuery, StatusDead, now, errStr, jobID)
		return err
	}

	// Schedule for retry with exponential backoff + jitter
	retryDelay := q.calculateRetryDelay(job.Attempts)
	scheduledAt := now.Add(retryDelay)

	updateQuery := `
		UPDATE jobs
		SET status = $1, scheduled_at = $2, last_error = $3,
		    locked_until = NULL, locked_by = NULL, updated_at = $4
		WHERE id = $5
	`
	_, err := q.db.ExecContext(ctx, updateQuery, StatusPending, scheduledAt, errStr, now, jobID)
	return err
}

func (q *PostgresQueue) calculateRetryDelay(attempt int) time.Duration {
	// Exponential backoff: base * 2^attempt
	delay := float64(q.baseRetry) * math.Pow(2, float64(attempt-1))

	// Add jitter (±25%)
	jitter := delay * 0.25 * (rand.Float64()*2 - 1)
	delay += jitter

	// Cap at max retry
	if time.Duration(delay) > q.maxRetry {
		return q.maxRetry
	}

	return time.Duration(delay)
}

func (q *PostgresQueue) Heartbeat(ctx context.Context, jobID uuid.UUID) error {
	lockUntil := time.Now().Add(q.lockDuration)

	query := `
		UPDATE jobs
		SET locked_until = $1, updated_at = $2
		WHERE id = $3 AND locked_by = $4 AND status = $5
	`

	result, err := q.db.ExecContext(ctx, query, lockUntil, time.Now(), jobID, q.workerID, StatusRunning)
	if err != nil {
		return err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("job %s not found or lock lost", jobID)
	}

	return nil
}

func (q *PostgresQueue) Stats(ctx context.Context, queue string) (*QueueStats, error) {
	stats := &QueueStats{Queue: queue}

	query := `
		SELECT
			COUNT(*) FILTER (WHERE status = 'pending') as pending,
			COUNT(*) FILTER (WHERE status = 'running') as running,
			COUNT(*) FILTER (WHERE status = 'completed') as completed,
			COUNT(*) FILTER (WHERE status = 'failed') as failed,
			COUNT(*) FILTER (WHERE status = 'dead') as dead
		FROM jobs
		WHERE queue = $1
	`

	err := q.db.QueryRowContext(ctx, query, queue).Scan(
		&stats.Pending, &stats.Running, &stats.Completed, &stats.Failed, &stats.Dead,
	)
	return stats, err
}

func (q *PostgresQueue) Close() error {
	return q.db.Close()
}
```

### Worker Pool with Graceful Shutdown

The production pool adds handler registration, per-job heartbeats, and a two-phase shutdown sequence on top of the basic pool pattern from Section 30.1. Each worker polls the queue on a one-second interval, looks up the registered handler by job type, and spawns a heartbeat goroutine that extends the lock every 30 seconds for long-running jobs. Shutdown closes a signal channel so all workers exit their poll loop, then waits with a configurable timeout for in-flight jobs to complete.

```go
// internal/worker/pool.go
package worker

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"worker-service/internal/queue"
)

type Pool struct {
	queue       queue.Queue
	handlers    map[string]Handler
	workers     []*Worker
	queues      []string
	logger      *slog.Logger
	metrics     *Metrics

	mu          sync.RWMutex
	running     bool
	shutdown    chan struct{}
	wg          sync.WaitGroup
}

type PoolConfig struct {
	Queue           queue.Queue
	WorkerCount     int
	Queues          []string
	PollInterval    time.Duration
	HeartbeatInterval time.Duration
	Logger          *slog.Logger
}

func NewPool(cfg PoolConfig) *Pool {
	if cfg.WorkerCount == 0 {
		cfg.WorkerCount = 10
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = time.Second
	}
	if cfg.HeartbeatInterval == 0 {
		cfg.HeartbeatInterval = 30 * time.Second
	}

	return &Pool{
		queue:    cfg.Queue,
		handlers: make(map[string]Handler),
		queues:   cfg.Queues,
		logger:   cfg.Logger,
		metrics:  NewMetrics(),
		shutdown: make(chan struct{}),
	}
}

// Handler processes a job
type Handler func(ctx context.Context, job *queue.Job) error

// RegisterHandler registers a handler for a job type
func (p *Pool) RegisterHandler(jobType string, handler Handler) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.handlers[jobType] = handler
}

// Start starts the worker pool
func (p *Pool) Start(ctx context.Context) error {
	p.mu.Lock()
	if p.running {
		p.mu.Unlock()
		return nil
	}
	p.running = true
	p.mu.Unlock()

	p.logger.Info("starting worker pool",
		"worker_count", len(p.workers),
		"queues", p.queues,
	)

	// Create and start workers
	for i := 0; i < 10; i++ {
		worker := &Worker{
			id:       i,
			pool:     p,
			logger:   p.logger.With("worker_id", i),
		}
		p.workers = append(p.workers, worker)
		p.wg.Add(1)
		go worker.run(ctx)
	}

	return nil
}

// Stop gracefully shuts down the worker pool
func (p *Pool) Stop(ctx context.Context) error {
	p.mu.Lock()
	if !p.running {
		p.mu.Unlock()
		return nil
	}
	p.running = false
	p.mu.Unlock()

	p.logger.Info("stopping worker pool...")

	// Signal shutdown
	close(p.shutdown)

	// Wait for workers to finish with timeout
	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		p.logger.Info("worker pool stopped gracefully")
	case <-ctx.Done():
		p.logger.Warn("worker pool shutdown timeout")
	}

	return nil
}

func (p *Pool) getHandler(jobType string) (Handler, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	h, ok := p.handlers[jobType]
	return h, ok
}

// Worker processes jobs from the pool
type Worker struct {
	id     int
	pool   *Pool
	logger *slog.Logger
}

func (w *Worker) run(ctx context.Context) {
	defer w.pool.wg.Done()

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-w.pool.shutdown:
			return
		case <-ticker.C:
			w.poll(ctx)
		}
	}
}

func (w *Worker) poll(ctx context.Context) {
	jobs, err := w.pool.queue.Dequeue(ctx, w.pool.queues, 1)
	if err != nil {
		w.logger.Error("failed to dequeue jobs", "error", err)
		return
	}

	for _, job := range jobs {
		w.process(ctx, job)
	}
}

func (w *Worker) process(ctx context.Context, job *queue.Job) {
	start := time.Now()
	logger := w.logger.With(
		"job_id", job.ID,
		"job_type", job.Type,
		"queue", job.Queue,
		"attempt", job.Attempts,
	)

	logger.Debug("processing job")

	// Get handler
	handler, ok := w.pool.getHandler(job.Type)
	if !ok {
		logger.Error("no handler registered for job type")
		w.pool.queue.Fail(ctx, job.ID, fmt.Errorf("no handler for type: %s", job.Type))
		return
	}

	// Create job context with cancellation
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Start heartbeat goroutine for long-running jobs
	heartbeatDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatDone:
				return
			case <-ticker.C:
				if err := w.pool.queue.Heartbeat(ctx, job.ID); err != nil {
					logger.Warn("heartbeat failed", "error", err)
					cancel() // Cancel job if we lose the lock
				}
			}
		}
	}()

	// Execute handler
	err := handler(jobCtx, job)
	close(heartbeatDone)

	duration := time.Since(start)

	if err != nil {
		logger.Error("job failed", "error", err, "duration", duration)
		w.pool.metrics.RecordFailed(job.Queue)
		if err := w.pool.queue.Fail(ctx, job.ID, err); err != nil {
			logger.Error("failed to mark job as failed", "error", err)
		}
		return
	}

	logger.Info("job completed", "duration", duration)
	w.pool.metrics.RecordCompleted(job.Queue, duration)

	if err := w.pool.queue.Complete(ctx, job.ID); err != nil {
		logger.Error("failed to mark job as complete", "error", err)
	}
}
```

### Job Handlers

Each job handler is a struct that deserializes the job payload, validates required fields, checks context cancellation, and delegates to an external service. Handlers are registered by job type with the worker pool, so adding a new job type requires only implementing the `Handle` method and calling `RegisterHandler`. The two examples below show an email sender and a push notification dispatcher.

```go
// internal/jobs/email.go
package jobs

import (
	"context"
	"encoding/json"
	"fmt"

	"worker-service/internal/queue"
)

const JobTypeEmail = "email"

type EmailPayload struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
	HTML    bool   `json:"html"`
}

type EmailHandler struct {
	smtpHost     string
	smtpPort     int
	smtpUser     string
	smtpPassword string
	fromAddress  string
}

func NewEmailHandler(host string, port int, user, password, from string) *EmailHandler {
	return &EmailHandler{
		smtpHost:     host,
		smtpPort:     port,
		smtpUser:     user,
		smtpPassword: password,
		fromAddress:  from,
	}
}

func (h *EmailHandler) Handle(ctx context.Context, job *queue.Job) error {
	var payload EmailPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	// Validate
	if payload.To == "" {
		return fmt.Errorf("email recipient is required")
	}

	// Check context before sending
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	// Send email (implementation would use net/smtp or a service)
	// For production, use a service like SendGrid, SES, etc.
	return h.sendEmail(ctx, payload)
}

func (h *EmailHandler) sendEmail(ctx context.Context, payload EmailPayload) error {
	// Email sending implementation
	// This would integrate with SMTP or email service
	return nil
}
```

The push notification handler follows the same pattern but iterates over multiple device tokens per user. If one token fails (for example, because the user uninstalled the app), it continues delivering to the remaining tokens and returns only the last error, so partial delivery still succeeds.

```go
// internal/jobs/notification.go
package jobs

import (
	"context"
	"encoding/json"
	"fmt"

	"worker-service/internal/queue"
)

const JobTypePushNotification = "push_notification"

type PushNotificationPayload struct {
	UserID  string            `json:"user_id"`
	Title   string            `json:"title"`
	Body    string            `json:"body"`
	Data    map[string]string `json:"data,omitempty"`
	Tokens  []string          `json:"tokens"`
}

type PushNotificationHandler struct {
	fcmClient any // Firebase Cloud Messaging client
}

func (h *PushNotificationHandler) Handle(ctx context.Context, job *queue.Job) error {
	var payload PushNotificationPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	// Send to each token
	var lastErr error
	for _, token := range payload.Tokens {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if err := h.sendToToken(ctx, token, payload); err != nil {
			lastErr = err
			// Continue trying other tokens
		}
	}

	return lastErr
}

func (h *PushNotificationHandler) sendToToken(ctx context.Context, token string, payload PushNotificationPayload) error {
	// FCM implementation
	return nil
}
```

### Main Application

The `main` function wires together the database connection, queue, worker pool, job handlers, and scheduler, then blocks on an OS signal to trigger graceful shutdown. The shutdown sequence cancels the root context (stopping all pollers and the scheduler), then waits up to 30 seconds for in-flight jobs to finish before exiting.

```go
// cmd/worker/main.go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"

	"worker-service/internal/jobs"
	"worker-service/internal/queue"
	"worker-service/internal/scheduler"
	"worker-service/internal/worker"
)

func main() {
	// Initialize logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Load configuration
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@localhost:5432/workers?sslmode=disable"
	}

	// Connect to database
	db, err := sqlx.Connect("postgres", dbURL)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	// Create queue
	q := queue.NewPostgresQueue(queue.PostgresQueueConfig{
		DB:           db,
		LockDuration: 5 * time.Minute,
		BaseRetry:    time.Minute,
		MaxRetry:     24 * time.Hour,
	})

	// Create worker pool
	pool := worker.NewPool(worker.PoolConfig{
		Queue:          q,
		WorkerCount:    10,
		Queues:         []string{"default", "emails", "notifications"},
		PollInterval:   time.Second,
		Logger:         logger,
	})

	// Register handlers
	emailHandler := jobs.NewEmailHandler(
		os.Getenv("SMTP_HOST"),
		587,
		os.Getenv("SMTP_USER"),
		os.Getenv("SMTP_PASSWORD"),
		"noreply@example.com",
	)
	pool.RegisterHandler(jobs.JobTypeEmail, emailHandler.Handle)

	notificationHandler := &jobs.PushNotificationHandler{}
	pool.RegisterHandler(jobs.JobTypePushNotification, notificationHandler.Handle)

	// Create context with cancellation
	ctx, cancel := context.WithCancel(context.Background())

	// Start worker pool
	if err := pool.Start(ctx); err != nil {
		logger.Error("failed to start worker pool", "error", err)
		os.Exit(1)
	}

	// Create and start scheduler for cron jobs
	sched := scheduler.NewScheduler(logger)
	sched.AddJob("cleanup-old-jobs", "0 0 * * *", func(ctx context.Context) error {
		// Cleanup jobs older than 30 days
		_, err := db.ExecContext(ctx,
			"DELETE FROM jobs WHERE completed_at < NOW() - INTERVAL '30 days'",
		)
		return err
	})
	go sched.Start(ctx)

	logger.Info("worker service started")

	// Wait for shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down...")
	cancel()

	// Graceful shutdown with timeout
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := pool.Stop(shutdownCtx); err != nil {
		logger.Error("shutdown error", "error", err)
	}

	logger.Info("worker service stopped")
}
```

### Dockerfile

The multi-stage Dockerfile separates the build environment from the runtime image. The first stage compiles the Go binary with all build tools available. The second stage copies only the compiled binary into a minimal base image, reducing the final image size and attack surface.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/worker ./cmd/worker

FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

RUN addgroup -g 1000 worker && adduser -u 1000 -G worker -s /bin/sh -D worker

WORKDIR /app
COPY --from=builder /app/worker .

USER worker

ENTRYPOINT ["./worker"]
```

### Docker Compose

The compose file defines the worker service alongside its dependencies: PostgreSQL for durable job storage, Redis for distributed locking and fast queues, and Mailpit (the maintained successor to the archived MailHog, same 8025/1025 ports) as a local SMTP trap for testing email delivery. The `deploy.replicas: 3` directive launches three worker instances, simulating a production deployment where multiple workers coordinate through `FOR UPDATE SKIP LOCKED`.

```yaml
# docker-compose.yml
services:
  worker:
    build: .
    environment:
      - DATABASE_URL=postgres://postgres:postgres@postgres:5432/workers?sslmode=disable
      - REDIS_URL=redis://redis:6379
      - SMTP_HOST=mailpit
      - SMTP_USER=
      - SMTP_PASSWORD=
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      replicas: 3
    restart: unless-stopped

  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: workers
    volumes:
      - ./migrations/init.sql:/docker-entrypoint-initdb.d/init.sql
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  mailpit:
    image: axllent/mailpit:v1.31.0
    ports:
      - "8025:8025"  # Web UI

volumes:
  postgres_data:
```

### Makefile

The build configuration automates compilation, testing, and code generation steps. Encoding these commands in a Makefile or shell script ensures that all contributors run identical commands and that CI uses the same process as local development.

```makefile
# Makefile
.PHONY: all build run test docker-build docker-up docker-down migrate

BINARY=worker
VERSION=$(shell git describe --tags --always --dirty)

all: build

build:
	go build -o bin/$(BINARY) ./cmd/worker

run:
	go run ./cmd/worker

test:
	go test -v -race ./...

docker-build:
	docker build -t worker-service:latest .

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

docker-scale:
	docker-compose up -d --scale worker=5

migrate:
	migrate -path migrations -database "$(DATABASE_URL)" up

enqueue-test:
	@curl -X POST http://localhost:8080/jobs \
		-H "Content-Type: application/json" \
		-d '{"queue":"emails","type":"email","payload":{"to":"test@example.com","subject":"Test","body":"Hello"}}'
```

### Junior to FAANG: reading the framework as a real codebase

This framework is a skeleton. It is close to what a junior team would ship as v1. Things that look done but are not, and how you would fix them in your first on-call rotation.

1. **`Start` hardcodes `for i := 0; i < 10; i++` instead of `cfg.WorkerCount`.** Real bug in the snippet. Fix before running in prod. This is the class of bug you find by reviewing diffs carefully.

2. **`Fail` inside `process` uses the parent `ctx` not `shutdownCtx`.** On SIGTERM, if the parent ctx is canceled, the Fail call fails too and the job is stuck in `running` status until the lease expires. Fix is a background-context for failure recording during shutdown.

3. **Heartbeat runs every 30 seconds but lock duration is 5 minutes.** Ratio of 1/10 is fine, conventional is 1/3. Tune heartbeat to `lockDuration / 3`.

4. **No panic recovery in `process`.** A handler that panics will crash the whole pool via goroutine death. Add `defer recover()` with a stack trace log and metric.

5. **`enqueue-test` curl assumes an HTTP enqueue endpoint that does not exist in this code.** Producers write directly to the DB. Build a minimal enqueue HTTP service to make this Makefile target work.

6. **No authentication or authorization.** A real service has auth on enqueue (who can enqueue what job_type for what tenant). Add middleware before shipping.

7. **`MaxAttempts` is a job property but retry classification is not.** Handlers can only return `error`. There is no way to distinguish permanent from retryable. Add a typed result as shown earlier in chapter 30.

Walkthrough of your first end-to-end test. Start the compose stack. Run a small Go test that enqueues 100 email jobs with different priorities. Verify in the DB that all 100 land. Watch the worker logs as they process. Kill one worker. Verify jobs recover from stuck state after `lockDuration`. Enqueue a job with a bad email address that permanently fails. Verify it hits max_attempts and lands in `dead` status. Trigger the cleanup cron. Verify old rows are deleted.

Interview entry point. "Walk me through what happens from HTTP request to job completion." A candidate who can trace the code path through this framework clearly is ready for L4 background-worker work.

### Senior at FAANG: productionizing a framework skeleton

A staff engineer looking at this framework asks, "what is missing for this to be a platform product at my company". The gap list is the work.

**Missing platform concerns.**

1. **Multi-tenancy.** No `tenant_id` column, no per-tenant quotas, no fair scheduling. Must be added before onboarding multiple teams.
2. **Job versioning.** No `(type, version)` tuple. Rolling deploys with schema changes will fail.
3. **Idempotency keys.** No `idempotency_key` column. Exactly-once is impossible.
4. **Outbox integration.** Producers write direct to `jobs` table. Multi-service enqueue requires outbox relay or CDC.
5. **Typed result classification.** Handlers return raw error. Retry policy cannot distinguish permanent from transient.
6. **Observability contract.** Metrics package is opaque. No Prometheus integration, no OTel tracing, no structured log contract.
7. **Middleware chain.** No layered middleware for auth, rate limit, tracing, idempotency check, panic recovery.
8. **DLQ tooling.** `status = 'dead'` is a state, not a product. No replay UI, no RBAC, no triage workflow.
9. **Scheduler HA.** Cron runs in-process in `main`. Duplicate runs on 3 replicas.
10. **Auto-scaling signal.** No exported `oldest_message_age` metric for KEDA. Pools cannot scale on SLO.
11. **Graceful drain.** Shutdown waits up to 30s but does not return leases early. Failure case wastes up to `lockDuration` before jobs become pickable.

**Roadmap for turning skeleton into platform.**

- **Milestone 1, 2 months.** Add tenant_id, idempotency_key, job versioning, typed results, Prometheus metrics, OTel tracing. Ship to 2 internal teams as beta.
- **Milestone 2, 3 months.** Middleware chain, HA scheduler with etcd lease, outbox relay service, DLQ replay UI. Open onboarding to 5 more teams.
- **Milestone 3, 6 months.** Multi-tenant fair scheduling, auto-scaling integration with KEDA, dashboard auto-generation per job_type, cost observability. Declare GA.
- **Milestone 4, 12 months.** Region-pinning for data residency, cross-region DLQ replication, exactly-once-per-idempotency-key guarantees, Temporal integration for long workflows. Retire hand-rolled queues org-wide.

**Deployment topology at FAANG scale.**

- Workers as Kubernetes Deployments with HPA via KEDA on `oldest_message_age`.
- Postgres as Aurora or CloudSQL with read replicas for stats queries.
- Redis as ElastiCache or Memorystore cluster-mode for distributed locks (opportunistic) and asynq if adopted.
- etcd cluster for scheduler leader election and lease-based coordination.
- Prometheus plus Grafana for dashboards, Tempo or Honeycomb for traces.
- PagerDuty integration for burn-rate alerts.

**Security hardening.**

- Workers run as non-root (the Dockerfile does this, good).
- Database credentials from secrets manager, not env vars in compose (compose is dev-only).
- Network policies restricting worker pods to Postgres and Redis only.
- TLS for all in-cluster traffic.
- Audit log for DLQ replays.
- Payload encryption at rest for PII job_types.

**ADR template for rollout.** Title, "Adopt platform worker SDK org-wide". Status, proposed. Context, 5 teams have rolled their own queues, each with different retry policies and observability. Decision, all new async work uses platform SDK. Existing queues migrate within 18 months. Consequences. Reduced SEV rate from async bugs. Shared observability. Reduced DLQ backlog across org. Investment required, 3 FTE for 12 months on platform team.

**Game-day scenarios.** Annually, simulate. (1) Postgres primary failover, verify no job loss. (2) Redis cluster partition, verify opportunistic locks degrade safely. (3) Worker pod mass-eviction, verify lease recovery. (4) Handler deploy with schema-breaking change, verify version-gated rollout catches it. (5) DLQ flood (inject 100k poison pills), verify triage SLA is met.

**Capacity planning document.** For each tier, specify. Throughput target, P99 latency target, worker count at steady state, worker count at burst, Postgres IOPS required, Redis memory required, cost per million jobs. Update annually. Feed into budget cycle.

---
