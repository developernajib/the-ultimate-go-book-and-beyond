## 73.15 Advanced Interview Questions with Frameworks

### Question 3: Explain Your Approach to Identifying a DP Problem

**Interview Question:** "Walk me through how you identify whether a problem can be solved with dynamic programming."

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              DP PROBLEM IDENTIFICATION FRAMEWORK                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  STEP 1: LOOK FOR KEYWORDS                                              │
│  ─────────────────────────────                                          │
│  • "Count the number of ways..."                                        │
│  • "Find the minimum/maximum..."                                        │
│  • "Is it possible to..."                                               │
│  • "Find longest/shortest..."                                           │
│  • Optimization problems with constraints                               │
│                                                                         │
│  STEP 2: CHECK FOR OPTIMAL SUBSTRUCTURE                                 │
│  ────────────────────────────────────────                               │
│  Can I build the solution from smaller problems?                        │
│                                                                         │
│  Example: Edit Distance                                                 │
│  editDist("abc", "ac") uses:                                            │
│  • editDist("ab", "a")                                                  │
│  • editDist("abc", "a")                                                 │
│  • editDist("ab", "ac")                                                 │
│                                                                         │
│  STEP 3: CHECK FOR OVERLAPPING SUBPROBLEMS                              │
│  ────────────────────────────────────────────                           │
│  Do I solve the same subproblem multiple times?                         │
│                                                                         │
│  Fibonacci: fib(5) calls fib(3) twice                                   │
│       fib(5)                                                            │
│      /     \                                                            │
│   fib(4)   fib(3)  ← both call fib(2)                                   │
│   /   \    /   \                                                        │
│ fib(3) fib(2)...                                                        │
│                                                                         │
│  STEP 4: DEFINE STATE                                                   │
│  ────────────────────                                                   │
│  What variables uniquely identify a subproblem?                         │
│                                                                         │
│  • 1D: dp[i] = answer for first i elements                              │
│  • 2D: dp[i][j] = answer for str1[0:i] and str2[0:j]                    │
│  • State machine: dp[i][state] = answer at position i in state          │
│                                                                         │
│  STEP 5: WRITE RECURRENCE                                               │
│  ─────────────────────────                                              │
│  dp[i] = f(dp[i-1], dp[i-2], ...) based on problem structure            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer:**

```markdown
"When I encounter a problem, I follow this mental checklist:

1. **Keywords Check**: If the problem asks for 'number of ways',
   'minimum/maximum', or 'is it possible', DP is likely applicable.

2. **Optimal Substructure Test**: I ask myself, 'Can the solution be
   built from solutions to smaller instances?' For example, the shortest
   path to node N can be built from shortest paths to N's neighbors.

3. **Overlapping Subproblems Test**: I trace through a small example
   and look for repeated work. If I'm computing the same thing twice,
   memoization will help.

4. **State Design**: I determine what variables define a subproblem.
   This is often the trickiest part. For example, in stock problems
   with cooldown, the state needs day AND whether I can buy.

5. **Recurrence Relation**: I write how dp[current] relates to previous
   states. Then I verify with small examples.

Let me demonstrate with 'Coin Change':
- Keywords: 'minimum number' → optimization problem
- Optimal Substructure: min coins for amount N = 1 + min coins for (N - coin)
- Overlapping: Computing coins(10) with {1,5} needs coins(9), coins(5)
  multiple times
- State: dp[amount] = minimum coins for that amount
- Recurrence: dp[i] = 1 + min(dp[i-coin]) for each valid coin"
```

### Question 4: Solve "Longest Increasing Path in Matrix" and Explain

