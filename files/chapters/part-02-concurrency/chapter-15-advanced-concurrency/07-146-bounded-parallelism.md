## 15.6 Bounded Parallelism

Goroutines are cheap but not free. Each one consumes at least 2 KB of stack memory and adds scheduling overhead. Spawning 100,000 goroutines for CPU-bound work on an 8-core machine produces 12,500x more goroutines than can run simultaneously, wasting memory and thrashing the scheduler. Bounded parallelism limits the number of concurrent goroutines to match available resources, typically `runtime.GOMAXPROCS(0)` for CPU-bound work, or an externally imposed limit for I/O-bound work like database connection pools or HTTP client connections.

### Semaphore-Based Limiting

A `BoundedExecutor` uses a buffered channel as a counting semaphore: sending into the channel acquires a slot, receiving releases it. The send happens on the calling goroutine before the worker goroutine is launched, so `Execute` blocks the caller until a worker slot is available, providing backpressure to the producer without spawning an unbounded number of goroutines.

The ordering of those two lines is the whole point, and it is the detail people get wrong. Acquiring *inside* the new goroutine, `go func() { e.sem <- struct{}{}; ... }()`, still bounds how many tasks run at once but bounds nothing about how many goroutines exist: the caller never blocks, so a million-item loop creates a million goroutines that all queue on the channel. That is the difference between bounded parallelism and a memory leak with a speed limit.

Two limits worth knowing. `fn` runs unguarded, so a panic in any task takes the process down with it. `Execute` also cannot be cancelled: once the caller blocks on the send it stays blocked until a slot frees. Both are addressed by `semaphore.Weighted` and `errgroup`, discussed below.

```go
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
```

### Token Bucket with Priority

A plain semaphore treats all callers equally, but some workloads need differentiated access, for example, user-facing API requests should preempt background batch jobs for the same downstream resource. `PriorityLimiter` implements this by maintaining a sorted wait queue: when no token is available, the caller inserts itself at the position matching its priority level and blocks on a per-waiter channel. When a token is released, the highest-priority waiter is unblocked rather than an arbitrary one.

Three requirements shape this code, and skipping any of them produces something that looks right and hangs.

The limiter needs a **constructor**. A zero-value `PriorityLimiter` starts with `tokens == 0` and an empty queue, so the very first `Acquire` queues itself and waits for a `Release` that no one will ever call. There is no useful zero value here, so the type must not appear to have one.

`Acquire` needs **context**. A bare `<-token.ready` cannot be abandoned: a caller whose request has already timed out is stuck holding a goroutine until a token arrives, which on a saturated limiter may be never. Adding `ctx` also forces you to handle the case the naive version hides, namely a cancellation that races a handoff. If `Release` has already closed our `ready` channel, we *own* a token, and returning an error without giving it back leaks a permit permanently, shrinking the limiter's capacity by one every time it happens.

`Release` needs a **ceiling**. Handing back more tokens than were issued silently raises `maxTokens`, which is exactly the bug that makes a limiter stop limiting.

```go
type PriorityToken struct {
    priority int
    ready    chan struct{}
}

type PriorityLimiter struct {
    mu        sync.Mutex
    queue     []*PriorityToken
    tokens    int
    maxTokens int
}

// NewPriorityLimiter is mandatory: the zero value deadlocks on first use.
func NewPriorityLimiter(maxTokens int) *PriorityLimiter {
    if maxTokens <= 0 {
        panic("limiter: maxTokens must be > 0")
    }
    return &PriorityLimiter{tokens: maxTokens, maxTokens: maxTokens}
}

func (l *PriorityLimiter) Acquire(ctx context.Context, priority int) error {
    l.mu.Lock()

    if l.tokens > 0 {
        l.tokens--
        l.mu.Unlock()
        return nil
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

    select {
    case <-token.ready:
        return nil

    case <-ctx.Done():
        // Try to withdraw from the queue.
        l.mu.Lock()
        for i, t := range l.queue {
            if t == token {
                l.queue = append(l.queue[:i], l.queue[i+1:]...)
                l.mu.Unlock()
                return ctx.Err()
            }
        }
        l.mu.Unlock()

        // We are not in the queue, so Release already dequeued us and a
        // token is being handed over right now. We own it. Take delivery
        // and hand it straight back, otherwise the permit is gone for
        // good and the limiter permanently loses capacity.
        <-token.ready
        l.Release()
        return ctx.Err()
    }
}

func (l *PriorityLimiter) Release() {
    l.mu.Lock()
    defer l.mu.Unlock()

    if len(l.queue) > 0 {
        // Direct handoff: transfer the permit to the waiter without
        // ever incrementing tokens, so it cannot be stolen in between.
        token := l.queue[0]
        l.queue = l.queue[1:]
        close(token.ready)
        return
    }

    // Never exceed the ceiling. An over-eager or duplicated Release
    // would otherwise widen the limit it exists to enforce.
    if l.tokens < l.maxTokens {
        l.tokens++
    }
}
```

Verify the ordering rather than trusting it. With one token held and waiters queued at priorities 1, 5, and 3, the service order must be 5, 3, 1, a cancelled `Acquire` must leave the queue empty, and surplus `Release` calls must not push `tokens` past `maxTokens`.

The obvious caveat: strict priority means **low-priority starvation**. Sustained high-priority load starves priority 0 indefinitely, because nothing ever ages a waiter upward. That is the intended behaviour when shedding batch work protects user-facing latency, and it is a serious bug when the starved work is a checkpoint that must eventually run. If the low-priority work must make progress, add aging (raise a waiter's effective priority with wait time) or reserve a token that only low-priority callers may take.

### Prefer golang.org/x/sync/semaphore

For most bounded-parallelism needs, `golang.org/x/sync/semaphore.Weighted` is the right primitive. It supports weighted acquisition (useful when different tasks have different resource costs), context cancellation, and has been battle-tested at scale. Hand-rolling a semaphore is teaching material. Production code uses the library.

### Staff Lens: Every Fan-Out Has a Bound

The single most important bounded-parallelism rule in production Go: every `for _, x := range items { go fn(x) }` must have a concurrency bound. Unbounded fan-out on a slow downstream is a goroutine leak waiting to happen. The review question: "what bounds the concurrency here?" If the answer is "nothing", reject the PR.

---
