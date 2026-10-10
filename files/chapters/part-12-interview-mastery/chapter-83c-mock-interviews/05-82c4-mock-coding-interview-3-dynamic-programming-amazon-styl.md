## 83C.4 Mock Coding Interview 3: Dynamic Programming (Amazon-style)

### Interviewer Briefing

**Company style:** Amazon. Interviewers often start with a behavioral question (5 minutes) before the coding problem. The coding problem tests DP thinking. Amazon interviewers value clear problem decomposition and may ask how your solution relates to real-world Amazon systems.

**Level:** SDE II (L5) or Senior SDE (L6)

**Interview duration:** 45 minutes (5 min behavioral + 40 min coding)

### Opening Behavioral Question (5 minutes)

*"Tell me about a time you had to optimize the performance of a system. What was the situation, what did you do, and what was the result?"*

(This is a warm-up. Keep it to 2-3 minutes. Map to Amazon LP: "Dive Deep" or "Invent and Simplify".)

### Problem Statement

*Read this to the candidate:*

> You are given an array `prices` where `prices[i]` is the price of a given stock on the i-th day. You may complete at most `k` transactions (a transaction is one buy and one sell). You may not hold more than one share at a time (you must sell before you buy again).
>
> Return the maximum profit you can achieve.
>
> **Example 1:**
> Input: `k = 2`, `prices = [2, 4, 1]`
> Output: `2`
> Explanation: Buy on day 0 (price=2), sell on day 1 (price=4). Profit = 2.
>
> **Example 2:**
> Input: `k = 2`, `prices = [3, 2, 6, 5, 0, 3]`
> Output: `7`
> Explanation: Buy on day 1 (price=2), sell on day 2 (price=6). Buy on day 4 (price=0), sell on day 5 (price=3). Profit = 4 + 3 = 7.
>
> **Constraints:**
> - `1 <= k <= 100`
> - `1 <= len(prices) <= 1000`
> - `0 <= prices[i] <= 1000`

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| 0:00-5:00 | Behavioral | Quick STAR answer about performance optimization |
| 5:00-8:00 | Clarify | Confirm transaction = buy+sell, must sell before buying again, can skip days |
| 8:00-15:00 | Approach | DP with states: day, transactions remaining, holding/not holding. Discuss state transition. Mention the k >= n/2 optimization. |
| 15:00-18:00 | Recurrence | `dp[i][j][0] = max(dp[i-1][j][0], dp[i-1][j][1] + prices[i])` and `dp[i][j][1] = max(dp[i-1][j][1], dp[i-1][j-1][0] - prices[i])` |
| 18:00-35:00 | Implementation | Clean DP implementation with space optimization |
| 35:00-42:00 | Testing | Trace through examples, test k=0, k=1, k>=n/2, single day, decreasing prices |
| 42:00-45:00 | Follow-ups | See below |

### Expected Solution Walkthrough

**State Definition:**
- `dp[i][j][0]` = max profit on day i with at most j transactions completed, not holding stock
- `dp[i][j][1]` = max profit on day i with at most j transactions completed, holding stock

**Transitions:**
- Not holding on day i: either was not holding yesterday, or sold today: `dp[i][j][0] = max(dp[i-1][j][0], dp[i-1][j-1][1] + prices[i])`
- Holding on day i: either was holding yesterday, or bought today: `dp[i][j][1] = max(dp[i-1][j][1], dp[i-1][j][0] - prices[i])`

**Optimization:** When `k >= n/2`, we can make unlimited transactions, so we use the greedy approach (buy every valley, sell every peak).

### Interviewer Notes: What to Look For

**Strong signals:**
- Identifies the 3D DP state space correctly
- Recognizes the k >= n/2 optimization to avoid TLE
- Writes the state transition equations before coding
- Can optimize space from O(n*k) to O(k)
- Connects to Amazon systems: "This is similar to optimizing batch purchasing decisions in supply chain"

**Weak signals:**
- Needs hints to define the state space
- Implements correct but unoptimized O(n*k) space solution
- Cannot explain why the greedy optimization works for large k

**Red flags:**
- Cannot formulate DP recurrence after hints
- Confuses "at most k transactions" with "exactly k transactions"
- Cannot implement basic DP table iteration

### Complete Go Solution

The reference implementation below is written to the standard an interviewer expects: correct complexity and idiomatic use of the standard library.

