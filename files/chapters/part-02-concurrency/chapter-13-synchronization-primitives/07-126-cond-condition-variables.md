## 13.6 Cond: Condition Variables

`sync.Cond` provides a way for goroutines to wait for or announce an event.

### Basic Producer-Consumer

A bounded queue requires two conditions: `notFull` (producers must wait when the queue is at capacity) and `notEmpty` (consumers must wait when the queue has nothing to dequeue). Each `Wait` call atomically releases the mutex and suspends the goroutine, reacquiring the lock before returning.

The condition check must be in a `for` loop, never an `if`. The reason is not spurious wakeups, because Go's `sync.Cond` does not produce them. The reason is that `Wait` does not reacquire the lock at the instant it is signalled. Between the `Signal` and the moment the woken goroutine actually holds the mutex again, any other goroutine can acquire the lock and invalidate the condition. A consumer woken for an item can find that a different consumer already took it. The signal tells you "the state may have changed", not "the state you want is now true", so you re-check and go back to waiting if you lost the race.

```go
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
```

### Barrier Pattern with Broadcast

A barrier is a synchronization point where every goroutine must arrive before any of them can continue. The `cycle` counter distinguishes consecutive barrier phases so that a goroutine woken after a `Broadcast` does not immediately fall back into waiting on the very next cycle's barrier.

```go
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
            if workerID == workers-1 {
                end = len(data) // last worker absorbs the remainder
            }
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
```

### Shutdown Coordination

Graceful shutdown requires the server to signal all workers to stop and then wait until every worker has fully exited before returning. The `Broadcast` inside each worker's deferred cleanup wakes the shutdown waiter, which re-checks the `workers` count inside a loop, ensuring it only proceeds when the count has truly reached zero.

This example also exposes the single hardest limitation of `sync.Cond`, so read the `Shutdown` method carefully. **`Cond.Wait` cannot be cancelled.** There is no `WaitContext`, no deadline, no way to interrupt it. A goroutine parked in `Wait` wakes only when someone calls `Signal` or `Broadcast` on that exact `Cond`. This is why the timeout is bolted on from the outside: `Shutdown` pushes the uncancellable wait into a helper goroutine and races it against `ctx.Done()` with a `select`.

Be honest about what that buys and what it costs. `Shutdown` gains a deadline, so a hung worker cannot block shutdown forever. The helper goroutine does not: when the context expires, `Shutdown` returns `ctx.Err()` and the helper stays parked in `Wait`. It exits later if the workers eventually drain, and never if they do not. The timeout is on the caller, not on the wait. That leaked goroutine is acceptable here because it holds no lock while parked and it is bounded by one per `Shutdown` call, but the pattern does not generalize. If you find yourself writing a `WaitWithContext` helper around `sync.Cond` that gets called on a hot path, every timed-out call leaks a goroutine permanently, and you should be using a channel instead. A channel closed when the condition becomes true is selectable, and `select` is the only cancellation mechanism in Go that actually composes.

```go
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

    // Wait for all workers with a timeout.
    //
    // Cond.Wait is uninterruptible, so the wait must live in its own
    // goroutine and be raced against ctx.Done(). If ctx expires first,
    // THIS GOROUTINE STAYS PARKED until the workers finally drain.
    // The deadline protects Shutdown's caller, not the waiter.
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
```

### When to Use Cond vs Channels

`sync.Cond` is best when multiple goroutines must all react to a single state change via `Broadcast`, or when the condition depends on shared mutable state that already requires a mutex. Channels are a simpler and more idiomatic choice for most signaling and data-passing needs, and they compose naturally with `select` for timeouts and cancellation.

```go
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
```

### When to Actually Use sync.Cond

`sync.Cond` is the lowest-level synchronization primitive in the `sync` package, and also the most easily misused. Channels handle most wait-for-condition patterns more clearly, with fewer edge cases. The narrow cases where `sync.Cond` wins:

1. **The wait condition depends on many variables.** "Buffer has at least N items AND priority X is first". Channels can model this but awkwardly.
2. **Multiple goroutines must be woken at once for a shared state change.** `Broadcast()` does this atomically. Simulating it with channels requires close-and-recreate.
3. **Waking many waiters repeatedly.** `Broadcast` wakes every waiter on an existing `Cond`. The channel equivalent of a repeatable broadcast is close-and-recreate, which means allocating a fresh channel per round and publishing it safely to everyone still reading the old one. `Cond` does it without that dance.

Note what is *not* on this list: raw speed. `sync.NewCond` allocates once, exactly like `make(chan struct{})`, and neither allocates per operation afterward. Choosing `Cond` over a channel to save allocations is not a real argument. Choose it for `Broadcast` semantics and multi-variable predicates, or do not choose it.

For general coordination, prefer channels. For "is this state ready?", prefer `sync.Once` or a channel closed when ready. For simple producer-consumer queues, prefer channels.

### sync.Cond Pitfalls

1. **Missed signal.** `Signal` and `Broadcast` are not sticky. A signal sent while no goroutine is parked in `Wait` is dropped, not queued. This is why you check the condition under the lock *before* calling `Wait`: if the state is already what you want, you never park, so there is no signal to miss. Code that calls `Wait` unconditionally can sleep forever waiting for a wakeup that already happened.
2. **No spurious wakeups in Go's Cond.** Unlike pthread condvars, Go's `sync.Cond` does not produce spurious wakeups. You must still re-check the condition in a `for` loop after waking, because `Wait` reacquires the lock some time after the signal and another goroutine can consume the condition in that window.
3. **Forgetting to hold the lock during Wait.** `Wait` atomically releases the lock and blocks. Calling `Wait` without the lock held is a bug, and it panics on the internal unlock of an unlocked mutex.
4. **Expecting `Wait` to respect a context or a deadline.** It does not, and there is no variant that does. Any timeout you attach is a race between an outer `select` and an inner wait that keeps waiting regardless of the outcome. Every timed-out call leaves a goroutine parked until the condition eventually becomes true, which for a condition that never becomes true means forever. If your waiters need cancellation, the answer is a channel, not a `Cond`.
5. **Signal when you needed Broadcast.** `Signal` wakes one arbitrary waiter. If waiters are parked on the same `Cond` for different reasons, `Signal` can wake one whose predicate is still false. That goroutine re-checks, goes back to sleep, and the wakeup is consumed. The goroutine that could have made progress is still asleep. Either give each condition its own `Cond` (as `BoundedQueue` does with `notEmpty` and `notFull`) or use `Broadcast`.

### Staff Lens: sync.Cond Is Almost Always the Wrong Answer

A review finding to raise: `sync.Cond` in new code requires justification. The Go community has moved toward channels for coordination because channels encode the synchronization in the type system and produce clearer stack traces when stuck. `sync.Cond` is correct for a handful of specialized cases and wrong for the rest. Default to channels. Reach for `sync.Cond` only when the channel version is demonstrably worse.

---
