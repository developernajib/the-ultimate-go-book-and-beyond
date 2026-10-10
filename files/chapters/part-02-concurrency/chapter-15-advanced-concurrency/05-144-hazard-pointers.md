## 15.4 Hazard Pointers

Hazard pointers prevent ABA problems and enable safe memory reclamation in lock-free structures. The core idea is that a thread announces, via a hazard record, which pointer it is currently reading. The reclamation logic will not free any pointer that is listed in any thread's hazard record. This provides a cooperative protocol between readers and reclaimers without requiring garbage-collected languages to add special runtime support.

The implementation below consists of three parts: a `HazardManager` that maintains a list of hazard records, individual `HazardRecord` entries that goroutines acquire and use to protect pointers during read operations, and a `scan` function that walks all active hazard records to determine which retired pointers are safe to reclaim. When a goroutine retires a pointer, it appends it to a goroutine-local list. Once that list grows to twice the number of active records, a scan pass reclaims any pointer not currently protected by a hazard record.

Two details in this protocol are where real implementations go wrong, and both are worth naming before the code.

**Publishing a hazard is not enough. You must re-read and validate.** The naive `Protect(ptr)` that simply stores the pointer is broken, and its brokenness is the exact hazard the technique exists to prevent. A reader loads the pointer, and *before* its hazard store becomes visible, a writer unlinks and retires that node. The reader then publishes a hazard for a node already judged reclaimable, and proceeds to read it. The protocol requires a loop: publish the hazard, re-read the source, and only proceed if it still holds the same value. Otherwise start over. Without that re-read there is no protection, only the appearance of it.

**The record list itself is shared state.** Reading `m.records` unsynchronized while `Acquire` appends to it under a mutex is a plain data race, and `-race` catches it immediately:

```
WARNING: DATA RACE
Write at 0x00c00012e000 by goroutine 8:
  main.(*HazardManager[go.shape.int]).Acquire()
Previous read at 0x00c00012e000 by goroutine 10:
  main.(*HazardManager[go.shape.int]).Acquire()
```

A mutex that guards the write but not the read guards nothing. Since the list is read constantly and grows rarely, hold it in an `atomic.Pointer` and copy-on-append, so readers stay lock-free and the append publishes a complete new slice.

```go
type HazardRecord[T any] struct {
    active  atomic.Bool
    hazard  atomic.Pointer[T]
    retired []*T // Owned by the acquiring goroutine, never shared
}

type HazardManager[T any] struct {
    // Read on every operation, appended to rarely: copy-on-write so
    // readers never need the mutex. mu serialises writers only.
    records atomic.Pointer[[]*HazardRecord[T]]
    mu      sync.Mutex
}

func (m *HazardManager[T]) list() []*HazardRecord[T] {
    if p := m.records.Load(); p != nil {
        return *p
    }
    return nil
}

func (m *HazardManager[T]) Acquire() *HazardRecord[T] {
    // Fast path: reuse a retired record without touching the mutex.
    for _, r := range m.list() {
        if !r.active.Load() && r.active.CompareAndSwap(false, true) {
            return r
        }
    }

    m.mu.Lock()
    defer m.mu.Unlock()

    // Re-check under the lock: another goroutine may have released a
    // record, or appended one, while we were getting here.
    cur := m.list()
    for _, r := range cur {
        if !r.active.Load() && r.active.CompareAndSwap(false, true) {
            return r
        }
    }

    r := &HazardRecord[T]{}
    r.active.Store(true)

    // Copy-on-write: build the new slice, then publish it atomically.
    // Appending in place would mutate a slice header that lock-free
    // readers are reading right now.
    next := make([]*HazardRecord[T], len(cur), len(cur)+1)
    copy(next, cur)
    next = append(next, r)
    m.records.Store(&next)
    return r
}

// ProtectFrom publishes a hazard for whatever src currently holds, then
// validates that src did not change in the meantime.
//
// This re-read is the protocol. A bare Store(ptr) with no validation
// lets a node be retired between the caller's load and the hazard
// becoming visible, which is precisely the use-after-free this is
// supposed to prevent.
func (r *HazardRecord[T]) ProtectFrom(src *atomic.Pointer[T]) *T {
    for {
        p := src.Load()
        r.hazard.Store(p)

        // If src still reads as p, then any concurrent retire of p was
        // ordered after our hazard was visible, so p is safe.
        if src.Load() == p {
            return p
        }
        // src moved: our hazard is stale. Retry.
    }
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
    if len(record.retired) >= 2*len(m.list()) {
        m.scan(record)
    }
}

func (m *HazardManager[T]) scan(record *HazardRecord[T]) {
    // Collect every pointer any goroutine currently claims to be reading.
    hazards := make(map[*T]bool)
    for _, r := range m.list() {
        if p := r.hazard.Load(); p != nil {
            hazards[p] = true
        }
    }

    // Retain the pointers that are STILL protected, as they must stay on
    // the retired list for a later scan. Everything else is unprotected
    // and is dropped here, which in Go means the GC may now collect it.
    var remaining []*T
    for _, p := range record.retired {
        if hazards[p] {
            remaining = append(remaining, p)
        }
    }
    record.retired = remaining
}
```

Notice what `scan` does in Go versus C. In C, the loop over unprotected pointers would call `free`. Here, dropping the reference is the whole reclamation step, and the GC does the rest. That is a hint about how little this machinery buys you in Go, which the next section makes explicit.

### Go Has GC, So You Probably Do Not Need Hazard Pointers

Hazard pointers solve a problem that exists in languages without garbage collection (C, C++): how to safely reclaim memory in a lock-free data structure when concurrent readers might still hold pointers. In Go, the garbage collector handles this automatically. Any lock-free structure that drops all references to a node will have it collected eventually.

The cases where hazard pointers matter in Go:

1. **You are storing pointers where the GC cannot see them**, such as inside a `uintptr` or in off-heap or mapped memory. The GC does not track those, so reclamation is yours to manage. Note that plain `unsafe.Pointer` does not qualify: the GC *does* track it. It is the round trip through `uintptr` that loses the reference.
2. **You need deterministic reclamation timing.** The GC decides when to collect, so nodes may live longer than you want. Be precise about what hazard pointers buy here: in Go they do not free anything, they only drop the last reference, which makes a node *eligible* for collection sooner. Deterministic eligibility is not deterministic freeing.
3. **The structure holds external resources (file descriptors, connections).** These need explicit release, and hazard pointers can tell you when the last reader is done. Do not lean on finalizers for this: `runtime.SetFinalizer` and its modern replacement `runtime.AddCleanup` (Go 1.24) make no promise about running promptly, or at all before exit.

Outside these cases, let Go's GC do the work. Hazard pointers are a significant complexity investment for uncertain benefit in a garbage-collected language.

### Staff Lens: Hazard Pointers Are a Research-Level Technique

Implementing hazard pointers correctly requires understanding memory ordering, retirement semantics, and scan thresholds. Very few Go teams have the expertise to maintain this code. If you believe you need hazard pointers, the first step is to reconsider the design. The second step is to consult someone who has implemented them before. The third step, if those fail, is to implement with extreme care and extensive testing.

---
