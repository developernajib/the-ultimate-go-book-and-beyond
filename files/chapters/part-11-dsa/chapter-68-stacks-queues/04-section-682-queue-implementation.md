## 68.2 Queue Implementation

### Slice-Based Queue

A slice-based queue is the simplest Go queue implementation, using `append` for O(1) amortized enqueue and slice re-slicing for dequeue. The generic type parameter `T any` allows the same queue to store integers, strings, or any custom type without code duplication.

It is worth correcting a widespread myth right here, because it is repeated constantly and it is false: `q.items = q.items[1:]` is **not** O(n) and it does not shift the array. A slice is a three-word header of pointer, length, and capacity. Reslicing writes a new header that starts one element further along the *same* backing array. Nothing is copied. Draining ten million elements this way takes a few milliseconds, which would be impossible if each dequeue copied the remainder.

The real cost is memory, not time. The backing array only ever grows, the space in front of the head is never reused, and every dequeued element remains inside the array and therefore reachable by the collector. A queue drained to `len == 0` still holds every object it ever carried. That is why the ring buffer below exists, and why the linked list variant exists. Neither is faster per operation. Both bound the memory.

```go
package queue

// Queue implements a generic queue using a slice
type Queue[T any] struct {
    items []T
}

// New creates an empty queue
func New[T any]() *Queue[T] {
    return &Queue[T]{}
}

// Enqueue adds an element to the back
// Time: O(1) amortized
func (q *Queue[T]) Enqueue(item T) {
    q.items = append(q.items, item)
}

// Dequeue removes and returns the front element
// Time: O(1). Space: the backing array never shrinks, so a long-lived
// queue drained this way retains everything it ever held. Bounded use
// (a BFS over one input) is fine - a long-running service is not.
func (q *Queue[T]) Dequeue() (T, bool) {
    var zero T
    if len(q.items) == 0 {
        return zero, false
    }

    front := q.items[0]

    // Clear the slot before advancing. The element stays inside the
    // backing array once the header moves past it, so without this a
    // pointer element is pinned for the lifetime of the array.
    q.items[0] = zero

    q.items = q.items[1:]
    return front, true
}

// Front returns the front element without removing it
// Time: O(1)
func (q *Queue[T]) Front() (T, bool) {
    var zero T
    if len(q.items) == 0 {
        return zero, false
    }
    return q.items[0], true
}

// Size returns the number of elements
func (q *Queue[T]) Size() int {
    return len(q.items)
}

// IsEmpty returns true if the queue is empty
func (q *Queue[T]) IsEmpty() bool {
    return len(q.items) == 0
}
```

### Circular Queue (Ring Buffer)

A circular queue (ring buffer) solves the slice queue's *memory* problem by treating a fixed-size array as if its ends wrap around, reusing the space in front of the head instead of abandoning it. Modular arithmetic advances the `front` and `rear` indices. Both enqueue and dequeue run in O(1), the same as the slice queue, but memory is now bounded by the capacity rather than by total throughput. The capacity is fixed at creation and cannot grow. This pattern is the basis of LeetCode 622 and is commonly used in producer-consumer scenarios where a bounded buffer is intentional.

The design decision worth noticing is the explicit `size` field. With only `front` and `rear`, the condition `front == rear` is ambiguous: it means empty on an empty ring and also means full on a full one, because `rear` has wrapped all the way around to meet `front`. There are three standard escapes. Keep an explicit count, as here. Or sacrifice one slot so the ring is considered full at `(rear+1)%capacity == front`, which trades a slot for a branch and is what many C implementations do. Or use free-running counters that are only reduced modulo capacity at indexing time, so `rear - front` is the true size, which is what Go's own `hchan` does with `qcount`. The `size` field is the clearest of the three and is the reason `IsFull` and `IsEmpty` here are one-liners with no off-by-one to reason about.

