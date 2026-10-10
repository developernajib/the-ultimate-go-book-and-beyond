## 68.3 Deque (Double-Ended Queue)

A deque generalizes both a stack and a queue by allowing push and pop at either end in O(1) amortized time. This makes it the right structure for problems that need access to both extremes simultaneously, such as sliding-window maximum, where you track candidates from the front and expire stale ones from the back.

The slice-backed implementation below is straightforward to reason about, and exactly one of its four operations is genuinely expensive. `PushFront` is O(n) because `append([]T{item}, d.items...)` allocates a fresh array and copies every element into it, on every call. `PopFront` is O(1): it reslices, which moves the header and copies nothing. Do not lump the two together. The costs are different, they have different causes, and only one of them is worth engineering around. The ring-buffer version that follows fixes `PushFront` and additionally bounds the memory that repeated `PopFront` calls would otherwise abandon.

```go
package deque

// Deque implements a double-ended queue
type Deque[T any] struct {
    items []T
}

// New creates an empty deque
func New[T any]() *Deque[T] {
    return &Deque[T]{}
}

// PushFront adds an element to the front
// Time: O(n) - allocates a new array and copies every element
func (d *Deque[T]) PushFront(item T) {
    d.items = append([]T{item}, d.items...)
}

// PushBack adds an element to the back
// Time: O(1) amortized
func (d *Deque[T]) PushBack(item T) {
    d.items = append(d.items, item)
}

// PopFront removes and returns the front element
// Time: O(1) - reslicing moves the header, it does not shift elements
func (d *Deque[T]) PopFront() (T, bool) {
    var zero T
    if len(d.items) == 0 {
        return zero, false
    }

    front := d.items[0]
    d.items[0] = zero // release the element before the header moves past it
    d.items = d.items[1:]
    return front, true
}

// PopBack removes and returns the back element
// Time: O(1)
func (d *Deque[T]) PopBack() (T, bool) {
    var zero T
    if len(d.items) == 0 {
        return zero, false
    }

    last := len(d.items) - 1
    back := d.items[last]
    d.items[last] = zero // release the element left beyond len
    d.items = d.items[:last]
    return back, true
}

// Front returns the front element
func (d *Deque[T]) Front() (T, bool) {
    var zero T
    if len(d.items) == 0 {
        return zero, false
    }
    return d.items[0], true
}

// Back returns the back element
func (d *Deque[T]) Back() (T, bool) {
    var zero T
    if len(d.items) == 0 {
        return zero, false
    }
    return d.items[len(d.items)-1], true
}

// Size returns the number of elements
func (d *Deque[T]) Size() int {
    return len(d.items)
}

// IsEmpty returns true if the deque is empty
func (d *Deque[T]) IsEmpty() bool {
    return len(d.items) == 0
}

// At returns the element at index i
func (d *Deque[T]) At(i int) (T, bool) {
    var zero T
    if i < 0 || i >= len(d.items) {
        return zero, false
    }
    return d.items[i], true
}
```

### Efficient Ring Buffer Deque

The ring buffer implementation achieves true O(1) amortized time for all four operations by storing elements in a fixed-capacity array and tracking the logical front with an integer index rather than physically moving data. `PushFront` decrements the front index with modular arithmetic (`(front - 1 + capacity) % capacity`), so it wraps around to the end of the array instead of shifting elements left. When the buffer is full, `grow` doubles capacity and copies elements in logical order, resetting `front` to zero to avoid wrap-around bugs after the resize.

```go
package deque

// RingDeque implements an efficient deque using a ring buffer
type RingDeque[T any] struct {
    items    []T
    front    int // index of front element
    size     int
    capacity int
}

// NewRing creates a ring buffer deque with initial capacity
func NewRing[T any](capacity int) *RingDeque[T] {
    if capacity < 1 {
        capacity = 8
    }
    return &RingDeque[T]{
        items:    make([]T, capacity),
        front:    0,
        size:     0,
        capacity: capacity,
    }
}

// grow doubles the capacity
func (d *RingDeque[T]) grow() {
    newCapacity := d.capacity * 2
    newItems := make([]T, newCapacity)

    // Copy elements in order
    for i := 0; i < d.size; i++ {
        newItems[i] = d.items[(d.front+i)%d.capacity]
    }

    d.items = newItems
    d.front = 0
    d.capacity = newCapacity
}

// PushFront adds an element to the front
// Time: O(1) amortized
func (d *RingDeque[T]) PushFront(item T) {
    if d.size == d.capacity {
        d.grow()
    }

    d.front = (d.front - 1 + d.capacity) % d.capacity
    d.items[d.front] = item
    d.size++
}

// PushBack adds an element to the back
// Time: O(1) amortized
func (d *RingDeque[T]) PushBack(item T) {
    if d.size == d.capacity {
        d.grow()
    }

    back := (d.front + d.size) % d.capacity
    d.items[back] = item
    d.size++
}

// PopFront removes and returns the front element
// Time: O(1)
func (d *RingDeque[T]) PopFront() (T, bool) {
    var zero T
    if d.size == 0 {
        return zero, false
    }

    item := d.items[d.front]
    d.items[d.front] = zero // slot is now outside the logical deque
    d.front = (d.front + 1) % d.capacity
    d.size--
    return item, true
}

// PopBack removes and returns the back element
// Time: O(1)
func (d *RingDeque[T]) PopBack() (T, bool) {
    var zero T
    if d.size == 0 {
        return zero, false
    }

    back := (d.front + d.size - 1) % d.capacity
    item := d.items[back]
    d.items[back] = zero // slot is now outside the logical deque
    d.size--
    return item, true
}

// Front returns the front element
func (d *RingDeque[T]) Front() (T, bool) {
    var zero T
    if d.size == 0 {
        return zero, false
    }
    return d.items[d.front], true
}

// Back returns the back element
func (d *RingDeque[T]) Back() (T, bool) {
    var zero T
    if d.size == 0 {
        return zero, false
    }
    back := (d.front + d.size - 1) % d.capacity
    return d.items[back], true
}

// Size returns the number of elements
func (d *RingDeque[T]) Size() int {
    return d.size
}

// IsEmpty returns true if empty
func (d *RingDeque[T]) IsEmpty() bool {
    return d.size == 0
}
```

