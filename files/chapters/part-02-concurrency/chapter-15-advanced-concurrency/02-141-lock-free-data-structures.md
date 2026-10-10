## 15.1 Lock-Free Data Structures

Lock-free programming eliminates mutual exclusion entirely. Instead of mutexes, lock-free algorithms coordinate access to shared data through atomic operations, primarily compare-and-swap (CAS). Under high contention, this avoids the convoy effect where goroutines queue behind a single lock holder, but the trade-off is substantially more complex code that must handle retry loops, memory ordering, and subtle correctness pitfalls like the ABA problem.

### Understanding Lock-Free vs Lock-Based

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Concurrency Approaches                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Lock-Based (Mutex)              Lock-Free (Atomic CAS)              │
│  ┌─────────────────┐            ┌─────────────────────┐              │
│  │ Goroutine 1     │            │ Goroutine 1         │              │
│  │ ┌───────────┐   │            │ ┌─────────────────┐ │              │
│  │ │Lock()     │   │            │ │CAS(old, new)    │ │              │
│  │ │  modify   │   │            │ │  if success:    │ │              │
│  │ │Unlock()   │   │            │ │    done         │ │              │
│  │ └───────────┘   │            │ │  else:          │ │              │
│  └────────┬────────┘            │ │    retry        │ │              │
│           │                      │ └─────────────────┘ │             │
│           ▼                      └──────────┬──────────┘             │
│  Other goroutines                           │                        │
│  WAIT in queue                   Other goroutines                    │
│                                  RETRY immediately                   │
│                                                                      │
│  Pros:                          Pros:                                │
│  - Simpler to reason about      - No blocking (progress guarantee)   │
│  - Easier to implement          - No deadlocks possible              │
│  - Good for long operations     - Better under high contention       │
│                                                                      │
│  Cons:                          Cons:                                │
│  - Can cause priority inversion - Complex to implement correctly     │
│  - Deadlock risk                - ABA problem                        │
│  - Blocking can waste CPU       - Only for simple operations         │
└──────────────────────────────────────────────────────────────────────┘
```

### The ABA Problem

The ABA problem is a fundamental challenge in lock-free programming:

```go
// The ABA Problem Illustrated
//
// Thread 1: Reads value A from location X
// Thread 1: Gets preempted
// Thread 2: Changes X from A to B
// Thread 2: Changes X from B back to A
// Thread 1: Resumes, does CAS(A, new_value) - SUCCEEDS!
//
// Problem: Thread 1 doesn't know the value changed and changed back

// Example: Lock-free stack with ABA problem
type UnsafeNode struct {
    value int
    next  *UnsafeNode
}

type UnsafeStack struct {
    head *UnsafeNode
}

// This is UNSAFE - demonstrates the ABA problem
func (s *UnsafeStack) PopUnsafe() (*UnsafeNode, bool) {
    for {
        head := s.head // Read head
        if head == nil {
            return nil, false
        }
        next := head.next

        // ABA Problem: Between reading head and CAS,
        // another goroutine could:
        // 1. Pop head (node A)
        // 2. Pop next (node B)
        // 3. Push A back (reusing same memory)
        // 4. Now CAS succeeds but next points to freed memory!

        if atomic.CompareAndSwapPointer(
            (*unsafe.Pointer)(unsafe.Pointer(&s.head)),
            unsafe.Pointer(head),
            unsafe.Pointer(next),
        ) {
            return head, true
        }
    }
}
```

### Solutions to the ABA Problem

**1. Tagged Pointers (Version Numbers)**

The classic C and C++ solution packs a version counter into the unused high bits of a pointer, so that a CAS compares pointer and version together. An A-B-A sequence bumps the version twice, so the stale CAS fails.

> **Read this for background, do not ship it in Go.** The code below is shown because you will meet the technique in the literature and in runtime internals, but it is unsound as written in ordinary Go. Storing the only reference to a node inside a `uint64` hides that pointer from the garbage collector, which is free to collect the node while the stack still "holds" it. It also assumes a 48-bit address space, which is not guaranteed. You do not have to take this on faith: `go vet` reports `possible misuse of unsafe.Pointer` on both `UnpackTaggedPointer` and the `Pop` below, which is exactly the round trip through `uintptr` that loses the GC's reference. Go's answer is the versioned head record shown next: it gets the same ABA immunity while keeping every pointer visible to the GC.

```go
// TaggedPointer combines a pointer with a version number
type TaggedPointer struct {
    ptr     unsafe.Pointer
    version uint32
}

