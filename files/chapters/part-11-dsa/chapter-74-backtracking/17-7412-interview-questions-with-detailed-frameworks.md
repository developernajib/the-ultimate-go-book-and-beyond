## 74.15 Interview Questions with Detailed Frameworks

### Question 1: "Generate all valid parentheses combinations for n pairs"

**What Interviewers Are Testing**:
- Understanding of backtracking template
- Ability to identify valid states and prune invalid branches
- Clean recursive code with proper base cases
- Time and space complexity analysis

**Problem Analysis**:

```
INPUT: n = 3
OUTPUT: ["((()))", "(()())", "(())()", "()(())", "()()()"]

KEY INSIGHT: At any point, we can add '(' if we haven't used all n.
            We can add ')' only if close_count < open_count.

DECISION TREE FOR n=2:
                    ""
                    |
                   "("
                 /     \
              "(("     "()"
              /          \
           "(()"        "()()"  ← valid, add to result
              |
           "(())"  ← valid, add to result
```

**Framework for Solving**:

```
1. IDENTIFY CHOICES:
   - At each step: add '(' or add ')'

2. IDENTIFY CONSTRAINTS:
   - Can add '(' if open < n
   - Can add ')' if close < open

3. IDENTIFY BASE CASE:
   - String length == 2*n → add to result

4. IMPLEMENT BACKTRACKING:
   - Make choice (append char)
   - Recurse
   - Undo choice (typically strings are immutable, so no undo needed)
```

**Complete Solution with Analysis**:

```go
// GenerateParenthesis generates all valid parentheses combinations.
// The result count is the n-th Catalan number (1, 1, 2, 5, 14, 42, ...),
// which is ~4^n/n^1.5, and each result costs O(n) to build.
// Time: O(4^n / sqrt(n)), Space: O(n) recursion depth, excluding output.
func GenerateParenthesis(n int) []string {
    result := []string{}

    var backtrack func(current string, open, close int)
    backtrack = func(current string, open, close int) {
        // Base case: complete valid combination
        if len(current) == 2*n {
            result = append(result, current)
            return
        }

        // Choice 1: Add opening parenthesis
        // Constraint: Haven't used all n opening parens
        if open < n {
            backtrack(current+"(", open+1, close)
        }

        // Choice 2: Add closing parenthesis
        // Constraint: Must have more opens than closes (maintains validity)
        if close < open {
            backtrack(current+")", open, close+1)
        }
    }

    backtrack("", 0, 0)
    return result
}
```

**Follow-Up Questions to Expect**:

1. "What's the time complexity?" → O(4^n / sqrt(n)). The result count is the n-th Catalan number, which grows as roughly 4^n / n^1.5, and each result costs O(n) to build, so the product is 4^n / sqrt(n). Worth stating as two facts rather than one, since "4^n / sqrt(n)" is not itself the Catalan number
2. "Can you optimize for memory?" → Use byte slice with explicit backtracking:

```go
func GenerateParenthesisOptimized(n int) []string {
    result := []string{}
    path := make([]byte, 0, 2*n)

    var backtrack func(open, close int)
    backtrack = func(open, close int) {
        if len(path) == 2*n {
            result = append(result, string(path))
            return
        }

        if open < n {
            path = append(path, '(')
            backtrack(open+1, close)
            path = path[:len(path)-1] // explicit backtrack
        }

        if close < open {
            path = append(path, ')')
            backtrack(open, close+1)
            path = path[:len(path)-1] // explicit backtrack
        }
    }

    backtrack(0, 0)
    return result
}
```

---

### Question 2: "Given a 2D board and a word, find if the word exists in the grid"

**What Interviewers Are Testing**:
- 2D grid backtracking pattern
- In-place visited marking
- Early termination optimization
- Handling edge cases (empty grid, single character)

**Problem Analysis**:

```
BOARD:              WORD: "ABCCED"
[['A','B','C','E'],
 ['S','F','C','S'],
 ['A','D','E','E']]

SEARCH PATH:
A → B → C → C → E → D  ✓ Found!
↓   ↓   ↓   ↓   ↓   ↓
Start from A(0,0), move right to B, right to C,
down to C, down to E, left to D
```

