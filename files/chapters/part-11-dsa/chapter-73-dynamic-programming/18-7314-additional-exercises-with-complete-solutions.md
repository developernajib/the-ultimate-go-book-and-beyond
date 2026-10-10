## 73.16 Additional Exercises with Complete Solutions

### Exercise 5: Perfect Squares

**Problem:** Given an integer n, return the least number of perfect square numbers that sum to n.

**Solution:**

```go
package main

import "math"

// NumSquares finds minimum perfect squares summing to n
// LeetCode 279: Perfect Squares
// Time: O(n * sqrt(n)), Space: O(n)
func NumSquares(n int) int {
    // dp[i] = minimum perfect squares summing to i
    dp := make([]int, n+1)
    for i := range dp {
        dp[i] = math.MaxInt32
    }
    dp[0] = 0

    // Precompute perfect squares up to n
    squares := []int{}
    for i := 1; i*i <= n; i++ {
        squares = append(squares, i*i)
    }

    for i := 1; i <= n; i++ {
        for _, sq := range squares {
            if sq > i {
                break
            }
            dp[i] = min(dp[i], dp[i-sq]+1)
        }
    }

    return dp[n]
}

// NumSquaresBFS uses BFS (often faster in practice)
func NumSquaresBFS(n int) int {
    if n <= 0 {
        return 0
    }

    // Precompute squares
    squares := []int{}
    for i := 1; i*i <= n; i++ {
        squares = append(squares, i*i)
    }

    // BFS level = number of squares used
    queue := []int{n}
    visited := make(map[int]bool)
    visited[n] = true
    level := 0

    for len(queue) > 0 {
        level++
        size := len(queue)

        for i := 0; i < size; i++ {
            curr := queue[i]

            for _, sq := range squares {
                next := curr - sq
                if next == 0 {
                    return level
                }
                if next > 0 && !visited[next] {
                    visited[next] = true
                    queue = append(queue, next)
                }
            }
        }
        queue = queue[size:]
    }

    return level
}

// NumSquaresMath uses Lagrange's four-square theorem
func NumSquaresMath(n int) int {
    // Lagrange: Every positive integer can be expressed as sum of 4 squares
    // Check if n is perfect square: 1 square
    // Check if n = a² + b²: 2 squares
    // Check if n = 4^k(8m+7): 4 squares (Legendre's three-square theorem)
    // Otherwise: 3 squares

    isSquare := func(x int) bool {
        s := int(math.Sqrt(float64(x)))
        return s*s == x
    }

    if isSquare(n) {
        return 1
    }

    // Check for 2 squares
    for i := 1; i*i <= n; i++ {
        if isSquare(n - i*i) {
            return 2
        }
    }

    // Check for 4 squares (n = 4^k(8m+7))
    for n%4 == 0 {
        n /= 4
    }
    if n%8 == 7 {
        return 4
    }

    return 3
}
// Note: Go 1.21+ provides builtin min() and max()
```

### Exercise 6: Decode Ways

**Problem:** Given a string of digits, count ways to decode it (A=1, B=2, ..., Z=26).

**Solution:**

