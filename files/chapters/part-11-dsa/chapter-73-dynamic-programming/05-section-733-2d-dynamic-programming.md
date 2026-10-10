## 73.3 2D Dynamic Programming

### Unique Paths

In a grid where movement is restricted to right and down, every cell can only be reached from the cell above or the cell to the left, making the number of paths to each cell the sum of paths to those two predecessors. The 2D table can be compressed to a 1D rolling array because each row only depends on the previous row's values.

```go
// UniquePaths counts paths in a grid from top-left to bottom-right
// LeetCode 62: Unique Paths
// Time: O(m*n), Space: O(n)
func UniquePaths(m int, n int) int {
    // dp[i][j] = number of paths to reach (i, j)
    // dp[i][j] = dp[i-1][j] + dp[i][j-1]
    dp := make([]int, n)
    for i := range dp {
        dp[i] = 1
    }

    for i := 1; i < m; i++ {
        for j := 1; j < n; j++ {
            dp[j] += dp[j-1]
        }
    }

    return dp[n-1]
}

// UniquePathsWithObstacles handles obstacles
// LeetCode 63: Unique Paths II
func UniquePathsWithObstacles(obstacleGrid [][]int) int {
    m, n := len(obstacleGrid), len(obstacleGrid[0])
    if obstacleGrid[0][0] == 1 {
        return 0
    }

    dp := make([]int, n)
    dp[0] = 1

    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            if obstacleGrid[i][j] == 1 {
                dp[j] = 0
            } else if j > 0 {
                dp[j] += dp[j-1]
            }
        }
    }

    return dp[n-1]
}

// MinPathSum finds minimum sum path
// LeetCode 64: Minimum Path Sum
func MinPathSum(grid [][]int) int {
    m, n := len(grid), len(grid[0])
    dp := make([]int, n)

    dp[0] = grid[0][0]
    for j := 1; j < n; j++ {
        dp[j] = dp[j-1] + grid[0][j]
    }

    for i := 1; i < m; i++ {
        dp[0] += grid[i][0]
        for j := 1; j < n; j++ {
            dp[j] = min(dp[j], dp[j-1]) + grid[i][j]
        }
    }

    return dp[n-1]
}
```

### Longest Common Subsequence

The LCS problem builds a 2D table where `dp[i][j]` stores the length of the longest common subsequence of the first `i` characters of `text1` and the first `j` characters of `text2`. When characters match, the solution extends the diagonal value. When they differ, it inherits the best result from either skipping a character in `text1` or `text2`. The space-optimized version exploits the fact that each row only reads from the immediately preceding row, so two alternating arrays suffice in place of the full matrix.

```go
// LongestCommonSubsequence finds LCS length
// LeetCode 1143: Longest Common Subsequence
// Time: O(m*n), Space: O(m*n) for the full table.
// See LCSSpaceOptimized below for the O(min(m,n)) two-row version.
func LongestCommonSubsequence(text1 string, text2 string) int {
    m, n := len(text1), len(text2)

    // dp[i][j] = LCS of text1[0:i] and text2[0:j]
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if text1[i-1] == text2[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1
            } else {
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
            }
        }
    }

    return dp[m][n]
}

// LCSSpaceOptimized keeps two rows instead of the full table.
// Time: O(m*n), Space: O(min(m,n)) after the swap below makes n the shorter side.
// Returns the LENGTH only: the discarded rows are exactly the information
// a backtrack would need, so use FindLCS if you need the string itself.
func LCSSpaceOptimized(text1 string, text2 string) int {
    m, n := len(text1), len(text2)
    if m < n {
        text1, text2 = text2, text1
        m, n = n, m
    }

    prev := make([]int, n+1)
    curr := make([]int, n+1)

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if text1[i-1] == text2[j-1] {
                curr[j] = prev[j-1] + 1
            } else {
                curr[j] = max(prev[j], curr[j-1])
            }
        }
        prev, curr = curr, prev
    }

    return prev[n]
}

// FindLCS returns the actual LCS string (one of possibly many valid answers).
// Needs the full table to backtrack through, so Space: O(m*n).
func FindLCS(text1 string, text2 string) string {
    m, n := len(text1), len(text2)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if text1[i-1] == text2[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1
            } else {
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
            }
        }
    }

    // Backtrack to find LCS
    lcs := make([]byte, dp[m][n])
    idx := dp[m][n] - 1
    i, j := m, n

    for i > 0 && j > 0 {
        if text1[i-1] == text2[j-1] {
            lcs[idx] = text1[i-1]
            idx--
            i--
            j--
        } else if dp[i-1][j] > dp[i][j-1] {
            i--
        } else {
            j--
        }
    }

    return string(lcs)
}
```

