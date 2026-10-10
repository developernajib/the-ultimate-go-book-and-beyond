## 75.15 Interview Pitfalls

### Pitfall 1: Applying Greedy When It Doesn't Work

**The failure**: reaching for greedy on coin change with coins [1, 3, 4] and amount 6. Greedy takes 4+1+1 for three coins and misses the optimal 3+3 for two. Greedy is correct for coin change only when the denominations happen to be canonical, as US currency is. Nothing tells you a system is canonical by looking at it, so with arbitrary denominations the answer is DP.

```go
// ❌ WRONG: greedy doesn't work for all coin systems.
func coinChangeGreedy(coins []int, amount int) int {
    // Sort descending.
    slices.SortFunc(coins, func(a, b int) int {
        return cmp.Compare(b, a)
    })

    count := 0

    for _, coin := range coins {
        count += amount / coin  // Take as many as possible
        amount %= coin
    }

    if amount > 0 {
        return -1  // Can't make exact change
    }
    return count  // WRONG for [1,3,4], amount=6: returns 3, not 2
}

// ✅ CORRECT: Use DP when greedy doesn't apply
func coinChangeDP(coins []int, amount int) int {
    dp := make([]int, amount+1)
    for i := 1; i <= amount; i++ {
        dp[i] = amount + 1  // Sentinel for impossible
    }

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
    return dp[amount]  // Correct: returns 2 for [1,3,4], amount=6
}
```

### Pitfall 2: Wrong Sorting Criteria for Intervals

**The failure**: sorting intervals by start time for "non-overlapping intervals". For minimum removals you must sort by END time. Start-time order produces suboptimal removal counts, and on randomized inputs this bug fires often enough that you will notice it, roughly one small case in ten.

```go
// ❌ WRONG: sorting by start time.
func eraseOverlapIntervalsBad(intervals [][]int) int {
    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[0], b[0]) // WRONG: sort by start.
    })

    count := 0
    prevEnd := intervals[0][1]

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] < prevEnd {
            count++
            // Keep the one ending earlier... but our sort doesn't help here!
        } else {
            prevEnd = intervals[i][1]
        }
    }
    return count  // May not be minimum
}

// ✅ CORRECT: Sort by end time
func eraseOverlapIntervalsGood(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    // Sort by END time. Greedy: keep the intervals that end earliest.
    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[1], b[1])
    })

    count := 0
    prevEnd := intervals[0][1]

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] < prevEnd {
            count++  // Must remove this one (starts before prev ends)
            // prevEnd stays same (we removed current, kept previous)
        } else {
            prevEnd = intervals[i][1]  // No overlap, update end
        }
    }
    return count  // Minimum removals guaranteed
}
```

### Pitfall 3: Not Handling Edge Cases in Greedy Assignment

**The failure**: an "assign cookies" solution that breaks when there are more children than cookies, indexing into the cookies array without a bounds check and panicking.

```go
// ❌ WRONG: No bounds checking
func findContentChildrenBad(g []int, s []int) int {
    slices.Sort(g)  // Children greed
    slices.Sort(s)  // Cookie sizes

    count := 0
    cookieIdx := 0

    for _, greed := range g {
        // BUG: What if we run out of cookies?
        for s[cookieIdx] < greed {  // Crashes when cookieIdx >= len(s)!
            cookieIdx++
        }
        count++
        cookieIdx++
    }
    return count
}

// ✅ CORRECT: Check bounds
func findContentChildrenGood(g []int, s []int) int {
    slices.Sort(g)
    slices.Sort(s)

    child, cookie := 0, 0

    for child < len(g) && cookie < len(s) {
        if s[cookie] >= g[child] {
            child++  // Child satisfied
        }
        cookie++  // Move to next cookie regardless
    }
    return child  // Number of satisfied children
}
```

### Pitfall 4: Greedy Without Proving Correctness

**The failure**: claiming greedy works for "partition array for maximum sum" because "taking the max in each window seems optimal." It is the word *seems* that gives it away. Where the partition boundaries belong depends on the values, so a fixed-size window is a guess, not a rule. If you cannot produce the exchange argument, you do not have a greedy solution.

```go
// ❌ WRONG: Assuming greedy works without proof
func maxSumAfterPartitioningGreedy(arr []int, k int) int {
    // Greedy: always make each partition as large as possible?
    // This is WRONG - optimal partition sizes depend on values!
    n := len(arr)
    result := 0
    i := 0

    for i < n {
        maxVal := arr[i]
        partLen := min(k, n-i)

        for j := 0; j < partLen; j++ {
            maxVal = max(maxVal, arr[i+j])
        }

        result += maxVal * partLen
        i += partLen
    }
    return result  // Wrong for many inputs
}

// ✅ CORRECT: This problem requires DP, not greedy
func maxSumAfterPartitioningDP(arr []int, k int) int {
    n := len(arr)
    dp := make([]int, n+1)  // dp[i] = max sum for arr[0:i]

    for i := 1; i <= n; i++ {
        maxVal := 0
        // Try all partition lengths 1 to k ending at position i
        for j := 1; j <= k && i-j >= 0; j++ {
            maxVal = max(maxVal, arr[i-j])
            dp[i] = max(dp[i], dp[i-j]+maxVal*j)
        }
    }
    return dp[n]
}
```

