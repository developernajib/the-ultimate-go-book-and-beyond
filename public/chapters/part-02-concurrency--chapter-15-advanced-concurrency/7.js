export default `## 15.6 Bounded Parallelism

Goroutines are cheap but not free. Each one consumes at least 2 KB of stack memory and adds scheduling overhead. Spawning 100,000 goroutines for CPU-bound work on an 8-core machine produces 12,500x more goroutines than can run simultaneously, wasting memory and thrashing the scheduler. Bounded parallelism limits the number of concurrent goroutines to match available resources, typically \`runtime.GOMAXPROCS(0)\` for CPU-bound work, or an externally imposed limit for I/O-bound work like database connection pools or HTTP client connections.

### Semaphore-Based Limiting

A \`BoundedExecutor\` uses a buffered channel as a counting semaphore: sending into the channel acquires a slot, receiving releases it. The send happens on the calling goroutine before the worker goroutine is launched, so \`Execute\` blocks the caller until a worker slot is available, providing backpressure to the producer without spawning an unbounded number of goroutines.

\`\`\`go
type BoundedExecutor struct {
    sem chan struct{}
    wg  sync.WaitGroup
}

func NewBoundedExecutor(limit int) *BoundedExecutor {
    return &BoundedExecutor{
        sem: make(chan struct{}, limit),
    }
}

func (e *BoundedExecutor) Execute(fn func()) {
    e.wg.Add(1)
    e.sem <- struct{}{} // Acquire

    go func() {
        defer func() {
            <-e.sem // Release
            e.wg.Done()
        }()
        fn()
    }()
}

func (e *BoundedExecutor) Wait() {
    e.wg.Wait()
}
\`\`\`

### Token Bucket with Priority

A plain semaphore treats all callers equally, but some workloads need differentiated access, for example, user-facing API requests should preempt background batch jobs for the same downstream resource. \`PriorityLimiter\` implements this by maintaining a sorted wait queue: when no token is available, the caller inserts itself at the position matching its priority level and blocks on a per-waiter channel. When a token is released, the highest-priority waiter is unblocked rather than an arbitrary one, preventing low-priority work from starving latency-sensitive requests.

\`\`\`go
type PriorityToken struct {
    priority int
    ready    chan struct{}
}

type PriorityLimiter struct {
    mu       sync.Mutex
    queue    []*PriorityToken
    tokens   int
    maxTokens int
}

func (l *PriorityLimiter) Acquire(priority int) {
    l.mu.Lock()

    if l.tokens > 0 {
        l.tokens--
        l.mu.Unlock()
        return
    }

    token := &PriorityToken{
        priority: priority,
        ready:    make(chan struct{}),
    }

    // Insert by priority (higher = first)
    pos := 0
    for pos < len(l.queue) && l.queue[pos].priority >= priority {
        pos++
    }
    l.queue = append(l.queue[:pos], append([]*PriorityToken{token}, l.queue[pos:]...)...)

    l.mu.Unlock()
    <-token.ready
}

func (l *PriorityLimiter) Release() {
    l.mu.Lock()
    defer l.mu.Unlock()

    if len(l.queue) > 0 {
        token := l.queue[0]
        l.queue = l.queue[1:]
        close(token.ready)
    } else {
        l.tokens++
    }
}
\`\`\`

### Prefer golang.org/x/sync/semaphore

For most bounded-parallelism needs, \`golang.org/x/sync/semaphore.Weighted\` is the right primitive. It supports weighted acquisition (useful when different tasks have different resource costs), context cancellation, and has been battle-tested at scale. Hand-rolling a semaphore is teaching material; production code uses the library.

### Staff Lens: Every Fan-Out Has a Bound

The single most important bounded-parallelism rule in production Go: every \`for _, x := range items { go fn(x) }\` must have a concurrency bound. Unbounded fan-out on a slow downstream is a goroutine leak waiting to happen. The review question: "what bounds the concurrency here?" If the answer is "nothing", reject the PR.

---
`;
