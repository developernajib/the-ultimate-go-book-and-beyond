## 12.9 Broadcast Pattern

Signal multiple goroutines simultaneously.

### Channel-Based Broadcast

A broadcaster decouples the signaler from the recipients by maintaining a registry of per-listener channels. Closing is exactly the right mechanism here, and the reason is worth stating precisely: a close is observed by *every* receiver, whereas a send is consumed by exactly one. That is what makes close a broadcast and a send a handoff.

The limitation of close is not that it reaches only one listener. It is that it is permanent. A channel can be closed once and never reopened, so each listener channel carries exactly one broadcast. That is why `Broadcast` below closes each listener's channel and then drops it from the registry: the channel has been spent. A listener that wants the next broadcast must call `Listen` again for a fresh one. This is a deliberate design, not an oversight, and it is what keeps the implementation this short.

The `Listen` function returns an unsubscribe function so callers can deregister when they are no longer interested.

```go
// Broadcaster sends signals to multiple listeners
type Broadcaster struct {
    mu        sync.RWMutex
    listeners map[int]chan struct{}
    nextID    int
    closed    bool
}

func NewBroadcaster() *Broadcaster {
    return &Broadcaster{
        listeners: make(map[int]chan struct{}),
    }
}

// Listen returns a channel that will receive the broadcast
func (b *Broadcaster) Listen() (<-chan struct{}, func()) {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.closed {
        ch := make(chan struct{})
        close(ch)
        return ch, func() {}
    }

    id := b.nextID
    b.nextID++

    ch := make(chan struct{})
    b.listeners[id] = ch

    // Return unsubscribe function
    return ch, func() {
        b.mu.Lock()
        defer b.mu.Unlock()
        delete(b.listeners, id)
    }
}

// Broadcast signals all current listeners.
//
// Each listener channel is closed, which every receiver on it observes,
// and then discarded: a closed channel cannot signal twice. Listeners
// wanting a subsequent broadcast must call Listen again.
func (b *Broadcaster) Broadcast() {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.closed {
        return
    }

    for id, ch := range b.listeners {
        close(ch)
        delete(b.listeners, id)
    }
}

// Close permanently closes the broadcaster
func (b *Broadcaster) Close() {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.closed {
        return
    }

    b.closed = true
    for _, ch := range b.listeners {
        close(ch)
    }
    b.listeners = nil
}
```

### Resettable Event (sync.Cond)

`sync.Cond` addresses the one-shot limitation above: a closed channel wakes every reader but cannot be reopened, whereas `Broadcast` can fire repeatedly against the same waiters. `Broadcast` wakes all goroutines blocked in `Wait`, and the predicate loop is what makes each wakeup safe. The `Reset` method clears the `signaled` flag so the event can be reused for cyclic workflows like a periodic gate, a frame signal, or a synchronization barrier.

Read this section for the mechanics, then read the limitation that follows it before choosing `sync.Cond` for anything real. Cancellation is where it falls down, and cancellation is table stakes in a service.

```go
// Event provides a resettable broadcast signal
type Event struct {
    mu       sync.Mutex
    cond     *sync.Cond
    signaled bool
}

func NewEvent() *Event {
    e := &Event{}
    e.cond = sync.NewCond(&e.mu)
    return e
}

// Wait blocks until the event is signaled
func (e *Event) Wait() {
    e.mu.Lock()
    defer e.mu.Unlock()

    for !e.signaled {
        e.cond.Wait()
    }
}

// Signal wakes all waiters
func (e *Event) Signal() {
    e.mu.Lock()
    defer e.mu.Unlock()

    e.signaled = true
    e.cond.Broadcast()
}

// Reset allows the event to be signaled again
func (e *Event) Reset() {
    e.mu.Lock()
    defer e.mu.Unlock()
    e.signaled = false
}

// IsSignaled returns the current state
func (e *Event) IsSignaled() bool {
    e.mu.Lock()
    defer e.mu.Unlock()
    return e.signaled
}
```

