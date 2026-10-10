## 68.1 Stack Implementation

### Slice-Based Stack

The simplest Go stack uses a slice as the underlying storage, appending on `Push` and shrinking the slice on `Pop`, both O(1) amortized thanks to Go's built-in slice growth strategy. Using a generic type parameter `T any` makes the stack reusable across any element type without sacrificing type safety.

```go
package stack

// Stack implements a generic stack using a slice
type Stack[T any] struct {
    items []T
}

// New creates an empty stack
func New[T any]() *Stack[T] {
    return &Stack[T]{}
}

// Push adds an element to the top
// Time: O(1) amortized
func (s *Stack[T]) Push(item T) {
    s.items = append(s.items, item)
}

// Pop removes and returns the top element
// Time: O(1)
func (s *Stack[T]) Pop() (T, bool) {
    var zero T
    if len(s.items) == 0 {
        return zero, false
    }

    last := len(s.items) - 1
    top := s.items[last]

    // Required: reslicing only moves len, it does not touch the backing
    // array. Without this write the popped element is still stored in the
    // array beyond len, so if T contains a pointer the GC still sees it and
    // the object it points to can never be reclaimed. The stack reports
    // empty while pinning everything ever pushed into it.
    s.items[last] = zero

    s.items = s.items[:last]
    return top, true
}

// Peek returns the top element without removing it
// Time: O(1)
func (s *Stack[T]) Peek() (T, bool) {
    var zero T
    if len(s.items) == 0 {
        return zero, false
    }
    return s.items[len(s.items)-1], true
}

// Size returns the number of elements
func (s *Stack[T]) Size() int {
    return len(s.items)
}

// IsEmpty returns true if the stack is empty
func (s *Stack[T]) IsEmpty() bool {
    return len(s.items) == 0
}

// Clear removes all elements
func (s *Stack[T]) Clear() {
    s.items = nil
}
```

### Linked List-Based Stack

A linked-list stack prepends new nodes at the head on every `Push` and removes the head on `Pop`, keeping both operations at a strict O(1) without the occasional reallocation overhead that a growing slice can incur. This approach trades slightly higher per-element memory use (each node carries a pointer) for fully predictable allocation behavior, which matters in latency-sensitive contexts.

```go
package stack

// ListNode represents a node in the linked list stack
type ListNode[T any] struct {
    val  T
    next *ListNode[T]
}

// LinkedStack implements a stack using a linked list
type LinkedStack[T any] struct {
    top  *ListNode[T]
    size int
}

// NewLinkedStack creates an empty linked list stack
func NewLinkedStack[T any]() *LinkedStack[T] {
    return &LinkedStack[T]{}
}

// Push adds an element to the top
// Time: O(1)
func (s *LinkedStack[T]) Push(item T) {
    s.top = &ListNode[T]{val: item, next: s.top}
    s.size++
}

// Pop removes and returns the top element
// Time: O(1)
func (s *LinkedStack[T]) Pop() (T, bool) {
    var zero T
    if s.top == nil {
        return zero, false
    }

    val := s.top.val
    s.top = s.top.next
    s.size--
    return val, true
}

// Peek returns the top element without removing it
// Time: O(1)
func (s *LinkedStack[T]) Peek() (T, bool) {
    var zero T
    if s.top == nil {
        return zero, false
    }
    return s.top.val, true
}

// Size returns the number of elements
func (s *LinkedStack[T]) Size() int {
    return s.size
}

// IsEmpty returns true if the stack is empty
func (s *LinkedStack[T]) IsEmpty() bool {
    return s.top == nil
}
```

### Thread-Safe Stack

When multiple goroutines share a stack, unprotected concurrent reads and writes cause data races that corrupt state. The `ConcurrentStack` wraps the slice with a `sync.RWMutex`, acquiring an exclusive write lock for `Push` and `Pop` while allowing concurrent read locks for the non-mutating `Peek` and `Size` calls, minimizing lock contention without sacrificing correctness.

```go
package stack

import "sync"

// ConcurrentStack is a thread-safe stack
type ConcurrentStack[T any] struct {
    items []T
    mu    sync.RWMutex
}

// NewConcurrent creates a thread-safe stack
func NewConcurrent[T any]() *ConcurrentStack[T] {
    return &ConcurrentStack[T]{}
}

// Push adds an element atomically
func (s *ConcurrentStack[T]) Push(item T) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.items = append(s.items, item)
}

// Pop removes and returns the top element atomically
func (s *ConcurrentStack[T]) Pop() (T, bool) {
    s.mu.Lock()
    defer s.mu.Unlock()

    var zero T
    if len(s.items) == 0 {
        return zero, false
    }

    last := len(s.items) - 1
    top := s.items[last]
    s.items[last] = zero // clear the slot; see Stack.Pop
    s.items = s.items[:last]
    return top, true
}

// Peek returns the top element without removing it
func (s *ConcurrentStack[T]) Peek() (T, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    var zero T
    if len(s.items) == 0 {
        return zero, false
    }
    return s.items[len(s.items)-1], true
}

// Size returns the number of elements
func (s *ConcurrentStack[T]) Size() int {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return len(s.items)
}
```

### The Popped-Slot Leak

The single line `s.items[last] = zero` in `Pop` is the most commonly omitted line in slice-backed stacks, and its absence is invisible until it is expensive. Reslicing with `s.items[:last]` changes only the length field of the slice header. The backing array is untouched, and the element sitting at index `last` is still there, still a live pointer as far as the garbage collector is concerned, because the array itself is reachable and the GC scans the whole allocation rather than only the first `len` entries.

