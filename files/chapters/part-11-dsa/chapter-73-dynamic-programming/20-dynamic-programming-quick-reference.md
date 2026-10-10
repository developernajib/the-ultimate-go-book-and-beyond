## Dynamic Programming Quick Reference

The table below distills the major DP patterns into a canonical state definition and recurrence. Use it to classify an unfamiliar problem: identify what varies (index, capacity, two pointers, range), write that as your state, then derive the recurrence from the choices available at each state. Note the loop direction called out on the knapsack rows. Iterating right-to-left prevents an item from being counted twice in 0/1 knapsack, while left-to-right enables unlimited reuse in the unbounded variant. It is the one line in this table that changes the answer rather than the speed.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DP PATTERNS CHEAT SHEET                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  PATTERN           │ STATE              │ RECURRENCE                    │
│  ─────────────────────────────────────────────────────────────────────  │
│  Fibonacci/Stairs  │ dp[i]              │ dp[i] = dp[i-1] + dp[i-2]     │
│  House Robber      │ dp[i]              │ dp[i] = max(dp[i-1],          │
│                    │                    │         dp[i-2]+nums[i])      │
│  Coin Change       │ dp[amount]         │ dp[i] = min(dp[i-coin]+1)     │
│  LIS               │ dp[i] = LIS ending │ dp[i] = max(dp[j]+1)          │
│                    │ at i               │ for all j < i where a[j]<a[i] │
│  ─────────────────────────────────────────────────────────────────────  │
│  Grid Paths        │ dp[i][j]           │ dp[i][j] = dp[i-1][j] +       │
│                    │                    │            dp[i][j-1]         │
│  LCS               │ dp[i][j] for       │ if match: dp[i-1][j-1]+1      │
│                    │ s1[0:i], s2[0:j]   │ else: max(dp[i-1][j],         │
│                    │                    │           dp[i][j-1])         │
│  Edit Distance     │ dp[i][j]           │ if match: dp[i-1][j-1]        │
│                    │                    │ else: 1+min(3 options)        │
│  ─────────────────────────────────────────────────────────────────────  │
│  0/1 Knapsack      │ dp[w] = max value  │ dp[w] = max(dp[w],            │
│                    │ with capacity w    │         dp[w-wt]+val)         │
│                    │                    │ Process R-to-L!               │
│  Unbounded Knapsack│ Same               │ Process L-to-R!               │
│  ─────────────────────────────────────────────────────────────────────  │
│  Stock Buy/Sell    │ dp[i][holding]     │ State machine transitions     │
│  Stock w/ Cooldown │ dp[i][state]       │ hold/sold/rest states         │
│  ─────────────────────────────────────────────────────────────────────  │
│  Interval DP       │ dp[i][j] for       │ Matrix chain, split AT k:     │
│  (Matrix Chain)    │ range [i,j]        │ dp[i][k] + dp[k+1][j] + c     │
│  (Burst Balloons)  │                    │ Balloons, k burst LAST:       │
│                    │                    │ dp[i][k-1] + dp[k+1][j] + c   │
│                    │                    │ Note the halves never         │
│                    │                    │ overlap at k. Fill by         │
│                    │                    │ increasing length.            │
│                                                                         │
│  OPTIMIZATION TECHNIQUES:                                               │
│  • Space: Use rolling array if only need prev row/few values            │
│  • 0/1 vs Unbounded: Direction of inner loop matters!                   │
│  • Binary Search + DP: LIS in O(n log n) (length only, not the seq)     │
│  • Monotonic Stack + DP: Some range problems                            │
│  • Monotonic Queue + DP: Sliding-window max/min transitions             │
│                                                                         │
│  COMMON MISTAKES:                                                       │
│  ✗ Forgetting base cases                                                │
│  ✗ Sentinel left at the zero value (min DP then returns 0)              │
│  ✗ Sentinel = MaxInt, then +1 wraps SILENTLY to MinInt                  │
│  ✗ Returning the sentinel instead of -1 / "impossible"                  │
│  ✗ Off-by-one in array sizes                                            │
│  ✗ Wrong loop direction in space-optimized knapsack                     │
│  ✗ Not handling edge cases (empty input, n=0, n=1)                      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Cheat Sheet Actively

