## 73.14 Interview Pitfalls

### Pitfall 1: Seeding Only Some of the Base Cases

**Failure mode**: a "climbing stairs" solution that returns wrong answers because the recurrence looks back two cells but only one of the two starting cells was seeded. `dp[0]` gets set, `dp[1]` is left at Go's zero value, and every later cell inherits the hole. Nothing crashes. The function just quietly under-reports every result.

```go
// ❌ WRONG: Inconsistent base cases
func climbStairsBad(n int) int {
    if n <= 1 {
        return 1
    }

    dp := make([]int, n+1)
    dp[0] = 1  // Base: 1 way to reach step 0
    // BUG: Forgot dp[1] = 1!

    for i := 2; i <= n; i++ {
        dp[i] = dp[i-1] + dp[i-2]  // dp[1] is 0, wrong!
    }
    return dp[n]
}

// ✅ CORRECT: Both base cases defined
func climbStairsGood(n int) int {
    if n <= 1 {
        return 1
    }

    dp := make([]int, n+1)
    dp[0] = 1  // 1 way to be at ground
    dp[1] = 1  // 1 way to reach step 1

    for i := 2; i <= n; i++ {
        dp[i] = dp[i-1] + dp[i-2]
    }
    return dp[n]
}
```

### Pitfall 2: Storing a Slice Reference Instead of a Copy

**Failure mode**: an enumeration DP that caches or collects the working slice itself rather than a copy of it. The backtracking then mutates the same backing array in place, and every stored "answer" mutates with it. The classic symptom is a result set where all entries are identical, or identical to the final state of the working slice. This is the same aliasing bug that dominates backtracking code, and it is worth internalizing here because it is silent: the shapes and counts are right, only the contents are wrong.

```go
import "fmt"

// ❌ WRONG: Storing slice reference
func subsetSumBad(nums []int, target int) [][]int {
    memo := make(map[string][][]int)

    var dp func(idx, remaining int, current []int) [][]int
    dp = func(idx, remaining int, current []int) [][]int {
        key := fmt.Sprintf("%d_%d", idx, remaining)
        if cached, ok := memo[key]; ok {
            return cached
        }

        if remaining == 0 {
            return [][]int{current}  // BUG: current will be modified!
        }
        // ...
        memo[key] = result
        return result
    }
    return dp(0, target, []int{})
}

// ✅ CORRECT: Make copies before storing
func subsetSumGood(nums []int, target int) [][]int {
    memo := make(map[string][][]int)

    var dp func(idx, remaining int, current []int) [][]int
    dp = func(idx, remaining int, current []int) [][]int {
        key := fmt.Sprintf("%d_%d", idx, remaining)
        if cached, ok := memo[key]; ok {
            return cached
        }

        if remaining == 0 {
            // Make a COPY of current slice
            result := make([]int, len(current))
            copy(result, current)
            return [][]int{result}
        }
        // ...
        memo[key] = result
        return result
    }
    return dp(0, target, []int{})
}
```

**A second bug hides in both versions, and it is worth more than the first.** The memo key is `(idx, remaining)`, but the cached value embeds `current`, which is not in the key. Two different prefixes can arrive at the same `(idx, remaining)` and will then receive each other's answers, complete with the wrong prefix baked in. A memo key must cover every input the cached value depends on. Keyed on fewer dimensions than the state, it is not a cache, it is a wrong answer with good performance.

There are two honest ways out. Either cache *completions* rather than full paths, so the value genuinely depends only on `(idx, remaining)` and the caller prepends its own prefix, or drop the memo and accept plain backtracking, which is what enumeration problems usually want because the output is exponential anyway and there is nothing to amortize. Fix the copy and keep the broken key and you have traded a visible bug for an invisible one.

### Pitfall 3: Skipping the First Row and Column in 2D DP

**Failure mode**: an "edit distance" solution whose loops are fine but whose border is not. The recurrence reads `dp[i-1][j-1]`, `dp[i-1][j]`, and `dp[i][j-1]`, so row 0 and column 0 are read by every interior cell and are never written by the main loop. They must be seeded first. Left at Go's zero value, they claim it costs nothing to turn an empty string into a prefix of any length, and the error propagates through the whole table.

The tell is that the answer comes back too small. `editDistanceBad("horse", "ros")` returns 2 instead of 3, and `editDistanceBad("abc", "")` returns 0, confidently reporting that "abc" and the empty string are the same string.

