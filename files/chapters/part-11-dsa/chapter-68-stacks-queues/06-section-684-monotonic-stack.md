## 68.4 Monotonic Stack

A monotonic stack maintains elements in sorted order (either increasing or decreasing). It's extremely useful for finding the next greater/smaller element.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    MONOTONIC STACK CONCEPT                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Problem: Find next greater element for each position                │
│  Array: [2, 1, 2, 4, 3]                                              │
│  Result: [4, 2, 4, -1, -1]                                           │
│                                                                      │
│  Monotonic DECREASING stack (for next greater):                      │
│                                                                      │
│  i=0: Stack=[] → Push 0                                              │
│       Stack=[0(val=2)]                                               │
│                                                                      │
│  i=1: 1 < 2 → Push 1                                                 │
│       Stack=[0(2), 1(val=1)]                                         │
│                                                                      │
│  i=2: 2 > 1 → Pop 1, result[1]=2                                     │
│       2 = 2 → Push 2                                                 │
│       Stack=[0(2), 2(val=2)]                                         │
│                                                                      │
│  i=3: 4 > 2 → Pop 2, result[2]=4                                     │
│       4 > 2 → Pop 0, result[0]=4                                     │
│       Stack empty → Push 3                                           │
│       Stack=[3(val=4)]                                               │
│                                                                      │
│  i=4: 3 < 4 → Push 4                                                 │
│       Stack=[3(4), 4(val=3)]                                         │
│                                                                      │
│  Remaining elements have no next greater → result[3]=-1, result[4]=-1│
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

```go
package monotonic

// NextGreaterElement finds the next greater element for each element.
// This is the core pattern. LeetCode 496 (Next Greater Element I) is this
// plus a map from value to answer, because there nums1 is a subset of nums2
// and you look the results up rather than returning them positionally.
// Time: O(n), Space: O(n)
func NextGreaterElement(nums []int) []int {
    n := len(nums)
    result := make([]int, n)

    // Initialize with -1 (no greater element found)
    for i := range result {
        result[i] = -1
    }

    // Monotonic decreasing stack (stores indices)
    stack := []int{}

    for i := 0; i < n; i++ {
        // Pop while current element is greater than stack top
        for len(stack) > 0 && nums[i] > nums[stack[len(stack)-1]] {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[top] = nums[i]
        }
        stack = append(stack, i)
    }

    return result
}

// NextGreaterElementCircular handles circular arrays
// LeetCode 503: Next Greater Element II
// Time: O(n), Space: O(n)
func NextGreaterElementCircular(nums []int) []int {
    n := len(nums)
    result := make([]int, n)

    for i := range result {
        result[i] = -1
    }

    stack := []int{}

    // Iterate twice to handle circular nature
    for i := 0; i < 2*n; i++ {
        idx := i % n

        for len(stack) > 0 && nums[idx] > nums[stack[len(stack)-1]] {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[top] = nums[idx]
        }

        // Only push indices in first pass
        if i < n {
            stack = append(stack, idx)
        }
    }

    return result
}

// NextSmallerElement finds the next smaller element for each element
func NextSmallerElement(nums []int) []int {
    n := len(nums)
    result := make([]int, n)

    for i := range result {
        result[i] = -1
    }

    // Monotonic increasing stack
    stack := []int{}

    for i := 0; i < n; i++ {
        // Pop while current element is smaller than stack top
        for len(stack) > 0 && nums[i] < nums[stack[len(stack)-1]] {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[top] = nums[i]
        }
        stack = append(stack, i)
    }

    return result
}

// PreviousGreaterElement finds the previous greater element for each element
func PreviousGreaterElement(nums []int) []int {
    n := len(nums)
    result := make([]int, n)

    for i := range result {
        result[i] = -1
    }

    // Monotonic decreasing stack
    stack := []int{}

    for i := 0; i < n; i++ {
        // Pop until we find a greater element
        for len(stack) > 0 && nums[stack[len(stack)-1]] <= nums[i] {
            stack = stack[:len(stack)-1]
        }

        if len(stack) > 0 {
            result[i] = nums[stack[len(stack)-1]]
        }

        stack = append(stack, i)
    }

    return result
}

// DailyTemperatures returns days until a warmer temperature
// LeetCode 739: Daily Temperatures
// Time: O(n), Space: O(n)
func DailyTemperatures(temperatures []int) []int {
    n := len(temperatures)
    result := make([]int, n)
    stack := []int{} // monotonic decreasing stack

    for i := 0; i < n; i++ {
        for len(stack) > 0 && temperatures[i] > temperatures[stack[len(stack)-1]] {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[top] = i - top
        }
        stack = append(stack, i)
    }

    return result
}
```

