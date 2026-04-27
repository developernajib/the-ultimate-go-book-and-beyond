export default `## 6.9 Complete Interface-Driven Application

This section walks through a complete task queue application where every major component depends on interfaces rather than concrete types. The queue, task store, and task processor are all defined as interfaces, with in-memory implementations provided for demonstration. Swapping to Redis or PostgreSQL backends requires implementing the same interfaces without changing the worker or server code.

### Project Structure

A well-structured Go project separates concerns across predictable directories, making it immediately navigable to any Go developer. The following layout follows the widely adopted convention for Go module organization.

\`\`\`
taskqueue/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── domain/
│   │   └── task.go
│   ├── queue/
│   │   ├── queue.go
│   │   ├── memory.go
│   │   └── redis.go
│   ├── worker/
│   │   ├── worker.go
│   │   └── pool.go
│   └── server/
│       └── server.go
├── go.mod
├── Dockerfile
└── Makefile
\`\`\`

### internal/domain/task.go

The domain package defines types and interfaces that represent the business model independently of any infrastructure concerns. Other packages depend on these types but not vice versa.

\`\`\`go
package domain

import (
    "time"
)

type TaskStatus string

const (
    TaskStatusPending   TaskStatus = "pending"
    TaskStatusRunning   TaskStatus = "running"
    TaskStatusCompleted TaskStatus = "completed"
    TaskStatusFailed    TaskStatus = "failed"
)

type Task struct {
    ID        string
    Type      string
    Payload   []byte
    Status    TaskStatus
    Priority  int
    CreatedAt time.Time
    StartedAt *time.Time
    CompletedAt *time.Time
    Error     string
    Retries   int
    MaxRetries int
}

type TaskResult struct {
    TaskID    string
    Success   bool
    Output    []byte
    Error     error
    Duration  time.Duration
}
\`\`\`

### internal/queue/queue.go

This file defines the interfaces that the rest of the application depends on. The \`Queue\`, \`TaskStore\`, and \`TaskProcessor\` interfaces each describe a single responsibility. Note the \`ProcessorFunc\` adapter at the bottom, which lets plain functions satisfy \`TaskProcessor\`, the same pattern \`http.HandlerFunc\` uses for \`http.Handler\`.

\`\`\`go
package queue

import (
    "context"
    "errors"

    "github.com/example/taskqueue/internal/domain"
)

var (
    ErrQueueEmpty   = errors.New("queue is empty")
    ErrTaskNotFound = errors.New("task not found")
)

// Queue defines the task queue interface
type Queue interface {
    // Enqueue adds a task to the queue
    Enqueue(ctx context.Context, task *domain.Task) error

    // Dequeue removes and returns the next task
    Dequeue(ctx context.Context) (*domain.Task, error)

    // Peek returns the next task without removing it
    Peek(ctx context.Context) (*domain.Task, error)

    // Len returns the number of tasks in the queue
    Len(ctx context.Context) (int, error)
}

// TaskStore stores task state
type TaskStore interface {
    // Save stores a task
    Save(ctx context.Context, task *domain.Task) error

    // Get retrieves a task by ID
    Get(ctx context.Context, id string) (*domain.Task, error)

    // Update updates a task
    Update(ctx context.Context, task *domain.Task) error

    // List returns all tasks matching the filter
    List(ctx context.Context, filter TaskFilter) ([]*domain.Task, error)
}

type TaskFilter struct {
    Status    *domain.TaskStatus
    Type      *string
    Limit     int
    Offset    int
}

// TaskProcessor processes tasks
type TaskProcessor interface {
    Process(ctx context.Context, task *domain.Task) (*domain.TaskResult, error)
}

// ProcessorFunc is a function adapter for TaskProcessor
type ProcessorFunc func(ctx context.Context, task *domain.Task) (*domain.TaskResult, error)

func (f ProcessorFunc) Process(ctx context.Context, task *domain.Task) (*domain.TaskResult, error) {
    return f(ctx, task)
}
\`\`\`

### internal/queue/memory.go

The in-memory implementation uses a \`sync.Mutex\`-protected heap for priority ordering and a \`sync.Cond\` to block \`Dequeue\` callers until a task arrives. The \`MemoryTaskStore\` uses a map with \`sync.RWMutex\` for concurrent read access. Both types include compile-time interface guards at the bottom of the file.

\`\`\`go
package queue

import (
    "container/heap"
    "context"
    "sync"
    "time"

    "github.com/example/taskqueue/internal/domain"
)

// MemoryQueue is an in-memory priority queue implementation
type MemoryQueue struct {
    mu     sync.Mutex
    tasks  taskHeap
    cond   *sync.Cond
    closed bool
}

func NewMemoryQueue() *MemoryQueue {
    mq := &MemoryQueue{
        tasks: make(taskHeap, 0),
    }
    mq.cond = sync.NewCond(&mq.mu)
    heap.Init(&mq.tasks)
    return mq
}

func (q *MemoryQueue) Enqueue(ctx context.Context, task *domain.Task) error {
    q.mu.Lock()
    defer q.mu.Unlock()

    if q.closed {
        return errors.New("queue is closed")
    }

    task.CreatedAt = time.Now()
    task.Status = domain.TaskStatusPending
    heap.Push(&q.tasks, task)
    q.cond.Signal()
    return nil
}

func (q *MemoryQueue) Dequeue(ctx context.Context) (*domain.Task, error) {
    q.mu.Lock()
    defer q.mu.Unlock()

    for len(q.tasks) == 0 && !q.closed {
        // Wait with context support
        done := make(chan struct{})
        go func() {
            q.cond.Wait()
            close(done)
        }()

        q.mu.Unlock()
        select {
        case <-ctx.Done():
            q.mu.Lock()
            return nil, ctx.Err()
        case <-done:
            q.mu.Lock()
        }
    }

    if q.closed && len(q.tasks) == 0 {
        return nil, ErrQueueEmpty
    }

    task := heap.Pop(&q.tasks).(*domain.Task)
    return task, nil
}

func (q *MemoryQueue) Peek(ctx context.Context) (*domain.Task, error) {
    q.mu.Lock()
    defer q.mu.Unlock()

    if len(q.tasks) == 0 {
        return nil, ErrQueueEmpty
    }

    return q.tasks[0], nil
}

func (q *MemoryQueue) Len(ctx context.Context) (int, error) {
    q.mu.Lock()
    defer q.mu.Unlock()
    return len(q.tasks), nil
}

func (q *MemoryQueue) Close() error {
    q.mu.Lock()
    defer q.mu.Unlock()
    q.closed = true
    q.cond.Broadcast()
    return nil
}

// taskHeap implements heap.Interface for priority queue
type taskHeap []*domain.Task

func (h taskHeap) Len() int           { return len(h) }
func (h taskHeap) Less(i, j int) bool { return h[i].Priority > h[j].Priority }
func (h taskHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *taskHeap) Push(x any) {
    *h = append(*h, x.(*domain.Task))
}

func (h *taskHeap) Pop() any {
    old := *h
    n := len(old)
    task := old[n-1]
    *h = old[0 : n-1]
    return task
}

// MemoryTaskStore stores tasks in memory
type MemoryTaskStore struct {
    mu    sync.RWMutex
    tasks map[string]*domain.Task
}

func NewMemoryTaskStore() *MemoryTaskStore {
    return &MemoryTaskStore{
        tasks: make(map[string]*domain.Task),
    }
}

func (s *MemoryTaskStore) Save(ctx context.Context, task *domain.Task) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.tasks[task.ID] = task
    return nil
}

func (s *MemoryTaskStore) Get(ctx context.Context, id string) (*domain.Task, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    task, ok := s.tasks[id]
    if !ok {
        return nil, ErrTaskNotFound
    }
    return task, nil
}

func (s *MemoryTaskStore) Update(ctx context.Context, task *domain.Task) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    if _, ok := s.tasks[task.ID]; !ok {
        return ErrTaskNotFound
    }
    s.tasks[task.ID] = task
    return nil
}

func (s *MemoryTaskStore) List(ctx context.Context, filter TaskFilter) ([]*domain.Task, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    var result []*domain.Task
    for _, task := range s.tasks {
        if filter.Status != nil && task.Status != *filter.Status {
            continue
        }
        if filter.Type != nil && task.Type != *filter.Type {
            continue
        }
        result = append(result, task)
    }

    // Apply pagination
    if filter.Offset >= len(result) {
        return []*domain.Task{}, nil
    }
    result = result[filter.Offset:]
    if filter.Limit > 0 && filter.Limit < len(result) {
        result = result[:filter.Limit]
    }

    return result, nil
}

// Compile-time interface checks
var (
    _ Queue     = (*MemoryQueue)(nil)
    _ TaskStore = (*MemoryTaskStore)(nil)
)
\`\`\`

### internal/worker/worker.go

The \`Worker\` depends on the \`Queue\` and \`TaskStore\` interfaces, not their concrete types. It dispatches tasks to registered \`TaskProcessor\` implementations by task type string, updates task status in the store, and handles retries when processing fails. Context cancellation drives graceful shutdown.

\`\`\`go
package worker

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/example/taskqueue/internal/domain"
    "github.com/example/taskqueue/internal/queue"
)

type Logger interface {
    Debug(msg string, fields ...any)
    Info(msg string, fields ...any)
    Error(msg string, fields ...any)
}

type Worker struct {
    id         string
    queue      queue.Queue
    store      queue.TaskStore
    processors map[string]queue.TaskProcessor
    logger     Logger

    mu      sync.RWMutex
    running bool
    done    chan struct{}
}

func NewWorker(id string, q queue.Queue, store queue.TaskStore, logger Logger) *Worker {
    return &Worker{
        id:         id,
        queue:      q,
        store:      store,
        processors: make(map[string]queue.TaskProcessor),
        logger:     logger,
        done:       make(chan struct{}),
    }
}

func (w *Worker) RegisterProcessor(taskType string, processor queue.TaskProcessor) {
    w.mu.Lock()
    defer w.mu.Unlock()
    w.processors[taskType] = processor
}

func (w *Worker) Start(ctx context.Context) error {
    w.mu.Lock()
    if w.running {
        w.mu.Unlock()
        return fmt.Errorf("worker %s already running", w.id)
    }
    w.running = true
    w.mu.Unlock()

    w.logger.Info("worker started", "worker_id", w.id)

    for {
        select {
        case <-ctx.Done():
            w.logger.Info("worker stopping", "worker_id", w.id)
            close(w.done)
            return ctx.Err()
        default:
            if err := w.processNext(ctx); err != nil {
                if err == queue.ErrQueueEmpty {
                    time.Sleep(100 * time.Millisecond)
                    continue
                }
                w.logger.Error("process error", "worker_id", w.id, "error", err)
            }
        }
    }
}

func (w *Worker) processNext(ctx context.Context) error {
    task, err := w.queue.Dequeue(ctx)
    if err != nil {
        return err
    }

    w.mu.RLock()
    processor, ok := w.processors[task.Type]
    w.mu.RUnlock()

    if !ok {
        w.logger.Error("no processor for task type",
            "task_id", task.ID,
            "task_type", task.Type)
        task.Status = domain.TaskStatusFailed
        task.Error = fmt.Sprintf("no processor for type: %s", task.Type)
        return w.store.Update(ctx, task)
    }

    // Update task status
    now := time.Now()
    task.Status = domain.TaskStatusRunning
    task.StartedAt = &now
    if err := w.store.Update(ctx, task); err != nil {
        return fmt.Errorf("update task status: %w", err)
    }

    w.logger.Debug("processing task",
        "task_id", task.ID,
        "task_type", task.Type)

    // Process task
    result, err := processor.Process(ctx, task)

    completed := time.Now()
    task.CompletedAt = &completed

    if err != nil || (result != nil && !result.Success) {
        task.Status = domain.TaskStatusFailed
        if err != nil {
            task.Error = err.Error()
        } else if result.Error != nil {
            task.Error = result.Error.Error()
        }

        // Retry logic
        if task.Retries < task.MaxRetries {
            task.Retries++
            task.Status = domain.TaskStatusPending
            if err := w.queue.Enqueue(ctx, task); err != nil {
                w.logger.Error("failed to requeue task",
                    "task_id", task.ID,
                    "error", err)
            }
        }
    } else {
        task.Status = domain.TaskStatusCompleted
    }

    return w.store.Update(ctx, task)
}

func (w *Worker) Done() <-chan struct{} {
    return w.done
}
\`\`\`

### internal/worker/pool.go

The \`Pool\` manages multiple \`Worker\` instances, starting them as goroutines and collecting errors when the context is cancelled. Each worker in the pool shares the same queue and store interfaces, so the pool scales horizontally by adding workers without changing any wiring code.

\`\`\`go
package worker

import (
    "context"
    "fmt"
    "sync"

    "github.com/example/taskqueue/internal/queue"
)

type Pool struct {
    workers []*Worker
    queue   queue.Queue
    store   queue.TaskStore
    logger  Logger

    mu      sync.RWMutex
    running bool
}

func NewPool(size int, q queue.Queue, store queue.TaskStore, logger Logger) *Pool {
    workers := make([]*Worker, size)
    for i := 0; i < size; i++ {
        workers[i] = NewWorker(fmt.Sprintf("worker-%d", i), q, store, logger)
    }
    return &Pool{
        workers: workers,
        queue:   q,
        store:   store,
        logger:  logger,
    }
}

func (p *Pool) RegisterProcessor(taskType string, processor queue.TaskProcessor) {
    for _, w := range p.workers {
        w.RegisterProcessor(taskType, processor)
    }
}

func (p *Pool) Start(ctx context.Context) error {
    p.mu.Lock()
    if p.running {
        p.mu.Unlock()
        return fmt.Errorf("pool already running")
    }
    p.running = true
    p.mu.Unlock()

    var wg sync.WaitGroup
    errCh := make(chan error, len(p.workers))

    for _, w := range p.workers {
        wg.Add(1)
        go func(worker *Worker) {
            defer wg.Done()
            if err := worker.Start(ctx); err != nil && err != context.Canceled {
                errCh <- err
            }
        }(w)
    }

    wg.Wait()
    close(errCh)

    // Collect errors
    var errs []error
    for err := range errCh {
        errs = append(errs, err)
    }

    if len(errs) > 0 {
        return fmt.Errorf("pool errors: %v", errs)
    }
    return nil
}
\`\`\`

### cmd/server/main.go

The application entry point wires together all components, configures the server, and handles graceful shutdown. This file should remain thin, delegating business logic to internal packages.

\`\`\`go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/taskqueue/internal/domain"
    "github.com/example/taskqueue/internal/queue"
    "github.com/example/taskqueue/internal/worker"
    "github.com/google/uuid"
)

type stdLogger struct{}

func (l stdLogger) Debug(msg string, fields ...any) {
    log.Printf("[DEBUG] %s %v", msg, fields)
}

func (l stdLogger) Info(msg string, fields ...any) {
    log.Printf("[INFO] %s %v", msg, fields)
}

func (l stdLogger) Error(msg string, fields ...any) {
    log.Printf("[ERROR] %s %v", msg, fields)
}

func main() {
    logger := stdLogger{}

    // Create queue and store
    q := queue.NewMemoryQueue()
    store := queue.NewMemoryTaskStore()

    // Create worker pool
    pool := worker.NewPool(4, q, store, logger)

    // Register processors
    pool.RegisterProcessor("email", queue.ProcessorFunc(processEmail))
    pool.RegisterProcessor("webhook", queue.ProcessorFunc(processWebhook))

    // Start workers
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    go func() {
        if err := pool.Start(ctx); err != nil {
            logger.Error("pool error", "error", err)
        }
    }()

    // HTTP server for submitting tasks
    mux := http.NewServeMux()
    mux.HandleFunc("/tasks", handleCreateTask(q, store, logger))
    mux.HandleFunc("/tasks/", handleGetTask(store))

    server := &http.Server{
        Addr:    ":8080",
        Handler: mux,
    }

    go func() {
        logger.Info("HTTP server starting", "addr", ":8080")
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("server error", "error", err)
        }
    }()

    // Wait for shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    <-sigCh

    logger.Info("Shutting down...")
    cancel()

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        logger.Error("shutdown error", "error", err)
    }

    logger.Info("Server stopped")
}

func handleCreateTask(q queue.Queue, store queue.TaskStore, logger worker.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
            return
        }

        var req struct {
            Type       string          \`json:"type"\`
            Payload    json.RawMessage \`json:"payload"\`
            Priority   int             \`json:"priority"\`
            MaxRetries int             \`json:"max_retries"\`
        }

        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            http.Error(w, "invalid request", http.StatusBadRequest)
            return
        }

        task := &domain.Task{
            ID:         uuid.New().String(),
            Type:       req.Type,
            Payload:    req.Payload,
            Priority:   req.Priority,
            MaxRetries: req.MaxRetries,
        }

        if err := store.Save(r.Context(), task); err != nil {
            http.Error(w, "failed to save task", http.StatusInternalServerError)
            return
        }

        if err := q.Enqueue(r.Context(), task); err != nil {
            http.Error(w, "failed to enqueue task", http.StatusInternalServerError)
            return
        }

        logger.Info("task created", "task_id", task.ID, "type", task.Type)

        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusCreated)
        json.NewEncoder(w).Encode(task)
    }
}

func handleGetTask(store queue.TaskStore) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        id := r.URL.Path[len("/tasks/"):]

        task, err := store.Get(r.Context(), id)
        if err == queue.ErrTaskNotFound {
            http.NotFound(w, r)
            return
        }
        if err != nil {
            http.Error(w, "failed to get task", http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(task)
    }
}

func processEmail(ctx context.Context, task *domain.Task) (*domain.TaskResult, error) {
    // Simulate email processing
    time.Sleep(100 * time.Millisecond)
    return &domain.TaskResult{
        TaskID:  task.ID,
        Success: true,
    }, nil
}

func processWebhook(ctx context.Context, task *domain.Task) (*domain.TaskResult, error) {
    // Simulate webhook processing
    time.Sleep(50 * time.Millisecond)
    return &domain.TaskResult{
        TaskID:  task.ID,
        Success: true,
    }, nil
}
\`\`\`

### Read the Code Like a Reviewer

The interface-driven application above is a strong reference. A staff reviewer would flag:

1. **The interfaces live with the implementations.** For a teaching example this is acceptable. In production, move the interfaces to the consumer packages so the dependency arrow points from implementation to consumer.
2. **Each interface has a single implementation.** For some types this is transitional (a real implementation is next), but for types with one real implementation and one mock, consider whether the interface is earning its complexity.
3. **No circuit breaker or retry logic at the interface boundary.** For production services calling external APIs, add the resilience layer at the boundary where the interface is satisfied.
4. **Error types are not typed.** The service returns plain errors wrapped with \`%w\`. For callers that need to branch (not-found vs retryable vs permanent), add typed errors with \`errors.As\` extraction.

### How to Use This as a Reference (Senior Track)

Three deployment patterns:

1. **As a day-one reference for new Go engineers.** "Here is our team's interface design. Read it and pattern-match on your first PR."
2. **As the skeleton for new services.** Copy, rename, adapt to the service's specific domain.
3. **As the subject of an architecture review.** Walk the team through it in a 90-minute session. Each section is a discussion topic.

The reference implementation rots if it is not maintained. Assign an owner to refresh it each quarter.

### Staff Lens: The Evolution Path This Application Sets Up

The value of this structure is not the code. It is the evolution path it enables without rewrites.

- **Swap the in-memory queue for Redis.** Implement \`Queue\` against Redis Streams. Add a \`RedisQueue\` type. Flip one line in \`main.go\`. Zero changes to \`Worker\` or \`Pool\`.
- **Swap the in-memory store for PostgreSQL.** Same story with \`TaskStore\`.
- **Add durability and exactly-once semantics.** The interface does not change. The implementation adds a transactional outbox pattern.
- **Split processors across services.** \`TaskProcessor\` becomes the RPC boundary. The worker stays local, the processor moves to a different binary via gRPC.
- **Add observability.** Wrap the \`Queue\` and \`TaskStore\` interfaces with a decorator that emits traces and metrics. No changes to the worker.

Each evolution is a one-week project scoped to a single package. This is what interface-driven design buys: optionality. A staff engineer evaluating this code asks "what are the three most likely production changes over the next two years, and how does the current interface design handle them?" If the answer requires rewriting the worker, the interfaces are wrong. If the answer is "add an implementation of an existing interface", the interfaces are right.

### Production Gaps to Close Before Shipping

This reference is a teaching example. Before any team runs it in production, close these gaps:

1. **Context propagation into \`Queue.Dequeue\`'s wait loop.** The current \`sync.Cond\` pattern leaks a goroutine on context cancellation. Use a channel-based queue or \`context.AfterFunc\` instead.
2. **Typed errors.** Callers cannot branch on \`ErrTaskNotFound\` versus a transient DB error without string inspection. Export typed errors and use \`errors.Is\` or \`errors.As\`.
3. **Poison-message handling.** A task that fails \`MaxRetries\` times should go to a dead-letter queue, not vanish. Add a DLQ interface.
4. **Metrics and tracing.** No production queue runs without per-task latency histograms and queue-depth gauges. Wire these at the interface boundary via a decorator.
5. **Authentication on the HTTP endpoints.** \`/tasks\` currently accepts anything. Add authentication middleware and per-user task-type authorization.
6. **Backpressure.** Enqueue succeeds unconditionally. A fast producer can drive the queue into OOM. Add a bounded-queue variant of \`Queue\`.

These are not edge cases. They are table stakes. Every one of them is absorbed by extending interfaces, not rewriting them, which is the staff-level win of this design.

---
`;
