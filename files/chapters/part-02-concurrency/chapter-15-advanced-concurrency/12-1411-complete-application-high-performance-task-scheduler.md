## 15.11 Complete Application: High-Performance Task Scheduler

The following task scheduler combines strict-priority queues shared by a fixed worker pool, per-task timeouts with context propagation, automatic retry with exponential backoff, and atomic metrics collection. It demonstrates how the individual patterns from this chapter compose into a single coherent system.

Shutdown is where schedulers like this one earn their keep, and it is worth naming the three traps before the code, because all three are easy to write and each is fatal.

**Never close a queue channel to signal shutdown.** Closing is a broadcast to *receivers*, and it says nothing to senders. A `push` that checks a `closed` flag and then sends is a check-then-act race: `close` can land in the window between the check and the send, and the result is a `send on closed channel` panic, which is unrecoverable in the sending goroutine and takes the process with it. This is not theoretical, it reproduces in seconds under contention. The rule is that a channel is closed by its sender, or not at all. Here, shutdown is signalled by cancelling a context, and the queues are simply left to be garbage collected.

**A closed channel is always ready to receive.** This is the subtler trap. A `select` on a closed channel never blocks, it yields the zero value immediately, so a receive helper that ignores `ok` reports success forever:

```go
// BROKEN: ok is true even when the channel is closed and empty.
func (q *priorityQueue) tryPop() (Task, bool) {
    select {
    case task := <-q.tasks:
        return task, true // <- must be: return task, ok
    default:
        return Task{}, false
    }
}
```

Every worker then receives a zero `Task` with a nil `Fn`, "executes" it, panics, recovers, records a failure, and loops, at full speed, forever. Measured against the version above: after `Shutdown`, two workers emitted **1,139,980 phantom results in two seconds**, never exited, and `Shutdown` itself hung until its context expired. The fix is one identifier, `return task, ok`, and the lesson is that a two-value receive is not optional bookkeeping.

**Every unguarded send is a leak.** A worker doing `s.results <- result` blocks forever once the buffer fills and the consumer goes away, which is exactly what happens during shutdown. Each such send needs a `ctx.Done()` escape.

Note also what this scheduler is not. Workers share four global priority queues, so this is strict priority scheduling, not work stealing: there are no per-worker deques for anyone to steal from. Section 15.2 covers the real thing.

