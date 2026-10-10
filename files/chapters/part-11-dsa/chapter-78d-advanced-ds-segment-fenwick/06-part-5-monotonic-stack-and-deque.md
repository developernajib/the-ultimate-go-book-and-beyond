## 78D.5 Monotonic Stack and Deque

### What Is a Monotonic Stack?

A monotonic stack maintains elements in either strictly increasing or strictly decreasing order. When we push a new element, we pop all elements that violate the monotonic property.

**Use cases:**
- Next Greater Element
- Previous Smaller Element
- Largest Rectangle in Histogram
- Trapping Rain Water

### LeetCode 496: Next Greater Element I

**Problem:** Given two arrays `nums1` and `nums2` where `nums1` is a subset of `nums2`, find the next greater element for each element of `nums1` in `nums2`.

A single pass over `nums2` with a monotonic decreasing stack computes the next greater element for every value, storing results in a map. Elements remaining on the stack after the pass have no next greater element and are assigned -1.

```go
func nextGreaterElement(nums1 []int, nums2 []int) []int {
	// Build a map: value -> its next greater element in nums2
	nextGreater := make(map[int]int)
	stack := []int{} // monotonic decreasing stack

	for _, num := range nums2 {
		for len(stack) > 0 && stack[len(stack)-1] < num {
			nextGreater[stack[len(stack)-1]] = num
			stack = stack[:len(stack)-1]
		}
		stack = append(stack, num)
	}

	result := make([]int, len(nums1))
	for i, num := range nums1 {
		if ng, ok := nextGreater[num]; ok {
			result[i] = ng
		} else {
			result[i] = -1
		}
	}
	return result
}
```

**Complexity:** O(m + n) time, O(n) space.
**Key insight:** Use a decreasing monotonic stack. A number larger than the stack top is the next greater element for every smaller element sitting on the stack, so one arrival can resolve many pending answers at once.

This keys the map by **value**, which is sound only because LC 496 guarantees the values in `nums2` are distinct. If they can repeat, two occurrences of the same value may have different next-greater elements and the map keeps only the last write. The `ok` check handles "never resolved" cleanly, but it cannot rescue an ambiguous key. State the distinctness assumption when you use this shape.

### LeetCode 503: Next Greater Element II (Circular Array)

**Problem:** Same as above, but the array is circular.

```go
func nextGreaterElements(nums []int) []int {
	n := len(nums)
	result := make([]int, n)
	for i := range result {
		result[i] = -1
	}
	stack := []int{} // stack of indices

	// Traverse twice to handle circularity
	for i := 0; i < 2*n; i++ {
		idx := i % n
		for len(stack) > 0 && nums[stack[len(stack)-1]] < nums[idx] {
			result[stack[len(stack)-1]] = nums[idx]
			stack = stack[:len(stack)-1]
		}
		if i < n {
			stack = append(stack, idx)
		}
	}
	return result
}
```

**Complexity:** O(n) time, O(n) space.
**Key insight:** Traverse twice to simulate circularity, but only push during the first pass. The second pass exists purely to *resolve* indices still on the stack, and pushing during it would let an element wrap around and match itself.

Two passes suffice because one full lap past an element examines every other element. If nothing greater is found in a lap, nothing greater exists, and the `-1` pre-fill is already the answer for anything left on the stack. This is also why the stack stores indices here rather than values, unlike LC 496: results must be written back to specific positions, and this array may contain duplicates.

### LeetCode 739: Daily Temperatures

**Problem:** Given an array of daily temperatures, return an array where `answer[i]` is the number of days you have to wait after day `i` to get a warmer temperature.

```go
func dailyTemperatures(temperatures []int) []int {
	n := len(temperatures)
	result := make([]int, n)
	stack := []int{} // stack of indices, monotonic decreasing by temperature

	for i := 0; i < n; i++ {
		for len(stack) > 0 && temperatures[stack[len(stack)-1]] < temperatures[i] {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			result[j] = i - j
		}
		stack = append(stack, i)
	}
	return result
}
```

**Complexity:** O(n) time, O(n) space.
**Key insight:** Maintain a stack of indices in decreasing temperature order. When a warmer day arrives, pop all cooler days and record the distance.

