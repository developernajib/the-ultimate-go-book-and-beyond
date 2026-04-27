export default `## 15.5 Epoch-Based Reclamation

Hazard pointers (Section 15.4) require each reader to publish the exact pointer it is accessing, which works well but imposes per-pointer overhead. Epoch-based reclamation takes a coarser approach: instead of tracking individual pointers, it divides time into numbered epochs and tracks which epoch each goroutine entered its critical section. Retired objects are assigned to the current epoch's bucket. When all goroutines have advanced past an epoch, every object in that bucket is guaranteed to be unreachable and can be freed. This amortizes the cost of reclamation over many retirements rather than paying per-pointer bookkeeping.

The three-slot ring (\`retired[current%3]\`) accommodates the worst case where some goroutines are still in epoch N−1 while the global epoch has reached N+1. In Go, where the garbage collector handles most reclamation, epoch-based techniques are primarily useful for managing non-GC resources such as memory-mapped file regions, OS file descriptors, or manually allocated C memory accessed through cgo.

\`\`\`go
type Epoch struct {
    current atomic.Uint64
    retired [3][]unsafe.Pointer
    mu      sync.Mutex
}

type EpochGuard struct {
    epoch *Epoch
    local uint64
}

func (e *Epoch) Pin() *EpochGuard {
    return &EpochGuard{
        epoch: e,
        local: e.current.Load(),
    }
}

func (g *EpochGuard) Unpin() {
    // Mark this thread as not in critical section
}

func (e *Epoch) Retire(ptr unsafe.Pointer) {
    current := e.current.Load()
    e.mu.Lock()
    e.retired[current%3] = append(e.retired[current%3], ptr)
    e.mu.Unlock()
}

func (e *Epoch) TryAdvance() {
    current := e.current.Load()
    // If all threads have moved past current-2, we can free those pointers
    e.mu.Lock()
    defer e.mu.Unlock()

    toFree := e.retired[(current+1)%3]
    e.retired[(current+1)%3] = nil

    for _, ptr := range toFree {
        // Free memory
        _ = ptr
    }

    e.current.Add(1)
}
\`\`\`

### Staff Lens: Same Warnings as Hazard Pointers

Epoch-based reclamation solves the same problem as hazard pointers (safe memory reclamation in lock-free structures) with slightly different tradeoffs. Same warnings apply: Go's GC usually makes this unnecessary. Reach for it only when \`unsafe.Pointer\` forces explicit reclamation or deterministic timing matters. Prefer hazard pointers when readers are few and common; prefer epoch-based when readers are many and most structures evolve slowly.

---
`;