Note the `for !e.signaled` loop in `Wait`. It must be a loop and never an `if`. `Broadcast` wakes every waiter, but a waiter only reacquires the lock some time later, and the world may have changed by then: another goroutine may have called `Reset` in between. Rechecking the predicate after every wake is what makes the wakeup safe. This is the single most important rule for `sync.Cond`, and an `if` here produces a bug that appears only under load.

#### The limitation that usually disqualifies sync.Cond

`sync.Cond` has no context support, and it cannot be given any. `Wait` blocks until `Signal` or `Broadcast` arrives, full stop: there is no deadline, no cancellation, no way to interrupt it. The tempting workaround is to push the wait into a goroutine and race it against `ctx.Done()`:

```go
// BROKEN: leaks a goroutine on every cancellation.
func (e *Event) WaitWithContext(ctx context.Context) error {
    done := make(chan struct{})
    go func() {
        e.Wait() // Nothing here can ever be cancelled.
        close(done)
    }()
    select {
    case <-ctx.Done():
        return ctx.Err() // Returns, but the goroutine is still in Wait.
    case <-done:
        return nil
    }
}
```

This compiles, passes a happy-path test, and leaks. When the context is cancelled the caller returns, but the spawned goroutine stays parked inside `cond.Wait` and is only released if someone eventually signals. If the event is never signalled, it is parked for the life of the process. Wrapping an uninterruptible primitive in a goroutine does not make it interruptible. It just relocates the block somewhere you are no longer looking.

If you need a resettable event *and* cancellation, do not use `sync.Cond`. Use a channel that you replace on reset. The generation channel gives you broadcast via close, reset via replacement, and cancellation for free, because a channel receive composes with `select` and `cond.Wait` does not.

```go
// ChanEvent is resettable and context-aware.
type ChanEvent struct {
    mu sync.Mutex
    ch chan struct{} // Closed when signaled. Replaced on Reset.
}

func NewChanEvent() *ChanEvent {
    return &ChanEvent{ch: make(chan struct{})}
}

func (e *ChanEvent) Signal() {
    e.mu.Lock()
    defer e.mu.Unlock()
    select {
    case <-e.ch: // Already closed, nothing to do.
    default:
        close(e.ch)
    }
}

// Reset swaps in a fresh channel. Waiters already released by the
// previous close stay released, which is the correct semantic.
func (e *ChanEvent) Reset() {
    e.mu.Lock()
    defer e.mu.Unlock()
    select {
    case <-e.ch:
        e.ch = make(chan struct{})
    default: // Not signaled, nothing to reset.
    }
}

func (e *ChanEvent) Wait(ctx context.Context) error {
    e.mu.Lock()
    ch := e.ch // Capture this generation before releasing the lock.
    e.mu.Unlock()

    select {
    case <-ch:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

`sync.Cond` still earns its keep where waiters are numerous, wakeups are frequent, and cancellation is not required, because it allocates nothing per wait. Outside that case, reach for the channel.

### The `close(ch)` Broadcast Idiom

The simplest broadcast in Go: close a channel. Every goroutine receiving from the channel gets the zero value and the `ok == false` signal. This is the canonical shutdown pattern:

```go
done := make(chan struct{})
// ... many goroutines doing: select { case <-done: return; ... }
close(done) // broadcasts shutdown to all
```

This is simpler than `sync.Cond` for one-shot broadcast. `sync.Cond` wins when the broadcast is repeated (signal every N events, not just once). For shutdown signaling, prefer `context.Context` and the close-channel pattern.

### Staff Lens: Broadcast Is Usually Shutdown

Most broadcast use cases in Go are really shutdown signaling: tell every goroutine to stop. `context.Context` handles this with standard semantics (cancellation, deadline, cause propagation). When you see a custom broadcast primitive, ask whether `context.Context` would do the job. Ninety percent of the time it would. The remaining ten percent (broadcasting a configuration change, a "resume" signal, a level-change notification) are the legitimate uses of `sync.Cond` or close-and-recreate patterns.

---