### LeetCode 84: Largest Rectangle in Histogram

**Problem:** Given an array of heights representing a histogram, find the area of the largest rectangle that can be formed.

```go
func largestRectangleArea(heights []int) int {
	n := len(heights)
	stack := []int{} // stack of indices, monotonic increasing by height
	maxArea := 0

	for i := 0; i <= n; i++ {
		// Use 0 as sentinel for the end
		h := 0
		if i < n {
			h = heights[i]
		}

		for len(stack) > 0 && heights[stack[len(stack)-1]] > h {
			height := heights[stack[len(stack)-1]]
			stack = stack[:len(stack)-1]

			width := i
			if len(stack) > 0 {
				width = i - stack[len(stack)-1] - 1
			}

			area := height * width
			if area > maxArea {
				maxArea = area
			}
		}
		stack = append(stack, i)
	}
	return maxArea
}
```

**Complexity:** O(n) time, O(n) space.
**Key insight:** Maintain an increasing monotonic stack of indices. When we encounter a shorter bar, we pop and calculate the area using the popped bar's height. The width extends from the new stack top to the current index.

### LeetCode 42: Trapping Rain Water

**Problem:** Given `n` non-negative integers representing an elevation map, compute how much water it can trap after raining.

**Approach 1: Monotonic stack**

```go
func trap(height []int) int {
	stack := []int{}
	water := 0

	for i := 0; i < len(height); i++ {
		for len(stack) > 0 && height[stack[len(stack)-1]] < height[i] {
			bottom := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				break
			}
			left := stack[len(stack)-1]
			w := i - left - 1
			h := min(height[left], height[i]) - height[bottom]
			water += w * h
		}
		stack = append(stack, i)
	}
	return water
}

// min is the builtin, available since Go 1.21.
```

This one fills water in **horizontal layers**, not columns. Each pop identifies a `bottom` bounded by `left` (the new stack top) and `i` (the arriving bar), and adds the slab between them. That is why it needs the `len(stack) == 0` check: with nothing to the left, there is no wall, so the water spills and there is nothing to add.

**Approach 2: Two pointers (optimal)**

(An alternative implementation of the same function. Two `trap` functions will not compile in one package.)

```go
func trap(height []int) int {
	left, right := 0, len(height)-1
	leftMax, rightMax := 0, 0
	water := 0

	for left < right {
		if height[left] < height[right] {
			if height[left] >= leftMax {
				leftMax = height[left]
			} else {
				water += leftMax - height[left]
			}
			left++
		} else {
			if height[right] >= rightMax {
				rightMax = height[right]
			} else {
				water += rightMax - height[right]
			}
			right--
		}
	}
	return water
}
```

**Complexity:** Both O(n) time. The stack uses O(n) space, the two pointers O(1).
**Key insight (two pointers):** Water above position i is `min(leftMax, rightMax) - height[i]`. The two-pointer version computes this while only ever knowing one of the two maxima for certain, which is the part that deserves an explanation rather than a claim.

The argument: when `height[left] < height[right]`, whatever the true `rightMax` turns out to be, it is at least `height[right]`, and `height[right]` already exceeds `height[left]`. So `leftMax` is definitely the smaller of the two maxima, and the water level at `left` is settled by `leftMax` alone. The unknown value cannot change the answer because it cannot be the minimum. That is why it is safe to commit to a result while still ignorant of half the array. Advance the smaller side and the same argument applies at each step.

Both approaches are correct and the two-pointer one is strictly better on space. Know the stack version anyway: it generalizes to problems where you need the bounding pair itself, not just the total.

### LeetCode 862: Shortest Subarray with Sum at Least K

**Problem:** Given an integer array `nums` and an integer `k`, return the length of the shortest non-empty subarray with sum at least `k`. If no such subarray exists, return -1. (Array may contain negative numbers.)

**Key insight:** Use prefix sums + monotonic deque. We need the shortest `j - i` such that `prefix[j] - prefix[i] >= k`.

