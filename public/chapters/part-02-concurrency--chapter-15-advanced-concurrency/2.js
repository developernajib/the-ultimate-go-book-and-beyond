export default `## 15.1 Lock-Free Data Structures

Lock-free programming eliminates mutual exclusion entirely. Instead of mutexes, lock-free algorithms coordinate access to shared data through atomic operations, primarily compare-and-swap (CAS). Under high contention, this avoids the convoy effect where goroutines queue behind a single lock holder, but the trade-off is substantially more complex code that must handle retry loops, memory ordering, and subtle correctness pitfalls like the ABA problem.

### Understanding Lock-Free vs Lock-Based

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                   Concurrency Approaches                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Lock-Based (Mutex)              Lock-Free (Atomic CAS)             │
│  ┌─────────────────┐            ┌─────────────────────┐             │
│  │ Goroutine 1     │            │ Goroutine 1         │             │
│  │ ┌───────────┐   │            │ ┌─────────────────┐ │             │
│  │ │Lock()     │   │            │ │CAS(old, new)    │ │             │
│  │ │  modify   │   │            │ │  if success:    │ │             │
│  │ │Unlock()   │   │            │ │    done         │ │             │
│  │ └───────────┘   │            │ │  else:          │ │             │
│  └────────┬────────┘            │ │    retry        │ │             │
│           │                      │ └─────────────────┘ │             │
│           ▼                      └──────────┬──────────┘             │
│  Other goroutines                           │                        │
│  WAIT in queue                   Other goroutines                   │
│                                  RETRY immediately                  │
│                                                                      │
│  Pros:                          Pros:                               │
│  - Simpler to reason about      - No blocking (progress guarantee)  │
│  - Easier to implement          - No deadlocks possible             │
│  - Good for long operations     - Better under high contention      │
│                                                                      │
│  Cons:                          Cons:                               │
│  - Can cause priority inversion - Complex to implement correctly    │
│  - Deadlock risk                - ABA problem                       │
│  - Blocking can waste CPU       - Only for simple operations        │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

### The ABA Problem

The ABA problem is a fundamental challenge in lock-free programming:

\`\`\`go
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
\`\`\`

### Solutions to the ABA Problem

**1. Tagged Pointers (Version Numbers)**

\`\`\`go
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
        oldPtr, version := UnpackTaggedPointer(oldHead)

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
        _, nextVersion := UnpackTaggedPointer(nextHead)
        newHead := PackTaggedPointer(
            unsafe.Pointer(uintptr(nextHead & 0x0000FFFFFFFFFFFF)),
            version+1,
        )

        if s.head.CompareAndSwap(oldHead, newHead) {
            return node.value, true
        }
    }
}
\`\`\`

**2. Using Go 1.19+ atomic.Pointer (Recommended)**

Go 1.19 introduced the generic \`atomic.Pointer[T]\` type, which replaces raw \`unsafe.Pointer\` manipulations with a type-safe API that the compiler can verify. Because \`atomic.Pointer\` stores a typed \`*T\`, the version counter is kept as a separate \`atomic.Uint64\` field rather than packed into unused pointer bits, this avoids the platform-specific bit-masking of the tagged-pointer approach and eliminates the risk of corrupting pointers on platforms that use more than 48 address bits.

\`\`\`go
// Modern Go approach using atomic.Pointer
// This is safer and clearer than unsafe.Pointer manipulations

type Node[T any] struct {
    value T
    next  atomic.Pointer[Node[T]]
}

type SafeStack[T any] struct {
    head    atomic.Pointer[Node[T]]
    version atomic.Uint64 // Separate version counter
}

func NewSafeStack[T any]() *SafeStack[T] {
    return &SafeStack[T]{}
}

func (s *SafeStack[T]) Push(value T) {
    node := &Node[T]{value: value}

    for {
        head := s.head.Load()
        node.next.Store(head)

        if s.head.CompareAndSwap(head, node) {
            s.version.Add(1) // Track modifications
            return
        }
        // CAS failed, another goroutine modified head
        // Retry with new head value
    }
}

func (s *SafeStack[T]) Pop() (T, bool) {
    for {
        head := s.head.Load()
        if head == nil {
            var zero T
            return zero, false
        }

        next := head.next.Load()

        if s.head.CompareAndSwap(head, next) {
            s.version.Add(1)
            return head.value, true
        }
        // CAS failed, retry
    }
}

func (s *SafeStack[T]) Peek() (T, bool) {
    head := s.head.Load()
    if head == nil {
        var zero T
        return zero, false
    }
    return head.value, true
}

func (s *SafeStack[T]) IsEmpty() bool {
    return s.head.Load() == nil
}
\`\`\`

### Lock-Free Queue (MPSC, Multiple Producer, Single Consumer)

The MPSC queue is commonly used for logging, metrics collection, and event processing:

\`\`\`go
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

    // Atomically swap tail, then link previous tail to new node
    for {
        tail := q.tail.Load()
        if q.tail.CompareAndSwap(tail, node) {
            // Successfully claimed this position
            tail.next.Store(node)
            return
        }
        // Another producer beat us, retry
    }
}

// Pop removes an item from the queue (only safe for single consumer)
func (q *MPSCQueue[T]) Pop() (T, bool) {
    head := q.head.Load()
    next := head.next.Load()

    if next == nil {
        var zero T
        return zero, false
    }

    // Move head to next
    q.head.Store(next)
    return next.value, true
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
\`\`\`

### Lock-Free Counter with Exponential Backoff

Under high contention, naive CAS loops can cause excessive retries as multiple goroutines repeatedly read the same value, attempt a CAS, fail, and immediately retry, generating cache line traffic that slows everyone down. Exponential backoff breaks this cycle by having goroutines wait progressively longer between retries, giving the successful goroutine time to complete its operation before others compete again.

\`\`\`go
// LockFreeCounter implements a high-performance counter
// with exponential backoff for contention management
type LockFreeCounter struct {
    value    int64
    _        [56]byte // Padding to prevent false sharing

    // Statistics
    casAttempts atomic.Uint64
    casFailures atomic.Uint64
}

func NewLockFreeCounter() *LockFreeCounter {
    return &LockFreeCounter{}
}

func (c *LockFreeCounter) Add(delta int64) int64 {
    backoff := 1
    maxBackoff := 1024

    for {
        c.casAttempts.Add(1)
        old := atomic.LoadInt64(&c.value)

        if atomic.CompareAndSwapInt64(&c.value, old, old+delta) {
            return old + delta
        }

        // CAS failed - apply backoff
        c.casFailures.Add(1)

        // Exponential backoff with jitter
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
\`\`\`

### TTAS (Test-and-Test-and-Set) Optimization

A naive spinlock that calls \`Swap\` in a tight loop generates a bus write on every iteration, even when the lock is held. The TTAS pattern avoids this by first performing a read-only \`Load\`, which can be satisfied from the local CPU cache without bus traffic, and only attempting the expensive \`Swap\` when the load indicates the lock is free. This distinction matters because cache-coherent reads are cheap (local cache hit) while atomic read-modify-write operations force exclusive cache line ownership.

\`\`\`go
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

// LockWithBackoff uses exponential backoff
func (l *TTASLock) LockWithBackoff() {
    backoff := time.Nanosecond * 100
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
\`\`\`

### When to Use Lock-Free

Most Go services never need lock-free data structures. A well-tuned \`sync.Mutex\` or \`sync.RWMutex\` handles the vast majority of concurrency requirements with far less implementation risk. Lock-free techniques become worth the complexity only when CPU profiling shows that lock contention, visible as high \`runtime.mutex\` or \`runtime.semacquire\` time in \`pprof\` traces, is a measurable bottleneck that cannot be resolved by reducing critical section duration or sharding the data.

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

A Go service that needs lock-free data structures is often a service that is carrying shared state that should not exist. The principal-level question: can we eliminate the shared state entirely (per-goroutine ownership, sharding, immutability) rather than optimising access to it? The answer is usually yes. Lock-free is the last resort. Redesigning the shared state out of existence is usually the better answer, though more disruptive.

---
`;
