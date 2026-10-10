## 78C.10 Backtracking

Backtracking explores all candidates and abandons paths that violate constraints. The template is: choose, explore, unchoose.

---
### LC 78 - Subsets 🟡

**Key Insight**: At each element, choose to include it or not, building all 2^n combinations.

```go
func subsets(nums []int) [][]int {
    var result [][]int
    var current []int

    var backtrack func(start int)
    backtrack = func(start int) {
        tmp := make([]int, len(current))
        copy(tmp, current)
        result = append(result, tmp)

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
**Time**: O(n × 2^n).
**Space**: O(n) for the recursion depth.

---
### LC 46 - Permutations 🟡

**Key Insight**: Swap each element into the current position and recurse on the remaining elements.

```go
func permute(nums []int) [][]int {
    var result [][]int

    var backtrack func(start int)
    backtrack = func(start int) {
        if start == len(nums) {
            tmp := make([]int, len(nums))
            copy(tmp, nums)
            result = append(result, tmp)
            return
        }
        for i := start; i < len(nums); i++ {
            nums[start], nums[i] = nums[i], nums[start]
            backtrack(start + 1)
            nums[start], nums[i] = nums[i], nums[start]
        }
    }

    backtrack(0)
    return result
}
```
**Time**: O(n × n!).
**Space**: O(n).

---
### LC 39 - Combination Sum 🟡

**Key Insight**: Include the current candidate (reuse allowed) or skip it. Sorting enables early termination.

```go
func combinationSum(candidates []int, target int) [][]int {
    sort.Ints(candidates)
    var result [][]int
    var current []int

    var backtrack func(start, remaining int)
    backtrack = func(start, remaining int) {
        if remaining == 0 {
            tmp := make([]int, len(current))
            copy(tmp, current)
            result = append(result, tmp)
            return
        }
        for i := start; i < len(candidates); i++ {
            if candidates[i] > remaining {
                break
            }
            current = append(current, candidates[i])
            backtrack(i, remaining-candidates[i])
            current = current[:len(current)-1]
        }
    }

    backtrack(0, target)
    return result
}
```
**Time**: O(n^(target/min)).
**Space**: O(target/min) for the recursion depth.

---
### LC 17 - Letter Combinations of a Phone Number 🟡

**Key Insight**: Map each digit to its letters. Build combinations by appending one letter per digit.

```go
func letterCombinations(digits string) []string {
    if len(digits) == 0 {
        return nil
    }

    phone := map[byte]string{
        '2': "abc", '3': "def", '4': "ghi", '5': "jkl",
        '6': "mno", '7': "pqrs", '8': "tuv", '9': "wxyz",
    }

    var result []string
    var backtrack func(idx int, current []byte)
    backtrack = func(idx int, current []byte) {
        if idx == len(digits) {
            result = append(result, string(current))
            return
        }
        for _, ch := range phone[digits[idx]] {
            backtrack(idx+1, append(current, byte(ch)))
        }
    }

    backtrack(0, nil)
    return result
}
```
**Time**: O(4^n) where n = len(digits).
**Space**: O(n).

---
### LC 22 - Generate Parentheses 🟡

**Key Insight**: Track open and close counts. Add an open bracket if open < n, add a close bracket if close < open.

```go
func generateParenthesis(n int) []string {
    var result []string

    var backtrack func(current []byte, open, close int)
    backtrack = func(current []byte, open, close int) {
        if len(current) == 2*n {
            result = append(result, string(current))
            return
        }
        if open < n {
            backtrack(append(current, '('), open+1, close)
        }
        if close < open {
            backtrack(append(current, ')'), open, close+1)
        }
    }

    backtrack(nil, 0, 0)
    return result
}
```
**Time**: O(4^n / sqrt(n)), the Catalan number.
**Space**: O(n).

---
### LC 79 - Word Search 🟡

**Key Insight**: DFS from each cell matching the first letter. Mark cells visited during the path to avoid reuse.

```go
func exist(board [][]byte, word string) bool {
    rows, cols := len(board), len(board[0])

    var dfs func(r, c, idx int) bool
    dfs = func(r, c, idx int) bool {
        if idx == len(word) {
            return true
        }
        if r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] != word[idx] {
            return false
        }

        tmp := board[r][c]
        board[r][c] = '#' // mark visited

        found := dfs(r+1, c, idx+1) || dfs(r-1, c, idx+1) ||
            dfs(r, c+1, idx+1) || dfs(r, c-1, idx+1)

        board[r][c] = tmp // restore
        return found
    }

    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if dfs(r, c, 0) {
                return true
            }
        }
    }
    return false
}
```
**Time**: O(m × n × 4^L) where L = word length.
**Space**: O(L) for the recursion depth.

---
### LC 131 - Palindrome Partitioning 🟡

**Key Insight**: At each position, try all possible palindrome prefixes and recurse on the remainder.

```go
func partition(s string) [][]string {
    var result [][]string
    var current []string

    var backtrack func(start int)
    backtrack = func(start int) {
        if start == len(s) {
            tmp := make([]string, len(current))
            copy(tmp, current)
            result = append(result, tmp)
            return
        }
        for end := start + 1; end <= len(s); end++ {
            if isPalindrome(s, start, end-1) {
                current = append(current, s[start:end])
                backtrack(end)
                current = current[:len(current)-1]
            }
        }
    }

    backtrack(0)
    return result
}

