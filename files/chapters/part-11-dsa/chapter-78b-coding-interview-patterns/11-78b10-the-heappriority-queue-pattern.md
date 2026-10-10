## 78B.10 The Heap/Priority Queue Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│               HEAP / PRIORITY QUEUE PATTERN                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Min-Heap:       Max-Heap:                                      │
│       1               9                                         │
│      / \             / \                                        │
│     3   5           7   8                                       │
│    / \             / \                                          │
│   7   8           3   5                                         │
│                                                                 │
│  Go: container/heap interface                                   │
│  Push/Pop: O(log n)    Peek: O(1)                               │
│                                                                 │
│  Use: Top-K elements, merge K sorted lists/arrays,              │
│       running median, task scheduler                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Go's `container/heap` requires implementing the `heap.Interface`:

```go
import "container/heap"

// MinHeap of integers
type MinHeap []int

func (h MinHeap) Len() int            { return len(h) }
func (h MinHeap) Less(i, j int) bool  { return h[i] < h[j] }
func (h MinHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }

func (h *MinHeap) Push(x any) {
    *h = append(*h, x.(int))
}

func (h *MinHeap) Pop() any {
    old := *h
    n := len(old)
    val := old[n-1]
    *h = old[:n-1]
    return val
}
```

---

### Problem 1: Kth Largest Element in an Array (LC 215)

**Problem:** Find the kth largest element in an unsorted array.

**Approach:** Use a min-heap of size k. After processing all elements, the top of the heap is the kth largest.

```go
func findKthLargest(nums []int, k int) int {
    h := &MinHeap{}
    heap.Init(h)

    for _, num := range nums {
        heap.Push(h, num)
        if h.Len() > k {
            heap.Pop(h) // remove the smallest, keeping k largest
        }
    }

    return heap.Pop(h).(int)
}
```

**Time Complexity:** O(n log k). Each push and pop is O(log k).
**Space Complexity:** O(k).

**Edge cases:**
- k=1 → find max
- k=n → find min
- Duplicates in the array: "kth largest" counts positions, not distinct values, so `[3,3,3]` with k=2 is 3
- Alternative: Quickselect gives O(n) average and O(n²) worst case, though median-of-medians pivot selection makes it O(n) worst case at a constant-factor cost. Chapter 79 covers selection and top-k in depth. Prefer the heap when the input is a stream or when k is much smaller than n, since Quickselect needs the whole array in memory and reorders it

---

### Problem 2: Merge K Sorted Lists (LC 23)

**Problem:** Merge k sorted linked lists into one sorted linked list.

**Approach:** Use a min-heap to always pick the smallest head among all lists.

```go
type ListNode struct {
    Val  int
    Next *ListNode
}

// Heap of ListNode pointers
type ListNodeHeap []*ListNode

func (h ListNodeHeap) Len() int            { return len(h) }
func (h ListNodeHeap) Less(i, j int) bool  { return h[i].Val < h[j].Val }
func (h ListNodeHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *ListNodeHeap) Push(x any) { *h = append(*h, x.(*ListNode)) }
func (h *ListNodeHeap) Pop() any {
    old := *h
    n := len(old)
    val := old[n-1]
    *h = old[:n-1]
    return val
}

func mergeKLists(lists []*ListNode) *ListNode {
    h := &ListNodeHeap{}
    heap.Init(h)

    // Push all non-nil heads
    for _, head := range lists {
        if head != nil {
            heap.Push(h, head)
        }
    }

    dummy := &ListNode{}
    curr := dummy

    for h.Len() > 0 {
        node := heap.Pop(h).(*ListNode)
        curr.Next = node
        curr = curr.Next

        if node.Next != nil {
            heap.Push(h, node.Next)
        }
    }

    return dummy.Next
}
```

**Time Complexity:** O(N log k) where N = total nodes, k = number of lists.
**Space Complexity:** O(k) for the heap.

**Edge cases:**
- Empty lists array → nil
- Some lists are nil → skip them
- k=1 → return the single list
- All lists have one element

---

### Problem 3: Find Median from Data Stream (LC 295)

**Problem:** Design a data structure that supports adding integers and finding the median efficiently.

**Approach:** Use two heaps: a max-heap for the lower half and a min-heap for the upper half. Balance them so their sizes differ by at most 1.

