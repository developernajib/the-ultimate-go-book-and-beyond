## 73.7 Matrix Chain Multiplication Pattern

### Burst Balloons

The burst balloons problem uses an interval DP where `dp[l][r]` represents the maximum coins obtainable by bursting all balloons between indices `l` and `r`. The key insight is to think of each balloon `k` as the *last* one burst within the interval, not the first. This avoids dependency on which balloons in the interval have already been removed.

```go
// MaxCoins finds maximum coins from bursting balloons
// LeetCode 312: Burst Balloons
// Time: O(n^3), Space: O(n^2)
func MaxCoins(nums []int) int {
    n := len(nums)
    // Add boundary balloons
    balloons := make([]int, n+2)
    balloons[0] = 1
    balloons[n+1] = 1
    copy(balloons[1:], nums)

    // dp[i][j] = max coins from bursting balloons in range (i, j)
    dp := make([][]int, n+2)
    for i := range dp {
        dp[i] = make([]int, n+2)
    }

    // Fill for increasing ranges
    for length := 1; length <= n; length++ {
        for i := 1; i <= n-length+1; i++ {
            j := i + length - 1
            for k := i; k <= j; k++ {
                // k is the last balloon to burst
                coins := balloons[i-1]*balloons[k]*balloons[j+1] +
                        dp[i][k-1] + dp[k+1][j]
                dp[i][j] = max(dp[i][j], coins)
            }
        }
    }

    return dp[1][n]
}
```

### Matrix Chain Multiplication

Matrix chain multiplication asks for the optimal parenthesization of a chain of matrices to minimize the total number of scalar multiplications. Multiplying an `a×b` matrix by a `b×c` matrix costs `a*b*c` operations, and associativity means the order of grouping dramatically changes the total cost. The interval DP here tries every split point `k` within each subchain `[i, j]`, computing the cost of multiplying the left group, the right group, and then combining them. The recurrence `dp[i][j] = min over k of (dp[i][k] + dp[k+1][j] + dims[i]*dims[k+1]*dims[j+1])` finds the globally optimal split by building up from chains of length 2 to the full chain.

```go
// MatrixChainMultiplication finds the minimum scalar multiplications needed.
// dims has length n+1: matrix i has shape dims[i] x dims[i+1].
// Returns the cost, not the parenthesization. Track the argmin k per cell to
// recover the actual grouping.
// Time: O(n^3), Space: O(n^2)
func MatrixChainMultiplication(dims []int) int {
    n := len(dims) - 1 // number of matrices

    // dp[i][j] = min cost to multiply matrices i to j
    dp := make([][]int, n)
    for i := range dp {
        dp[i] = make([]int, n)
    }

    // Fill for increasing chain lengths
    for length := 2; length <= n; length++ {
        for i := 0; i <= n-length; i++ {
            j := i + length - 1
            dp[i][j] = 1 << 30
            for k := i; k < j; k++ {
                cost := dp[i][k] + dp[k+1][j] + dims[i]*dims[k+1]*dims[j+1]
                dp[i][j] = min(dp[i][j], cost)
            }
        }
    }

    return dp[0][n-1]
}
```

### Junior → FAANG: Interval DP as a Category

Interval DP is the hardest pattern to recognize because the problems look structurally diverse (balloons, matrices, stones, parentheses) but all share the same template: iterate over increasing interval lengths, try every split point within each interval, and use precomputed sub-interval results. The key insight is always to think of the last operation rather than the first, because choosing the last-burst balloon (or last-merged stone pile, or outermost matrix product) creates clean independence between sub-intervals.

For burst balloons (LeetCode 312), the interview narration that matters is: "I consider balloon k as the last one to be burst in interval [l, r]. When k is the last to burst, the coins I gain from k are `balloons[l-1] * balloons[k] * balloons[r+1]` because at that point, l-1 and r+1 are the nearest survivors. This makes the left and right sub-problems independent, so I can add their results." Without this "last burst" insight, the sub-problems are entangled (removing an element changes the neighbors of remaining elements), and the recurrence cannot be written.

For matrix chain multiplication, the analogous narration is: "I try every split point k as the place where the final multiplication happens, combining the left product and right product and adding the cost of the final multiplication." Drawing a small example (three matrices with dimensions given) and filling the DP table by hand in an interview shows competence more convincingly than writing code from memory.

### Senior @ FAANG: Interval DP in Compiler and Query Optimization

