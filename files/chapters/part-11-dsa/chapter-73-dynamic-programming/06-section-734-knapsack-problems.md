## 73.4 Knapsack Problems

### 0/1 Knapsack

The 0/1 knapsack problem asks for the maximum value achievable by selecting a subset of items without exceeding a weight capacity, where each item can be used at most once. Iterating the weight dimension backwards when updating `dp` prevents the same item from being counted multiple times within a single pass, as each `dp[w]` is only updated once per item.

```go
// Knapsack01 solves 0/1 knapsack problem
// Each item can be taken at most once
// Time: O(n*W), Space: O(W)
func Knapsack01(weights, values []int, capacity int) int {
    n := len(weights)

    // dp[w] = max value with capacity w
    dp := make([]int, capacity+1)

    for i := 0; i < n; i++ {
        // Traverse backwards to avoid using same item twice
        for w := capacity; w >= weights[i]; w-- {
            dp[w] = max(dp[w], dp[w-weights[i]]+values[i])
        }
    }

    return dp[capacity]
}

// CanPartition checks if array can be partitioned into equal sum subsets
// LeetCode 416: Partition Equal Subset Sum
func CanPartition(nums []int) bool {
    sum := 0
    for _, num := range nums {
        sum += num
    }

    if sum%2 != 0 {
        return false
    }

    target := sum / 2
    // dp[i] = true if we can make sum i
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

### Unbounded Knapsack

The unbounded variant lifts the "use each item at most once" restriction, allowing any item to be selected any number of times. Because reuse is permitted, the weight dimension is traversed forwards rather than backwards: when `dp[w]` is updated, `dp[w - weights[i]]` may already reflect the current item being included, which is exactly the behavior we want.

The implementation below puts weight in the outer loop and items in the inner loop, which is the other common spelling of the same algorithm. Both orderings are correct for the unbounded case, because `dp[w]` only ever reads strictly smaller indices and every smaller index is fully settled by the time it is read, so the two loops commute. That is not true of 0/1 knapsack, where items must be the outer loop: the whole point there is that item `i` gets exactly one pass over the capacity range. Swapping the loops in `Knapsack01` breaks it. Swapping them here does not. Coin change (minimum coins to reach a target amount) is the canonical example of this pattern, reframing "maximize value" as "minimize count."

```go
// KnapsackUnbounded allows unlimited use of each item
// Time: O(n*W), Space: O(W)
func KnapsackUnbounded(weights, values []int, capacity int) int {
    dp := make([]int, capacity+1)

    for w := 1; w <= capacity; w++ {
        for i := 0; i < len(weights); i++ {
            if weights[i] <= w {
                dp[w] = max(dp[w], dp[w-weights[i]]+values[i])
            }
        }
    }

    return dp[capacity]
}