// PackTaggedPointer creates a tagged pointer
// Uses the upper bits of a 64-bit value for version
func PackTaggedPointer(ptr unsafe.Pointer, version uint32) uint64 {
    return uint64(uintptr(ptr)) | (uint64(version) << 48)
}

func UnpackTaggedPointer(tagged uint64) (unsafe.Pointer, uint32) {
    ptr := unsafe.Pointer(uintptr(tagged & 0x0000FFFFFFFFFFFF))
    version := uint32(tagged >> 48)
    return ptr, version
}

type TaggedStack[T any] struct {
    head atomic.Uint64 // Tagged pointer
}

type TaggedNode[T any] struct {
    value T
    next  atomic.Uint64
}

func (s *TaggedStack[T]) Push(value T) {
    node := &TaggedNode[T]{value: value}
    nodePtr := unsafe.Pointer(node)

    for {
        oldHead := s.head.Load()
        _, version := UnpackTaggedPointer(oldHead)

        node.next.Store(oldHead)
        newHead := PackTaggedPointer(nodePtr, version+1)

        if s.head.CompareAndSwap(oldHead, newHead) {
            return
        }
    }
}

func (s *TaggedStack[T]) Pop() (T, bool) {
    for {
        oldHead := s.head.Load()
        oldPtr, version := UnpackTaggedPointer(oldHead)

        if oldPtr == nil {
            var zero T
            return zero, false
        }

        node := (*TaggedNode[T])(oldPtr)
        nextHead := node.next.Load()
        newHead := PackTaggedPointer(
            unsafe.Pointer(uintptr(nextHead & 0x0000FFFFFFFFFFFF)),
            version+1,
        )

        if s.head.CompareAndSwap(oldHead, newHead) {
            return node.value, true
        }
    }
}
```

**2. Using Go 1.19+ atomic.Pointer (Recommended)**

Go 1.19 introduced the generic `atomic.Pointer[T]` type, which replaces raw `unsafe.Pointer` manipulations with a type-safe API that the compiler can verify and, critically, that the garbage collector can see. Be precise about what this buys you, because it is easy to overclaim.

The ABA problem has two halves. `atomic.Pointer` plus Go's GC solves one of them for free: a node you still hold a pointer to cannot be freed and its address cannot be recycled underneath you, so the use-after-free half of the C and C++ version simply cannot happen. The *logical* half survives untouched. If another goroutine pops A, pops B, and pushes the same node A back, then `head` is once again A, your CAS succeeds, and you install a `next` pointer that was read from an earlier state of the stack.

Here is the trap, and it is a common one. This is the naive `atomic.Pointer` stack, with a version counter bolted on:

```go
type SafeStack[T any] struct {
    head    atomic.Pointer[Node[T]]
    version atomic.Uint64 // Incremented, but never compared. Decorative.
}

func (s *SafeStack[T]) Pop() (T, bool) {
    for {
        head := s.head.Load()
        if head == nil { /* ... */ }
        next := head.next.Load()
        if s.head.CompareAndSwap(head, next) { // Compares only the pointer
            s.version.Add(1)
            return head.value, true
        }
    }
}
```

That counter does nothing. `CompareAndSwap` compares the pointer and the pointer alone, so a version the CAS never reads cannot reject anything. Run the A-B-A interleaving against this stack and the CAS succeeds against a stale head, reinstalling already-popped node B: the stack ends up holding `[B, C]` when it should hold `[C]`. A node that was removed comes back from the dead. Incrementing a counter next to a CAS is not the same as CASing on the counter.

The fix is to make the thing you CAS on carry the version, so that the comparison covers both. Allocate a small immutable head record on each update. Every update produces a *fresh* record, and the record you loaded is kept alive by your own local variable, so its address cannot be reused while you are mid-operation. Pointer identity therefore becomes a reliable proxy for "the stack has not moved since I looked", which is exactly the property ABA destroys:

```go
// Modern Go approach: version the head record, not just the node.
// Each update allocates a fresh stackHead, so a CAS that succeeds
// proves nothing changed in between. ABA cannot occur.

type Node[T any] struct {
    value T
    next  *Node[T] // Plain pointer: never mutated once linked
}

