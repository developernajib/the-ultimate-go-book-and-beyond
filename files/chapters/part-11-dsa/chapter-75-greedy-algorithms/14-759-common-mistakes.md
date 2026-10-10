## 75.12 Common Mistakes

### Mistake 1: Greedy When DP Required

The most dangerous mistake with greedy algorithms is assuming they work without verifying the greedy choice property. If choosing the locally best option now can prevent you from reaching the globally best solution later, greedy gives wrong answers. Coin change is the classic example: greedy is optimal for US denominations, but for a set like [1, 3, 4] it is not. Always test your greedy assumption against a small counterexample before committing.

There are two distinct failure modes here, and the second one surprises people. The obvious one is a suboptimal count: for [1, 3, 4] and amount 6, greedy takes 4 + 1 + 1 for three coins where 3 + 3 needs two. The worse one is a false negative. Give greedy the coins [3, 4] and amount 6 and it takes the 4, is left with 2, cannot proceed, and reports that the amount is impossible. But 3 + 3 makes 6 exactly. The algorithm does not merely return a worse answer, it denies that an answer exists. If that function backs an API, it rejects valid requests, and no exception is ever raised to tell you.

```go
// ❌ BAD: greedy is wrong for arbitrary denominations.
func coinChangeGreedy(coins []int, amount int) int {
    // Sort descending.
    slices.SortFunc(coins, func(a, b int) int {
        return cmp.Compare(b, a)
    })

    count := 0

    for _, coin := range coins {
        for amount >= coin {
            amount -= coin
            count++
        }
    }

    if amount > 0 {
        // Not "no solution exists", only "greedy painted itself into a corner".
        // coins=[3,4], amount=6 lands here despite 3+3 being a valid answer.
        return -1
    }

    // And even on success the count may exceed the true minimum:
    // coins=[1,3,4], amount=6 returns 3, but the optimum is 2.
    return count
}

// ✅ GOOD: Use DP for optimal solution
func coinChangeDP(coins []int, amount int) int {
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

---

### Junior → FAANG: Building an Anti-Pattern Checklist Before Every Greedy Problem

This section describes the single most common mistake: applying greedy when DP is required. To avoid it, build a pre-coding checklist with three items. First, state the greedy choice. Second, find or rule out a counterexample with small inputs (3-5 elements). Third, state the exchange argument in one sentence. If you cannot complete all three in under 60 seconds, stop and consider DP.

For the coin change problem, the counterexample is always the same: denominations [1, 3, 4], amount 6. Greedy picks 4 + 1 + 1 = 3 coins. Optimal is 3 + 3 = 2 coins. Keep it memorized as a fast disqualification test for any coin-type problem with arbitrary denominations. Keep [3, 4] with amount 6 alongside it, since a greedy that reports "impossible" for a solvable input is the more persuasive demonstration and takes the same five seconds to state.

Writing down the assumption your code depends on is the right habit even when you are confident. A comment that names the assumption forces you to ask whether it is justified, and in an interview it shows the interviewer the reasoning rather than making them infer it. Just make the comment true: "may not be optimal" would have undersold this function, which also lies about feasibility.

### Senior @ FAANG: The Cost of Greedy Mistakes in Production Systems

The interview scenario in this section (wrong algorithm on coin change) is a controlled failure. In production, applying greedy when DP is required produces silent correctness failures that can persist for months before being detected. The cost depends on what the algorithm is optimizing.

**Silent failures in resource allocation.** A greedy bin-packing algorithm in a cloud resource allocator produces placements that use more bins than necessary. That shows up as an infrastructure bill, never as an error or an exception. Be careful about the framing "suboptimal compared to DP" here: bin packing is NP-hard, so for realistic input sizes there is no DP baseline to compare against either. What you can do is bound the gap. First Fit Decreasing is guaranteed within 11/9 of optimal plus a constant, so a placement using far more bins than that bound allows means something other than the heuristic is wrong. You can also compute a cheap lower bound (total volume divided by bin capacity) and track the ratio of bins used to that floor as a metric. Neither gives you the optimum. Both turn an invisible cost into a number on a dashboard, which is the actual goal.

**Detection strategy.** The production-grade approach is to run the greedy algorithm in real time and the DP or optimal algorithm offline on the same inputs (sampled at 1-5% of traffic). Compare the outputs. If the greedy solution differs from the optimal by more than an acceptable margin, alert and investigate. This is the standard approach for validating heuristics in production ML systems (A/B testing the heuristic against the optimal model on held-out data), and it applies equally to algorithmic heuristics like greedy.

**Governance: who verifies algorithm correctness.** At staff level, algorithmic correctness is a shared responsibility between the engineer who wrote the algorithm and the team that owns the system's correctness SLA. The review process should include: a correctness proof or proof sketch, a counterexample test (if one exists, the algorithm is wrong, if none can be found after reasonable effort, add that reasoning to the PR), and a production validator that compares greedy output to optimal on sampled inputs. Building this governance process is a staff-level infrastructure investment with a long payoff horizon.
