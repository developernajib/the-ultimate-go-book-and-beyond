## 74.6 Classic Backtracking Problems

### N-Queens

The N-Queens problem places n non-attacking queens on an n×n board by building the solution row by row. Placing exactly one queen per row disposes of the row constraint for free, leaving only columns and diagonals to check. The board string is built only when a full n-row solution is reached, so partial paths cost nothing to represent.

The two implementations below deliberately differ in how they check conflicts, and the contrast is the point. `SolveNQueens` scans the previously placed queens with a loop, which is O(n) per check and reads exactly like the constraint it enforces. `TotalNQueens` keeps three sets (`cols`, `diag1` keyed on `row-col`, `diag2` keyed on `row+col`) and answers the same question in O(1). The set version is what you want in an interview once correctness is established. The scan version is the one to write first, because it is obviously right, and "obviously right" is worth more at minute five than a constant factor is at minute forty.

The diagonal keys are the part worth understanding rather than memorizing. Every cell on a given top-left-to-bottom-right diagonal shares the same value of `row - col`, and every cell on an anti-diagonal shares the same `row + col`. That is why two integers identify a queen's diagonals completely. In Go, `row - col` ranges over negative values, which is exactly why the code uses maps rather than plain slices: a slice would need an offset of `+n` to keep the index non-negative, and forgetting that offset is a classic index-out-of-range.

```go
// SolveNQueens places n queens on n×n board
// LeetCode 51: N-Queens
// Time: O(n! * n) with this O(n) isValid scan, and O(n!) is the usual
// shorthand. Both are upper bounds that pruning never approaches: for
// n=8 this explores 2057 nodes against 8! = 40320, and returns 92 boards.
// Quote O(n!) as the bound, but know it is loose by orders of magnitude.
// Space: O(n) for the board plus O(n) recursion depth.
func SolveNQueens(n int) [][]string {
    result := [][]string{}
    board := make([]int, n) // board[row] = column of queen in that row

    // Check if placing queen at (row, col) is valid
    isValid := func(row, col int) bool {
        for i := 0; i < row; i++ {
            // Same column
            if board[i] == col {
                return false
            }
            // Same diagonal
            if abs(board[i]-col) == abs(i-row) {
                return false
            }
        }
        return true
    }

    // Convert board to string representation
    boardToStrings := func() []string {
        result := make([]string, n)
        for i := 0; i < n; i++ {
            row := make([]byte, n)
            for j := 0; j < n; j++ {
                if board[i] == j {
                    row[j] = 'Q'
                } else {
                    row[j] = '.'
                }
            }
            result[i] = string(row)
        }
        return result
    }

    var backtrack func(row int)
    backtrack = func(row int) {
        if row == n {
            result = append(result, boardToStrings())
            return
        }

        for col := 0; col < n; col++ {
            if isValid(row, col) {
                board[row] = col
                backtrack(row + 1)
                // No need to reset board[row] as it will be overwritten
            }
        }
    }

    backtrack(0)
    return result
}

func abs(x int) int {
    if x < 0 {
        return -x
    }
    return x
}

// TotalNQueens counts number of solutions
// LeetCode 52: N-Queens II
func TotalNQueens(n int) int {
    count := 0
    cols := make(map[int]bool)    // columns used
    diag1 := make(map[int]bool)   // row - col diagonals
    diag2 := make(map[int]bool)   // row + col anti-diagonals

    var backtrack func(row int)
    backtrack = func(row int) {
        if row == n {
            count++
            return
        }

        for col := 0; col < n; col++ {
            if cols[col] || diag1[row-col] || diag2[row+col] {
                continue
            }

            cols[col] = true
            diag1[row-col] = true
            diag2[row+col] = true

            backtrack(row + 1)

            cols[col] = false
            diag1[row-col] = false
            diag2[row+col] = false
        }
    }

    backtrack(0)
    return count
}
```

### Sudoku Solver

LeetCode 37 asks you to fill every `'.'` cell with a digit that satisfies all row, column, and 3×3 box constraints. The `solve` function scans for the first empty cell and tries digits `'1'`-`'9'` in order, placing a digit only if `isValidSudoku` confirms it is legal, then recursing. If the recursion returns `false` (no digit works), it resets the cell to `'.'` and backtracks. The 3×3 box check uses the formula `3*(row/3) + i/3` and `3*(col/3) + i%3` to map a linear index `i` onto the nine cells of the appropriate box.

