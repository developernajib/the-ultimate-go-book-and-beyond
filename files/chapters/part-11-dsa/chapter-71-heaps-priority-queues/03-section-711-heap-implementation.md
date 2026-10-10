## 71.1 Heap Implementation

### Min-Heap

A heap stores elements in a complete binary tree mapped to an array where node `i`'s children are at indices `2i+1` and `2i+2`. The min-heap invariant (every parent is smaller than its children) is maintained by `siftUp` after insertion and `siftDown` after removal. Building a heap from an arbitrary slice using bottom-up heapify runs in O(n) by applying siftDown starting from the last non-leaf node, which is faster than n individual insertions.

```go
package heap

// MinHeap implements a min-heap
type MinHeap struct {
    items []int
}

// NewMinHeap creates an empty min-heap
func NewMinHeap() *MinHeap {
    return &MinHeap{}
}

// NewMinHeapFromSlice creates a min-heap from a slice
// Time: O(n) using heapify
func NewMinHeapFromSlice(items []int) *MinHeap {
    h := &MinHeap{items: make([]int, len(items))}
    copy(h.items, items)
    h.heapify()
    return h
}

// heapify builds a heap in O(n) time
func (h *MinHeap) heapify() {
    // Start from last non-leaf node and sift down
    for i := len(h.items)/2 - 1; i >= 0; i-- {
        h.siftDown(i)
    }
}

// Size returns the number of elements
func (h *MinHeap) Size() int {
    return len(h.items)
}

// IsEmpty returns true if the heap is empty
func (h *MinHeap) IsEmpty() bool {
    return len(h.items) == 0
}

// Peek returns the minimum element without removing it
// Time: O(1)
func (h *MinHeap) Peek() (int, bool) {
    if h.IsEmpty() {
        return 0, false
    }
    return h.items[0], true
}

// Push adds an element to the heap
// Time: O(log n)
func (h *MinHeap) Push(val int) {
    h.items = append(h.items, val)
    h.siftUp(len(h.items) - 1)
}

// Pop removes and returns the minimum element
// Time: O(log n)
func (h *MinHeap) Pop() (int, bool) {
    if h.IsEmpty() {
        return 0, false
    }

    min := h.items[0]
    lastIdx := len(h.items) - 1

    // Move last element to root
    h.items[0] = h.items[lastIdx]
    h.items = h.items[:lastIdx]

    // Restore heap property
    if !h.IsEmpty() {
        h.siftDown(0)
    }

    return min, true
}

// siftUp moves element up to restore heap property
func (h *MinHeap) siftUp(idx int) {
    for idx > 0 {
        parentIdx := (idx - 1) / 2
        if h.items[idx] >= h.items[parentIdx] {
            break
        }
        h.items[idx], h.items[parentIdx] = h.items[parentIdx], h.items[idx]
        idx = parentIdx
    }
}

// siftDown moves element down to restore heap property
func (h *MinHeap) siftDown(idx int) {
    n := len(h.items)

    for {
        smallest := idx
        leftChild := 2*idx + 1
        rightChild := 2*idx + 2

        if leftChild < n && h.items[leftChild] < h.items[smallest] {
            smallest = leftChild
        }
        if rightChild < n && h.items[rightChild] < h.items[smallest] {
            smallest = rightChild
        }

        if smallest == idx {
            break
        }

        h.items[idx], h.items[smallest] = h.items[smallest], h.items[idx]
        idx = smallest
    }
}

// UpdateKey updates the value at index and restores heap property
func (h *MinHeap) UpdateKey(idx int, newVal int) {
    if idx < 0 || idx >= len(h.items) {
        return
    }

    oldVal := h.items[idx]
    h.items[idx] = newVal

    if newVal < oldVal {
        h.siftUp(idx)
    } else {
        h.siftDown(idx)
    }
}

// Delete removes element at index
func (h *MinHeap) Delete(idx int) (int, bool) {
    if idx < 0 || idx >= len(h.items) {
        return 0, false
    }

    deleted := h.items[idx]
    lastIdx := len(h.items) - 1

    h.items[idx] = h.items[lastIdx]
    h.items = h.items[:lastIdx]

    if idx < len(h.items) {
        h.siftDown(idx)
        h.siftUp(idx)
    }

    return deleted, true
}
```

