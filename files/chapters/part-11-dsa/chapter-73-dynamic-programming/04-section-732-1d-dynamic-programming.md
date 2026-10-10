## 73.2 1D Dynamic Programming

### Climbing Stairs

Climbing stairs is structurally identical to Fibonacci: the number of ways to reach step `n` equals the sum of ways to reach step `n-1` (take one step) and step `n-2` (take two steps). This recurrence bottoms out at `n=1` and `n=2`, and the space-optimized solution uses only two variables rolling forward through the sequence.

```go
// ClimbStairs counts ways to climb n stairs (1 or 2 steps at a time)
// LeetCode 70: Climbing Stairs
// Time: O(n), Space: O(1)
func ClimbStairs(n int) int {
    if n <= 2 {
        return n
    }

    // dp[i] = number of ways to reach step i
    // dp[i] = dp[i-1] + dp[i-2]
    prev2, prev1 := 1, 2

    for i := 3; i <= n; i++ {
        curr := prev1 + prev2
        prev2 = prev1
        prev1 = curr
    }

    return prev1
}

// ClimbStairsK counts ways with up to k steps
func ClimbStairsK(n, k int) int {
    if n <= 0 {
        return 1
    }

    dp := make([]int, n+1)
    dp[0] = 1

    for i := 1; i <= n; i++ {
        for j := 1; j <= k && j <= i; j++ {
            dp[i] += dp[i-j]
        }
    }

    return dp[n]
}
```

### House Robber

The house robber recurrence expresses a binary choice at each house: rob it (gain its value plus the best outcome from two houses back) or skip it (carry forward the best outcome so far). The circular variant splits the problem into two linear sub-problems (houses 0 to n-2 and houses 1 to n-1), ensuring the first and last houses are never both robbed.

```go
// Rob returns maximum money without robbing adjacent houses
// LeetCode 198: House Robber
// Time: O(n), Space: O(1)
func Rob(nums []int) int {
    if len(nums) == 0 {
        return 0
    }
    if len(nums) == 1 {
        return nums[0]
    }

    // dp[i] = max money from first i houses
    // dp[i] = max(dp[i-1], dp[i-2] + nums[i])
    prev2, prev1 := 0, nums[0]

    for i := 1; i < len(nums); i++ {
        curr := max(prev1, prev2+nums[i])
        prev2 = prev1
        prev1 = curr
    }

    return prev1
}

// RobCircular for circular arrangement
// LeetCode 213: House Robber II
func RobCircular(nums []int) int {
    n := len(nums)
    if n == 0 {
        return 0
    }
    if n == 1 {
        return nums[0]
    }

    // Either rob houses 0 to n-2 OR houses 1 to n-1
    return max(robRange(nums, 0, n-2), robRange(nums, 1, n-1))
}

func robRange(nums []int, start, end int) int {
    prev2, prev1 := 0, 0

    for i := start; i <= end; i++ {
        curr := max(prev1, prev2+nums[i])
        prev2 = prev1
        prev1 = curr
    }

    return prev1
}
// Note: Go 1.21+ provides builtin min() and max()
```

### Maximum Subarray

Kadane's algorithm finds the maximum subarray sum in O(n) by tracking the best sum ending at the current index. At each position, the choice is to either extend the previous subarray or start a new one at the current element. The recurrence `maxEndingHere = max(nums[i], maxEndingHere + nums[i])` encapsulates this decision directly.

```go
// MaxSubArray finds contiguous subarray with largest sum
// LeetCode 53: Maximum Subarray
// Kadane's Algorithm
// Time: O(n), Space: O(1)
func MaxSubArray(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    // dp[i] = max sum ending at index i
    // dp[i] = max(nums[i], dp[i-1] + nums[i])
    maxSoFar := nums[0]
    maxEndingHere := nums[0]

    for i := 1; i < len(nums); i++ {
        maxEndingHere = max(nums[i], maxEndingHere+nums[i])
        maxSoFar = max(maxSoFar, maxEndingHere)
    }

    return maxSoFar
}

// MaxSubArrayIndices returns the indices as well
func MaxSubArrayIndices(nums []int) (int, int, int) {
    maxSum := nums[0]
    currentSum := nums[0]
    start, end, tempStart := 0, 0, 0

    for i := 1; i < len(nums); i++ {
        if nums[i] > currentSum+nums[i] {
            currentSum = nums[i]
            tempStart = i
        } else {
            currentSum = currentSum + nums[i]
        }

        if currentSum > maxSum {
            maxSum = currentSum
            start = tempStart
            end = i
        }
    }

    return maxSum, start, end
}
```

### Coin Change

Coin change is an unbounded knapsack problem where coins can be reused: `dp[i]` stores the minimum number of coins needed to form amount `i`, built up from `dp[0] = 0`. Initializing all other entries to `amount + 1` acts as infinity and simplifies the min comparison. Any value that remains above `amount` indicates the amount is unreachable.