type stackHead[T any] struct {
    node    *Node[T]
    version uint64
}

type SafeStack[T any] struct {
    head atomic.Pointer[stackHead[T]]
}

func NewSafeStack[T any]() *SafeStack[T] {
    return &SafeStack[T]{}
}

func (s *SafeStack[T]) Push(value T) {
    node := &Node[T]{value: value}

    for {
        old := s.head.Load()
        var oldNode *Node[T]
        var version uint64
        if old != nil {
            oldNode, version = old.node, old.version
        }
        node.next = oldNode

        // The new head is a fresh allocation, so this CAS can never
        // be fooled by an address that was recycled.
        if s.head.CompareAndSwap(old, &stackHead[T]{node: node, version: version + 1}) {
            return
        }
        // CAS failed, another goroutine modified head. Retry.
    }
}

func (s *SafeStack[T]) Pop() (T, bool) {
    for {
        old := s.head.Load()
        if old == nil || old.node == nil {
            var zero T
            return zero, false
        }

        next := &stackHead[T]{node: old.node.next, version: old.version + 1}

        if s.head.CompareAndSwap(old, next) {
            return old.node.value, true
        }
        // CAS failed, retry
    }
}

func (s *SafeStack[T]) Peek() (T, bool) {
    old := s.head.Load()
    if old == nil || old.node == nil {
        var zero T
        return zero, false
    }
    return old.node.value, true
}

func (s *SafeStack[T]) IsEmpty() bool {
    head := s.head.Load()
    return head == nil || head.node == nil
}
```

Under the same A-B-A interleaving that fools the naive version, this CAS fails and the loop retries against the current head, which is the correct outcome. The cost is one small allocation per update, which is the price of buying ABA immunity without leaving the type system or hiding pointers from the GC. If that allocation shows up in a profile, that is the point at which hazard pointers (section 15.4) or epoch-based reclamation (section 15.5) start to earn their complexity.

`Peek` deserves one caution: it is a point-in-time observation. The value it returns may already have been popped by another goroutine before it returns to the caller. That is inherent to lock-free reads, not a defect, but it means `Peek` is only useful for diagnostics, never for a check-then-act sequence such as `if !s.IsEmpty() { s.Pop() }`.

### Lock-Free Queue (MPSC, Multiple Producer, Single Consumer)

The MPSC queue is commonly used for logging, metrics collection, and event processing:

```go
// MPSCQueue is a lock-free queue optimized for multiple producers
// and a single consumer. Used extensively in logging systems.
type MPSCQueue[T any] struct {
    head atomic.Pointer[mpscNode[T]]
    tail atomic.Pointer[mpscNode[T]]
}

type mpscNode[T any] struct {
    value T
    next  atomic.Pointer[mpscNode[T]]
}

func NewMPSCQueue[T any]() *MPSCQueue[T] {
    // Create sentinel node
    sentinel := &mpscNode[T]{}
    q := &MPSCQueue[T]{}
    q.head.Store(sentinel)
    q.tail.Store(sentinel)
    return q
}

// Push adds an item to the queue (thread-safe for multiple producers)
func (q *MPSCQueue[T]) Push(value T) {
    node := &mpscNode[T]{value: value}

    // Swap always succeeds, so no retry loop is needed. The swap
    // claims this producer's slot in the order, and the store links it.
    prev := q.tail.Swap(node)
    prev.next.Store(node)
}

// Pop removes an item from the queue (only safe for a single consumer).
//
// IMPORTANT: ok == false means "no item is visible right now", NOT
// "the queue is empty". A producer that has completed its tail.Swap
// but has not yet run prev.next.Store leaves the queue momentarily
// disconnected, and Pop reports false even though the item is queued
// and will appear shortly. Never treat false as a drained signal or
// as a termination condition. Use a separate done channel for that.
func (q *MPSCQueue[T]) Pop() (T, bool) {
    head := q.head.Load()
    next := head.next.Load()

    if next == nil {
        var zero T
        return zero, false
    }

    // Move head to next. next becomes the new sentinel, clearing its
    // value so the queue does not pin a reference the consumer has
    // already handed back to the caller.
    var zero T
    value := next.value
    next.value = zero
    q.head.Store(next)
    return value, true
}