```go
func shortestSubarray(nums []int, k int) int {
	n := len(nums)
	prefix := make([]int64, n+1)
	for i := 0; i < n; i++ {
		prefix[i+1] = prefix[i] + int64(nums[i])
	}

	result := n + 1
	deque := []int{} // indices into prefix, monotonically increasing by prefix value

	for j := 0; j <= n; j++ {
		// If prefix[j] - prefix[deque.front] >= k, we found a candidate
		for len(deque) > 0 && prefix[j]-prefix[deque[0]] >= int64(k) {
			length := j - deque[0]
			if length < result {
				result = length
			}
			deque = deque[1:] // pop front - we cannot do better with this start
		}

		// Maintain monotonicity: remove indices with prefix >= prefix[j]
		for len(deque) > 0 && prefix[deque[len(deque)-1]] >= prefix[j] {
			deque = deque[:len(deque)-1]
		}

		deque = append(deque, j)
	}

	if result == n+1 {
		return -1
	}
	return result
}
```

**Complexity:** O(n) time, O(n) space.

**Why the monotonic deque works here:**
1. The deque holds indices whose prefix sums are strictly increasing.
2. For each `j`, if the front gives `prefix[j] - prefix[front] >= k`, that is a valid subarray. Record its length and **pop the front permanently**: any later `j` paired with this same start yields a strictly longer subarray, so this start can never again produce a better answer. It is finished, not merely skipped.
3. Pop from the back any index whose prefix is `>= prefix[j]`. Such an index is dominated: `j` has a prefix that is no larger *and* sits further right, so for every future endpoint, `j` yields a sum at least as large over a shorter span. A dominated start can never win, so it is deleted rather than kept.

Each index is pushed once and popped once, from either end, giving O(n) despite the nested loops.

**Why this is not just a sliding window.** With negative numbers, `prefix` is not monotone, so growing the window can *decrease* the sum. The standard two-pointer window relies on the invariant that extending right increases the sum and shrinking left decreases it, and that invariant is exactly what negatives destroy. The deque replaces the assumption with an explicit structure: rather than assuming earlier starts are worse, it maintains the set of starts that could still be optimal and evicts the rest by proof. This is the single best illustration in the chapter of what to do when a window's monotonicity assumption fails, and it is why LC 862 is much harder than LC 209, its all-positive counterpart.

Note the `int64` prefix sums. With up to 10^5 elements at magnitude 10^4, the total fits comfortably in an `int` on a 64-bit platform, but the explicit `int64` documents the intent and keeps the code correct on a 32-bit target where `int` is 32 bits and the sum would overflow.

---

### Junior → FAANG: Distinguishing Stack and Deque Variants

The monotonic stack processes elements once and gives answers about global next/previous relationships. The monotonic deque adds a second invariant: elements outside the window are evicted from the front, giving answers about local (windowed) relationships. The interview signal for using a deque instead of a stack is the phrase "sliding window" in combination with "maximum," "minimum," or "sum at least K." When you see those words together, the deque is the tool: push to the back, evict from the front when out of window, pop from the back when violating the monotonic property. Practice LC 239 and LC 862 until the deque manipulation is automatic.

### Senior @ FAANG: Monotonic Structures in Real-Time Data Processing Pipelines

The idea worth carrying out of this section is the one that makes the deque necessary at all: **some aggregations have an inverse and some do not.** Sum does, so a windowed sum needs O(1) state, adding the entrant and subtracting the leaver. Max does not. You cannot un-max a departing element, so when the current maximum leaves the window you must already know the runner-up, and the deque is precisely the set of elements that could still become the maximum. Min, max, and distinct-count all share this. When you meet a windowed aggregation in a design review, ask whether the operator is invertible, because that single question decides whether the state is a counter or a candidate structure, and therefore whether memory is O(1) or O(window).

"Shortest subarray with sum at least K" is the same shape as "how quickly did this cumulative metric cross a threshold," which is a real alerting primitive.

The concern that follows is state size. The deque's bound is the window, so a window defined by count or by time is bounded and a window defined by a data-dependent condition is not. Systems that process out-of-order events bound the state by time, evicting anything older than a watermark, which is really just a principled answer to "how late can an event be before I stop caring." That is the same eviction the deque's front does, with the clock supplying the boundary instead of an index. The follow-on question, what to do when an event arrives after its window's result was already emitted, has no free answer: either hold state longer, accept the loss, or emit a correction downstream.