### Largest Rectangle in Histogram

This classic problem asks for the maximum area rectangle that can be formed using consecutive bars of a histogram. The approach uses two monotonic increasing stacks (one scanning left-to-right to find the nearest shorter bar on the left, and one scanning right-to-left for the right), then computes each bar's maximum width at its own height. The optimized single-pass variant appends sentinel zeros to both ends so all pending bars are automatically flushed when the loop ends.

```go
// LargestRectangleInHistogram finds the largest rectangle in a histogram
// LeetCode 84: Largest Rectangle in Histogram
// Time: O(n), Space: O(n)
func LargestRectangleInHistogram(heights []int) int {
    n := len(heights)
    if n == 0 {
        return 0
    }

    // For each bar, find the first smaller bar on left and right
    leftSmaller := make([]int, n)
    rightSmaller := make([]int, n)

    // Find left smaller using monotonic increasing stack
    stack := []int{}
    for i := 0; i < n; i++ {
        for len(stack) > 0 && heights[stack[len(stack)-1]] >= heights[i] {
            stack = stack[:len(stack)-1]
        }
        if len(stack) == 0 {
            leftSmaller[i] = -1
        } else {
            leftSmaller[i] = stack[len(stack)-1]
        }
        stack = append(stack, i)
    }

    // Find right smaller
    stack = []int{}
    for i := n - 1; i >= 0; i-- {
        for len(stack) > 0 && heights[stack[len(stack)-1]] >= heights[i] {
            stack = stack[:len(stack)-1]
        }
        if len(stack) == 0 {
            rightSmaller[i] = n
        } else {
            rightSmaller[i] = stack[len(stack)-1]
        }
        stack = append(stack, i)
    }

    // Calculate max area
    maxArea := 0
    for i := 0; i < n; i++ {
        width := rightSmaller[i] - leftSmaller[i] - 1
        area := heights[i] * width
        if area > maxArea {
            maxArea = area
        }
    }

    return maxArea
}

// LargestRectangleOptimized uses a single pass
// Time: O(n), Space: O(n)
func LargestRectangleOptimized(heights []int) int {
    // Add sentinel values
    heights = append([]int{0}, heights...)
    heights = append(heights, 0)

    n := len(heights)
    stack := []int{0} // start with sentinel
    maxArea := 0

    for i := 1; i < n; i++ {
        for heights[i] < heights[stack[len(stack)-1]] {
            h := heights[stack[len(stack)-1]]
            stack = stack[:len(stack)-1]
            w := i - stack[len(stack)-1] - 1
            area := h * w
            if area > maxArea {
                maxArea = area
            }
        }
        stack = append(stack, i)
    }

    return maxArea
}
```

### Maximal Rectangle

LeetCode 85 extends the histogram problem to a 2D binary matrix by treating each row as the base of a histogram: for each cell containing `'1'`, the height is the count of consecutive `'1'`s above it (including itself), while a `'0'` resets the height to zero. After building the per-row height array, the problem reduces to running `LargestRectangleOptimized` on that array, giving an overall O(m×n) solution.

