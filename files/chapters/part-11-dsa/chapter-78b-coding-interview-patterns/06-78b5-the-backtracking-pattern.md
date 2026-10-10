## 78B.5 The Backtracking Pattern

```
┌──────────────────────────────────────────────────────────────────┐
│                  BACKTRACKING PATTERN                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Framework:                                                      │
│  1. Choose    : make a decision                                  │
│  2. Explore   : recurse with that decision                       │
│  3. Unchoose  : undo the decision (backtrack)                    │
│                                                                  │
│  Decision Tree for [1, 2, 3] subsets:                            │
│                    {}                                            │
│              /     |      \                                      │
│           {1}    {2}     {3}                                     │
│          /   \     |                                             │
│       {1,2} {1,3} {2,3}                                          │
│         |                                                        │
│      {1,2,3}                                                     │
│                                                                  │
│  Pruning: Skip branches that cannot lead to valid solutions      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Backtracking systematically explores all candidates for a solution, abandoning a candidate ("backtracking") as soon as it is determined to be invalid. It is the brute-force strategy made efficient through pruning.

**When to use Backtracking:**
- Generate all permutations, combinations, or subsets
- Solve constraint satisfaction problems (Sudoku, N-Queens)
- Path finding with constraints
- String partitioning (palindrome partitioning)

### Template: Backtracking

The backtracking template's three-step body (choose, explore, unchoose) must always make a deep copy of `current` before appending to `result`, because the same underlying slice is mutated throughout the search. A `start` index confines choices to forward positions, ensuring combinations rather than permutations are generated.

```go
func backtrack(result *[][]int, current []int, choices []int, start int) {
    // Base case: add a copy of current to result
    temp := make([]int, len(current))
    copy(temp, current)
    *result = append(*result, temp)

    for i := start; i < len(choices); i++ {
        // Pruning: skip invalid choices
        if !isValid(choices, i) {
            continue
        }

        // Choose
        current = append(current, choices[i])

        // Explore
        backtrack(result, current, choices, i+1)

        // Unchoose
        current = current[:len(current)-1]
    }
}
```

---

### Problem 1: Subsets (LC 78)

**Problem:** Given an integer array `nums` of unique elements, return all possible subsets (the power set).

**Approach:** Backtracking where at each position we choose to include or not include the element. Use the `start` index to avoid duplicates.

```go
func subsets(nums []int) [][]int {
    result := [][]int{}
    current := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        // Add current subset (make a copy)
        temp := make([]int, len(current))
        copy(temp, current)
        result = append(result, temp)

        for i := start; i < len(nums); i++ {
            current = append(current, nums[i])
            backtrack(i + 1)
            current = current[:len(current)-1]
        }
    }

    backtrack(0)
    return result
}
```

**Time Complexity:** O(n · 2^n). There are 2^n subsets and each takes O(n) to copy.
**Space Complexity:** O(n) for recursion depth, excluding the output.

The `copy` before appending to `result` is not a defensive habit, it is load-bearing. `current` is a single slice mutated in place for the whole search, so appending it directly would push the same backing array into `result` every time and every entry would end up identical (and empty, once the search unwinds). This is the single most common way a correct-looking backtracking solution produces garbage. If your subsets output is a list of identical rows, this is why.

**Edge cases:**
- Empty array → [[]]
- Single element → [[], [x]]

---

### Problem 2: Permutations (LC 46)

**Problem:** Given an array `nums` of distinct integers, return all possible permutations.

**Approach:** Backtracking with a `used` boolean array to track which elements are already in the current permutation.

```go
func permute(nums []int) [][]int {
    result := [][]int{}
    current := []int{}
    used := make([]bool, len(nums))

    var backtrack func()
    backtrack = func() {
        if len(current) == len(nums) {
            temp := make([]int, len(current))
            copy(temp, current)
            result = append(result, temp)
            return
        }

        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }
            used[i] = true
            current = append(current, nums[i])
            backtrack()
            current = current[:len(current)-1]
            used[i] = false
        }
    }

    backtrack()
    return result
}
```

**Time Complexity:** O(n · n!). There are n! permutations, each O(n) to copy.
**Space Complexity:** O(n) for recursion and the `used` array.

**Edge cases:**
- Single element → [[x]]
- Two elements → [[a,b], [b,a]]

---

### Problem 3: Combination Sum (LC 39)

**Problem:** Given an array of distinct integers `candidates` and a target integer `target`, return all unique combinations where the chosen numbers sum to target. The same number may be used unlimited times.

**Approach:** Backtracking with the key insight that we pass `i` (not `i+1`) to allow reusing the same candidate.

```go
import "slices"

