## 15.16 Exercises with Solutions

### Exercise 1: Implement a Lock-Free MPMC Queue

**Problem**: Implement a multiple-producer, multiple-consumer lock-free queue.

**Solution**: This implementation uses Dmitry Vyukov's bounded MPMC queue algorithm. Each slot carries a sequence number that coordinates producers and consumers without a mutex. A producer can only write to a slot whose sequence number equals the producer's claimed position. A consumer can only read from a slot whose sequence number equals the consumer's claimed position plus one. The difference (`diff`) between the sequence number and the expected value determines whether the slot is ready, full, or claimed by another goroutine.
```go
type MPMCQueue[T any] struct {
    buffer   []slot[T]
    mask     int64
    enqueue  atomic.Int64
    dequeue  atomic.Int64
}

type slot[T any] struct {
    sequence atomic.Int64
    value    T
}

func NewMPMCQueue[T any](capacity int) *MPMCQueue[T] {
    // Capacity must be power of 2
    if capacity&(capacity-1) != 0 {
        panic("capacity must be power of 2")
    }

    q := &MPMCQueue[T]{
        buffer: make([]slot[T], capacity),
        mask:   int64(capacity - 1),
    }

    for i := range q.buffer {
        q.buffer[i].sequence.Store(int64(i))
    }

    return q
}

func (q *MPMCQueue[T]) Enqueue(value T) bool {
    for {
        pos := q.enqueue.Load()
        slot := &q.buffer[pos&q.mask]
        seq := slot.sequence.Load()

        diff := seq - pos
        if diff == 0 {
            // Slot is ready for enqueue
            if q.enqueue.CompareAndSwap(pos, pos+1) {
                slot.value = value
                slot.sequence.Store(pos + 1)
                return true
            }
        } else if diff < 0 {
            // Queue is full
            return false
        }
        // Another enqueuer got there first, retry
    }
}

func (q *MPMCQueue[T]) Dequeue() (T, bool) {
    for {
        pos := q.dequeue.Load()
        slot := &q.buffer[pos&q.mask]
        seq := slot.sequence.Load()

        diff := seq - (pos + 1)
        if diff == 0 {
            // Slot has data ready
            if q.dequeue.CompareAndSwap(pos, pos+1) {
                value := slot.value
                slot.sequence.Store(pos + q.mask + 1)
                return value, true
            }
        } else if diff < 0 {
            // Queue is empty
            var zero T
            return zero, false
        }
        // Another dequeuer got there first, retry
    }
}
```

### Exercise 2: Build a Sharded Rate Limiter

**Problem**: Create a rate limiter that handles 100K requests/second with minimal contention.

**Solution**: A single token bucket under 100K requests/second would see heavy CAS contention. Sharding the rate limit across multiple independent token buckets, each responsible for `rps / numShards` requests per second, distributes the contention.

Two traps make this exercise worth doing, and both are the kind that survive code review.

**The shard selector must not itself be contended.** The tempting move is a hand-rolled "fast" PRNG, on the theory that `math/rand` takes a lock. That reasoning is a decade out of date. A hand-rolled `fastrand` built on a global `atomic.Uint64` CAS loop funnels *every* `Allow` call through one contended cache line, which is exactly the bottleneck the sharding exists to remove. It is not a micro-optimization, it is the bug. Measured across 8 goroutines:

```
hand-rolled global-CAS         79.7 ns/op
math/rand/v2 rand.Uint32        1.4 ns/op
```

Fifty-seven times slower than the standard library it was trying to avoid. `math/rand/v2`'s top-level functions read a per-thread source inside the runtime, with no lock and no shared state. Use them.

