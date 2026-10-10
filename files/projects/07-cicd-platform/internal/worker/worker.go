package worker

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"github.com/example/cicd-platform/internal/domain"
	"github.com/example/cicd-platform/internal/executor"
	"github.com/example/cicd-platform/internal/queue"
	"github.com/example/cicd-platform/internal/storage"
)

// Worker processes jobs from the queue
type Worker struct {
	id       uuid.UUID
	name     string
	hostname string
	capacity int // Max concurrent jobs

	queue    *queue.JobQueue
	executor executor.Executor
	storage  *storage.DB

	currentJobs int
	stopCh      chan struct{}
}

// Config contains worker configuration
type Config struct {
	Name     string
	Capacity int
	WorkDir  string
	LogDir   string
}

// New creates a new worker
func New(cfg *Config, q *queue.JobQueue, db *storage.DB) (*Worker, error) {
	// Create Docker executor
	exec, err := executor.NewDockerExecutor(cfg.WorkDir, cfg.LogDir)
	if err != nil {
		return nil, fmt.Errorf("create executor: %w", err)
	}

	hostname, _ := os.Hostname()

	return &Worker{
		id:       uuid.New(),
		name:     cfg.Name,
		hostname: hostname,
		capacity: cfg.Capacity,
		queue:    q,
		executor: exec,
		storage:  db,
		stopCh:   make(chan struct{}),
	}, nil
}

// Start starts the worker
func (w *Worker) Start(ctx context.Context) error {
	log.Info().
		Str("worker_id", w.id.String()).
		Str("name", w.name).
		Int("capacity", w.capacity).
		Msg("Worker starting")

	// Register worker in database
	if err := w.register(ctx); err != nil {
		return fmt.Errorf("register worker: %w", err)
	}

	// Start health reporter
	go w.reportHealth(ctx)

	// Start job processor
	go w.processJobs(ctx)

	// Wait for stop signal
	<-w.stopCh

	log.Info().Msg("Worker stopped")
	return nil
}

// Stop stops the worker gracefully
func (w *Worker) Stop() {
	close(w.stopCh)
}

// register registers the worker in the database
func (w *Worker) register(ctx context.Context) error {
	// In production, this would insert/update worker record in database
	log.Info().
		Str("worker_id", w.id.String()).
		Msg("Worker registered")
	return nil
}

// reportHealth periodically reports worker health
func (w *Worker) reportHealth(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// Update worker status in database
			log.Debug().
				Str("worker_id", w.id.String()).
				Int("current_jobs", w.currentJobs).
				Msg("Health check")

		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		}
	}
}

// processJobs processes jobs from the queue
func (w *Worker) processJobs(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
			// Check capacity
			if w.currentJobs >= w.capacity {
				time.Sleep(1 * time.Second)
				continue
			}

			// Dequeue job
			jobMsg, err := w.queue.Dequeue(ctx)
			if err != nil {
				if err != queue.ErrEmptyQueue {
					log.Error().Err(err).Msg("Failed to dequeue job")
				}
				time.Sleep(1 * time.Second)
				continue
			}

			// Process job asynchronously
			w.currentJobs++
			go func(msg *queue.JobMessage) {
				defer func() { w.currentJobs-- }()

				if err := w.processJob(ctx, msg); err != nil {
					log.Error().
						Err(err).
						Str("job_run_id", msg.JobRunID.String()).
						Msg("Failed to process job")
				}
			}(jobMsg)
		}
	}
}

// processJob processes a single job
func (w *Worker) processJob(ctx context.Context, msg *queue.JobMessage) error {
	jobRunID := msg.JobRunID

	log.Info().
		Str("job_run_id", jobRunID.String()).
		Msg("Processing job")

	// Update job status to running
	jobRunStore := storage.NewJobRunStore(w.storage)
	startedAt := time.Now()

	if err := jobRunStore.UpdateStatus(
		ctx,
		jobRunID,
		domain.JobStatusRunning,
		&w.id,
		nil,
		&startedAt,
		nil,
		"",
	); err != nil {
		return fmt.Errorf("update job status: %w", err)
	}

	// Get job run details
	jobRun, err := jobRunStore.GetByID(ctx, jobRunID)
	if err != nil {
		return fmt.Errorf("get job run: %w", err)
	}

	// TODO: Get job config, execute job
	// This is a placeholder - full implementation would:
	// 1. Clone repository
	// 2. Parse job config
	// 3. Execute job using executor
	// 4. Collect artifacts
	// 5. Upload logs
	// 6. Update final status

	_ = jobRun

	// Simulate job execution
	time.Sleep(5 * time.Second)

	// Update job status to success
	completedAt := time.Now()
	exitCode := 0

	if err := jobRunStore.UpdateStatus(
		ctx,
		jobRunID,
		domain.JobStatusSuccess,
		&w.id,
		&exitCode,
		nil,
		&completedAt,
		"",
	); err != nil {
		return fmt.Errorf("update job status: %w", err)
	}

	log.Info().
		Str("job_run_id", jobRunID.String()).
		Msg("Job completed successfully")

	return nil
}