```go
package main

// NumDecodings counts ways to decode digit string
// LeetCode 91: Decode Ways
// Time: O(n), Space: O(1)
func NumDecodings(s string) int {
    if len(s) == 0 || s[0] == '0' {
        return 0
    }

    n := len(s)

    // dp[i] = ways to decode s[0:i]
    // Space optimized: only need dp[i-1] and dp[i-2]
    prev2 := 1 // dp[i-2]: ways to decode empty string
    prev1 := 1 // dp[i-1]: ways to decode s[0:1]

    for i := 1; i < n; i++ {
        curr := 0

        // Single digit decode (1-9)
        if s[i] != '0' {
            curr += prev1
        }

        // Two digit decode (10-26)
        twoDigit := (s[i-1]-'0')*10 + (s[i] - '0')
        if s[i-1] != '0' && twoDigit >= 10 && twoDigit <= 26 {
            curr += prev2
        }

        prev2 = prev1
        prev1 = curr
    }

    return prev1
}

// NumDecodingsWithStar handles '*' wildcard
// LeetCode 639: Decode Ways II
func NumDecodingsWithStar(s string) int {
    const MOD = 1000000007
    n := len(s)
    if n == 0 {
        return 0
    }

    // dp[i] = ways to decode s[0:i]
    dp := make([]int, n+1)
    dp[0] = 1

    // First character
    if s[0] == '*' {
        dp[1] = 9 // 1-9
    } else if s[0] != '0' {
        dp[1] = 1
    }

    for i := 2; i <= n; i++ {
        // Single digit
        if s[i-1] == '*' {
            dp[i] = (dp[i] + 9*dp[i-1]) % MOD
        } else if s[i-1] != '0' {
            dp[i] = (dp[i] + dp[i-1]) % MOD
        }

        // Two digits
        if s[i-2] == '*' {
            if s[i-1] == '*' {
                // ** can be 11-19, 21-26 = 15 combinations
                dp[i] = (dp[i] + 15*dp[i-2]) % MOD
            } else if s[i-1] <= '6' {
                // *0-*6: 10,20 or 11-16, 21-26 = 2 options
                dp[i] = (dp[i] + 2*dp[i-2]) % MOD
            } else {
                // *7-*9: only 17,18,19 valid = 1 option
                dp[i] = (dp[i] + dp[i-2]) % MOD
            }
        } else if s[i-2] == '1' {
            if s[i-1] == '*' {
                dp[i] = (dp[i] + 9*dp[i-2]) % MOD // 11-19
            } else {
                dp[i] = (dp[i] + dp[i-2]) % MOD // 10-19
            }
        } else if s[i-2] == '2' {
            if s[i-1] == '*' {
                dp[i] = (dp[i] + 6*dp[i-2]) % MOD // 21-26
            } else if s[i-1] <= '6' {
                dp[i] = (dp[i] + dp[i-2]) % MOD // 20-26
            }
        }
    }

    return dp[n]
}
```

### Exercise 7: Interleaving String

**Problem:** Check if s3 is formed by interleaving s1 and s2.

**Solution:**

```go
package main

// IsInterleave checks if s3 is interleaving of s1 and s2
// LeetCode 97: Interleaving String
// Time: O(m*n), Space: O(n)
func IsInterleave(s1 string, s2 string, s3 string) bool {
    m, n := len(s1), len(s2)
    if m+n != len(s3) {
        return false
    }

    // dp[j] = can we form s3[0:i+j] using s1[0:i] and s2[0:j]?
    dp := make([]bool, n+1)
    dp[0] = true

    // Initialize: using only s2
    for j := 1; j <= n; j++ {
        dp[j] = dp[j-1] && s2[j-1] == s3[j-1]
    }

    for i := 1; i <= m; i++ {
        // Using only s1 up to i
        dp[0] = dp[0] && s1[i-1] == s3[i-1]

        for j := 1; j <= n; j++ {
            // s3[i+j-1] must match either s1[i-1] or s2[j-1]
            dp[j] = (dp[j] && s1[i-1] == s3[i+j-1]) ||
                    (dp[j-1] && s2[j-1] == s3[i+j-1])
        }
    }

    return dp[n]
}

// IsInterleave2D shows the full 2D DP
func IsInterleave2D(s1 string, s2 string, s3 string) bool {
    m, n := len(s1), len(s2)
    if m+n != len(s3) {
        return false
    }

    // dp[i][j] = can form s3[0:i+j] from s1[0:i] and s2[0:j]?
    dp := make([][]bool, m+1)
    for i := range dp {
        dp[i] = make([]bool, n+1)
    }
    dp[0][0] = true

    // Initialize first row (only s2)
    for j := 1; j <= n; j++ {
        dp[0][j] = dp[0][j-1] && s2[j-1] == s3[j-1]
    }

    // Initialize first column (only s1)
    for i := 1; i <= m; i++ {
        dp[i][0] = dp[i-1][0] && s1[i-1] == s3[i-1]
    }

    // Fill the table
    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            // Take from s1: s1[i-1] must match s3[i+j-1]
            fromS1 := dp[i-1][j] && s1[i-1] == s3[i+j-1]
            // Take from s2: s2[j-1] must match s3[i+j-1]
            fromS2 := dp[i][j-1] && s2[j-1] == s3[i+j-1]
            dp[i][j] = fromS1 || fromS2
        }
    }

    return dp[m][n]
}
```