Note that `grow` never shrinks. A ring deque that spikes to a million elements and then drains holds that capacity forever. That is usually the right default, since shrinking eagerly causes thrash when the size oscillates around a threshold, but it is a decision to make deliberately rather than by omission. If the deque is long-lived and its size is spiky, add a shrink that triggers only when the size stays below a quarter of capacity, so growing and shrinking cannot alternate on adjacent operations.

### Junior -> FAANG: When to Use a Deque and How to Implement It

A deque is required when a problem needs both ends simultaneously. The most common interview application is the sliding window maximum (LeetCode 239): you add new elements at the back and remove expired elements from the front, maintaining a decreasing invariant.

The slice-based `Deque` has an O(n) `PushFront`, because prepending allocates and copies, and an O(1) `PopFront`, because reslicing does neither. For interview purposes this is fine: sliding window problems push at the back and pop from both ends, and never prepend, so the one expensive operation is the one they never call. Say that explicitly if asked, rather than claiming the whole structure is O(n) at the front. If a problem does require frequent front insertion, reach for the ring buffer.

**Ring buffer deque: key idioms to memorize.** Two formulas matter:
- `PushFront` decrements front: `d.front = (d.front - 1 + d.capacity) % d.capacity`. The `+ d.capacity` prevents negative modulo.
- Back index: `back = (d.front + d.size) % d.capacity`. Access the last element at `(d.front + d.size - 1) % d.capacity`.

Practice writing `PushFront` and `PopFront` with these formulas until the modular arithmetic feels natural.

**Sliding window maximum implementation pattern.** In most interview problems, you will implement the monotonic deque inline rather than using the `Deque` struct directly. The inline version uses a `[]int` slice of indices and manually pops from back (to remove dominated elements) and from front (to remove expired elements). This is the pattern shown in section 68.7.

**First-job habit:** When you use a deque for a sliding window problem, write two comments: one explaining why you pop from the back ("remove elements smaller than the new element that can never be the maximum") and one explaining why you pop from the front ("remove elements outside the current window"). These comments prevent future reviewers from misunderstanding the invariant.

### Senior @ FAANG: Ring Buffer Deque as a Production Primitive

**Cache efficiency of the ring buffer.** The ring deque stores all elements in a single contiguous array with modular index arithmetic. Compared to a linked list deque (where each node is a separate allocation), the ring buffer has better cache performance because sequential access loads multiple elements per cache line, and it allocates once per growth rather than once per element. The gap is real and worth measuring, but quote your own numbers rather than a remembered multiplier: it depends entirely on element size, working set, and how badly the linked nodes end up scattered, and it shrinks toward nothing when the element is large enough that one per cache line is all you get either way.

**`grow` function correctness under wrap-around.** The `grow` method copies elements in logical order from `d.front` to `d.front + d.size`, using modular arithmetic (`(d.front+i)%d.capacity`), then resets `d.front = 0`. This is critical: if `grow` copied elements verbatim (including the gap), the logical order would be incorrect after reallocation. This is a subtle correctness requirement that must be covered by tests that trigger growth when the buffer has wrapped around (i.e., when `d.front > 0` at growth time). A test that only grows from an un-wrapped state (d.front = 0) will not catch this bug.

**ADR: ring deque vs. container/list for deque operations.** Go's `container/list` provides a doubly linked list that supports O(1) front and back operations. It is the right choice when: elements are heterogeneous (interface values) - the deque must support arbitrary middle insertions/deletions (list provides O(1) given a pointer), or the deque is rarely iterated sequentially. The ring buffer deque is the right choice when: elements are homogeneous (concrete type T) - the access pattern is sequential iteration and end access only, or cache efficiency is a measured concern.

**Monotonic deque as a streaming primitive.** The monotonic deque pattern (maintaining a decreasing deque of indices for sliding window maximum) is directly applicable to production streaming systems. A metrics pipeline that needs to emit the maximum value observed in any 60-second window can use a ring deque of (timestamp, value) pairs with the same algorithm: pop expired timestamps from the front, pop dominated values from the back, and read the current maximum from the front. The amortized cost is O(1) per event, which is a significant improvement over sorting the window or maintaining a heap (O(log k) per event for window size k).
