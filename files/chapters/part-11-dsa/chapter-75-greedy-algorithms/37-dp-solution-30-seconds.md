## DP Solution (30 seconds)
"We need DP because each item creates a choice that affects
all future choices. DP explores all possibilities:

dp[i][w] = max value using the first i items with capacity w

  skip item i:  dp[i-1][w]
  take item i:  dp[i-1][w-weight[i-1]] + value[i-1]
                (only when weight[i-1] <= w)

dp[i][w] = max of whichever options are available.

Watch the indices. dp[i] covers the first i items, so item i
lives at weight[i-1] and value[i-1], not weight[i]. Mixing the
two conventions is the most common way to get this wrong, and
without the weight[i-1] <= w guard the take branch indexes a
negative capacity."

### Junior → FAANG: Translating the Recurrence into Working Code

The DP recurrence for 0/1 knapsack is the canonical example of a "choice" recurrence: at each item, you either skip it (carry forward the value without it) or take it (add its value to the best solution without it at reduced capacity). New engineers commonly make two mistakes: using a 2D array when a 1D rolling array suffices (iterate capacity in reverse to avoid using the same item twice), and forgetting to handle the case where the current item's weight exceeds the remaining capacity. Practicing this problem until the implementation comes out without bugs in under 10 minutes is the baseline for a mid-level interview at any FAANG company.

### Senior @ FAANG: Scaling DP to Production Constraints and Choosing Between Exact and Approximate Solutions

The standard 0/1 knapsack DP runs in O(nW) time and O(W) space after the rolling array optimization. At senior level, the interview question shifts: "What if W is 10^9?" The answer is that pseudo-polynomial DP is no longer feasible and the problem must be either approximated or reformulated. Practical paths include: (1) coordinate compression when items have few distinct weights, collapsing the effective capacity, (2) meet-in-the-middle for small n (up to ~40 items), (3) LP relaxation followed by branch-and-bound for production systems where near-optimality is acceptable. At the staff/L7 level, the question becomes architectural: how does your system decide at runtime which solver to invoke given input characteristics (n, W, time budget)? A well-designed solver dispatcher uses a decision tree based on problem size, routes small exact problems to DP, medium problems to B&B with a time limit, and large problems to a greedy or FPTAS baseline. This tiered solver architecture is documented in an ADR and must be owned by the senior engineer responsible for the optimization service.

---