### Exercise 8: Russian Doll Envelopes (2D LIS)

**Problem:** Given envelopes with (width, height), find maximum envelopes that can be Russian-dolled.

**Solution:**

```go
package main

import "sort"

// MaxEnvelopes finds maximum Russian doll envelopes
// LeetCode 354: Russian Doll Envelopes
// Time: O(n log n), Space: O(n)
func MaxEnvelopes(envelopes [][]int) int {
    if len(envelopes) == 0 {
        return 0
    }

    // Sort by width ascending, height descending (for same width)
    sort.Slice(envelopes, func(i, j int) bool {
        if envelopes[i][0] == envelopes[j][0] {
            return envelopes[i][1] > envelopes[j][1] // Height descending
        }
        return envelopes[i][0] < envelopes[j][0] // Width ascending
    })

    // Now find LIS on heights
    // Why height descending for same width?
    // Prevents using two envelopes with same width in same sequence

    heights := make([]int, len(envelopes))
    for i, env := range envelopes {
        heights[i] = env[1]
    }

    return lengthOfLIS(heights)
}

// lengthOfLIS using binary search - O(n log n)
func lengthOfLIS(nums []int) int {
    tails := []int{}

    for _, num := range nums {
        idx := lowerBound(tails, num)
        if idx == len(tails) {
            tails = append(tails, num)
        } else {
            tails[idx] = num
        }
    }

    return len(tails)
}

func lowerBound(arr []int, target int) int {
    left, right := 0, len(arr)
    for left < right {
        mid := left + (right-left)/2
        if arr[mid] < target {
            left = mid + 1
        } else {
            right = mid
        }
    }
    return left
}

// MaxEnvelopesDP2 shows the O(n^2) DP solution. It checks both dimensions
// explicitly, so unlike MaxEnvelopes it does not depend on the tie-break.
// Note both functions sort in place and therefore reorder the caller's slice.
func MaxEnvelopesDP2(envelopes [][]int) int {
    n := len(envelopes)
    if n == 0 {
        return 0
    }

    // Sort by width, then height
    sort.Slice(envelopes, func(i, j int) bool {
        if envelopes[i][0] == envelopes[j][0] {
            return envelopes[i][1] < envelopes[j][1]
        }
        return envelopes[i][0] < envelopes[j][0]
    })

    // dp[i] = max chain ending with envelope i
    dp := make([]int, n)
    for i := range dp {
        dp[i] = 1
    }

    maxLen := 1
    for i := 1; i < n; i++ {
        for j := 0; j < i; j++ {
            // Envelope j can fit in envelope i
            if envelopes[j][0] < envelopes[i][0] &&
               envelopes[j][1] < envelopes[i][1] {
                if dp[j]+1 > dp[i] {
                    dp[i] = dp[j] + 1
                }
            }
        }
        if dp[i] > maxLen {
            maxLen = dp[i]
        }
    }

    return maxLen
}
```

### Junior → FAANG: Reducing 2D Problems to 1D Algorithms

Exercise 8 (Russian Doll Envelopes) is the canonical example of problem reduction: a 2D containment problem reduces to a 1D LIS problem through a sorting trick. The sort order (width ascending, height descending for equal widths) is the key insight. The descending sort on height for equal widths ensures that two envelopes with the same width cannot both appear in the same LIS of heights, preserving the "strictly fit inside" property.

This kind of reduction is a high-value interview skill because it shows creative problem decomposition. Practice narrating it: "I observe that the containment constraint is equivalent to a 2D order relationship. By sorting strategically, I can reduce this to a 1D problem I already know how to solve." The word "reduce" is the signal interviewers listen for.

The two solutions to Exercise 8 differ in how much the sort has to do for them, and the contrast is the lesson. `MaxEnvelopesDP2`, the O(n^2) version, re-checks both dimensions strictly at every pair, so it only needs width-ascending order and does not care how ties are broken. `MaxEnvelopes`, the O(n log n) version, has thrown one dimension away by the time it runs LIS on heights alone, so the tie-break is the only thing standing between it and a wrong answer. That is why equal widths must be sorted by height *descending*: it makes the heights of an equal-width group strictly decreasing, so LIS can never pick two of them, which is exactly the "same width does not nest" rule the reduction would otherwise lose. Faster algorithm, more load-bearing preconditions.