```go
// MaximalRectangle finds the largest rectangle containing only 1s
// LeetCode 85: Maximal Rectangle
// Time: O(m*n), Space: O(n)
func MaximalRectangle(matrix [][]byte) int {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return 0
    }

    m, n := len(matrix), len(matrix[0])
    heights := make([]int, n)
    maxArea := 0

    for i := 0; i < m; i++ {
        // Build histogram for current row
        for j := 0; j < n; j++ {
            if matrix[i][j] == '1' {
                heights[j]++
            } else {
                heights[j] = 0
            }
        }

        // Find largest rectangle in histogram
        area := LargestRectangleOptimized(append([]int{}, heights...))
        if area > maxArea {
            maxArea = area
        }
    }

    return maxArea
}
```

### Trapping Rain Water

LeetCode 42 asks how much rainwater is trapped between elevation bars after it rains. The stack-based approach processes bars left to right, using a monotonic stack to identify "bowls". Whenever a taller bar is encountered, it acts as the right wall for water trapped above all shorter bars currently on the stack. The two-pointer variant achieves the same O(n) time with O(1) space by advancing inward from both ends, always moving the side with the shorter current maximum.

```go
// Trap calculates how much water can be trapped
// LeetCode 42: Trapping Rain Water
// Time: O(n), Space: O(n) using stack
func Trap(height []int) int {
    stack := []int{}
    water := 0

    for i := 0; i < len(height); i++ {
        // While current bar is higher than stack top
        for len(stack) > 0 && height[i] > height[stack[len(stack)-1]] {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]

            if len(stack) == 0 {
                break
            }

            left := stack[len(stack)-1]
            width := i - left - 1
            boundedHeight := min(height[i], height[left]) - height[top]
            water += width * boundedHeight
        }
        stack = append(stack, i)
    }

    return water
}

// TrapTwoPointer uses two pointers
// Time: O(n), Space: O(1)
func TrapTwoPointer(height []int) int {
    if len(height) == 0 {
        return 0
    }

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

### Why the Total Work Is O(n)

Every function above has a loop nested inside a loop, which looks like O(n^2) and is not. The argument is worth being able to state precisely, because it is the standard follow-up.

Count pushes, not iterations. Each index is pushed exactly once, in the outer loop. The inner `for` does nothing but pop, and an index can only be popped once, because nothing ever pushes it back. So across the entire run the inner loop body executes at most n times in total, no matter how it is distributed across outer iterations. Total work is at most n pushes plus at most n pops, which is O(n).

This is an amortized argument, and the distribution really is lumpy: on `[5,4,3,2,1,6]` the last element pops all five predecessors in a single outer iteration. That one iteration is O(n), and it is still O(n) overall, because those five pops were prepaid by the five pushes that put them there. The same accounting justifies the two-stack queue in section 68.6, and it is the same reason `append` is O(1) amortized. If an interviewer asks "isn't that nested loop quadratic?", answer with the token argument rather than by tracing an example.

### Junior -> FAANG: Monotonic Stack Pattern Recognition

The monotonic stack is the single most powerful interview pattern in this chapter. It solves a family of "next greater/smaller element" problems in O(n) that would otherwise require O(n^2) nested loops.

**The four variants and their pop conditions.** The stack always holds indices, so every comparison goes through the array. Writing `stack.top` where you mean `nums[stack.top]` is how people confuse themselves here.

- Next greater: pop while `nums[stack.top] < nums[i]` - the popped element's answer is `nums[i]` (decreasing stack)
- Next smaller: pop while `nums[stack.top] > nums[i]` - the popped element's answer is `nums[i]` (increasing stack)
- Previous greater: pop while `nums[stack.top] <= nums[i]` - the answer for `i` is `nums[stack.top]` of whatever survives
- Previous smaller: pop while `nums[stack.top] >= nums[i]` - the answer for `i` is `nums[stack.top]` of whatever survives

The structural difference is worth naming, because it is what people actually miss: in the "next" variants the answer is assigned to the element being *popped*, and in the "previous" variants the answer is read for the element being *pushed*. Same stack, opposite direction of information flow.

Note also which comparisons are strict. `<` and `>` keep equal elements on the stack, so "next greater" means strictly greater. `<=` and `>=` pop equals. Whether ties count is a question to ask the interviewer, and it is exactly the difference between the pop conditions above.

The confusion between variants is the most common interview mistake. Practice all four before the interview by tracing through [2, 1, 2, 4, 3] for each variant, since that input has a duplicate and will expose a tie-handling mistake.

**The three key problems to master:**
1. `DailyTemperatures` (LeetCode 739): next greater, O(n), return number of days.
2. `LargestRectangleInHistogram` (LeetCode 84): single-pass with sentinel zeros, O(n).
3. `Trap` (LeetCode 42): monotonic stack version plus the two-pointer O(1)-space version.

For LeetCode 84, the sentinel-zero approach is the cleanest implementation. Add a 0 at the start and end of `heights`, then the main loop never needs to handle the "stack not empty at loop end" edge case because the final 0 flushes all remaining bars.

**Interview habit:** When you push to the stack, always push indices, not values. You need the index to compute widths or distances. Access the value via `nums[stack[top]]`. Writing "store indices, access values through array" as a comment prevents the common mistake of storing values and losing position information.

### Senior @ FAANG: Monotonic Stack in Production and System Design

**Production applications of monotonic stacks.**

The next-greater-element pattern appears directly in production stream processing: "for each sensor reading, find how long until the next reading exceeds this one" is exactly `DailyTemperatures` on a real-time event stream. A streaming version processes events one at a time, maintaining the monotonic stack as state, and emits answers when elements are popped. This is O(1) amortized per event and O(n) total.

The largest rectangle in histogram pattern appears in resource allocation: "given a timeline of CPU utilization, find the largest contiguous block of time where utilization was below a threshold" is structurally identical. The histogram is the inverted utilization curve, and the largest rectangle is the largest available window.

**`Trap` as a canonical trade-off discussion.** The trapping rain water problem has three known approaches: dynamic programming (O(n) time, O(n) space for prefix arrays), monotonic stack (O(n) time, O(n) stack space), and two pointers (O(n) time, O(1) space). An interviewer asking you to solve this problem and then asking "can you do it in O(1) space?" is specifically testing whether you know the two-pointer approach. The key insight of the two-pointer approach is: the water at position i is determined by `min(leftMax, rightMax) - height[i]`. The two-pointer approach processes from the side with the smaller current maximum, because that side's water height is fully determined by the already-computed maximum.

**ADR: precomputing next-greater links at ingestion.** A monotonic stack maintained during ingestion answers exactly one question in O(1): "for this event, which later event was the first to exceed it?" Precompute that link per event and the query becomes a pointer follow instead of a scan. Be careful not to oversell it. This does not accelerate "previous event where metric > threshold" for a caller-supplied threshold, because the next-greater relation is defined against the neighbouring values, not against an arbitrary bound the querier picks later. Threshold queries want a different structure, typically a sparse table or segment tree over range maxima, which answers any threshold in O(log n) at the cost of O(n log n) space. Choosing between them comes down to whether the comparison target is fixed at ingestion (monotonic stack, O(1) amortized, one index per event) or supplied at query time (range-max structure). Conflating the two is the actual failure mode in this design space.

**Bar-raiser signal: `MaximalRectangle` complexity derivation.** The outer loop runs m times (one per row), and each inner `LargestRectangleOptimized` call runs in O(n). Total: O(m*n). A bar raiser will ask: "Can you do better than O(m*n)?" No, and the reason is simpler than it first sounds: any correct algorithm must read every cell, since flipping a single unread cell can change the answer, and there are m*n cells. That is an input-size bound, not a comparison-based bound. It has nothing to do with the sorting-style Omega(n log n) argument in Chapter 79, and conflating the two is a common tell. Recognizing when an algorithm is already optimal because it matches the cost of reading its input, and therefore refusing to optimize further, is the L6 signal here.