**Interview Question:** "Given a matrix of integers, find the longest increasing path. You can move in four directions."

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│            MATRIX DP WITH DFS MEMOIZATION FRAMEWORK                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  STEP 1: UNDERSTAND THE PROBLEM                                         │
│  ────────────────────────────────                                       │
│  • Start from any cell                                                  │
│  • Move to adjacent cell with GREATER value                             │
│  • Find maximum path length                                             │
│                                                                         │
│  Example:                                                               │
│  [9, 9, 4]       Longest: 1→2→6→9 (length 4)                            │
│  [6, 6, 8]       Start at the 1 in the bottom row, go LEFT to 2,        │
│  [2, 1, 1]       then UP to 6, then UP again to 9                       │
│                                                                         │
│  STEP 2: IDENTIFY DP APPLICABILITY                                      │
│  ──────────────────────────────────                                     │
│  • Optimal substructure: path from (i,j) = 1 + max(paths from neighbors)│
│  • Overlapping: multiple cells might lead to same cell                  │
│                                                                         │
│  STEP 3: DESIGN STATE                                                   │
│  ─────────────────────                                                  │
│  dp[i][j] = longest path starting from cell (i, j)                      │
│                                                                         │
│  STEP 4: RECURRENCE                                                     │
│  ─────────────────────                                                  │
│  dp[i][j] = 1 + max(dp[ni][nj]) for all neighbors (ni,nj)               │
│             where matrix[ni][nj] > matrix[i][j]                         │
│                                                                         │
│  STEP 5: IMPLEMENTATION CHOICE                                          │
│  ─────────────────────────────                                          │
│  • Top-down with memoization (natural for this problem)                 │
│  • DFS from each cell, cache results                                    │
│                                                                         │
│  TIME: O(m*n) - each cell computed once                                 │
│  SPACE: O(m*n) - memo table + recursion stack                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Solution:**

```go
package main

// LongestIncreasingPath finds the longest increasing path in matrix
// LeetCode 329: Longest Increasing Path in a Matrix
// Time: O(m*n), Space: O(m*n)
func LongestIncreasingPath(matrix [][]int) int {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return 0
    }

    m, n := len(matrix), len(matrix[0])
    memo := make([][]int, m)
    for i := range memo {
        memo[i] = make([]int, n)
    }

    maxLen := 0
    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            length := dfs(matrix, memo, i, j, m, n)
            if length > maxLen {
                maxLen = length
            }
        }
    }

    return maxLen
}

var directions = [][]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}}

func dfs(matrix [][]int, memo [][]int, i, j, m, n int) int {
    // Already computed
    if memo[i][j] != 0 {
        return memo[i][j]
    }

    // Base: path of length 1 (just this cell)
    maxLen := 1

    // Try all four directions
    for _, d := range directions {
        ni, nj := i+d[0], j+d[1]

        // Check bounds AND strictly increasing
        if ni >= 0 && ni < m && nj >= 0 && nj < n &&
            matrix[ni][nj] > matrix[i][j] {
            length := 1 + dfs(matrix, memo, ni, nj, m, n)
            if length > maxLen {
                maxLen = length
            }
        }
    }

    memo[i][j] = maxLen
    return maxLen
}

// Interview Explanation:
//
// "I'll use DFS with memoization because:
// 1. Each cell has at most 4 neighbors to check
// 2. We can start from any cell, so we try all
// 3. Memoization ensures we compute each cell only once
//
// Key insight: Since we only move to LARGER values, there are no cycles.
// This guarantees our DFS terminates and memoization is safe.
//
// Time: O(m*n) because each cell is computed exactly once
// Space: O(m*n) for the memo table plus O(m*n) worst-case recursion depth"
```

### Question 5: Design a Caching System with DP Principles

**Interview Question:** "How would you apply DP principles to design an optimal caching eviction policy?"

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              DP-BASED CACHING DESIGN FRAMEWORK                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  CONNECTION TO DP:                                                      │
│  • Optimal caching is the "offline" paging problem                      │
│  • Bélády's rule: evict the page used furthest in the future            │
│  • CAREFUL: this is GREEDY, not DP, and it is provably optimal          │
│  • The DP lesson is knowing when NOT to reach for a table               │
│                                                                         │
│  REAL-WORLD APPLICATION:                                                │
│  • Can't see the future, so Bélády is unimplementable online            │
│  • It stays useful as the OFFLINE BOUND to score real policies          │
│  • Learned policies train against that bound                            │
│                                                                         │
│  DESIGN APPROACH:                                                       │
│  ─────────────────                                                      │
│  1. Offline Analysis (DP):                                              │
│     - Given historical access patterns                                  │
│     - Find optimal eviction decisions                                   │
│     - This becomes training data                                        │
│                                                                         │
│  2. Online Policy:                                                      │
│     - LRU/LFU as baseline                                               │
│     - ML model predicting "time until next access"                      │
│     - Evict item with longest predicted gap                             │
│                                                                         │
│  3. DP for Pre-fetching:                                                │
│     - Given access pattern, what to pre-fetch?                          │
│     - dp[i][cache_state] = min cost from position i                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer with Code:**

