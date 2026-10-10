## 52G.10 Complete Task Processing System

This section ties together the patterns from the entire chapter into a complete background job processing system. The application accepts jobs through an HTTP API, publishes them to a RabbitMQ priority queue with publisher confirms, and processes them through a configurable worker pool. Each worker runs on its own AMQP channel with manual acknowledgment and dead-letter routing for failed jobs. The entrypoint function handles graceful shutdown via OS signals, draining in-flight work before closing connections.

```go
package jobsystem

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ============================================================
// Domain types
// ============================================================

// JobPriority represents task urgency levels (RabbitMQ priority 1-10).
type JobPriority uint8

const (
	PriorityLow    JobPriority = 1
	PriorityMedium JobPriority = 5
	PriorityHigh   JobPriority = 9
)

// Job represents a unit of work submitted through the HTTP API.
type Job struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Priority  JobPriority     `json:"priority"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}

// JobStatus tracks job lifecycle.
type JobStatus string

const (
	StatusPending    JobStatus = "pending"
	StatusProcessing JobStatus = "processing"
	StatusDone       JobStatus = "done"
	StatusFailed     JobStatus = "failed"
)

// ============================================================
// Worker Pool
// ============================================================

// WorkerPool manages a configurable number of concurrent consumers.
type WorkerPool struct {
	conn        *amqp.Connection
	queueName   string
	concurrency int
	handler     JobHandler
	logger      *slog.Logger
	wg          sync.WaitGroup
}

// JobHandler processes a job. Return error to nack.
type JobHandler func(ctx context.Context, job Job) error

// NewWorkerPool creates a worker pool.
func NewWorkerPool(conn *amqp.Connection, queue string, concurrency int, handler JobHandler, logger *slog.Logger) *WorkerPool {
	return &WorkerPool{
		conn:        conn,
		queueName:   queue,
		concurrency: concurrency,
		handler:     handler,
		logger:      logger,
	}
}

// Start launches concurrency worker goroutines, each with its own channel.
func (wp *WorkerPool) Start(ctx context.Context) error {
	for i := 0; i < wp.concurrency; i++ {
		workerID := i + 1
		ch, err := wp.conn.Channel()
		if err != nil {
			return fmt.Errorf("worker %d: open channel: %w", workerID, err)
		}

		if err := ch.Qos(10, 0, false); err != nil {
			_ = ch.Close()
			return fmt.Errorf("worker %d: set qos: %w", workerID, err)
		}

		deliveries, err := ch.Consume(wp.queueName, "", false, false, false, false, nil)
		if err != nil {
			_ = ch.Close()
			return fmt.Errorf("worker %d: consume: %w", workerID, err)
		}

		wp.wg.Add(1)
		go wp.runWorker(ctx, workerID, ch, deliveries)
	}

	wp.logger.Info("worker pool started",
		"concurrency", wp.concurrency,
		"queue", wp.queueName,
	)
	return nil
}

// Wait blocks until all workers have stopped.
func (wp *WorkerPool) Wait() {
	wp.wg.Wait()
}

func (wp *WorkerPool) runWorker(ctx context.Context, id int, ch *amqp.Channel, deliveries <-chan amqp.Delivery) {
	defer wp.wg.Done()
	defer ch.Close()

	logger := wp.logger.With("worker_id", id)
	logger.Info("worker: started")

	for {
		select {
		case d, ok := <-deliveries:
			if !ok {
				logger.Warn("worker: delivery channel closed")
				return
			}

			wp.processJob(ctx, logger, d)

		case <-ctx.Done():
			logger.Info("worker: context canceled, stopping")
			return
		}
	}
}

func (wp *WorkerPool) processJob(ctx context.Context, logger *slog.Logger, d amqp.Delivery) {
	var job Job
	if err := json.Unmarshal(d.Body, &job); err != nil {
		logger.Error("worker: invalid job payload, rejecting",
			"error", err,
			"body", string(d.Body),
		)
		_ = d.Reject(false) // requeue=false → DLX
		return
	}

	start := time.Now()
	logger = logger.With("job_id", job.ID, "job_type", job.Type, "priority", job.Priority)
	logger.Info("worker: processing job")

	if err := wp.handler(ctx, job); err != nil {
		logger.Error("worker: job failed",
			"error", err,
			"duration", time.Since(start),
			"redelivered", d.Redelivered,
		)
		requeue := !d.Redelivered
		_ = d.Nack(false, requeue)
		return
	}

	logger.Info("worker: job completed", "duration", time.Since(start))
	_ = d.Ack(false)
}

// ============================================================
// HTTP API
// ============================================================