```go
// ❌ WRONG: base cases never seeded (the loop order here is fine)
func editDistanceBad(word1, word2 string) int {
    m, n := len(word1), len(word2)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    // Forgot to initialize first row and column! They stay 0, which asserts
    // that "" -> word2[0:j] is free. Every interior cell reads that lie.

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                dp[i][j] = dp[i-1][j-1]
            } else {
                dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
            }
        }
    }
    return dp[m][n]  // Wrong, and always too small
}

// ✅ CORRECT: Initialize base cases first
func editDistanceGood(word1, word2 string) int {
    m, n := len(word1), len(word2)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    // Initialize: converting empty string
    for i := 0; i <= m; i++ {
        dp[i][0] = i  // Delete all chars from word1
    }
    for j := 0; j <= n; j++ {
        dp[0][j] = j  // Insert all chars to get word2
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                dp[i][j] = dp[i-1][j-1]
            } else {
                dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
            }
        }
    }
    return dp[m][n]
}
```

### Pitfall 4: Space Optimization Breaking When Order Matters

**Failure mode**: a 2D knapsack correctly collapsed to 1D, then iterated in the wrong direction. Processing capacity left-to-right lets `dp[w-weights[i]]` already contain item `i`, so the item gets taken again and again. The 0/1 knapsack silently becomes an unbounded knapsack. It returns a number, the number is larger than the true optimum, and nothing in the output announces that the constraint was dropped. This is the highest-frequency wrong-answer bug in all of DP, which is why the same rule appears in section 73.4 and again here.

```go
// ❌ WRONG: Left-to-right allows item reuse (unbounded knapsack)
func knapsack01Bad(weights, values []int, capacity int) int {
    dp := make([]int, capacity+1)

    for i := 0; i < len(weights); i++ {
        // BUG: Left-to-right means dp[w-weights[i]] might already
        // include current item!
        for w := weights[i]; w <= capacity; w++ {
            dp[w] = max(dp[w], dp[w-weights[i]]+values[i])
        }
    }
    return dp[capacity]  // Wrong: same item used multiple times
}

// ✅ CORRECT: Right-to-left ensures each item used at most once
func knapsack01Good(weights, values []int, capacity int) int {
    dp := make([]int, capacity+1)

    for i := 0; i < len(weights); i++ {
        // Right-to-left: dp[w-weights[i]] hasn't been updated yet
        // so it represents state WITHOUT current item
        for w := capacity; w >= weights[i]; w-- {
            dp[w] = max(dp[w], dp[w-weights[i]]+values[i])
        }
    }
    return dp[capacity]
}
```

### Pitfall 5: Leaking the Sentinel Instead of Reporting "Impossible"

**Failure mode**: a "coin change" solution that computes correctly but never translates its internal sentinel back into the contract the caller expects. Asked for the fewest coins making 3 out of `[2]`, it returns 2147483647. The DP is right. The return statement is not. This is the pitfall that survives interviews and reaches production, because every test case with a reachable amount passes.

