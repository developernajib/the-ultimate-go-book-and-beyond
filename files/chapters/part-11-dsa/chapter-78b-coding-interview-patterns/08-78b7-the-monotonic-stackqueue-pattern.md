## 78B.7 The Monotonic Stack/Queue Pattern

```
┌──────────────────────────────────────────────────────────────────┐
│              MONOTONIC STACK / QUEUE PATTERN                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Monotonic Decreasing Stack (for next greater element):          │
│                                                                  │
│  Input:  [2, 1, 2, 4, 3]                                         │
│  Stack:  │   │   Scan left to right, stack holds indices         │
│          │ 3 │                                                   │
│          │ 4 │   Pop elements smaller than current:              │
│          └───┘   the arriving value is their next greater        │
│                                                                  │
│  Result: [4, 2, 4, -1, -1]  (next greater for each element)      │
│           ^        ^                                             │
│           |        the 2 at index 2 also resolves to 4           │
│           the first 2 skips over 1 and resolves to 4             │
│                                                                  │
│  Key insight: Maintain a stack with a monotonic property         │
│  to efficiently find the next greater/smaller element.           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

A monotonic stack maintains elements in either strictly increasing or decreasing order. When a new element violates the order, we pop elements until the invariant is restored. This gives us O(n) solutions for "next greater/smaller element" problems.

**When to use Monotonic Stack:**
- Next greater/smaller element
- Previous greater/smaller element
- Largest rectangle in histogram
- Trapping rain water
- Stock span problems

---

### Problem 1: Next Greater Element I (LC 496)

**Problem:** Given two arrays `nums1` (subset of `nums2`), find the next greater element for each element of `nums1` in `nums2`.

**Approach:** Use a monotonic decreasing stack to compute the next greater element for every element in `nums2`, store results in a map.

```go
func nextGreaterElement(nums1 []int, nums2 []int) []int {
    nextGreater := make(map[int]int)
    stack := []int{} // monotonic decreasing stack

    for _, num := range nums2 {
        // Pop elements smaller than current: current is their next greater
        for len(stack) > 0 && stack[len(stack)-1] < num {
            nextGreater[stack[len(stack)-1]] = num
            stack = stack[:len(stack)-1]
        }
        stack = append(stack, num)
    }

    // Remaining elements have no next greater
    for _, num := range stack {
        nextGreater[num] = -1
    }

    result := make([]int, len(nums1))
    for i, num := range nums1 {
        result[i] = nextGreater[num]
    }

    return result
}
```

**Time Complexity:** O(n + m) where n = len(nums1) and m = len(nums2). Each element is pushed and popped at most once.
**Space Complexity:** O(m) for the stack and map.

This solution keys the map by *value*, not by index, and that is only sound because LC 496 guarantees all values in `nums2` are distinct. Drop that guarantee and it silently returns wrong answers: for `nums2 = [2, 4, 2, 1]` the first 2 has next greater 4 and the second 2 has none, but both write to `nextGreater[2]`, so the last write wins and the query returns -1 for both. Say the distinctness assumption out loud when you use this shape. If values can repeat, the question "the next greater element of *which* 2?" has no answer unless the caller identifies elements by index, which changes the problem.

**Edge cases:**
- nums1 has one element
- All elements in decreasing order → all -1
- All elements in increasing order → each resolves to its immediate successor

---

### Problem 2: Daily Temperatures (LC 739)

**Problem:** Given daily temperatures, return an array where `answer[i]` is the number of days until a warmer temperature. If no warmer day, answer[i] = 0.

**Approach:** Monotonic decreasing stack storing indices. When we find a warmer day, pop and compute the distance.

```go
func dailyTemperatures(temperatures []int) []int {
    n := len(temperatures)
    answer := make([]int, n)
    stack := []int{} // stack of indices, monotonic decreasing by temperature

    for i := 0; i < n; i++ {
        for len(stack) > 0 && temperatures[i] > temperatures[stack[len(stack)-1]] {
            j := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            answer[j] = i - j
        }
        stack = append(stack, i)
    }

    return answer
}
```

**Time Complexity:** O(n). Each index is pushed and popped at most once.
**Space Complexity:** O(n) for the stack.

Indices on the stack that are never popped keep their `answer[j]` at 0, which is the required "no warmer day" value. Go zero-initializes the slice, so this needs no explicit handling. That is convenient, but call it out rather than leaving it implicit, since the same code in a language without zeroed allocation would return garbage.

**Edge cases:**
- Constantly decreasing temperatures → all 0s
- Constantly increasing → [1, 1, 1, ..., 0]
- All same temperature → all 0s, since the pop test is strict `>`

---

### Problem 3: Largest Rectangle in Histogram (LC 84)

**Problem:** Given an array of integers `heights` representing a histogram, find the area of the largest rectangle.

**Approach:** Monotonic increasing stack. For each bar, find the nearest shorter bar on both sides. The width of the rectangle with that bar as height is `right_boundary - left_boundary - 1`.

```go
func largestRectangleArea(heights []int) int {
    n := len(heights)
    stack := []int{} // monotonic increasing stack of indices
    maxArea := 0

    for i := 0; i <= n; i++ {
        // Use 0 as sentinel for the end
        h := 0
        if i < n {
            h = heights[i]
        }

        for len(stack) > 0 && h < heights[stack[len(stack)-1]] {
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

**Time Complexity:** O(n).
**Space Complexity:** O(n).

**Edge cases:**
- Single bar → its height
- All same height → height * n
- Strictly increasing → the whole histogram forms triangular widths
- Strictly decreasing → each bar only contributes its own width

---

### Problem 4: Sliding Window Maximum (LC 239), Monotonic Deque

**Problem:** Given an array and window size `k`, return the maximum value in each sliding window.

**Approach:** Use a monotonic decreasing deque (double-ended queue) storing indices. The front always holds the index of the maximum in the current window.

```go
func maxSlidingWindow(nums []int, k int) []int {
    n := len(nums)
    result := make([]int, 0, n-k+1)
    deque := []int{} // indices, monotonic decreasing by value

    for i := 0; i < n; i++ {
        // Remove elements outside the window from the front
        for len(deque) > 0 && deque[0] <= i-k {
            deque = deque[1:]
        }

        // Remove smaller elements from the back
        for len(deque) > 0 && nums[deque[len(deque)-1]] <= nums[i] {
            deque = deque[:len(deque)-1]
        }

        deque = append(deque, i)

        // Add to result once we have a full window
        if i >= k-1 {
            result = append(result, nums[deque[0]])
        }
    }

    return result
}
```

**Time Complexity:** O(n). Each element is added to and removed from the deque at most once.
**Space Complexity:** O(k) for the deque.

The `<=` in the back-eviction test rather than `<` matters less than it looks: popping equal values keeps the deque shorter and is still correct, because an equal element that arrives later survives longer in the window and therefore dominates the earlier one. Using `<` is also correct, just slightly less compact. `deque = deque[1:]` reslices instead of copying, so front eviction is O(1), not a shift.

**Edge cases:**
- k=1 → return the input array itself
- k=n → return [max(nums)]
- All same values → all windows have the same max
- Strictly decreasing → each window max is the leftmost element

---

### Junior → FAANG: Reading the Stack Direction Before You Write

Monotonic stack problems have a specific tell: the problem asks for the "next greater," "next smaller," "previous greater," or "previous smaller" element for each position. Before writing any code, determine which direction the stack should maintain monotonicity. A monotonically decreasing stack (elements on the stack are in decreasing order) pops when a larger element arrives, meaning each pop event is a "next greater element found" event. A monotonically increasing stack (elements in increasing order) pops when a smaller element arrives, giving "next smaller element found" events.

Worked recognition exercise for Daily Temperatures: you want, for each day, how many days until a warmer temperature. That is "next greater element" in index distance. Use a decreasing stack of indices. When `temps[i] > temps[stack.top()]`, the wait for the day at `stack.top()` is `i - stack.top()`. Pop, record, continue. The stack invariant is maintained because you only push index `i` after all smaller-temperature days have been resolved.

Junior mistake: building the stack bottom-to-top vs. top-to-bottom confusion. In Go, a stack is a slice where `append` is push and `s[len(s)-1]` with `s = s[:len(s)-1]` is pop. This is idiomatic and efficient. Using a separate index variable to simulate a stack leads to off-by-one bugs.

Entry-level signal: recognizing the Largest Rectangle in Histogram as a monotonic stack problem without hints. The tell is "for each bar, find the farthest left and right extent where this bar is the minimum height," which is a left and right boundary problem solvable by two monotonic stack passes or one combined pass with sentinel values.

### Senior @ FAANG: Monotonic Structures in Stream Processing and Real-Time Analytics

The reason sliding window maximum needs a deque at all is worth understanding, because it generalizes. Sum over a sliding window is easy: addition has an inverse, so you add the entering element and subtract the leaving one in O(1). Maximum has no inverse. When the maximum leaves the window you cannot subtract it, you have to know what the second-best was, and the deque is exactly the structure that remembers the candidates that could still become the maximum. Any aggregation that is associative but not invertible (max, min, and to a degree distinct-count) has this same problem, and it is why stream processing engines treat sum and max differently when they aggregate over windows. When you meet a windowed aggregation in a design discussion, the first question is whether the operator has an inverse, because that decides whether you need O(1) state or a candidate structure.

The monotonic stack shows up wherever a time series is scanned for "how far until something bigger." Local extrema detection, span-style indicators, and skyline or visibility problems are all the same structure with a different label on the axis.

ADR consideration: when implementing a custom aggregation over a sliding time window in a Go service, the monotonic deque approach requires careful handling of eviction by time vs. by count. A time-based eviction policy means the deque may not shrink predictably under bursty loads, requiring a capacity cap and graceful degradation when the cap is hit. Document the eviction policy, the cap, and the behavior when the cap is exceeded (drop oldest, drop newest, or return an error).

Bar-raiser signal: the candidate explains the amortized argument correctly. The inner `for` loop looks like it makes the algorithm O(n²), and the answer is not "it usually doesn't run much" but a counting argument: each index is pushed exactly once and popped at most once, so the total number of pop operations across the entire run is bounded by n regardless of how they cluster. Total work is O(n), even though a single iteration can do O(n) pops. They also recognize that Trapping Rain Water admits a monotonic stack solution, a two-pointer solution in O(1) space, and a prefix/suffix maximum solution in O(n) space, and can say which they would pick and why. A candidate who adds that none of the three carries over to the 2D version, which needs a priority queue processing the boundary inward because water level is no longer determined by a left and a right maximum, is showing they understand why the 1D approaches work rather than that they memorized them.