func combinationSum(candidates []int, target int) [][]int {
    result := [][]int{}
    current := []int{}

    slices.Sort(candidates) // sort for pruning

    var backtrack func(start, remaining int)
    backtrack = func(start, remaining int) {
        if remaining == 0 {
            temp := make([]int, len(current))
            copy(temp, current)
            result = append(result, temp)
            return
        }

        for i := start; i < len(candidates); i++ {
            if candidates[i] > remaining {
                break // prune: sorted array, no point continuing
            }
            current = append(current, candidates[i])
            backtrack(i, remaining-candidates[i]) // i, not i+1: reuse allowed
            current = current[:len(current)-1]
        }
    }

    backtrack(0, target)
    return result
}
```

**Time Complexity:** O(n^(T/M)) where T is the target and M the smallest candidate. The branching factor is n and the depth is bounded by T/M.
**Space Complexity:** O(T/M) for recursion depth.

Two distinct mechanisms are at work and it is worth separating them. Passing `i` rather than `i+1` permits reuse. Passing `start` at all (rather than always scanning from 0) is what prevents `[2,3]` and `[3,2]` from both appearing: it forces every combination to be emitted in non-decreasing order, so each multiset is reached exactly once. The `break` on `candidates[i] > remaining` is the only true pruning, and it is valid only because the array was sorted.

**Edge cases:**
- Target is 0 → [[]]
- No candidates sum to target → []
- Single candidate equal to target → [[candidate]]
- Candidate larger than target → skipped by pruning

---

### Problem 4: N-Queens (LC 51)

**Problem:** Place n queens on an n×n chessboard such that no two queens attack each other. Return all distinct solutions.

**Approach:** Backtracking row by row. For each row, try each column. Use sets to track which columns, diagonals (row-col), and anti-diagonals (row+col) are under attack.

```go
func solveNQueens(n int) [][]string {
    result := [][]string{}
    queens := make([]int, n) // queens[row] = column

    cols := make(map[int]bool)
    diag := make(map[int]bool)     // row - col
    antiDiag := make(map[int]bool) // row + col

    var backtrack func(row int)
    backtrack = func(row int) {
        if row == n {
            board := make([]string, n)
            for r := 0; r < n; r++ {
                rowStr := make([]byte, n)
                for c := 0; c < n; c++ {
                    if queens[r] == c {
                        rowStr[c] = 'Q'
                    } else {
                        rowStr[c] = '.'
                    }
                }
                board[r] = string(rowStr)
            }
            result = append(result, board)
            return
        }

        for col := 0; col < n; col++ {
            if cols[col] || diag[row-col] || antiDiag[row+col] {
                continue
            }

            queens[row] = col
            cols[col] = true
            diag[row-col] = true
            antiDiag[row+col] = true

            backtrack(row + 1)

            cols[col] = false
            diag[row-col] = false
            antiDiag[row+col] = false
        }
    }

    backtrack(0)
    return result
}
```

**Time Complexity:** O(n!) as a loose upper bound on the nodes explored, with the real count far lower because the diagonal checks prune aggressively. Compare against O(n^n) for unpruned brute force. No closed form for the exact count is known.
**Space Complexity:** O(n) for the recursion stack and tracking sets.

**Edge cases:**
- n=1 → [["Q"]]
- n=2, n=3 → no solution (return [])
- n=4 → 2 solutions

---

### Problem 5: Palindrome Partitioning (LC 131)

**Problem:** Given a string `s`, partition it such that every substring is a palindrome. Return all possible partitions.

**Approach:** Backtracking. At each position, try all substrings starting there. If a substring is a palindrome, recurse on the remainder.

```go
func partition(s string) [][]string {
    result := [][]string{}
    current := []string{}

    var backtrack func(start int)
    backtrack = func(start int) {
        if start == len(s) {
            temp := make([]string, len(current))
            copy(temp, current)
            result = append(result, temp)
            return
        }

        for end := start + 1; end <= len(s); end++ {
            substr := s[start:end]
            if isPalin(substr) {
                current = append(current, substr)
                backtrack(end)
                current = current[:len(current)-1]
            }
        }
    }

    backtrack(0)
    return result
}