```go
package cache

// OptimalOfflineCache computes the minimum possible page faults for a known
// access sequence, by simulating Bélády's rule: always evict the page whose
// next use is furthest away.
//
// Note this is a GREEDY algorithm, not a DP one, and it is provably optimal.
// It earns its place in a DP chapter as the contrast case: see the discussion
// below for why "offline optimum" does not imply "solved by a table".
//
// Time: O(n * cacheSize), Space: O(n)
func OptimalOfflineCache(accesses []int, cacheSize int) int {
    n := len(accesses)
    if cacheSize == 0 || n == 0 {
        return n
    }

    // For each position, precompute where that same page is next requested.
    // Scanning backwards means lastSeen[page] already holds the next index.
    nextOccurrence := make([]int, n)
    lastSeen := make(map[int]int)

    for i := n - 1; i >= 0; i-- {
        page := accesses[i]
        if next, exists := lastSeen[page]; exists {
            nextOccurrence[i] = next
        } else {
            nextOccurrence[i] = n // Never used again
        }
        lastSeen[page] = i
    }

    // cache maps a resident page to the index of its next use. Keeping the
    // next-use index IN the cache is what makes the precomputation pay off:
    // eviction reads it directly instead of rescanning the future.
    cache := make(map[int]int)
    pageFaults := 0

    for i := 0; i < n; i++ {
        page := accesses[i]

        if _, hit := cache[page]; hit {
            cache[page] = nextOccurrence[i] // refresh: this use is now spent
            continue
        }

        pageFaults++

        if len(cache) >= cacheSize {
            // Evict the page used furthest in the future. nextOccurrence == n
            // means "never again", which correctly sorts as furthest away.
            evictPage, evictNext := -1, -1
            for p, nextUse := range cache {
                if nextUse > evictNext {
                    evictNext = nextUse
                    evictPage = p
                }
            }
            delete(cache, evictPage)
        }

        cache[page] = nextOccurrence[i]
    }

    return pageFaults
}

// LRUWithLearning combines LRU with learned patterns
type LRUWithLearning struct {
    capacity    int
    cache       map[int]*Node
    head, tail  *Node
    accessCount map[int]int    // Track access frequency
    lastAccess  map[int]int    // Track recency
    time        int
}

type Node struct {
    key, value int
    prev, next *Node
}

// Interview Answer:
//
// "Caching is a good test of whether someone reaches for DP reflexively
//  or deliberately, because the headline result here is NOT a DP result.
//
// 1. **Offline Optimal (Bélády)**: given the whole access sequence in
//    advance, the minimum page faults is achieved by always evicting the
//    page used furthest in the future. Worth being precise: that is a
//    greedy rule, proven optimal by an exchange argument, not a table.
//    I'd flag that explicitly, because 'optimal' and 'offline' both smell
//    like DP and here they aren't.
//
// 2. **Why it still matters**: Bélády needs the future, so it can never
//    ship. Its value is as the BOUND. Replay a production trace through
//    it and you learn how much room your real policy has left, which
//    turns 'our hit rate is 87%' into 'we are 4 points off optimal'.
//
// 3. **Online Approximation**: since we can't see the future:
//    - LRU bets 'recently used = will be used soon'
//    - LFU bets 'frequently used = will be used again'
//    Each is a heuristic for the one quantity Bélády gets for free:
//    time until next access.
//
// 4. **Learning-Based**: the research direction (Hawkeye, Glider, and
//    Learning Relaxed Belady among others) makes that explicit. Compute
//    Bélády's decisions offline on a trace, use them as labels, and train
//    a model to predict reuse distance from features available online.
//    The offline optimum becomes the training signal.
//
// 5. **Where DP genuinely enters**: prefetching under a budget, where a
//    decision at step i changes the state you face at i+1:
//    dp[i][state] = min(miss_cost + dp[i+1][new_state],
//                       prefetch_cost + dp[i+1][prefetched_state])
//    That has real optimal substructure over an exponential state space,
//    which is why production prefetchers approximate it rather than solve
//    it. Hardware prefetchers in particular are far simpler than this:
//    they detect strides and streams with small tables, no optimization
//    involved. The DP is the model you reason WITH, not the code that
//    ships in silicon."
```

### Junior → FAANG: Using Frameworks to Unlock Hard Problems

The five-step DP identification framework in Question 3 is your mental scaffold for any problem you have never seen before. The key discipline is to apply every step explicitly before typing any code. In a 45-minute interview, spending 8-10 minutes on steps 1-4 (keywords, optimal substructure check, overlapping subproblems check, state design) leaves you 30-35 minutes to implement and test, which is sufficient for most DP problems.