// JobAPI exposes endpoints to submit jobs and check status.
type JobAPI struct {
	publisher *ConfirmingPublisher
	exchange  string
	queueName string
	logger    *slog.Logger
}

// ConfirmingPublisher is the publisher from §52G.4 (referenced here).
type ConfirmingPublisher struct {
	ch     *amqp.Channel
	logger *slog.Logger
}

func NewConfirmingPublisherSimple(ch *amqp.Channel, logger *slog.Logger) (*ConfirmingPublisher, error) {
	if err := ch.Confirm(false); err != nil {
		return nil, fmt.Errorf("confirm mode: %w", err)
	}
	return &ConfirmingPublisher{ch: ch, logger: logger}, nil
}

func (p *ConfirmingPublisher) Publish(ctx context.Context, exchange, key string, priority uint8, body []byte) error {
	return p.ch.PublishWithContext(ctx, exchange, key, true, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Priority:     priority,
			Timestamp:    time.Now(),
			Body:         body,
		},
	)
}

// NewJobAPI creates the HTTP handler set.
func NewJobAPI(pub *ConfirmingPublisher, exchange, queueName string, logger *slog.Logger) *JobAPI {
	return &JobAPI{
		publisher: pub,
		exchange:  exchange,
		queueName: queueName,
		logger:    logger,
	}
}

// SubmitHandler handles POST /jobs.
func (a *JobAPI) SubmitHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var job Job
	if err := json.NewDecoder(r.Body).Decode(&job); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if job.ID == "" || job.Type == "" {
		http.Error(w, "id and type are required", http.StatusBadRequest)
		return
	}
	if job.Priority == 0 {
		job.Priority = PriorityMedium
	}
	job.CreatedAt = time.Now().UTC()

	body, err := json.Marshal(job)
	if err != nil {
		http.Error(w, "marshal error", http.StatusInternalServerError)
		return
	}

	if err := a.publisher.Publish(r.Context(), a.exchange, a.queueName, uint8(job.Priority), body); err != nil {
		a.logger.Error("api: publish failed", "error", err, "job_id", job.ID)
		http.Error(w, "failed to enqueue job", http.StatusServiceUnavailable)
		return
	}

	a.logger.Info("api: job submitted", "job_id", job.ID, "priority", job.Priority)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": job.ID, "status": string(StatusPending)})
}

// ============================================================
// Priority Queue Setup
// ============================================================

// SetupPriorityQueue declares a queue with x-max-priority.
// RabbitMQ supports priorities 1-255 - using >10 wastes memory.
func SetupPriorityQueue(ch *amqp.Channel, name string) (amqp.Queue, error) {
	return ch.QueueDeclare(name, true, false, false, false, amqp.Table{
		"x-max-priority":            int32(10),
		"x-dead-letter-exchange":    name + ".dlx",
		"x-dead-letter-routing-key": name,
		"x-max-length":              int32(1_000_000),
	})
}

// ============================================================
// Application Entrypoint
// ============================================================

// AppConfig holds all runtime configuration.
type AppConfig struct {
	RabbitMQURL string
	QueueName   string
	Exchange    string
	Workers     int
	HTTPAddr    string
}