### Pitfall 5: Missing the Two-Pass Pattern

**The failure**: solving "candy distribution" in one pass, assigning each child candies based on the left neighbour alone. The constraint is bidirectional. A rating higher than the *right* neighbour must also earn more candies, and only a second right-to-left pass enforces it.

```go
// ❌ WRONG: Only considers left neighbor
func candyBad(ratings []int) int {
    n := len(ratings)
    candies := make([]int, n)
    for i := range candies {
        candies[i] = 1
    }

    // Only left-to-right pass
    for i := 1; i < n; i++ {
        if ratings[i] > ratings[i-1] {
            candies[i] = candies[i-1] + 1
        }
    }

    sum := 0
    for _, c := range candies {
        sum += c
    }
    return sum  // WRONG: Doesn't satisfy right neighbor constraints
}

// ✅ CORRECT: Two passes (left-to-right AND right-to-left)
func candyGood(ratings []int) int {
    n := len(ratings)
    candies := make([]int, n)
    for i := range candies {
        candies[i] = 1
    }

    // Pass 1: Left to right
    for i := 1; i < n; i++ {
        if ratings[i] > ratings[i-1] {
            candies[i] = candies[i-1] + 1
        }
    }

    // Pass 2: Right to left
    for i := n - 2; i >= 0; i-- {
        if ratings[i] > ratings[i+1] {
            candies[i] = max(candies[i], candies[i+1]+1)
        }
    }

    sum := 0
    for _, c := range candies {
        sum += c
    }
    return sum
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Greedy doesn't apply | Suboptimal solution | Prove greedy choice property first |
| Wrong sorting criteria | Wrong answer | Intervals: usually sort by END time |
| Missing bounds check | Array index panic | Always check array bounds in loops |
| No correctness proof | Interviewer skepticism | Explain WHY greedy works |
| Single pass insufficient | Constraint violation | Consider two-pass for bidirectional constraints |
| Greedy vs DP confusion | Wrong approach | If choices affect future options, likely DP |

---

### Junior → FAANG: Using This Pitfall Table as a Pre-Submit Checklist

The six pitfalls in this section are not abstract warnings. They are a checklist you should run through before submitting every greedy solution in an interview. Take 60 seconds after writing your code and ask: (1) Did I verify greedy choice property? (2) Did I sort by the right criterion? (3) Did I check bounds in every loop? (4) Can I explain why it works? (5) Do I need a second pass? (6) Is this actually a DP problem?

The most high-value pitfall to eliminate first is Pitfall 2 (wrong sorting criteria for intervals). It is easy to catch with one test case: `[[1,100],[2,3],[3,4]]`. If you sort by start time and try to find non-overlapping intervals, you pick `[1,100]` first and can add nothing else. If you sort by end time, you pick `[2,3]`, then `[3,4]`, giving 2 intervals. Run this test mentally before finalizing any interval solution.

Pitfall 3 (bounds checking) is particularly important in Go because out-of-bounds access is a runtime panic, not undefined behavior. The compiler will not catch it. Always test your solution with empty input, a single element, and a case where the secondary array (cookies, stack, heap) is exhausted before the primary array.

### Senior @ FAANG: Pitfall Prevention at the System Level

The failure-first framing in this section mirrors a production practice. Post-incident reviews use the same shape: describe the failure, identify the root cause, define the prevention measure. Training engineers to think about algorithm bugs in that format builds prevention-first habits, and it moves the conversation off the individual who wrote the code and onto the check that was missing.

**Systematic testing prevents Pitfall 1.** Applying greedy when DP is required is a category of bug that unit tests can catch if the test suite includes adversarial counterexamples. For the coin change problem, the counterexample `[1, 3, 4]` with amount 6 is the canonical adversarial test. A staff engineer reviewing a PR that introduces a new greedy algorithm asks: "What is the counterexample test for this algorithm?" If none exists, the PR is not ready to merge. Building this review criterion into the team's PR checklist is a governance action with measurable impact on correctness defect rates.

**Pitfall 2 (sorting criterion) as a type safety opportunity.** Wrong sorting criteria are a category of bug that the type system can sometimes prevent. If intervals are represented as a named type `type Interval struct { Start, End int }` rather than `[]int`, the comparator is written in terms of `a.End < b.End` rather than `intervals[i][1] < intervals[j][1]`. The named fields are self-documenting and reduce the chance of using the wrong field. Enforcing the use of named types for domain objects (rather than generic slices) is a code review standard that prevents this pitfall systematically.

**Pitfall 5 (single pass insufficient) and bidirectional constraint detection.** A staff engineer reviewing code for bidirectional constraint problems asks: "Is the correct value at position i dependent on values to its right?" If yes, a single left-to-right pass is insufficient. This question should be answered by inspecting the problem statement, not by running the code and seeing if it fails. Teaching this inspection habit through code review feedback (commenting "this constraint is bidirectional, have you verified that a second right-to-left pass is not needed?") builds team-wide awareness without requiring a separate pitfall document.
