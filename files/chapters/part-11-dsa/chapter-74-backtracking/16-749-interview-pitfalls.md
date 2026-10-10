## 74.14 Interview Pitfalls

### Pitfall 1: Not Making a Copy When Adding to Results

**Failure mode**: a "subsets" solution that appends the working slice itself instead of a copy, so every stored result is a window onto one backing array that the search keeps writing through.

Be precise about the symptom, because the folk version ("all results come back empty") is not what happens and looking for it will mislead you. `subsetsBad([]int{1, 2, 3})` returns `[[] [1] [1 2] [3 3 3] [3 3] [3] [3 3] [3]]`. The first three entries are correct, the rest are garbage, and the count is right. Entries that were stored before `append` last grew the backing array kept their own copy by luck - everything after shares one array. The output looks plausible at the front, which is exactly why this reaches the "I'm done" moment.

```go
// ❌ WRONG: Adding slice reference, not copy
func subsetsBad(nums []int) [][]int {
    var result [][]int
    var current []int

    var backtrack func(start int)
    backtrack = func(start int) {
        result = append(result, current)  // BUG: Same reference!

        for i := start; i < len(nums); i++ {
            // Not this line: truncating only shortens the local header.
            // The append BELOW is what writes through the shared array and
            // silently rewrites results already stored.
            current = append(current, nums[i])
            backtrack(i + 1)
            current = current[:len(current)-1]
        }
    }

    backtrack(0)
    return result // entries that share a backing array read back corrupted
}

// ✅ CORRECT: Make a copy before storing
func subsetsGood(nums []int) [][]int {
    var result [][]int
    var current []int

    var backtrack func(start int)
    backtrack = func(start int) {
        // Make a COPY of current slice
        subset := make([]int, len(current))
        copy(subset, current)
        result = append(result, subset)

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

### Pitfall 2: Not Handling Duplicates in Input

**Failure mode**: a permutation solution that emits repeats when the input has repeated elements. On `[1,1,2]` the two 1s are distinct *positions* but identical *values*, so swapping which one is placed first produces the same permutation twice. The naive version returns 6 results where only 3 are distinct. When a problem says "unique permutations," the deduplication has to happen in the search, not in a post-pass.

```go
// ❌ WRONG: Generates duplicate permutations
func permuteUniqueBad(nums []int) [][]int {
    var result [][]int
    used := make([]bool, len(nums))

    var backtrack func(current []int)
    backtrack = func(current []int) {
        if len(current) == len(nums) {
            result = append(result, append([]int{}, current...))
            return
        }

        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }
            used[i] = true
            current = append(current, nums[i])
            backtrack(current)
            current = current[:len(current)-1]
            used[i] = false
        }
    }

    backtrack([]int{})
    return result  // Contains duplicates for [1,1,2]
}

import "slices"

// ✅ CORRECT: Sort first, skip same-level duplicates.
// Note this reorders the caller's slice. Sort a copy if that matters.
func permuteUniqueGood(nums []int) [][]int {
    slices.Sort(nums) // required: the guard below needs equal values adjacent
    var result [][]int
    used := make([]bool, len(nums))

    var backtrack func(current []int)
    backtrack = func(current []int) {
        if len(current) == len(nums) {
            result = append(result, append([]int{}, current...))
            return
        }

        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }
            // Skip duplicates at same level
            // Only use first occurrence of each value at each position
            if i > 0 && nums[i] == nums[i-1] && !used[i-1] {
                continue
            }

            used[i] = true
            current = append(current, nums[i])
            backtrack(current)
            current = current[:len(current)-1]
            used[i] = false
        }
    }

    backtrack([]int{})
    return result
}
```

### Pitfall 3: Forgetting to Undo the Choice (Backtrack Step)

**Failure mode**: an N-Queens solution that never removes the queen after exploring, so queens from abandoned attempts stay on the board and poison every later validity check.

The symptom is more brutal than "it finds fewer solutions." Run it: `solveNQueensBad` returns **0** for n=4, 6, 7 and 8, and 1 for n=5, against the correct 2, 4, 40, 92 and 10. It does not find the first solution and stop. It mostly finds nothing at all, because the leftover queens block every column and diagonal the search still needs. A function that confidently reports "there are no solutions to 8-Queens" is the failure here, and note that it never panics and never loops forever. It just answers a different question.

```go
// isValid is the row-by-row check from section 74.6: scan the column and
// the two upward diagonals for an existing 'Q'.
func isValid(board [][]byte, row, col int) bool

