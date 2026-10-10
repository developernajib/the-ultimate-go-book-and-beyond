## 78B.6 The Dynamic Programming Pattern

```
┌──────────────────────────────────────────────────────────────────┐
│                DYNAMIC PROGRAMMING PATTERN                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Framework:                                                      │
│  1. Define STATE: What information do we need?                   │
│  2. Define TRANSITION: How do states relate?                     │
│  3. Define BASE CASE: Starting values                            │
│  4. Define ORDER: Bottom-up or top-down?                         │
│  5. Define ANSWER: Which state(s) contain the answer?            │
│                                                                  │
│  Sub-patterns:                                                   │
│  ┌──────────────┬──────────────────────────────────┐             │
│  │ 1D DP        │ Fibonacci, climbing stairs       │             │
│  │ 2D DP        │ Grid paths, LCS, edit distance   │             │
│  │ State Machine│ Stock buy/sell, state transitions│             │
│  │ Interval DP  │ Burst balloons, matrix chain     │             │
│  │ Bitmask DP   │ TSP, assignment problems         │             │
│  └──────────────┴──────────────────────────────────┘             │
│                                                                  │
│  Key insight: Overlapping subproblems + optimal substructure     │
│  = use DP instead of brute force recursion                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Dynamic Programming is arguably the most feared interview pattern, but it follows a systematic framework. The key is identifying the state, transition, and base cases.

**When to use DP:**
- "Find the minimum/maximum..."
- "Count the number of ways..."
- "Is it possible to..." (where greedy fails)
- The problem has overlapping subproblems and optimal substructure
- Brute force solution has exponential time complexity

---

### Problem 1: Climbing Stairs (LC 70), 1D DP

**Problem:** You can climb 1 or 2 steps at a time. How many distinct ways can you climb n steps?

**Approach:** Classic 1D DP. `dp[i]` = number of ways to reach step i. Transition: `dp[i] = dp[i-1] + dp[i-2]`. This is the Fibonacci sequence.

```go
func climbStairs(n int) int {
    if n <= 2 {
        return n
    }

    // Space-optimized: only need the last two values
    prev2, prev1 := 1, 2

    for i := 3; i <= n; i++ {
        curr := prev1 + prev2
        prev2 = prev1
        prev1 = curr
    }

    return prev1
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(1) with space optimization.

**Edge cases:**
- n=1 → 1, n=2 → 2, both returned directly by the guard
- n=0 → this code returns 0, because the `n <= 2` guard returns `n`. The mathematically consistent answer is 1, since there is exactly one way to climb nothing, and that is the value the Fibonacci recurrence needs at its base. The problem constrains n to be at least 1 so it never comes up, but if an interviewer asks about n=0 the honest answer is that the guard is a shortcut that happens to be wrong outside the stated constraints

---

### Problem 2: Longest Common Subsequence (LC 1143), 2D DP

**Problem:** Given two strings `text1` and `text2`, return the length of their longest common subsequence.

**Approach:** 2D DP. `dp[i][j]` = LCS length of `text1[0..i-1]` and `text2[0..j-1]`. If characters match, `dp[i][j] = dp[i-1][j-1] + 1`. Otherwise, `dp[i][j] = max(dp[i-1][j], dp[i][j-1])`.

```go
func longestCommonSubsequence(text1 string, text2 string) int {
    m, n := len(text1), len(text2)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if text1[i-1] == text2[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1
            } else {
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
            }
        }
    }

    return dp[m][n]
}
```

**Time Complexity:** O(m * n).
**Space Complexity:** O(m * n), optimizable to O(min(m, n)) with rolling array.

**Edge cases:**
- One string empty → 0
- Strings identical → length of string
- No common characters → 0

---

### Problem 3: Best Time to Buy and Sell Stock with Cooldown (LC 309), State Machine DP

**Problem:** You can buy and sell a stock multiple times, but after selling you must wait one day before buying again. Find the maximum profit.

**Approach:** State machine DP with three states: `held` (holding stock), `sold` (just sold), `rest` (cooling down or idle).

```go
func maxProfit(prices []int) int {
    if len(prices) <= 1 {
        return 0
    }

    n := len(prices)
    // State transitions:
    // held[i] = max(held[i-1], rest[i-1] - prices[i])   -- keep holding or buy
    // sold[i] = held[i-1] + prices[i]                     -- sell
    // rest[i] = max(rest[i-1], sold[i-1])                 -- stay resting or transition from sold

    held := -prices[0] // started by buying on day 0
    sold := 0
    rest := 0

    for i := 1; i < n; i++ {
        prevHeld := held
        prevSold := sold
        prevRest := rest

        held = max(prevHeld, prevRest-prices[i])
        sold = prevHeld + prices[i]
        rest = max(prevRest, prevSold)
    }

    return max(sold, rest)
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(1).

The `sold := 0` initialization looks suspicious, since you cannot sell on day 0 without having bought. It is safe because `sold` only ever feeds `rest`, and `rest` is already 0, so the bogus state never contributes profit that a real schedule could not achieve. Reading the three transitions as a state machine, rather than as three arrays, is what makes the reasoning tractable: each variable is a node and each `max` is an incoming edge.

**Edge cases:**
- Single price → 0 (cannot sell)
- Prices always decreasing → 0 (never buy)
- Two prices → max(0, prices[1]-prices[0])

---

### Problem 4: Burst Balloons (LC 312), Interval DP

**Problem:** Given n balloons with values, bursting balloon i earns `nums[i-1] * nums[i] * nums[i+1]`. Find the maximum coins you can collect.

**Approach:** Interval DP. `dp[i][j]` = max coins from bursting all balloons between index i and j (exclusive). The key insight: instead of thinking about which balloon to burst first, think about which balloon to burst LAST in the interval.

```go
func maxCoins(nums []int) int {
    // Pad with 1s on both ends
    n := len(nums)
    vals := make([]int, n+2)
    vals[0] = 1
    vals[n+1] = 1
    for i := 0; i < n; i++ {
        vals[i+1] = nums[i]
    }

    // dp[i][j] = max coins from bursting all balloons in (i, j) exclusive
    dp := make([][]int, n+2)
    for i := range dp {
        dp[i] = make([]int, n+2)
    }

    // Iterate by interval length
    for length := 1; length <= n; length++ {
        for i := 0; i+length+1 <= n+1; i++ {
            j := i + length + 1
            for k := i + 1; k < j; k++ {
                // k is the last balloon to burst in interval (i, j)
                coins := vals[i]*vals[k]*vals[j] + dp[i][k] + dp[k][j]
                if coins > dp[i][j] {
                    dp[i][j] = coins
                }
            }
        }
    }

    return dp[0][n+1]
}
```

**Time Complexity:** O(n³).
**Space Complexity:** O(n²).

**Edge cases:**
- Single balloon → its value (multiplied by padded 1s)
- Two balloons → try both orders, pick the better
- All balloons have value 1

---

### Problem 5: Partition Equal Subset Sum (LC 416), Knapsack DP

**Problem:** Given a non-empty array of positive integers, determine if the array can be partitioned into two subsets with equal sum.

**Approach:** This is a 0/1 knapsack problem. If total sum is odd, return false. Otherwise, find if a subset sums to `total/2`.

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

    // dp[j] = true if we can form sum j from the elements seen so far
    dp := make([]bool, target+1)
    dp[0] = true

    for _, num := range nums {
        // Iterate backwards to avoid using the same element twice
        for j := target; j >= num; j-- {
            dp[j] = dp[j] || dp[j-num]
        }
    }

    return dp[target]
}
```

**Time Complexity:** O(n * target) where target = sum/2.
**Space Complexity:** O(target).

**Edge cases:**
- Odd total sum → false
- Single element → false (can't split)
- Two equal elements → true
- Element equal to target → true

---

### Junior → FAANG: DP State Definition Is the Entire Problem

Junior engineers struggle with DP because they focus on the recurrence before nailing the state definition. The state must be a complete description of all information needed to make the optimal decision at that point, and nothing more. If the state is too narrow, the recurrence is incorrect. If it is too wide, the memoization table is too large and the solution TLEs.

Worked state definition exercise for Longest Common Subsequence: the state is `dp[i][j]` = length of LCS of the first `i` characters of s1 and the first `j` characters of s2. Ask: is this complete? Yes, because knowing i and j fully determines which prefixes we are comparing, and the LCS of those prefixes depends only on those prefixes, not on how we got to this state. Ask: is this minimal? Yes, because removing either i or j leaves ambiguity about which prefix we are at. This two-question check ("complete?" and "minimal?") applied before writing the recurrence prevents the most common DP bugs.

Pattern recognition: 1D DP for single-sequence problems (Fibonacci, House Robber, Coin Change). 2D DP for two-sequence or grid problems (LCS, Edit Distance, Unique Paths). Interval DP when you are combining adjacent segments (Matrix Chain Multiplication, Burst Balloons). Bitmask DP when the state must track subset membership and n is at most 20.

Entry-level signal: explaining the base cases before the recurrence. Interviewers test whether you understand why base cases are needed (they terminate the recursion and represent subproblems small enough to answer directly) rather than treating them as boilerplate to copy.

### Senior @ FAANG: DP in Production Optimization and Compiler Infrastructure

Dynamic programming is embedded in production systems at a level most engineers do not recognize. The Viterbi algorithm, used in speech recognition and in decoding convolutional codes, is DP over a trellis whose state is (time step, hidden state). Smith-Waterman and Needleman-Wunsch in computational biology are 2D DP on string sequences with gap penalties, structurally the same table as Edit Distance. Cost-based join order selection in a query optimizer, in the Selinger tradition, is DP over *subsets* of relations: the optimizer computes the best plan for every subset of tables and builds larger subsets from smaller ones. That is bitmask DP, and it is why optimizers fall back to heuristics or genetic search beyond roughly a dozen joins, since the table is 2^n.

The related but distinct point of comparison: matrix chain multiplication is interval DP, because a chain has an order and you only ever combine *adjacent* segments. Join ordering is not interval DP precisely because joins commute, so any subset is reachable, not just contiguous runs. Knowing which of the two shapes you are in determines whether the table is O(n²) intervals or O(2^n) subsets. That distinction is worth far more in a design discussion than reciting either template.

ADR consideration: the choice between top-down (memoization) and bottom-up (tabulation) DP affects stack depth and cache locality. Top-down is easier to implement and naturally handles sparse state spaces, since only reachable states are ever computed, which is a real win when the reachable fraction is small. Its cost is recursion depth plus a hash lookup per state. Bottom-up fills all states in a fixed order, including unreachable ones, but indexes a flat array and walks it predictably, which is far friendlier to the CPU cache and the prefetcher. For production DP computations over large tables (e.g., sequence alignment on genome-length strings), bottom-up with memory-optimized rolling arrays is often the only viable approach.

Bar-raiser signal: the candidate explains space optimization for 2D DP problems (reducing O(mn) space to O(min(m, n)) using rolling rows) and identifies which access pattern in the recurrence determines whether the optimization is possible. They also discuss how the Partition Equal Subset Sum problem is NP-complete in the general case and that the pseudo-polynomial DP solution's feasibility depends on the sum being bounded. This demonstrates understanding of DP's complexity class, not just its template.