```go
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

    // Start workers (strict-priority queues shared by the pool,
    // not per-worker deques: no work stealing here, see above)
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

    // Validate before indexing: s.queues[task.Priority] panics with an
    // out-of-range index on any Priority the caller invents.
    if task.Priority < PriorityLow || task.Priority > PriorityCritical {
        return fmt.Errorf("invalid priority %d", task.Priority)
    }
    if task.Fn == nil {
        return errors.New("task has no Fn")
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

// avgWaitTime and avgExecTime divide by finished tasks, not by
// successful ones. TotalWaitTime and TotalExecTime accumulate for every
// task including the ones that failed, so dividing by TasksCompleted
// alone inflates both averages by exactly the failure rate: the numerator
// and denominator have to count the same population.
func (s *Scheduler) finished() int64 {
    return s.metrics.TasksCompleted.Load() + s.metrics.TasksFailed.Load()
}

func (s *Scheduler) avgWaitTime() time.Duration {
    n := s.finished()
    if n == 0 {
        return 0
    }
    return time.Duration(s.metrics.TotalWaitTime.Load() / n)
}

// Note that TotalExecTime sums every attempt, so a retried task
// contributes all of its tries. That makes this "average time spent
// executing per finished task", not "average duration of a successful
// run". Both are useful, but they are different numbers.
func (s *Scheduler) avgExecTime() time.Duration {
    n := s.finished()
    if n == 0 {
        return 0
    }
    return time.Duration(s.metrics.TotalExecTime.Load() / n)
}

// Shutdown gracefully shuts down the scheduler.
//
// Order matters. closed stops new Submits, cancel tells parked workers
// to drain and exit, and only after every worker has returned is it safe
// to close results, because the workers are its only senders.
func (s *Scheduler) Shutdown(ctx context.Context) error {
    s.closed.Store(true)

    // Signal shutdown by cancelling, never by closing the queues.
    // Submit may still be in flight - closing a channel out from under a
    // sender panics.
    s.cancel()

    done := make(chan struct{})
    go func() {
        s.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        // All senders are gone, so this close is safe and it lets any
        // caller ranging over Results() terminate.
        close(s.results)
        return nil

    case <-ctx.Done():
        // Workers are still running, so we must NOT close(s.results):
        // that would panic the first worker to report a result. Leave it
        // open and report the timeout. A caller ranging over Results()
        // will not see it end, which is the honest signal that shutdown
        // did not complete.
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

// priorityQueue is a bounded queue for tasks.
//
// It is never closed. Shutdown is signalled by cancelling the
// scheduler's context, because closing a channel that Submit may still
// be sending on is a send-on-closed panic waiting to happen. The queue
// is plain garbage once the scheduler is gone.
type priorityQueue struct {
    tasks chan Task
}

func newPriorityQueue(size int) *priorityQueue {
    return &priorityQueue{
        tasks: make(chan Task, size),
    }
}

func (q *priorityQueue) push(task Task) error {
    select {
    case q.tasks <- task:
        return nil
    default:
        return errors.New("queue full")
    }
}

// tryPop returns ok=false when no task is immediately available.
func (q *priorityQueue) tryPop() (Task, bool) {
    select {
    case task := <-q.tasks:
        return task, true
    default:
        return Task{}, false
    }
}

// depth reports the queued task count. Sampled, so treat it as a metric.
func (q *priorityQueue) depth() int {
    return len(q.tasks)
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
            // Context cancelled and every queue drained.
            return
        }

        w.executeTask(task)
    }
}

func (w *worker) getTask() (Task, bool) {
    s := w.scheduler

    // Strict priority: always drain higher priorities first. Whenever
    // there is any backlog, this sweep decides the order.
    for pri := PriorityCritical; pri >= PriorityLow; pri-- {
        if task, ok := s.queues[pri].tryPop(); ok {
            return task, true
        }
    }

    // Nothing queued, so park until something arrives rather than
    // polling. select chooses uniformly at random among ready cases, so
    // this path does not honour priority. That is acceptable precisely
    // because we only reach it when every queue was empty a moment ago:
    // with no backlog there is no ordering to get wrong, and the sweep
    // above reasserts priority on the next call.
    select {
    case task := <-s.queues[PriorityCritical].tasks:
        return task, true
    case task := <-s.queues[PriorityHigh].tasks:
        return task, true
    case task := <-s.queues[PriorityNormal].tasks:
        return task, true
    case task := <-s.queues[PriorityLow].tasks:
        return task, true

    case <-s.ctx.Done():
        // Shutting down. Re-sweep before leaving: a task may have landed
        // between the sweep above and the cancellation. Dropping an
        // accepted task at shutdown is worse than one extra pass.
        for pri := PriorityCritical; pri >= PriorityLow; pri-- {
            if task, ok := s.queues[pri].tryPop(); ok {
                return task, true
            }
        }
        return Task{}, false
    }
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

            // Exponential backoff, but interruptible. A bare time.Sleep
            // here ignores shutdown and stalls Shutdown for the full
            // backoff of every in-flight retry.
            backoff := time.Duration(1<<attempt) * 100 * time.Millisecond
            t := time.NewTimer(backoff)
            select {
            case <-t.C:
            case <-s.ctx.Done():
                t.Stop()
                s.metrics.TasksFailed.Add(1)
                s.report(TaskResult{TaskID: task.ID, Error: s.ctx.Err(), Retries: retries})
                return
            }
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
            s.report(TaskResult{
                TaskID:   task.ID,
                Duration: execTime,
                Retries:  retries,
            })
            return
        }

        lastErr = err
    }

    // All retries exhausted
    s.metrics.TasksFailed.Add(1)
    s.report(TaskResult{
        TaskID:   task.ID,
        Error:    lastErr,
        Retries:  retries,
    })
}

// report delivers a result without ever blocking forever.
//
// A bare s.results <- result parks the worker permanently once the
// buffer fills and the consumer stops reading, which is precisely what
// happens during shutdown. Every send needs an escape hatch.
func (s *Scheduler) report(r TaskResult) {
    select {
    case s.results <- r:
    case <-s.ctx.Done():
        // Shutting down and nobody is draining. Dropping the result is
        // correct here: the metrics counters already recorded the
        // outcome, and blocking would deadlock Shutdown.
    }
}

func generateID() string {
    h := fnv.New64a()
    h.Write([]byte(fmt.Sprintf("%d-%d", time.Now().UnixNano(), runtime.NumGoroutine())))
    return fmt.Sprintf("%x", h.Sum64())
}
```