```go
package interview

// maxProfit returns the maximum profit with at most k transactions.
// Time: O(n*k) where n = len(prices), Space: O(k)
func maxProfit(k int, prices []int) int {
    n := len(prices)
    if n <= 1 || k == 0 {
        return 0
    }

    // Optimization: if k >= n/2, we can make unlimited transactions
    if k >= n/2 {
        return maxProfitUnlimited(prices)
    }

    // dp[j][0] = max profit with j transactions, not holding
    // dp[j][1] = max profit with j transactions, holding
    // Space-optimized: only need previous day's values
    dp := make([][2]int, k+1)

    // Initialize: holding stock before any day costs infinity
    for j := 0; j <= k; j++ {
        dp[j][1] = -1 << 31 // negative infinity
    }

    for i := 0; i < n; i++ {
        // Iterate transactions in reverse to avoid using updated values
        for j := k; j >= 1; j-- {
            // Not holding: either still not holding, or sell today
            dp[j][0] = max(dp[j][0], dp[j][1]+prices[i])
            // Holding: either still holding, or buy today (uses j-1 transactions when not holding)
            dp[j][1] = max(dp[j][1], dp[j-1][0]-prices[i])
        }
    }

    return dp[k][0]
}

func maxProfitUnlimited(prices []int) int {
    profit := 0
    for i := 1; i < len(prices); i++ {
        if prices[i] > prices[i-1] {
            profit += prices[i] - prices[i-1]
        }
    }
    return profit
}

// Note: Uses builtin max() available since Go 1.21
```

### Follow-up Questions

**Follow-up 1: "What if there's a transaction fee for each trade?"**

*Strong answer:*

```go
// maxProfitWithFee handles unlimited transactions with a fee per trade.
// Modify the sell transition: dp[j][0] = max(dp[j][0], dp[j][1]+prices[i]-fee)
func maxProfitWithFee(prices []int, fee int) int {
    n := len(prices)
    if n <= 1 {
        return 0
    }

    notHolding := 0
    holding := -prices[0]

    for i := 1; i < n; i++ {
        notHolding = max(notHolding, holding+prices[i]-fee)
        holding = max(holding, notHolding-prices[i])
    }

    return notHolding
}
```

**Follow-up 2: "How does this relate to a real Amazon problem?"**

*Strong answer:* "This directly maps to inventory optimization in Amazon's fulfillment network. Each 'buy' is a purchase order, each 'sell' is fulfilling customer demand. The 'k transactions' constraint represents budget or logistics limits on how many purchase cycles you can execute in a period. The fee variant models shipping and handling costs. At Amazon scale, you'd add constraints for warehouse capacity, lead times, and demand uncertainty - turning this from DP into stochastic optimization or reinforcement learning."

**Follow-up 3: "Can you solve this with O(1) space for k=2?"**

*Strong answer:*

```go
// maxProfitTwoTransactions optimizes for exactly k=2 with O(1) space.
func maxProfitTwoTransactions(prices []int) int {
    buy1, sell1 := -1<<31, 0
    buy2, sell2 := -1<<31, 0

    for _, price := range prices {
        buy1 = max(buy1, -price)
        sell1 = max(sell1, buy1+price)
        buy2 = max(buy2, sell1-price)
        sell2 = max(sell2, buy2+price)
    }

    return sell2
}
```

### Scoring Rubric

| Rating | Criteria |
|--------|----------|
| **Strong Hire** | Good behavioral answer. Identifies DP states and transitions quickly. Implements k>=n/2 optimization. Clean, bug-free code. Handles follow-ups including fee variant and Amazon connection. Strong communication. |
| **Hire** | Acceptable behavioral answer. Gets DP solution working (possibly without space optimization). Code correct for both examples. Handles at least one follow-up. Communicates approach before coding. |
| **Lean Hire** | Weak behavioral answer. Needs hints for DP formulation. Code works for basic cases, may have bugs with edge cases. Struggles with follow-ups. |
| **No Hire** | Cannot formulate DP states. Code fundamentally broken. Cannot connect to real-world applications. Poor communication. |


### Junior → FAANG: Dynamic Programming Mock Interview Fundamentals

Dynamic programming is the most feared topic in coding interviews, but the pattern is consistent: identify the overlapping subproblems, define the state clearly, write the recurrence relation, and decide between top-down memoization and bottom-up tabulation. The key insight that unlocks most DP problems is the definition of the state: what is the minimum information you need to represent a subproblem uniquely. Practice identifying the state by working backward from the final answer: if the answer is 'minimum cost to reach position n', the state is likely dp[i] = minimum cost to reach position i.

### Senior @ FAANG: Dynamic Programming at the L5/L6 Bar: State Design and Optimization

At the L5/L6 level, the evaluation of DP problems includes the quality of your state design. Candidates who arrive at a correct but space-inefficient solution and do not recognize the space optimization (e.g., that a rolling window over a 2D DP table can reduce space from O(n*m) to O(n)) are evaluated lower than candidates who recognize and implement the optimization. Amazon-style DP interviews often involve follow-up questions about what happens when the input size grows significantly, which tests whether you understand the space and time trade-offs of different DP formulations. At the bar-raiser level, the interviewer may also ask you to prove the correctness of your recurrence relation, which requires understanding why the optimal substructure and overlapping subproblems properties hold for the specific problem.

---