```go
type MaxHeap []int

func (h MaxHeap) Len() int            { return len(h) }
func (h MaxHeap) Less(i, j int) bool  { return h[i] > h[j] } // max-heap
func (h MaxHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *MaxHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MaxHeap) Pop() any {
    old := *h
    n := len(old)
    val := old[n-1]
    *h = old[:n-1]
    return val
}

type MedianFinder struct {
    lo *MaxHeap // max-heap: lower half
    hi *MinHeap // min-heap: upper half
}

func MedianFinderConstructor() MedianFinder {
    lo := &MaxHeap{}
    hi := &MinHeap{}
    heap.Init(lo)
    heap.Init(hi)
    return MedianFinder{lo: lo, hi: hi}
}

func (mf *MedianFinder) AddNum(num int) {
    heap.Push(mf.lo, num)

    // Ensure all elements in lo <= all elements in hi
    if mf.lo.Len() > 0 && mf.hi.Len() > 0 && (*mf.lo)[0] > (*mf.hi)[0] {
        val := heap.Pop(mf.lo).(int)
        heap.Push(mf.hi, val)
    }

    // Balance sizes: lo can have at most 1 more element than hi
    if mf.lo.Len() > mf.hi.Len()+1 {
        val := heap.Pop(mf.lo).(int)
        heap.Push(mf.hi, val)
    } else if mf.hi.Len() > mf.lo.Len() {
        val := heap.Pop(mf.hi).(int)
        heap.Push(mf.lo, val)
    }
}

func (mf *MedianFinder) FindMedian() float64 {
    if mf.lo.Len() > mf.hi.Len() {
        return float64((*mf.lo)[0])
    }
    return float64((*mf.lo)[0]+(*mf.hi)[0]) / 2.0
}
```

**Time Complexity:** O(log n) for AddNum, O(1) for FindMedian.
**Space Complexity:** O(n).

The two steps in `AddNum` are doing different jobs and both are needed. The first restores the *ordering* invariant, that every element of `lo` is at most every element of `hi`, which can break because the new value was pushed into `lo` unconditionally. The second restores the *size* invariant. Moving `hi`'s minimum into `lo` cannot break the ordering, since that minimum is already at least everything in `lo`, which is why fixing size second is safe. Do these in the other order and the structure returns wrong medians on inputs that look fine in testing.

**Edge cases:**
- Single element → returned from `lo`, which is why `lo` is the heap allowed to be the larger one
- Two elements → average
- All same elements → that element
- Negative numbers
- FindMedian before any AddNum panics on `(*mf.lo)[0]`. The problem guarantees it will not happen. In production code this would return an error or an ok flag

---

### Problem 4: Top K Frequent Elements (LC 347)

**Problem:** Given an integer array `nums` and integer `k`, return the k most frequent elements.

**Approach:** Count frequencies, then use a min-heap of size k to find the top k.

```go
type FreqPair struct {
    val  int
    freq int
}

type FreqHeap []FreqPair

func (h FreqHeap) Len() int            { return len(h) }
func (h FreqHeap) Less(i, j int) bool  { return h[i].freq < h[j].freq } // min-heap by freq
func (h FreqHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *FreqHeap) Push(x any) { *h = append(*h, x.(FreqPair)) }
func (h *FreqHeap) Pop() any {
    old := *h
    n := len(old)
    val := old[n-1]
    *h = old[:n-1]
    return val
}

func topKFrequent(nums []int, k int) []int {
    // Count frequencies
    freq := make(map[int]int)
    for _, n := range nums {
        freq[n]++
    }

    // Use min-heap of size k
    h := &FreqHeap{}
    heap.Init(h)

    for val, count := range freq {
        heap.Push(h, FreqPair{val, count})
        if h.Len() > k {
            heap.Pop(h)
        }
    }

    result := make([]int, k)
    for i := k - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).(FreqPair).val
    }

    return result
}
```

**Time Complexity:** O(n log k). O(n) to count, then O(log k) per distinct element.
**Space Complexity:** O(n) for the frequency map.

**Edge cases:**
- k equals the number of unique elements → return all
- All elements the same → return that one element
- Ties at the k-th frequency: any of the tied elements is a valid answer and which one you get depends on heap order. If the interviewer wants a deterministic tie-break, that is a second key in `Less`, not an afterthought
- Alternative: bucket sort by frequency gives O(n), since frequencies are bounded by n. That beats the heap outright when k is close to the number of distinct values

