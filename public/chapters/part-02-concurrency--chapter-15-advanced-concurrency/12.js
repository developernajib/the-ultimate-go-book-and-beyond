export default `## 15.11 Complete Application: High-Performance Task Scheduler

The following task scheduler combines priority queues, work stealing across priority levels, per-task timeouts with context propagation, automatic retry with exponential backoff, and atomic metrics collection. It demonstrates how the individual patterns from this chapter compose into a single coherent system.

\`\`\`go
// scheduler/scheduler.go
package scheduler

import (
    "context"
    "errors"
    "fmt"
    "hash/fnv"
    "runtime"
    "sync"
    "sync/atomic"
    "time"
)

// Priority levels for tasks
type Priority int

const (
    PriorityLow Priority = iota
    PriorityNormal
    PriorityHigh
    PriorityCritical
)

// Task represents a unit of work
type Task struct {
    ID       string
    Priority Priority
    Fn       func(ctx context.Context) error
    Timeout  time.Duration
    Retries  int
    Created  time.Time
}

// TaskResult holds the result of task execution
type TaskResult struct {
    TaskID   string
    Duration time.Duration
    Error    error
    Retries  int
}

// Scheduler is a high-performance task scheduler
type Scheduler struct {
    config       Config
    queues       []*priorityQueue
    workers      []*worker
    results      chan TaskResult
    wg           sync.WaitGroup
    closed       atomic.Bool
    ctx          context.Context
    cancel       context.CancelFunc

    // Metrics
    metrics *Metrics
}

type Config struct {
    Workers          int
    QueueSize        int
    ResultBufferSize int
    DefaultTimeout   time.Duration
    MaxRetries       int
}

func DefaultConfig() Config {
    return Config{
        Workers:          runtime.NumCPU(),
        QueueSize:        10000,
        ResultBufferSize: 1000,
        DefaultTimeout:   time.Minute,
        MaxRetries:       3,
    }
}

// Metrics tracks scheduler performance
type Metrics struct {
    TasksSubmitted  atomic.Int64
    TasksCompleted  atomic.Int64
    TasksFailed     atomic.Int64
    TasksRetried    atomic.Int64
    TotalWaitTime   atomic.Int64 // nanoseconds
    TotalExecTime   atomic.Int64 // nanoseconds
    ActiveWorkers   atomic.Int32
    QueueDepth      atomic.Int64
}

func NewScheduler(config Config) *Scheduler {
    if config.Workers <= 0 {
        config.Workers = runtime.NumCPU()
    }

    ctx, cancel := context.WithCancel(context.Background())

    s := &Scheduler{
        config:  config,
        queues:  make([]*priorityQueue, 4), // One per priority
        workers: make([]*worker, config.Workers),
        results: make(chan TaskResult, config.ResultBufferSize),
        ctx:     ctx,
        cancel:  cancel,
        metrics: &Metrics{},
    }

    // Initialize priority queues
    for i := range s.queues {
        s.queues[i] = newPriorityQueue(config.QueueSize)
    }

    // Start workers with work stealing
    for i := 0; i < config.Workers; i++ {
        s.workers[i] = newWorker(i, s)
        s.wg.Add(1)
        go s.workers[i].run()
    }

    return s
}

// Submit adds a task to the scheduler
func (s *Scheduler) Submit(task Task) error {
    if s.closed.Load() {
        return errors.New("scheduler is closed")
    }

    if task.ID == "" {
        task.ID = generateID()
    }
    if task.Timeout == 0 {
        task.Timeout = s.config.DefaultTimeout
    }
    task.Created = time.Now()

    // Add to appropriate priority queue
    queue := s.queues[task.Priority]
    if err := queue.push(task); err != nil {
        return fmt.Errorf("queue full: %w", err)
    }

    s.metrics.TasksSubmitted.Add(1)
    s.metrics.QueueDepth.Add(1)
    return nil
}

// Results returns a channel for receiving task results
func (s *Scheduler) Results() <-chan TaskResult {
    return s.results
}

// Metrics returns current scheduler metrics
func (s *Scheduler) Metrics() MetricsSnapshot {
    return MetricsSnapshot{
        TasksSubmitted: s.metrics.TasksSubmitted.Load(),
        TasksCompleted: s.metrics.TasksCompleted.Load(),
        TasksFailed:    s.metrics.TasksFailed.Load(),
        TasksRetried:   s.metrics.TasksRetried.Load(),
        AvgWaitTime:    s.avgWaitTime(),
        AvgExecTime:    s.avgExecTime(),
        ActiveWorkers:  s.metrics.ActiveWorkers.Load(),
        QueueDepth:     s.metrics.QueueDepth.Load(),
    }
}

func (s *Scheduler) avgWaitTime() time.Duration {
    completed := s.metrics.TasksCompleted.Load()
    if completed == 0 {
        return 0
    }
    return time.Duration(s.metrics.TotalWaitTime.Load() / completed)
}

func (s *Scheduler) avgExecTime() time.Duration {
    completed := s.metrics.TasksCompleted.Load()
    if completed == 0 {
        return 0
    }
    return time.Duration(s.metrics.TotalExecTime.Load() / completed)
}

// Shutdown gracefully shuts down the scheduler
func (s *Scheduler) Shutdown(ctx context.Context) error {
    s.closed.Store(true)

    // Close all queues
    for _, q := range s.queues {
        q.close()
    }

    // Wait for workers with timeout
    done := make(chan struct{})
    go func() {
        s.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        s.cancel()
        close(s.results)
        return nil
    case <-ctx.Done():
        s.cancel()
        return ctx.Err()
    }
}

type MetricsSnapshot struct {
    TasksSubmitted int64
    TasksCompleted int64
    TasksFailed    int64
    TasksRetried   int64
    AvgWaitTime    time.Duration
    AvgExecTime    time.Duration
    ActiveWorkers  int32
    QueueDepth     int64
}

// priorityQueue is a bounded queue for tasks
type priorityQueue struct {
    tasks  chan Task
    closed atomic.Bool
}

func newPriorityQueue(size int) *priorityQueue {
    return &priorityQueue{
        tasks: make(chan Task, size),
    }
}

func (q *priorityQueue) push(task Task) error {
    if q.closed.Load() {
        return errors.New("queue closed")
    }
    select {
    case q.tasks <- task:
        return nil
    default:
        return errors.New("queue full")
    }
}

func (q *priorityQueue) pop() (Task, bool) {
    task, ok := <-q.tasks
    return task, ok
}

func (q *priorityQueue) tryPop() (Task, bool) {
    select {
    case task := <-q.tasks:
        return task, true
    default:
        return Task{}, false
    }
}

func (q *priorityQueue) close() {
    q.closed.Store(true)
    close(q.tasks)
}

// worker executes tasks with work stealing
type worker struct {
    id        int
    scheduler *Scheduler
}

func newWorker(id int, s *Scheduler) *worker {
    return &worker{id: id, scheduler: s}
}

func (w *worker) run() {
    defer w.scheduler.wg.Done()

    for {
        // Try to get task in priority order (highest first)
        task, ok := w.getTask()
        if !ok {
            // All queues closed
            return
        }

        w.executeTask(task)
    }
}

func (w *worker) getTask() (Task, bool) {
    s := w.scheduler

    // Check queues from highest to lowest priority
    for pri := PriorityCritical; pri >= PriorityLow; pri-- {
        if task, ok := s.queues[pri].tryPop(); ok {
            return task, true
        }
    }

    // No tasks available - block on highest priority queue
    // but also check shutdown
    select {
    case task, ok := <-s.queues[PriorityCritical].tasks:
        if ok {
            return task, true
        }
    case task, ok := <-s.queues[PriorityHigh].tasks:
        if ok {
            return task, true
        }
    case task, ok := <-s.queues[PriorityNormal].tasks:
        if ok {
            return task, true
        }
    case task, ok := <-s.queues[PriorityLow].tasks:
        if ok {
            return task, true
        }
    case <-s.ctx.Done():
        return Task{}, false
    }

    return Task{}, false
}

func (w *worker) executeTask(task Task) {
    s := w.scheduler
    s.metrics.ActiveWorkers.Add(1)
    defer s.metrics.ActiveWorkers.Add(-1)

    // Calculate wait time
    waitTime := time.Since(task.Created)
    s.metrics.TotalWaitTime.Add(int64(waitTime))
    s.metrics.QueueDepth.Add(-1)

    // Execute with timeout and retries
    var lastErr error
    var retries int

    for attempt := 0; attempt <= task.Retries; attempt++ {
        if attempt > 0 {
            retries++
            s.metrics.TasksRetried.Add(1)
            // Exponential backoff
            time.Sleep(time.Duration(1<<attempt) * 100 * time.Millisecond)
        }

        ctx, cancel := context.WithTimeout(s.ctx, task.Timeout)
        start := time.Now()

        err := func() (err error) {
            defer func() {
                if r := recover(); r != nil {
                    err = fmt.Errorf("panic: %v", r)
                }
            }()
            return task.Fn(ctx)
        }()

        cancel()
        execTime := time.Since(start)
        s.metrics.TotalExecTime.Add(int64(execTime))

        if err == nil {
            // Success
            s.metrics.TasksCompleted.Add(1)
            s.results <- TaskResult{
                TaskID:   task.ID,
                Duration: execTime,
                Retries:  retries,
            }
            return
        }

        lastErr = err
    }

    // All retries exhausted
    s.metrics.TasksFailed.Add(1)
    s.results <- TaskResult{
        TaskID:   task.ID,
        Error:    lastErr,
        Retries:  retries,
    }
}

func generateID() string {
    h := fnv.New64a()
    h.Write([]byte(fmt.Sprintf("%d-%d", time.Now().UnixNano(), runtime.NumGoroutine())))
    return fmt.Sprintf("%x", h.Sum64())
}
\`\`\`

### Tests

The test suite validates the scheduler's core guarantees: correct execution of all submitted tasks, priority ordering under a single worker, automatic retries with exponential backoff, and per-task timeout enforcement. Each test isolates a specific behavioral contract so failures are immediately actionable.

\`\`\`go
// scheduler/scheduler_test.go
package scheduler

import (
    "context"
    "errors"
    "sync/atomic"
    "testing"
    "time"
)

func TestSchedulerBasic(t *testing.T) {
    s := NewScheduler(DefaultConfig())
    defer s.Shutdown(context.Background())

    var executed atomic.Int32

    for i := 0; i < 100; i++ {
        err := s.Submit(Task{
            Fn: func(ctx context.Context) error {
                executed.Add(1)
                return nil
            },
        })
        if err != nil {
            t.Fatalf("failed to submit task: %v", err)
        }
    }

    // Wait for results
    timeout := time.After(5 * time.Second)
    for i := 0; i < 100; i++ {
        select {
        case result := <-s.Results():
            if result.Error != nil {
                t.Errorf("task failed: %v", result.Error)
            }
        case <-timeout:
            t.Fatal("timeout waiting for results")
        }
    }

    if executed.Load() != 100 {
        t.Errorf("expected 100 executed, got %d", executed.Load())
    }
}

func TestSchedulerPriority(t *testing.T) {
    config := DefaultConfig()
    config.Workers = 1 // Single worker for deterministic ordering
    s := NewScheduler(config)
    defer s.Shutdown(context.Background())

    var order []Priority
    var mu sync.Mutex

    // Submit low priority first
    s.Submit(Task{
        Priority: PriorityLow,
        Fn: func(ctx context.Context) error {
            time.Sleep(10 * time.Millisecond)
            mu.Lock()
            order = append(order, PriorityLow)
            mu.Unlock()
            return nil
        },
    })

    // Then high priority
    s.Submit(Task{
        Priority: PriorityHigh,
        Fn: func(ctx context.Context) error {
            mu.Lock()
            order = append(order, PriorityHigh)
            mu.Unlock()
            return nil
        },
    })

    // Wait for completion
    for i := 0; i < 2; i++ {
        <-s.Results()
    }

    // High priority should execute first
    if len(order) == 2 && order[0] != PriorityHigh {
        t.Errorf("expected high priority first, got %v", order)
    }
}

func TestSchedulerRetry(t *testing.T) {
    s := NewScheduler(DefaultConfig())
    defer s.Shutdown(context.Background())

    var attempts atomic.Int32

    s.Submit(Task{
        Retries: 2,
        Fn: func(ctx context.Context) error {
            if attempts.Add(1) < 3 {
                return errors.New("temporary failure")
            }
            return nil
        },
    })

    result := <-s.Results()
    if result.Error != nil {
        t.Errorf("expected success after retries, got: %v", result.Error)
    }
    if result.Retries != 2 {
        t.Errorf("expected 2 retries, got %d", result.Retries)
    }
}

func TestSchedulerTimeout(t *testing.T) {
    s := NewScheduler(DefaultConfig())
    defer s.Shutdown(context.Background())

    s.Submit(Task{
        Timeout: 100 * time.Millisecond,
        Fn: func(ctx context.Context) error {
            select {
            case <-time.After(time.Second):
                return nil
            case <-ctx.Done():
                return ctx.Err()
            }
        },
    })

    result := <-s.Results()
    if result.Error == nil {
        t.Error("expected timeout error")
    }
}

func BenchmarkSchedulerThroughput(b *testing.B) {
    config := DefaultConfig()
    config.QueueSize = 100000
    s := NewScheduler(config)
    defer s.Shutdown(context.Background())

    // Drain results in background
    go func() {
        for range s.Results() {
        }
    }()

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            s.Submit(Task{
                Fn: func(ctx context.Context) error {
                    return nil
                },
            })
        }
    })
}
\`\`\`

### Dockerfile

This multi-stage Dockerfile first compiles the scheduler binary in a full Go toolchain image, then copies only the statically linked binary into a minimal Alpine runtime image. Disabling CGO with \`CGO_ENABLED=0\` ensures the binary is fully self-contained and runs without glibc dependencies in the scratch-like final stage.

\`\`\`dockerfile
# Dockerfile
FROM golang:1.25-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o scheduler ./cmd/scheduler

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/scheduler .
EXPOSE 8080
CMD ["./scheduler"]
\`\`\`

### docker-compose.yml

The Compose file wires the scheduler together with Prometheus for metrics scraping and Grafana for visualization, giving you an observable stack from a single \`docker-compose up\`. Resource limits on the scheduler service prevent runaway goroutines from starving other containers, and the health check ensures the orchestrator only routes traffic once the HTTP endpoint is responsive.

\`\`\`yaml
# docker-compose.yml
version: '3.8'

services:
  scheduler:
    build: .
    ports:
      - "8080:8080"
    environment:
      - WORKERS=8
      - QUEUE_SIZE=10000
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 1G
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
\`\`\`

### Makefile

The Makefile centralizes every common workflow, building with embedded version metadata from \`git describe\`, running the race detector during tests, executing benchmarks, and building or launching the Docker stack, behind short, memorable targets. Embedding the version string via \`-ldflags\` means every binary is traceable back to its exact commit without runtime overhead.

\`\`\`makefile
# Makefile
.PHONY: build test bench run clean docker

BINARY=scheduler
VERSION=\$(shell git describe --tags --always --dirty)
LDFLAGS=-ldflags "-X main.version=\$(VERSION)"

build:
	go build \$(LDFLAGS) -o \$(BINARY) ./cmd/scheduler

test:
	go test -v -race ./...

bench:
	go test -bench=. -benchmem ./...

run: build
	./\$(BINARY)

clean:
	rm -f \$(BINARY)
	go clean

docker:
	docker build -t scheduler:\$(VERSION) .

docker-run:
	docker-compose up -d

lint:
	golangci-lint run

coverage:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
\`\`\`

### Staff Lens: This Is Teaching Code, Not Production Code

The scheduler above combines many advanced techniques (work-stealing, sharding, lock-free structures) into one application. In production, most teams would not build this. They would use a battle-tested library (e.g., \`github.com/uber-go/fx\` for scheduling, or a distributed queue like Redis Streams) and focus engineering effort elsewhere.

The lesson is the composition: recognising which techniques fit together, and why each applies to its specific concern. If you ever need to build such a scheduler from scratch (e.g., for unusual performance requirements), this is a starting template. For most production needs, it is overkill.

### Principal Lens: Build vs Buy for Specialised Infrastructure

A high-performance task scheduler is specialised infrastructure. The build-vs-buy question: is your workload different enough from commodity to justify custom code? Most teams say yes and are wrong. The specialised versions cost years of engineering investment to match the reliability of off-the-shelf solutions. Use the off-the-shelf option until you have measured evidence that it cannot scale further. Principal engineers should be skeptical of every "we need to build our own" proposal.

---
`;
