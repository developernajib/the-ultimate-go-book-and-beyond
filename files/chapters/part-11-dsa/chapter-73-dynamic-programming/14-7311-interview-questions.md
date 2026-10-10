## 73.12 Interview Questions

### Question 1: Longest Increasing Subsequence

The naive DP solution runs in O(n²) by comparing every pair of elements, but the O(n log n) approach replaces it with a patience-sorting insight: maintain a `tails` array where `tails[i]` holds the smallest possible tail value of any increasing subsequence of length `i+1`. For each new number, binary search locates where it fits, either extending the longest subsequence or replacing an existing tail to keep future options open. The array length at the end equals the LIS length, though the array itself is not a valid LIS.

```go
import "sort" // sort.SearchInts is a lower-bound search: the first index
               // where tails[i] >= num, which is what keeps the LIS strict.
               // slices.BinarySearch is the modern equivalent.

func lengthOfLIS(nums []int) int {
    // O(n log n) time, O(n) space
    tails := []int{}

    for _, num := range nums {
        idx := sort.SearchInts(tails, num)
        if idx == len(tails) {
            tails = append(tails, num)
        } else {
            tails[idx] = num
        }
    }

    return len(tails)
}
```

### Question 2: Edit Distance

This interview implementation uses a full 2D `dp` table rather than the rolling-array optimization, making the recurrence easier to follow during an explanation. The base cases initialize the first row and column to represent converting between an empty string and prefixes of the other word using only insertions or deletions. Each interior cell then picks the cheapest of the three edit operations: `dp[i-1][j-1]` for a substitution (or free match), `dp[i-1][j]` for a deletion, and `dp[i][j-1]` for an insertion.

```go
func minDistance(word1 string, word2 string) int {
    m, n := len(word1), len(word2)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    for i := 0; i <= m; i++ {
        dp[i][0] = i
    }
    for j := 0; j <= n; j++ {
        dp[0][j] = j
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                dp[i][j] = dp[i-1][j-1]
            } else {
                dp[i][j] = 1 + min(dp[i-1][j-1], min(dp[i-1][j], dp[i][j-1]))
            }
        }
    }

    return dp[m][n]
}
```

### Junior → FAANG: Communicating Complexity Under Pressure

Both questions above are canonical LeetCode problems that appear in FAANG phone screens. The expected performance is: write a working solution in 15-20 minutes, state the time and space complexity correctly, and offer at least one optimization when prompted.

For LIS, the progression is: "I can solve this in O(n^2) using DP where dp[i] is the length of the longest increasing subsequence ending at index i." Pause, then: "There is also an O(n log n) solution using a greedy approach with binary search. The insight is maintaining a `tails` array where `tails[k]` is the smallest tail value for any increasing subsequence of length k+1. For each element, binary search for its position in `tails` and either extend or replace." If you can implement both variants on demand, you are well above the median candidate.

For edit distance, the 2D table version shown above is the correct interview implementation. Interviewers expect you to know the three operations (insert, delete, replace) and which table directions they correspond to. A prompt to "optimize space" should immediately lead you to the rolling-array variant. Practice this transition: identify that row i only reads from row i-1, allocate two arrays, swap them each iteration.

### Senior @ FAANG: Interview Questions as Bar-Raiser Probes

At the L6/L7 interview level, these two problems appear not as standalone exercises but as components of larger system design or algorithm design questions. "You are building a version control system. How do you efficiently compute the diff between two versions of a file?" This requires LCS or edit distance as the core algorithm, plus reasoning about line-level versus character-level granularity, efficient representation of the diff output, and handling binary files.

"You are building a search engine with autocomplete and spell correction. How do you find the k closest words (by edit distance) to a misspelled query in under 10 milliseconds?" This requires knowing that computing edit distance naively against a million-word dictionary is too slow, and that a BK-tree (a metric tree over edit distance) prunes the search so that the DP runs on a small candidate set instead of the whole dictionary. The pruning is worth stating honestly rather than as a complexity headline: a BK-tree gives no logarithmic guarantee. It works by the triangle inequality, since if `d(query, node) = k` and you will accept matches within tolerance `t`, only children at edge distances `k-t` through `k+t` can possibly qualify and the rest of the subtree is skipped. How much that saves depends entirely on `t`. At `t = 1` it is dramatic. As `t` grows the surviving band widens, and the tree degrades toward scanning everything. Knowing where a structure stops helping is the actual signal, and it is why production systems cap the tolerance rather than exposing it as a free parameter. The full stack here runs from the metric space property (edit distance satisfies the triangle inequality, which is what permits the tree at all) through the DP to the latency target.

### Junior → FAANG: Interview Questions as a Complexity Progression

The two questions in this file (LIS and edit distance) represent a complexity progression that matches what FAANG interviewers expect. LIS requires knowing two solutions: O(n^2) DP and O(n log n) patience sort. Edit distance requires knowing one solution with two representations: 2D table (clear for explanation) and rolling arrays (space-optimized for production). In both cases, present the simpler solution first, then offer the optimization.

For LIS, the progression narration is: "The O(n^2) solution is clear: `dp[i]` is the LIS length ending at index i, and I check all prior indices where the value is smaller. I can improve this to O(n log n) using the patience sort insight, where I maintain a `tails` array and binary search for the insertion point of each new element." Then implement whichever version the interviewer requests, or both if time permits.

For edit distance, always draw a 3x3 table before coding. The table shows the interviewer whether you understand all three operations and the table direction each one corresponds to, and it costs a minute or two. Most edit distance bugs are base-case and direction errors, which is exactly what the drawing exposes before you have written a line.

### Senior @ FAANG: Building LIS and Edit Distance Into Platform Systems

LIS appears in data pipeline ordering: given a list of pipeline stages with version numbers, find the longest sequence of stages that can be applied in strictly increasing version order (for incremental schema migrations or feature rollouts). The O(n log n) variant is the correct production choice when the number of stages can reach thousands.

Edit distance with reconstruction (not just length) is used in diff and merge tools. The production challenge is that computing the optimal alignment for two large files requires the full O(m*n) table, which may not fit in memory. Production diff tools use the Myers diff algorithm, which is O(nd) time and O(n+d) space where d is the number of edits. Staff engineers who understand edit distance DP can read and reason about the Myers algorithm's correctness (it is a diagonal DP over the edit graph) without treating it as a black box.

---