Matrix chain multiplication is not an academic exercise, it is the ancestor of query plan optimization in relational databases. A SQL join of tables A, B, C, D has many valid orderings, the cost of each depends on the intermediate result sizes, and the planner picks the cheapest by dynamic programming over subplans, the bottom-up approach IBM's System R introduced and that PostgreSQL and most other engines still use in recognizable form.

The resemblance is real but it is not an equality, and the difference is the interesting part. Matrix chain is restricted to *contiguous* intervals: matrices are a fixed sequence and only adjacent groups can combine, which is what bounds it to O(n^3) over the O(n^2) intervals. Joins have no such fixed order. Any subset of relations can be joined with any other, so the planner's DP is over *subsets*, and that table has 2^n entries, not n^2. This is why the two have such different tolerances for n: an O(n^3) interval DP is comfortable at n in the hundreds, while subset-based join ordering falls off a cliff in the low teens.

The burst balloons problem structure appears in optimal binary search tree construction (Knuth's algorithm) and in the CYK algorithm for context-free grammar parsing. CYK is O(n^3 * |G|) where |G| is the grammar size, and it is used in natural language processing and compiler front-ends. Knowing these connections demonstrates the breadth of systems knowledge that distinguishes staff engineers from senior engineers.

An ADR consideration for interval DP in production: the O(n^3) complexity is often acceptable for n up to a few hundred but becomes a problem as n grows. Query optimizers use this limit directly: exhaustive DP join ordering is disabled above a certain table count and replaced with a greedy or genetic algorithm. Staff engineers document the n threshold at which the switch occurs and the quality loss (suboptimal plan selection rate) introduced by the approximation, allowing informed trade-off decisions when the threshold needs adjustment.

### Junior → FAANG: The Last-Operation Insight as an Interview Key

Interval DP problems all share one insight: think about the last operation, not the first. For burst balloons, think about which balloon is burst last in the interval. For matrix chain, think about where the final multiplication between two groups occurs. For palindrome partitioning, think about which cut is the outermost. This "last operation" framing makes the subproblems independent and the recurrence clean.

Practice explaining this insight verbally for each problem. "For burst balloons, if balloon k is the last to burst in interval [l, r], then at the moment k is burst, l-1 and r+1 are its only remaining neighbors. So I gain `balloons[l-1] * balloons[k] * balloons[r+1]` coins. The left and right sub-intervals [l, k-1] and [k+1, r] were burst independently before k, so their optimal values are already computed in `dp[l][k-1]` and `dp[k+1][r]`." Being able to narrate this in 60 seconds is the goal.

For interviews, always fill the interval DP table by increasing length. Start with length 1 (trivially zero cost), then length 2, then length 3, up to the full length. This filling order ensures that when you compute `dp[i][j]`, all shorter sub-intervals are already filled.

### Senior @ FAANG: Interval DP in Query Optimization and Compiler Design

PostgreSQL makes this trade-off explicit and configurable, which makes it a good system to reason about. Its planner does exhaustive DP over join orders up to `geqo_threshold` relations (default 12) and switches to GEQO, a genetic algorithm, at or above that. The threshold is where an exponential search stops fitting in a planning budget measured in milliseconds. Note the shape of the curve: because the cost is exponential rather than polynomial, each additional relation roughly doubles the planning work, so there is no gentle degradation. The planner is fast, then it is not.

Understanding that shape is what lets you reason about moving the knob. Lowering the threshold caps planning time for mid-complexity queries at the cost of accepting a genetically-searched, possibly suboptimal join order, and a bad join order does not cost a few percent, it costs orders of magnitude, because it changes intermediate result sizes multiplicatively. Raising it buys better plans and risks spending more time planning a query than executing it. The trade-off is measurable rather than a matter of taste: look at the distribution of relation counts in your actual query mix, weigh planning time against execution time at each count, and set the threshold accordingly. Doing that well requires knowing why the threshold exists at all.

The burst balloons structure also appears in optimal binary search tree construction (Knuth's algorithm, which uses Knuth's optimization to reduce interval DP from O(n^3) to O(n^2)) and in Earley parsing for context-free grammars. Staff engineers who encounter a new interval-structured optimization problem should check whether Knuth's optimization applies: if the split point that is optimal for interval [i, j] is always between the optimal split points for [i, j-1] and [i+1, j], the inner loop can be bounded to run in amortized O(1) per cell rather than O(n), reducing the overall complexity from O(n^3) to O(n^2).