The longest increasing path in matrix problem (Question 4) combines DFS with memoization in a way that is not immediately recognizable as DP. The key property that makes memoization safe is the absence of cycles: since movement is only to strictly larger values, there are no cycles in the DFS, so each cell's memo result is computed exactly once and never invalidated. This "no-cycle guarantee" is the condition that must be stated explicitly when explaining why DFS memoization is valid for this problem.

For the caching design question (Question 5), the interviewer is evaluating your ability to connect an abstract algorithmic concept to a concrete system design. The Belady's algorithm connection (offline optimal caching is DP) is the bridge. Practice this kind of "algorithm to system" mapping for several DP problems: "optimal scheduling is knapsack," "query plan optimization is matrix chain," "autocomplete ranking is edit distance." These mappings will surface naturally in system design interviews if you have trained them.

### Senior @ FAANG: Advanced Frameworks as Staff-Level Thinking Tools

At the L6/L7 level, the advanced interview questions in this file probe not just DP knowledge but the ability to reason about the broader landscape of which problems can and cannot be solved by DP, and what the trade-offs are when they can.

The DP identification framework must be complemented by a "DP limits" framework: recognizing when a problem looks like DP but is not amenable to it. Examples include: problems where the optimal solution does not decompose into optimal sub-solutions (e.g., the longest path in a general graph is NP-hard, unlike the shortest path), problems with highly non-uniform overlap structure (making the memoization table mostly empty, so brute-force search is preferred), and problems where the state space is too large for any practical table representation (requiring approximation or sampling techniques instead of exact DP).

The caching design question reveals staff-level thinking when the candidate moves beyond Belady's algorithm to discuss the practical gap: Belady requires future knowledge, so production systems use learned prefetchers trained on historical traces. The connection between the offline DP solution (training oracle) and the online learned policy (deployment artifact) is a machine learning systems concept that appears in ICLR and OSDI research papers. Staff engineers at FAANG are expected to be aware of this research frontier and to evaluate when learned approaches offer practical advantages over algorithm-based approaches for their specific workload characteristics.

### Junior → FAANG: Using Advanced Frameworks to Structure Novel Problems

The five-step framework for DP identification (keywords, optimal substructure, overlapping subproblems, state design, recurrence) is the tool that makes unfamiliar problems tractable. When you encounter Question 4 (longest increasing path in matrix) for the first time, the framework prevents panic: "keywords are 'longest' and 'path,' which are DP signals. Does path from (i, j) decompose into shorter paths from neighbors? Yes. Do different starting cells lead to the same (i, j)? Yes. State is `dp[i][j]` = longest path starting from (i, j). Recurrence is `1 + max(dp[neighbor])` for neighbors with larger values."

The key discipline is to never skip the "overlapping subproblems" check, even for graph problems. If two paths both reach the same cell (i, j), and the answer from (i, j) onward is the same regardless of how you arrived, memoization is valid. If the answer depends on the path taken (e.g., "you cannot revisit a cell"), memoization is not valid and backtracking is required. This distinction is the most important DP-versus-backtracking decision in graph problems.

### Senior @ FAANG: Advanced Frameworks as L6 Interview Discriminators

The advanced questions in this file (Questions 3-6) are used at the L6 interview level because they test not just DP knowledge but the ability to reason about the limits of DP, choose between DP and alternative approaches, and connect algorithms to system design. A candidate who can answer all four questions fluently, including the system design connections (Belady as an oracle for learned caching, BK-tree for edit distance search), is demonstrating L6-level thinking.

The distinct subsequences problem (Question 6) is a discriminator because the "use or skip" case analysis for matching characters is non-obvious. The insight that matching adds two contributions (use this character, or skip it and use a later match) while non-matching adds only one (skip this character) requires genuine understanding of the state semantics. Candidates who derive this case analysis from the state definition are demonstrating depth. Candidates who recall it are not.

The extension worth having ready is bounding the work when t is much shorter than s. Two of them are concrete rather than gestural. First, most cells are structurally dead: `dp[i][j]` is 0 whenever `j > i` (a prefix of s cannot contain a longer t) and irrelevant whenever `n - j > m - i` (too little of s remains to supply the rest of t). Clamping the inner loop to that band, which is what `min(i, n)` in `NumDistinct` starts to do, keeps the filled region to a diagonal strip rather than the full rectangle. Second, a row only changes at positions where `s[i-1]` actually occurs in t, so precomputing the positions of each character in t lets you touch only those j values and skip the rest of the row outright. Both keep O(m*n) as the worst case and both cut real work when the alphabet is large or t is short. Naming the invariant that licenses the pruning matters more than the pruning.

