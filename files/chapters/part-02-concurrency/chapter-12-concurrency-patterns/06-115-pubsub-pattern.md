## 12.5 Pub/Sub Pattern

Publish messages to multiple subscribers.

### Type-Safe Pub/Sub

A generic pub/sub implementation eliminates the `any` type assertions required by older pattern implementations. Each subscription holds a buffered channel and an optional filter function. The publisher delivers to all subscribers on a topic but skips those whose filter rejects the payload, providing topic-level fan-out with subscriber-level selectivity in a single pass.

```go
// Message represents a pub/sub message
type Message[T any] struct {
    Topic     string
    Payload   T
    Timestamp time.Time
    ID        string
}

// generateID mints a unique ID for messages and subscriptions
// (import "uuid", the standard library package since Go 1.27).
func generateID() string {
    return uuid.New().String()
}

// Subscription represents a subscriber.
//
// The channel's lifetime is guarded by the subscription's own RWMutex
// rather than an atomic flag. An atomic is not sufficient here: a
// checked-then-send sequence has a window in which the channel is
// closed between the check and the send, and a send on a closed channel
// is an unrecoverable panic. Holding the read lock across the whole send
// closes that window, because close() must take the write lock.
type Subscription[T any] struct {
    id     string
    topic  string
    ch     chan Message[T]
    filter func(T) bool

    mu     sync.RWMutex
    closed bool
}

// trySend delivers without blocking. Reports false if the subscriber is
// closed or its buffer is full.
func (s *Subscription[T]) trySend(msg Message[T]) bool {
    s.mu.RLock()
    defer s.mu.RUnlock()

    if s.closed {
        return false
    }
    select {
    case s.ch <- msg:
        return true
    default:
        return false
    }
}

// sendWait blocks until the message is accepted, the timeout elapses, or
// the context is cancelled. The read lock is held throughout, so a
// concurrent close cannot land mid-send. It therefore delays close by at
// most `wait`, which is a deliberate trade of liveness for the
// impossibility of a panic.
func (s *Subscription[T]) sendWait(ctx context.Context, msg Message[T], wait time.Duration) bool {
    s.mu.RLock()
    defer s.mu.RUnlock()

    if s.closed {
        return false
    }

    timer := time.NewTimer(wait)
    defer timer.Stop()

    select {
    case s.ch <- msg:
        return true
    case <-ctx.Done():
        return false
    case <-timer.C:
        return false
    }
}

// close is idempotent. Closing an already-closed channel panics, so the
// flag is checked and set under the same write lock that does the close.
func (s *Subscription[T]) close() {
    s.mu.Lock()
    defer s.mu.Unlock()

    if !s.closed {
        s.closed = true
        close(s.ch)
    }
}

func (s *Subscription[T]) isClosed() bool {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return s.closed
}

// PubSub is a generic publish/subscribe system
type PubSub[T any] struct {
    mu            sync.RWMutex
    subscriptions map[string][]*Subscription[T]
    closed        bool
    bufferSize    int
}

// NewPubSub creates a new pub/sub system
func NewPubSub[T any](bufferSize int) *PubSub[T] {
    return &PubSub[T]{
        subscriptions: make(map[string][]*Subscription[T]),
        bufferSize:    bufferSize,
    }
}

// Subscribe creates a subscription to a topic
func (ps *PubSub[T]) Subscribe(topic string, filter func(T) bool) *Subscription[T] {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    if ps.closed {
        return nil
    }

    sub := &Subscription[T]{
        id:     generateID(),
        topic:  topic,
        ch:     make(chan Message[T], ps.bufferSize),
        filter: filter,
    }

    ps.subscriptions[topic] = append(ps.subscriptions[topic], sub)
    return sub
}

// SubscribePattern registers a subscription under a pattern string.
//
// Be aware that this is a stub, not a working wildcard subscription.
// It stores the pattern as a literal map key, so Publish("events.click")
// will not reach a subscriber registered for "events.*": Publish looks
// up an exact key. Making this real means Publish walking the pattern
// subscriptions and matching each one, which turns every publish from a
// map lookup into a scan. That cost is exactly why brokers index topics
// as trees rather than strings.
func (ps *PubSub[T]) SubscribePattern(pattern string) *Subscription[T] {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    if ps.closed {
        return nil
    }

    sub := &Subscription[T]{
        id:    generateID(),
        topic: pattern,
        ch:    make(chan Message[T], ps.bufferSize),
    }

    ps.subscriptions[pattern] = append(ps.subscriptions[pattern], sub)
    return sub
}

// Publish sends a message to all subscribers
func (ps *PubSub[T]) Publish(topic string, payload T) error {
    ps.mu.RLock()
    defer ps.mu.RUnlock()

    if ps.closed {
        return errors.New("pubsub closed")
    }

    msg := Message[T]{
        Topic:     topic,
        Payload:   payload,
        Timestamp: time.Now(),
        ID:        generateID(),
    }

    subs := ps.subscriptions[topic]
    for _, sub := range subs {
        // Apply filter
        if sub.filter != nil && !sub.filter(payload) {
            continue
        }

        // trySend handles the closed check and the send atomically.
        // A slow or closed subscriber drops the message rather than
        // stalling the publisher.
        sub.trySend(msg)
    }

    return nil
}

// Unsubscribe removes a subscription. Safe to call more than once.
func (ps *PubSub[T]) Unsubscribe(sub *Subscription[T]) {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    sub.close() // Idempotent: a second Unsubscribe will not double-close.

    subs := ps.subscriptions[sub.topic]
    for i, s := range subs {
        if s.id == sub.id {
            ps.subscriptions[sub.topic] = append(subs[:i], subs[i+1:]...)
            break
        }
    }
}

// Messages returns the channel to receive messages
func (s *Subscription[T]) Messages() <-chan Message[T] {
    return s.ch
}

// Close closes the pub/sub system
func (ps *PubSub[T]) Close() {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    ps.closed = true

    for _, subs := range ps.subscriptions {
        for _, sub := range subs {
            sub.close()
        }
    }
}
```