---

### Junior → FAANG: Go's Heap Interface and Size-K Heap Discipline

Go's `container/heap` requires five methods: `Len`, `Less`, and `Swap` (this is `sort.Interface`, which `heap.Interface` embeds), plus `Push` and `Pop`. The confusion that bites everyone once is that your `Push`/`Pop` methods are not the operations you call. They are raw slice manipulation that the package calls for you: your `Push` appends to the end with no ordering work, and your `Pop` removes the last element, because `heap.Pop` has already swapped the root there. All the sifting lives in the package functions. Call `heap.Push(h, x)` and `heap.Pop(h)`. Calling `h.Push(x)` directly appends without restoring the heap invariant, and the result is a silently corrupt heap rather than an error.

The `Less` function determines heap order. `Less(i, j) bool` returning `true` when `h[i] < h[j]` gives a min-heap. Returning `true` when `h[i] > h[j]` gives a max-heap. Getting this backward is the most common Go heap bug, and it is easy to miss because the heap still compiles and runs but produces wrong output silently.

Size-K heap discipline: for "top K" problems, maintain a heap of exactly K elements. For top K largest, use a min-heap of size K: when the heap size exceeds K, pop the minimum. This ensures the K largest elements remain. Counterintuitively, a min-heap finds the K largest, and a max-heap finds the K smallest. State this explicitly in your interview to show you understand why.

Entry-level signal: explaining why the K-th largest element problem can be solved with a size-K min-heap in O(n log k) time and O(k) space rather than sorting in O(n log n) time and O(n) space. The heap approach is preferable when k is much smaller than n and especially when the input is a stream (you cannot sort a stream, but you can maintain a heap).

### Senior @ FAANG: Priority Queues in Scheduling and Event-Driven Systems

"Select the next task by priority" is the defining operation of a scheduler, and it is why schedulers reach for ordered structures. Linux is an instructive case: its long-lived CFS design kept runnable tasks in a red-black tree keyed on virtual runtime, and since 6.6 the mainline scheduler is EEVDF, which keeps the augmented-tree approach while changing the selection policy. A tree rather than a binary heap, because the scheduler also wants ordered traversal and removal of arbitrary tasks, not only extract-min, and a heap does arbitrary removal badly.

Worth being precise about the complexity, since it is a common interview trap: a binary heap's push and pop are O(log n) in the *worst case*, not amortized. The sift path is bounded by the tree height on every single operation. There is no amortization argument involved and nothing to hand back later. (Binomial and Fibonacci heaps are where amortized bounds enter, which is a different tradeoff.) The practical read on a heap of 100,000 elements is that pop does about 17 levels of sifting, every time, with no tail surprise. That predictability is often worth more than a better average.

Note that Go's own goroutine scheduler is not a priority queue at all. It uses per-P run queues with FIFO order plus a runnext slot, deliberately avoiding the ordering cost, since goroutines have no priorities to order by.

In event-driven simulation (used in network simulation, game engines, and distributed system testing), the event queue is a priority queue keyed on event timestamp. The "merge K sorted lists" problem is exactly the event-driven simulation step where K source queues are merged into a single timeline-ordered stream. In Go, the `container/heap` implementation of merge K sorted lists is the idiomatic approach, and understanding its O(n log k) complexity lets you set realistic throughput expectations for simulation workloads.

ADR consideration: `container/heap` in Go is not goroutine-safe. For concurrent producers pushing to a shared priority queue, you must add an external mutex or use a lock-free heap variant. Document the concurrency requirements before choosing `container/heap`: for single-threaded use it is the right default, but for worker pool implementations with multiple goroutines pushing tasks, evaluate whether the mutex contention is acceptable or whether a channel-based priority queue (using a heap with a goroutine draining it) is a better fit.

Bar-raiser signal: the candidate discusses the Median from Data Stream problem and explains why two heaps (a max-heap for the lower half, a min-heap for the upper half) give O(log n) per insertion and O(1) median retrieval, versus a sorted data structure that gives O(log n) insertion and O(1) median but with higher constant factors. They also discuss the rebalancing invariant (the two heaps must differ in size by at most one) and how to maintain it correctly when the invariant breaks after an insertion.
