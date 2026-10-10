## 78C.18 Monotonic Stack

A monotonic stack maintains elements in sorted order (increasing or decreasing). It is used to find the next greater/smaller element efficiently.

---
### LC 739 - Daily Temperatures

*(Covered in Stack section.)*

---
### LC 84 - Largest Rectangle in Histogram

*(Covered in Stack section.)*

---
### LC 42 - Trapping Rain Water

*(Covered in Two Pointers section.)*

---
### LC 496 - Next Greater Element I 🟢

**Key Insight**: Use a monotonic decreasing stack to precompute the next greater element for every number in nums2. Store in a map.

```go
func nextGreaterElement(nums1 []int, nums2 []int) []int {
    nextGreater := make(map[int]int)
    stack := []int{}

    for _, num := range nums2 {
        for len(stack) > 0 && stack[len(stack)-1] < num {
            nextGreater[stack[len(stack)-1]] = num
            stack = stack[:len(stack)-1]
        }
        stack = append(stack, num)
    }

    result := make([]int, len(nums1))
    for i, num := range nums1 {
        if val, ok := nextGreater[num]; ok {
            result[i] = val
        } else {
            result[i] = -1
        }
    }
    return result
}
```
**Time**: O(n + m).
**Space**: O(n).

---
### LC 503 - Next Greater Element II 🟡

**Key Insight**: The array is circular, so iterate through it twice using modulo indexing with a monotonic stack, pushing indices only on the first pass.

```go
func nextGreaterElements(nums []int) []int {
    n := len(nums)
    result := make([]int, n)
    for i := range result {
        result[i] = -1
    }
    stack := []int{} // indices

    for i := 0; i < 2*n; i++ {
        for len(stack) > 0 && nums[stack[len(stack)-1]] < nums[i%n] {
            idx := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[idx] = nums[i%n]
        }
        if i < n {
            stack = append(stack, i)
        }
    }
    return result
}
```
**Time**: O(n).
**Space**: O(n).

---

### Junior → FAANG: Recognizing the Monotonic Stack Pattern

The monotonic stack pattern has one trigger: you need the next (or previous) greater (or smaller) element for each position in an array. The invariant is simple: when pushing a new element, pop all elements that violate the monotonic property, recording the answer for each popped element. Increasing stack gives next-smaller, decreasing stack gives next-greater. The remaining elements on the stack after the pass have no such element. Memorize the four combinations (next/previous, greater/smaller) and practice on LC 739, LC 496, LC 503, and LC 84. The circular array variant (LC 503) just requires iterating twice using modulo indexing.

### Senior @ FAANG: Monotonic Stack in Stream Processing and Compiler Pipelines

At the senior level, the monotonic stack appears in non-obvious contexts. In stream processing systems (Kafka Streams, Flink), the "sliding window maximum" is computed using a monotonic deque (a deque maintaining decreasing order), enabling O(n) throughput regardless of window size. This is the core of windowed aggregation in real-time analytics. In compiler intermediate representation (IR) passes, monotonic sequences are used in loop-carried dependency analysis and register allocation. In financial systems, the "largest rectangle in histogram" problem models the maximum position size achievable given bar chart constraints on margin requirements. The bar-raiser question at L6 is: "How would you implement a sliding window maximum over a stream with late-arriving out-of-order events?" The answer involves watermarking for late data, a monotonic deque keyed by event time rather than arrival time, and a triggering policy (processing time, event time, or punctuation-based) for emitting window results. The staff-level concern is defining the correctness guarantee under reordering: with a bounded out-of-order tolerance, the deque must retain elements within the maximum expected delay, and the ADR must specify what happens to elements that arrive after the window has closed (drop, reprocess, or route to a correction pipeline).