```go
// SolveSudoku fills a 9x9 sudoku board
// LeetCode 37: Sudoku Solver
func SolveSudoku(board [][]byte) {
    solve(board)
}

func solve(board [][]byte) bool {
    for i := 0; i < 9; i++ {
        for j := 0; j < 9; j++ {
            if board[i][j] == '.' {
                for c := byte('1'); c <= '9'; c++ {
                    if isValidSudoku(board, i, j, c) {
                        board[i][j] = c

                        if solve(board) {
                            return true
                        }

                        board[i][j] = '.' // backtrack
                    }
                }
                return false // no valid number found
            }
        }
    }
    return true // all cells filled
}

func isValidSudoku(board [][]byte, row, col int, c byte) bool {
    for i := 0; i < 9; i++ {
        // Check row
        if board[row][i] == c {
            return false
        }
        // Check column
        if board[i][col] == c {
            return false
        }
        // Check 3x3 box
        boxRow := 3*(row/3) + i/3
        boxCol := 3*(col/3) + i%3
        if board[boxRow][boxCol] == c {
            return false
        }
    }
    return true
}
```

### Generate Parentheses

LeetCode 22 generates all well-formed combinations of `n` pairs of parentheses using two counters (`open` and `close`) to enforce validity at every step rather than generating and filtering afterward. An open paren is appended whenever `open < n`, and a close paren is appended whenever `close < open` (ensuring we never close more than we have opened). The recursion terminates when the string reaches length `2*n`, guaranteeing only balanced combinations are collected.

```go
// GenerateParenthesis generates valid parentheses combinations
// LeetCode 22: Generate Parentheses
// Time: O(4^n / sqrt(n)), Space: O(n)
func GenerateParenthesis(n int) []string {
    result := []string{}

    var backtrack func(current string, open, close int)
    backtrack = func(current string, open, close int) {
        if len(current) == 2*n {
            result = append(result, current)
            return
        }

        if open < n {
            backtrack(current+"(", open+1, close)
        }
        if close < open {
            backtrack(current+")", open, close+1)
        }
    }

    backtrack("", 0, 0)
    return result
}
```

### Letter Combinations of Phone Number

LeetCode 17 maps each digit to its T9 phone keypad letters and uses backtracking to build every possible combination character by character. At each recursive call, the current digit selects its letter set from the map and each letter is appended to the growing string before recursing on the next digit index. When the index reaches the end of the input, the fully built combination is appended to the results.

```go
// LetterCombinations returns phone number letter combinations
// LeetCode 17: Letter Combinations of a Phone Number
func LetterCombinations(digits string) []string {
    if len(digits) == 0 {
        return []string{}
    }

    mapping := map[byte]string{
        '2': "abc", '3': "def", '4': "ghi", '5': "jkl",
        '6': "mno", '7': "pqrs", '8': "tuv", '9': "wxyz",
    }

    result := []string{}

    var backtrack func(index int, current string)
    backtrack = func(index int, current string) {
        if index == len(digits) {
            result = append(result, current)
            return
        }

        letters := mapping[digits[index]]
        for i := 0; i < len(letters); i++ {
            backtrack(index+1, current+string(letters[i]))
        }
    }

    backtrack(0, "")
    return result
}
```

### Junior → FAANG: Classic Problems as Interview Anchors

N-Queens, Sudoku, Generate Parentheses, and Letter Combinations are the four problems that almost every backtracking-focused interview draws from. Mastering all four means you can handle any question that belongs to one of their structural categories.

N-Queens tests constraint satisfaction with O(1) validity checking. The key interview signal is using hash maps or bitsets (rather than linear scans through placed queens) for column and diagonal conflict detection. If you use the O(n) linear validity check (`isValid` that loops through all rows), mention it is O(n) and that a hash-set approach would reduce it to O(1).

Sudoku tests constraint satisfaction across multiple overlapping constraint sets (row, column, box). The box index formula `(row/3)*3 + col/3` is worth memorizing exactly. Interviewers check whether you implement the box constraint correctly, and getting it wrong is an immediate red flag.

Generate Parentheses tests validity-as-you-build rather than validity-after-building. The `open < n` and `close < open` guards ensure that only valid strings are ever constructed, eliminating the need to generate and filter. This "build valid, not filter invalid" principle is the efficiency insight.

Letter Combinations is the simplest of the four and the most common at the phone screen level. Know the mapping and know that the string `current + string(letters[i])` approach (which creates a new string at each level) can be replaced with a byte slice for efficiency, reducing string allocation from O(n^2) total to O(n).

### Senior @ FAANG: Classic Problems as System Design Analogues

