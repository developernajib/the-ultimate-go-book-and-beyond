export default `## 15.16 Exercises with Solutions

### Exercise 1: Implement a Lock-Free MPMC Queue

**Problem**: Implement a multiple-producer, multiple-consumer lock-free queue.

**Solution**: This implementation uses Dmitry Vyukov's bounded MPMC queue algorithm. Each slot carries a sequence number that coordinates producers and consumers without a mutex. A producer can only write to a slot whose sequence number equals the producer's claimed position. A consumer can only read from a slot whose sequence number equals the consumer's claimed position plus one. The difference (\`diff\`) between the sequence number and the expected value determines whether the slot is ready, full, or claimed by another goroutine.
\`\`\`go
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
\`\`\`

### Exercise 2: Build a Sharded Rate Limiter

**Problem**: Create a rate limiter that handles 100K requests/second with minimal contention.

**Solution**: A single token bucket under 100K requests/second would see heavy CAS contention. Sharding the rate limit across multiple independent token buckets, each responsible for \`rps / numShards\` requests per second, distributes the contention. A fast pseudorandom number generator selects the shard, avoiding the overhead of \`math/rand\` synchronization.
\`\`\`go
type ShardedRateLimiter struct {
    limiters []*tokenBucket
    numShards int
}

type tokenBucket struct {
    rate     float64
    burst    int64
    tokens   atomic.Int64
    lastTime atomic.Int64
    _        [32]byte // Padding
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
            rate:  float64(rpsPerShard),
            burst: int64(rpsPerShard),
        }
        l.limiters[i].tokens.Store(int64(rpsPerShard))
        l.limiters[i].lastTime.Store(time.Now().UnixNano())
    }

    return l
}

func (l *ShardedRateLimiter) Allow() bool {
    // Use cheap hash for shard selection
    shard := int(fastrand()) % l.numShards
    return l.limiters[shard].allow()
}

func (tb *tokenBucket) allow() bool {
    now := time.Now().UnixNano()
    last := tb.lastTime.Load()

    // Calculate tokens to add
    elapsed := float64(now-last) / float64(time.Second)
    tokensToAdd := int64(elapsed * tb.rate)

    for {
        current := tb.tokens.Load()
        newTokens := min(current+tokensToAdd, tb.burst)

        if newTokens < 1 {
            return false
        }

        if tb.tokens.CompareAndSwap(current, newTokens-1) {
            tb.lastTime.Store(now)
            return true
        }
    }
}

// Fast random number generator
var randState atomic.Uint64

func fastrand() uint64 {
    for {
        old := randState.Load()
        new := old*6364136223846793005 + 1442695040888963407
        if randState.CompareAndSwap(old, new) {
            return new
        }
    }
}
\`\`\`

### Exercise 3: Implement a Work Stealing Scheduler with Priorities

**Problem**: Extend the work stealing scheduler to support task priorities.

**Solution**: Each worker maintains four deques, one per priority level, instead of a single deque. Task execution always checks the highest priority deque first, and stealing follows the same priority order across victim workers. This ensures that critical tasks preempt lower-priority work even when they arrive on a different worker's queue.
\`\`\`go
type PriorityWorkStealer struct {
    workers  []*priorityWorker
    wg       sync.WaitGroup
    closed   atomic.Bool
    metrics  *SchedulerMetrics
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
    return Task{}, false
}

func (w *priorityWorker) steal() (Task, bool) {
    s := w.scheduler

    // Randomize victim selection
    start := int(fastrand()) % len(s.workers)

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
    defer func() {
        if r := recover(); r != nil {
            w.scheduler.metrics.Panics.Add(1)
        }
    }()

    start := time.Now()
    task.Fn(context.Background())
    w.scheduler.metrics.ExecutionTime.Add(int64(time.Since(start)))
    w.scheduler.metrics.TasksCompleted.Add(1)
}

func (s *PriorityWorkStealer) Submit(task Task, priority int) {
    // Round-robin worker selection
    worker := s.workers[int(fastrand())%len(s.workers)]
    worker.queues[priority].Push(task)
}

type SchedulerMetrics struct {
    TasksCompleted atomic.Int64
    ExecutionTime  atomic.Int64
    Panics         atomic.Int64
}
\`\`\`

### Staff / Principal Track

4. **Advanced-concurrency audit.** For one service, find every use of advanced techniques (lock-free structures, unsafe.Pointer, hazard pointers, custom memory ordering). For each, verify the profile evidence that justified it. Remove ones that do not pass the bar.

5. **Contention-profile workflow.** Build the team's playbook for diagnosing contention: enable \`runtime.SetMutexProfileFraction\`, capture profiles during load, identify the top three contentions, propose fixes. Document the workflow and train the team.

6. **Simpler-first rule.** For any PR that introduces advanced concurrency, require a documented profile comparison showing the simpler alternative is insufficient. Apply consistently for three months. Measure how many advanced-concurrency PRs were rejected or simplified.

7. **Scale-ceiling analysis.** For one high-throughput service, document the scale ceiling of its current design. Identify which primitive will bottleneck first (mutex contention, channel throughput, GC pressure). Propose the next redesign.

8. **Memory-model training.** Deliver a workshop on the Go memory model to the senior pool. Include concrete examples of code that works on x86 but would fail on ARM. Measure comprehension. This is specialist training worth a few days per year.

---
`;