**Refill must be atomic with consumption.** Reading `lastTime`, computing the tokens owed, and then CAS-ing them into the balance is a read-compute-act sequence over two separate atomics, and two goroutines that both read the same stale `lastTime` will each add the same refill. The bucket inflates and admits more than its configured rate. A `burst` cap masks this in casual testing, which is why it survives. Rather than build an elaborate packed-CAS scheme, note that the shards have already removed the contention: a plain mutex per bucket is correct, obvious, and fast enough.
```go
type ShardedRateLimiter struct {
    limiters []*tokenBucket
    numShards int
}

type tokenBucket struct {
    // tokens and lastTime must be updated together, so one mutex guards
    // both. Two independent atomics cannot express "refill and consume
    // as one step", and pretending otherwise is how the bucket inflates.
    mu       sync.Mutex
    rate     float64
    burst    int64
    tokens   float64
    lastTime time.Time
    _        [8]byte // Pad the hot struct toward its own cache line
}

func NewShardedRateLimiter(rps int, numShards int) *ShardedRateLimiter {
    if numShards <= 0 {
        numShards = runtime.NumCPU() * 4
    }

    rpsPerShard := rps / numShards

    l := &ShardedRateLimiter{
        limiters:  make([]*tokenBucket, numShards),
        numShards: numShards,
    }

    for i := range l.limiters {
        l.limiters[i] = &tokenBucket{
            rate:     float64(rpsPerShard),
            burst:    int64(rpsPerShard),
            tokens:   float64(rpsPerShard),
            lastTime: time.Now(),
        }
    }

    return l
}

func (l *ShardedRateLimiter) Allow() bool {
    // rand.Uint32 from math/rand/v2: per-thread runtime source, no lock,
    // no shared state. Do NOT hand-roll a global-CAS PRNG here - it
    // serialises every call and defeats the sharding entirely.
    shard := int(rand.Uint32()) % l.numShards
    return l.limiters[shard].allow()
}

func (tb *tokenBucket) allow() bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    // Refill and consume are one atomic step under the lock. The elapsed
    // window is consumed exactly once because lastTime advances here and
    // nowhere else.
    now := time.Now()
    elapsed := now.Sub(tb.lastTime).Seconds()
    tb.lastTime = now

    // float64 tokens, not int64: with int64 an elapsed window too short
    // to earn a whole token truncates to zero and is lost, so a bucket
    // hit often enough never refills at all.
    tb.tokens = min(tb.tokens+elapsed*tb.rate, float64(tb.burst))

    if tb.tokens < 1 {
        return false
    }
    tb.tokens--
    return true
}
```

Note the `float64` for the token count. With an integer balance, any call arriving before a full token has accrued truncates the refill to zero, and because `lastTime` still advances, that fraction is discarded forever. Under steady high load the bucket then refills at a rate of zero and rejects everything. Accumulating fractional tokens is not pedantry, it is the difference between a rate limiter and a shutoff valve.

### Exercise 3: Implement a Work Stealing Scheduler with Priorities

**Problem**: Extend the work stealing scheduler to support task priorities.

**Solution**: Each worker maintains four deques, one per priority level, instead of a single deque. Task execution always checks the highest priority deque first, and stealing follows the same priority order across victim workers. This ensures that critical tasks preempt lower-priority work even when they arrive on a different worker's queue.