The patterns table above is most useful when you internalize it as a decision tree, not as a lookup table. When you read a problem, work through the columns in order: what are the "what varies" dimensions (index, two string positions, capacity, range)? That determines the state. Then what choices are available at each state (take or skip, match or skip, split or not)? That determines the recurrence form. Then which loop direction keeps dependencies satisfied?

Print this table and keep it next to your practice environment. After each problem you solve, identify which row it belongs to and verify that your implementation matches the pattern. When you encounter a problem that does not fit cleanly into a row, it either combines two patterns (LCS with a length limit adds a third dimension) or it is not a DP problem at all.

The common mistakes section is the most important part to memorize, because every entry on it produces a plausible number rather than a crash. The base case, sentinel, and knapsack-direction errors are the ones that recur most, and none of them will be caught by the compiler or by a test case that only checks a happy path. Run the list after writing every DP solution, before testing.

### Senior @ FAANG: The Cheat Sheet as a Team Knowledge Artifact

At the staff level, a DP pattern reference like this serves as a team knowledge artifact, not just a personal study aid. When a team is implementing a new feature that requires DP (e.g., a resource scheduler, a recommendation ranker, a diff tool), the patterns table provides a shared vocabulary for design discussions. Saying "this is a knapsack variant with an additional capacity dimension" is faster and less ambiguous than describing the state and recurrence from scratch.

The "common mistakes" section also serves as a code review heuristic. Senior engineers who have internalized these patterns can scan a DP implementation and identify whether the loop direction, array sizing, base case initialization, and sentinel values are correct in under 60 seconds. This makes DP code reviews faster and more effective.

The "optimization techniques" section hints at a maturity model for DP implementations. A Level 1 implementation is correct but unoptimized (full 2D table). A Level 2 implementation applies space optimization (rolling arrays). A Level 3 implementation applies algorithmic optimization (binary search for LIS, monotonic queue for sliding window DP). Level 4 applies problem-specific mathematical shortcuts (GCD normalization for knapsack, number theory for perfect squares). Teams should document which level is appropriate for their performance requirements and explicitly decide not to go further unless profiling justifies it.

### Junior → FAANG: The Reference Card as an Active Practice Tool

The cheat sheet is most useful when used to generate new practice problems rather than to look up known ones. Pick any row from the patterns table (e.g., "0/1 Knapsack: dp[w], process R-to-L") and write a novel problem that fits that pattern before looking at any LeetCode problems. This forces you to understand the pattern well enough to author a problem, not just solve one. Writing a problem and then solving it is one of the most effective practice techniques available.

For the common mistakes section, use each mistake as a prompt to write a buggy implementation deliberately. Write `make([]int, n)` instead of `make([]int, n+1)`, submit it, watch it fail, then fix it. This deliberate bug-then-fix cycle builds the mental alarm that fires automatically when you write the wrong version in an interview.

The optimization techniques section maps to a set of follow-up questions you should be able to answer unprompted for every DP solution you present. After presenting a solution, immediately say: "I can reduce the space from O(n^2) to O(n) by using a rolling array" (if applicable), "I can improve the time from O(n^2) to O(n log n) by using binary search" (for LIS), or "for this problem, the space optimization does not apply because the recurrence reads from more than the immediately prior row." Volunteering these follow-ups before being asked is the signal that separates L5-ready candidates from L4-ready ones.

### Senior @ FAANG: The Reference Card as a Team Alignment Artifact

At the staff level, a shared DP reference card serves as a vocabulary alignment document for an engineering team. When different engineers use different terminology for the same concept (one says "memoization table," another says "cache," a third says "precomputed results"), design discussions become ambiguous. A shared reference card that defines terms precisely (the state, the recurrence, the base case, the rolling-array optimization) eliminates these ambiguities and makes technical discussions faster and more precise.

The maturity model implicit in the optimization techniques section is worth making explicit in the team's engineering principles document. Defining Level 1 through Level 4 implementations and establishing a policy that "all production DP must be at Level 2 or above, with profiling data required to justify Level 3 or Level 4" sets a clear baseline while requiring evidence-based decisions for further optimization. This prevents both premature optimization (Level 4 applied without profiling justification) and underoptimization (Level 1 shipped without considering the space implications).

---