**Framework for Solving**:

```
1. IDENTIFY STARTING POINTS:
   - Any cell matching word[0]

2. IDENTIFY CHOICES:
   - Move in 4 directions: up, down, left, right

3. IDENTIFY CONSTRAINTS:
   - Stay within bounds
   - Current cell matches current character
   - Cell not already visited in current path

4. IDENTIFY BASE CASE:
   - Matched all characters → return true
   - Out of bounds or mismatch → return false

5. BACKTRACKING:
   - Mark cell as visited (modify in place)
   - Recurse in 4 directions
   - Unmark cell (restore original)
```

**Complete Solution with Analysis**:

```go
// Exist checks if word exists in the grid via adjacent cells
// Time: O(m*n*4^L) where L is word length
// Space: O(L) for recursion stack
func Exist(board [][]byte, word string) bool {
    if len(board) == 0 || len(board[0]) == 0 {
        return false
    }

    m, n := len(board), len(board[0])

    var backtrack func(i, j, k int) bool
    backtrack = func(i, j, k int) bool {
        // Base case: matched entire word
        if k == len(word) {
            return true
        }

        // Pruning: out of bounds or character mismatch
        if i < 0 || i >= m || j < 0 || j >= n || board[i][j] != word[k] {
            return false
        }

        // Mark as visited (using special character)
        temp := board[i][j]
        board[i][j] = '#'

        // Try all 4 directions
        found := backtrack(i+1, j, k+1) || // down
                 backtrack(i-1, j, k+1) || // up
                 backtrack(i, j+1, k+1) || // right
                 backtrack(i, j-1, k+1)    // left

        // Backtrack: restore original character
        board[i][j] = temp

        return found
    }

    // Try starting from every cell
    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            if backtrack(i, j, 0) {
                return true
            }
        }
    }

    return false
}
```

**Common Interview Mistakes to Avoid**:

```go
// ⚠️ TRADE-OFF, not a mistake: a separate visited array
func ExistWithVisited(board [][]byte, word string) bool {
    visited := make([][]bool, len(board))
    // ... costs an extra O(m*n) space
}
// This is correct, and it has two real advantages over the in-place trick:
// it never touches the caller's board, and it needs no sentinel value, so
// it still works when the alphabet includes '#'. The in-place version is
// preferred in interviews for the O(1) extra space, but reach for the
// visited array when the board is shared, read concurrently, or when you
// cannot prove a sentinel is safe.

// ✅ PREFERRED HERE: mark in place and restore, for O(1) extra space

// ❌ MISTAKE 2: Not short-circuiting on found
func backtrackBad(i, j, k int) bool {
    // Try all directions regardless of result
    down := backtrack(i+1, j, k+1)
    up := backtrack(i-1, j, k+1)    // Still executes even if down found it
    right := backtrack(i, j+1, k+1)
    left := backtrack(i, j-1, k+1)
    return down || up || right || left
}

// ✅ BETTER: Short-circuit with ||
return backtrack(i+1, j, k+1) ||
       backtrack(i-1, j, k+1) ||
       backtrack(i, j+1, k+1) ||
       backtrack(i, j-1, k+1)
```

**Follow-Up: "How would you optimize for multiple word searches?"**

→ Use Trie-based approach for Word Search II (LeetCode 212)

---

### Question 3: "Solve the N-Queens problem - place N queens on an N×N board"

**What Interviewers Are Testing**:
- Classic constraint satisfaction problem
- Efficient validity checking
- Solution representation
- Understanding of optimization techniques

**Problem Analysis**:

```
N=4 SOLUTION:
. Q . .     . . Q .
. . . Q     Q . . .
Q . . .     . . . Q
. . Q .     . Q . .

CONSTRAINT: No two queens can attack each other
- Same row: ✗ (we place one per row, so handled)
- Same column: Check cols[col] == false
- Same diagonal: Check row-col diagonal
- Same anti-diagonal: Check row+col anti-diagonal
```

**Framework for Solving**:

