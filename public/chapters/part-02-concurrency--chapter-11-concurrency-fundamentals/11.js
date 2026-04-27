export default `## 11.10 Complete Application: Concurrent Task Processor

This section puts every concept from the chapter into a single working application: a concurrent task processor with a worker pool, retry logic, metrics collection, graceful shutdown, and Docker packaging.

### Project Structure

The task processor is organized as a Go module with a clean separation between the task domain model, the worker pool, and the metrics collector. This layout keeps each package focused on a single concern, making it easy to test and replace individual components without touching the rest of the system.

\`\`\`
taskprocessor/
├── cmd/
│   └── processor/
│       └── main.go
├── internal/
│   ├── pool/
│   │   ├── pool.go
│   │   └── pool_test.go
│   ├── task/
│   │   └── task.go
│   └── metrics/
│       └── metrics.go
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── go.mod
└── README.md
\`\`\`

### task/task.go

The \`task\` package defines the core domain types: a \`Task\` with a SHA-256-derived unique ID, priority level, payload, and per-task deadline, plus a \`Result\` that carries the outcome back to the caller. The \`Processor\` interface keeps the pool decoupled from any specific processing logic, allowing the \`DefaultProcessor\`, which simulates variable latency and a 10% random failure rate, to be swapped out in tests or production without changing the pool itself.

\`\`\`go
// Package task defines the task types and processing logic.
package task

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "math/rand/v2"
    "time"
)

// Priority defines task priority levels.
type Priority int

const (
    PriorityLow    Priority = 0
    PriorityNormal Priority = 1
    PriorityHigh   Priority = 2
)

// Task represents a unit of work.
type Task struct {
    ID        string
    Priority  Priority
    Payload   []byte
    CreatedAt time.Time
    Timeout   time.Duration
}

// NewTask creates a new task with a unique ID.
func NewTask(payload []byte, priority Priority, timeout time.Duration) *Task {
    id := generateID(payload)
    return &Task{
        ID:        id,
        Priority:  priority,
        Payload:   payload,
        CreatedAt: time.Now(),
        Timeout:   timeout,
    }
}

func generateID(payload []byte) string {
    hash := sha256.Sum256(append(payload, []byte(time.Now().String())...))
    return hex.EncodeToString(hash[:8])
}

// Result represents the outcome of processing a task.
type Result struct {
    TaskID     string
    Success    bool
    Output     []byte
    Error      error
    Duration   time.Duration
    WorkerID   int
    RetryCount int
}

// Processor defines the interface for task processing.
type Processor interface {
    Process(ctx context.Context, task *Task) (*Result, error)
}

// DefaultProcessor is a sample processor implementation.
type DefaultProcessor struct{}

// Process performs the actual task processing.
func (p *DefaultProcessor) Process(ctx context.Context, task *Task) (*Result, error) {
    start := time.Now()

    // Simulate variable processing time (50-200ms)
    processingTime := time.Duration(50+rand.IntN(150)) * time.Millisecond

    select {
    case <-ctx.Done():
        return &Result{
            TaskID:  task.ID,
            Success: false,
            Error:   ctx.Err(),
        }, ctx.Err()
    case <-time.After(processingTime):
    }

    // Simulate occasional failures (10% chance)
    if rand.Float32() < 0.1 {
        return &Result{
            TaskID:   task.ID,
            Success:  false,
            Error:    fmt.Errorf("simulated processing error"),
            Duration: time.Since(start),
        }, nil
    }

    // Process the payload
    output := sha256.Sum256(task.Payload)

    return &Result{
        TaskID:   task.ID,
        Success:  true,
        Output:   output[:],
        Duration: time.Since(start),
    }, nil
}
\`\`\`

### pool/pool.go

The \`Pool\` manages a fixed number of goroutine workers that pull tasks from a buffered channel, process them through the injected \`Processor\`, and forward results to a second buffered channel. Workers use \`processWithRetry\` to transparently retry failing tasks up to \`MaxRetries\` times with a configurable delay, and \`atomic.Int64\` counters track submitted, processed, and failed counts lock-free for low-overhead instrumentation.

\`\`\`go
// Package pool provides a concurrent worker pool for task processing.
package pool

import (
    "context"
    "fmt"
    "log"
    "sync"
    "sync/atomic"
    "time"

    "taskprocessor/internal/task"
)

// Config holds worker pool configuration.
type Config struct {
    NumWorkers    int
    QueueSize     int
    MaxRetries    int
    RetryDelay    time.Duration
    ShutdownWait  time.Duration
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
    return Config{
        NumWorkers:   4,
        QueueSize:    100,
        MaxRetries:   3,
        RetryDelay:   time.Second,
        ShutdownWait: 30 * time.Second,
    }
}

// Pool manages a pool of workers processing tasks.
type Pool struct {
    config    Config
    processor task.Processor

    // Channels
    tasks    chan *task.Task
    results  chan *task.Result

    // State
    ctx       context.Context
    cancel    context.CancelFunc
    wg        sync.WaitGroup
    mu        sync.RWMutex
    running   bool

    // Metrics
    tasksSubmitted   atomic.Int64
    tasksProcessed   atomic.Int64
    tasksFailed      atomic.Int64
    totalDuration    atomic.Int64
}

// New creates a new worker pool.
func New(config Config, processor task.Processor) *Pool {
    ctx, cancel := context.WithCancel(context.Background())

    return &Pool{
        config:    config,
        processor: processor,
        tasks:     make(chan *task.Task, config.QueueSize),
        results:   make(chan *task.Result, config.QueueSize),
        ctx:       ctx,
        cancel:    cancel,
    }
}

// Start initializes and starts all workers.
func (p *Pool) Start() error {
    p.mu.Lock()
    defer p.mu.Unlock()

    if p.running {
        return fmt.Errorf("pool already running")
    }

    p.running = true

    // Start workers
    for i := 0; i < p.config.NumWorkers; i++ {
        p.wg.Add(1)
        go p.worker(i)
    }

    log.Printf("Started %d workers", p.config.NumWorkers)
    return nil
}

// worker is the main worker loop.
func (p *Pool) worker(id int) {
    defer p.wg.Done()

    log.Printf("Worker %d started", id)
    defer log.Printf("Worker %d stopped", id)

    for {
        select {
        case <-p.ctx.Done():
            return
        case t, ok := <-p.tasks:
            if !ok {
                return  // Channel closed
            }

            result := p.processWithRetry(id, t)

            // Send result
            select {
            case <-p.ctx.Done():
                return
            case p.results <- result:
            }
        }
    }
}

// processWithRetry processes a task with retries.
func (p *Pool) processWithRetry(workerID int, t *task.Task) *task.Result {
    var result *task.Result
    var lastErr error

    for retry := 0; retry <= p.config.MaxRetries; retry++ {
        if retry > 0 {
            select {
            case <-p.ctx.Done():
                return &task.Result{
                    TaskID:     t.ID,
                    Success:    false,
                    Error:      p.ctx.Err(),
                    WorkerID:   workerID,
                    RetryCount: retry,
                }
            case <-time.After(p.config.RetryDelay):
            }
        }

        // Create context with task timeout
        ctx, cancel := context.WithTimeout(p.ctx, t.Timeout)

        result, lastErr = p.processor.Process(ctx, t)
        cancel()

        if lastErr == nil && result.Success {
            result.WorkerID = workerID
            result.RetryCount = retry
            p.tasksProcessed.Add(1)
            p.totalDuration.Add(int64(result.Duration))
            return result
        }

        log.Printf("Worker %d: task %s failed (attempt %d/%d): %v",
            workerID, t.ID, retry+1, p.config.MaxRetries+1, lastErr)
    }

    // All retries exhausted
    p.tasksFailed.Add(1)

    if result == nil {
        result = &task.Result{TaskID: t.ID}
    }

    result.Success = false
    result.Error = fmt.Errorf("max retries exceeded: %w", lastErr)
    result.WorkerID = workerID
    result.RetryCount = p.config.MaxRetries

    return result
}

// Submit adds a task to the queue.
func (p *Pool) Submit(ctx context.Context, t *task.Task) error {
    p.mu.RLock()
    if !p.running {
        p.mu.RUnlock()
        return fmt.Errorf("pool not running")
    }
    p.mu.RUnlock()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-p.ctx.Done():
        return fmt.Errorf("pool shutting down")
    case p.tasks <- t:
        p.tasksSubmitted.Add(1)
        return nil
    }
}

// Results returns the results channel.
func (p *Pool) Results() <-chan *task.Result {
    return p.results
}

// Shutdown gracefully shuts down the pool.
func (p *Pool) Shutdown() error {
    p.mu.Lock()
    if !p.running {
        p.mu.Unlock()
        return nil
    }
    p.running = false
    p.mu.Unlock()

    log.Println("Shutting down worker pool...")

    // Stop accepting new tasks
    close(p.tasks)

    // Wait for workers with timeout
    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        log.Println("All workers stopped gracefully")
    case <-time.After(p.config.ShutdownWait):
        log.Println("Shutdown timeout, cancelling remaining work")
        p.cancel()
        <-done
    }

    close(p.results)
    return nil
}

// Stats returns current pool statistics.
type Stats struct {
    TasksSubmitted  int64
    TasksProcessed  int64
    TasksFailed     int64
    AverageDuration time.Duration
    QueueLength     int
}

// Stats returns current pool statistics.
func (p *Pool) Stats() Stats {
    processed := p.tasksProcessed.Load()
    var avgDuration time.Duration
    if processed > 0 {
        avgDuration = time.Duration(p.totalDuration.Load() / processed)
    }

    return Stats{
        TasksSubmitted:  p.tasksSubmitted.Load(),
        TasksProcessed:  processed,
        TasksFailed:     p.tasksFailed.Load(),
        AverageDuration: avgDuration,
        QueueLength:     len(p.tasks),
    }
}
\`\`\`

### pool/pool_test.go

The test file validates the pool through four complementary angles: basic end-to-end processing, context cancellation, concurrent submission from multiple goroutines, and goroutine-leak detection via \`runtime.NumGoroutine\` comparisons before and after repeated pool lifecycles. The benchmark uses \`b.Loop()\`, the modern, allocator-aware form of the benchmark loop, to measure raw submission throughput against a near-instant mock processor.

\`\`\`go
package pool

import (
    "context"
    "sync"
    "sync/atomic"
    "testing"
    "time"

    "taskprocessor/internal/task"
)

// mockProcessor is a test processor.
type mockProcessor struct {
    processTime time.Duration
    failRate    float32
    calls       atomic.Int32
}

func (m *mockProcessor) Process(ctx context.Context, t *task.Task) (*task.Result, error) {
    m.calls.Add(1)

    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    case <-time.After(m.processTime):
    }

    return &task.Result{
        TaskID:  t.ID,
        Success: true,
        Output:  []byte("processed"),
    }, nil
}

func TestPoolBasic(t *testing.T) {
    processor := &mockProcessor{processTime: 10 * time.Millisecond}
    config := Config{
        NumWorkers:   2,
        QueueSize:    10,
        MaxRetries:   0,
        ShutdownWait: 5 * time.Second,
    }

    p := New(config, processor)
    if err := p.Start(); err != nil {
        t.Fatalf("failed to start pool: %v", err)
    }

    // Submit tasks
    numTasks := 10
    for i := 0; i < numTasks; i++ {
        tsk := task.NewTask([]byte("test"), task.PriorityNormal, time.Second)
        if err := p.Submit(context.Background(), tsk); err != nil {
            t.Fatalf("failed to submit task: %v", err)
        }
    }

    // Collect results
    var results []*task.Result
    timeout := time.After(5 * time.Second)

    for len(results) < numTasks {
        select {
        case r := <-p.Results():
            results = append(results, r)
        case <-timeout:
            t.Fatalf("timeout waiting for results, got %d/%d", len(results), numTasks)
        }
    }

    // Verify
    for _, r := range results {
        if !r.Success {
            t.Errorf("task %s failed: %v", r.TaskID, r.Error)
        }
    }

    // Shutdown
    if err := p.Shutdown(); err != nil {
        t.Fatalf("failed to shutdown: %v", err)
    }

    stats := p.Stats()
    if stats.TasksProcessed != int64(numTasks) {
        t.Errorf("expected %d processed, got %d", numTasks, stats.TasksProcessed)
    }
}

func TestPoolCancellation(t *testing.T) {
    processor := &mockProcessor{processTime: time.Second}
    config := Config{
        NumWorkers:   2,
        QueueSize:    10,
        MaxRetries:   0,
        ShutdownWait: time.Second,
    }

    p := New(config, processor)
    if err := p.Start(); err != nil {
        t.Fatalf("failed to start pool: %v", err)
    }

    // Submit task with short timeout
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
    defer cancel()

    tsk := task.NewTask([]byte("test"), task.PriorityNormal, 50*time.Millisecond)
    if err := p.Submit(ctx, tsk); err != nil && err != context.DeadlineExceeded {
        t.Fatalf("unexpected error: %v", err)
    }

    if err := p.Shutdown(); err != nil {
        t.Fatalf("failed to shutdown: %v", err)
    }
}

func TestPoolConcurrency(t *testing.T) {
    processor := &mockProcessor{processTime: 10 * time.Millisecond}
    config := Config{
        NumWorkers:   4,
        QueueSize:    100,
        MaxRetries:   0,
        ShutdownWait: 10 * time.Second,
    }

    p := New(config, processor)
    if err := p.Start(); err != nil {
        t.Fatalf("failed to start pool: %v", err)
    }

    // Submit from multiple goroutines
    numGoroutines := 10
    tasksPerGoroutine := 10
    totalTasks := numGoroutines * tasksPerGoroutine

    var wg sync.WaitGroup
    for i := 0; i < numGoroutines; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := 0; j < tasksPerGoroutine; j++ {
                tsk := task.NewTask([]byte("test"), task.PriorityNormal, time.Second)
                _ = p.Submit(context.Background(), tsk)
            }
        }()
    }
    wg.Wait()

    // Wait for processing
    time.Sleep(500 * time.Millisecond)

    if err := p.Shutdown(); err != nil {
        t.Fatalf("failed to shutdown: %v", err)
    }

    stats := p.Stats()
    if stats.TasksSubmitted != int64(totalTasks) {
        t.Errorf("expected %d submitted, got %d", totalTasks, stats.TasksSubmitted)
    }
}

func TestNoGoroutineLeaks(t *testing.T) {
    // This test must be run with go test -race
    before := runtime.NumGoroutine()

    for i := 0; i < 5; i++ {
        processor := &mockProcessor{processTime: 5 * time.Millisecond}
        config := DefaultConfig()
        config.NumWorkers = 2
        config.ShutdownWait = time.Second

        p := New(config, processor)
        _ = p.Start()

        tsk := task.NewTask([]byte("test"), task.PriorityNormal, time.Second)
        _ = p.Submit(context.Background(), tsk)

        time.Sleep(50 * time.Millisecond)
        _ = p.Shutdown()
    }

    time.Sleep(100 * time.Millisecond)
    runtime.GC()

    after := runtime.NumGoroutine()
    if after > before+2 {  // Allow small variance
        t.Errorf("goroutine leak detected: before=%d, after=%d", before, after)
    }
}

func BenchmarkPool(b *testing.B) {
    processor := &mockProcessor{processTime: time.Microsecond}
    config := Config{
        NumWorkers:   runtime.NumCPU(),
        QueueSize:    1000,
        MaxRetries:   0,
        ShutdownWait: 10 * time.Second,
    }

    p := New(config, processor)
    _ = p.Start()
    defer p.Shutdown()

    // Drain results in background
    go func() {
        for range p.Results() {
        }
    }()

    b.ResetTimer()

    for b.Loop() {
        tsk := task.NewTask([]byte("bench"), task.PriorityNormal, time.Second)
        _ = p.Submit(context.Background(), tsk)
    }
}
\`\`\`

### metrics/metrics.go

The \`Collector\` provides a lightweight, in-process metrics store with counters, gauges, and histograms, each protected by its own mutex for safe concurrent access. Histograms pre-allocate Prometheus-compatible buckets from 1 ms to 10 s, making the output compatible with standard dashboards without pulling in the full Prometheus client library for this standalone example.

\`\`\`go
// Package metrics provides metrics collection for the task processor.
package metrics

import (
    "fmt"
    "sync"
    "time"
)

// Collector collects and reports metrics.
type Collector struct {
    mu         sync.RWMutex
    counters   map[string]int64
    gauges     map[string]float64
    histograms map[string]*Histogram
}

// Histogram tracks value distributions.
type Histogram struct {
    mu      sync.Mutex
    count   int64
    sum     float64
    buckets map[float64]int64
}

// NewCollector creates a new metrics collector.
func NewCollector() *Collector {
    return &Collector{
        counters:   make(map[string]int64),
        gauges:     make(map[string]float64),
        histograms: make(map[string]*Histogram),
    }
}

// IncrCounter increments a counter.
func (c *Collector) IncrCounter(name string, delta int64) {
    c.mu.Lock()
    c.counters[name] += delta
    c.mu.Unlock()
}

// SetGauge sets a gauge value.
func (c *Collector) SetGauge(name string, value float64) {
    c.mu.Lock()
    c.gauges[name] = value
    c.mu.Unlock()
}

// ObserveHistogram records a value in a histogram.
func (c *Collector) ObserveHistogram(name string, value float64) {
    c.mu.Lock()
    h, exists := c.histograms[name]
    if !exists {
        h = &Histogram{
            buckets: map[float64]int64{
                0.001: 0, 0.005: 0, 0.01: 0, 0.025: 0, 0.05: 0,
                0.1: 0, 0.25: 0, 0.5: 0, 1: 0, 2.5: 0, 5: 0, 10: 0,
            },
        }
        c.histograms[name] = h
    }
    c.mu.Unlock()

    h.mu.Lock()
    h.count++
    h.sum += value
    for bucket := range h.buckets {
        if value <= bucket {
            h.buckets[bucket]++
        }
    }
    h.mu.Unlock()
}

// Report returns a formatted metrics report.
func (c *Collector) Report() string {
    c.mu.RLock()
    defer c.mu.RUnlock()

    var report string

    report += "=== Counters ===\\n"
    for name, value := range c.counters {
        report += fmt.Sprintf("%s: %d\\n", name, value)
    }

    report += "\\n=== Gauges ===\\n"
    for name, value := range c.gauges {
        report += fmt.Sprintf("%s: %.2f\\n", name, value)
    }

    report += "\\n=== Histograms ===\\n"
    for name, h := range c.histograms {
        h.mu.Lock()
        avg := h.sum / float64(h.count)
        report += fmt.Sprintf("%s: count=%d, avg=%.4f\\n", name, h.count, avg)
        h.mu.Unlock()
    }

    return report
}

// TimerFunc times a function execution.
func (c *Collector) TimerFunc(name string, fn func()) {
    start := time.Now()
    fn()
    duration := time.Since(start).Seconds()
    c.ObserveHistogram(name, duration)
}
\`\`\`

### cmd/processor/main.go

The entry point wires all components together: it parses CLI flags for worker count, queue size, task count, and ingestion rate, then drives a ticker-based generator that submits tasks at the requested rate and uses a labeled \`break\` to exit the generation loop cleanly on signal or deadline. A separate goroutine drains the results channel and feeds the metrics collector, while periodic stats logging and a polled completion check allow the program to wait for all submitted work before gracefully shutting down the pool.

\`\`\`go
package main

import (
    "context"
    "flag"
    "fmt"
    "log"
    "math/rand/v2"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "taskprocessor/internal/metrics"
    "taskprocessor/internal/pool"
    "taskprocessor/internal/task"
)

func main() {
    // Parse flags
    workers := flag.Int("workers", 4, "number of worker goroutines")
    queueSize := flag.Int("queue", 100, "task queue size")
    tasks := flag.Int("tasks", 1000, "number of tasks to generate")
    rate := flag.Int("rate", 100, "tasks per second")
    flag.Parse()

    log.Printf("Starting task processor with %d workers", *workers)

    // Initialize components
    processor := &task.DefaultProcessor{}
    collector := metrics.NewCollector()

    config := pool.Config{
        NumWorkers:   *workers,
        QueueSize:    *queueSize,
        MaxRetries:   3,
        RetryDelay:   100 * time.Millisecond,
        ShutdownWait: 30 * time.Second,
    }

    p := pool.New(config, processor)

    // Setup signal handling
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        sig := <-sigCh
        log.Printf("Received signal: %v", sig)
        cancel()
    }()

    // Start pool
    if err := p.Start(); err != nil {
        log.Fatalf("Failed to start pool: %v", err)
    }

    // Result collector
    var wg sync.WaitGroup
    wg.Add(1)
    go func() {
        defer wg.Done()
        for result := range p.Results() {
            if result.Success {
                collector.IncrCounter("tasks.success", 1)
            } else {
                collector.IncrCounter("tasks.failed", 1)
            }
            collector.ObserveHistogram("task.duration", result.Duration.Seconds())
        }
    }()

    // Task generator
    log.Printf("Generating %d tasks at %d/sec", *tasks, *rate)
    ticker := time.NewTicker(time.Second / time.Duration(*rate))
    defer ticker.Stop()

    generated := 0
    priorities := []task.Priority{task.PriorityLow, task.PriorityNormal, task.PriorityHigh}

GenerateLoop:
    for generated < *tasks {
        select {
        case <-ctx.Done():
            break GenerateLoop
        case <-ticker.C:
            priority := priorities[rand.IntN(len(priorities))]
            payload := []byte(fmt.Sprintf("task-%d-%d", generated, time.Now().UnixNano()))
            t := task.NewTask(payload, priority, 5*time.Second)

            submitCtx, submitCancel := context.WithTimeout(ctx, time.Second)
            if err := p.Submit(submitCtx, t); err != nil {
                log.Printf("Failed to submit task: %v", err)
                collector.IncrCounter("tasks.submit_failed", 1)
            } else {
                generated++
                collector.IncrCounter("tasks.submitted", 1)
            }
            submitCancel()
        }
    }

    log.Printf("Generated %d tasks, waiting for completion...", generated)

    // Periodic stats
    statsTicker := time.NewTicker(time.Second)
    defer statsTicker.Stop()

    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            case <-statsTicker.C:
                stats := p.Stats()
                collector.SetGauge("pool.queue_length", float64(stats.QueueLength))
                log.Printf("Stats: submitted=%d, processed=%d, failed=%d, queue=%d, avg_duration=%v",
                    stats.TasksSubmitted, stats.TasksProcessed, stats.TasksFailed,
                    stats.QueueLength, stats.AverageDuration)
            }
        }
    }()

    // Wait for processing to complete (with timeout)
    deadline := time.After(2 * time.Minute)
    checkTicker := time.NewTicker(100 * time.Millisecond)
    defer checkTicker.Stop()

WaitLoop:
    for {
        select {
        case <-ctx.Done():
            break WaitLoop
        case <-deadline:
            log.Println("Deadline reached, shutting down")
            break WaitLoop
        case <-checkTicker.C:
            stats := p.Stats()
            if stats.TasksProcessed+stats.TasksFailed >= stats.TasksSubmitted {
                log.Println("All tasks processed")
                break WaitLoop
            }
        }
    }

    // Shutdown
    if err := p.Shutdown(); err != nil {
        log.Printf("Shutdown error: %v", err)
    }

    wg.Wait()

    // Final report
    fmt.Println("\\n" + collector.Report())

    finalStats := p.Stats()
    fmt.Printf("\\nFinal Statistics:\\n")
    fmt.Printf("  Tasks Submitted:  %d\\n", finalStats.TasksSubmitted)
    fmt.Printf("  Tasks Processed:  %d\\n", finalStats.TasksProcessed)
    fmt.Printf("  Tasks Failed:     %d\\n", finalStats.TasksFailed)
    fmt.Printf("  Average Duration: %v\\n", finalStats.AverageDuration)
    fmt.Printf("  Success Rate:     %.2f%%\\n",
        float64(finalStats.TasksProcessed)/float64(finalStats.TasksSubmitted)*100)
}
\`\`\`

### Makefile

The Makefile captures every common developer action, build, test with the race detector, benchmark, clean, and Docker image creation, as short, mnemonic targets. The \`race\` and \`profile\` targets make it easy to run the application with Go's built-in data-race detector or to capture a CPU profile with \`pprof\` without memorizing lengthy flag strings.

\`\`\`makefile
.PHONY: all build test bench clean run docker

BINARY=taskprocessor
DOCKER_IMAGE=taskprocessor:latest

all: test build

build:
	go build -o bin/\$(BINARY) ./cmd/processor

test:
	go test -v -race ./...

bench:
	go test -bench=. -benchmem ./internal/pool

clean:
	rm -rf bin/
	go clean

run: build
	./bin/\$(BINARY) -workers=4 -tasks=1000 -rate=100

docker:
	docker build -t \$(DOCKER_IMAGE) .

docker-run: docker
	docker run --rm \$(DOCKER_IMAGE) -workers=4 -tasks=500 -rate=50

lint:
	golangci-lint run

cover:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

# Run with race detector
race:
	go run -race ./cmd/processor -workers=4 -tasks=100

# Run with profiling
profile:
	go run ./cmd/processor -workers=4 -tasks=10000 -rate=1000 &
	sleep 5
	go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=10
\`\`\`

### Dockerfile

The Dockerfile uses a two-stage build: the builder stage compiles the binary with \`-ldflags="-w -s"\` to strip debug symbols and reduce binary size, while the minimal \`alpine\` runtime stage contains only the binary, CA certificates, and a dedicated non-root user for improved security posture. This pattern produces a final image typically under 10 MB with no Go toolchain overhead at runtime.

\`\`\`dockerfile
# Build stage
FROM golang:1.26-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build with optimizations
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /taskprocessor ./cmd/processor

# Runtime stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

# Copy binary from builder
COPY --from=builder /taskprocessor .

# Create non-root user
RUN adduser -D -g '' appuser
USER appuser

ENTRYPOINT ["./taskprocessor"]
CMD ["-workers=4", "-tasks=100", "-rate=50"]
\`\`\`

### docker-compose.yml

The Compose file defines a base \`processor\` service with CPU and memory hard limits, and a \`processor-scaled\` service with three replicas to simulate a real multi-instance deployment during load testing. Setting \`GOMAXPROCS\` explicitly via an environment variable ensures the Go scheduler matches the CPU quota rather than over-provisioning threads for the available cores.

\`\`\`yaml
version: '3.8'

services:
  processor:
    build: .
    command: ["-workers=4", "-tasks=1000", "-rate=100"]
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 256M
    environment:
      - GOMAXPROCS=2

  # Multiple processor instances for load testing
  processor-scaled:
    build: .
    command: ["-workers=8", "-tasks=5000", "-rate=500"]
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '4'
          memory: 512M
\`\`\`

### go.mod

The module file declares the single external dependency, \`golang.org/x/sync\`, for any future use of \`errgroup\` or \`singleflight\` patterns, keeping the dependency graph minimal. Pinning a specific version here ensures reproducible builds across all contributors and CI environments.

\`\`\`
module taskprocessor

go 1.22

require golang.org/x/sync v0.6.0
\`\`\`

### Production Hardening Checklist

This is a teaching example. Before running it in production, a staff engineer would demand:

1. **Observability.** Replace ad-hoc metrics with Prometheus-exposed counters, histograms, and gauges. Wire OpenTelemetry traces so every task has a span from submission to completion. Emit structured logs with a request correlation ID.
2. **Bounded backpressure.** The task queue is bounded. What happens when it fills? Current code probably blocks. Decide: reject the submission (return 429), spill to disk (durable queue), or block (apply backpressure upstream). Every queue needs an overflow policy.
3. **Durable queueing.** If tasks matter, they must survive process restart. Either persist to disk (embedded database) or delegate to an external queue (Redis, RabbitMQ, SQS). In-memory queues lose tasks on every deploy.
4. **Poison task handling.** A task that fails every retry should not loop forever. After \`MaxRetries\`, route it to a dead-letter queue for operator inspection.
5. **Graceful drain on shutdown.** On SIGTERM, stop accepting new tasks immediately, finish in-flight work with a bounded deadline, persist the remaining queue, and exit cleanly. Kubernetes pod deletion gives you ~30 seconds for this.
6. **Circuit breaker on downstream failures.** If the task processor calls a downstream service, wrap the call in a circuit breaker. Without this, a downstream outage causes all workers to block on slow calls, exhausting the pool.
7. **Rate limiting.** Token bucket per client or per task type. Without this, one misbehaving client DOSes the entire processor.
8. **Health checks.** \`/healthz\` (liveness, always returns 200 if the process is up) and \`/readyz\` (readiness, returns 503 if the worker pool is unhealthy or the queue is full). Kubernetes uses these for scheduling decisions.

### Staff Lens: What This Example Teaches

The real lesson of this complete application is not the code. It is the architecture: worker pool with bounded concurrency, context propagation through every goroutine, graceful shutdown driven by signal handling, metrics at every instrumentation point, clean separation between task definition, pool mechanics, and metrics collection. These are the shapes that scale. A new engineer reading this code should come away with the architecture internalised, then customise the specifics (task type, worker count, retry policy) to their domain. The code is disposable. The architecture is the lesson.

### Principal Lens: Where This Architecture Breaks

At some scale, this in-process worker pool architecture stops being the right answer. The signals:

- The service consumes most of one machine's CPU and you need to scale horizontally. The in-process pool does not help. You need a distributed queue (Kafka, SQS, Redis) and stateless workers.
- Tasks take longer than the acceptable deploy-cycle time. In-process goroutines do not survive redeploys. You need durable tasks and at-least-once semantics.
- Task submission rate exceeds what a single process can accept. You need horizontal scaling of the submission path, not just the processing path.
- Different task types have different SLOs. One pool cannot optimize for all of them. You need multiple pools or a priority-aware scheduler.

Each of these is a specific scale threshold. The principal-level judgment is recognising which threshold applies to your team and refusing to scale the in-process pattern beyond it. The pattern is great at its scale. It is a liability beyond it. Knowing where the line is separates the principal engineer from the staff engineer.

---
`;
