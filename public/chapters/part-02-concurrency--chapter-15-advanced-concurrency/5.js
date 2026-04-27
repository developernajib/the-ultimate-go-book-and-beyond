export default `## 15.4 Hazard Pointers

Hazard pointers prevent ABA problems and enable safe memory reclamation in lock-free structures. The core idea is that a thread announces, via a hazard record, which pointer it is currently reading. The reclamation logic will not free any pointer that is listed in any thread's hazard record. This provides a cooperative protocol between readers and reclaimers without requiring garbage-collected languages to add special runtime support.

The implementation below consists of three parts: a \`HazardManager\` that maintains a list of hazard records, individual \`HazardRecord\` entries that goroutines acquire and use to protect pointers during read operations, and a \`scan\` function that walks all active hazard records to determine which retired pointers are safe to reclaim. When a goroutine retires a pointer, it appends it to a thread-local list. Once that list grows to twice the number of active records, a scan pass reclaims any pointer not currently protected by a hazard record.

\`\`\`go
type HazardPointer[T any] struct {
    ptr atomic.Pointer[T]
}

type HazardRecord[T any] struct {
    active  atomic.Bool
    hazard  atomic.Pointer[T]
    retired []*T
}

type HazardManager[T any] struct {
    records []*HazardRecord[T]
    mu      sync.Mutex
}

func (m *HazardManager[T]) Acquire() *HazardRecord[T] {
    // Try to reuse existing record
    for _, r := range m.records {
        if !r.active.Load() {
            if r.active.CompareAndSwap(false, true) {
                return r
            }
        }
    }

    // Create new record
    m.mu.Lock()
    defer m.mu.Unlock()
    r := &HazardRecord[T]{}
    r.active.Store(true)
    m.records = append(m.records, r)
    return r
}

func (r *HazardRecord[T]) Protect(ptr *T) {
    r.hazard.Store(ptr)
}

func (r *HazardRecord[T]) Clear() {
    r.hazard.Store(nil)
}

func (r *HazardRecord[T]) Release() {
    r.hazard.Store(nil)
    r.active.Store(false)
}

func (m *HazardManager[T]) Retire(ptr *T, record *HazardRecord[T]) {
    record.retired = append(record.retired, ptr)
    if len(record.retired) >= 2*len(m.records) {
        m.scan(record)
    }
}

func (m *HazardManager[T]) scan(record *HazardRecord[T]) {
    // Collect all hazard pointers
    hazards := make(map[*T]bool)
    for _, r := range m.records {
        if p := r.hazard.Load(); p != nil {
            hazards[p] = true
        }
    }

    // Keep only non-hazardous retired pointers
    var remaining []*T
    for _, p := range record.retired {
        if hazards[p] {
            remaining = append(remaining, p)
        }
        // Non-hazardous pointers can be freed
    }
    record.retired = remaining
}
\`\`\`

### Go Has GC, So You Probably Do Not Need Hazard Pointers

Hazard pointers solve a problem that exists in languages without garbage collection (C, C++): how to safely reclaim memory in a lock-free data structure when concurrent readers might still hold pointers. In Go, the garbage collector handles this automatically. Any lock-free structure that drops all references to a node will have it collected eventually.

The cases where hazard pointers matter in Go:

1. **You are using \`unsafe.Pointer\` for performance.** The GC does not track these. You need explicit reclamation.
2. **You need deterministic reclamation timing.** GC is cooperative; nodes may live longer than you want. Hazard pointers free immediately after no hazard is held.
3. **The structure holds external resources (file descriptors, connections).** GC eventually runs finalizers, but "eventually" may not be soon enough. Explicit reclamation is better.

Outside these cases, let Go's GC do the work. Hazard pointers are a significant complexity investment for uncertain benefit in a garbage-collected language.

### Staff Lens: Hazard Pointers Are a Research-Level Technique

Implementing hazard pointers correctly requires understanding memory ordering, retirement semantics, and scan thresholds. Very few Go teams have the expertise to maintain this code. If you believe you need hazard pointers, the first step is to reconsider the design. The second step is to consult someone who has implemented them before. The third step, if those fail, is to implement with extreme care and extensive testing.

---
`;