The exercise hides the trap from section 15.2, and it is worth catching before reading the answer. `WorkStealingDeque.Push` is **owner-only**: it does a load-modify-store on `bottom` with no CAS, which is sound only when a single goroutine performs it. A `Submit` that pushes straight into `worker.queues[priority]` runs `Push` on the *caller's* goroutine while the owning worker concurrently runs `Pop`, and the result is lost tasks with no race-detector warning, because every access is individually atomic. The fix mirrors the Go runtime: hand submissions to an intake channel and let each worker refill its own deques.
```go
type PriorityWorkStealer struct {
    workers []*priorityWorker
    // intake[p] is the submission queue for priority p. Submit sends
    // here - only the owning worker ever Pushes into a deque.
    intake  [4]chan Task
    wg      sync.WaitGroup
    closed  atomic.Bool
    metrics *SchedulerMetrics
}

type priorityWorker struct {
    id       int
    queues   [4]*WorkStealingDeque[Task] // One per priority
    scheduler *PriorityWorkStealer
}

func NewPriorityWorkStealer(numWorkers int) *PriorityWorkStealer {
    s := &PriorityWorkStealer{
        workers: make([]*priorityWorker, numWorkers),
        metrics: &SchedulerMetrics{},
    }
    for p := range s.intake {
        s.intake[p] = make(chan Task, 1024)
    }

    for i := 0; i < numWorkers; i++ {
        w := &priorityWorker{
            id:        i,
            scheduler: s,
        }
        for p := 0; p < 4; p++ {
            w.queues[p] = NewWorkStealingDeque[Task](1024)
        }
        s.workers[i] = w

        s.wg.Add(1)
        go w.run()
    }

    return s
}

func (w *priorityWorker) run() {
    defer w.scheduler.wg.Done()

    for !w.scheduler.closed.Load() {
        // Try own queues (highest priority first)
        if task, ok := w.getOwnTask(); ok {
            w.execute(task)
            continue
        }

        // Try stealing (highest priority first)
        if task, ok := w.steal(); ok {
            w.execute(task)
            continue
        }

        // Nothing to do
        runtime.Gosched()
    }
}

func (w *priorityWorker) getOwnTask() (Task, bool) {
    for pri := 3; pri >= 0; pri-- {
        if task, ok := w.queues[pri].Pop(); ok {
            return task, true
        }
    }

    // Nothing local. Pull from the intake queues, highest priority
    // first, into our own deque. This Push is safe precisely because
    // this goroutine owns w.queues.
    for pri := 3; pri >= 0; pri-- {
        select {
        case task := <-w.scheduler.intake[pri]:
            return task, true
        default:
        }
    }
    return Task{}, false
}

func (w *priorityWorker) steal() (Task, bool) {
    s := w.scheduler

    // Randomize victim selection
    start := int(rand.Uint32()) % len(s.workers)

    for i := 0; i < len(s.workers); i++ {
        victim := s.workers[(start+i)%len(s.workers)]
        if victim.id == w.id {
            continue
        }

        // Steal from highest priority queue first
        for pri := 3; pri >= 0; pri-- {
            if task, ok := victim.queues[pri].Steal(); ok {
                return task, true
            }
        }
    }

    return Task{}, false
}

func (w *priorityWorker) execute(task Task) {
    start := time.Now()

    // Account in the defer. Placing these after task.Fn means a
    // panicking task unwinds straight past them and the metrics
    // silently stop counting.
    defer func() {
        w.scheduler.metrics.ExecutionTime.Add(int64(time.Since(start)))
        w.scheduler.metrics.TasksCompleted.Add(1)
        if r := recover(); r != nil {
            w.scheduler.metrics.Panics.Add(1)
        }
    }()

    task.Fn(context.Background())
}

func (s *PriorityWorkStealer) Submit(task Task, priority int) error {
    // Validate: s.intake[priority] panics on an out-of-range index.
    if priority < 0 || priority > 3 {
        return fmt.Errorf("invalid priority %d", priority)
    }
    if s.closed.Load() {
        return errors.New("scheduler closed")
    }

    // Hand off to intake. Do NOT Push into worker.queues here: Push is
    // owner-only, and calling it from this goroutine races the owning
    // worker's Pop and silently loses tasks.
    select {
    case s.intake[priority] <- task:
        return nil
    default:
        return errors.New("intake queue full")
    }
}

type SchedulerMetrics struct {
    TasksCompleted atomic.Int64
    ExecutionTime  atomic.Int64
    Panics         atomic.Int64
}
```

### Staff / Principal Track

4. **Advanced-concurrency audit.** For one service, find every use of advanced techniques (lock-free structures, unsafe.Pointer, hazard pointers, custom memory ordering). For each, verify the profile evidence that justified it. Remove ones that do not pass the bar.

5. **Contention-profile workflow.** Build the team's playbook for diagnosing contention: enable `runtime.SetMutexProfileFraction`, capture profiles during load, identify the top three contentions, propose fixes. Document the workflow and train the team.

6. **Simpler-first rule.** For any PR that introduces advanced concurrency, require a documented profile comparison showing the simpler alternative is insufficient. Apply consistently for three months. Measure how many advanced-concurrency PRs were rejected or simplified.

7. **Scale-ceiling analysis.** For one high-throughput service, document the scale ceiling of its current design. Identify which primitive will bottleneck first (mutex contention, channel throughput, GC pressure). Propose the next redesign.

8. **Memory-model training.** Deliver a workshop on the Go memory model to the senior pool. Include concrete examples of code that works on x86 but would fail on ARM. Measure comprehension. This is specialist training worth a few days per year.

---