```go
package queue

// CircularQueue implements a fixed-size circular queue
type CircularQueue struct {
    items    []int
    front    int
    rear     int
    size     int
    capacity int
}

// NewCircular creates a circular queue with given capacity
func NewCircular(k int) *CircularQueue {
    return &CircularQueue{
        items:    make([]int, k),
        front:    0,
        rear:     0,
        size:     0,
        capacity: k,
    }
}

// Enqueue adds an element to the rear
// LeetCode 622: Design Circular Queue
func (q *CircularQueue) Enqueue(value int) bool {
    if q.IsFull() {
        return false
    }

    q.items[q.rear] = value
    q.rear = (q.rear + 1) % q.capacity
    q.size++
    return true
}

// Dequeue removes an element from the front
func (q *CircularQueue) Dequeue() bool {
    if q.IsEmpty() {
        return false
    }

    q.front = (q.front + 1) % q.capacity
    q.size--
    return true
}

// Front returns the front element
func (q *CircularQueue) Front() int {
    if q.IsEmpty() {
        return -1
    }
    return q.items[q.front]
}

// Rear returns the rear element
func (q *CircularQueue) Rear() int {
    if q.IsEmpty() {
        return -1
    }
    // rear points to next empty position
    return q.items[(q.rear-1+q.capacity)%q.capacity]
}

// IsEmpty returns true if queue is empty
func (q *CircularQueue) IsEmpty() bool {
    return q.size == 0
}

// IsFull returns true if queue is full
func (q *CircularQueue) IsFull() bool {
    return q.size == q.capacity
}
```

### Linked List Queue (O(1) Dequeue)

The linked list queue achieves true O(1) enqueue and dequeue by maintaining explicit `front` and `rear` node pointers, so no element shifting is ever needed. Each `Enqueue` call allocates a new node and links it at the rear. Each `Dequeue` simply advances the `front` pointer and lets the garbage collector reclaim the old node. This is the preferred implementation when queue size is unpredictable and you want constant-time operations without a fixed capacity ceiling.

```go
package queue

// ListNode represents a node in the queue
type ListNode[T any] struct {
    val  T
    next *ListNode[T]
}

// LinkedQueue implements a queue using a linked list
type LinkedQueue[T any] struct {
    front *ListNode[T]
    rear  *ListNode[T]
    size  int
}

// NewLinkedQueue creates an empty linked queue
func NewLinkedQueue[T any]() *LinkedQueue[T] {
    return &LinkedQueue[T]{}
}

// Enqueue adds an element to the rear
// Time: O(1)
func (q *LinkedQueue[T]) Enqueue(item T) {
    newNode := &ListNode[T]{val: item}

    if q.rear == nil {
        q.front = newNode
        q.rear = newNode
    } else {
        q.rear.next = newNode
        q.rear = newNode
    }
    q.size++
}

// Dequeue removes and returns the front element
// Time: O(1)
func (q *LinkedQueue[T]) Dequeue() (T, bool) {
    var zero T
    if q.front == nil {
        return zero, false
    }

    old := q.front
    val := old.val
    q.front = old.next

    // Setting rear to nil when the queue empties is not bookkeeping
    // pedantry. Skip it and rear still points at the removed node, so the
    // next Enqueue links onto a node that is no longer in the queue and
    // the new element is unreachable from front.
    if q.front == nil {
        q.rear = nil
    }

    // Unlink the removed node so it cannot pin the rest of the queue.
    old.next = nil

    q.size--
    return val, true
}

// Front returns the front element without removing it
// Time: O(1)
func (q *LinkedQueue[T]) Front() (T, bool) {
    var zero T
    if q.front == nil {
        return zero, false
    }
    return q.front.val, true
}

// Size returns the number of elements
func (q *LinkedQueue[T]) Size() int {
    return q.size
}

// IsEmpty returns true if the queue is empty
func (q *LinkedQueue[T]) IsEmpty() bool {
    return q.front == nil
}
```

### Junior -> FAANG: Queue Implementation Choice for Interviews

