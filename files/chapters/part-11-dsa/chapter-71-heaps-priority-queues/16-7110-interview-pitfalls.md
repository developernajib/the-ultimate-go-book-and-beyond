## 71.14 Interview Pitfalls

### Pitfall 1: Using Wrong Heap Type for Top-K Problems

**Typical failure**: a candidate is asked for the K largest elements, reaches for a max-heap, pushes all N elements, and pops K times. The usual feedback is "can you do better?", and the usual mistake in *responding* is to accept that the max-heap version was wrong. It was not wrong, it was unbounded. Being precise about this distinction is what separates a good answer from a lucky one.

```go
// ⚠️ SUBOPTIMAL, not incorrect: pushes all N elements.
// N pushes cost O(N log N) time and O(N) space.
func topKLargestBad(nums []int, k int) []int {
    h := &MaxIntHeap{}
    heap.Init(h)

    for _, n := range nums {
        heap.Push(h, n) // O(log N) each, N times
    }

    // Returns the right answer, in descending order.
    result := make([]int, k)
    for i := 0; i < k; i++ {
        result[i] = heap.Pop(h).(int)
    }
    return result
}

// ✅ PREFERRED: bounded min-heap of size K. O(N log K) time, O(K) space.
func topKLargestGood(nums []int, k int) []int {
    h := &IntHeap{} // min-heap: root is the weakest of the current best K
    heap.Init(h)

    for _, n := range nums {
        heap.Push(h, n)
        if h.Len() > k {
            heap.Pop(h) // eject the smallest, keeping the K largest
        }
    }

    // Min-heap pops ascending, so fill backwards for descending output.
    result := make([]int, k)
    for i := k - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).(int)
    }
    return result
}
```

Now the part most candidates get wrong in the other direction. The bounded min-heap is **not** unambiguously faster. Compare honestly:

| Approach | Time | Space | Streams? |
|----------|------|-------|----------|
| N pushes into a max-heap, pop K | O(N log N) | O(N) | No |
| `heap.Init` on the slice, pop K | O(N + K log N) | O(N) in place | No |
| Bounded min-heap of size K | O(N log K) | O(K) | Yes |

The middle row is the one nobody mentions, and for small K it beats the bounded heap on time: `heap.Init` is O(N), and K pops cost K log N, so for K=10 and N=1,000,000 that is roughly N operations against the bounded heap's N log 10. The bounded min-heap's real wins are **space** (O(K), not O(N)) and **streaming** (it never needs the whole input in memory), and those are usually the reasons that matter. Say "I'll use the bounded heap because it is O(K) space and works on a stream" rather than claiming a time win you would lose an argument about. Section 79.6 covers this decision in full.

### Pitfall 2: Not Implementing heap.Interface Correctly

**Typical failure**: `Swap` written as a one-way copy, or `Pop` taking from the front of the slice. Both compile and satisfy the interface, and both silently corrupt the heap. `container/heap` supplies the sift logic but trusts your five methods completely, so an interface bug becomes a data-structure bug with no error in between.

```go
// ❌ WRONG: Common interface mistakes
type BrokenHeap []int

func (h BrokenHeap) Len() int           { return len(h) }
func (h BrokenHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h BrokenHeap) Swap(i, j int)      { h[i] = h[j] }  // WRONG: One-way copy!

func (h *BrokenHeap) Push(x any) {
    *h = append(*h, x.(int))
}

func (h *BrokenHeap) Pop() any {
    return (*h)[0]  // WRONG: Should pop from end, not front!
}

// ✅ CORRECT: Proper heap.Interface implementation
type CorrectHeap []int

func (h CorrectHeap) Len() int           { return len(h) }
func (h CorrectHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h CorrectHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }  // Two-way swap!

func (h *CorrectHeap) Push(x any) {
    *h = append(*h, x.(int))
}

func (h *CorrectHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]     // Pop from END (heap maintains structure)
    *h = old[0 : n-1]
    return x
}
```

### Pitfall 3: Forgetting heap.Init on a Pre-Populated Slice

**Typical failure**: a heap is constructed from an existing slice and used directly, without `heap.Init`. Every operation then computes confidently wrong answers, because `Push` and `Pop` assume the slice is *already* heap-ordered and only repair the single position they touch.