func isPalindrome(s string, l, r int) bool {
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
**Time**: O(n × 2^n).
**Space**: O(n).

---
### LC 51 - N-Queens 🔴

**Key Insight**: Place queens row by row. Track occupied columns and diagonals to prune invalid placements.

```go
func solveNQueens(n int) [][]string {
    var result [][]string
    board := make([][]byte, n)
    for i := range board {
        board[i] = make([]byte, n)
        for j := range board[i] {
            board[i][j] = '.'
        }
    }

    cols := make(map[int]bool)
    diag1 := make(map[int]bool) // row - col
    diag2 := make(map[int]bool) // row + col

    var backtrack func(row int)
    backtrack = func(row int) {
        if row == n {
            solution := make([]string, n)
            for i := range board {
                solution[i] = string(board[i])
            }
            result = append(result, solution)
            return
        }
        for col := 0; col < n; col++ {
            if cols[col] || diag1[row-col] || diag2[row+col] {
                continue
            }
            board[row][col] = 'Q'
            cols[col] = true
            diag1[row-col] = true
            diag2[row+col] = true

            backtrack(row + 1)

            board[row][col] = '.'
            delete(cols, col)
            delete(diag1, row-col)
            delete(diag2, row+col)
        }
    }

    backtrack(0)
    return result
}
```
**Time**: O(n!).
**Space**: O(n²).

---

### Junior → FAANG: Choose-Explore-Unchoose Without Undo Bugs

Backtracking correctness requires that the "unchoose" step perfectly reverses the "choose" step. In Go it also requires one rule that costs more candidates their offer than any other: **copy the path before you store it**.

The trap is that `result = append(result, path)` stores a slice header, not the elements. Every stored header can point into one shared backing array, so later recursion overwrites results you already "saved". Passing `append(path, val)` down the recursion does not save you: when `cap(path) > len(path)`, `append` writes into the same backing array rather than allocating a new one. Pre-size the path with `make([]int, 0, len(nums))` and the subsets of `[1 2 3]` come back as `[[] [3] [3 3] [3 3 3] [3 3] [3] [3 3] [3]]`, which is every result aliased onto the same memory. Nothing panics and no test fails at the point of the bug.

What makes this vicious is that the same code appears to work when `path` starts as `nil`, because each append hits capacity and reallocates. The bug then surfaces only after someone adds a harmless-looking pre-allocation.

The reliable rule: snapshot at the moment you record a result.

```go
result = append(result, append([]int(nil), current...))
```

Every solution above follows it. Subsets, Combination Sum, and Palindrome Partitioning copy explicitly into a fresh slice before appending to `result`. Letter Combinations and Generate Parentheses look like exceptions, but `string(current)` allocates a new string from the bytes, which is the same snapshot by another name. Storing a raw `[]byte` there instead of converting would reintroduce the bug immediately.

The shared-slice-plus-truncate structure those solutions use also needs `current = current[:len(current)-1]` as the exact undo step. Forgetting it produces wrong answers silently, with no panic to point at the line.

N-Queens is the hardest backtracking problem in this section. The three constraint sets (no two queens in the same column, no two in the same forward diagonal, no two in the same backward diagonal) can each be tracked with a boolean slice indexed by column, by `row-col+n-1` (forward diagonal), and by `row+col` (backward diagonal). Practice computing these indices until they are automatic. The key insight is that diagonals have a fixed index based on the row and column, so you can check all three constraints in O(1) without scanning the board.

### Senior @ FAANG: Backtracking in Configuration Search and Test Generation

Automated test generation systems use backtracking to construct minimal counterexamples for property-based tests. Given a set of constraints (the property) and a search space (the input domain), backtracking explores combinations of inputs, pruning as soon as a partial assignment violates any constraint. This is the same structure as N-Queens: the "constraints" are the test property, the "choices" are the input values at each position, and "unchoose" is backtracking to a previous input value.

In Kubernetes admission webhook validation, a webhook that validates pod configurations is evaluating a constraint satisfaction problem: does this pod configuration satisfy all admission constraints? When multiple webhooks interact with overlapping constraints, the order of evaluation matters and can produce unexpected rejections. Thinking about this as a CSP (constraint satisfaction problem) with backtracking clarifies why webhook ordering policies exist and what the failure modes of incorrect ordering are.