```
1. APPROACH: Place one queen per row
   - Iterate through columns for each row
   - Check if placement is valid
   - Recurse to next row

2. VALIDITY CHECK:
   - Column not used
   - Diagonal (row-col) not used
   - Anti-diagonal (row+col) not used

3. OPTIMIZATION:
   - Use sets/arrays for O(1) validity check
   - Instead of checking all placed queens O(n)
```

**Complete Solution with Analysis**:

```go
// SolveNQueens returns all valid N-Queens configurations
// Time: O(N!), Space: O(N)
func SolveNQueens(n int) [][]string {
    result := [][]string{}

    // Track used columns and diagonals for O(1) lookup
    cols := make(map[int]bool)
    diag1 := make(map[int]bool)  // row - col (same value = same diagonal)
    diag2 := make(map[int]bool)  // row + col (same value = same anti-diagonal)

    board := make([]int, n) // board[row] = column position of queen

    var backtrack func(row int)
    backtrack = func(row int) {
        // Base case: placed all N queens
        if row == n {
            result = append(result, buildBoard(board, n))
            return
        }

        // Try each column in current row
        for col := 0; col < n; col++ {
            // Check all three constraints
            if cols[col] || diag1[row-col] || diag2[row+col] {
                continue
            }

            // Place queen
            board[row] = col
            cols[col] = true
            diag1[row-col] = true
            diag2[row+col] = true

            // Recurse to next row
            backtrack(row + 1)

            // Remove queen (backtrack)
            cols[col] = false
            diag1[row-col] = false
            diag2[row+col] = false
        }
    }

    backtrack(0)
    return result
}

func buildBoard(board []int, n int) []string {
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
```

**Why This Approach is Optimal**:

```
NAIVE APPROACH: O(N²) per validity check
- For each queen placement, check against all other queens
- Total: O(N! * N²)

OPTIMIZED APPROACH: O(1) per validity check
- Use sets to track used columns and diagonals
- Total: O(N!)

DIAGONAL INSIGHT:
- Cells on same diagonal have same (row - col) value
- Cells on same anti-diagonal have same (row + col) value

Example for N=4:
         col 0  col 1  col 2  col 3
row 0:    0-0=0  0-1=-1 0-2=-2 0-3=-3   (diag1 values)
row 1:    1-0=1  1-1=0  1-2=-1 1-3=-2
row 2:    2-0=2  2-1=1  2-2=0  2-3=-1
row 3:    3-0=3  3-1=2  3-2=1  3-3=0

Notice: Main diagonal has diag1=0, parallel diagonals have other values
```

---

### Question 4: "Given a collection of numbers with duplicates, return all unique permutations"

**What Interviewers Are Testing**:
- Duplicate handling in backtracking
- Understanding of the "used" array pattern
- Ability to explain the skip condition

**Problem Analysis**:

```
INPUT: [1, 1, 2]
OUTPUT: [[1,1,2], [1,2,1], [2,1,1]]

WITHOUT DUPLICATE HANDLING:
Would generate [1,1,2] twice (using first 1, then second 1)

KEY INSIGHT:
- Sort the array first
- Skip duplicate elements at the same tree level
- "Same level" means: previous duplicate not used yet
```

**The Critical Skip Condition Explained**:

```
SORTED: [1, 1, 2]
        ↑  ↑
       i=0 i=1

When building permutations, at each level we try each unused element.

Tree without duplicate handling:
                []
        /       |       \
      [1]      [1]      [2]
     (i=0)    (i=1)    (i=2)
    /    \   /    \      |
[1,1] [1,2] [1,1] [1,2] [2,1]
(using   (using
 second   first
 1)       1)

Both [1] branches lead to same results!

SOLUTION: At each level, skip nums[i] if:
1. nums[i] == nums[i-1] (duplicate)
2. !used[i-1] (previous duplicate not used)

Why !used[i-1]?
- If used[i-1] is true: we're going deeper (different level) - OK
- If used[i-1] is false: we're at same level, already tried this value - SKIP
```

**Complete Solution with Analysis**:

