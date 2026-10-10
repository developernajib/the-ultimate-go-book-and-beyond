## 75.6 Candy and Assignment Problems

These problems involve distributing resources (candies, cookies) among recipients while satisfying ordering or capacity constraints. The candy problem (LeetCode 135) requires that each child gets at least one candy and that children with higher ratings than their neighbors receive more candies. A single left-to-right pass handles increasing sequences, but you also need a right-to-left pass to handle decreasing sequences, taking the maximum of both passes at each position. The assign cookies problem is simpler: sort both children's greed factors and cookie sizes, then use a two-pointer scan to greedily match the smallest satisfying cookie to each child.

```go
// Candy distributes minimum candies following rules
// LeetCode 135: Candy
// Time: O(n), Space: O(n)
func Candy(ratings []int) int {
    n := len(ratings)
    if n <= 1 {
        return n
    }

    candies := make([]int, n)
    for i := range candies {
        candies[i] = 1
    }

    // Left to right: handle increasing ratings
    for i := 1; i < n; i++ {
        if ratings[i] > ratings[i-1] {
            candies[i] = candies[i-1] + 1
        }
    }

    // Right to left: handle decreasing ratings
    for i := n - 2; i >= 0; i-- {
        if ratings[i] > ratings[i+1] && candies[i] <= candies[i+1] {
            candies[i] = candies[i+1] + 1
        }
    }

    total := 0
    for _, c := range candies {
        total += c
    }

    return total
}

// FindContentChildren returns the maximum number of children that can be made
// content, where child i is content with any cookie of size >= g[i] and each
// cookie serves at most one child.
// LeetCode 455: Assign Cookies
//
// Both inputs are sorted in place. Time: O(n log n + m log m),
// Space: O(log n) for the sorts' stacks.
func FindContentChildren(g []int, s []int) int {
    slices.Sort(g) // children's greed factors
    slices.Sort(s) // cookie sizes

    child, cookie := 0, 0

    for child < len(g) && cookie < len(s) {
        if s[cookie] >= g[child] {
            child++
        }
        cookie++
    }

    return child
}
```

### Junior → FAANG: The Two-Pass Technique as a Reusable Pattern

The candy problem is the canonical example of the two-pass greedy technique. The insight is that a single left-to-right pass can only enforce constraints relative to the left neighbor, but the problem has bidirectional constraints (each child must have more candies than both neighbors if their rating is higher). The second right-to-left pass handles the right-neighbor constraint and takes the maximum of both passes at each position.

Memorize this pattern, not just the candy solution. Two-pass greedy applies to several related problems: trapping rain water (left-max and right-max arrays), building heights with sunlight constraints, and evaluating expressions with bidirectional precedence. Whenever constraints flow in two directions, consider two passes.

For the assign cookies problem, the two-pointer approach is the key pattern. Always advance the cookie pointer regardless of whether a child is satisfied (you tried this cookie, whether it worked or not, you move on). This is a common mistake: advancing the cookie pointer only when a child is satisfied leads to an infinite loop.

### Senior @ FAANG: Resource Assignment Fairness and Optimality Tradeoffs

The candy and cookies problems are stylized models of resource assignment fairness. In production systems, the tradeoff between fairness (each recipient gets a proportional share) and efficiency (minimize total resource consumption) is a constant design tension.

**Kubernetes resource allocation.** Pod scheduling is an assignment problem: pods carry resource requests, nodes carry capacity, and the scheduler places pods so that no node is over-committed while cluster utilization stays high. The kube-scheduler does this by filtering nodes to the feasible set and then scoring them, taking the top-scoring node for each pod in turn, which is greedy in the practical sense of one irrevocable local decision per pod with no lookahead. That is fine while pods are independent. It degrades once pods constrain each other, through affinity rules, anti-affinity, topology spread, or gang scheduling, where placing one pod well can make a later pod unplaceable. The connection to the cookies problem is worth stating carefully, because it is easy to overclaim: sorted two-pointer matching is provably optimal for one-dimensional cookies, and nothing about that proof survives multi-dimensional resources plus inter-pod constraints. The scheduler is a heuristic, and the fact that a related toy problem has an optimality proof does not lend it one.

**Fairness models in distributed systems.** Max-min fairness (maximize the minimum allocation) and proportional fairness (allocate proportional to weights) are two alternative objectives that differ from the candy problem's "strict ordering" fairness. A staff engineer designing a resource allocator must choose the fairness model explicitly, document the tradeoff (max-min is more fair but wastes more resources when demands are heterogeneous, proportional is more efficient but can starve low-priority users), and implement the chosen model correctly.

**Bar-raiser signal.** An L6 candidate asked "how would you extend the cookie assignment to handle children with multiple greed dimensions (e.g., both a preferred flavor and a size preference)?" recognizes that this is a multi-attribute matching problem, connects it to stable matching (Gale-Shapley) or multi-objective optimization, states whether greedy still works (only if the dimensions are independent and lexicographically ordered), and proposes a concrete algorithm. The ability to generalize cleanly under interview pressure is the L6 differentiator.
