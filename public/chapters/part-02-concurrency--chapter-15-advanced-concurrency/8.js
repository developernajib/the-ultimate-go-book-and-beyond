export default `## 15.7 Backpressure

When producers generate work faster than consumers can process it, the system must make a choice: buffer indefinitely (leading to memory exhaustion and eventual OOM kill), drop excess work, or slow the producer down to match the consumer's rate. Backpressure is the mechanism that communicates consumer capacity upstream to the producer, preventing unbounded queue growth. The three strategies below, blocking, dropping, and adaptive, each make a different trade-off between producer liveness, data completeness, and system stability.

### Blocking Backpressure

Blocking backpressure propagates load upstream: when a queue is full, the producer blocks until a consumer makes room. This naturally throttles producers to the rate consumers can sustain, but requires that producers are goroutines that can safely block, not the main goroutine or a timer callback.

\`\`\`go
type BackpressureQueue[T any] struct {
    items chan T
}

func NewBackpressureQueue[T any](capacity int) *BackpressureQueue[T] {
    return &BackpressureQueue[T]{
        items: make(chan T, capacity),
    }
}

func (q *BackpressureQueue[T]) Push(item T) {
    q.items <- item // Blocks when full
}

func (q *BackpressureQueue[T]) Pop() T {
    return <-q.items
}
\`\`\`

### Dropping Backpressure

Dropping backpressure favors producer liveness over completeness: when the queue is full, new items are silently discarded rather than blocking the producer. This is appropriate for telemetry, metrics, and other best-effort data where a bounded loss rate under peak load is acceptable but producer stalls are not.

\`\`\`go
type DroppingQueue[T any] struct {
    items chan T
}

func (q *DroppingQueue[T]) Push(item T) bool {
    select {
    case q.items <- item:
        return true
    default:
        return false // Dropped
    }
}
\`\`\`

### Adaptive Backpressure

Adaptive backpressure sits between hard blocking and silent dropping: it allows producers to continue but introduces an artificial delay proportional to how far queue depth exceeds the threshold. By tracking the number of concurrent \`Push\` callers with an atomic counter, the queue measures instantaneous pressure without acquiring a lock, producers that arrive when pressure is below the threshold pay zero overhead, while those that arrive during a surge are slowed just enough to let the consumer catch up.

\`\`\`go
type AdaptiveQueue[T any] struct {
    items     chan T
    pressure  atomic.Int64
    threshold int64
}

func (q *AdaptiveQueue[T]) Push(item T) error {
    pressure := q.pressure.Add(1)
    defer q.pressure.Add(-1)

    if pressure > q.threshold {
        // Apply backpressure
        time.Sleep(time.Duration(pressure-q.threshold) * time.Millisecond)
    }

    select {
    case q.items <- item:
        return nil
    default:
        return errors.New("queue full")
    }
}
\`\`\`

### Staff Lens: Backpressure Policy Is a Business Decision

Every queue with a bound needs an overflow policy. The choices:

1. **Block.** The producer waits until capacity is available. Correct when upstream can slow down safely.
2. **Drop.** New items are rejected with an error. Correct when upstream can retry or when item freshness matters.
3. **Drop-oldest.** Evict the oldest item to make room. Correct when only recent data matters (metrics, live updates).
4. **Spill to disk.** Overflow persists. Correct when items must not be lost.

Each of these is a business decision, not a technical one. The staff-level discipline is making the choice explicit and documented. A queue without a documented overflow policy is a queue whose behaviour under load is unknown to its operators.

---
`;