// ❌ WRONG: Not undoing the choice
func solveNQueensBad(n int) int {
    board := make([][]byte, n)
    for i := range board {
        board[i] = make([]byte, n)
        for j := range board[i] {
            board[i][j] = '.'
        }
    }

    count := 0
    var backtrack func(row int)
    backtrack = func(row int) {
        if row == n {
            count++
            return
        }

        for col := 0; col < n; col++ {
            if isValid(board, row, col) {
                board[row][col] = 'Q'
                backtrack(row + 1)
                // BUG: Forgot to remove queen!
            }
        }
    }

    backtrack(0)
    return count // returns 0 for n=4,6,7,8 and 1 for n=5: finds almost nothing
}

// ✅ CORRECT: Always undo the choice
func solveNQueensGood(n int) int {
    board := make([][]byte, n)
    for i := range board {
        board[i] = make([]byte, n)
        for j := range board[i] {
            board[i][j] = '.'
        }
    }

    count := 0
    var backtrack func(row int)
    backtrack = func(row int) {
        if row == n {
            count++
            return
        }

        for col := 0; col < n; col++ {
            if isValid(board, row, col) {
                board[row][col] = 'Q'  // Make choice
                backtrack(row + 1)
                board[row][col] = '.'  // UNDO choice!
            }
        }
    }

    backtrack(0)
    return count
}
```

### Pitfall 4: Inefficient Validity Check in Each Recursion

**Failure mode**: a Sudoku solver that rescans the board on every placement. `isValidSudoku` loops 9 times reading 3 cells each, so it touches 27 cells per candidate digit, up to 9 candidates per cell, at every node of the search. It is correct and it is constant-factor slow in the hottest possible place. The fix is to maintain sets of used digits per row, column, and box, updated in the choose/unchoose steps, turning the scan into three lookups.

```go
// ❌ SLOW: 27 cell reads per candidate digit, at every node
func solveSudokuBad(board [][]byte) bool {
    for i := 0; i < 9; i++ {
        for j := 0; j < 9; j++ {
            if board[i][j] == '.' {
                for c := byte('1'); c <= '9'; c++ {
                    if isValidSudoku(board, i, j, c) {  // O(27) check
                        board[i][j] = c
                        if solveSudokuBad(board) {
                            return true
                        }
                        board[i][j] = '.'
                    }
                }
                return false
            }
        }
    }
    return true
}