```go
// CoinChange finds minimum coins needed for amount
// LeetCode 322: Coin Change
// Time: O(amount * len(coins)), Space: O(amount)
func CoinChange(coins []int, amount int) int {
    // dp[i] = minimum coins to make amount i
    dp := make([]int, amount+1)
    for i := range dp {
        dp[i] = amount + 1 // impossible value
    }
    dp[0] = 0

    for i := 1; i <= amount; i++ {
        for _, coin := range coins {
            if coin <= i {
                dp[i] = min(dp[i], dp[i-coin]+1)
            }
        }
    }

    if dp[amount] > amount {
        return -1
    }
    return dp[amount]
}
// Note: Go 1.21+ provides builtin min() and max()

// CoinChangeWays counts number of ways to make amount
// LeetCode 518: Coin Change 2
// Time: O(amount * len(coins)), Space: O(amount)
func CoinChangeWays(coins []int, amount int) int {
    // dp[i] = number of ways to make amount i
    dp := make([]int, amount+1)
    dp[0] = 1 // one way to make 0: use no coins

    // Process coins first to avoid counting permutations
    for _, coin := range coins {
        for i := coin; i <= amount; i++ {
            dp[i] += dp[i-coin]
        }
    }

    return dp[amount]
}
```

### Longest Increasing Subsequence

The O(n²) approach defines `dp[i]` as the length of the longest strictly increasing subsequence ending exactly at index `i`, then for each `i` scans all prior indices `j` where `nums[j] < nums[i]` to extend those subsequences. The O(n log n) binary-search variant maintains a `tails` array where `tails[k]` holds the smallest possible tail value for any increasing subsequence of length `k+1`. Each new element either extends the longest known subsequence or replaces an entry to keep tails as small as possible, enabling longer future extensions.

The length of `tails` at the end is the answer, and that word "length" is load-bearing. `tails` is **not** the longest increasing subsequence. It is increasing, and it has the right length, but its contents are a mix of values left behind by different candidate subsequences, and it need not be a subsequence of the input at all. Run it on `[3, 4, 5, 1]`: the array fills to `[3, 4, 5]`, then `1` overwrites position 0 and the final `tails` is `[1, 4, 5]`. The length, 3, is right. The contents are not an answer: `1` occurs last in the input, so `[1, 4, 5]` is not a subsequence of `[3, 4, 5, 1]` at all. The real LIS is `[3, 4, 5]`. This is the trap, because `tails` is increasing and correctly sized, so returning it looks right until a test case like this one lands. To recover the actual sequence you must record, for each element, the length class it landed in and a parent pointer to the element occupying the previous class at that moment, then walk the pointers backward. `FindLIS` below does the reconstruction the simple way, from the O(n^2) DP, which is what you should reach for in an interview unless the interviewer specifically asks for O(n log n) reconstruction.

```go
// LengthOfLIS finds longest strictly increasing subsequence
// LeetCode 300: Longest Increasing Subsequence
// Time: O(n^2), Space: O(n)
func LengthOfLIS(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    // dp[i] = length of LIS ending at index i
    dp := make([]int, len(nums))
    for i := range dp {
        dp[i] = 1
    }

    maxLen := 1
    for i := 1; i < len(nums); i++ {
        for j := 0; j < i; j++ {
            if nums[j] < nums[i] {
                dp[i] = max(dp[i], dp[j]+1)
            }
        }
        maxLen = max(maxLen, dp[i])
    }

    return maxLen
}

// LengthOfLISBinarySearch uses binary search for O(n log n)
func LengthOfLISBinarySearch(nums []int) int {
    // tails[i] = smallest tail element for LIS of length i+1
    tails := []int{}

    for _, num := range nums {
        // Binary search for position
        left, right := 0, len(tails)
        for left < right {
            mid := left + (right-left)/2
            if tails[mid] < num {
                left = mid + 1
            } else {
                right = mid
            }
        }

        if left == len(tails) {
            tails = append(tails, num)
        } else {
            tails[left] = num
        }
    }

    return len(tails)
}

// FindLIS returns the actual LIS (one possible answer)
func FindLIS(nums []int) []int {

    n := len(nums)
    if n == 0 {
        return []int{}
    }

    dp := make([]int, n)
    parent := make([]int, n)
    for i := range dp {
        dp[i] = 1
        parent[i] = -1
    }

    maxLen, maxIdx := 1, 0
    for i := 1; i < n; i++ {
        for j := 0; j < i; j++ {
            if nums[j] < nums[i] && dp[j]+1 > dp[i] {
                dp[i] = dp[j] + 1
                parent[i] = j
            }
        }
        if dp[i] > maxLen {
            maxLen = dp[i]
            maxIdx = i
        }
    }

    // Reconstruct
    lis := make([]int, maxLen)
    for i := maxLen - 1; i >= 0; i-- {
        lis[i] = nums[maxIdx]
        maxIdx = parent[maxIdx]
    }

    return lis
}
```

