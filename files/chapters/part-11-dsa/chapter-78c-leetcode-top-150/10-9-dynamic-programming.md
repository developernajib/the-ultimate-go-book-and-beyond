## 78C.9 Dynamic Programming

DP problems have optimal substructure and overlapping subproblems. Identify the state, recurrence, and base cases.

---
### LC 70 - Climbing Stairs 🟢

**Key Insight**: This is Fibonacci. The number of ways to reach step n is ways(n-1) + ways(n-2).

```go
func climbStairs(n int) int {
    if n <= 2 {
        return n
    }
    a, b := 1, 2
    for i := 3; i <= n; i++ {
        a, b = b, a+b
    }
    return b
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 198 - House Robber 🟡

**Key Insight**: At each house, choose max(rob this + dp[i-2], skip this = dp[i-1]).

```go
func rob(nums []int) int {
    if len(nums) == 0 {
        return 0
    }
    if len(nums) == 1 {
        return nums[0]
    }
    prev2, prev1 := nums[0], max(nums[0], nums[1])
    for i := 2; i < len(nums); i++ {
        curr := max(prev1, prev2+nums[i])
        prev2 = prev1
        prev1 = curr
    }
    return prev1
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 213 - House Robber II 🟡

**Key Insight**: The houses are in a circle, so run House Robber twice: once excluding the first house, once excluding the last. Take the max.

```go
func rob(nums []int) int {
    if len(nums) == 1 {
        return nums[0]
    }
    return max(robRange(nums, 0, len(nums)-2), robRange(nums, 1, len(nums)-1))
}

func robRange(nums []int, lo, hi int) int {
    prev2, prev1 := 0, 0
    for i := lo; i <= hi; i++ {
        curr := max(prev1, prev2+nums[i])
        prev2 = prev1
        prev1 = curr
    }
    return prev1
}
```

`max` is a builtin since Go 1.21, so neither House Robber variant needs a helper.

**Time**: O(n).
**Space**: O(1).

---
### LC 53 - Maximum Subarray 🟡

**Key Insight**: Kadane's algorithm. Extend the current subarray or start fresh at each element.

```go
func maxSubArray(nums []int) int {
    maxSum := nums[0]
    currSum := nums[0]

    for i := 1; i < len(nums); i++ {
        if currSum < 0 {
            currSum = nums[i]
        } else {
            currSum += nums[i]
        }
        if currSum > maxSum {
            maxSum = currSum
        }
    }
    return maxSum
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 152 - Maximum Product Subarray 🟡

**Key Insight**: Track both max and min products (a negative min can become max when multiplied by a negative number).

```go
func maxProduct(nums []int) int {
    result := nums[0]
    curMax, curMin := nums[0], nums[0]

    for i := 1; i < len(nums); i++ {
        if nums[i] < 0 {
            curMax, curMin = curMin, curMax
        }
        if nums[i] > curMax*nums[i] {
            curMax = nums[i]
        } else {
            curMax = curMax * nums[i]
        }
        if nums[i] < curMin*nums[i] {
            curMin = nums[i]
        } else {
            curMin = curMin * nums[i]
        }
        if curMax > result {
            result = curMax
        }
    }
    return result
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 300 - Longest Increasing Subsequence 🟡

**Key Insight**: Maintain a tails array where tails[i] is the smallest tail of all increasing subsequences of length i+1. Use binary search to update.

```go
func lengthOfLIS(nums []int) int {
    tails := []int{}

    for _, num := range nums {
        pos := sort.SearchInts(tails, num)
        if pos == len(tails) {
            tails = append(tails, num)
        } else {
            tails[pos] = num
        }
    }
    return len(tails)
}
```
**Time**: O(n log n).
**Space**: O(n).

---
### LC 322 - Coin Change 🟡

**Key Insight**: dp[amount] = min coins needed. For each amount, try every coin and take min(dp[amount - coin] + 1).

```go
func coinChange(coins []int, amount int) int {
    dp := make([]int, amount+1)
    for i := range dp {
        dp[i] = amount + 1
    }
    dp[0] = 0

    for i := 1; i <= amount; i++ {
        for _, coin := range coins {
            if coin <= i && dp[i-coin]+1 < dp[i] {
                dp[i] = dp[i-coin] + 1
            }
        }
    }

    if dp[amount] > amount {
        return -1
    }
    return dp[amount]
}
```
**Time**: O(amount × len(coins)).
**Space**: O(amount).

---
### LC 62 - Unique Paths 🟡

**Key Insight**: dp[r][c] = dp[r-1][c] + dp[r][c-1], which collapses to a single row since only the previous row is needed.

```go
func uniquePaths(m int, n int) int {
    dp := make([]int, n)
    for i := range dp {
        dp[i] = 1
    }
    for r := 1; r < m; r++ {
        for c := 1; c < n; c++ {
            dp[c] += dp[c-1]
        }
    }
    return dp[n-1]
}
```
**Time**: O(m × n).
**Space**: O(n).

---
### LC 221 - Maximal Square 🟡

**Key Insight**: Define `dp[r][c]` as the side length of the largest all-ones square whose **bottom-right corner** is `(r, c)`. A square of side s+1 needs three overlapping squares of side s (above, left, and diagonal) to all be present, so the recurrence is `min` of those three plus one. The `min` is the whole problem: one short neighbour caps the square.

```go
func maximalSquare(matrix [][]byte) int {
    if len(matrix) == 0 {
        return 0
    }
    rows, cols := len(matrix), len(matrix[0])
    // 1-indexed with a zero row/column, so r-1 and c-1 need no bounds checks
    prev := make([]int, cols+1)
    curr := make([]int, cols+1)
    best := 0

    for r := 1; r <= rows; r++ {
        for c := 1; c <= cols; c++ {
            if matrix[r-1][c-1] == '1' {
                curr[c] = min(prev[c], curr[c-1], prev[c-1]) + 1
                best = max(best, curr[c])
            } else {
                curr[c] = 0 // must reset: curr is reused from two rows ago
            }
        }
        prev, curr = curr, prev
    }
    return best * best
}
```

Two traps. First, the answer is the **area**, so the tracked side length is squared on the way out. Forgetting this returns 2 instead of 4 on the canonical example and is the single most common wrong submission on this problem.

Second, the `else` branch must write zero rather than being skipped. Because the two row buffers are swapped and reused, a cell left untouched would still hold the value from two rows earlier and silently extend a square through a zero. Note that `min` takes three arguments here: since Go 1.21 the builtin is variadic, so no nested `min(a, min(b, c))` is needed.

The matrix is `[][]byte` and the cells are the ASCII characters `'0'` and `'1'`, not the integers 0 and 1. Comparing against `1` instead of `'1'` compiles cleanly and returns 0 for every input.

**Time**: O(rows × cols) - constant work per cell.
**Space**: O(cols) - two rolling rows instead of the full table.

---
### LC 91 - Decode Ways 🟡

**Key Insight**: At each position, check whether the single digit and the two-digit number form valid decodings, then sum the ways.

```go
func numDecodings(s string) int {
    if len(s) == 0 || s[0] == '0' {
        return 0
    }

    n := len(s)
    prev2, prev1 := 1, 1 // dp[i-2], dp[i-1]

    for i := 1; i < n; i++ {
        curr := 0
        oneDigit := s[i] - '0'
        twoDigit := (s[i-1]-'0')*10 + oneDigit

        if oneDigit >= 1 {
            curr += prev1
        }
        if twoDigit >= 10 && twoDigit <= 26 {
            curr += prev2
        }
        prev2 = prev1
        prev1 = curr
    }
    return prev1
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 139 - Word Break 🟡

**Key Insight**: dp[i] = true if s[:i] can be segmented. Check all dictionary words that could end at position i.

```go
func wordBreak(s string, wordDict []string) bool {
    wordSet := make(map[string]bool)
    for _, w := range wordDict {
        wordSet[w] = true
    }

    dp := make([]bool, len(s)+1)
    dp[0] = true

    for i := 1; i <= len(s); i++ {
        for j := 0; j < i; j++ {
            if dp[j] && wordSet[s[j:i]] {
                dp[i] = true
                break
            }
        }
    }
    return dp[len(s)]
}
```
**Time**: O(n² × k) where k is average word length for substring comparison.
**Space**: O(n).

---
### LC 5 - Longest Palindromic Substring 🟡

**Key Insight**: Expand around each center, both odd and even length. The longest expansion is the answer.

```go
func longestPalindrome(s string) string {
    if len(s) < 2 {
        return s
    }

    start, maxLen := 0, 1

    expand := func(l, r int) {
        for l >= 0 && r < len(s) && s[l] == s[r] {
            if r-l+1 > maxLen {
                start = l
                maxLen = r - l + 1
            }
            l--
            r++
        }
    }

    for i := 0; i < len(s); i++ {
        expand(i, i)   // odd length
        expand(i, i+1) // even length
    }
    return s[start : start+maxLen]
}
```
**Time**: O(n²).
**Space**: O(1).

---
### LC 72 - Edit Distance 🟡

**Key Insight**: dp[i][j] = min operations to convert word1[:i] to word2[:j]. Three choices: insert, delete, replace.

```go
func minDistance(word1 string, word2 string) int {
    m, n := len(word1), len(word2)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
        dp[i][0] = i
    }
    for j := 0; j <= n; j++ {
        dp[0][j] = j
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                dp[i][j] = dp[i-1][j-1]
            } else {
                dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
            }
        }
    }
    return dp[m][n]
}
```

The builtin `min` is variadic, so it takes all three candidates directly and no `min3` helper is needed.

**Time**: O(m × n).
**Space**: O(m × n).

---
### LC 377 - Combination Sum IV 🟡

**Key Insight**: dp[target] = sum of dp[target - num] over all nums. Order matters, so this counts permutations rather than combinations.

```go
func combinationSum4(nums []int, target int) int {
    dp := make([]int, target+1)
    dp[0] = 1

    for i := 1; i <= target; i++ {
        for _, num := range nums {
            if num <= i {
                dp[i] += dp[i-num]
            }
        }
    }
    return dp[target]
}
```
**Time**: O(target × len(nums)).
**Space**: O(target).

---
### LC 416 - Partition Equal Subset Sum 🟡

**Key Insight**: Reduce to 0/1 knapsack. Can we pick a subset summing to totalSum/2?

```go
func canPartition(nums []int) bool {
    total := 0
    for _, n := range nums {
        total += n
    }
    if total%2 != 0 {
        return false
    }

    target := total / 2
    dp := make([]bool, target+1)
    dp[0] = true

    for _, num := range nums {
        for j := target; j >= num; j-- {
            dp[j] = dp[j] || dp[j-num]
        }
    }
    return dp[target]
}
```
**Time**: O(n × target).
**Space**: O(target).

---
### LC 494 - Target Sum 🟡

**Key Insight**: Transform to subset sum. Find subsets summing to (total + target) / 2 and count the ways with DP.

```go
func findTargetSumWays(nums []int, target int) int {
    total := 0
    for _, n := range nums {
        total += n
    }

    if (total+target)%2 != 0 || total+target < 0 {
        return 0
    }

    sum := (total + target) / 2
    dp := make([]int, sum+1)
    dp[0] = 1

    for _, num := range nums {
        for j := sum; j >= num; j-- {
            dp[j] += dp[j-num]
        }
    }
    return dp[sum]
}
```
**Time**: O(n × sum).
**Space**: O(sum).

---

### Junior → FAANG: Identifying DP and Defining the State

The signal that a problem is DP: it asks for a count, minimum, maximum, or boolean feasibility over all ways to achieve something, and the choices at each step affect future choices. If the problem asks for a single specific arrangement (not a count or optimum over all arrangements), it is probably greedy or backtracking, not DP.

State definition is the hardest step. For Coin Change, the state is `dp[amount]` = minimum coins to make exactly `amount`. The recurrence is `dp[amount] = min over all coins c of dp[amount-c] + 1`. The base case is `dp[0] = 0`. Stating all three before writing the loop is the discipline that prevents bugs.

Space optimization: many 2D DP problems can be reduced to 1D by observing that the recurrence for row i only depends on row i-1. This works when the recurrence does not require values from rows further back. Once you roll a 2D table into one array, the fill direction stops being cosmetic and becomes the whole correctness argument. Learn the rule cold, because it decides which problem you are actually solving:

- **0/1 knapsack** (each item usable at most once, as in Partition Equal Subset Sum and Target Sum): iterate capacity **descending**. Descending order guarantees `dp[j-num]` still holds the previous item's value, so each item is counted once.
- **Unbounded knapsack** (each item reusable, as in Coin Change and Combination Sum IV): iterate capacity **ascending**, which deliberately lets `dp[j-num]` already include the current item.

The failure mode is silent: run a 0/1 knapsack ascending and it compiles, runs, and returns the unbounded answer with no error. Verify the direction against a small hand-checked case before trusting the output.

### Senior @ FAANG: DP Formulations in Optimization and ML Infrastructure

Dynamic programming underlies the Viterbi algorithm (decoding HMMs in speech recognition), the CYK algorithm (parsing context-free grammars in compiler frontends), and the Needleman-Wunsch alignment algorithm (sequence alignment in bioinformatics pipelines). In ML infrastructure, beam search (used in language model decoding) is a pruned DP over sequence states. Understanding the DP state, recurrence, and base case structure is the prerequisite for reading and modifying these algorithms in production ML serving systems. When a beam search implementation has incorrect results for certain input distributions, diagnosing the bug requires understanding the DP invariants, not just the code flow.
