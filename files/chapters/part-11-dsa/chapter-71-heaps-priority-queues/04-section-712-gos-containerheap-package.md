## 71.2 Go's container/heap Package

Go's `container/heap` package provides heap operations over any type that satisfies `heap.Interface`, which combines `sort.Interface` (`Len`, `Less`, `Swap`) with `Push` and `Pop` methods. The `Less` function determines the heap order: returning `h[i] < h[j]` creates a min-heap while `h[i] > h[j]` creates a max-heap, making it straightforward to adapt for any ordering requirement.

```go
package main

import (
    "container/heap"
    "fmt"
)

// IntHeap is a min-heap of ints
type IntHeap []int

func (h IntHeap) Len() int           { return len(h) }
func (h IntHeap) Less(i, j int) bool { return h[i] < h[j] } // min-heap
func (h IntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *IntHeap) Push(x any) {
    *h = append(*h, x.(int))
}

func (h *IntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// Using the heap
func UseIntHeap() {
    h := &IntHeap{3, 1, 4, 1, 5, 9, 2, 6}
    heap.Init(h)

    heap.Push(h, 0)

    for h.Len() > 0 {
        fmt.Printf("%d ", heap.Pop(h))
    }
    // Output: 0 1 1 2 3 4 5 6 9
}

// For max-heap, change Less to: return h[i] > h[j]
type MaxIntHeap []int

func (h MaxIntHeap) Len() int           { return len(h) }
func (h MaxIntHeap) Less(i, j int) bool { return h[i] > h[j] } // max-heap
func (h MaxIntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MaxIntHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MaxIntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

### Priority Queue with Custom Type

When heap elements carry domain data beyond a plain integer, embed the priority inside a struct and implement `heap.Interface` over a slice of pointers to that struct. Storing the element's current slice index in the `index` field is what makes `heap.Fix` possible: after mutating a priority in-place, `heap.Fix` sifts the element up or down in O(log n) without a full rebuild, enabling efficient priority updates required by algorithms like Dijkstra's.

```go
package main

import (
    "container/heap"
)

// Task represents a task with priority
type Task struct {
    name     string
    priority int
    index    int // for heap.Fix
}

// PriorityQueue implements heap.Interface
type PriorityQueue []*Task

func (pq PriorityQueue) Len() int { return len(pq) }

func (pq PriorityQueue) Less(i, j int) bool {
    // Higher priority = smaller number (min-heap on priority)
    return pq[i].priority < pq[j].priority
}

func (pq PriorityQueue) Swap(i, j int) {
    pq[i], pq[j] = pq[j], pq[i]
    pq[i].index = i
    pq[j].index = j
}

func (pq *PriorityQueue) Push(x any) {
    n := len(*pq)
    task := x.(*Task)
    task.index = n
    *pq = append(*pq, task)
}

func (pq *PriorityQueue) Pop() any {
    old := *pq
    n := len(old)
    task := old[n-1]
    old[n-1] = nil // avoid memory leak
    task.index = -1
    *pq = old[:n-1]
    return task
}

// UpdatePriority modifies the priority of a task
func (pq *PriorityQueue) UpdatePriority(task *Task, priority int) {
    task.priority = priority
    heap.Fix(pq, task.index)
}

// UsePriorityQueue demonstrates usage
func UsePriorityQueue() {
    pq := make(PriorityQueue, 0)
    heap.Init(&pq)

    // Add tasks
    tasks := []*Task{
        {name: "task1", priority: 3},
        {name: "task2", priority: 1},
        {name: "task3", priority: 2},
    }

    for _, task := range tasks {
        heap.Push(&pq, task)
    }

    // Process in priority order
    for pq.Len() > 0 {
        task := heap.Pop(&pq).(*Task)
        _ = task.name // process task
    }
}
```

### Index-Tracked Priority Queue

A plain heap cannot locate an arbitrary element faster than O(n), making targeted updates or removals expensive. The `IndexedPQ` solves this by maintaining a separate `map[string]int` that maps each item's key to its current position in the backing slice. Every `Swap` call keeps this map in sync, so `Update` and `Remove` can jump directly to any element in O(1) lookup followed by an O(log n) sift.

```go
package main

import (
    "container/heap"
)

// IndexedPQ supports efficient update and removal by key
type IndexedPQ struct {
    items []*Item
    index map[string]int // key -> index in items
}

type Item struct {
    key      string
    priority int
}

func NewIndexedPQ() *IndexedPQ {
    return &IndexedPQ{
        items: make([]*Item, 0),
        index: make(map[string]int),
    }
}

