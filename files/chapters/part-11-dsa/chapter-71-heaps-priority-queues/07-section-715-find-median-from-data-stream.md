## 71.5 Find Median from Data Stream

The two-heap approach for streaming median maintenance partitions the data into a lower half (max-heap) and an upper half (min-heap), keeping them balanced within one element of each other. The median is always the root of the larger heap or the average of both roots, enabling O(1) median queries after O(log n) insertions.

```go
import "container/heap"

// IntHeap is a min-heap of ints, MaxIntHeap is a max-heap.
// Only Less differs between them.
type IntHeap []int

func (h IntHeap) Len() int           { return len(h) }
func (h IntHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h IntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *IntHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *IntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

type MaxIntHeap []int

func (h MaxIntHeap) Len() int           { return len(h) }
func (h MaxIntHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h MaxIntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MaxIntHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *MaxIntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// MedianFinder maintains median in a stream
// LeetCode 295: Find Median from Data Stream
// Time: O(log n) per add, O(1) per find
type MedianFinder struct {
    small *MaxIntHeap // max-heap for smaller half
    large *IntHeap    // min-heap for larger half
}

func MedianFinderConstructor() MedianFinder {
    small := &MaxIntHeap{}
    large := &IntHeap{}
    heap.Init(small)
    heap.Init(large)
    return MedianFinder{small: small, large: large}
}

func (mf *MedianFinder) AddNum(num int) {
    // Add to max-heap first
    heap.Push(mf.small, num)

    // Balance: move max from small to large
    heap.Push(mf.large, heap.Pop(mf.small).(int))

    // Ensure small has >= elements than large
    if mf.large.Len() > mf.small.Len() {
        heap.Push(mf.small, heap.Pop(mf.large).(int))
    }
}

func (mf *MedianFinder) FindMedian() float64 {
    if mf.small.Len() > mf.large.Len() {
        return float64((*mf.small)[0])
    }
    return float64((*mf.small)[0]+(*mf.large)[0]) / 2.0
}
```

`FindMedian` indexes both heap roots directly, so it panics on an empty stream. LeetCode 295 guarantees at least one `AddNum` before any query. In production code you would return an `(float64, bool)` or an error instead of trusting the caller.

### Junior → FAANG: The Two-Heap Invariant

The streaming median is a classic Hard problem that trips up candidates who try to maintain a sorted structure instead. The trick is that you do not need full sorted order. you only need the boundary between the lower half and the upper half of the data.

Two heaps maintain this boundary: a max-heap `small` holds all values in the lower half (its root is the largest of the small values), and a min-heap `large` holds all values in the upper half (its root is the smallest of the large values). The invariant is: every value in `small` is less than or equal to every value in `large`, and `small` has the same size as `large` or exactly one more.

The three-step insert sequence preserves both parts of the invariant:
1. Push to `small` (tentatively place in lower half).
2. Pop `small`'s max and push it to `large` (ensures small.max <= large.min).
3. If `large` is now larger than `small`, pop `large`'s min back to `small` (restores size balance).

Walk through inserting `[5, 3, 8, 1]` by hand before your interview. Verifying the invariant after each step solidifies the pattern.

### Senior @ FAANG: Streaming Quantiles and Production Observability

The two-heap median is exact, and that exactness has a price the interview never charges you: memory grows with the stream. Both heaps retain every element ever inserted, so an unbounded stream is an unbounded heap. This is the observation that matters, and it is what pushes production systems toward approximate quantile sketches such as t-digest, KLL, or HDRHistogram, which answer arbitrary quantiles (p50, p95, p99, p99.9) in memory that does not grow with the stream.

Put concrete numbers on it. Exact median over a 1 million element window costs O(n): about 8 MB just for the values at 8 bytes each, before per-heap slice overhead. A quantile sketch holds a few hundred to a few thousand summary points regardless of how many events pass through, so it lands in the kilobytes and stays there. That is not a small constant-factor win, it is a different growth curve, which is why monitoring systems (Prometheus, OpenTelemetry, and commercial APM backends) report latency percentiles from bucketed or sketched histograms rather than exact order statistics.

Be careful with the claims here, because interviewers probe them. Sketch insert is cheap but not free, and t-digest in particular buffers incoming points and periodically merges them, so it is amortized rather than a flat O(1) per point. Accuracy guarantees are also not uniform: t-digest deliberately gives *relative* error that is tightest at the extreme tails and loosest near the median, which is exactly backwards from what you want if the median is your target metric. Quoting a single "sub-percent error" figure for all quantiles is the kind of overclaim that gets challenged.

At staff level you own the choice, and the decision record should capture: required precision per quantile and where the tails matter, memory budget per metric series, and mergeability, which is often the deciding factor. If regional aggregators must roll up into a global percentile, the sketch has to support merging two summaries without the raw data. t-digest and KLL do, naively bucketed approaches do so only when the bucket boundaries agree. In Go, `beorn7/perks` provides streaming quantiles of the Greenwald-Khanna family and is what `client_golang` builds summary metrics on, note that it is not a t-digest, and separate t-digest implementations exist. Verify the accuracy and merge semantics of whichever you pick against your own data rather than trusting the README. The exact two-heap median from this section is the prerequisite that makes you literate in the trade-off, even when the production answer is an approximation.
