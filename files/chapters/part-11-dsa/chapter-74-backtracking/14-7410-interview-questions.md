## 74.12 Interview Questions

### Question 1: N-Queens

The N-Queens problem places `n` queens on an `n×n` board so that no two queens share a row, column, or diagonal. Because exactly one queen is placed per row, the backtracking proceeds row by row, and validity only needs to check the rows already filled. The `isValidQueen` helper checks three directions (the column above, the upper-left diagonal, and the upper-right diagonal), which is sufficient because queens in rows below the current one have not yet been placed. This row-by-row strategy reduces the branching factor from `n²` to at most `n` per level, giving a time complexity of roughly O(n!).

```go
func solveNQueens(n int) [][]string {
    var results [][]string
    board := make([][]byte, n)
    for i := range board {
        board[i] = make([]byte, n)
        for j := range board[i] {
            board[i][j] = '.'
        }
    }

    var backtrack func(row int)
    backtrack = func(row int) {
        if row == n {
            solution := make([]string, n)
            for i := range board {
                solution[i] = string(board[i])
            }
            results = append(results, solution)
            return
        }

        for col := 0; col < n; col++ {
            if isValidQueen(board, row, col, n) {
                board[row][col] = 'Q'
                backtrack(row + 1)
                board[row][col] = '.'
            }
        }
    }

    backtrack(0)
    return results
}

func isValidQueen(board [][]byte, row, col, n int) bool {
    for i := 0; i < row; i++ {
        if board[i][col] == 'Q' {
            return false
        }
    }
    for i, j := row-1, col-1; i >= 0 && j >= 0; i, j = i-1, j-1 {
        if board[i][j] == 'Q' {
            return false
        }
    }
    for i, j := row-1, col+1; i >= 0 && j < n; i, j = i-1, j+1 {
        if board[i][j] == 'Q' {
            return false
        }
    }
    return true
}
```

### Junior → FAANG: N-Queens as the Interview Benchmark

N-Queens is the most commonly asked constraint satisfaction backtracking problem. Implement it cleanly in Go, explain the row-by-row strategy, name the upgrade from the scanning validity check to an O(1) set-based one, and get the board construction right, and you have covered the backtracking portion of most interviews.

The implementation above deliberately takes the plain route on both counts: a 2D byte board, and an `isValidQueen` that walks the column and the two upward diagonals, which is O(n) per check. It is readable and obviously correct, which is what you want first. Two upgrades are worth naming out loud. Store the board as a 1D array (`board[row] = col`), which drops the state to O(n) and makes the leaf conversion trivial. Then replace the scan with three sets keyed on `col`, `row-col`, and `row+col`, which makes each check O(1). Know all three representations and why you would reach for each.

When asked for the time complexity of N-Queens, the correct answer is O(n!), with the caveat that the bound is loose by orders of magnitude. For n=8, one-queen-per-row with distinct columns allows 8! = 40,320 arrangements, but the diagonal constraints prune so aggressively that the search visits 2,057 nodes and returns 92 boards. Quote the bound, then say it is not what happens. That pairing is the practical argument for why backtracking works here despite a factorial worst case.

The board-to-strings conversion at the end is a step candidates rush and get wrong. With the 1D representation, for each row create a byte slice of length n filled with `'.'`, set `row[board[i]] = 'Q'`, and convert to string. The `board[i]` value is the column of the queen in row i. (The code above sidesteps this by keeping the 2D board, where the conversion is just `string(board[i])`, which is one of the reasons to like the 2D form in an interview.)

### Senior @ FAANG: N-Queens as a CSP Benchmark and Research Problem

N-Queens is one of the most studied CSP benchmark problems. For large n (n > 15), backtracking without intelligent heuristics becomes too slow. Production CSP solvers use several enhancements: forward checking (eliminate values from future variables' domains as soon as a value is chosen), constraint propagation (apply arc consistency to reduce domains before search), and intelligent variable ordering (choose the next row based on which has the fewest remaining valid columns, the MRV heuristic).

Two facts about N-Queens are worth keeping straight, because they pull in opposite directions and candidates routinely merge them into one wrong claim.

*Counting* all solutions has no known closed form. The sequence (1, 0, 0, 2, 10, 4, 40, 92, 352, ... for n = 1, 2, 3, ...) is tabulated, not derived: each new term has been obtained by massive computation, which is why the known values stop in the twenties. If someone tells you there is a formula for the number of N-Queens solutions, they are thinking of something else.

*Finding one* solution is easy, and that is the surprise. Explicit constructions place n queens directly with no search at all, in O(n): for n not congruent to 2 or 3 mod 6 a simple arithmetic pattern works, and the two awkward residues have their own known constructions. So "find a valid board for n = 1000" is instant, while "count the boards for n = 30" is a research-scale computation. Knowing which side of that line a question falls on is the staff-level competency.

At FAANG, N-Queens appears in bar-raiser interviews not as a test of whether you can implement backtracking but as a canvas for deeper questions: "how would you parallelize the search?", "what is the most constrained first heuristic and how would you apply it here?", "if you needed to solve this for n=100, what algorithmic change would you make?" These follow-ups reveal whether the candidate understands the algorithm deeply or has memorized a solution.

### Junior → FAANG: N-Queens as a Complete Interview Blueprint

N-Queens is the best problem to practice as a complete end-to-end interview drill because it requires every backtracking skill: state design (1D array `board[row] = col`), constraint representation (hash maps for column and diagonal tracking), validity check (O(1) using the hash maps), make/unmake symmetry (set to true, recurse, set to false), and result construction (build the string board at the leaf). Practicing this problem from scratch in under 20 minutes, without reference material, is the benchmark for N-Queens readiness.

For the result construction step, practice the `buildBoard` function separately. The most common bug here is off-by-one in the board-to-string conversion. The safe implementation: for each row i, create a byte slice of length n filled with `'.'`, set `row[board[i]] = 'Q'`, convert to string. Verify with n=4 by printing each row separately before collecting into the result.

After implementing N-Queens, practice this follow-up: "how would you modify your solution to count solutions instead of listing them?" The change is minimal: replace `result = append(result, buildBoard(...))` with `count++` and remove the `buildBoard` function. Being able to make this modification in under 30 seconds shows you understand what each part of your implementation does.

### Senior @ FAANG: N-Queens Parallelization as a System Design Exercise

The N-Queens parallelization question is a rich system design exercise at the staff level. The search tree can be parallelized by assigning each possible first-row column (columns 0 to n-1) to a separate goroutine, then collecting the results. This naive parallelization gives an n-fold speedup on an n-core machine for small n.

The more interesting question is: for large n (n=20), the first-row split gives only 20 sub-problems, each still enormous, and they are not equal in size, so the machine finishes 19 of them and waits on the last. A better split enumerates all valid first-*two*-row placements and hands each to a goroutine. Count them honestly: the second queen must avoid the first queen's column and its two diagonals, which rules out at most 3 columns, so the number of valid pairs is n*(n-3) + 2 (the +2 because the two edge columns exclude only 2 columns rather than 3). That is 42 tasks at n=8 and 342 at n=20, roughly an order of magnitude more than the first-row split, which is what makes the load balancing work. Note this is a scheduling win, not an algorithmic one: the total tree is the same size, it is just carved into enough pieces that idle cores can steal work.

The result collection from parallel goroutines requires a mutex or channel. Using a channel (each goroutine sends its sub-results on a shared result channel) avoids the mutex and integrates naturally with Go's concurrency model. The main goroutine collects from the channel until all sub-problems are complete (tracked by a `sync.WaitGroup`). This pattern is the production Go idiom for parallel backtracking.

---
