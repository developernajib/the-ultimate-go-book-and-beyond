## 66.4 Kadane's Algorithm

Kadane's algorithm solves the maximum subarray problem in a single linear pass by exploiting a key insight: at each index, either extend the running subarray or discard it and start fresh, whichever yields a larger value. This reduces an O(n²) brute-force search to O(n) because the decision at each step is purely local: if `currentSum` would drag the new element below its own value, reset. The product variant extends this by tracking both a running maximum and minimum simultaneously, since multiplying by a negative number flips which extreme becomes largest.

```go
// Maximum Subarray (LeetCode 53)
// Find contiguous subarray with largest sum
// Time: O(n), Space: O(1)
func maxSubArray(nums []int) int {
    maxSum := nums[0]
    currentSum := nums[0]

    for i := 1; i < len(nums); i++ {
        // Either extend current subarray or start new one
        currentSum = max(nums[i], currentSum+nums[i])
        maxSum = max(maxSum, currentSum)
    }
    return maxSum
}

// Maximum Product Subarray (LeetCode 152)
// Time: O(n), Space: O(1)
func maxProduct(nums []int) int {
    maxProd := nums[0]
    minProd := nums[0]
    result := nums[0]

    for i := 1; i < len(nums); i++ {
        // Swap when multiplying by negative
        if nums[i] < 0 {
            maxProd, minProd = minProd, maxProd
        }

        maxProd = max(nums[i], maxProd*nums[i])
        minProd = min(nums[i], minProd*nums[i])

        result = max(result, maxProd)
    }
    return result
}

// Maximum Sum Circular Subarray (LeetCode 918)
// Time: O(n), Space: O(1)
func maxSubarraySumCircular(nums []int) int {
    totalSum := 0
    maxSum := nums[0]
    currentMax := 0
    minSum := nums[0]
    currentMin := 0

    for _, num := range nums {
        currentMax = max(currentMax+num, num)
        maxSum = max(maxSum, currentMax)

        currentMin = min(currentMin+num, num)
        minSum = min(minSum, currentMin)

        totalSum += num
    }

    // If all negative, return max element
    if maxSum < 0 {
        return maxSum
    }

    // Max of: normal max subarray OR circular (total - min subarray)
    return max(maxSum, totalSum-minSum)
}
```

### Junior → FAANG: Internalizing Kadane's Decision Logic

Kadane's algorithm is a dynamic programming algorithm with O(1) state: at each position, the only state needed is the maximum subarray sum ending at the current index. The decision is: should the current element extend the previous subarray (`currentSum + nums[i]`) or start a new subarray from itself (`nums[i]`)? Whichever is larger becomes the new `currentSum`. The global `maxSum` records the best seen so far.

The product variant is trickier because multiplication by a negative number flips sign. The solution is to track both the running maximum and running minimum, because a large negative minimum can become the largest value after multiplying by a negative element. The swap on negative input (`if nums[i] < 0 { maxProd, minProd = minProd, maxProd }`) ensures that after the swap, multiplying the max (which is now the most negative value) by the negative element produces the new maximum.

The circular subarray variant reveals a beautiful insight: the maximum circular subarray is either a standard subarray (use Kadane normally) or it wraps around the ends of the array (equivalent to the total sum minus the minimum subarray in the middle). Running Kadane with min in place of max to find the minimum subarray gives the second case in O(n).

### Senior @ FAANG: Kadane's in Signal Processing and Time-Series Analysis

Kadane's algorithm is the O(n) solution to the maximum subarray problem, which appears outside of interviews in signal processing (find the time window with maximum net signal), financial analysis (find the holding period with maximum profit given buy-sell at any point), and anomaly detection (find the time window where a metric most exceeded its baseline).

In production systems, the "maximum subarray" query is often applied to sliding windows rather than the full history, which converts it from a static O(n) problem to a streaming problem. A monotonic deque can maintain the maximum subarray sum over the last k elements with O(1) amortized updates, enabling real-time alerting when a metric's peak accumulated value in any recent window exceeds a threshold.

The circular variant is particularly relevant in systems that process circular buffers (ring buffers), which are the standard data structure for bounded-memory queues in Go's `bufio`, network drivers, and audio processing pipelines. An algorithm that finds the maximum-sum window in a circular buffer is directly applicable to peak load detection in such systems.

For a staff-level interview, the follow-up question is: "How would you parallelize Kadane's algorithm across k machines for an array of n billion elements?" The answer requires understanding that the maximum subarray that crosses a partition boundary must be computed as the maximum suffix of the left partition plus the maximum prefix of the right partition. This gives a divide-and-conquer scheme: one O(n/k) local pass per machine, followed by an O(log k)-round combine that merges each partition's total, best, best-prefix, and best-suffix sums.

---
