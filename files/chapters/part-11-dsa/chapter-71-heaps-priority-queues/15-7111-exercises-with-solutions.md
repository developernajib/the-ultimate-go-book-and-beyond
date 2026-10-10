## 71.13 Exercises with Solutions

### Exercise 1: Top K Frequent Elements

This solution uses a min-heap capped at size `k` to track the top-k most frequent elements in a single pass over the frequency map. The key insight is counterintuitive: to find the `k` largest frequencies you maintain a min-heap. When the heap exceeds `k` elements you evict the current minimum, guaranteeing only the `k` highest-frequency entries survive. The extraction loop then pops in ascending frequency but writes backwards into the result, so the returned slice ends up in descending frequency without a separate sort.

```go
import "container/heap"

// topKFrequent assumes k <= number of distinct values in nums, which
// LeetCode 347 guarantees. Without that guarantee the extraction loop
// pops an empty heap and panics.
func topKFrequent(nums []int, k int) []int {
    count := make(map[int]int)
    for _, n := range nums {
        count[n]++
    }

    h := &FreqHeap{}
    for num, freq := range count {
        heap.Push(h, &NumFreq{num, freq})
        if h.Len() > k {
            heap.Pop(h)
        }
    }

    result := make([]int, k)
    for i := k - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).(*NumFreq).Num
    }
    return result
}

type NumFreq struct {
    Num, Freq int
}

type FreqHeap []*NumFreq

func (h FreqHeap) Len() int           { return len(h) }
func (h FreqHeap) Less(i, j int) bool { return h[i].Freq < h[j].Freq }
func (h FreqHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *FreqHeap) Push(x any)        { *h = append(*h, x.(*NumFreq)) }
func (h *FreqHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[0 : n-1]
    return x
}
```

### Junior → FAANG: Breaking Down the Top-K Frequent Solution

The solution uses a two-phase approach that is worth understanding independently.

Phase 1 builds the frequency map in O(n). This is straightforward: iterate once, increment the count for each number.

Phase 2 maintains a min-heap capped at size k. The counterintuitive part is using a min-heap (which has the smallest frequency at the root) to track the k largest frequencies. The reason: when the heap has k+1 elements and you pop the root, you remove the smallest frequency seen so far. Only the k largest survive. The heap root at the end is the k-th largest frequency (the smallest of the top-k). This is the min-heap-for-K-largest rule applied to frequency counts rather than raw values.

The final extraction loop pops in ascending order and fills the result array from the end (`result[i]` for decreasing i), which produces a descending-frequency result without an extra sort step.

Practice: implement this solution from scratch, then implement the bucket-sort O(n) variant from section 71.3 and compare when each is preferable (k relative to the number of distinct values).

### Senior @ FAANG: Top-K as a Foundation for Recommendation Systems

The frequency-based top-K pattern underpins recommendation and ranking systems everywhere: "the top-k items this user interacted with" is one of the most-run query shapes on any content platform. The heap solution above handles a single user's session comfortably, because the heap is O(k) and the frequency map is O(distinct items for that user), which stays small.

For platform-wide aggregate top-K, the frequency map is what breaks, not the heap. This is the same point as the chapter introduction, and it is worth repeating because candidates reliably optimize the wrong half: k stays at 50 while the distinct-key count grows to the size of the catalog, so exact counting needs a counter per item and the heap needs 50 slots. The fix targets the counting side. A Count-Min Sketch estimates frequencies in O(w*d) space with a tunable error bound, and a dedicated heavy-hitters algorithm (Misra-Gries or Space-Saving, which are two distinct algorithms rather than one under two names) tracks the candidate top-k directly. Whatever you commit to in an SLA has to follow from the sketch's actual parameters, so derive the error bound from w and d rather than quoting a confidence figure you cannot defend.

At staff level, owning a recommendation service means owning the decision of where to draw the line between exact and approximate algorithms for each query type: exact for personalised top-K (small item space per user), approximate for global trending (large item space, lower precision requirement). This decision is an ADR, not a code comment, because it affects SLA commitments, infrastructure cost, and the product's accuracy story.

---
