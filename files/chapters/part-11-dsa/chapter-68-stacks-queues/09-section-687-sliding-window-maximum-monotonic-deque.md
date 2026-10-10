## 68.7 Sliding Window Maximum (Monotonic Deque)

The sliding window maximum problem exemplifies the power of a monotonic deque: by maintaining a decreasing deque of indices, each element is enqueued and dequeued at most once, achieving O(n) total time instead of the naive O(nk). The deque front always holds the index of the maximum element in the current window, while stale indices (those that have slid out of the window) are discarded from the front before reading the result.

```go
// MaxSlidingWindow returns the max element in each sliding window
// LeetCode 239: Sliding Window Maximum
// Time: O(n), Space: O(k)
func MaxSlidingWindow(nums []int, k int) []int {
    n := len(nums)
    if n == 0 || k == 0 {
        return []int{}
    }

    // Monotonic decreasing deque (stores indices)
    deque := []int{}
    result := []int{}

    for i := 0; i < n; i++ {
        // Remove elements outside window
        for len(deque) > 0 && deque[0] <= i-k {
            deque = deque[1:]
        }

        // Remove smaller elements (they can never be max)
        for len(deque) > 0 && nums[deque[len(deque)-1]] < nums[i] {
            deque = deque[:len(deque)-1]
        }

        deque = append(deque, i)

        // Add max to result when window is complete
        if i >= k-1 {
            result = append(result, nums[deque[0]])
        }
    }

    return result
}

// The two halves of a sliding window median (LeetCode 480) are held in a
// max-heap of the smaller half and a min-heap of the larger half, so the
// median is always at one of the two roots:
//
//     type SlidingWindowMedian struct {
//         small *MaxHeap // max heap for the smaller half
//         large *MinHeap // min heap for the larger half
//     }
//
// The heap types below are the halves. The window logic is deliberately
// left out: the hard part is not the heaps but evicting the element that
// just left the window, which may sit anywhere inside either heap.
// container/heap has no "remove this value" operation, so a real
// implementation needs either lazy deletion with an expiry map, or an
// index stored on each element as shown for MaxStack in section 68.6.
// See the senior note at the end of this section.

// MaxHeap implementation. Together with MinHeap these satisfy
// heap.Interface, so callers drive them via container/heap.
type MaxHeap []int
func (h MaxHeap) Len() int           { return len(h) }
func (h MaxHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h MaxHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MaxHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MaxHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// MinHeap implementation
type MinHeap []int
func (h MinHeap) Len() int           { return len(h) }
func (h MinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h MinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MinHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// ShortestSubarrayWithSumAtLeastK handles negative numbers
// LeetCode 862: Shortest Subarray with Sum at Least K
// Time: O(n), Space: O(n)
func ShortestSubarrayWithSumAtLeastK(nums []int, k int) int {
    n := len(nums)
    // Prefix sum
    prefix := make([]int64, n+1)
    for i := 0; i < n; i++ {
        prefix[i+1] = prefix[i] + int64(nums[i])
    }

    result := n + 1
    // Monotonic increasing deque of indices
    deque := []int{}

    for i := 0; i <= n; i++ {
        // Check if current prefix - deque front >= k
        for len(deque) > 0 && prefix[i]-prefix[deque[0]] >= int64(k) {
            length := i - deque[0]
            if length < result {
                result = length
            }
            deque = deque[1:]
        }

        // Maintain monotonic property
        for len(deque) > 0 && prefix[i] <= prefix[deque[len(deque)-1]] {
            deque = deque[:len(deque)-1]
        }

        deque = append(deque, i)
    }

    if result > n {
        return -1
    }
    return result
}
```

Why `ShortestSubarrayWithSumAtLeastK` needs a deque and not a plain sliding window: with negative numbers the prefix sums are not monotonic, so growing a window no longer reliably grows its sum, and the two-pointer contraction that solves the all-positive version is simply wrong here. The deque keeps prefix indices in increasing order of prefix value, discarding any index whose prefix is not smaller than a later one, because a later index with a smaller-or-equal prefix is better on both counts: it yields a larger sum and a shorter window. Note that the front pop is permanent rather than a peek. Once index `deque[0]` produces a qualifying window ending at `i`, it can never produce a shorter one at any larger `i`, so it is discarded, and that is what keeps the total work linear.

### Junior -> FAANG: Sliding Window Maximum as the Canonical Deque Problem

