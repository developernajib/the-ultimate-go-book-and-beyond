export default `## 15.2 Work Stealing

Work stealing is one of the most important techniques for load balancing in concurrent systems. It was pioneered by the Cilk project at MIT and is now used in Go's own scheduler, Java's ForkJoinPool, and many other systems.

### How Work Stealing Works

In a work-stealing scheduler each worker thread maintains its own double-ended queue (deque) of tasks. The owner thread pushes and pops tasks from one end using LIFO order, which is cache-friendly because recently created tasks are likely to reference data still in the CPU cache. When a worker's own deque is empty it becomes a "thief" and steals tasks from the opposite end of a randomly chosen victim's deque, minimizing contention between the owner and any potential thieves.

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                    Work Stealing Architecture                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Worker 0          Worker 1          Worker 2          Worker 3     │
│  ┌────────┐        ┌────────┐        ┌────────┐        ┌────────┐   │
│  │ Task A │        │ Task D │        │ Task G │        │ IDLE   │   │
│  │ Task B │        │ Task E │        │        │        │        │   │
│  │ Task C │        │ Task F │        │        │        │        │   │
│  └────┬───┘        └────────┘        └────────┘        └────┬───┘   │
│       │                                                      │       │
│       │              STEAL! ◄────────────────────────────────┘       │
│       │                                                              │
│  Deque (double-ended queue):                                        │
│  - Owner pushes/pops from bottom (LIFO)                             │
│  - Thieves steal from top (FIFO)                                    │
│  - Minimizes contention between owner and thieves                   │
│                                                                      │
│  Benefits:                                                          │
│  - Automatic load balancing                                         │
│  - Cache-friendly (owner works on recently pushed tasks)            │
│  - Minimal synchronization (contention only on steal)               │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

### Lock-Free Work-Stealing Deque

The classic work-stealing deque uses atomic operations for efficiency:

\`\`\`go
// WorkStealingDeque is a lock-free double-ended queue
// Owner pushes/pops from bottom, thieves steal from top
type WorkStealingDeque[T any] struct {
    buffer atomic.Pointer[[]T]
    top    atomic.Int64
    bottom atomic.Int64
}

func NewWorkStealingDeque[T any](capacity int) *WorkStealingDeque[T] {
    buf := make([]T, capacity)
    d := &WorkStealingDeque[T]{}
    d.buffer.Store(&buf)
    return d
}

// Push adds a task to the bottom (only called by owner)
func (d *WorkStealingDeque[T]) Push(task T) {
    bottom := d.bottom.Load()
    top := d.top.Load()
    buf := *d.buffer.Load()

    size := bottom - top
    if size >= int64(len(buf)-1) {
        // Grow buffer
        d.grow()
        buf = *d.buffer.Load()
    }

    buf[bottom%int64(len(buf))] = task
    // Memory barrier to ensure task is visible before bottom update
    d.bottom.Store(bottom + 1)
}

// Pop removes a task from bottom (only called by owner)
func (d *WorkStealingDeque[T]) Pop() (T, bool) {
    bottom := d.bottom.Load() - 1
    d.bottom.Store(bottom)

    top := d.top.Load()

    if top <= bottom {
        // Non-empty
        buf := *d.buffer.Load()
        task := buf[bottom%int64(len(buf))]

        if top == bottom {
            // Last element - potential race with thieves
            if !d.top.CompareAndSwap(top, top+1) {
                // Lost race to thief
                d.bottom.Store(top + 1)
                var zero T
                return zero, false
            }
            d.bottom.Store(top + 1)
        }
        return task, true
    }

    // Empty
    d.bottom.Store(top)
    var zero T
    return zero, false
}

// Steal removes a task from top (called by other workers)
func (d *WorkStealingDeque[T]) Steal() (T, bool) {
    top := d.top.Load()
    bottom := d.bottom.Load()

    if top >= bottom {
        // Empty
        var zero T
        return zero, false
    }

    buf := *d.buffer.Load()
    task := buf[top%int64(len(buf))]

    // Try to increment top
    if !d.top.CompareAndSwap(top, top+1) {
        // Lost race
        var zero T
        return zero, false
    }

    return task, true
}

func (d *WorkStealingDeque[T]) grow() {
    oldBuf := *d.buffer.Load()
    newBuf := make([]T, len(oldBuf)*2)

    top := d.top.Load()
    bottom := d.bottom.Load()

    for i := top; i < bottom; i++ {
        newBuf[i%int64(len(newBuf))] = oldBuf[i%int64(len(oldBuf))]
    }

    d.buffer.Store(&newBuf)
}

func (d *WorkStealingDeque[T]) Size() int {
    return int(d.bottom.Load() - d.top.Load())
}
\`\`\`

### Production-Ready Work Stealing Pool

The \`WorkStealingPool\` ties together the deque implementation and the worker goroutines into a reusable pool modelled after Go's own scheduler and Java's \`ForkJoinPool\`. Each worker first drains its own deque before attempting to steal from a randomly selected victim, and a brief sleep on idle prevents busy-waiting from consuming CPU. Atomic counters track steal successes and failures, giving operators visibility into load-balance efficiency at runtime.

\`\`\`go
// WorkStealingPool implements a work-stealing thread pool
// similar to Go's own scheduler and Java's ForkJoinPool
type WorkStealingPool struct {
    workers    int
    deques     []*WorkStealingDeque[Task]
    wg         sync.WaitGroup
    closed     atomic.Bool
    taskCount  atomic.Int64
    stealCount atomic.Int64

    // Metrics
    tasksExecuted atomic.Int64
    stealsSuccess atomic.Int64
    stealsFailed  atomic.Int64
}

type Task func()

var globalCounter atomic.Int64

func NewWorkStealingPool(workers int) *WorkStealingPool {
    if workers <= 0 {
        workers = runtime.NumCPU()
    }

    p := &WorkStealingPool{
        workers: workers,
        deques:  make([]*WorkStealingDeque[Task], workers),
    }

    for i := 0; i < workers; i++ {
        p.deques[i] = NewWorkStealingDeque[Task](1024)
    }

    for i := 0; i < workers; i++ {
        p.wg.Add(1)
        go p.worker(i)
    }

    return p
}

func (p *WorkStealingPool) worker(id int) {
    defer p.wg.Done()

    myDeque := p.deques[id]
    rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano())+uint64(id), 0))

    for !p.closed.Load() {
        // Try own queue first (LIFO - cache friendly)
        if task, ok := myDeque.Pop(); ok {
            p.executeTask(task)
            continue
        }

        // Try to steal from random worker
        if task, ok := p.trySteal(id, rng); ok {
            p.executeTask(task)
            p.stealsSuccess.Add(1)
            continue
        }
        p.stealsFailed.Add(1)

        // Nothing to do - brief sleep to avoid busy waiting
        time.Sleep(time.Microsecond * 10)
    }

    // Drain remaining tasks on shutdown
    for {
        if task, ok := myDeque.Pop(); ok {
            p.executeTask(task)
        } else {
            break
        }
    }
}

func (p *WorkStealingPool) trySteal(myID int, rng *rand.Rand) (Task, bool) {
    // Random victim selection reduces contention
    startIdx := rng.Intn(p.workers)

    for i := 0; i < p.workers; i++ {
        victim := (startIdx + i) % p.workers
        if victim == myID {
            continue
        }

        if task, ok := p.deques[victim].Steal(); ok {
            p.stealCount.Add(1)
            return task, true
        }
    }

    return nil, false
}

func (p *WorkStealingPool) executeTask(task Task) {
    defer func() {
        if r := recover(); r != nil {
            // Log panic but don't crash the worker
            fmt.Printf("task panicked: %v\\n", r)
        }
    }()

    task()
    p.tasksExecuted.Add(1)
    p.taskCount.Add(-1)
}

// Submit adds a task to the pool
func (p *WorkStealingPool) Submit(task Task) error {
    if p.closed.Load() {
        return errors.New("pool is closed")
    }

    // Round-robin distribution for initial task placement
    id := int(globalCounter.Add(1)) % p.workers
    p.deques[id].Push(task)
    p.taskCount.Add(1)
    return nil
}

// SubmitAndWait submits a task and waits for completion
func (p *WorkStealingPool) SubmitAndWait(task Task) error {
    done := make(chan struct{})

    err := p.Submit(func() {
        defer close(done)
        task()
    })
    if err != nil {
        return err
    }

    <-done
    return nil
}

// Shutdown gracefully shuts down the pool
func (p *WorkStealingPool) Shutdown() {
    p.closed.Store(true)
    p.wg.Wait()
}

// Stats returns pool statistics
func (p *WorkStealingPool) Stats() PoolStats {
    return PoolStats{
        TasksExecuted: p.tasksExecuted.Load(),
        StealsSuccess: p.stealsSuccess.Load(),
        StealsFailed:  p.stealsFailed.Load(),
        PendingTasks:  p.taskCount.Load(),
    }
}

type PoolStats struct {
    TasksExecuted int64
    StealsSuccess int64
    StealsFailed  int64
    PendingTasks  int64
}
\`\`\`

### Fork-Join Pattern

Work stealing naturally supports the fork-join pattern for divide-and-conquer algorithms:

\`\`\`go
// ForkJoinPool extends work stealing with fork-join support
type ForkJoinPool struct {
    *WorkStealingPool
}

// ForkJoinTask represents a task that can spawn subtasks
type ForkJoinTask[T any] struct {
    pool   *ForkJoinPool
    result atomic.Pointer[T]
    done   atomic.Bool
    wait   chan struct{}
}

func NewForkJoinTask[T any](pool *ForkJoinPool) *ForkJoinTask[T] {
    return &ForkJoinTask[T]{
        pool: pool,
        wait: make(chan struct{}),
    }
}

func (t *ForkJoinTask[T]) Complete(result T) {
    t.result.Store(&result)
    t.done.Store(true)
    close(t.wait)
}

func (t *ForkJoinTask[T]) Join() T {
    <-t.wait
    return *t.result.Load()
}

func (t *ForkJoinTask[T]) Fork(fn func()) {
    t.pool.Submit(fn)
}

// Example: Parallel sum using fork-join
func ParallelSum(pool *ForkJoinPool, nums []int, threshold int) int {
    if len(nums) <= threshold {
        sum := 0
        for _, n := range nums {
            sum += n
        }
        return sum
    }

    mid := len(nums) / 2
    leftResult := make(chan int, 1)
    rightResult := make(chan int, 1)

    // Fork left subtask
    pool.Submit(func() {
        leftResult <- ParallelSum(pool, nums[:mid], threshold)
    })

    // Fork right subtask
    pool.Submit(func() {
        rightResult <- ParallelSum(pool, nums[mid:], threshold)
    })

    // Join results
    return <-leftResult + <-rightResult
}
\`\`\`

### Go's Scheduler Already Does Work-Stealing

Go's runtime scheduler itself uses work-stealing: each P (processor) has its own runqueue, and idle Ps steal work from busy ones. This is built-in and automatic. For general goroutine scheduling, you get work-stealing for free.

The pattern in this section applies when you have an application-level work queue (jobs to process, tasks in a pool) and want work-stealing semantics for it. Most Go applications do not need this because a shared channel with multiple workers already provides reasonable load balancing. Work-stealing at the application level is justified when:

- Per-worker queues are needed for locality (cache affinity, state partitioning).
- Channel-based distribution produces a visible imbalance due to varying task durations.
- Profiling shows idle workers while other workers have backlog.

Without these conditions, a shared work channel with multiple consumers is simpler and often equivalent in performance.

### Staff Lens: Work-Stealing Is Rarely the Answer

Go's idiomatic worker pool (N workers, 1 shared channel) is not work-stealing, but it is usually equivalent in performance because goroutine scheduling already distributes work across Ps. Reaching for application-level work-stealing often adds complexity for no benefit. Before implementing, profile the idiomatic worker pool first and confirm imbalance is the actual problem.

---
`;