func isPalin(s string) bool {
    l, r := 0, len(s)-1
    for l < r {
        if s[l] != s[r] {
            return false
        }
        l++
        r--
    }
    return true
}
```

**Time Complexity:** O(n · 2^n). There are 2^(n-1) ways to cut the string and each palindrome check plus copy is O(n).
**Space Complexity:** O(n) for recursion depth.

**Edge cases:**
- Single character → [[c]]
- All same characters → many partitions (e.g., "aaa" → ["a","a","a"], ["a","aa"], ["aa","a"], ["aaa"])
- No palindrome partition possible beyond individual characters → that is always possible since single chars are palindromes

---

### Junior → FAANG: Backtracking Template and Pruning Discipline

Junior engineers often implement backtracking as brute-force with a post-hoc filter, generating all possibilities and then removing invalid ones. This approach leads to TLE on medium and hard problems because it explores exponentially many invalid branches before filtering. True backtracking prunes before recursing: check the constraint before making a recursive call, not after.

The template has three mandatory steps in order: make a choice, recurse, undo the choice. The undo step is where junior implementations break. If you use a shared data structure (a slice, a map, a string builder) and forget to undo mutations, later recursive calls see corrupted state. In Go, passing a copy of the current path prevents this but costs O(depth) per recursive call. Passing a shared slice and appending/truncating is more efficient but requires careful undo logic.

Pruning recognition exercise: for Permutations, the only valid pruning is "don't reuse an element." For Combination Sum where elements can be reused, the pruning is "don't try elements smaller than the current last chosen element." For N-Queens, the pruning requires tracking occupied columns, forward diagonals, and backward diagonals. Identifying the pruning conditions before writing code is a signal that separates prepared candidates from those who write the template and add pruning only when the solution TLEs.

Entry-level signal: when asked "what is the time complexity of your backtracking solution?", give an answer in terms of the branching factor and depth, not a vague "exponential." For permutations of n elements it is O(n!) recursive calls times O(n) work per call.

### Senior @ FAANG: Backtracking in Constraint Solving and Compiler Optimization

Backtracking is the engine of constraint satisfaction solvers, and the constraint-satisfaction *shape* appears throughout infrastructure engineering even where the solver does not. Placing workloads on machines under hard constraints (resource fit, affinity) and soft constraints (spread, anti-affinity) is a constraint problem. So is register allocation, which is graph coloring. So is configuration validation, checking that a combination of feature flags is mutually consistent over a boolean domain.

The instructive part is how often production systems refuse to backtrack. The Kubernetes scheduler is a good example of the road not taken: it does not search over placements at all. It runs a filter phase and a score phase per pod and commits to the highest-scoring node, one pod at a time, with no reconsideration of earlier placements. That is a greedy algorithm, and it can produce placements that a full search would avoid. The tradeoff is deliberate, because exhaustive placement search is exponential and a scheduler must keep up with arrival rate. Production register allocators make the same trade, leaning on Chaitin-Briggs style simplify-and-spill heuristics rather than searching for an optimal coloring.

That is the senior-level lesson: recognizing a problem as constraint satisfaction tells you the search space is exponential, which is usually an argument for a heuristic with a bounded cost rather than for a solver. Reach for real backtracking when the instance is small, the constraints are tight enough to prune hard, or correctness genuinely requires exhaustiveness.

ADR consideration: backtracking is appropriate when pruning is effective, meaning constraints fail early and near the root rather than at the leaves. When pruning rarely fires, backtracking degenerates into enumeration and a branch-and-bound, SAT, or integer programming solver will beat hand-written search, because those invest in bounding and clause learning that a hand-rolled recursion does not have. Measure rather than assume: instrument the search to count nodes visited against nodes pruned. If the visited count tracks the size of the full solution space, pruning is not doing anything and the algorithm choice is wrong.

Bar-raiser signal: the candidate discusses iterative deepening depth-first search (IDDFS) as a memory-optimal alternative to BFS for exhaustive search problems, explains why it achieves the same O(b^d) time as BFS while using only O(d) memory like DFS, and identifies when it is preferable (large search spaces where the branching factor is wide and memory is the bottleneck). This demonstrates algorithmic breadth beyond the standard backtracking template.
