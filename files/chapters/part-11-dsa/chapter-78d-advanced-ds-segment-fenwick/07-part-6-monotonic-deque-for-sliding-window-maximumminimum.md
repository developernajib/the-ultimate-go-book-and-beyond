## 78D.6 Monotonic Deque for Sliding Window Maximum/Minimum

The monotonic deque is the go-to technique for sliding window min/max problems.

### LeetCode 239: Sliding Window Maximum

**Problem:** Given an array `nums` and a sliding window of size `k`, return the maximum in each window position.

The monotonic deque stores indices in decreasing value order. Elements that have fallen out of the current window are evicted from the front, and elements that can never again be the window maximum are evicted from the back before each new index is pushed. The front of the deque is therefore always the index of the current window's maximum.

The back-eviction is the part that needs justifying. When `nums[i]` arrives, any element already in the deque that is smaller is now permanently useless: it is both smaller than `nums[i]` *and* leaves the window earlier, so there is no future window containing it that does not also contain the larger, longer-lived `nums[i]`. It is dominated, and dominated candidates are deleted rather than retained. What survives is exactly the set of elements that could still become the maximum, which is why the deque ends up sorted by value without anyone sorting it.

```go
func maxSlidingWindow(nums []int, k int) []int {
	n := len(nums)
	result := make([]int, 0, n-k+1)
	deque := []int{} // indices, monotonically decreasing by value

	for i := 0; i < n; i++ {
		// Remove elements outside the window
		for len(deque) > 0 && deque[0] <= i-k {
			deque = deque[1:]
		}

		// Remove elements smaller than current (they can never be the max)
		for len(deque) > 0 && nums[deque[len(deque)-1]] <= nums[i] {
			deque = deque[:len(deque)-1]
		}

		deque = append(deque, i)

		// Window is full, record the max
		if i >= k-1 {
			result = append(result, nums[deque[0]])
		}
	}
	return result
}
```

**Complexity:** O(n) time, O(k) space.

Implementation notes. `deque = deque[1:]` reslices rather than shifting, so front eviction is O(1). It does retain the original backing array, which is irrelevant here but would matter in a long-lived structure. Front eviction compares `deque[0] <= i-k` on the *index*, not the value, which is why the deque must store indices: values alone carry no expiry information. And the eviction test uses `<=` rather than `<`, since equal values are also dominated by the later arrival, which keeps the deque shorter. Using `<` is equally correct.

For a sliding window *minimum*, flip the single comparison in the back-eviction to `>=`. Nothing else changes.

---

### Junior → FAANG: Why the Deque Achieves O(n) for Sliding Window Maximum

Scanning each window for its maximum is O(n · k). A heap gives O(n log k) but needs lazy deletion, because a binary heap cannot remove an arbitrary expired element, only its root. The deque reaches O(n).

Interviewers ask "why is this O(n) and not O(n · k)?" because the code visibly contains a loop inside a loop. The answer is a counting argument, not an appeal to the inner loop usually being short: each index is appended exactly once and removed at most once, so across the whole run the total number of removals is bounded by n no matter how they cluster. A single iteration can pop many elements, but only by consuming pops that no later iteration can perform. Total work is O(n), independent of k.

This is the same argument that makes the monotonic stack O(n) for the histogram and for trapping rain water. It is worth being able to state in that form, because "amortized O(1)" recited without the counting behind it does not distinguish you from someone who memorized the complexity.

### Senior @ FAANG: Sliding Window Maximum in Time-Series Databases and Real-Time Monitoring

"Rolling maximum over the last N minutes" is a standard monitoring query, and PromQL spells it `max_over_time(metric[5m])`. The interesting part for a senior engineer is not that the query exists but why the interview version of this algorithm does not directly apply to it.

Three assumptions break. The window is defined by *time*, not by element count, so eviction is driven by a timestamp rather than by `i-k`, and the number of elements in a window varies. Samples are not uniformly spaced, so gaps and late arrivals mean the window's contents are not knowable from an index. And a query engine typically evaluates a range query by iterating the samples that fall inside the range, which is O(window) and perfectly adequate, rather than incrementally maintaining a deque across evaluations. The deque's advantage only materializes when windows *slide*, sharing most of their contents with the previous window. Evaluate windows independently and there is nothing to amortize.

That is the transferable judgment: the monotonic deque pays off when consecutive windows overlap heavily and the aggregation is non-invertible. Change either condition and a simpler structure wins. Recognizing that the optimization's precondition is absent is as valuable as knowing the optimization.
