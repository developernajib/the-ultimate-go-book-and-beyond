## 15.2 Work Stealing

Work stealing is one of the most important techniques for load balancing in concurrent systems. It was pioneered by the Cilk project at MIT and is now used in Go's own scheduler, Java's ForkJoinPool, and many other systems.

### How Work Stealing Works

In a work-stealing scheduler each worker thread maintains its own double-ended queue (deque) of tasks. The owner thread pushes and pops tasks from one end using LIFO order, which is cache-friendly because recently created tasks are likely to reference data still in the CPU cache. When a worker's own deque is empty it becomes a "thief" and steals tasks from the opposite end of a randomly chosen victim's deque, minimizing contention between the owner and any potential thieves.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Work Stealing Architecture                        │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Worker 0          Worker 1          Worker 2          Worker 3      │
│  ┌────────┐        ┌────────┐        ┌────────┐        ┌────────┐    │
│  │ Task A │        │ Task D │        │ Task G │        │ IDLE   │    │
│  │ Task B │        │ Task E │        │        │        │        │    │
│  │ Task C │        │ Task F │        │        │        │        │    │
│  └────┬───┘        └────────┘        └────────┘        └────┬───┘    │
│       │                                                      │       │
│       │              STEAL! ◄────────────────────────────────┘       │
│       │                                                              │
│  Deque (double-ended queue):                                         │
│  - Owner pushes/pops from bottom (LIFO)                              │
│  - Thieves steal from top (FIFO)                                     │
│  - Minimizes contention between owner and thieves                    │
│                                                                      │
│  Benefits:                                                           │
│  - Automatic load balancing                                          │
│  - Cache-friendly (owner works on recently pushed tasks)             │
│  - Minimal synchronization (contention only on steal)                │
└──────────────────────────────────────────────────────────────────────┘
```

### Lock-Free Work-Stealing Deque

The classic work-stealing deque (Chase and Lev, 2005) uses atomic operations for efficiency. One detail in it is easy to miss and produces a genuine data race, so it is worth stating up front.

A thief reads the task out of the slot *before* it CASes `top`. That read is speculative: if the CAS then fails, the thief throws the value away. The tempting conclusion is that the CAS makes the read safe. It does not. The CAS validates the *index*, not the read, and the read already happened. Meanwhile the owner may be popping that same slot and pushing a new task straight back into it. Slot writes and the thief's speculative read therefore need to be atomic in their own right, not merely guarded by a later CAS on a different variable.

Storing the elements as `[]atomic.Pointer[T]` rather than `[]T` is what closes the hole. With plain `[]T` the race detector fires on the very first stress run:

```
WARNING: DATA RACE
Write at 0x00c0000be030 by goroutine 7:
  main.(*WorkStealingDeque[go.shape.int]).Push()
Previous read at 0x00c0000be030 by goroutine 10:
  main.(*WorkStealingDeque[go.shape.int]).Steal()
```

```go
// WorkStealingDeque is a lock-free double-ended queue.
// Owner pushes/pops from bottom, thieves steal from top.
//
// Elements are atomic.Pointer slots, not plain values: a thief reads a
// slot speculatively before its CAS, concurrently with the owner
// writing that slot, so the element access itself must be atomic.
type WorkStealingDeque[T any] struct {
    buffer atomic.Pointer[[]atomic.Pointer[T]]
    top    atomic.Int64
    bottom atomic.Int64
}

func NewWorkStealingDeque[T any](capacity int) *WorkStealingDeque[T] {
    buf := make([]atomic.Pointer[T], capacity)
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

    buf[bottom%int64(len(buf))].Store(&task)
    // The bottom store publishes the task: it is a release that pairs
    // with the acquiring load in Steal.
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
        p := buf[bottom%int64(len(buf))].Load()

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
        if p == nil {
            var zero T
            return zero, false
        }
        return *p, true
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
    // Speculative read: only valid if the CAS below succeeds.
    p := buf[top%int64(len(buf))].Load()

    // Try to increment top
    if !d.top.CompareAndSwap(top, top+1) {
        // Lost race
        var zero T
        return zero, false
    }

    if p == nil {
        var zero T
        return zero, false
    }
    return *p, true
}

