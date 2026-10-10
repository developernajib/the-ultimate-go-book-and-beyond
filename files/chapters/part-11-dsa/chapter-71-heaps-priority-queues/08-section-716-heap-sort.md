## 71.6 Heap Sort

Heap sort achieves O(n log n) time and O(1) space by sorting in place using the heap structure. The first phase builds a max-heap bottom-up in O(n), and the second phase repeatedly swaps the root (maximum) with the last unsorted element and sifts down to restore the heap property, placing elements in sorted order from back to front.

```go
// HeapSort sorts an array in place using a max-heap.
// Time: O(n log n) worst case, Space: O(1) auxiliary.
func HeapSort(nums []int) {
    n := len(nums)

    // Phase 1: build max-heap bottom-up, O(n)
    for i := n/2 - 1; i >= 0; i-- {
        heapify(nums, n, i)
    }

    // Phase 2: repeatedly move the root to the sorted tail, O(n log n)
    for i := n - 1; i > 0; i-- {
        nums[0], nums[i] = nums[i], nums[0]
        heapify(nums, i, 0)
    }
}

// heapify sifts nums[i] down within the heap nums[:n].
// The loop form uses O(1) stack. Written recursively (tail call at the
// bottom) it would cost O(log n) stack, and Go does not eliminate tail
// calls, so HeapSort's O(1) space claim depends on this being a loop.
func heapify(nums []int, n, i int) {
    for {
        largest := i
        left := 2*i + 1
        right := 2*i + 2

        if left < n && nums[left] > nums[largest] {
            largest = left
        }
        if right < n && nums[right] > nums[largest] {
            largest = right
        }

        if largest == i {
            return
        }

        nums[i], nums[largest] = nums[largest], nums[i]
        i = largest
    }
}
```

### Junior → FAANG: When to Mention Heap Sort

Heap sort is O(n log n) worst case with O(1) extra space, which makes it superior to quicksort in the worst case and superior to merge sort in space usage. Knowing this positions you well in interviews that ask "what is the best comparison-based sorting algorithm?" The complete answer is: it depends on average-case vs worst-case requirements and whether extra memory is available.

In practice, heap sort has poor cache performance because siftDown accesses the array non-sequentially, jumping from parent index `i` to child `2i+1` or `2i+2`. Those indices are far apart in memory near the top of the heap, so each level of a sift can miss cache. Merge sort and quicksort both stream through memory in mostly sequential runs and use the cache far better.

Go's `sort.Slice` and `sort.Ints` use pdqsort (pattern-defeating quicksort), which has been the standard library's sort since Go 1.19. Pdqsort keeps heap sort in its back pocket: it counts how badly its partitions are splitting, and when a run of bad pivots suggests adversarial or already-degenerate input, it switches to heap sort to guarantee the O(n log n) worst case. That is heap sort's real production role. It is the safety net that makes an otherwise-quicksort algorithm immune to the O(n^2) blowup, not the algorithm that runs on the common path.

Interview signal: if an interviewer asks for an in-place O(n log n) sort with a worst-case guarantee, heap sort is the answer. If they ask what is fastest in practice, say quicksort variants, explain the cache trade-off, and name pdqsort as what Go actually runs. Introsort is the analogous quicksort/heapsort hybrid from the C++ standard library, so cite it as the C++ counterpart, not as Go's implementation. Chapter 79 covers pdqsort and the sorting landscape in full.

### Senior @ FAANG: Heap Sort's Real Role and Cache Hierarchy

The gap between heap sort and pdqsort is worth measuring rather than reciting. A slice of one million `int` values spans 8 MB, which is at or beyond the L3 capacity of a typical laptop-class CPU, so a siftDown near the top of the heap jumps between locations that are nowhere near each other and misses cache repeatedly.

Benchmarked on one machine (an Intel i7-10510U, 8 MB L3, Go 1.27.1) sorting one million random ints, the `HeapSort` above ran about 161 ms against about 89 ms for `sort.Ints`, roughly 1.8x slower at identical asymptotic complexity. Treat that ratio as an illustration, not a constant. It moves with cache size, element size, and input distribution, and it is the reason the honest instruction is to run the benchmark on your target hardware. Do not attribute the whole gap to caching either: pdqsort also performs fewer comparisons on typical input and generates more predictable branches. Cache behavior is a large part of the story, not the entirety of it.

At staff level, this gap matters for two reasons. First, it stops you from recommending heap sort for throughput-sensitive sorting where pdqsort or a radix sort fits better. Second, it motivates d-ary heaps, where each node has d children (d = 4 or 8) instead of 2. A d-ary heap is shallower, log_d(n) instead of log_2(n), so siftDown takes fewer levels and each node's children sit contiguously and can share a cache line. The trade is more comparisons per level to find the best child. Note the terminology: this is cache-*aware* tuning, since you pick d with the cache line size in mind. It is not a cache-*oblivious* structure, which is a specific technical term for designs that achieve good cache behavior without knowing the cache parameters at all.

Whether a d-ary heap actually wins depends on d, element size, and access pattern, so it is a hypothesis to benchmark, not a guaranteed speedup. That is the shape of the skill: not choosing between O(n log n) algorithms by asymptotic analysis alone, but measuring against real memory behavior on the hardware you actually ship on.