```go
// ❌ WRONG: returns the sentinel to the caller
import "math"

func coinChangeBad(coins []int, amount int) int {
    dp := make([]int, amount+1) // dp[0] = 0 by zero value, which is correct

    for i := 1; i <= amount; i++ {
        dp[i] = math.MaxInt32
        for _, coin := range coins {
            // the != guard is right: it stops MaxInt32+1 from wrapping
            if coin <= i && dp[i-coin] != math.MaxInt32 {
                dp[i] = min(dp[i], dp[i-coin]+1)
            }
        }
    }

    // BUG: for an unreachable amount this hands back MaxInt32, a number that
    // looks like an answer and will be happily added to something downstream.
    return dp[amount]  // Should return -1 for impossible
}

// ✅ CORRECT: Use sentinel value, check impossible
func coinChangeGood(coins []int, amount int) int {
    dp := make([]int, amount+1)
    for i := 1; i <= amount; i++ {
        dp[i] = amount + 1  // Impossible sentinel (> any valid answer)
    }
    dp[0] = 0  // Base case: 0 coins for amount 0

    for i := 1; i <= amount; i++ {
        for _, coin := range coins {
            if coin <= i {
                dp[i] = min(dp[i], dp[i-coin]+1)
            }
        }
    }

    if dp[amount] > amount {
        return -1  // Impossible
    }
    return dp[amount]
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Partial base cases | Results too small, no crash | Seed one cell per lookback step |
| Unseeded 2D border | Answer too small, "" looks free | Fill row 0 and column 0 first |
| Slice reference in memo | Every stored answer identical | Always copy before caching |
| Wrong loop order | Dependencies read stale cells | Draw dependency arrows first |
| L-to-R in 0/1 knapsack | Item reused, answer too big | R-to-L for 0/1, L-to-R for unbounded |
| Sentinel leaked to caller | Returns MaxInt as an "answer" | Map sentinel to -1 before returning |
| Sentinel too large | Silent wrap to a huge negative | Use amount+1 or MaxInt/2, never MaxInt |

### Junior → FAANG: Converting Pitfalls Into Defensive Code Habits

The five pitfalls documented above map to five specific code-review checklist items. Before submitting any DP solution, verify each of these manually.

Pitfall 1 (inconsistent base cases): write base cases first, before the main loop. Commit to the convention that `dp[0]` means the empty case. For climbing stairs, `dp[0] = 1` means "one way to stand at the bottom without taking any steps," which is the correct interpretation even if it feels unnatural.

Pitfall 2 (slice reference in memoization): any time you store a slice in a map or append it to a results collection, ask "did I make a copy?" The safe patterns in Go are `append([]int{}, slice...)` for a shallow copy and `copy(dst, src)` for a pre-allocated destination. Using `result = append(result, path)` where `path` is a shared slice is always wrong.

Pitfall 3 (wrong loop order in 2D DP): draw the dependency arrows before writing the loop. For edit distance, cell (i, j) reads from (i-1, j-1), (i-1, j), and (i, j-1), which means you must process row 0 before row 1, and within each row, column 0 before column 1. If your loops follow this order, the dependencies are satisfied.

Pitfall 4 (L-to-R in 0/1 knapsack): if you cannot remember the direction rule, derive it. In 0/1 knapsack, you want `dp[w - weights[i]]` to represent the state before adding item i. If you iterate L-to-R, that cell has already been updated to include item i, so you get unbounded behavior. Iterating R-to-L uses the pre-update value, giving 0/1 semantics.

Pitfall 5 (zero vs impossible): the sentinel `amount + 1` works because any valid answer is at most `amount` (using all 1-coin coins). `math.MaxInt` does not work because adding 1 overflows. This is a subtle point worth committing to memory.

### Senior @ FAANG: Pitfall Analysis as a Code Review Framework

In code review for production DP implementations, these pitfalls translate to specific review checklist items that senior engineers apply systematically. A production PR containing a DP solution should receive a review comment for each of the following unless the code explicitly addresses it.

Base case initialization: verify that the base case initialization block is separate from the main loop, clearly commented, and tested by a unit test that passes in the base case inputs directly (n=0, empty string, zero capacity).

Memoization safety: if the implementation uses memoization with slice or map values, verify that returned values are copies (not references to internal cache state) and that the cache is not shared across concurrent goroutines without synchronization. A memoized DP function that is called from multiple goroutines without a mutex is a data race.

Loop order comment: every rolling-array or 1D-optimized DP should have a comment stating the dependency direction and explaining why the loop order is correct. This is the most commonly missing documentation in production DP code.

Overflow guards: for any DP recurrence that performs addition, verify that the sentinel value plus the maximum single-step increment does not overflow the integer type. With a 64-bit `int`, overflow is unlikely but not impossible in DP problems with multiplicative recurrences (matrix chain, burst balloons with large values), and because Go wraps silently rather than trapping, the failure surfaces as a nonsense answer rather than as an error.

### Junior → FAANG: Pitfalls as a Pre-Submit Checklist

The five pitfalls in this file translate to a 2-minute post-implementation checklist you can run before claiming your solution is finished. This checklist should become automatic before any DP interview.

Pitfall 1 (partial base cases): find the base case block. Your recurrence looks back k cells, so k starting cells must be seeded, not one. Pitfall 2 (slice aliasing): every slice you store in a map or append to a result set, is it a copy? Pitfall 3 (2D border): row 0 and column 0 are read by every interior cell and written by no loop. Are they seeded? Pitfall 4 (knapsack direction): is this 0/1 or unbounded? If 0/1, the capacity loop runs right-to-left. Pitfall 5 (sentinel leak): is the sentinel larger than any valid answer, safe to increment, and translated back to the caller's contract before returning?

Five checks, two minutes, and they cover the bugs that a compiler will never mention.

### Senior @ FAANG: Pitfall Analysis as a Hiring Signal

In bar-raiser interviews, the pitfalls listed in this file are the first things interviewers look for after a candidate claims their solution is complete. A candidate who has internalized this checklist will run it themselves before saying "I'm done," catching their own mistakes. A candidate who has not internalized it will wait for the interviewer to find the bugs.

The most telling pitfalls are the base case ones (1 and 3), because they reveal whether the candidate understands the table's semantics or is mechanically filling cells. A candidate who leaves a base case unseeded and is asked "what does `dp[0]` represent?" will either answer correctly and fix the bug on the spot (understanding) or be unable to answer at all (recall). The question is diagnostic precisely because it separates those two.

For code review, the pitfall analysis in this file maps to a "DP correctness rubric" that can be applied to any PR containing DP. Teams that adopt a formal DP review rubric catch these pitfalls at code review time rather than in production post-mortems, which is the correct tradeoff.

---
