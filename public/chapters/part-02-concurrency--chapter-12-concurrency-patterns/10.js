export default `## 12.9 Broadcast Pattern

Signal multiple goroutines simultaneously.

### Channel-Based Broadcast

A broadcaster decouples the signaler from the recipients by maintaining a registry of per-listener channels. Closing the broadcaster's signal channel is not viable for multiple listeners because a close can only happen once. Instead, the broadcaster iterates over all registered listener channels and sends a signal to each. The \`Listen\` function returns an unsubscribe function so callers can deregister when they are no longer interested.

\`\`\`go
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

// Broadcast sends a signal to all listeners
func (b *Broadcaster) Broadcast() {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.closed {
        return
    }

    // Close all channels (broadcasts the signal)
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
\`\`\`

### Resettable Event (sync.Cond)

\`sync.Cond\` solves a specific problem that channels cannot: broadcasting to an unbounded number of waiters that need to re-block after the signal fires. A closed channel wakes all readers but cannot be reopened, making it one-shot. \`sync.Cond.Broadcast\` wakes all goroutines blocked in \`Wait\` and the predicate loop guards against spurious wakeups without consuming the signal. The \`Reset\` method clears the \`signaled\` flag so the event can be reused for cyclic workflows like a periodic gate, render frame signal, or worker pool synchronization barrier.

\`\`\`go
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

// WaitWithContext waits with context support
func (e *Event) WaitWithContext(ctx context.Context) error {
    done := make(chan struct{})

    go func() {
        e.Wait()
        close(done)
    }()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-done:
        return nil
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
\`\`\`

### The \`close(ch)\` Broadcast Idiom

The simplest broadcast in Go: close a channel. Every goroutine receiving from the channel gets the zero value and the \`ok == false\` signal. This is the canonical shutdown pattern:

\`\`\`go
done := make(chan struct{})
// ... many goroutines doing: select { case <-done: return; ... }
close(done) // broadcasts shutdown to all
\`\`\`

This is simpler than \`sync.Cond\` for one-shot broadcast. \`sync.Cond\` wins when the broadcast is repeated (signal every N events, not just once). For shutdown signalling, prefer \`context.Context\` and the close-channel pattern.

### Staff Lens: Broadcast Is Usually Shutdown

Most broadcast use cases in Go are really shutdown signalling: tell every goroutine to stop. \`context.Context\` handles this with standard semantics (cancellation, deadline, cause propagation). When you see a custom broadcast primitive, ask whether \`context.Context\` would do the job. Ninety percent of the time it would. The remaining ten percent (broadcasting a configuration change, a "resume" signal, a level-change notification) are the legitimate uses of \`sync.Cond\` or close-and-recreate patterns.

---
`;
