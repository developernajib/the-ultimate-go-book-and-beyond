## 71.11 Common Mistakes

### Mistake 1: Using Wrong Heap Type

For "k smallest" problems, a max-heap of size k is correct: the maximum element in the heap is always evicted when the heap exceeds k, preserving only the k smallest seen so far. Using a min-heap instead discards the smallest elements on overflow, which is exactly the opposite of the desired behavior.

```go
// ❌ BAD: Using a MIN-heap for "k smallest"
func kSmallestBad(nums []int, k int) []int {
    h := &IntHeap{} // min-heap: root is the smallest
    for _, n := range nums {
        heap.Push(h, n)
        if h.Len() > k {
            heap.Pop(h) // Evicts the SMALLEST. Exactly backwards.
        }
    }
    return *h
}

// ✅ GOOD: Use a MAX-heap for k smallest
func kSmallestGood(nums []int, k int) []int {
    h := &MaxIntHeap{} // max-heap: root is the largest
    for _, n := range nums {
        heap.Push(h, n)
        if h.Len() > k {
            heap.Pop(h) // Evicts the LARGEST, keeping the k smallest.
        }
    }
    return *h
}
```

On `[3, 1, 4, 1, 5, 9, 2, 6]` with k=3, `kSmallestBad` returns `[5 6 9]` (it kept the three *largest*) and `kSmallestGood` returns `[2 1 1]`, which is the right set. Both return the raw backing slice, so the elements are in heap order, not sorted. Only index 0 has a guaranteed meaning. If the caller needs them sorted, pop them one at a time or sort the copy, and do not let a passing test on a 3-element input convince you the order is meaningful.

### Mistake 2: Forgetting heap.Init

`container/heap` does not enforce the heap property on a raw slice. `heap.Push` and `heap.Pop` *assume* the slice is already heap-ordered and only repair the one position they touch. Feed them an arbitrary slice and they will not panic or misbehave in any exciting way, they will simply compute wrong answers, quietly. Go has no "undefined behavior" here in the C sense, which is worse for you: nothing announces the bug. Always call `heap.Init` before operating on a pre-populated slice.

```go
// ❌ BAD: Not initializing heap
func badHeapUse() {
    h := &IntHeap{3, 1, 4, 1, 5} // not heap-ordered
    heap.Push(h, 2)
    // *h is now [2 1 3 1 5 4], and heap.Pop(h) returns 2.
    // The true minimum, 1, is sitting right there at index 1.
}

// ✅ GOOD: Always initialize
func goodHeapUse() {
    h := &IntHeap{3, 1, 4, 1, 5}
    heap.Init(h) // O(n), establishes the invariant
    heap.Push(h, 2)
    // *h is now [1 1 2 3 5 4], and heap.Pop(h) correctly returns 1.
}
```

`heap.Init` is O(n) via bottom-up heapify, not O(n log n). Building with n `heap.Push` calls costs O(n log n), so seeding the slice and calling `Init` once is genuinely cheaper than pushing elements one by one, in addition to being the only correct option for data you did not build through `Push`.

### Junior → FAANG: Internalising the Mistake Patterns

Both mistakes in this section (wrong heap polarity for top-K, missing `heap.Init`) cause subtle failures that produce wrong answers rather than panics. A test suite that only checks the final result may miss these bugs if the input is small or already partially sorted.

For the wrong heap polarity mistake: write a test with a known answer before writing the function. For `kSmallest([3,1,4,1,5,9,2,6], 3)` the expected *set* is `{1,1,2}`. If your function comes back with `{5,6,9}`, you reached for a min-heap where a max-heap was needed and you have collected the k largest instead. Compare as a sorted set, not element by element, since the heap's internal order is not the sorted order. Run the test rather than simulating it in your head, because polarity errors are exactly the kind of thing that looks right when you read it back.

For the missing `heap.Init` mistake: make `heap.Init` the first line after creating any heap that is not empty. If you are building the heap element by element with `heap.Push`, `heap.Init` on an empty heap is a no-op but documents intent. Treat it as a required ritual rather than an optional optimization.

### Senior @ FAANG: Turning Common Mistakes into Linting and Testing Standards

At staff level, the goal is to prevent these mistakes from reaching production, not just to know how to fix them. Two engineering practices achieve this systematically.

The first practice is a project-level lint rule that flags a `heap.Push` or `heap.Pop` on a composite literal that was never passed to `heap.Init`. Write it as an AST visitor using `golang.org/x/tools/go/analysis`, the same framework `go vet` itself is built on, and wire it into CI. Be realistic about its limits: the check is easy when construction and use sit in one function and undecidable in general once the heap crosses a function boundary. Target the common local case, accept the false negatives, and do not let the rule's incompleteness become an argument against having it.

The second practice is property-based testing, which is the real defense because it does not depend on you guessing the failing input. Generate random slices of random length, push all elements, then assert each successive `Pop` is greater than or equal to the previous for a min-heap. Better still, assert against a reference: sort a copy and require the pop sequence to match exactly. Go's standard library ships `testing/quick` for this, `pgregory.net/rapid` is the modern third-party choice with proper shrinking, and Go's built-in fuzzing (`go test -fuzz`) covers the same ground with corpus persistence. Any of the three catches a polarity error immediately, since the wrong polarity fails the sorted-order property on nearly every non-trivial input.

A concrete differential test is worth more than either lint rule: for a bounded top-k heap, compare its output against `slices.Sorted` plus a slice expression on random inputs. That single test would have caught every polarity bug in this chapter.

For wrong-heap-polarity bugs specifically, a code review checklist item is effective: "For every heap in this PR, state explicitly whether it is a min-heap or max-heap, what the `Less` function returns for two equal priorities, and which direction of polarity is needed for the algorithm's correctness." Making this explicit in code review comments costs two minutes and prevents an entire class of production bugs.

---