func (pq IndexedPQ) Len() int { return len(pq.items) }

func (pq IndexedPQ) Less(i, j int) bool {
    return pq.items[i].priority < pq.items[j].priority
}

func (pq IndexedPQ) Swap(i, j int) {
    pq.items[i], pq.items[j] = pq.items[j], pq.items[i]
    pq.index[pq.items[i].key] = i
    pq.index[pq.items[j].key] = j
}

func (pq *IndexedPQ) Push(x any) {
    item := x.(*Item)
    pq.index[item.key] = len(pq.items)
    pq.items = append(pq.items, item)
}

func (pq *IndexedPQ) Pop() any {
    old := pq.items
    n := len(old)
    item := old[n-1]
    old[n-1] = nil
    delete(pq.index, item.key)
    pq.items = old[:n-1]
    return item
}

// Contains checks if key exists
func (pq *IndexedPQ) Contains(key string) bool {
    _, ok := pq.index[key]
    return ok
}

// Update changes the priority of an item
func (pq *IndexedPQ) Update(key string, priority int) {
    if idx, ok := pq.index[key]; ok {
        pq.items[idx].priority = priority
        heap.Fix(pq, idx)
    }
}

// Remove removes an item by key
func (pq *IndexedPQ) Remove(key string) *Item {
    if idx, ok := pq.index[key]; ok {
        return heap.Remove(pq, idx).(*Item)
    }
    return nil
}

// Peek returns the minimum item without removing
func (pq *IndexedPQ) Peek() *Item {
    if len(pq.items) == 0 {
        return nil
    }
    return pq.items[0]
}
```

### Junior → FAANG: Mastering the container/heap Interface

The five methods of `heap.Interface` have a non-obvious split of responsibilities. `Len`, `Less`, and `Swap` belong to the underlying data, and you control them. `Push` and `Pop` are called by the package and have a strict contract: `Push` receives the raw element and appends it to the backing slice. `Pop` removes from the end of the slice (after the package has already moved the minimum to the last position) and returns it. Getting `Pop` wrong by removing from the front is the most common interface implementation bug.

The `heap.Fix(h, i)` function is underused by juniors but critical for Dijkstra's and any algorithm that needs to update a priority in place. Without `Fix`, updating a priority requires a Remove followed by a Push (two O(log n) operations with extra allocations). With `Fix`, it is a single O(log n) sift in the correct direction.

Practice drill: implement `IntHeap` and `PriorityQueue` from memory, then write a test that pushes ten items, updates the priority of one item using `heap.Fix`, and verifies that `Pop` returns elements in the expected order.

### Senior @ FAANG: IndexedPQ Design and Production Correctness

The `IndexedPQ` design above is the correct pattern for Dijkstra's, Prim's, and any scheduler that needs O(log n) priority updates on named entities. The map from key to index must be kept consistent in `Swap`, `Push`, and `Pop`. A common production bug is updating the index map in `Swap` but forgetting to clean it up in `Pop`, leading to stale entries that cause incorrect `Contains` checks.

Note what `heap.Remove(h, i)` actually does: it swaps element `i` with the last element, sifts the displaced element down and then up (the same repair `Fix` performs, though `Remove` calls the internal `down`/`up` directly rather than routing through `Fix`), and finally calls your `Pop` to detach the tail. Both directions of repair are attempted because the element swapped into position `i` may be smaller or larger than what was there. That is why your `Swap` must keep the index map current: `Remove` moves elements you never named.

Exposing `Remove` on an `IndexedPQ` is safe as long as the invariant "every live key maps to its true slice position" holds through every path. The pattern that breaks it is removing an item, mutating its priority, and reinserting it, while forgetting that `Pop` already deleted the key from the map. Reinsertion must go through `Push`, never a direct slice append.

None of this makes the structure goroutine-safe. `IndexedPQ` has no internal synchronization, so concurrent `Update` and `Pop` calls race on both the slice and the map, and a concurrent map write will panic outright rather than corrupt silently. Either guard it with a mutex or document it as single-threaded, and prefer the documentation when the queue already lives behind a single owning goroutine.

For genuinely concurrent priority queues, a common approach is a sharded design: several independent heaps partitioned by key hash, each with its own lock. This cuts contention at the cost of weaker global ordering, acceptable when each shard is an independent workload (per-user queues, per-region task pools). A single global heap serializes every operation behind one lock, so measure whether the lock is actually the bottleneck before sharding.