### Max-Heap

A max-heap is structurally identical to a min-heap but with the ordering inverted: the comparison in `siftUp` and `siftDown` uses `>` instead of `<`, keeping the largest element at the root. Converting between min and max heaps is therefore purely a matter of changing the comparison predicate, with no structural differences in the underlying array representation.

```go
package heap

// MaxHeap implements a max-heap
type MaxHeap struct {
    items []int
}

// NewMaxHeap creates an empty max-heap
func NewMaxHeap() *MaxHeap {
    return &MaxHeap{}
}

// NewMaxHeapFromSlice creates a max-heap from a slice
func NewMaxHeapFromSlice(items []int) *MaxHeap {
    h := &MaxHeap{items: make([]int, len(items))}
    copy(h.items, items)
    h.heapify()
    return h
}

func (h *MaxHeap) heapify() {
    for i := len(h.items)/2 - 1; i >= 0; i-- {
        h.siftDown(i)
    }
}

func (h *MaxHeap) Size() int     { return len(h.items) }
func (h *MaxHeap) IsEmpty() bool { return len(h.items) == 0 }

func (h *MaxHeap) Peek() (int, bool) {
    if h.IsEmpty() {
        return 0, false
    }
    return h.items[0], true
}

func (h *MaxHeap) Push(val int) {
    h.items = append(h.items, val)
    h.siftUp(len(h.items) - 1)
}

func (h *MaxHeap) Pop() (int, bool) {
    if h.IsEmpty() {
        return 0, false
    }

    max := h.items[0]
    lastIdx := len(h.items) - 1
    h.items[0] = h.items[lastIdx]
    h.items = h.items[:lastIdx]

    if !h.IsEmpty() {
        h.siftDown(0)
    }

    return max, true
}

func (h *MaxHeap) siftUp(idx int) {
    for idx > 0 {
        parentIdx := (idx - 1) / 2
        if h.items[idx] <= h.items[parentIdx] {
            break
        }
        h.items[idx], h.items[parentIdx] = h.items[parentIdx], h.items[idx]
        idx = parentIdx
    }
}

func (h *MaxHeap) siftDown(idx int) {
    n := len(h.items)

    for {
        largest := idx
        leftChild := 2*idx + 1
        rightChild := 2*idx + 2

        if leftChild < n && h.items[leftChild] > h.items[largest] {
            largest = leftChild
        }
        if rightChild < n && h.items[rightChild] > h.items[largest] {
            largest = rightChild
        }

        if largest == idx {
            break
        }

        h.items[idx], h.items[largest] = h.items[largest], h.items[idx]
        idx = largest
    }
}
```

### Generic Heap

Go generics allow a single heap implementation parameterized over the element type and a comparison function, eliminating the need for separate min-heap and max-heap types. Passing `func(a, b T) bool { return a < b }` produces a min-heap and `func(a, b T) bool { return a > b }` produces a max-heap, with custom types supported through any comparison logic.

