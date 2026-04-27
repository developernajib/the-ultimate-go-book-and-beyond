export default `## 12.4 Worker Pool Pattern

A fixed pool of workers processes jobs from a queue.

### Production Worker Pool

A worker pool bounds concurrency to a fixed number of goroutines, preventing unbounded resource consumption when the job queue grows faster than workers can drain it. The pool exposes atomic counters for processed and failed jobs and a queue depth gauge, giving operators a real-time view of throughput and backlog without additional instrumentation.

\`\`\`go
// Job represents a unit of work
type Job interface {
    ID() string
    Process(ctx context.Context) error
}

// WorkerPool manages a pool of workers
type WorkerPool struct {
    workers    int
    jobs       chan Job
    results    chan Result
    errors     chan error
    wg         sync.WaitGroup
    ctx        context.Context
    cancel     context.CancelFunc
    mu         sync.RWMutex
    running    bool

    // Metrics
    processed  atomic.Int64
    failed     atomic.Int64
    queueDepth atomic.Int64
}

// Result represents job completion
type Result struct {
    JobID    string
    Duration time.Duration
    Error    error
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(workers, queueSize int) *WorkerPool {
    ctx, cancel := context.WithCancel(context.Background())

    return &WorkerPool{
        workers: workers,
        jobs:    make(chan Job, queueSize),
        results: make(chan Result, queueSize),
        errors:  make(chan error, queueSize),
        ctx:     ctx,
        cancel:  cancel,
    }
}

// Start launches all workers
func (wp *WorkerPool) Start() error {
    wp.mu.Lock()
    defer wp.mu.Unlock()

    if wp.running {
        return errors.New("pool already running")
    }
    wp.running = true

    for i := 0; i < wp.workers; i++ {
        wp.wg.Add(1)
        go wp.worker(i)
    }

    return nil
}

// worker processes jobs from the queue
func (wp *WorkerPool) worker(id int) {
    defer wp.wg.Done()

    for {
        select {
        case <-wp.ctx.Done():
            return
        case job, ok := <-wp.jobs:
            if !ok {
                return
            }

            wp.queueDepth.Add(-1)

            start := time.Now()
            err := job.Process(wp.ctx)
            duration := time.Since(start)

            if err != nil {
                wp.failed.Add(1)
            } else {
                wp.processed.Add(1)
            }

            select {
            case <-wp.ctx.Done():
                return
            case wp.results <- Result{
                JobID:    job.ID(),
                Duration: duration,
                Error:    err,
            }:
            }
        }
    }
}

// Submit adds a job to the queue
func (wp *WorkerPool) Submit(ctx context.Context, job Job) error {
    wp.mu.RLock()
    if !wp.running {
        wp.mu.RUnlock()
        return errors.New("pool not running")
    }
    wp.mu.RUnlock()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-wp.ctx.Done():
        return errors.New("pool shutting down")
    case wp.jobs <- job:
        wp.queueDepth.Add(1)
        return nil
    }
}

// Results returns the results channel
func (wp *WorkerPool) Results() <-chan Result {
    return wp.results
}

// Stats returns pool statistics
type PoolStats struct {
    Workers    int
    QueueDepth int64
    Processed  int64
    Failed     int64
}

func (wp *WorkerPool) Stats() PoolStats {
    return PoolStats{
        Workers:    wp.workers,
        QueueDepth: wp.queueDepth.Load(),
        Processed:  wp.processed.Load(),
        Failed:     wp.failed.Load(),
    }
}

// Shutdown gracefully stops the pool
func (wp *WorkerPool) Shutdown(timeout time.Duration) error {
    wp.mu.Lock()
    if !wp.running {
        wp.mu.Unlock()
        return nil
    }
    wp.running = false
    wp.mu.Unlock()

    // Stop accepting new jobs
    close(wp.jobs)

    // Wait with timeout
    done := make(chan struct{})
    go func() {
        wp.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        close(wp.results)
        return nil
    case <-time.After(timeout):
        wp.cancel()
        <-done
        close(wp.results)
        return errors.New("shutdown timeout exceeded")
    }
}
\`\`\`

### Dynamic Worker Pool

A fixed-size pool wastes resources when traffic is low and bottlenecks when traffic spikes. A dynamic pool solves this by scaling the worker count between configurable minimum and maximum bounds. An autoscaler goroutine periodically checks the job queue depth: if the backlog exceeds twice the current worker count, it spawns a new worker. If the queue is empty, it signals a worker to exit. Each worker also carries an idle timer, if no job arrives within 30 seconds and the pool is above the minimum, the worker exits on its own.

\`\`\`go
// DynamicPool scales workers based on queue depth
type DynamicPool struct {
    minWorkers int
    maxWorkers int
    jobs       chan Job
    results    chan Result

    ctx        context.Context
    cancel     context.CancelFunc

    activeWorkers atomic.Int32
    workerWg      sync.WaitGroup

    scaleUp    chan struct{}
    scaleDown  chan struct{}
}

func NewDynamicPool(minWorkers, maxWorkers, queueSize int) *DynamicPool {
    ctx, cancel := context.WithCancel(context.Background())

    dp := &DynamicPool{
        minWorkers: minWorkers,
        maxWorkers: maxWorkers,
        jobs:       make(chan Job, queueSize),
        results:    make(chan Result, queueSize),
        ctx:        ctx,
        cancel:     cancel,
        scaleUp:    make(chan struct{}, maxWorkers),
        scaleDown:  make(chan struct{}, maxWorkers),
    }

    return dp
}

func (dp *DynamicPool) Start() {
    // Start minimum workers
    for i := 0; i < dp.minWorkers; i++ {
        dp.addWorker()
    }

    // Start autoscaler
    go dp.autoscaler()
}

func (dp *DynamicPool) addWorker() {
    current := int(dp.activeWorkers.Load())
    if current >= dp.maxWorkers {
        return
    }

    dp.activeWorkers.Add(1)
    dp.workerWg.Add(1)

    go func() {
        defer dp.workerWg.Done()
        defer dp.activeWorkers.Add(-1)

        idleTimer := time.NewTimer(30 * time.Second)
        defer idleTimer.Stop()

        for {
            select {
            case <-dp.ctx.Done():
                return
            case <-dp.scaleDown:
                // Check if we're above minimum
                if int(dp.activeWorkers.Load()) > dp.minWorkers {
                    return
                }
            case job, ok := <-dp.jobs:
                if !ok {
                    return
                }
                idleTimer.Reset(30 * time.Second)

                result := Result{JobID: job.ID()}
                start := time.Now()
                result.Error = job.Process(dp.ctx)
                result.Duration = time.Since(start)

                select {
                case <-dp.ctx.Done():
                    return
                case dp.results <- result:
                }
            case <-idleTimer.C:
                // Idle timeout - try to scale down
                if int(dp.activeWorkers.Load()) > dp.minWorkers {
                    return
                }
                idleTimer.Reset(30 * time.Second)
            }
        }
    }()
}

func (dp *DynamicPool) autoscaler() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-dp.ctx.Done():
            return
        case <-ticker.C:
            queueLen := len(dp.jobs)
            workers := int(dp.activeWorkers.Load())

            // Scale up if queue is backing up
            if queueLen > workers*2 && workers < dp.maxWorkers {
                dp.addWorker()
            }

            // Scale down if queue is empty
            if queueLen == 0 && workers > dp.minWorkers {
                select {
                case dp.scaleDown <- struct{}{}:
                default:
                }
            }
        }
    }
}
\`\`\`

### Worker Pool vs errgroup.SetLimit

For most "process N items with bounded concurrency" patterns, \`errgroup.Group.SetLimit(n)\` is the simpler and more idiomatic choice than a hand-rolled worker pool. The pool shown above is useful when:

- Workers must be long-lived across many batches (connection reuse, warmup cost).
- The pool exposes observability (active-worker gauge, queue depth, per-worker metrics).
- Dynamic scaling matters (the queue-depth scaler above).

For one-shot fan-out with bounded concurrency, \`errgroup.SetLimit\` is four lines instead of forty. Teach both, and recommend the simpler one by default.

### Staff Lens: Pool Sizing Is an Operational Decision

Worker pool size is a tuning knob that interacts with memory limits, downstream capacity, and traffic patterns. The default "NumCPU() for CPU-bound, hundreds for I/O-bound" is a starting point, not an answer. The staff-level discipline: expose the pool size as configuration, not a constant. Tune per environment. Monitor utilisation. Alert when the pool is saturated for extended periods (indicates either under-provisioning or a downstream problem). A pool size burned into the code is a pool size you cannot change without a redeploy when the traffic shape shifts.

### Principal Lens: The Adaptive-Pool Trap

Dynamic pool sizing is seductive and often wrong. The scaling signal (queue length) lags behind the cause (input rate change), so the pool oscillates. Fast scale-up followed by scale-down followed by scale-up is worse than a static pool sized for peak. If dynamic sizing is genuinely needed, use a damped signal (moving average of queue length over minutes, not instantaneous). Most teams are better served by static sizing with an alert threshold than by adaptive scaling with its tuning complexity.

---
`;