// CoinChange is an unbounded knapsack variant
// Minimize coins instead of maximize value
```

### Target Sum

At first glance this problem seems to require exploring 2^n sign assignments, but it reduces to a subset-sum count via a mathematical substitution. If `P` is the sum of positively assigned numbers and `N` the rest, then `P - N = target` and `P + N = sum`, which gives `P = (target + sum) / 2`. Counting the number of subsets that sum to `P` is a standard 0/1 knapsack variant, bringing the complexity from exponential to O(n · sum).

```go
// FindTargetSumWays counts ways to assign +/- to reach target
// LeetCode 494: Target Sum
// Time: O(n*sum), Space: O(sum)
func FindTargetSumWays(nums []int, target int) int {
    // Let P = sum of positive assignments
    // Let N = sum of negative assignments
    // P - N = target
    // P + N = sum
    // P = (target + sum) / 2

    sum := 0
    for _, num := range nums {
        sum += num
    }

    if (sum+target)%2 != 0 || sum < target || sum < -target {
        return 0
    }

    p := (sum + target) / 2
    if p < 0 {
        return 0
    }

    // Count subsets with sum P
    dp := make([]int, p+1)
    dp[0] = 1

    for _, num := range nums {
        for j := p; j >= num; j-- {
            dp[j] += dp[j-num]
        }
    }

    return dp[p]
}
```

### Junior → FAANG: Knapsack as the Foundation for a Problem Family

Mastering 0/1 knapsack is not about memorizing one solution, it is about learning a template that applies to a dozen interview problems. The key invariant is: iterate items in the outer loop, iterate capacity in the inner loop backwards (for 0/1) or forwards (for unbounded). Once this direction rule is internalized, subset sum, partition equal subset, target sum, and coin change all become straightforward applications.

The most common interview mistake is forgetting to iterate the inner loop backwards for 0/1 knapsack. The backwards direction ensures that when you read `dp[w - weights[i]]`, that value has not yet been updated in the current item's pass, so it reflects the state before the current item was considered. Forgetting this causes each item to be counted multiple times, producing unbounded knapsack behavior.

For `CanPartition` (LeetCode 416), the mathematical setup is the bridge from a boolean question to a knapsack problem. If the total sum is odd, no valid partition exists. If even, find whether any subset sums to `sum / 2`. Reducing a partition problem to a subset-sum knapsack is itself a recognized pattern in interviews, and mentioning the reduction explicitly before coding shows mathematical maturity.

For `FindTargetSumWays`, narrate the algebra: "P - N = target and P + N = sum, so P = (target + sum) / 2. I now need to count subsets summing to P, which is a counting knapsack." Reducing a non-obvious problem to a known template scores better than inventing a new approach on the spot, and it is the specific move being looked for.

### Senior @ FAANG: Knapsack in Resource Allocation and Capacity Planning

The 0/1 knapsack is the foundational model for resource allocation under discrete constraints. At the platform level, instances of this problem appear in job scheduling (assign tasks to machines to maximize utilization without exceeding CPU or memory limits), feature flag budget allocation (select which experiments to run given a constraint on total user exposure), and ad auction (select which ads to show in a fixed number of slots to maximize expected revenue).

The production gap between the textbook algorithm and a deployed system is significant. Textbook knapsack assumes exact integer weights and a scalar capacity. Production resource allocation typically involves: fractional resources (a task uses 1.5 CPU cores), multiple capacity dimensions (CPU and memory must both be satisfied), time-varying capacities (capacity changes across a scheduling window), and soft constraints (violating a constraint by 5% is acceptable if the total value increase justifies it). These extensions require moving from pure DP to mixed-integer programming (MIP) or approximation algorithms, but the DP solution remains the baseline that MIP solvers are benchmarked against.

A bar-raiser interview for senior engineers often takes the form: "Consider a production knapsack-based scheduler you deployed. During load testing you observe that it is too slow for your target 99th-percentile latency. How do you diagnose and address this?" The expected answer covers: profiling the table fill loop to identify the bottleneck, checking whether the capacity dimension can be reduced by GCD normalization (if all weights share a common factor, divide through to shrink the table), evaluating whether an approximate greedy solution is acceptable, and considering whether the problem is really a feasibility question rather than an optimization one, because if it is, bitset DP applies: pack the reachable-sums table into `uint64` words and each item becomes a single shift-and-or (`reach |= reach << weight`), advancing 64 capacity cells per instruction. The caveat is what makes it a senior answer rather than a trivia answer: bitset DP works for "which sums are reachable" (subset sum, partition) and does not directly carry values, so a max-value knapsack cannot use it without reformulation. Knowing both that it exists and where it stops applying is the differentiator.

### Junior → FAANG: The Loop Direction Rule as a Memory Anchor

The single most important thing to memorize about knapsack is the loop direction rule: iterate the capacity dimension backwards for 0/1 knapsack, forwards for unbounded knapsack. If you forget this rule during an interview, derive it on the spot. Ask yourself: "when I compute `dp[w]`, has `dp[w - weight[i]]` already been updated for item `i` in this pass?" For 0/1, you want the answer to be no (backwards traversal ensures this). For unbounded, you want the answer to be yes (forwards traversal ensures this). Two sentences of derivation are more reliable than memorized direction.

For the `CanPartition` problem, the mathematical bridge from "can I partition into two equal subsets" to "does any subset sum to half the total" is the part candidates most often skip. Walk through it explicitly in an interview: "The total sum is S. If I assign positive signs to a subset P and negative signs to the rest N, then P - N = 0 requires P = N = S/2. So I need a subset summing to S/2." This narration takes 20 seconds and earns significant credit.

### Senior @ FAANG: Knapsack Variants in Platform Capacity Engineering

Production capacity engineering problems are almost always multi-dimensional knapsack variants. A cloud capacity planner must select a mix of instance types (items, with CPU and memory as two weight dimensions) to serve a workload (value to maximize: throughput per dollar) subject to a budget constraint (capacity). The textbook 1D knapsack is insufficient. The production problem is 2D knapsack or fractional knapsack with continuous relaxation.

The GCD normalization optimization for the capacity dimension is underused in practice. If all item weights share a common factor g, the capacity dimension can be divided by g (and the capacity floored to the nearest multiple), reducing the table by a factor of g. The win comes from choosing the right unit. A planner that models a 1 TB budget in bytes carries a table of 2^40 entries and will never finish. If every allocation is a whole number of gigabytes, then g is 2^30, and normalizing collapses that table to 1024 entries, which fills in microseconds. Same problem, same answer, a billion-fold smaller table, purely from noticing that the byte-level resolution was never real. Documenting this normalization in the ADR, including the derivation of g and the proof that the normalized problem is equivalent, is a production engineering habit that prevents future engineers from treating the table size as a fixed constant.

The subset-sum variant (CanPartition) appears in workload balancing: given a set of tasks with known durations, can they be split into two groups of exactly equal total duration? This is NP-complete in general but solvable by DP when the total duration is bounded, which it usually is in production scheduling contexts where task durations are measured in minutes. Staff engineers recognize the NP-completeness, document the feasibility bound (what total duration makes the DP tractable), and design the system to enforce that bound.
