## 73.11 Common Mistakes

### Mistake 1: Off-by-One in DP Array Size

DP arrays are typically sized `n+1` so that `dp[n]` represents the answer for an input of size `n` without any index adjustment. Allocating only `n` elements forces awkward `dp[n-1]` indexing and frequently masks subtle off-by-one errors in the loop bounds.

```go
// ❌ BAD: Wrong array size
func climbStairsBad(n int) int {
    dp := make([]int, n) // Should be n+1!
    dp[0], dp[1] = 1, 1
    for i := 2; i < n; i++ { // should be i <= n
        dp[i] = dp[i-1] + dp[i-2]
    }
    return dp[n-1] // off by one: this is the answer for n-1 stairs
}
// Two failure modes, and the loud one is the lucky one. For n < 2 the
// dp[1] assignment panics outright. For n >= 2 it returns quietly: it
// reports 5 for n=5, when the answer is 8. A panic gets fixed. A
// plausible wrong number ships.

// ✅ GOOD: Correct size
func climbStairsGood(n int) int {
    if n <= 1 {
        return 1
    }
    dp := make([]int, n+1)
    dp[0], dp[1] = 1, 1
    for i := 2; i <= n; i++ {
        dp[i] = dp[i-1] + dp[i-2]
    }
    return dp[n]
}
```

### Mistake 2: Forgetting the Sentinel (the Go-Specific Half of "Base Cases")

A DP recurrence is only correct when every cell starts from the right value, and Go's zero-initialization makes this trickier than it looks rather than easier. `make([]int, amount+1)` hands you a table of zeros. For coin change that means `dp[0] = 0`, the base case, is already correct for free. It also means every *other* cell starts at 0, and that is the bug: 0 is smaller than any real answer, so `min(dp[i], dp[i-coin]+1)` never replaces it and the function cheerfully returns 0 for every input.

This is why the mistake is worth stating precisely. The danger in Go is not the base case you forgot to write. It is the sentinel you forgot to write, because the zero value silently impersonates a valid, optimal answer.