### Junior → FAANG: Recognizing and Communicating 1D DP Problems

The five problems in this section (climbing stairs, house robber, maximum subarray, coin change, LIS) cover the spectrum of 1D DP variants. Climbing stairs and house robber are Fibonacci-pattern problems where the recurrence references a fixed number of prior states. Coin change is an unbounded knapsack where each state is built from a variable-length lookback. LIS requires a nested loop (O(n^2)) for the standard solution and a non-obvious binary search insight for the O(n log n) variant.

In interviews, always mention the two LIS complexities: "the standard DP is O(n^2), but there is a patience-sorting approach using binary search that runs in O(n log n) time with O(n) space." Even if you cannot implement the binary search variant from memory, naming it and explaining the insight (maintaining the smallest possible tail values for each length class) signals that you know the literature.

For Kadane's algorithm (maximum subarray), the key interview narration is: "at each index I make a local decision: extend the current subarray, or start fresh. The recurrence is `maxEndingHere = max(nums[i], maxEndingHere + nums[i])`. This is DP with O(1) space because each state only depends on the immediately prior state." Connecting the word "recurrence" to an O(1) space solution shows the interviewer you understand DP even when it does not look like a table.

### Senior @ FAANG: 1D DP in Production Systems

The coin change problem is a direct model for resource allocation under a budget constraint. Any system that must distribute a fixed budget (bandwidth, memory, API quota) across a set of discrete allocation units is structurally equivalent. At the senior level, the production considerations go beyond the algorithm.

First, the input validation: coin change assumes all coin values are positive. In a production resource allocator, the "coin values" (allocation unit sizes) may come from configuration, and a value of zero or negative would cause an infinite loop or panic. Guard clauses with explicit error returns belong at the function boundary, not in the inner loop.

Second, the LIS pattern appears in sequence alignment problems inside bioinformatics pipelines, version control diff engines, and edit-distance applications. When LIS is embedded in a larger pipeline, the O(n^2) variant may be acceptable for small sequences but unacceptable at scale. Staff engineers make this transition explicit in the ADR and instrument the actual sequence lengths observed in production to validate the complexity assumption.

Third, Kadane's algorithm is used in financial systems for maximum drawdown analysis and in signal processing for peak detection. In these contexts, the "start fresh" decision has a specific business meaning (a loss streak resets the measurement window) that must be documented clearly so that future maintainers do not misread the `max(nums[i], maxEndingHere + nums[i])` line as a simple optimization rather than a deliberate business rule.

### Junior → FAANG: Building Fluency Across 1D Patterns

The five 1D DP problems in this section (climbing stairs, house robber, maximum subarray, coin change, LIS) should be your daily warm-up problems early in interview preparation. Each one requires less than 10 minutes to implement once you understand it. The goal is to reach the point where you can name the pattern (Fibonacci, binary choice, unbounded knapsack, patience sort) within 30 seconds of reading the problem and start coding the correct recurrence without hesitation.

A common first-job mistake specific to Go: using `math.MaxInt` as the sentinel for "impossible" in minimization DP. Adding 1 to `math.MaxInt` causes an overflow and wraps to `math.MinInt`, producing completely wrong results in the subsequent `min` comparison. Use `amount + 1` or `n + 1` as the sentinel (a value that is larger than any valid answer but safe to increment), and add an overflow comment explaining why this value was chosen.

Practice the space optimization for each problem. Climbing stairs: two variables rolling forward. House robber: two variables rolling forward. Coin change: stays at O(amount) because the lookback is not fixed. LIS standard: stays at O(n) because each state needs the full dp array. LIS binary search: O(n) for the tails array. Knowing which optimizations apply and why is the follow-up question interviewers use to distinguish L4 from L5 candidates.

### Senior @ FAANG: 1D DP Patterns in Platform-Level Decision Making

At the staff level, the 1D DP patterns serve as mental models for a class of sequential decision problems that appear throughout platform engineering. The house robber "binary choice at each step" pattern appears in feature rollout scheduling: given a sequence of features to release, some pairs cannot be released in adjacent weeks (dependencies, resource conflicts), and you want to maximize total business value delivered. The recurrence is identical. The business context is different.

The coin change "unbounded resource allocation" pattern appears in cloud cost optimization: given a set of instance types (coin denominations) and a compute target (amount), find the minimum number of instances that meet the compute target. Production extensions include fractional instance types (spot instances), multi-dimensional constraints (compute and memory must both be met), and time-varying pricing (the cost of each instance type changes by hour), all of which require moving beyond the textbook recurrence but use it as the starting point.

For platform engineers, the most important habit is to recognize these structural equivalences early in the design process, before a bespoke algorithm is implemented. A team that recognizes "this is coin change with a second dimension" can reuse existing DP infrastructure and test frameworks rather than building from scratch. Staff engineers build this recognition as a reflex through deliberate practice across domains.