// Run is the application entrypoint, implementing graceful shutdown.
func Run(cfg AppConfig) error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Connect to RabbitMQ.
	conn, err := amqp.Dial(cfg.RabbitMQURL)
	if err != nil {
		return fmt.Errorf("rabbitmq: dial: %w", err)
	}
	defer conn.Close()

	// Setup topology.
	setupCh, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("setup channel: %w", err)
	}
	if _, err := SetupPriorityQueue(setupCh, cfg.QueueName); err != nil {
		return fmt.Errorf("setup queue: %w", err)
	}
	_ = setupCh.Close()

	// Publisher channel.
	pubCh, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("publisher channel: %w", err)
	}
	defer pubCh.Close()

	pub, err := NewConfirmingPublisherSimple(pubCh, logger)
	if err != nil {
		return fmt.Errorf("publisher: %w", err)
	}

	// Worker pool.
	handler := func(ctx context.Context, job Job) error {
		logger.Info("processing job", "id", job.ID, "type", job.Type)
		// Simulate work.
		time.Sleep(100 * time.Millisecond)
		return nil
	}

	pool := NewWorkerPool(conn, cfg.QueueName, cfg.Workers, handler, logger)
	if err := pool.Start(ctx); err != nil {
		return fmt.Errorf("worker pool: %w", err)
	}

	// HTTP API.
	api := NewJobAPI(pub, cfg.Exchange, cfg.QueueName, logger)
	mux := http.NewServeMux()
	mux.HandleFunc("/jobs", api.SubmitHandler)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	server := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("http: listening", "addr", cfg.HTTPAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http: server error", "error", err)
		}
	}()

	<-ctx.Done()
	logger.Info("shutdown: signal received")

	shutCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_ = server.Shutdown(shutCtx)
	pool.Wait()
	logger.Info("shutdown: complete")
	return nil
}
```

### Junior → FAANG: Reading a Complete System Before Building One

The complete task processing system in this section is the kind of system design you will be asked to sketch in a FAANG interview. Before you try to draw it from scratch, understand what each component in this implementation does and why it exists.

**The worker pool pattern and why each worker needs its own channel:**

Each goroutine in the worker pool has its own AMQP channel. This is not optional. Sharing a channel across goroutines causes concurrent delivery reads to race. The correct model: one goroutine owns one channel exclusively for its lifetime. The delivery channel (`<-chan amqp.Delivery`) returned by `ch.Consume` is safe to read from a single goroutine. When the worker goroutine exits, it closes its channel, which returns all in-flight unacked messages to the queue.

**Why graceful shutdown matters for at-least-once guarantees:**

The `Run` function waits for `ctx.Done()` before returning. When the OS sends SIGTERM, the signal notifies context, which cancels the consumer loop. The worker goroutines finish their current message, ack it, and exit cleanly. If you skip graceful shutdown and call `os.Exit` directly, all in-flight messages (those delivered but not yet acked) return to the queue when the connection closes. This is correct for at-least-once but causes redelivery. Graceful shutdown eliminates unnecessary redeliveries during planned restarts.

**The HTTP API and the publisher/consumer separation:**

The system has two AMQP channels: one for the confirming publisher (used by the HTTP API handler) and separate channels per worker goroutine (used by the consumer pool). This separation is correct. Mixing publisher and consumer operations on the same channel does not cause a protocol error, but it adds coupling: a consumer processing delay could starve the confirm handler for the publisher. Dedicated channels per role give independent flow control.

**Interview sketch: components to name in order:**

HTTP handler receives request. Publisher with confirms publishes to exchange with routing key. Exchange routes to quorum queue with DLX and max-length configured. Worker pool consumes with per-goroutine channels and prefetch set. On failure, nack routes to DLX. DLX routes to retry queues with TTL. After max retries, permanent DLQ. Graceful shutdown drains in-flight work. This is the complete correct answer.

### Senior @ FAANG: Production-Hardening the Complete System

The complete system in this section is a correct skeleton but is missing several components that a senior engineer would add before calling it production-ready.

**Missing: connection recovery wired into the worker pool:**

The `Run` function creates an `amqp.Dial` connection and uses it for the lifetime of the process. If the broker node hosting this connection restarts, the connection closes, the delivery channels close, and all workers exit. The `Run` function returns an error. But `Run` is called from `main`, which then exits the process. A Kubernetes deployment restarts the pod, which reconnects. This is functional but results in 30-60 seconds of downtime per broker restart because Kubernetes restarts are not instant. The correct design replaces the raw `amqp.Dial` with `ReliableConnection.RunWithReconnect` from section 52G.7, wiring the worker pool startup into the `onConnected` callback. This gives sub-5-second recovery without pod restart.

**Missing: idempotency enforcement in the handler:**

The handler in `Run` calls `time.Sleep(100 * time.Millisecond)` to simulate work. A production handler must be idempotent because any message can be redelivered: on consumer crash, on channel close, or on nack-with-requeue. The idempotency mechanism depends on the job type: for database writes, check if the job ID already exists before inserting. For HTTP calls to external services, include the job ID as an idempotency key. For file writes, write to a temporary path and atomically rename. The job ID in the `Job` struct is the idempotency key. Every handler must use it.

**Missing: publisher confirm wired correctly:**

`NewConfirmingPublisherSimple` in this section enables confirm mode but does not implement the full async confirm tracking loop from section 52G.4. It is a simplified version that returns nil without waiting for confirms. This means the HTTP handler returns 202 Accepted before knowing whether the broker received the message. In a production system, `SubmitHandler` must wait for the broker confirm before responding with 202. Either use `PublishAndWait` for synchronous confirmation (adds 1-3ms latency per request but gives the caller a guarantee) or use async confirms with a response channel that the HTTP handler waits on.

**Missing: structured tracing across the broker boundary:**

Every job should carry a trace ID from the HTTP request through the publish and into the consumer. Add a `TraceID` field to the `Job` struct and propagate it in the AMQP message headers. The consumer extracts the trace ID and attaches it to its structured log context at the start of `processJob`. This enables correlation of the HTTP request log, the publish log, and the consumer processing log in a single trace query, which is essential for debugging failures in production.

---
