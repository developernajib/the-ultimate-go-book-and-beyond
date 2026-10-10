## 73.1 Introduction to Dynamic Programming

### Fibonacci - The Classic Example

Fibonacci sequence computation is the canonical introduction to dynamic programming because it visually demonstrates both the problem of overlapping subproblems (the naive recursive tree recomputes the small values, `fib(1)` and `fib(2)`, exponentially many times) and the two DP solutions: memoization caches already-computed results for O(n) time with O(n) space, while tabulation fills an array iteratively and can be space-reduced to O(1) by keeping only the last two values.

```go
package dp

// FibonacciRecursive is naive recursive approach
// Time: O(2^n), Space: O(n)
func FibonacciRecursive(n int) int {
    if n <= 1 {
        return n
    }
    return FibonacciRecursive(n-1) + FibonacciRecursive(n-2)
}

// FibonacciMemo uses top-down memoization
// Time: O(n), Space: O(n)
func FibonacciMemo(n int) int {
    memo := make(map[int]int)
    return fibMemoHelper(n, memo)
}

func fibMemoHelper(n int, memo map[int]int) int {
    if n <= 1 {
        return n
    }

    if val, ok := memo[n]; ok {
        return val
    }

    memo[n] = fibMemoHelper(n-1, memo) + fibMemoHelper(n-2, memo)
    return memo[n]
}

// FibonacciDP uses bottom-up tabulation
// Time: O(n), Space: O(n)
func FibonacciDP(n int) int {
    if n <= 1 {
        return n
    }

    dp := make([]int, n+1)
    dp[0], dp[1] = 0, 1

    for i := 2; i <= n; i++ {
        dp[i] = dp[i-1] + dp[i-2]
    }

    return dp[n]
}

// FibonacciOptimized uses space-optimized DP
// Time: O(n), Space: O(1)
func FibonacciOptimized(n int) int {
    if n <= 1 {
        return n
    }

    prev2, prev1 := 0, 1
    for i := 2; i <= n; i++ {
        curr := prev1 + prev2
        prev2 = prev1
        prev1 = curr
    }

    return prev1
}
```

### Framework for DP Problems

Every DP problem reduces to the same five-step process: define what a subproblem's state captures, write the recurrence that expresses a larger problem in terms of smaller ones, anchor the recursion with base cases, choose a traversal order that ensures dependencies are resolved before they are needed, and identify which cell in the table holds the final answer. Applying this framework explicitly (before writing any code) prevents the common trap of jumping to implementation and discovering midway that the state definition cannot express the required information.

```go
// DP Problem-Solving Framework:
//
// 1. Define the state
//    - What variables describe a subproblem?
//    - dp[i] = the answer to subproblem involving first i elements
//
// 2. Define the recurrence relation
//    - How do we compute dp[i] from smaller subproblems?
//    - dp[i] = f(dp[i-1], dp[i-2], ...)
//
// 3. Define base cases
//    - What are the smallest subproblems we can solve directly?
//    - dp[0] = ?, dp[1] = ?
//
// 4. Determine the computation order
//    - Bottom-up: What order ensures all dependencies are computed?
//    - Top-down: Natural with recursion
//
// 5. Find the final answer
//    - Which dp[?] gives us the answer?
```

### Junior → FAANG: Using the Framework Out Loud

The five-step framework above is your interview script. Before writing any code, verbalize all five steps to the interviewer. This serves two purposes: it demonstrates structured thinking, and it surfaces errors in your understanding while there is still time to correct them without throwing away code.

The most common breakdown point for junior candidates is step 1: state definition. A state that is too coarse loses information needed by the recurrence. A state that is too fine creates an exponential number of states and eliminates the efficiency benefit. The test for a correct state definition is: given the state values, can you compute the answer to the corresponding subproblem without knowing how you got there? If yes, the state is sufficient. If you need to know the path taken to the current state, the state is incomplete.

The Fibonacci implementations above also demonstrate a Go-specific performance point. `FibonacciMemo` uses `map[int]int` for the cache, which involves hashing and pointer indirection. `FibonacciDP` uses a slice, which is direct indexed memory access. For integer-keyed DP tables where the key range is bounded, a slice is always faster and should be preferred in production Go. Only use maps when the key space is sparse or multi-dimensional.