// ✅ CORRECT: O(1) check using precomputed sets
func solveSudokuGood(board [][]byte) bool {
    rows := make([]map[byte]bool, 9)
    cols := make([]map[byte]bool, 9)
    boxes := make([]map[byte]bool, 9)

    for i := 0; i < 9; i++ {
        rows[i] = make(map[byte]bool)
        cols[i] = make(map[byte]bool)
        boxes[i] = make(map[byte]bool)
    }

    // Pre-populate with existing numbers
    for i := 0; i < 9; i++ {
        for j := 0; j < 9; j++ {
            if board[i][j] != '.' {
                num := board[i][j]
                rows[i][num] = true
                cols[j][num] = true
                boxes[(i/3)*3+j/3][num] = true
            }
        }
    }

    var solve func() bool
    solve = func() bool {
        for i := 0; i < 9; i++ {
            for j := 0; j < 9; j++ {
                if board[i][j] == '.' {
                    boxIdx := (i/3)*3 + j/3
                    for c := byte('1'); c <= '9'; c++ {
                        // O(1) validity check!
                        if !rows[i][c] && !cols[j][c] && !boxes[boxIdx][c] {
                            board[i][j] = c
                            rows[i][c] = true
                            cols[j][c] = true
                            boxes[boxIdx][c] = true

                            if solve() {
                                return true
                            }

                            board[i][j] = '.'
                            rows[i][c] = false
                            cols[j][c] = false
                            boxes[boxIdx][c] = false
                        }
                    }
                    return false
                }
            }
        }
        return true
    }

    return solve()
}
```

### Pitfall 5: Wrong Starting Index for Combinations vs Permutations

**Failure mode**: a permutation solution built on a `start` index instead of a `used` array. The `start` index is what forbids revisiting earlier elements, which is exactly the property permutations must *not* have.

Check what it actually returns before trusting the usual description. `permuteBad([]int{1, 2, 3})` gives `[[1 2 3]]`: one result, not six. It does not "return combinations" either. Because only paths reaching length n are collected, and the start index forces indices to strictly increase, the single surviving path is the input in its original order. The answer count is off by a factor of n!, and on a sorted input the one result it does return is correct, which is the worst possible kind of wrong.

```go
// ❌ WRONG: Using combination logic for permutations
func permuteBad(nums []int) [][]int {
    var result [][]int

    var backtrack func(start int, current []int)
    backtrack = func(start int, current []int) {  // start is wrong here!
        if len(current) == len(nums) {
            result = append(result, append([]int{}, current...))
            return
        }

        for i := start; i < len(nums); i++ {  // BUG: Should start from 0!
            current = append(current, nums[i])
            backtrack(i+1, current)
            current = current[:len(current)-1]
        }
    }

    backtrack(0, []int{})
    return result // returns exactly ONE result: the input in its own order
}