### Edit Distance

Edit distance (Levenshtein distance) quantifies how many single-character insertions, deletions, or substitutions are needed to transform one string into another, a metric used in spell-checkers, diff tools, and DNA sequence alignment. The recurrence captures three editing choices at each cell: deleting from `word1` (move up in the table), inserting into `word1` (move left), or replacing a character (move diagonally). Row-by-row computation with two alternating arrays brings space down from O(m·n) to O(n).

```go
// MinDistance calculates minimum operations to convert word1 to word2
// LeetCode 72: Edit Distance
// Time: O(m*n), Space: O(n)
func MinDistance(word1 string, word2 string) int {
    m, n := len(word1), len(word2)

    // dp[i][j] = min operations for word1[0:i] to word2[0:j]
    prev := make([]int, n+1)
    curr := make([]int, n+1)

    // Base case: converting empty string to word2[0:j]
    for j := 0; j <= n; j++ {
        prev[j] = j
    }

    for i := 1; i <= m; i++ {
        curr[0] = i
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                curr[j] = prev[j-1]
            } else {
                curr[j] = 1 + min(prev[j],      // delete
                                min(curr[j-1],   // insert
                                    prev[j-1]))  // replace
            }
        }
        prev, curr = curr, prev
    }

    return prev[n]
}
```

### Junior → FAANG: 2D DP Table Intuition and Interview Execution

The canonical way to explain a 2D DP solution in an interview is to draw a small table (3x3 or 4x4) and fill it by hand for a concrete example. This demonstrates that you understand the recurrence direction and the base cases before you write any code. For LCS, show how a match produces `diagonal + 1` and a mismatch takes the max of the cell above and the cell to the left. For edit distance, show how each of the three operations maps to a table direction.

Go-specific initialization pattern for 2D DP: always use the two-step allocation:
```go
dp := make([][]int, m+1)
for i := range dp {
    dp[i] = make([]int, n+1)
}
```
Prefer this over a flat 1D slice with manual `i*n+j` index arithmetic in interview code: the two-step form is idiomatic and it reads without the reviewer having to check your arithmetic. The flat form is a legitimate optimization in hot production code, where one allocation and contiguous memory beat m separate row allocations and a pointer chase per row, so if you reach for it, say why. For the space-optimized version, the swap idiom `prev, curr = curr, prev` avoids allocation inside the loop and is worth knowing by heart. It carries one caveat: the swapped-in `curr` still holds row i-2's values, so it is only safe when every cell of the new row is unconditionally overwritten. Both functions above satisfy this (`curr[j]` is assigned in each branch, and `curr[0]` is either a fixed 0 or set explicitly), but a recurrence with a conditional write needs an explicit clear.

The unique paths problem is the entry point because its recurrence is the simplest (sum of top and left). Practice mentally converting the 2D `dp[i][j] = dp[i-1][j] + dp[i][j-1]` into the 1D rolling update `dp[j] += dp[j-1]` until the transformation is instantaneous. Every 2D DP with a "depends on row above and same column to the left" dependency pattern compresses the same way.

### Senior @ FAANG: 2D DP at Production Scale

The 2D DP patterns in this section (grid paths, LCS, edit distance) appear extensively in production systems. The production concerns for each differ.

Grid path DP is used in robotics path planning, PCB routing, and game AI movement. The production challenge is that the grid may be sparse (mostly blocked cells) or dynamically updated. A static 2D table is wasteful for a sparse grid. A hash map keyed by cell coordinates trades random access for lower memory pressure. For dynamic grids (cells becoming blocked or unblocked), a full recomputation of the DP table is too expensive, and incremental update algorithms (recomputing only the cells downstream of the changed cell) require careful dependency tracking.