func (d *WorkStealingDeque[T]) grow() {
    oldBuf := *d.buffer.Load()
    newBuf := make([]atomic.Pointer[T], len(oldBuf)*2)

    top := d.top.Load()
    bottom := d.bottom.Load()

    for i := top; i < bottom; i++ {
        newBuf[i%int64(len(newBuf))].Store(oldBuf[i%int64(len(oldBuf))].Load())
    }

    d.buffer.Store(&newBuf)
}

// Size is an estimate only. Both counters move under your feet, so
// treat the result as a metric, never as a decision input.
func (d *WorkStealingDeque[T]) Size() int {
    return int(d.bottom.Load() - d.top.Load())
}
```

A thief that loses the CAS may have read from a buffer the owner has since replaced. That is harmless: the old buffer is still reachable from the thief's own local variable, so the GC keeps it alive, and the stolen value is discarded anyway. This is a case where Go's GC removes an entire class of reclamation bugs that the original C version had to solve by hand.

### Production-Ready Work Stealing Pool

The `WorkStealingPool` ties together the deque implementation and the worker goroutines into a reusable pool modeled after Go's own scheduler and Java's `ForkJoinPool`. Each worker first drains its own deque before attempting to steal from a randomly selected victim, and a brief sleep on idle keeps a starved worker from spinning at full tilt. Atomic counters track steal successes and failures, giving operators visibility into load-balance efficiency at runtime.

Now the part that is easy to get catastrophically wrong. The deque's `Push` and `Pop` are documented "owner only", and that is not a stylistic preference. Both do a load-modify-store on `bottom` with no CAS:

```go
bottom := d.bottom.Load()
// ...
d.bottom.Store(bottom + 1)
```

That sequence is safe only when a single goroutine performs it. The obvious `Submit` implementation, `p.deques[id].Push(task)`, calls `Push` from whatever goroutine happened to call `Submit`, which is a different goroutine from the owning worker. Two concurrent `Push` calls read the same `bottom` and both store `bottom+1`: one task is overwritten and lost.

This bug is worth dwelling on because of how it fails. Submitting 20,000 tasks through two concurrent callers loses nearly half of them:

```
pushed 20000 items, deque reports size 11133 (lost 8867)
```

**The race detector reports nothing.** Every access here is an `atomic.Int64` operation, so there is no data race in the memory-model sense for `-race` to find. What there is instead is a lost update: an algorithm that is unsound at a level the tool does not model. This is the concrete reason "it passes under `-race`" is not the same as "it is correct". The detector proves the absence of unsynchronized access, not the presence of a correct algorithm.

The fix is the one Go's own scheduler uses. The runtime pairs each P's local runqueue with a **global runqueue**, and goroutines created from off-P go to the global queue rather than into a local one. Mirror that: `Submit` hands the task to a shared intake channel, and each worker refills its own deque from that channel, so every `Push` is executed by the deque's owner and the invariant holds.

Two further caveats, because "production-ready" has limits. Idle workers here poll on a timer rather than blocking, so an idle pool never lets the CPU go quiet. A pool meant to sit idle for long stretches should park on a channel instead. And `Submit` still races `Shutdown`: `Submit` can pass its `closed` check and then have `Shutdown` complete before the send lands. See the note on `Shutdown`.

```go
// WorkStealingPool implements a work-stealing thread pool
// similar to Go's own scheduler and Java's ForkJoinPool
type WorkStealingPool struct {
    workers int
    deques  []*WorkStealingDeque[Task]

    // global is the intake queue, mirroring the runtime's global
    // runqueue. Submit must not Push directly into a worker's deque:
    // Push is owner-only, and violating that silently loses tasks.
    global chan Task

    wg     sync.WaitGroup
    closed atomic.Bool

    // Metrics
    taskCount     atomic.Int64
    tasksExecuted atomic.Int64
    stealsSuccess atomic.Int64
    stealsFailed  atomic.Int64
}

type Task func()

