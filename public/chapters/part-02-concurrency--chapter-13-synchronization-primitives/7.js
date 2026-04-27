export default `## 13.6 Cond: Condition Variables

\`sync.Cond\` provides a way for goroutines to wait for or announce an event.

### Basic Producer-Consumer

A bounded queue requires two conditions: \`notFull\` (producers must wait when the queue is at capacity) and \`notEmpty\` (consumers must wait when the queue has nothing to dequeue). Each \`Wait\` call atomically releases the mutex and suspends the goroutine, reacquiring the lock before returning, which is why the condition check must be in a \`for\` loop rather than an \`if\` to guard against spurious wakeups.

\`\`\`go
type BoundedQueue struct {
    mu       sync.Mutex
    notEmpty *sync.Cond
    notFull  *sync.Cond
    items    []any
    capacity int
}

func NewBoundedQueue(capacity int) *BoundedQueue {
    q := &BoundedQueue{
        items:    make([]any, 0, capacity),
        capacity: capacity,
    }
    q.notEmpty = sync.NewCond(&q.mu)
    q.notFull = sync.NewCond(&q.mu)
    return q
}

func (q *BoundedQueue) Enqueue(item any) {
    q.mu.Lock()
    defer q.mu.Unlock()

    // Wait while queue is full
    for len(q.items) == q.capacity {
        q.notFull.Wait()  // Releases lock while waiting
    }

    q.items = append(q.items, item)
    q.notEmpty.Signal()  // Wake one consumer
}

func (q *BoundedQueue) Dequeue() any {
    q.mu.Lock()
    defer q.mu.Unlock()

    // Wait while queue is empty
    for len(q.items) == 0 {
        q.notEmpty.Wait()  // Releases lock while waiting
    }

    item := q.items[0]
    q.items = q.items[1:]
    q.notFull.Signal()  // Wake one producer

    return item
}

// Size returns current queue size (for monitoring)
func (q *BoundedQueue) Size() int {
    q.mu.Lock()
    defer q.mu.Unlock()
    return len(q.items)
}
\`\`\`

### Barrier Pattern with Broadcast

A barrier is a synchronization point where every goroutine must arrive before any of them can continue. The \`cycle\` counter distinguishes consecutive barrier phases so that a goroutine woken after a \`Broadcast\` does not immediately fall back into waiting on the very next cycle's barrier.

\`\`\`go
// Barrier blocks goroutines until all have arrived
type Barrier struct {
    mu      sync.Mutex
    cond    *sync.Cond
    count   int
    waiting int
    cycle   int
}

func NewBarrier(count int) *Barrier {
    b := &Barrier{count: count}
    b.cond = sync.NewCond(&b.mu)
    return b
}

func (b *Barrier) Wait() {
    b.mu.Lock()
    defer b.mu.Unlock()

    cycle := b.cycle
    b.waiting++

    if b.waiting == b.count {
        // Last arrival - wake everyone
        b.waiting = 0
        b.cycle++
        b.cond.Broadcast()
    } else {
        // Wait for others
        for cycle == b.cycle {
            b.cond.Wait()
        }
    }
}

// Usage: Parallel computation phases
func parallelComputation(data [][]float64, workers int) {
    barrier := NewBarrier(workers)
    var wg sync.WaitGroup

    chunkSize := len(data) / workers

    for w := 0; w < workers; w++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()

            start := workerID * chunkSize
            end := start + chunkSize
            chunk := data[start:end]

            // Phase 1: Local computation
            localCompute(chunk)
            barrier.Wait()  // Sync point

            // Phase 2: Exchange with neighbors
            exchangeData(chunk, workerID)
            barrier.Wait()  // Sync point

            // Phase 3: Final computation
            finalCompute(chunk)
        }(w)
    }

    wg.Wait()
}
\`\`\`

### Shutdown Coordination

Graceful shutdown requires the server to signal all workers to stop and then wait until every worker has fully exited before returning. The \`Broadcast\` inside each worker's deferred cleanup wakes the shutdown waiter, which re-checks the \`workers\` count inside a loop, ensuring it only proceeds when the count has truly reached zero.

\`\`\`go
type Server struct {
    mu        sync.Mutex
    cond      *sync.Cond
    running   bool
    workers   int
}

func NewServer() *Server {
    s := &Server{running: true}
    s.cond = sync.NewCond(&s.mu)
    return s
}

func (s *Server) StartWorker() {
    s.mu.Lock()
    s.workers++
    s.mu.Unlock()

    defer func() {
        s.mu.Lock()
        s.workers--
        s.cond.Broadcast()  // Notify shutdown waiter
        s.mu.Unlock()
    }()

    for {
        s.mu.Lock()
        running := s.running
        s.mu.Unlock()

        if !running {
            return
        }

        doWork()
    }
}

func (s *Server) Shutdown(ctx context.Context) error {
    s.mu.Lock()
    s.running = false
    s.mu.Unlock()

    // Wait for all workers with timeout
    done := make(chan struct{})
    go func() {
        s.mu.Lock()
        for s.workers > 0 {
            s.cond.Wait()
        }
        s.mu.Unlock()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
\`\`\`

### When to Use Cond vs Channels

\`sync.Cond\` is best when multiple goroutines must all react to a single state change via \`Broadcast\`, or when the condition depends on shared mutable state that already requires a mutex. Channels are a simpler and more idiomatic choice for most signaling and data-passing needs, and they compose naturally with \`select\` for timeouts and cancellation.

\`\`\`go
/*
Use sync.Cond when:
1. Multiple goroutines wait for same condition
2. Need Broadcast to wake all waiters
3. Condition involves complex state
4. Classic producer-consumer with bounded buffer

Use channels when:
1. Simple signaling (close channel)
2. Passing data between goroutines
3. One-to-one communication
4. Select with timeout needed
*/

// Channel-based queue (simpler for most cases)
type ChannelQueue struct {
    ch chan any
}

func NewChannelQueue(capacity int) *ChannelQueue {
    return &ChannelQueue{
        ch: make(chan any, capacity),
    }
}

func (q *ChannelQueue) Enqueue(item any) {
    q.ch <- item  // Blocks if full
}

func (q *ChannelQueue) Dequeue() any {
    return <-q.ch  // Blocks if empty
}

func (q *ChannelQueue) DequeueWithTimeout(d time.Duration) (any, bool) {
    select {
    case item := <-q.ch:
        return item, true
    case <-time.After(d):
        return nil, false
    }
}
\`\`\`

### When to Actually Use sync.Cond

\`sync.Cond\` is the lowest-level synchronization primitive in the \`sync\` package, and also the most easily misused. Channels handle most wait-for-condition patterns more clearly, with fewer edge cases. The narrow cases where \`sync.Cond\` wins:

1. **The wait condition depends on many variables.** "Buffer has at least N items AND priority X is first". Channels can model this but awkwardly.
2. **Multiple goroutines must be woken at once for a shared state change.** \`Broadcast()\` does this atomically. Simulating it with channels requires close-and-recreate.
3. **Performance-critical code where the channel allocation matters.** \`sync.Cond\` avoids allocation; channels do not.

For general coordination, prefer channels. For "is this state ready?", prefer \`sync.Once\` or a channel closed when ready. For simple producer-consumer queues, prefer channels.

### sync.Cond Pitfalls

1. **Missed signal.** If the signal is sent before the waiter calls \`Wait\`, the signal is lost. Always check the condition before waiting, and re-check after waking.
2. **No spurious wakeups in Go's Cond.** Unlike pthread condvars, Go's \`sync.Cond\` does not produce spurious wakeups. But you still must check the condition after waking because another goroutine might have consumed the condition.
3. **Forgetting to hold the lock during Wait.** \`Wait\` atomically releases the lock and blocks. Calling Wait without the lock held is a bug.

### Staff Lens: sync.Cond Is Almost Always the Wrong Answer

A review finding to raise: \`sync.Cond\` in new code requires justification. The Go community has moved toward channels for coordination because channels encode the synchronization in the type system and produce clearer stack traces when stuck. \`sync.Cond\` is correct for a handful of specialised cases and wrong for the rest. Default to channels. Reach for \`sync.Cond\` only when the channel version is demonstrably worse.

---
`;