Be precise about when `Init` is actually required, because the folk rule "always call Init" is repeated far more often than it is understood:

```go
// ✅ FINE: Init on an EMPTY heap is a no-op. Omitting it changes nothing.
// heap.Init runs down() from n/2-1 to 0, and with n == 0 that loop body
// never executes. Push maintains the invariant on every insertion, so a
// heap built exclusively through Push is always valid.
func buildByPush() *IntHeap {
    h := &IntHeap{}
    for _, v := range []int{7, 2, 9, 1} {
        heap.Push(h, v) // each Push sifts up: invariant preserved
    }
    return h // valid heap, no Init needed
}

// ❌ WRONG: pre-populated slice, never heapified.
func fromSliceBad() int {
    h := &IntHeap{3, 1, 4, 1, 5} // arbitrary order, NOT a heap
    heap.Push(h, 2)
    return heap.Pop(h).(int) // returns 2. The real minimum, 1, is ignored.
}

// ✅ CORRECT: establish the invariant first.
func fromSliceGood() int {
    h := &IntHeap{3, 1, 4, 1, 5}
    heap.Init(h)             // O(n) bottom-up heapify
    heap.Push(h, 2)
    return heap.Pop(h).(int) // returns 1
}
```

So the accurate rule is: **`Init` is mandatory when you hand `container/heap` a slice you populated yourself, and unnecessary when you built the heap through `heap.Push` alone.** Calling it on an empty heap is harmless and some codebases do it to document intent, which is a defensible style choice, just not a correctness one. If an interviewer says "you forgot `heap.Init`" on a heap you built entirely with `Push`, you should be able to say politely that it is a no-op there and explain why.

### Pitfall 4: Building Heap with Repeated Insertions

**Typical failure**: building a heap from N elements with N insertions, costing O(N log N), when bottom-up heapify does it in O(N). This is a classic follow-up question.

```go
// ⚠️ SUBOPTIMAL: O(N log N) heap building
func buildHeapBad(nums []int) *IntHeap {
    h := &IntHeap{}

    // Each Push is O(log n), total O(N log N)
    for _, n := range nums {
        heap.Push(h, n)
    }
    return h
}

// ✅ O(N) heap building.
// Note: IntHeap(nums) is a type conversion, NOT a copy. It shares the
// backing array, so heap.Init reorders the CALLER's slice in place.
// That is fine when the caller expects it and a nasty surprise otherwise.
func buildHeapGood(nums []int) *IntHeap {
    h := IntHeap(nums)
    heap.Init(&h) // O(N) bottom-up sift-down, mutates nums
    return &h
}

// ✅ Same O(N) build without clobbering the caller's slice.
func buildHeapCopy(nums []int) *IntHeap {
    h := IntHeap(slices.Clone(nums))
    heap.Init(&h)
    return &h
}

// Manual heapify for understanding:
func heapifyInPlace(nums []int) {
    n := len(nums)
    // Start from last non-leaf and sift down
    for i := n/2 - 1; i >= 0; i-- {
        siftDown(nums, i, n)
    }
}

func siftDown(nums []int, i, n int) {
    for {
        smallest := i
        left := 2*i + 1
        right := 2*i + 2

        if left < n && nums[left] < nums[smallest] {
            smallest = left
        }
        if right < n && nums[right] < nums[smallest] {
            smallest = right
        }
        if smallest == i {
            break
        }
        nums[i], nums[smallest] = nums[smallest], nums[i]
        i = smallest
    }
}
```

### Pitfall 5: Median Tracker with Unbalanced Heaps

**Typical failure**: a running median that skips the rebalance step. Everything looks right until the two heaps drift apart in size, at which point the root of `small` stops being the median. The invariant is that `small` and `large` are equal in size or `small` is exactly one larger, and it has to be restored on *every* insert.