The three queue implementations represent increasing implementation complexity and decreasing ease of misuse. For interview purposes, choose based on context.

**Slice queue:** Use this for BFS problems where the queue size is bounded by the input size. Dequeue is O(1), so the concern is never speed. The concern is that the memory high-water mark equals everything ever enqueued, which is exactly fine when the traversal visits each node once and the function then returns. Most BFS interview problems fall into this category.

**Circular queue:** Use this when the interviewer asks you to "implement a circular queue" (LeetCode 622) or when you need a fixed-capacity bounded buffer with O(1) enqueue and dequeue. The modular arithmetic `(rear + 1) % capacity` is the key idiom to memorize.

**Linked list queue:** Use this when you need unbounded O(1) enqueue and dequeue with memory proportional to the *current* contents rather than to total throughput. The key implementation detail is maintaining both `front` and `rear` pointers: `rear` is updated on enqueue, `front` on dequeue, and `rear` must be nilled when the queue drains, or the next enqueue links onto a detached node and the element is lost. The empty-to-nonempty and nonempty-to-empty transitions are the only interesting cases in this structure, so test exactly those: enqueue then dequeue then enqueue again is the sequence that catches a missing `rear = nil`.

**Common interview bug in slice queues:** The `q.items = q.items[1:]` re-slice in `Dequeue` creates a new slice header pointing one element forward. It is O(1) in time, and it never frees the old head element. Say this correctly if it comes up, because "slicing is O(n)" is a claim many candidates repeat and it is wrong. The cost is retention, not copying. For interview problems the retention is bounded and irrelevant. For a long-lived production queue, use a ring buffer or a linked list queue.

**Interview habit:** When you use a slice as a BFS queue, name your variable `queue` not `q` and write a comment at the first `queue = queue[1:]` line saying "O(1) dequeue - backing array is never reclaimed, bounded by input size here." That sentence demonstrates you know both the real cost and why it does not matter for this problem, which is a much stronger signal than repeating a complexity number you have not checked.

### Senior @ FAANG: Queue Design for Production Systems

**Circular queue as a hardware-aligned buffer.** Ring buffers (circular queues) are the standard implementation for inter-process communication and DMA transfer buffers in operating systems because they require only two indices (front and rear) and a fixed-size array, which maps directly to cache lines and avoids pointer chasing. In Go microservices, a circular buffer is the right implementation for a metrics ring buffer (keep the last N measurements for rolling percentile computation) and a network receive buffer (fixed-size, head drops when full).

**Linked list queue and GC pressure.** Every `Enqueue` in the linked list queue allocates a new node. For high-frequency queues (thousands of enqueues per second), this creates significant GC pressure because the collector must trace each new allocation. The production fix is a sync.Pool of pre-allocated nodes, where `Enqueue` gets a node from the pool and `Dequeue` returns it. This converts allocation pressure into pool contention, which is measured separately and is usually lower. Document the pool strategy in the implementation's godoc.

**ADR: channel vs. linked list queue for producer-consumer.** Go channels are the idiomatic choice for producer-consumer patterns when: (1) producers and consumers are goroutines, (2) blocking semantics (producer blocks when full) are desired for back-pressure, (3) `select` over multiple queues is needed. Linked list queues are the right choice when: (1) the queue must be non-blocking (try-enqueue returns immediately), (2) multiple consumers drain the same queue without goroutine context (synchronous processing), (3) queue inspection (current size, oldest element without dequeue) is required. Document this choice in the design document for any system that uses a queue as a primary data flow mechanism.

**Thread-safe queue: RWMutex vs. sync.Mutex.** For a queue where enqueue and dequeue both require exclusive access (both modify the slice or front/rear pointers), `sync.RWMutex` provides no benefit over `sync.Mutex`. Read locks are only useful for `Peek` and `IsEmpty`. A queue used primarily for enqueue/dequeue should use `sync.Mutex` to avoid the overhead of `RWMutex` acquisition protocol for write-heavy workloads. Profile before choosing.