### Senior @ FAANG: Framework Rigor and Production Correctness

The five-step framework is necessary but not sufficient for production-grade DP. Two additional steps belong in a senior engineer's working process.

Step 0: problem canonicalization. Before defining state, prove that the problem actually has optimal substructure by constructing a small counterexample and verifying the recurrence holds. Many interview problems that look like DP are actually greedy, and applying DP to a greedy problem produces correct results but at unnecessary cost. The canonical test: if you have the optimal solution for the full problem, does it necessarily contain the optimal solutions to its sub-problems? If yes, proceed with DP. If no, greedy or a different technique applies.

Step 6: overflow and boundary analysis. Every DP recurrence that involves addition or multiplication can overflow. In Go, `int` is 64-bit on the amd64 and arm64 platforms most services run on, but DP problems involving products of large values (matrix chain, burst balloons) can still overflow, and 64-bit overflow in Go wraps silently rather than panicking. Identify the maximum possible cell value analytically and decide up front whether `int` suffices or the problem needs `math/big` or a modular reduction, rather than discovering it from a wrong answer in testing. Note that `int64` is no help on a 64-bit platform where `int` is already 64 bits: the escalation is to arbitrary precision or to a modulus, not to a same-width named type.

The space optimization step (rolling arrays) is also a correctness risk, not just a performance improvement. Reducing from 2D to 1D requires verifying the read/write dependency direction, and the rule is the opposite of most people's first guess. When you collapse `dp[i][j]` onto a single row, each cell you overwrite destroys the row i-1 value that later cells might still need. So: if `dp[i][j]` reads a *smaller* column from the *previous* row (`dp[i-1][j-w]`, the 0/1 knapsack shape), iterate j **descending**, because a descending sweep has not yet touched the smaller columns and they still hold row i-1. If `dp[i][j]` reads a smaller column from the *current* row (`dp[i][j-w]`, the unbounded knapsack shape), iterate j **ascending**, because you want the already-updated row i value. Getting this backwards is the single most common DP bug: 0/1 knapsack iterated ascending silently becomes unbounded knapsack, reusing each item many times, and it still returns a plausible number. Document the dependency direction in the code comment whenever applying a rolling-array optimization.

### Junior → FAANG: Practicing the Five Steps Out Loud

The five-step framework is only useful if it becomes a spoken habit, not a silent mental checklist. In practice interviews, verbalize each step before writing the corresponding code. "My state is `dp[i]`, representing the minimum number of coins to make amount `i`." Pause. "My recurrence is `dp[i] = 1 + min over valid coins of dp[i - coin]`." Pause. "My base case is `dp[0] = 0`." This pacing is not slow: it is the pacing of a senior engineer who thinks before typing.

The most valuable practice drill: take any DP problem you have already solved and re-implement it with a different state definition. For coin change, try defining `dp[i]` as the last coin used to reach amount `i` and backtrack from `dp[target]` to reconstruct the path. This variant forces you to think about how the state and recurrence must change together, which is exactly what happens when an interviewer adds a follow-up constraint.

### Senior @ FAANG: Framework Extensions for Production Readiness

The five-step framework produces correct algorithms. Transforming a correct algorithm into a production-ready system requires three additional considerations that belong in every engineering design document for DP-based features.

Input contract: what input ranges does the algorithm guarantee correct results for? For example, coin change is correct only when all coin values are positive and the amount is non-negative. These are invariants that must be enforced at the API boundary, not assumed by the implementation.

Latency budget: given the input distribution (median, 95th percentile, 99th percentile), what is the expected table size and computation time? For a scheduler running 1000 times per second, a table fill that takes 10ms is budget-breaking. Document the profiled latency before shipping.

Degradation strategy: for inputs that exceed the safe table size (captured by the input contract), what does the system do? Return an error, apply a greedy approximation, or queue the request for offline processing? Having a documented degradation strategy prevents the silent "allocation too large" panics that DP systems produce when an adversarial or unexpected input arrives in production.