```go
package heap

// Heap implements a generic heap
type Heap[T any] struct {
    items   []T
    compare func(a, b T) bool // returns true if a has higher priority
}

// NewHeap creates a generic heap
func NewHeap[T any](compare func(a, b T) bool) *Heap[T] {
    return &Heap[T]{
        compare: compare,
    }
}

func (h *Heap[T]) Size() int     { return len(h.items) }
func (h *Heap[T]) IsEmpty() bool { return len(h.items) == 0 }

func (h *Heap[T]) Peek() (T, bool) {
    var zero T
    if h.IsEmpty() {
        return zero, false
    }
    return h.items[0], true
}

func (h *Heap[T]) Push(val T) {
    h.items = append(h.items, val)
    h.siftUp(len(h.items) - 1)
}

func (h *Heap[T]) Pop() (T, bool) {
    var zero T
    if h.IsEmpty() {
        return zero, false
    }

    top := h.items[0]
    lastIdx := len(h.items) - 1
    h.items[0] = h.items[lastIdx]
    h.items = h.items[:lastIdx]

    if !h.IsEmpty() {
        h.siftDown(0)
    }

    return top, true
}

func (h *Heap[T]) siftUp(idx int) {
    for idx > 0 {
        parentIdx := (idx - 1) / 2
        if !h.compare(h.items[idx], h.items[parentIdx]) {
            break
        }
        h.items[idx], h.items[parentIdx] = h.items[parentIdx], h.items[idx]
        idx = parentIdx
    }
}

func (h *Heap[T]) siftDown(idx int) {
    n := len(h.items)

    for {
        best := idx
        leftChild := 2*idx + 1
        rightChild := 2*idx + 2

        if leftChild < n && h.compare(h.items[leftChild], h.items[best]) {
            best = leftChild
        }
        if rightChild < n && h.compare(h.items[rightChild], h.items[best]) {
            best = rightChild
        }

        if best == idx {
            break
        }

        h.items[idx], h.items[best] = h.items[best], h.items[idx]
        idx = best
    }
}
```

### Junior → FAANG: Building Intuition for siftUp and siftDown

The two core operations are worth understanding separately before combining them into a heap.

`siftUp` runs after an insertion. You add the new element at the end of the array (rightmost position in the last level of the conceptual tree), then repeatedly compare it with its parent and swap upward until the heap invariant holds. The path from a leaf to the root has at most log n steps, which gives O(log n) worst case.

`siftDown` runs after a removal. When you extract the root (the minimum in a min-heap), you replace it with the last element (to avoid a gap), then compare it with its children and swap downward with the smaller child until the invariant holds. Again, at most log n swaps.

A common interview mistake is using `siftUp` where `siftDown` is needed and vice versa. The rule: insertion breaks the invariant upward (the new element might be smaller than its parent), so fix it by going up. Removal puts a large element at the root, which might be larger than its children, so fix it by going down.

The O(n) heapify trick (calling siftDown from `n/2 - 1` down to 0) surprises most juniors. The intuition is that leaves (the bottom half of the array) are already valid one-element heaps, so siftDown only needs to process the inner nodes. The mathematical proof sums the series of per-level work and converges to O(n), not O(n log n).

### Senior @ FAANG: Generic Heaps, Allocation Profiles, and Production Trade-offs

The generic `Heap[T any]` implementation above is idiomatic Go 1.18+ and avoids the boxing that `container/heap` forces on you, since its `Push`/`Pop` take and return `any`. A `Heap[int]` stores plain ints in a `[]int`, where `container/heap` would convert each value to an `any` on the way in and type-assert it back on the way out. It still pays a function-call overhead on every `compare` invocation, because the comparison is an indirect call through a stored `func(a, b T) bool` rather than inlined code. In most applications this is acceptable. In latency-critical paths (sub-microsecond event processing, order book management), measure before committing.

The `Delete` method in the `MinHeap` implementation calls both `siftDown` and `siftUp` because after swapping the target with the last element, the replacement might violate the invariant in either direction. Only one of the two calls will actually do any work, but both must be present for correctness. This is a subtle point that trips up candidates implementing arbitrary-index deletion for the first time.

For production Go services, the memory allocation profile matters as much as the algorithm complexity. A heap backed by `[]int` or a slice of structs avoids all allocations during steady-state operation. A heap backed by `[]*Task` allocates each task separately and gives the garbage collector a pointer to trace for every live element on every cycle. Switching from pointer to value types removes that scanning work entirely, which can be the difference between meeting and missing a tail-latency SLA. Measure it with `GODEBUG=gctrace=1` and a `pprof` allocation profile rather than assuming. A staff engineer makes this call deliberately, documents it in the ADR, and adds a benchmark test to prevent regression.