// PopWait waits for an item with exponential backoff
func (q *MPSCQueue[T]) PopWait(maxWait time.Duration) (T, bool) {
    backoff := time.Microsecond
    deadline := time.Now().Add(maxWait)

    for time.Now().Before(deadline) {
        if value, ok := q.Pop(); ok {
            return value, true
        }

        time.Sleep(backoff)
        if backoff < time.Millisecond*10 {
            backoff *= 2
        }
    }

    var zero T
    return zero, false
}
```

### Lock-Free Counter with Exponential Backoff

Under high contention, naive CAS loops can cause excessive retries as multiple goroutines repeatedly read the same value, attempt a CAS, fail, and immediately retry, generating cache line traffic that slows everyone down. Exponential backoff breaks this cycle by having goroutines wait progressively longer between retries, giving the successful goroutine time to complete its operation before others compete again.

> **Do not use a CAS loop to implement a counter.** Read the example below for the backoff structure, not as a counter you should ship. `atomic.AddInt64` compiles to a single `LOCK XADD` that can never fail and never retries, so a CAS loop around a plain increment is strictly worse: benchmarked against `atomic.Int64.Add` across eight goroutines, the version below runs at roughly half the throughput, and the two statistics counters are much of the reason. They add two more contended atomic read-modify-writes to the cache line you were trying to protect, so measuring the contention makes the contention worse. The backoff pattern earns its keep only where the new value is a function of the old one and no single atomic instruction exists for it: tracking a running maximum, or a counter that saturates at a cap. Reach for `atomic.Add` for anything it can express.

```go
// LockFreeCounter implements a high-performance counter
// with exponential backoff for contention management
type LockFreeCounter struct {
    // value is first so it is 64-bit aligned on 32-bit platforms,
    // which atomic.LoadInt64 requires. The padding keeps value on its
    // own cache line, away from the statistics fields below.
    value int64
    _     [56]byte

    // Statistics. These are themselves contended atomics, so they cost
    // real throughput. Instrument while tuning, then delete.
    casAttempts atomic.Uint64
    casFailures atomic.Uint64
}

func NewLockFreeCounter() *LockFreeCounter {
    return &LockFreeCounter{}
}

func (c *LockFreeCounter) Add(delta int64) int64 {
    // Each Gosched is a full scheduler round trip, so the ceiling stays
    // low. Backing off to hundreds of yields costs far more than the
    // contention it is trying to avoid.
    backoff := 1
    const maxBackoff = 32

    for {
        c.casAttempts.Add(1)
        old := atomic.LoadInt64(&c.value)

        if atomic.CompareAndSwapInt64(&c.value, old, old+delta) {
            return old + delta
        }

        // CAS failed, so another goroutine won the race. Back off.
        c.casFailures.Add(1)

        for i := 0; i < backoff; i++ {
            runtime.Gosched() // Yield to other goroutines
        }

        if backoff < maxBackoff {
            backoff *= 2
        }
    }
}

func (c *LockFreeCounter) Increment() int64 {
    return c.Add(1)
}

func (c *LockFreeCounter) Decrement() int64 {
    return c.Add(-1)
}

func (c *LockFreeCounter) Value() int64 {
    return atomic.LoadInt64(&c.value)
}

// ContentionRatio returns the ratio of failed CAS to total attempts
func (c *LockFreeCounter) ContentionRatio() float64 {
    attempts := c.casAttempts.Load()
    if attempts == 0 {
        return 0
    }
    return float64(c.casFailures.Load()) / float64(attempts)
}

// Compare-And-Swap with timeout for bounded wait
func (c *LockFreeCounter) AddWithTimeout(delta int64, timeout time.Duration) (int64, bool) {
    deadline := time.Now().Add(timeout)
    backoff := time.Microsecond

    for time.Now().Before(deadline) {
        old := atomic.LoadInt64(&c.value)
        if atomic.CompareAndSwapInt64(&c.value, old, old+delta) {
            return old + delta, true
        }

        time.Sleep(backoff)
        if backoff < time.Millisecond {
            backoff *= 2
        }
    }

    return 0, false
}
```

### TTAS (Test-and-Test-and-Set) Optimization

A naive spinlock that calls `Swap` in a tight loop generates a bus write on every iteration, even when the lock is held. The TTAS pattern avoids this by first performing a read-only `Load`, which can be satisfied from the local CPU cache without bus traffic, and only attempting the expensive `Swap` when the load indicates the lock is free. This distinction matters because cache-coherent reads are cheap (local cache hit) while atomic read-modify-write operations force exclusive cache line ownership.

> **Spinlocks are almost always the wrong choice in Go, and this one is here to explain TTAS, not to be used.** A spinlock assumes the lock holder is running on another core and will release shortly. Goroutines break that assumption: the holder is not a thread, and the scheduler can park it mid-critical-section, at which point every spinner burns a full CPU core waiting for a goroutine that is not running. `sync.Mutex` already spins briefly before parking, and unlike this code it knows when to stop, hands off to waiters fairly, and starves nobody. It is faster than a hand-rolled spinlock in essentially every realistic case. The one place TTAS reasoning pays off is reading runtime and lock-library internals, which is why it is worth understanding.

```go
// TTASLock implements Test-and-Test-and-Set spinlock
// More efficient than naive spinlock under contention
type TTASLock struct {
    locked atomic.Bool
}