### Pub/Sub with Dead Letter Queue

When a subscriber's channel buffer is full, a non-blocking send silently drops the message, acceptable for best-effort delivery but catastrophic for financial events or audit logs. The reliable variant retries delivery up to `maxRetries` times with a configurable delay per subscriber, and only after exhausting all attempts does it route the message to the dead letter queue (DLQ). The DLQ gives operators a persistent record of undeliverable messages that can be replayed, inspected, or alerted on without blocking the publisher.

```go
// DeadLetterMessage represents a failed message
type DeadLetterMessage[T any] struct {
    Original   Message[T]
    Error      error
    Attempts   int
    FailedAt   time.Time
}

// ReliablePubSub includes retry and dead letter queue
type ReliablePubSub[T any] struct {
    *PubSub[T]

    dlq          chan DeadLetterMessage[T]
    maxRetries   int
    retryDelay   time.Duration
}

func NewReliablePubSub[T any](bufferSize, dlqSize, maxRetries int) *ReliablePubSub[T] {
    return &ReliablePubSub[T]{
        PubSub:     NewPubSub[T](bufferSize),
        dlq:        make(chan DeadLetterMessage[T], dlqSize),
        maxRetries: maxRetries,
        retryDelay: time.Second,
    }
}

// PublishReliable ensures message delivery with retries
func (rps *ReliablePubSub[T]) PublishReliable(ctx context.Context, topic string, payload T) error {
    msg := Message[T]{
        Topic:     topic,
        Payload:   payload,
        Timestamp: time.Now(),
        ID:        generateID(),
    }

    // Snapshot the subscriber list under the lock, then release it.
    // Delivery must not hold ps.mu, or a slow subscriber would block
    // every Subscribe and Unsubscribe for the whole retry window.
    // Per-subscription locking inside sendWait is what keeps this safe.
    rps.mu.RLock()
    subs := make([]*Subscription[T], len(rps.subscriptions[topic]))
    copy(subs, rps.subscriptions[topic])
    rps.mu.RUnlock()

    var wg sync.WaitGroup
    // Note: do not name this channel `errors`. It would shadow the
    // errors package for the rest of the function.
    errCh := make(chan error, len(subs))

    for _, sub := range subs {
        wg.Add(1)
        go func(s *Subscription[T]) {
            defer wg.Done()

            attempts := 0
            for attempt := 0; attempt <= rps.maxRetries; attempt++ {
                attempts++

                if ctx.Err() != nil {
                    errCh <- ctx.Err()
                    return
                }
                // sendWait re-checks closed under the subscription's
                // read lock, so a concurrent Unsubscribe cannot make
                // this panic.
                if s.sendWait(ctx, msg, rps.retryDelay) {
                    return
                }
            }

            // Max retries exceeded, send to DLQ
            select {
            case rps.dlq <- DeadLetterMessage[T]{
                Original: msg,
                Error:    fmt.Errorf("max retries exceeded"),
                Attempts: attempts,
                FailedAt: time.Now(),
            }:
            default:
                errCh <- fmt.Errorf("DLQ full, message lost")
            }
        }(sub)
    }

    wg.Wait()
    close(errCh)

    var errs []error
    for err := range errCh {
        if err != nil {
            errs = append(errs, err)
        }
    }

    if len(errs) > 0 {
        return errors.Join(errs...)
    }
    return nil
}

// DeadLetterQueue returns the DLQ channel
func (rps *ReliablePubSub[T]) DeadLetterQueue() <-chan DeadLetterMessage[T] {
    return rps.dlq
}
```

### In-Process Pub/Sub Is Rarely Enough

The in-process pub/sub shown here is useful for decoupling within a single process. Production systems usually need cross-process pub/sub, which means a message broker (Kafka, NATS, RabbitMQ, Redis Streams, SQS). Signs your in-process pub/sub is the wrong tool:

- Subscribers need to survive publisher restart.
- Messages must be durable across crashes.
- Multiple service instances need to share subscription load.
- You need replay, ordering guarantees, or at-least-once delivery.

Each of these is a sign to move to a real broker. The in-process pattern is for loose coupling within a process, not for messaging infrastructure.

### Staff Lens: Slow Subscribers Are the Perennial Problem

Every pub/sub system, in-process or distributed, has the same failure mode: a slow subscriber backs up the system. In-process, a slow subscriber fills its buffer and then blocks the publisher (if sending synchronously) or gets dropped (if the policy is drop-on-full). Distributed brokers have consumer-group lag, retry dead-letter queues, and partition imbalance. The staff-level design question is: what happens when one subscriber is slow? Block the publisher (back-pressure), drop messages (lossy but available), or route to a dead-letter queue (durable but delayed)? Each is correct for some semantics and wrong for others. Make the decision explicit at design time.

### Principal Lens: Pub/Sub at the Architecture Level

At the architecture level, pub/sub is the answer to "loose coupling between services". It enables services to evolve independently, handle varying traffic, and survive partial failures. It also introduces: eventual consistency, debugging complexity (what published this event?), operational cost (the broker is a critical dependency), and coordination cost (schema evolution across publishers and subscribers). The principal-level judgment is when to adopt pub/sub and when to stay with synchronous calls. A common mistake is to reach for pub/sub too early, creating architectural complexity for a service that would be fine with direct RPC. Adopt pub/sub when the coupling benefit justifies the operational cost, not as a default.

---