The sliding window maximum (LeetCode 239) is the canonical problem for the monotonic deque pattern. It appears in interviews at all difficulty levels: Easy (find maximum in fixed window), Medium (find maximum in sliding window), Hard (sliding window with negative numbers using prefix sums).

**The algorithm in three sentences:** Maintain a deque of indices. When processing index i, remove from the back any index j where `nums[j] < nums[i]` (because i is newer and strictly larger, so j can never be the maximum of any future window). Remove from the front any index that is no longer in the window (`deque[0] <= i - k`). The front always holds the index of the current window's maximum.

**On `<` versus `<=` here.** Unlike the monotonic stack variants in section 68.4, where strictness changes the answer, both work for this problem and produce identical output. With `<`, equal values are kept and the deque holds the oldest of them at the front. With `<=`, equal values are evicted and only the newest survives. Either way the front holds *a* maximum, and the maximum is all this problem asks for. `<=` keeps the deque shorter on duplicate-heavy input, so prefer it if you like, but do not let an interviewer convince you one of them is a bug. If the problem asked for the *index* of the maximum rather than its value, the choice would suddenly matter, and that is the follow-up worth anticipating.

**The critical implementation detail:** Store indices in the deque, not values. You need the index to check window boundaries (`deque[0] <= i - k`). Access values via `nums[deque[...]]`.

**`ShortestSubarrayWithSumAtLeastK` as a harder variant.** This problem (LeetCode 862) extends sliding window to handle negative numbers by using prefix sums and a monotonic increasing deque. The deque maintains indices where the prefix sum is increasing: for any two indices i < j in the deque, `prefix[i] <= prefix[j]`. When `prefix[i] - prefix[deque[0]] >= k`, the window from `deque[0]` to `i` has sum at least k, so we pop from the front and record the length.

**First-job habit:** For any sliding window problem, before coding, decide: "Do I need the maximum, minimum, or sum of the window?" Maximum/minimum: monotonic deque. Sum: prefix sum or running sum. Both: monotonic deque with prefix sums.

### Senior @ FAANG: Monotonic Deque in Production Stream Processing

**O(n) sliding window vs. O(n log k) heap approach.** The monotonic deque achieves O(n) total for the sliding window maximum, while a max-heap approach achieves O(n log k), since each of n elements is pushed and popped from a heap of size at most k. The deque also wins on space in practice: it holds only the elements that could still become the maximum, which on random input is far fewer than k and is exactly k only on a strictly decreasing window.

Do not convert the log k into a predicted speedup. The temptation is to say a window of 600,000 makes the deque "20x faster" because log2(600000) is about 19, and that reasoning silently assumes the two approaches have identical constant factors, which they do not: a deque step is a couple of comparisons and an index bump on contiguous memory, while a heap step is a sift with scattered access and an interface dispatch through `heap.Interface`. The honest claim is directional. The deque is asymptotically better and usually wins by more than the asymptotics suggest, because its constants are also smaller. If you need a number, measure your own workload. The heap remains the right tool the moment the question changes from "maximum" to "median" or "k-th largest", since those need the elements the deque discards.

**`ShortestSubarrayWithSumAtLeastK` as a signal processing primitive.** This problem's structure is directly applicable to detecting anomalies in time-series data: "find the shortest time interval where the cumulative metric change exceeded a threshold." A distributed tracing system that wants to identify the shortest root-cause window for a latency spike can use this algorithm on prefix-summed latency deltas.

**Sliding window median (two-heap approach).** The two-heap approach for sliding window median uses a max-heap for the lower half and a min-heap for the upper half, rebalancing after each slide. This achieves O(n log k) time and O(k) space. The challenge is efficient deletion: when a window element expires, you must remove it from whichever heap contains it. The standard Go `container/heap` does not support arbitrary removal efficiently. The production solution uses a lazy deletion map (mark elements as expired, skip them during pop) identical to the `MaxStack` lazy deletion pattern. Implementing this correctly is an L5-level skill that demonstrates both algorithmic depth and Go-specific implementation judgment.

**ADR: sliding window maximum as a streaming service primitive.** A platform engineering decision: should sliding window maximum be implemented as a library function, as a streaming operator in a data pipeline framework (like Apache Flink's `AggregateFunction`), or as a specialized service? The library approach is appropriate for single-service use. The streaming operator approach is appropriate when multiple services need the same sliding window semantics and a shared framework manages state. The specialized service approach is appropriate when the window size is very large (requires distributed state) or when the maximum must be computed across multiple input streams. Framing this as an ADR and choosing based on scale and reuse requirements is an L6/staff decision.

---