### Question 6: Solve "Distinct Subsequences" and Analyze Time Complexity

**Interview Question:** "Given strings s and t, count the distinct subsequences of s that equal t."

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              DISTINCT SUBSEQUENCES DP FRAMEWORK                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  EXAMPLE:                                                               │
│  s = "rabbbit", t = "rabbit"                                            │
│  Answer: 3 (three ways to choose which 'b' to skip)                     │
│                                                                         │
│  STATE DEFINITION:                                                      │
│  dp[i][j] = number of ways to form t[0:j] from s[0:i]                   │
│                                                                         │
│  RECURRENCE:                                                            │
│  ─────────────                                                          │
│  If s[i-1] == t[j-1]:                                                   │
│      dp[i][j] = dp[i-1][j-1]  // Use s[i-1] to match t[j-1]             │
│               + dp[i-1][j]    // Skip s[i-1], still need t[0:j]         │
│                                                                         │
│  If s[i-1] != t[j-1]:                                                   │
│      dp[i][j] = dp[i-1][j]    // Must skip s[i-1]                       │
│                                                                         │
│  BASE CASES:                                                            │
│  dp[i][0] = 1  (empty t is subsequence of any s)                        │
│  dp[0][j] = 0  (non-empty t can't be formed from empty s)               │
│  dp[0][0] = 1  (empty matches empty)                                    │
│                                                                         │
│  VISUALIZATION for s="rab", t="ab":                                     │
│                                                                         │
│      ""  a   b                                                          │
│  ""   1  0   0                                                          │
│  r    1  0   0                                                          │
│  a    1  1   0   (a matches a: dp[2][1] = dp[1][0] + dp[1][1])          │
│  b    1  1   1   (b matches b: dp[3][2] = dp[2][1] + dp[2][2])          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Solution:**

```go
package main

// NumDistinct counts distinct subsequences of s that equal t
// LeetCode 115: Distinct Subsequences
// Time: O(m*n), Space: O(n) with optimization
func NumDistinct(s string, t string) int {
    m, n := len(s), len(t)
    if m < n {
        return 0
    }

    // dp[j] = ways to form t[0:j] from s[0:i] (current row)
    dp := make([]int, n+1)
    dp[0] = 1 // Empty t can be formed from any prefix of s

    for i := 1; i <= m; i++ {
        // Process right to left to avoid overwriting needed values
        for j := min(i, n); j >= 1; j-- {
            if s[i-1] == t[j-1] {
                dp[j] = dp[j] + dp[j-1]
            }
            // If not equal, dp[j] stays the same (skip s[i-1])
        }
    }

    return dp[n]
}

// NumDistinct2D shows the full 2D DP for clarity
func NumDistinct2D(s string, t string) int {
    m, n := len(s), len(t)

    // dp[i][j] = ways to form t[0:j] from s[0:i]
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
        dp[i][0] = 1 // Empty t matches
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if s[i-1] == t[j-1] {
                // Match: use this char OR skip it
                dp[i][j] = dp[i-1][j-1] + dp[i-1][j]
            } else {
                // No match: must skip s[i-1]
                dp[i][j] = dp[i-1][j]
            }
        }
    }

    return dp[m][n]
}
// Note: Go 1.21+ provides builtin min() and max()

// Interview Explanation:
//
// "The key insight is that when characters match, we have TWO choices:
// 1. Use the matching character (count from dp[i-1][j-1])
// 2. Skip it and find another match later (count from dp[i-1][j])
//
// When they don't match, we can only skip the character in s.
//
// Time Complexity: O(m*n) where m=len(s), n=len(t)
// - We fill an m×n table
// - Each cell takes O(1) time
//
// Space Complexity: O(n) with 1D optimization
// - Only need current row's dependency on previous row
// - Process right-to-left to avoid overwriting needed values
//
// Follow-up: a row only changes at j where t[j-1] == s[i-1], since
// every other cell just copies down. So precompute the positions of
// each character IN T (not in s: we are scanning a row of t for the
// one character s[i-1] contributes), then visit only those j. Worst
// case is still O(m*n), but with a large alphabet most rows do almost
// nothing."
```

---