For Exercise 6, trace `"201"` by hand. There are three candidate splits and only one survives: `[2][0][1]` dies because `0` alone decodes to nothing, `[2][01]` dies because `01` has a leading zero and is not 1, and `[20][1]` gives T followed by A. So `NumDecodings("201") == 1`, and the single valid decoding is "TA". Zeros are the whole difficulty of this problem: a `0` is never a character on its own and is only legal as the second digit of `10` or `20`.

### Senior @ FAANG: Problem Reduction as an Engineering Principle

The Russian Doll problem illustrates a broader principle that staff-level engineers apply constantly: reduce an unfamiliar problem to a familiar one. This is not just an interview technique. It is the foundation of effective software reuse. When a new business problem arrives that looks unique, the first engineering question is always "what known problem does this most closely resemble, and what transformation reduces the new problem to the known one?"

For production systems, problem reductions come with caveats. The sort step in Russian Doll Envelopes changes the problem's structure. If the input arrives in a streaming fashion and cannot be sorted up front, the reduction breaks down. In streaming contexts, a different approach (online longest chain data structure, perhaps using a balanced BST to maintain the candidate set) is required. Staff engineers evaluate whether the reduction's preconditions are satisfied by the production context, not just whether the algorithm is theoretically correct.

The Perfect Squares mathematical solution demonstrates another staff-level concern: when a closed form exists, it usually dominates the DP, here O(sqrt(n)) against O(n * sqrt(n)), with no table to allocate and no sentinel to get wrong. It leans on two number-theoretic facts rather than on a recurrence. Lagrange's four-square theorem says the answer is never more than 4, which bounds the whole problem. Legendre's three-square theorem says exactly which numbers need all 4: those of the form 4^k(8m+7), which is the `n /= 4` loop followed by the `n%8 == 7` test in the code. Everything else falls out by elimination: 1 if n is a perfect square, 2 if it splits into two, otherwise 3. Recognizing that this exists and naming it as a follow-up is the right interview behavior. Deriving Legendre's condition at the whiteboard is not the expectation.

### Junior → FAANG: Using Complete Solutions as Reverse-Engineering Exercises

The complete solutions in this file should not be read passively. For each exercise, read the problem statement, close this file, implement your own solution, and then compare against the reference implementation line by line. Focus the comparison on three things: where your state definition differs (if it does), whether your recurrence handles the same cases in the same order, and whether your loop bounds and initialization match.

For Exercise 8 (Russian Doll Envelopes), the sort order (descending height for equal widths) is the insight that enables the reduction to LIS. If your sort order was different, trace through a 4-envelope example with two equal widths to see why the ascending-height sort produces duplicate counting and the descending-height sort does not. Understanding why the sort order matters is more valuable than remembering the correct order.

For Exercise 5 (Perfect Squares), practice the BFS approach as a second implementation. BFS level = number of squares used is an elegant interpretation: each BFS level represents adding one more perfect square to the combination. The BFS runs until it reaches 0, and the level at which 0 is reached is the answer. Implementing the same problem with two completely different algorithms (DP and BFS) and verifying they produce identical results builds deep understanding.

### Senior @ FAANG: Problem Reduction as a Staff Engineering Core Competency

Russian Doll Envelopes exemplifies the most important staff engineering skill in the algorithms domain: recognizing that a new problem is a disguised version of a known problem, and finding the transformation that reveals the disguise. This skill transfers directly to system design: recognizing that a new business requirement is a disguised resource allocation problem (knapsack), or a disguised scheduling problem (LIS), allows reusing existing infrastructure rather than building bespoke solutions.

The transformation for Russian Doll Envelopes (sort + project to 1D) is a two-step reduction. Production reductions are often multi-step and involve data transformations, normalization, and dimension elimination. Staff engineers who practice multi-step reductions on algorithm problems develop the intuition to apply the same multi-step thinking to system design problems, where the "reduction" might involve denormalizing a database schema, pre-aggregating a time series, or projecting a high-dimensional feature space to a lower-dimensional one that enables a known algorithm to apply.

---