func NewWorkStealingPool(workers int) *WorkStealingPool {
    if workers <= 0 {
        workers = runtime.NumCPU()
    }

    p := &WorkStealingPool{
        workers: workers,
        deques:  make([]*WorkStealingDeque[Task], workers),
        global:  make(chan Task, 4096),
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

        // Then the global intake queue. This worker owns myDeque, so
        // this Push is the only kind that respects the owner rule.
        select {
        case task := <-p.global:
            myDeque.Push(task)
            continue
        default:
        }

        // Try to steal from random worker
        if task, ok := p.trySteal(id, rng); ok {
            p.stealsSuccess.Add(1)
            p.executeTask(task)
            continue
        }
        p.stealsFailed.Add(1)

        // Nothing to steal, so park briefly rather than spin. Note that
        // stealsFailed therefore counts idle polls, not just contested
        // steals: on an idle pool it climbs continuously. Read it as a
        // rate against stealsSuccess, never as an absolute.
        time.Sleep(time.Microsecond * 10)
    }

    // Drain remaining tasks on shutdown: local deque first, then
    // anything still sitting in the global intake queue.
    for {
        if task, ok := myDeque.Pop(); ok {
            p.executeTask(task)
            continue
        }
        select {
        case task := <-p.global:
            p.executeTask(task)
        default:
            return
        }
    }
}

func (p *WorkStealingPool) trySteal(myID int, rng *rand.Rand) (Task, bool) {
    // Random victim selection reduces contention
    startIdx := rng.IntN(p.workers)

    for i := 0; i < p.workers; i++ {
        victim := (startIdx + i) % p.workers
        if victim == myID {
            continue
        }

        if task, ok := p.deques[victim].Steal(); ok {
            return task, true
        }
    }

    return nil, false
}

func (p *WorkStealingPool) executeTask(task Task) {
    // The accounting must happen in the defer. If it sits after task()
    // instead, a panicking task unwinds straight past it and taskCount
    // never comes back down, so the pool reports phantom pending work
    // forever after the first panic.
    defer func() {
        p.tasksExecuted.Add(1)
        p.taskCount.Add(-1)

        if r := recover(); r != nil {
            // Log panic but don't crash the worker. An unrecovered
            // panic in a worker goroutine takes down the process.
            fmt.Printf("task panicked: %v\n", r)
        }
    }()

    task()
}

// Submit adds a task to the pool.
//
// The closed check is advisory: Shutdown can win the race between the
// check and the send, in which case the task is dropped. See the note
// above Shutdown.
func (p *WorkStealingPool) Submit(task Task) error {
    if p.closed.Load() {
        return errors.New("pool is closed")
    }

    p.taskCount.Add(1)

    // Hand off to the intake queue rather than pushing into a deque.
    // Push is owner-only, and calling it from this goroutine would race
    // the owning worker's Pop on bottom and silently lose tasks.
    p.global <- task
    return nil
}