N-Queens is the canonical model for constraint satisfaction problems (CSPs) in general. Production scheduling systems (assign jobs to machines respecting resource constraints), configuration validation (select a set of options respecting compatibility constraints), and network routing (route traffic respecting bandwidth and latency constraints) all have the same structure. The N-Queens backtracking algorithm is the baseline - production CSP solvers (Choco, OptaPlanner, Google OR-Tools) add forward checking, constraint propagation, and intelligent variable ordering on top of the same backtracking skeleton.

Sudoku solving is used in production for puzzle generation (generating a valid puzzle by starting from a solved board and removing numbers), for testing constraint propagation algorithms, and as a benchmark for CSP solver performance. The MRV (Minimum Remaining Values) heuristic shown in the `solveMRV` function of the Sudoku Solver exercise is the standard heuristic used in production CSP solvers: always fill the cell with the fewest valid choices first, because it reduces the branching factor at the most constrained points in the search and prunes dead ends earlier.

Generate Parentheses generalizes to any problem of generating well-formed strings from a formal grammar: generating valid XML tags, valid arithmetic expressions, valid code snippets. The build-valid-not-filter-invalid principle applies to all of these and is the foundation of grammar-directed test case generation in fuzzing tools.

The Letter Combinations byte-slice optimization is worth quantifying: for a 10-digit phone number (maximum depth 10), each level creates a new string of length up to 10, costing O(10) per level and O(10^2) total allocation versus O(10) with a byte slice. At scale (many concurrent requests generating combinations), this difference accumulates and can affect GC pressure. Measuring this with pprof before and after the optimization is the correct production discipline.

### Junior → FAANG: Mastering the Four Classic Problems as Interview Anchors

The four classic problems (N-Queens, Sudoku, Generate Parentheses, Letter Combinations) represent four distinct interview patterns. Mastery means: you can start coding any of them within 60 seconds of reading the problem, you can name the key constraint check before writing it, and you can state the time and space complexity without hesitation.

N-Queens key facts: row-by-row traversal eliminates the row constraint automatically, so you only need to check column and diagonal. The diagonal constraint uses `row - col` (same value on the same diagonal) and `row + col` (same value on the same anti-diagonal). Hash maps or arrays of size 2*n hold these. Time: O(n!), effective complexity much lower due to pruning.

Sudoku key facts: three overlapping constraint sets (row, column, box). Box index formula: `(row/3)*3 + col/3`. The solver returns a boolean because it is a decision problem (find any valid solution), not an enumeration problem. The backtrack step is `board[i][j] = '.'`. Time: O(9^e) where e is the number of empty cells.

Generate Parentheses key fact: build valid strings directly rather than filtering. The two guards (`open < n` and `close < open`) ensure every string built is valid, so no branch is ever wasted on something that will be thrown away. Note there is no visible unchoose step, and the reason is worth knowing: `current` is a Go string, which is immutable and passed by value, so each call gets its own logical copy and there is nothing to restore. The undo is free because the state was never shared. Swap `current` for a `[]byte` for efficiency and the unchoose step reappears immediately, because now it is shared. The number of valid strings is the n-th Catalan number, C(2n, n) / (n+1), which is 1, 1, 2, 5, 14, 42 for n = 0 through 5.

Letter Combinations key fact: it is the simplest of the four, appearing at phone screens. Use a byte slice instead of string concatenation to avoid O(n^2) total allocation. The branching factor is at most 4 (for digits 7 and 9), giving O(4^n) time.

### Senior @ FAANG: Classic Problems as a CSP Solver Benchmark Suite

The four classic problems serve as the benchmark suite for evaluating constraint satisfaction solver implementations. Any production CSP solver should reproduce the correct results for all four problems before being deployed. This benchmark suite is valuable because the four problems have genuinely different constraint structures: N-Queens is pure binary constraints (every rule relates exactly two queens, no two sharing a column or diagonal), Sudoku is all-different constraints over 9 variables at a time with each cell sitting in three of them at once, Generate Parentheses is an ordering constraint on a running counter rather than on any pair of positions, and Letter Combinations has no constraints at all and is pure enumeration.

That spread is what makes the suite meaningful: it covers pairwise constraints, overlapping group constraints, prefix-validity constraints, and the unconstrained baseline. A solver that handles all four has been exercised on structurally distinct search shapes rather than on four flavors of the same one.

For performance benchmarking, each problem should be run at multiple scales: N-Queens for n=8, 12, 15 - Sudoku for 25%, 50%, 75% empty cells - Generate Parentheses for n=5, 8, 10 - Letter Combinations for 4, 7, 10 digits. The scaling curves reveal whether the solver's pruning is effective across the full input range or only for the specific scale at which it was tested.