LCS is used in diff tools (Unix `diff`, Git diff, code review tools), plagiarism detection, and bioinformatics sequence alignment. In these domains, the strings can be millions of characters long, making the O(m*n) table allocation infeasible in memory. The two-row variant fixes the memory problem for the length but throws away the table you need to recover the alignment itself. The classic resolution is Hirschberg's algorithm, which computes the actual LCS in O(min(m,n)) space and still O(m*n) time by divide and conquer: find the midpoint of the alignment using two forward and backward linear-space passes, then recurse on the two halves. Knowing that "linear space and you still get the sequence back" is possible, and naming Hirschberg, is a strong signal on the LCS follow-up. Beyond that, real diff tools do not run textbook LCS at all: `git diff` and friends use Myers' O(ND) diff algorithm, which is fast when the two inputs are similar (D, the edit script length, is small), which is the common case for source files. When even that is too slow, approximate methods (shingling, MinHash) trade exactness for scalability.

Edit distance is used in spell checkers, DNA alignment (Needleman-Wunsch is the global-alignment member of the same DP family, and Smith-Waterman is its local-alignment counterpart), and fuzzy string matching in search engines. The production concern is latency: computing edit distance between a query and a dictionary of millions of words serially is too slow. Production systems pre-filter the dictionary using n-gram overlap (if two strings have fewer than k shared n-grams, their edit distance exceeds a threshold) and compute the full edit distance only for candidates passing the pre-filter. Staff engineers design these two-phase pipelines and reason about the precision-recall trade-off of the pre-filter threshold.

### Junior → FAANG: Mastering 2D DP Through Table Filling

The single most effective practice technique for 2D DP is to fill the table by hand for small inputs before writing any code. For unique paths on a 3x3 grid, fill all 9 cells with the recurrence `dp[i][j] = dp[i-1][j] + dp[i][j-1]`. For LCS of "abc" and "ac", fill the 4x3 table cell by cell. This takes 10 minutes per problem and reveals the iteration order, base case placement, and whether the recurrence is correct, all before you have written a single line of Go.

The tell is visible from the outside: candidates who filled the table first tend to get the loop bounds, the base cases, and the location of the final answer right on the first pass, while candidates who went straight to code tend to debug an off-by-one in one of those three places on the interviewer's clock.

For the space optimization from 2D to 1D, the reliable technique is to write the 2D solution first, then ask: "which cells of the previous row do I read when computing row `i`?" If the answer is "the entire previous row," two alternating arrays suffice. If the answer is "only the current column and the cell to the left," a single rolling array with the right traversal direction suffices. Never start with the 1D optimization. Derive it from the 2D version.

### Senior @ FAANG: 2D DP in Data Infrastructure and Machine Learning Systems

The three 2D DP patterns (grid paths, LCS, edit distance) map to concrete data infrastructure problems at FAANG scale. Grid path counting with obstacles is used in A/B test traffic routing: given a directed graph of experiment segments with some disabled paths, count the number of valid user journeys through the experiment. This problem is exactly unique paths with obstacles, and it runs as a batch job over experiment configuration graphs.

LCS at scale is a data lineage problem. In data pipeline systems, two pipeline versions are compared to find the longest common sequence of transformation steps, enabling incremental rebuilds (only re-run the steps that changed). For pipelines with thousands of steps, the O(m*n) table is feasible in batch, but interactive comparison requires the space-optimized two-row variant to stay within memory budgets.

Edit distance in ML systems underlies token alignment for sequence-to-sequence models (aligning predicted token sequences with reference sequences for BLEU score computation), and code change detection (computing the edit distance between two versions of a function to assess refactoring effort). Staff engineers who propose ML-based replacements for edit distance metrics (cosine similarity on embeddings, for example) must benchmark against the edit distance baseline on the actual production data distribution, not just on benchmark datasets, because the correlation between embedding similarity and edit distance varies significantly by domain.