// SubmitAndWait submits a task and waits for completion.
//
// Never call this from inside a pool task. It blocks the calling
// worker until the submitted task runs, which is exactly the
// thread-starvation deadlock described later in this section.
func (p *WorkStealingPool) SubmitAndWait(ctx context.Context, task Task) error {
    done := make(chan struct{})

    err := p.Submit(func() {
        defer close(done)
        task()
    })
    if err != nil {
        return err
    }

    // A bare <-done here leaks the caller forever if the pool shuts
    // down before the task is picked up. Always give the wait an exit.
    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Shutdown stops the pool and waits for workers to drain their deques.
//
// Callers must stop submitting before calling Shutdown. A Submit racing
// this call may observe closed == false and push a task that no worker
// will ever run. Enforcing that ordering in the pool means gating every
// Submit behind a lock, on the hot path, to protect a shutdown that
// happens once. Pushing the ordering to the caller is the better trade
// here, but it must be documented rather than left as a surprise.
func (p *WorkStealingPool) Shutdown() {
    p.closed.Store(true)
    p.wg.Wait()
}

// Stats returns pool statistics. The fields are sampled independently,
// so they are individually atomic but not a consistent snapshot of one
// instant. Fine for dashboards, wrong for assertions.
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
```

### Fork-Join Pattern

Work stealing naturally supports the fork-join pattern for divide-and-conquer algorithms:

```go
// ForkJoinPool extends work stealing with fork-join support
type ForkJoinPool struct {
    *WorkStealingPool
}

// ForkJoinTask represents a task that can spawn subtasks
type ForkJoinTask[T any] struct {
    pool   *ForkJoinPool
    result atomic.Pointer[T]
    once   sync.Once
    wait   chan struct{}
}

func NewForkJoinTask[T any](pool *ForkJoinPool) *ForkJoinTask[T] {
    return &ForkJoinTask[T]{
        pool: pool,
        wait: make(chan struct{}),
    }
}

// Complete is idempotent. A bare close(t.wait) panics on the second
// call, which turns a duplicate completion, easy to reach when a task
// is retried or stolen, into a dead process. sync.Once makes the
// store-then-publish sequence happen exactly once.
func (t *ForkJoinTask[T]) Complete(result T) {
    t.once.Do(func() {
        t.result.Store(&result)
        close(t.wait) // Publishes result: close happens-before <-t.wait
    })
}

// Join blocks until Complete runs. Calling it from inside a pool task
// consumes a worker while waiting, which is the deadlock demonstrated
// immediately below. This type is safe to Join only from outside the
// pool.
func (t *ForkJoinTask[T]) Join() T {
    <-t.wait
    return *t.result.Load()
}

func (t *ForkJoinTask[T]) Fork(fn func()) error {
    // Submit fails once the pool is closed. Swallowing that error
    // silently drops the subtask and Join then blocks forever.
    return t.pool.Submit(fn)
}
```

#### The fork-join deadlock, and why the pool is the wrong host for it

The obvious way to write a parallel sum on top of the pool above is also a deadlock. It is worth seeing, because the same shape appears in real fork-join code:

```go
// BROKEN: deadlocks. Do not use.
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

    pool.Submit(func() { leftResult <- ParallelSum(pool, nums[:mid], threshold) })
    pool.Submit(func() { rightResult <- ParallelSum(pool, nums[mid:], threshold) })

    // This task now blocks, while occupying a worker, waiting on tasks
    // that need a free worker in order to run.
    return <-leftResult + <-rightResult
}
```

Run that on a four-worker pool and it hangs permanently. Every worker ends up parked in `chan receive` inside a `ParallelSum` frame, waiting for subtasks that were queued behind it, and no worker remains to execute them:

```
goroutine 6 [chan receive]:
main.ParallelSum(...)
main.(*WorkStealingPool).executeTask(...)
main.(*WorkStealingPool).worker(...)
```

This is thread-starvation deadlock, and it is the defining hazard of fork-join on a bounded pool. A task that blocks on the completion of tasks it submitted has consumed a worker and is holding it hostage. Java's `ForkJoinPool` survives this only because `join()` is not a plain block: a joining worker executes other pending tasks while it waits. Without that help-while-waiting machinery, submitting from inside a pool task and then blocking on the result is a bug, not a pattern. Note that a bigger pool does not fix it, it only raises the recursion depth at which the hang appears, which is a good way to ship a deadlock that surfaces in production and not in tests.

Go's answer is to stop bounding the workers at all. Goroutines are cheap and the runtime scheduler is *already* a work-stealing scheduler over the Ps, so a plain goroutine per fork gets real work-stealing for free and cannot starve, because there is no fixed worker to hold hostage. Bound the *parallelism* instead of the workers, and recurse inline once the machine is saturated:

```go
// Parallel sum using goroutines. The runtime scheduler already
// work-steals across Ps, so no application-level pool is needed.
var activeWorkers atomic.Int64

func ParallelSum(nums []int, threshold int) int {
    if len(nums) <= threshold {
        sum := 0
        for _, n := range nums {
            sum += n
        }
        return sum
    }

    mid := len(nums) / 2

    // Fork only while there is a core to use. Once saturated, recurse
    // inline: the work still gets done, just on this goroutine, and
    // the recursion cannot outrun the machine.
    if activeWorkers.Load() >= int64(runtime.GOMAXPROCS(0)) {
        return ParallelSum(nums[:mid], threshold) + ParallelSum(nums[mid:], threshold)
    }

    var left int
    var wg sync.WaitGroup
    wg.Add(1)
    activeWorkers.Add(1)
    go func() {
        defer wg.Done()
        defer activeWorkers.Add(-1)
        left = ParallelSum(nums[:mid], threshold)
    }()

    // Do half the work on this goroutine rather than idling in a wait.
    right := ParallelSum(nums[mid:], threshold)

    wg.Wait()
    return left + right
}
```

The inline-recursion fallback is what makes this safe. There is no depth at which it can deadlock, because a goroutine that cannot fork simply does the work itself. `wg.Wait` establishes the happens-before edge for the write to `left`, so the read after it is race-free.

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