```go
// ❌ BAD: no sentinel fill, so every cell starts at 0 and stays there
func coinChangeBad(coins []int, amount int) int {
    dp := make([]int, amount+1) // all zeros: dp[0]=0 is right, the rest are not

    for i := 1; i <= amount; i++ {
        for _, coin := range coins {
            if coin <= i {
                // dp[i] is 0, and 0 <= anything, so min() always keeps it
                dp[i] = min(dp[i], dp[i-coin]+1)
            }
        }
    }

    return dp[amount] // always 0, for every input
}

// ✅ GOOD: sentinel everywhere, then the base case carved back out
func coinChangeGood(coins []int, amount int) int {
    dp := make([]int, amount+1)
    for i := range dp {
        dp[i] = amount + 1 // sentinel: larger than any real answer,
                           // and safe to +1 without overflowing
    }
    dp[0] = 0 // base case, stated explicitly rather than left to the zero value

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

### Junior → FAANG: Turning Mistakes Into a Pre-Flight Checklist

The two mistakes documented above (off-by-one array size and an unset sentinel) are behind a large share of first-attempt wrong answers on DP problems, and both are invisible to the compiler. Convert them into a checklist that you run before submitting any DP solution.

Check 1: is the array sized `n+1`? If your problem involves items indexed 1 through n, the table needs indices 0 through n, requiring size n+1. The `dp[0]` entry typically holds the base case (empty prefix, zero items, zero capacity).

Check 2: are all base cases set explicitly? Write them out before the main loop. For coin change: `dp[0] = 0`. For LCS: `dp[0][j] = 0` for all j, `dp[i][0] = 0` for all i. For edit distance: `dp[i][0] = i` and `dp[0][j] = j`. If any base case is missing, the entire table is built on uninitialized values.

Check 3: is the sentinel value correct? For minimization problems, the sentinel for "impossible" should be `amount + 1` or `math.MaxInt / 2` (never `math.MaxInt`, because `dp[i-coin] + 1` then overflows). For maximization problems, the sentinel is 0 or `math.MinInt / 2`.

Be clear about what "overflow" means in Go, because the word suggests a louder failure than you get: integer overflow does not panic. `math.MaxInt + 1` wraps silently to `math.MinInt`. So a `math.MaxInt` sentinel does not blow up, it quietly becomes the most negative number available, wins every `min` comparison it enters, and hands back a hugely negative answer as if it were optimal. Halving the sentinel (`math.MaxInt / 2`) leaves headroom to add to it without wrapping, which is the entire reason for the idiom.

Check 4 (post-code): trace through one non-trivial example by hand to verify the table produces the expected output before trusting the algorithm.

### Senior @ FAANG: Systematic Error Prevention in Production DP

The mistakes documented above are not just interview pitfalls. They produce silent correctness bugs in production systems. An off-by-one in a production bitrate allocator or pricing optimizer may not crash but will silently produce suboptimal results for a small fraction of inputs, the kind of bug that takes weeks to surface and diagnose.

Production DP code should include three categories of defenses beyond what the interview version requires. First, input validation: check that all input values are within the expected range before allocating the DP table. A negative coin value, a weight larger than the capacity, or a string containing characters outside the expected alphabet should all return an error (or panic with a clear message) rather than silently producing wrong results.

Second, invariant assertions: where the DP correctness depends on a loop invariant (e.g., "when we reach column w, dp[w] represents the optimal value for capacity exactly w using items 0 through i"), a debug-mode assertion that checks the invariant on a representative sample of states allows fast detection of regression when the code is modified.

Third, property-based tests: for DP functions with well-defined mathematical properties (e.g., the knapsack solution can never exceed the sum of all values, the LCS length can never exceed min(m, n)), generate random inputs and verify the properties hold without manually computing the expected output. This catches off-by-one errors and sentinel value bugs that specific hand-chosen test cases might miss.

### Junior → FAANG: Converting Mistakes Into Pre-Submit Habits

Both mistakes (off-by-one array size and an unset sentinel) are so common because they are invisible until you test. The best defense is a pre-submit ritual: before running your solution, read it in order and answer four questions. One: is every array sized `n+1` where `n` is the problem size? Two: are all base cases written before the main loop? Three: is the sentinel value safe to increment by 1 without overflow? Four: does a trace through the smallest non-trivial input produce the expected answer?

For Go specifically: `make([]int, n+1)` initializes all elements to zero. For minimization DP, zero is a valid answer (zero coins needed for amount 0), so you must explicitly overwrite non-base-case entries with your sentinel before the main loop. Missing this initialization step means the loop computes `min(sentinel, dp[i-coin] + 1)` where `sentinel` is 0 (the default), which is smaller than any valid answer and corrupts the result. This is a subtler bug than a missing base case and is harder to diagnose from wrong output alone.

### Senior @ FAANG: Common Mistake Prevention in Code Review

The mistakes documented in this file map directly to code review checklist items for DP PRs. A standardized DP code review checklist for a production team should include these checks, applied systematically before approving any DP implementation.

Array sizing check: verify that every `make([]int, n)` in a DP implementation is intentional. If `n` represents the problem size and the DP uses 1-indexed states, the size should be `n+1`. If it is `n`, document why explicitly.

Base case isolation: verify that base case initialization is in a clearly separated block (either a `for` loop before the main loop, or an explicit assignment block with a comment). Never accept base case initialization mixed into the main loop body.

Sentinel analysis: verify that the sentinel value cannot overflow when incremented by the maximum single-step cost. For coin change, the sentinel `amount + 1` is safe because the maximum cost per step is 1. For matrix chain, where the cost per step can be the product of large dimensions, compute the maximum possible table value and verify the sentinel is larger but still within `int64` range.

Property test requirement: require at least one property-based test for any DP function that handles more than trivial inputs. The Go `testing/quick` package or `pgregory.net/rapid` library make this straightforward to add and provides coverage that hand-written tests cannot achieve.

---
