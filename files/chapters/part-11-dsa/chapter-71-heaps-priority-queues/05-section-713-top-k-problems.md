## 71.3 Top K Problems

### Kth Largest Element

Finding the k-th largest element using a min-heap of size k works because the smallest element in the k-element heap is always the k-th largest seen so far. When the heap exceeds k elements, popping the minimum discards elements that cannot be in the top-k, keeping the heap bounded and reducing time complexity to O(n log k) rather than O(n log n) for full sorting.

```go
import "container/heap"

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

// FindKthLargest finds the k-th largest element
// LeetCode 215: Kth Largest Element in an Array
// Time: O(n log k), Space: O(k)
func FindKthLargest(nums []int, k int) int {
    // Use min-heap of size k
    h := &IntHeap{}
    heap.Init(h)

    for _, num := range nums {
        heap.Push(h, num)
        if h.Len() > k {
            heap.Pop(h) // remove smallest
        }
    }

    return (*h)[0] // k-th largest is min of k largest
}

// FindKthLargestQuickSelect uses QuickSelect algorithm
// Time: O(n) average, O(n^2) worst
func FindKthLargestQuickSelect(nums []int, k int) int {
    // Convert to finding (n-k)th smallest
    return quickSelect(nums, 0, len(nums)-1, len(nums)-k)
}

func quickSelect(nums []int, left, right, k int) int {
    if left == right {
        return nums[left]
    }

    pivotIdx := partition(nums, left, right)

    if k == pivotIdx {
        return nums[k]
    } else if k < pivotIdx {
        return quickSelect(nums, left, pivotIdx-1, k)
    }
    return quickSelect(nums, pivotIdx+1, right, k)
}

func partition(nums []int, left, right int) int {
    pivot := nums[right]
    i := left

    for j := left; j < right; j++ {
        if nums[j] <= pivot {
            nums[i], nums[j] = nums[j], nums[i]
            i++
        }
    }

    nums[i], nums[right] = nums[right], nums[i]
    return i
}
```

`quickSelect` recurses, so its space is O(log n) average and O(n) worst case for the call stack, not O(1). Rewriting the tail call as a loop makes it genuinely O(1) auxiliary space. Chapter 79 (Sorting and Selection) covers selection in depth, including the randomized pivot that keeps the O(n^2) worst case from being triggerable by adversarial input, and median-of-medians for a worst-case linear bound. Section 79.6 also lays out when to choose the bounded heap over quickselect, which is the decision an interviewer is actually probing.

### Top K Frequent Elements

The two-phase approach (first build a frequency map in O(n), then maintain a min-heap of size k ordered by count) means we only ever pay O(log k) per element rather than sorting the entire frequency table. The `TopKFrequentBucketSort` variant avoids the heap entirely by indexing buckets by count (which is bounded by n), achieving true O(n) time at the cost of O(n) auxiliary space for the bucket array.

```go
// TopKFrequent returns k most frequent elements
// LeetCode 347: Top K Frequent Elements
// Time: O(n log k), Space: O(n)
func TopKFrequent(nums []int, k int) []int {
    // Count frequencies
    freq := make(map[int]int)
    for _, num := range nums {
        freq[num]++
    }

    // Use min-heap of size k
    h := &FreqHeap{}
    heap.Init(h)

    for num, count := range freq {
        heap.Push(h, FreqItem{num: num, freq: count})
        if h.Len() > k {
            heap.Pop(h)
        }
    }

    result := make([]int, k)
    for i := k - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).(FreqItem).num
    }

    return result
}

type FreqItem struct {
    num  int
    freq int
}

type FreqHeap []FreqItem

func (h FreqHeap) Len() int           { return len(h) }
func (h FreqHeap) Less(i, j int) bool { return h[i].freq < h[j].freq } // min-heap by freq
func (h FreqHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *FreqHeap) Push(x any) { *h = append(*h, x.(FreqItem)) }
func (h *FreqHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// TopKFrequentBucketSort uses O(n) bucket sort
func TopKFrequentBucketSort(nums []int, k int) []int {
    freq := make(map[int]int)
    for _, num := range nums {
        freq[num]++
    }

    // Bucket by frequency
    buckets := make([][]int, len(nums)+1)
    for num, count := range freq {
        buckets[count] = append(buckets[count], num)
    }

    result := make([]int, 0, k)
    for i := len(buckets) - 1; i >= 0 && len(result) < k; i-- {
        result = append(result, buckets[i]...)
    }

    return result[:k]
}
```

### K Closest Points to Origin

Using a max-heap of size k inverts the typical pattern: the heap's maximum is the farthest point among the k candidates seen so far, so when a new point is closer than the current maximum, popping the maximum and inserting the new point maintains a tight set of k nearest neighbors. Comparing squared Euclidean distances (`x²+y²`) avoids the floating-point cost of `math.Sqrt` while preserving the correct ordering.

