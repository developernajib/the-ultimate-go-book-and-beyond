## 15.5 Epoch-Based Reclamation

Hazard pointers (Section 15.4) require each reader to publish the exact pointer it is accessing, which works well but imposes per-pointer overhead. Epoch-based reclamation takes a coarser approach: instead of tracking individual pointers, it divides time into numbered epochs and tracks which epoch each goroutine entered its critical section. Retired objects are assigned to the current epoch's bucket. When all goroutines have advanced past an epoch, every object in that bucket is guaranteed to be unreachable and can be freed. This amortizes the cost of reclamation over many retirements rather than paying per-pointer bookkeeping.

The three-slot ring (`retired[current%3]`) accommodates the worst case where some goroutines are still in epoch N-1 while the global epoch has reached N+1. In Go, where the garbage collector handles most reclamation, epoch-based techniques are primarily useful for managing non-GC resources such as memory-mapped file regions, OS file descriptors, or manually allocated C memory accessed through cgo.

Everything rests on one guarantee: *the epoch does not advance while any goroutine is still pinned in an older epoch*. That single check is the algorithm. Strip it out and what remains is a ring buffer that frees memory on a timer while readers are using it, which is worse than no reclamation scheme at all. So the participant registry below is not incidental bookkeeping. `Pin` has to announce the epoch somewhere other goroutines can read, `Unpin` has to retract that announcement, and `TryAdvance` has to consult it and refuse to advance when any pinned participant lags. An `Unpin` that does nothing, or a `TryAdvance` that advances unconditionally, is a use-after-free generator.

```go
// Participant is one goroutine's published state. Pin/Unpin write it,
// and TryAdvance reads every participant's copy.
type Participant struct {
    active atomic.Bool   // Is this goroutine inside a critical section?
    local  atomic.Uint64 // Which epoch did it enter at?
}

type Epoch struct {
    current atomic.Uint64
    // Copy-on-write registry: read on every TryAdvance, appended rarely.
    parts atomic.Pointer[[]*Participant]
    mu    sync.Mutex
    // Release callbacks, not raw pointers: what needs reclaiming here is
    // an external resource, so name the operation instead of pretending
    // to free memory Go already manages.
    retired [3][]func()
}

func (e *Epoch) list() []*Participant {
    if p := e.parts.Load(); p != nil {
        return *p
    }
    return nil
}

// Register returns a participant handle. Each goroutine needs its own.
func (e *Epoch) Register() *Participant {
    e.mu.Lock()
    defer e.mu.Unlock()

    cur := e.list()
    p := &Participant{}
    next := make([]*Participant, len(cur), len(cur)+1)
    copy(next, cur)
    next = append(next, p)
    e.parts.Store(&next)
    return p
}

// Pin enters a critical section, publishing the epoch we entered at.
// The order matters: record the epoch, then announce we are active.
func (e *Epoch) Pin(p *Participant) {
    p.local.Store(e.current.Load())
    p.active.Store(true)
}

// Unpin leaves the critical section. This must actually retract the
// announcement. A no-op Unpin pins the epoch forever and reclamation
// stops dead, which presents as an unbounded memory leak.
func (e *Epoch) Unpin(p *Participant) {
    p.active.Store(false)
}

// Retire schedules release to run once no goroutine can still be
// holding a reference from the current epoch.
func (e *Epoch) Retire(release func()) {
    e.mu.Lock()
    cur := e.current.Load()
    e.retired[cur%3] = append(e.retired[cur%3], release)
    e.mu.Unlock()
}

// TryAdvance advances the epoch and reclaims the oldest bucket, but
// only if it is safe to do so. Returns false if a straggler blocks it.
func (e *Epoch) TryAdvance() bool {
    cur := e.current.Load()

    // The check the whole scheme depends on: no pinned participant may
    // still be sitting in an older epoch.
    for _, p := range e.list() {
        if p.active.Load() && p.local.Load() != cur {
            return false
        }
    }

    e.mu.Lock()
    defer e.mu.Unlock()

    // CAS rather than Add: if another goroutine advanced while we were
    // scanning, our scan result is stale and we must not act on it.
    if !e.current.CompareAndSwap(cur, cur+1) {
        return false
    }

    // Bucket cur+1 is the same slot as cur-2 in a 3-ring. Everything in
    // it was retired two epochs ago, and we just proved nobody is that
    // far behind, so it is now unreachable.
    toFree := e.retired[(cur+1)%3]
    e.retired[(cur+1)%3] = nil

    for _, release := range toFree {
        release()
    }
    return true
}
```

The property is testable, and you should test it. Pin a reader, retire an object, then hammer `TryAdvance` from another goroutine: the release must not fire. Unpin the reader and it must fire promptly.

```
freed while reader still pinned?  false (must be false)
freed after reader unpinned?      true (must be true)
```

Note the failure asymmetry, which is what makes this technique unforgiving. Forget to `Unpin` and you get a memory leak: the epoch never advances, the buckets grow without bound, and you will eventually notice. Get the check wrong and you get a use-after-free: silent, rare, and corrupting. The leak is the survivable bug. Bias the implementation toward it.

### Staff Lens: Same Warnings as Hazard Pointers

Epoch-based reclamation solves the same problem as hazard pointers (safe memory reclamation in lock-free structures) with different tradeoffs. The same warnings apply: Go's GC usually makes this unnecessary, so reach for it only when the resource is genuinely outside the GC's reach, such as mapped regions, descriptors, or cgo allocations, or when reclamation timing must be deterministic.

The choice between the two comes down to what you are willing to pay on the read path. Hazard pointers charge every reader an atomic store plus a validating re-read for *each* pointer it touches, and in exchange reclamation is prompt and a stalled reader blocks only the specific nodes it is holding. Epochs charge a reader one announcement for an entire critical section regardless of how many pointers it dereferences, which is much cheaper when reads are frequent and touch many nodes, but reclamation is coarser and a single goroutine that stalls while pinned blocks *all* reclamation behind it.

So: hazard pointers when readers are few or may stall unpredictably. Epochs when readers are numerous, short, and touch many pointers per critical section.

---
