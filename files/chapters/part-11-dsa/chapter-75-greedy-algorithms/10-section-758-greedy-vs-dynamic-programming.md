## 75.8 Greedy vs Dynamic Programming

One of the most important skills in algorithm interviews is knowing whether a problem can be solved greedily or requires dynamic programming. Both techniques rely on optimal substructure, but greedy additionally requires the greedy choice property, the guarantee that making the locally best decision never needs to be revisited. When that property holds, greedy is preferred because it is simpler and often faster. When it does not hold, as with arbitrary coin denominations or the 0/1 knapsack, greedy produces incorrect results and you must use DP to explore all possible choices. The code below contrasts both approaches on the coin change problem to make this distinction concrete.

```go
// When Greedy Works vs When DP is Needed

// GREEDY WORKS, BUT ONLY FOR CANONICAL COIN SYSTEMS such as US denominations
// (1, 5, 10, 25). "Canonical" simply means: for every amount, the greedy choice
// happens to be optimal. It is a property you must verify for the specific value
// set, not something greedy earns on its own.
//
// Do not reach for the folklore justification "each coin is a multiple of the
// smaller ones." That is false for US coins (25 is not a multiple of 10) even
// though greedy is optimal for them. Divisibility is sufficient but not
// necessary, so the rule rejects working systems and teaches the wrong test.
func CoinChangeGreedy(coins []int, amount int) int {
    // Sort descending. Note this mutates the caller's slice.
    slices.SortFunc(coins, func(a, b int) int {
        return cmp.Compare(b, a)
    })

    count := 0
    for _, coin := range coins {
        count += amount / coin
        amount %= coin
    }

    if amount > 0 {
        return -1 // Can't make exact change with these denominations.
    }
    return count
}

// GREEDY FAILS: Coin Change with arbitrary denominations (e.g., 1, 3, 4)
// Example: amount=6, greedy gives 4+1+1=3 coins, optimal is 3+3=2 coins
// Need DP for this:
func CoinChangeDP(coins []int, amount int) int {
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

// When to use Greedy:
// 1. Activity Selection - earliest finish time
// 2. Fractional Knapsack - highest value/weight ratio
// 3. Huffman Coding - combine lowest frequencies
// 4. Prim's/Kruskal's MST - minimum edge
// 5. Dijkstra - shortest current distance

// When to use DP:
// 1. 0/1 Knapsack - can't take fractional items
// 2. Longest Common Subsequence
// 3. Edit Distance
// 4. Coin Change with arbitrary denominations
// 5. Problems where local optimum != global optimum
```

### Junior → FAANG: Making the Greedy vs. DP Decision in Real Time

The greedy vs. DP question is the most important decision in algorithm interviews, and the ability to make it quickly and confidently is a top-band signal. Build a two-step mental test. First: can I make a commitment at each step that I will never need to undo? If yes, greedy is a candidate. Second: can I construct a counterexample where the greedy choice leads to a suboptimal result? If yes, use DP.

For the coin change problem specifically, the honest answer is shorter than the folklore. If the interviewer hands you arbitrary denominations, use DP. Greedy is optimal only for *canonical* systems, and whether a system is canonical is not something you can eyeball.

You will see the rule "if each coin is a multiple of the previous one, greedy works." The implication is true, but it is only one direction, and the gap matters. US coins are the counterexample: 25 is not a multiple of 10, so the rule says "use DP," yet greedy is optimal for every amount. Treat divisibility as a sufficient condition you can sometimes exploit, never as the test for whether greedy applies.

Deciding canonicity properly is a real algorithm, not a three-second check (Pearson's algorithm does it in O(n^3) for n denominations, by proving that if any counterexample exists then a small one exists, and then checking that bounded range). The practical version, and a genuinely good thing to say aloud in an interview: "I would settle this by running greedy against a DP brute force over a bounded range of amounts rather than by inspecting the denominations." That is what an engineer does. Claiming a pattern from the shape of the numbers is what a candidate does right before they get a counterexample handed to them.

Practice paired problems: solve the fractional knapsack greedily and the 0/1 knapsack with DP, then explain in one sentence why the same greedy strategy that works for one fails for the other. "In fractional knapsack I can always take a partial item to fill remaining capacity, so the greedy ratio choice is never regretted. In 0/1 knapsack, taking an item is all-or-nothing, so a high-ratio item might waste capacity that multiple lower-ratio items could fill." That sentence is the exchange argument, and saying it clearly signals top-quartile preparation.

### Senior @ FAANG: Hybrid Greedy-DP Algorithms and Their Production Use Cases

The binary framing of "greedy or DP" is an interview simplification. Many production algorithms combine greedy heuristics with DP verification or use greedy initialization to accelerate DP. Understanding hybrid approaches is a staff-level knowledge point.

**Greedy-initialized DP.** In scheduling problems where the input is large but the optimal solution is close to the greedy solution, a practical approach is to run the greedy algorithm first, then use DP to check whether small perturbations improve the result. Greedy supplies a good incumbent solution and a bound, and the DP or local search only has to beat it, which prunes aggressively. The same shape shows up in branch and bound, where a greedy warm start is what makes the pruning effective.

For a feedback-driven analogue in Go itself, look at the GC pacer, which decides when to start a collection cycle so that the heap lands near the `GOGC` target. It is worth being precise about what it is and is not: the pacer is a proportional controller that adjusts its estimate from measured allocation and scan rates each cycle. It is not dynamic programming and computes no optimum. It is a control loop reacting to error. The transferable idea is the same one this chapter keeps returning to, though: a cheap local rule plus a measured correction signal, deployed where a proof of optimality is unavailable and would not be worth its cost anyway.

**Approximation algorithms with greedy cores.** Many NP-hard optimization problems (vertex cover, set cover, bin packing) have polynomial-time approximation algorithms with greedy cores and DP or linear programming verification. For example, the greedy set cover algorithm achieves an O(log n) approximation ratio, and this bound is tight (no polynomial algorithm does better unless P=NP). A staff engineer proposing to use greedy set cover in a feature flag targeting system needs to state this approximation ratio, explain what it means for the business metric (within a factor of log n of optimal targeting efficiency), and design the system to be robust to that suboptimality.

**Governance of algorithm selection.** At the platform level, the greedy vs. DP decision is not made once per problem: it is revisited as the input distribution and problem size change. A scheduling system that started with a greedy algorithm when n was small may need to switch to DP as n grows, or may need to switch from DP to greedy approximation when n grows so large that DP becomes infeasible. Building the system to support this migration (by abstracting the algorithm behind an interface, so the implementation can be swapped without changing the API) is a staff-level design concern. In Go, this is done with an interface like `type Scheduler interface { Schedule(jobs []Job) []Assignment }` so the greedy and DP implementations are interchangeable.