```go
// KClosest returns k closest points to origin
// LeetCode 973: K Closest Points to Origin
// Time: O(n log k), Space: O(k)
func KClosest(points [][]int, k int) [][]int {
    // Use max-heap of size k
    h := &PointHeap{}
    heap.Init(h)

    for _, p := range points {
        dist := p[0]*p[0] + p[1]*p[1]
        heap.Push(h, PointItem{point: p, dist: dist})
        if h.Len() > k {
            heap.Pop(h) // remove farthest
        }
    }

    result := make([][]int, k)
    for i := 0; i < k; i++ {
        result[i] = heap.Pop(h).(PointItem).point
    }

    return result
}

type PointItem struct {
    point []int
    dist  int
}

type PointHeap []PointItem

func (h PointHeap) Len() int           { return len(h) }
func (h PointHeap) Less(i, j int) bool { return h[i].dist > h[j].dist } // max-heap
func (h PointHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *PointHeap) Push(x any) { *h = append(*h, x.(PointItem)) }
func (h *PointHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

### Junior → FAANG: The Min-Heap-for-K-Largest Rule

The most important pattern to memorize before any FAANG interview is the heap polarity rule for top-K problems.

To find the K largest elements: use a min-heap of size K. When the heap exceeds K, pop the minimum. At the end, the heap contains exactly the K largest elements because every element smaller than the K-th largest has been evicted. The heap root is the K-th largest.

To find the K smallest elements: use a max-heap of size K. When the heap exceeds K, pop the maximum. At the end, the heap contains the K smallest elements.

The rule inverts the intuition, so verify it by hand rather than trusting it. Trace `[3, 1, 4, 1, 5, 9, 2, 6]` with K=3, pushing each element and popping the minimum whenever the heap exceeds 3. Heap contents shown sorted for readability:

| Push | Heap after push/evict | Root (Kth largest so far) |
|------|----------------------|---------------------------|
| 3    | {3}                  | 3 |
| 1    | {1, 3}               | 1 |
| 4    | {1, 3, 4}            | 1 |
| 1    | {1, 3, 4}            | 1 |
| 5    | {3, 4, 5}            | 3 |
| 9    | {4, 5, 9}            | 4 |
| 2    | {4, 5, 9}            | 4 |
| 6    | {5, 6, 9}            | 5 |

The final heap is {5, 6, 9}, exactly the three largest, and the root 5 is the 3rd largest. Note what the trace shows that the rule alone does not: the root is a running answer, correct for the prefix consumed so far. The two rows where the heap does not change (the second `1`, and the `2`) are elements smaller than the current root, which cannot belong to the top 3.

`FindKthLargest` pushes those doomed elements anyway and immediately pops them back out, paying two O(log k) sifts to learn nothing. The version in Section 79.6 compares against the root first and only pushes on a win, turning the common case into an O(1) rejection. Both are O(n log k), the second has a much better constant on real data where most elements lose. Mention that refinement in an interview after the correct solution is on the board, not before.

Comparing `FindKthLargest` (heap, O(n log k)) against `FindKthLargestQuickSelect` (O(n) average): in interviews, lead with the heap solution and mention QuickSelect as an optimization. Interviewers appreciate seeing both, but the heap solution is easier to implement correctly under time pressure.

### Senior @ FAANG: Top-K at Scale, Approximate Algorithms, and Data Architecture

The heap-based O(n log k) top-K is optimal for exact results when all data fits in memory. Once "all data" means a continuous event stream far larger than memory, exact top-K is often not worth its price.

A common architecture for streaming top-K analytics (trending topics, metric cardinality, popular content rankings) has three layers. The first is approximate counting with a Count-Min Sketch, which processes each event in O(1) with a tunable error bound and fixed memory. Note that HyperLogLog is *not* interchangeable here: it estimates distinct cardinality, not per-key frequency, so it answers "how many unique items" rather than "which items are heaviest." The second layer keeps exact counts for a candidate set several times larger than the final K, drawn from the sketch's heavy hitters. The third is a periodic reconciliation pass that corrects sketch error using exact counts from a backing store.

The engineering content is in the error budget, and it is derived from the product requirement rather than chosen for its own sake. "Trending topics refresh within a minute" fixes the reconciliation interval. The tolerable rank error near the K-th position fixes the sketch width and depth, since Count-Min's error scales with the total stream weight divided by the number of counters. State those numbers as a decision you made from a requirement, not as memorized constants. The heap is one component in a system, not the system itself.

For K closest points specifically, at production scale you would not scan all points. You would maintain a spatial index (k-d tree, ball tree, R-tree) and let it prune whole regions. Be careful about the complexity claim: k-d tree nearest-neighbor search is *not* O(log n). It is roughly O(log n) only for low dimensions and favorable data, and it degrades toward O(n) as dimensionality rises, because the pruning bound stops rejecting branches. This is the curse of dimensionality, and it is why high-dimensional similarity search uses approximate methods (LSH, HNSW) instead of exact trees. What is true regardless is the structural point: the heap becomes the output buffer that collects the k best candidates the index hands back, not the search mechanism. A bar-raiser asking a system design follow-up expects that distinction, and expects you not to oversell the index.