```go
// ❌ WRONG: Not maintaining balance
type MedianBad struct {
    small *MaxIntHeap // Left half (smaller numbers)
    large *IntHeap    // Right half (larger numbers)
}

func (m *MedianBad) AddNum(num int) {
    heap.Push(m.small, num)
    // Forgot to rebalance!
}

// ✅ CORRECT: Always maintain balance
type MedianGood struct {
    small *MaxIntHeap // Contains smaller half, max at top
    large *IntHeap    // Contains larger half, min at top
}

func (m *MedianGood) AddNum(num int) {
    // Step 1: Add to small heap
    heap.Push(m.small, num)

    // Step 2: Move max of small to large (ensures small.max <= large.min)
    heap.Push(m.large, heap.Pop(m.small))

    // Step 3: Rebalance if large has more elements
    if m.large.Len() > m.small.Len() {
        heap.Push(m.small, heap.Pop(m.large))
    }
}

func (m *MedianGood) FindMedian() float64 {
    if m.small.Len() > m.large.Len() {
        return float64((*m.small)[0])
    }
    return float64((*m.small)[0]+(*m.large)[0]) / 2.0
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Unbounded heap for top-K | O(N) memory, cannot stream | K largest → min-heap bounded at K |
| Inverted polarity for top-K | Silently returns the K *smallest* | Root must be the item you would evict |
| Interface Swap bug | Wrong values returned | Swap must be bidirectional |
| Missing heap.Init on a pre-filled slice | Wrong answers, no error | Init only when you populated the slice yourself |
| O(N log N) building | Slower than needed | heap.Init on the slice is O(N) |
| Unbalanced median | Wrong median value | Rebalance after every insert |
| Pop from the front | Heap property violated | Pop from the end of the slice |

### Junior → FAANG: Converting Pitfalls to Pre-Interview Checklists

Each pitfall here is a recurring failure mode rather than a story about one candidate. The efficient defense is a checklist you run before every practice session until it is automatic.

Checklist for any heap problem: (1) Which polarity do I need, and can I state *why* in terms of what gets evicted? (2) Did I populate a slice directly, and therefore need `heap.Init`? (3) Does my `Swap` exchange both directions? (4) Does my `Pop` remove from the end of the slice? (5) For median problems, am I asserting the size balance invariant explicitly?

The O(N log N) build is worth special attention, because "can you build the heap faster?" is a standard follow-up. The answer is `heap.Init`, and the follow-up to the follow-up is *why* it is O(n), which is where most candidates stall.

The argument is worth carrying verbatim. Bottom-up heapify calls sift-down on each internal node, and the cost of a sift-down is bounded by the node's height, not the tree's. In a heap of n nodes there are at most n/2^(h+1) nodes at height h, so the total work is bounded by the sum over h of h * n/2^(h+1), which is n/2 * sum of h/2^h. That sum converges to 2, giving at most n swaps, hence O(n). The intuition underneath the algebra: half the nodes are leaves and cost nothing, a quarter sit one level up and cost at most one sift, and the expensive nodes near the root are so few that they do not matter. Repeated insertion inverts this, because every one of the n pushes can travel the *full* log n height, which is exactly why it costs O(n log n).

### Senior @ FAANG: Pitfall Prevention at the Team Level

Individual knowledge of pitfalls is necessary but not sufficient for a team producing reliable heap-based code. Staff engineers implement systemic prevention.

For Pitfall 1 (wrong heap for top-K): add a test that verifies the heap polarity directly. Call `Peek` (return root without removing) after pushing all elements and assert it is the correct value (the K-th largest or smallest depending on the problem). This test is fast, deterministic, and catches the polarity bug regardless of input ordering.

For Pitfall 4 (naive heap building): add a benchmark that compares `heap.Init` vs N individual `heap.Push` calls for N=100000. The benchmark lives in the repository permanently and serves as documentation: it shows that the O(n) path exists and quantifies the saving. Future engineers who forget this optimization will discover it by running the benchmarks.

For Pitfall 5 (unbalanced median): the balance invariant is a post-condition of `AddNum`. Write it as a test helper: after every call to `AddNum`, assert `|small.Len() - large.Len()| <= 1` and `small.Peek() <= large.Peek()`. Running this helper in a table-driven test with 1000 random insertions will catch balance violations on the first run.

These practices are the difference between a team that debugs heap bugs in production and a team that prevents them in development. Staff engineers are responsible for the latter.

---
