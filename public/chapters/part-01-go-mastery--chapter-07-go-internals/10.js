export default `## 7.9 Company Case Studies

### Google: GC Tuning for Low-Latency Services

Google's internal Go services handle billions of requests daily with strict latency requirements.

**Challenge**: GC pauses were causing P99 latency spikes in ad-serving systems.

**Solution**:
1. Set \`GOMEMLIMIT\` to prevent OOM while allowing higher memory usage
2. Reduced allocation rate with \`sync.Pool\` for frequently allocated objects
3. Pre-allocated slices and maps where size was predictable
4. Kept hot-path objects on the stack via escape analysis awareness

The following code shows the \`sync.Pool\` pattern and pre-allocation approach used to reduce GC pressure.

\`\`\`go
// Google-style allocation optimization
package main

import (
    "sync"
)

// BufferPool reduces GC pressure for high-throughput services
var BufferPool = sync.Pool{
    New: func() any {
        // Pre-allocate common buffer size
        buf := make([]byte, 0, 4096)
        return &buf
    },
}

// GetBuffer retrieves a buffer from the pool
func GetBuffer() *[]byte {
    return BufferPool.Get().(*[]byte)
}

// PutBuffer returns a buffer to the pool
func PutBuffer(buf *[]byte) {
    // Reset length but keep capacity
    *buf = (*buf)[:0]
    BufferPool.Put(buf)
}

// PreallocatedMap avoids map growth during operation
type PreallocatedMap struct {
    data map[string]any
}

func NewPreallocatedMap(expectedSize int) *PreallocatedMap {
    return &PreallocatedMap{
        data: make(map[string]any, expectedSize),
    }
}
\`\`\`

### Uber: Scheduler Optimization for High-Concurrency

Uber's dispatch system handles millions of concurrent ride requests.

**Challenge**: Goroutine scheduling latency affected real-time driver-rider matching.

**Solution**:
1. Profiled scheduler behavior with \`GODEBUG=schedtrace\`
2. Replaced per-request goroutines with bounded worker pools
3. Used \`runtime.LockOSThread()\` for latency-sensitive operations
4. Coalesced requests to reduce total goroutine count

The priority worker pool below demonstrates the pattern: a fixed number of workers pull tasks from a priority queue, avoiding the overhead of unbounded goroutine creation.

\`\`\`go
// Uber-style worker pool with priority
package main

import (
    "container/heap"
    "sync"
    "time"
)

type Priority int

const (
    PriorityLow Priority = iota
    PriorityNormal
    PriorityHigh
    PriorityCritical
)

type Task struct {
    ID       string
    Priority Priority
    Work     func()
    Created  time.Time
    index    int
}

type PriorityQueue []*Task

func (pq PriorityQueue) Len() int { return len(pq) }

func (pq PriorityQueue) Less(i, j int) bool {
    // Higher priority first, then older tasks
    if pq[i].Priority != pq[j].Priority {
        return pq[i].Priority > pq[j].Priority
    }
    return pq[i].Created.Before(pq[j].Created)
}

func (pq PriorityQueue) Swap(i, j int) {
    pq[i], pq[j] = pq[j], pq[i]
    pq[i].index = i
    pq[j].index = j
}

func (pq *PriorityQueue) Push(x any) {
    n := len(*pq)
    task := x.(*Task)
    task.index = n
    *pq = append(*pq, task)
}

func (pq *PriorityQueue) Pop() any {
    old := *pq
    n := len(old)
    task := old[n-1]
    old[n-1] = nil
    task.index = -1
    *pq = old[0 : n-1]
    return task
}

type PriorityWorkerPool struct {
    mu      sync.Mutex
    cond    *sync.Cond
    queue   PriorityQueue
    workers int
    running bool
}

func NewPriorityWorkerPool(workers int) *PriorityWorkerPool {
    p := &PriorityWorkerPool{
        queue:   make(PriorityQueue, 0),
        workers: workers,
        running: true,
    }
    p.cond = sync.NewCond(&p.mu)
    heap.Init(&p.queue)

    for i := 0; i < workers; i++ {
        go p.worker()
    }

    return p
}

func (p *PriorityWorkerPool) worker() {
    for {
        p.mu.Lock()
        for p.running && p.queue.Len() == 0 {
            p.cond.Wait()
        }

        if !p.running && p.queue.Len() == 0 {
            p.mu.Unlock()
            return
        }

        task := heap.Pop(&p.queue).(*Task)
        p.mu.Unlock()

        task.Work()
    }
}

func (p *PriorityWorkerPool) Submit(task *Task) {
    task.Created = time.Now()

    p.mu.Lock()
    heap.Push(&p.queue, task)
    p.mu.Unlock()

    p.cond.Signal()
}

func (p *PriorityWorkerPool) Stop() {
    p.mu.Lock()
    p.running = false
    p.mu.Unlock()
    p.cond.Broadcast()
}
\`\`\`

### Netflix: Runtime Tracing for Performance Analysis

Netflix uses Go's built-in execution tracing to identify performance bottlenecks that are invisible in traditional metrics.

**Challenge**: Microservices had unpredictable latency spikes that did not correlate with CPU or memory usage.

**Solution**:
1. Integrated \`runtime/trace\` into their observability stack
2. Built custom trace analysis tools to identify goroutine contention and lock waits
3. Used trace data to optimize critical paths, particularly around mutex-heavy code

The \`TraceManager\` below wraps Go's tracing API into an HTTP-controllable service, allowing engineers to capture traces on-demand in production without redeploying.

\`\`\`go
// Netflix-style trace integration
package main

import (
    "context"
    "encoding/json"
    "net/http"
    "os"
    "runtime/trace"
    "sync"
    "time"
)

// TraceManager handles runtime tracing
type TraceManager struct {
    mu       sync.Mutex
    tracing  bool
    file     *os.File
    stopChan chan struct{}
}

func NewTraceManager() *TraceManager {
    return &TraceManager{
        stopChan: make(chan struct{}),
    }
}

// StartTracing begins runtime tracing
func (tm *TraceManager) StartTracing(filename string, duration time.Duration) error {
    tm.mu.Lock()
    defer tm.mu.Unlock()

    if tm.tracing {
        return nil
    }

    f, err := os.Create(filename)
    if err != nil {
        return err
    }

    if err := trace.Start(f); err != nil {
        f.Close()
        return err
    }

    tm.file = f
    tm.tracing = true

    // Auto-stop after duration
    if duration > 0 {
        go func() {
            select {
            case <-time.After(duration):
                tm.StopTracing()
            case <-tm.stopChan:
            }
        }()
    }

    return nil
}

// StopTracing ends runtime tracing
func (tm *TraceManager) StopTracing() error {
    tm.mu.Lock()
    defer tm.mu.Unlock()

    if !tm.tracing {
        return nil
    }

    trace.Stop()

    if tm.file != nil {
        tm.file.Close()
        tm.file = nil
    }

    tm.tracing = false

    select {
    case tm.stopChan <- struct{}{}:
    default:
    }

    return nil
}

// IsTracing returns whether tracing is active
func (tm *TraceManager) IsTracing() bool {
    tm.mu.Lock()
    defer tm.mu.Unlock()
    return tm.tracing
}

// TraceHandler returns HTTP handlers for trace management
func (tm *TraceManager) TraceHandler() http.Handler {
    mux := http.NewServeMux()

    mux.HandleFunc("/trace/start", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
            return
        }

        var req struct {
            Filename string \`json:"filename"\`
            Duration string \`json:"duration"\`
        }

        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }

        duration, _ := time.ParseDuration(req.Duration)
        if duration == 0 {
            duration = 30 * time.Second
        }

        filename := req.Filename
        if filename == "" {
            filename = "trace.out"
        }

        if err := tm.StartTracing(filename, duration); err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        json.NewEncoder(w).Encode(map[string]any{
            "status":   "tracing started",
            "filename": filename,
            "duration": duration.String(),
        })
    })

    mux.HandleFunc("/trace/stop", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
            return
        }

        if err := tm.StopTracing(); err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        json.NewEncoder(w).Encode(map[string]string{
            "status": "tracing stopped",
        })
    })

    mux.HandleFunc("/trace/status", func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode(map[string]bool{
            "tracing": tm.IsTracing(),
        })
    })

    return mux
}

// TracedOperation wraps an operation with trace regions
func TracedOperation(ctx context.Context, name string, fn func(context.Context) error) error {
    ctx, task := trace.NewTask(ctx, name)
    defer task.End()

    trace.WithRegion(ctx, "execute", func() {
        // Region for the actual execution
    })

    return fn(ctx)
}
\`\`\`

### What the Case Studies Have in Common

For a senior engineer reading case studies, the pattern to extract:

1. **Every company optimised after profiling.** None of them started with "we should optimise X". They all started with "pprof or trace said X is the bottleneck".
2. **The fix was structural more often than tuning.** Reducing allocations, restructuring hot paths, pooling reusable objects. \`GOGC\` and \`GOMEMLIMIT\` changes were complementary, not primary.
3. **The measurements were quantitative.** "Latency dropped from 50ms to 5ms" rather than "it feels faster". The discipline is "measure before, measure after, defend the change".

Adopt the pattern for your own team. The internal case studies your team writes after each optimisation become the institutional knowledge that compounds over years.

---
`;
