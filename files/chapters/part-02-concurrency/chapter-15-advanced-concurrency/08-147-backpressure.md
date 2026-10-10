## 15.7 Backpressure

When producers generate work faster than consumers can process it, the system must make a choice: buffer indefinitely (leading to memory exhaustion and eventual OOM kill), drop excess work, or slow the producer down to match the consumer's rate. Backpressure is the mechanism that communicates consumer capacity upstream to the producer, preventing unbounded queue growth. The three strategies below, blocking, dropping, and adaptive, each make a different trade-off between producer liveness, data completeness, and system stability.

### Blocking Backpressure

Blocking backpressure propagates load upstream: when a queue is full, the producer blocks until a consumer makes room. This naturally throttles producers to the rate consumers can sustain, but requires that producers are goroutines that can safely block, not the main goroutine or a timer callback.

```go
type BackpressureQueue[T any] struct {
    items chan T
}

func NewBackpressureQueue[T any](capacity int) *BackpressureQueue[T] {
    return &BackpressureQueue[T]{
        items: make(chan T, capacity),
    }
}

// Push blocks until there is room, or ctx is cancelled.
//
// The ctx case is what makes this safe to call from a request handler.
// A bare q.items <- item is uninterruptible: if consumers stall, every
// producer parks forever and no timeout can reclaim them, which
// converts a slow consumer into a total outage.
func (q *BackpressureQueue[T]) Push(ctx context.Context, item T) error {
    select {
    case q.items <- item:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (q *BackpressureQueue[T]) Pop(ctx context.Context) (T, error) {
    select {
    case item := <-q.items:
        return item, nil
    case <-ctx.Done():
        var zero T
        return zero, ctx.Err()
    }
}
```

### Dropping Backpressure

Dropping backpressure favors producer liveness over completeness: when the queue is full, new items are discarded rather than blocking the producer. This is appropriate for telemetry, metrics, and other best-effort data where a bounded loss rate under peak load is acceptable but producer stalls are not.

Two things make the difference between a dropping queue and a data-loss bug. It must have a **constructor**, because the zero value has a nil `items` channel, a send on a nil channel blocks forever, so `select` always takes `default` and the queue silently drops one hundred percent of everything forever while reporting nothing. And drops must be **counted**. A drop policy is only defensible if you know the drop rate. An uninstrumented dropping queue cannot distinguish "shedding 0.01% at peak, working as designed" from "shedding everything since the last deploy", and both look identical from the producer's side.

```go
type DroppingQueue[T any] struct {
    items   chan T
    dropped atomic.Int64
}

// NewDroppingQueue is required. The zero value drops everything.
func NewDroppingQueue[T any](capacity int) *DroppingQueue[T] {
    return &DroppingQueue[T]{items: make(chan T, capacity)}
}

func (q *DroppingQueue[T]) Push(item T) bool {
    select {
    case q.items <- item:
        return true
    default:
        q.dropped.Add(1) // Export this. A silent drop is an invisible outage.
        return false
    }
}

// Dropped returns the cumulative number of discarded items. Alert on
// its rate, not its value.
func (q *DroppingQueue[T]) Dropped() int64 {
    return q.dropped.Load()
}
```

### Adaptive Backpressure

Adaptive backpressure sits between hard blocking and silent dropping: it lets producers continue but introduces a delay proportional to how far queue depth exceeds a threshold. Producers arriving while the queue is shallow pay nothing, while those arriving during a surge are slowed just enough to let the consumer catch up.

The measurement has to be **queue depth**. An atomic counter of in-flight `Push` callers is a tempting stand-in, since it needs no lock, but it measures the wrong thing and fails in the most common configuration of all. With a single producer goroutine there is never more than one `Push` in flight, so that counter never exceeds 1, never crosses the threshold, and the delay never fires. Feed twenty items into a queue of capacity four through such a design and the result is a silent dropping queue wearing an adaptive queue's name:

```
single producer: accepted=4 dropped=16
-> pressure never exceeds 1 with one producer, so the sleep NEVER runs
```

`len(ch)` on a buffered channel is the depth, it is cheap, and it is the number the policy is actually about. It is a sample rather than a lock-held reading, which is fine: this is a heuristic controller, not an accounting ledger.

Two more requirements. The delay needs a **ceiling**, because a delay computed linearly from depth is unbounded, and a deep queue turns into a multi-second stall inside `Push` that no caller asked for. And the wait must be **cancellable**, or the backpressure meant to protect the system becomes a place where request goroutines pile up unkillably.

```go
type AdaptiveQueue[T any] struct {
    items     chan T
    threshold int
    maxDelay  time.Duration
}

func NewAdaptiveQueue[T any](capacity, threshold int, maxDelay time.Duration) *AdaptiveQueue[T] {
    return &AdaptiveQueue[T]{
        items:     make(chan T, capacity),
        threshold: threshold,
        maxDelay:  maxDelay,
    }
}

func (q *AdaptiveQueue[T]) Push(ctx context.Context, item T) error {
    // Depth of the queue, not the number of goroutines calling Push.
    if depth := len(q.items); depth > q.threshold {
        delay := time.Duration(depth-q.threshold) * time.Millisecond
        if delay > q.maxDelay {
            delay = q.maxDelay // Cap it: unbounded delay is an outage
        }

        // Sleep, but stay cancellable.
        t := time.NewTimer(delay)
        defer t.Stop()
        select {
        case <-t.C:
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    // Non-blocking: the delay above was the backpressure, so a still-full
    // queue means genuine overflow. No ctx case here, because default
    // already makes this select non-blocking.
    select {
    case q.items <- item:
        return nil
    default:
        return errors.New("queue full")
    }
}
```

### Staff Lens: Backpressure Policy Is a Business Decision

Every queue with a bound needs an overflow policy. The choices:

1. **Block.** The producer waits until capacity is available. Correct when upstream can slow down safely.
2. **Drop.** New items are rejected with an error. Correct when upstream can retry or when item freshness matters.
3. **Drop-oldest.** Evict the oldest item to make room. Correct when only recent data matters (metrics, live updates).
4. **Spill to disk.** Overflow persists. Correct when items must not be lost.

Each of these is a business decision, not a technical one. The staff-level discipline is making the choice explicit and documented. A queue without a documented overflow policy is a queue whose behavior under load is unknown to its operators.

---