The consequence is a stack that reports `Size() == 0` while holding every object ever pushed through it. Push 500 pointers to 64KB buffers, pop all 500, and a stack that claims to be empty still pins 31MB. Clear the slot on the way out and the same workload retains nothing. A long-lived worker that reuses one stack across requests turns this into a leak that grows to the high-water mark of stack depth and never recedes.

This generalizes past stacks. It is the same reason `slices.Delete` zeroes the tail it shifts away, and the same reason `container/list.Remove` nils the removed element's pointers. Any time you shrink a slice of pointer-containing values, ask what is still sitting past `len`.

Two refinements worth knowing. If `T` is a pointer-free type such as `int`, the write is pure overhead: the GC never scans those bytes, so there is nothing to release. The compiler cannot elide it for you in the generic case, so a specialized `Stack[int]` may legitimately omit it. And `Clear` here assigns `s.items = nil`, which drops the entire backing array at once and is correct as written, though it also throws away the capacity, so a stack that is cleared and refilled repeatedly will pay to regrow. `s.items = s.items[:0]` keeps the capacity but keeps every element alive, which is the leak again wearing a different hat. If you want both, clear the elements and then reslice to zero length.

### Junior -> FAANG: Stack Implementation as Interview Fluency

The three stack implementations in this section represent a progression: slice-based for simplicity, linked list for strict O(1) guarantee, concurrent for multi-goroutine correctness. In interviews, you will almost always use the slice-based variant. Practice writing it from memory in under sixty seconds.

The generic type parameter `[T any]` makes the stack type-safe and reusable. Before Go 1.18, you would use `interface{}` and type assertions, which is less safe. If an interviewer asks you to implement a stack in Go, use generics unless they specify a specific element type.

**The zero-value idiom:** `var zero T` provides a correctly typed zero value for any type T. This pattern appears in both `Pop` and `Peek` to return a zero value when the stack is empty, alongside a boolean `ok` flag. This is idiomatic Go: returning `(T, bool)` rather than panicking or returning -1 (which would not work for non-integer types).

**Linked list stack: when to prefer it.** The slice stack's amortized O(1) push hides occasional O(n) reallocations when the slice must grow. For algorithms where every push must complete in constant time (hard real-time systems, latency-sensitive request processing), the linked list stack eliminates these spikes. Mention this trade-off in an interview if the interviewer asks about your implementation choice.

**Concurrent stack: lock granularity.** The `ConcurrentStack` uses `sync.RWMutex` with a read lock for `Peek` and `Size`, and a write lock for `Push` and `Pop`. This is correct but may be over-engineered for stacks: if `Push` and `Pop` are more frequent than `Peek` and `Size`, the read lock provides no benefit. A single `sync.Mutex` with uniform locking is simpler and equally correct.

### Senior @ FAANG: Stack API Design and Concurrency Correctness

**API design: the (T, bool) return pattern.** The `Pop() (T, bool)` signature is the idiomatic Go approach for operations that may not find a value. An alternative is a separate `IsEmpty() bool` method and a panic-on-empty `Pop() T`, which is the approach used by Java's `Stack` class and is the source of countless `EmptyStackException` bugs. The `(T, bool)` pattern moves the error handling responsibility to the caller, where it belongs. A production library should document whether calling `Pop` on an empty stack panics or returns `(zero, false)` and test both behaviors.

**Concurrent stack correctness under composition.** The `ConcurrentStack` is safe for individual `Push` and `Pop` calls but not for composed operations. A `PopIfNotEmpty` pattern that checks `IsEmpty` and then calls `Pop` is not atomic: another goroutine may push or pop between the two calls. Correct composed operations require either holding the lock externally or providing a single method like `TryPop() (T, bool)` that performs the check and removal atomically under one lock acquisition. Code reviews of concurrent stack usage should flag all check-then-act patterns.

**Memory model consideration.** In the `ConcurrentStack`, `s.items = s.items[:len(s.items)-1]` in `Pop` modifies the slice header under a write lock. The Go memory model guarantees that the write lock release happens-before the subsequent read lock acquisition, so any goroutine that calls `Peek` after `Pop` completes will see the updated slice. However, if a goroutine holds a direct reference to a stack element (e.g., a pointer into the slice), that reference may be stale after a `grow` operation recopies the slice to a new backing array. Documenting that the `ConcurrentStack` does not guarantee pointer stability is an L5 API design concern.

**Bar-raiser: lock-free stack.** A lock-free stack using `sync/atomic.CompareAndSwap` on the head pointer achieves O(1) amortized push and pop without any mutex acquisition. The ABA problem (a node is popped, another node with the same address is pushed, and the compare-and-swap incorrectly succeeds) is the primary correctness concern. Go's garbage collector helps here in a specific way worth stating precisely: as long as a goroutine holds a pointer to a node, that node is reachable and its memory cannot be handed out for a different node, so the classic ABA cycle of free-then-reallocate-same-address cannot occur. That guarantee evaporates the moment you recycle nodes yourself through a `sync.Pool` or a free list, because now the same address legitimately returns while another goroutine still holds a stale pointer to it. Articulating this trade-off, and noting that the usual next question is whether the lock-free version actually wins, is an L6-level signal. It often does not: a CAS loop on a single head pointer puts every goroutine in contention on one cache line, and a plain mutex frequently beats it under high contention while being far easier to get right.