// ✅ CORRECT: Permutations start from 0 with used tracking
func permuteGood(nums []int) [][]int {
    var result [][]int
    used := make([]bool, len(nums))

    var backtrack func(current []int)
    backtrack = func(current []int) {
        if len(current) == len(nums) {
            result = append(result, append([]int{}, current...))
            return
        }

        for i := 0; i < len(nums); i++ {  // Always start from 0
            if used[i] {
                continue  // Skip already used elements
            }
            used[i] = true
            current = append(current, nums[i])
            backtrack(current)
            current = current[:len(current)-1]
            used[i] = false
        }
    }

    backtrack([]int{})
    return result
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| No copy when storing | Right count, tail entries corrupted | `append(result, append([]int(nil), path...))` |
| Duplicates in input | Duplicate results | Sort first, skip same-level duplicates |
| Forgetting to backtrack | Far too few results, often ZERO | Always undo the choice after recursion |
| Scanning validity check | Correct but slow at every node | Precompute - sets or bitmasks for O(1) |
| Wrong loop start | Answer count off by a factor of n! | Combos: `start`. Perms: `used[]` |
| Over-pruning | Silently missing valid answers | Prove the prune only cuts dead branches |
| Not pruning early | Times out on large inputs | Check validity before recursing |

### Junior → FAANG: Converting Pitfall Knowledge Into Interview Insurance

The five pitfalls above are the five most likely sources of failure in a backtracking interview. Convert them into a post-implementation checklist that you run before claiming your solution is complete.

Pitfall 1 (no copy): scan your code for every `result = append(result, ...)` and verify you are appending a newly allocated slice or string.

Pitfall 2 (duplicates): scan your code for any sorting step. If the input contains duplicates and the problem asks for unique results, you need both sorting and the `i > start && nums[i] == nums[i-1]` guard.

Pitfall 3 (forgetting to backtrack): scan your code for every state-modification step (append, set to true, set to 'Q', etc.) and verify there is a corresponding reversal step in the same function scope after the recursive call.

Pitfall 4 (O(n) validity): for constraint satisfaction problems (N-Queens, Sudoku), identify the validity check and verify it is O(1). If it contains a loop, consider whether a precomputed constraint set can eliminate it.

Pitfall 5 (wrong loop start): identify whether the problem is a combination (start index, order does not matter) or a permutation (used array, order matters). The diagnostic is: do [1,2] and [2,1] count as different answers?

### Senior @ FAANG: Pitfall Prevention as a Platform Security Concern

Pitfall 3 (forgetting to backtrack) is particularly dangerous in production systems that use backtracking on shared mutable data structures. If a backtracking implementation modifies a shared data structure (e.g., a shared resource allocation table) and fails to restore it on backtrack, the system's global state becomes corrupted. This is not just a correctness bug but a consistency violation that can affect other components of the system.

Production backtracking on shared state should use one of two approaches. First, copy-on-write: operate on a copy of the shared structure within each branch, discarding the copy on backtrack. This is safe but memory-intensive. Second, transaction-with-rollback: make changes to the shared structure with explicit rollback capabilities (similar to a database transaction). The "place and remove" pattern in N-Queens (set to 'Q', recurse, set to '.') is the simplest form of transaction-with-rollback.

Pitfall 4 (O(n) validity) becomes a platform security concern when the backtracking is exposed to user-controlled input and the validity check scales with input size. An adversary can craft inputs where the validity check is always slow (e.g., a Sudoku board where every digit is invalid for every cell, causing 9 * O(27) checks per cell before determining unsolvability). Precomputed constraint sets eliminate this attack surface by making the validity check O(1) regardless of board configuration.

### Junior → FAANG: Pitfalls as a Post-Implementation Review Protocol

The five pitfalls in this file define a 5-minute post-implementation review you must complete before declaring your backtracking solution ready. Run this review after writing the code but before running any tests.

Pitfall 1 (no copy): find every `result = append(result, ...)` line. Is the argument a newly allocated slice? If it contains the word `path` or `current` without `append([]int{}, ...)` wrapping, it is wrong.

Pitfall 2 (duplicates in input): re-read the problem statement. Does it say "with duplicates" or "may contain duplicates"? If yes, do you sort before backtracking and do you have the `i > start && nums[i] == nums[i-1]` guard?

Pitfall 3 (forgetting to backtrack): find every state modification (`used[i] = true`, `board[row][col] = 'Q'`, `path = append(path, x)`). Is there a corresponding reversal immediately after the recursive call?

Pitfall 4 (scanning validity): find the validity check. Does it loop over previously placed elements? If yes, can a set or bitmask lookup replace it?

Pitfall 5 (wrong loop start): is this a combination problem (start index, order does not matter) or a permutation problem (used array, order matters)? Verify your choice matches the problem, and check the *count* of your output, not just its contents: this bug returns answers that are individually valid and collectively far too few.

### Senior @ FAANG: Production Pitfall Prevention Architecture

The five pitfalls map to five categories of automated checks that can be added to the development pipeline for teams that use backtracking extensively.

Static analysis for pitfall 1: a custom `go vet` analyzer that detects `append(result, slice)` where `slice` is not a literal or a copy expression. This catches the most common form of the aliasing bug at compile time.

Test coverage for pitfall 2: require that any test suite for a backtracking function includes at least one test case with duplicate input elements and verifies that the result contains no duplicate entries. This is a mechanical test requirement that can be checked in CI.

Code review template for pitfall 3: the PR template for backtracking code should include a checkbox: "Every state modification has a corresponding reversal in the same scope." Reviewers explicitly check this before approving.

Benchmarks for pitfall 4: require a benchmark test for any validity function that is called inside a recursive loop. If the benchmark shows more than O(log n) scaling with problem size, the function must be redesigned or justified with a comment explaining why the cost is acceptable.

Integration test for pitfall 5: require a test case that verifies the result count matches the expected combinatorial formula (C(n, k) for combinations, n! for permutations, 2^n for subsets). A wrong start-index choice will produce the wrong count, and this test catches it immediately.

---