func (l *TTASLock) Lock() {
    for {
        // First test (read-only, cache-friendly)
        if !l.locked.Load() {
            // Then test-and-set (expensive bus operation)
            if !l.locked.Swap(true) {
                return // Acquired lock
            }
        }
        // Spin - yield to reduce contention
        runtime.Gosched()
    }
}

func (l *TTASLock) Unlock() {
    l.locked.Store(false)
}

// TryLock attempts to acquire lock without blocking
func (l *TTASLock) TryLock() bool {
    return !l.locked.Swap(true)
}

// LockWithBackoff uses exponential backoff.
//
// Note the floor: time.Sleep cannot deliver sub-microsecond naps. It
// parks the goroutine and relies on the runtime timer, so a requested
// 100ns typically costs microseconds. Start at a duration the runtime
// can actually honour rather than pretending to a precision it lacks.
func (l *TTASLock) LockWithBackoff() {
    backoff := time.Microsecond
    maxBackoff := time.Microsecond * 100

    for {
        if !l.locked.Load() {
            if !l.locked.Swap(true) {
                return
            }
        }

        time.Sleep(backoff)
        if backoff < maxBackoff {
            backoff *= 2
        }
    }
}
```

### When to Use Lock-Free

Most Go services never need lock-free data structures. A well-tuned `sync.Mutex` or `sync.RWMutex` handles the vast majority of concurrency requirements with far less implementation risk. Lock-free techniques become worth the complexity only when CPU profiling shows that lock contention, visible as high `runtime.mutex` or `runtime.semacquire` time in `pprof` traces, is a measurable bottleneck that cannot be resolved by reducing critical section duration or sharding the data.

**Advantages:**
- No lock contention or convoy effects
- No deadlock possibility, progress is guaranteed at the system level
- Better throughput under sustained high contention from many goroutines

**Disadvantages:**
- Substantially harder to implement correctly and to review
- Subtle bugs (ABA problem, memory ordering violations) that may not manifest during testing
- Often not faster than well-designed locks for moderate contention levels

**Use lock-free when:**
- Profiling shows lock contention is the dominant bottleneck
- The critical operation is simple (increment, push/pop, pointer swap)
- You have verified correctness under the race detector and stress testing

### Staff Lens: The Lock-Free Correctness Bar

A hand-rolled lock-free data structure has a correctness cost that most teams underestimate. Algorithms published in academic papers often have subtle requirements (fences, retry conditions, memory reclamation) that are easy to get wrong. The bar for shipping lock-free code to production:

1. **Algorithm is from a peer-reviewed source.** Not a blog post. A textbook or paper.
2. **Implementation is reviewed by at least two engineers with lock-free experience.** This is a specialist skill, not general.
3. **Correctness is verified under the race detector, stress testing, and long-running production canary.** Not just unit tests.
4. **An owner commits to maintaining it for at least three years.** Lock-free code does not age well without care.

If any of these four is missing, use a mutex. Teams that meet this bar can ship lock-free code successfully. Teams that do not ship bugs that appear months later under specific load conditions.

### Principal Lens: Lock-Free as a Sign of Design Smell

A Go service that needs lock-free data structures is often a service that is carrying shared state that should not exist. The principal-level question: can we eliminate the shared state entirely (per-goroutine ownership, sharding, immutability) rather than optimizing access to it? The answer is usually yes. Lock-free is the last resort. Redesigning the shared state out of existence is usually the better answer, though more disruptive.

---