```go
import "slices"

// PermuteUnique returns all unique permutations
// Time: O(N * N!) worst case (all distinct), Space: O(N)
// Note: sorts nums in place, reordering the caller's slice.
func PermuteUnique(nums []int) [][]int {
    slices.Sort(nums) // CRUCIAL: the guard below needs equal values adjacent

    result := [][]int{}
    used := make([]bool, len(nums))

    var backtrack func(path []int)
    backtrack = func(path []int) {
        // Base case
        if len(path) == len(nums) {
            perm := make([]int, len(path))
            copy(perm, path)
            result = append(result, perm)
            return
        }

        for i := 0; i < len(nums); i++ {
            // Skip if already used in current path
            if used[i] {
                continue
            }

            // Skip duplicates at same tree level
            // Key insight: if nums[i] == nums[i-1] AND !used[i-1]
            // means we're at the same level trying the same value
            if i > 0 && nums[i] == nums[i-1] && !used[i-1] {
                continue
            }

            // Make choice
            used[i] = true
            path = append(path, nums[i])

            // Recurse
            backtrack(path)

            // Undo choice
            path = path[:len(path)-1]
            used[i] = false
        }
    }

    backtrack([]int{})
    return result
}
```

**Alternative Skip Condition (genuinely equivalent)**:

```go
// Some prefer: skip if nums[i] == nums[i-1] && used[i-1]
//
// This really does produce the identical result set, which surprises people
// who expect one of the two to be the "right" one. The reason both work:
// each guard fixes a canonical order in which equal values may be consumed.
// !used[i-1] forces the LEFTMOST unused duplicate to be taken first.
//  used[i-1] forces the RIGHTMOST one first.
// Either way exactly one representative of each equivalence class of index
// choices survives, which is all the deduplication needs. The two build
// mirror-image trees and enumerate the same set in a different order.
//
// What is NOT interchangeable is dropping the sort. Both guards compare
// nums[i] to nums[i-1] and so are blind to duplicates that are not adjacent.
```

### Junior → FAANG: Framework Application Under Interview Pressure

The four detailed frameworks in this file (Generate Parentheses, Word Search, N-Queens, Unique Permutations) are the playbook for backtracking interviews. In the interview, apply each framework in sequence: identify choices, identify constraints, identify base case, implement. Do not skip any step even if the framework seems obvious. The steps are fast (under 2 minutes total for any of these four problems) and prevent the mistakes that occur when you rush to code.

For Generate Parentheses, the key framework insight is that the constraints make the undo step unnecessary: string concatenation (`current+"("`) creates a new string, so the parent's `current` is unchanged when the child returns. No explicit backtracking is needed. Recognizing this as an optimization (versus the byte-slice version that requires explicit backtracking) shows you understand what the undo step is for.

For N-Queens, the diagonal insight (same `row - col` value means same diagonal) is the framework fact that unlocks O(1) constraint checking. If you do not know this insight, you will implement O(n) linear validation, which works but is slow. Practice the diagonal formula until it is instant: "cells on the same diagonal have the same `row - col` value. Cells on the same anti-diagonal have the same `row + col` value."

### Senior @ FAANG: Frameworks as Interview Evaluation Rubrics

The four problem frameworks in this file define the evaluation rubric that senior engineers use when bar-raising for backtracking. The rubric has five dimensions for each problem: problem recognition (did they identify the right algorithm class?), framework application (did they work through the framework before coding?), constraint representation (did they choose an efficient constraint check?), template execution (did they write the make/recurse/unmake triple correctly?), and complexity analysis (did they state the exact formula?).

A candidate who scores 5/5 on all four frameworks is comfortably above the L5 bar for backtracking. For L6, the bar is extended: can they design the framework for a novel problem they have not seen before, and can they identify which follow-up constraints would require changing the framework versus which would require only a code modification?

For bar-raiser preparation, practice applying these frameworks to problems you encounter outside of LeetCode: network packet validation (IP restoration framework), expression parsing (operator precedence framework), placement problems (N-Queens framework), deduplication (unique permutations framework). The ability to transfer the framework to a new domain is the signal that the framework is internalized rather than memorized.

---