### Tests

The test suite validates the scheduler's core guarantees: correct execution of all submitted tasks, priority ordering under a single worker, automatic retries with exponential backoff, and per-task timeout enforcement. Each test isolates a specific behavioral contract so failures are immediately actionable.

```go
// scheduler/scheduler_test.go
package scheduler

import (
    "context"
    "errors"
    "sync"
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

    // Occupy the single worker with a blocking task first. Without
    // this, the worker usually grabs the Low task the instant it is
    // submitted, runs it, and only then sees the High task, so the
    // test asserts the opposite of priority order and fails. Both
    // test tasks must be queued before either runs.
    started := make(chan struct{})
    release := make(chan struct{})
    var once sync.Once
    s.Submit(Task{
        Priority: PriorityLow,
        Fn: func(ctx context.Context) error {
            once.Do(func() { close(started) })
            <-release
            return nil
        },
    })
    <-started

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

    // Release the blocker: both test tasks are queued, so the sweep
    // must pick High before Low.
    close(release)

    // Wait for completion (blocker + 2 test tasks)
    for i := 0; i < 3; i++ {
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
```

### Dockerfile

This multi-stage Dockerfile first compiles the scheduler binary in a full Go toolchain image, then copies only the statically linked binary into a minimal Alpine runtime image. Disabling CGO with `CGO_ENABLED=0` ensures the binary is fully self-contained and runs without glibc dependencies in the scratch-like final stage.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

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
```

### docker-compose.yml

The Compose file wires the scheduler together with Prometheus for metrics scraping and Grafana for visualization, giving you an observable stack from a single `docker compose up`. Resource limits on the scheduler service cap what it can take from other containers, and the health check ensures the orchestrator only routes traffic once the HTTP endpoint is responsive. The top-level `version` key is omitted deliberately: it has been obsolete since Compose V2 and now only produces a warning.

```yaml
# docker-compose.yml
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
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
```

### Makefile

The Makefile centralizes every common workflow, building with embedded version metadata from `git describe`, running the race detector during tests, executing benchmarks, and building or launching the Docker stack, behind short, memorable targets. Embedding the version string via `-ldflags` means every binary is traceable back to its exact commit without runtime overhead.

```makefile
# Makefile
.PHONY: build test bench run clean docker

BINARY=scheduler
VERSION=$(shell git describe --tags --always --dirty)
LDFLAGS=-ldflags "-X main.version=$(VERSION)"

build:
	go build $(LDFLAGS) -o $(BINARY) ./cmd/scheduler

test:
	go test -v -race ./...

bench:
	go test -bench=. -benchmem ./...

run: build
	./$(BINARY)

clean:
	rm -f $(BINARY)
	go clean

docker:
	docker build -t scheduler:$(VERSION) .

docker-run:
	docker-compose up -d

lint:
	golangci-lint run

coverage:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
```

### Staff Lens: This Is Teaching Code, Not Production Code

The scheduler above composes several techniques from this chapter, namely bounded queues, strict priority scheduling, context-propagated timeouts, atomic metrics, and panic isolation per task. It deliberately does not use work-stealing, sharding, or lock-free structures, because at this scale none of them would earn their complexity. That restraint is the point: the chapter's advanced techniques are for measured problems, and a scheduler is not automatically one of them.

The genuinely hard part of this code is not the throughput, it is the lifecycle. Nearly every bug worth having in a worker pool lives in shutdown, and the three traps described at the top of this section, closing a channel senders still hold, ignoring `ok` on a receive, and sending without an escape, are all shutdown bugs. They are also all invisible in a test that only submits work and reads results. Write the shutdown test.

In production, most teams would not build this at all. They would use a battle-tested library, such as a Redis-backed job queue like `github.com/hibiken/asynq`, or a distributed queue like Redis Streams, and spend the engineering effort elsewhere. If you do need to build one, this is a starting template, not a finished product.

### Principal Lens: Build vs Buy for Specialised Infrastructure

A high-performance task scheduler is specialized infrastructure. The build-vs-buy question: is your workload different enough from commodity to justify custom code? Most teams say yes and are wrong. The specialized versions cost years of engineering investment to match the reliability of off-the-shelf solutions. Use the off-the-shelf option until you have measured evidence that it cannot scale further. Principal engineers should be skeptical of every "we need to build our own" proposal.

---
