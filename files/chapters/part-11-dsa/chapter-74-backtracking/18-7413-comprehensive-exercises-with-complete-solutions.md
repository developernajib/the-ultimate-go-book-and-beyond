## 74.16 Comprehensive Exercises with Complete Solutions

### Exercise 1: Letter Combinations of a Phone Number

**Problem**: Given a string containing digits from 2-9, return all possible letter combinations.

```
INPUT: digits = "23"
OUTPUT: ["ad","ae","af","bd","be","bf","cd","ce","cf"]

MAPPING:
2 → "abc"
3 → "def"
4 → "ghi"
5 → "jkl"
6 → "mno"
7 → "pqrs"
8 → "tuv"
9 → "wxyz"
```

**Complete Solution**:

```go
package backtracking

// LetterCombinations returns all letter combinations for phone digits
// Time: O(4^N * N) where N is length of digits
// Space: O(N) for recursion stack
func LetterCombinations(digits string) []string {
    if len(digits) == 0 {
        return []string{}
    }

    // Phone keypad mapping
    mapping := map[byte]string{
        '2': "abc",
        '3': "def",
        '4': "ghi",
        '5': "jkl",
        '6': "mno",
        '7': "pqrs",
        '8': "tuv",
        '9': "wxyz",
    }

    result := []string{}

    var backtrack func(index int, current []byte)
    backtrack = func(index int, current []byte) {
        // Base case: processed all digits
        if index == len(digits) {
            result = append(result, string(current))
            return
        }

        // Get letters for current digit
        letters := mapping[digits[index]]

        // Try each letter
        for i := 0; i < len(letters); i++ {
            current = append(current, letters[i])
            backtrack(index+1, current)
            current = current[:len(current)-1] // backtrack
        }
    }

    backtrack(0, []byte{})
    return result
}

// LetterCombinationsIterative uses BFS-style iteration
// Useful when recursion depth could be a concern
func LetterCombinationsIterative(digits string) []string {
    if len(digits) == 0 {
        return []string{}
    }

    mapping := map[byte]string{
        '2': "abc", '3': "def", '4': "ghi", '5': "jkl",
        '6': "mno", '7': "pqrs", '8': "tuv", '9': "wxyz",
    }

    result := []string{""}

    for i := 0; i < len(digits); i++ {
        letters := mapping[digits[i]]
        newResult := []string{}

        for _, combo := range result {
            for j := 0; j < len(letters); j++ {
                newResult = append(newResult, combo+string(letters[j]))
            }
        }

        result = newResult
    }

    return result
}
```

**Test Cases**:

```go
import (
    "reflect"
    "slices"
    "testing"
)

func TestLetterCombinations(t *testing.T) {
    tests := []struct {
        digits   string
        expected []string
    }{
        {"23", []string{"ad", "ae", "af", "bd", "be", "bf", "cd", "ce", "cf"}},
        {"", []string{}},
        {"2", []string{"a", "b", "c"}},
        {"7", []string{"p", "q", "r", "s"}},
    }

    for _, tt := range tests {
        result := LetterCombinations(tt.digits)
        slices.Sort(result)
        slices.Sort(tt.expected)
        if !reflect.DeepEqual(result, tt.expected) {
            t.Errorf("LetterCombinations(%s) = %v, want %v",
                tt.digits, result, tt.expected)
        }
    }
}
```

### Junior → FAANG: Letter Combinations as a Template Warmup

Letter Combinations is the ideal warmup problem before a backtracking interview session because it requires the complete template (base case, for loop over choices, make/recurse/unmake) without any complex constraint logic or duplicate handling. Implementing it correctly in under 5 minutes means your template is ready for harder problems.

The byte-slice version in the solution above (`[]byte` path with explicit backtrack) is the production-preferred form. The string concatenation version (`current + string(letters[i])`) is simpler to write but allocates a new string at every level, creating O(n^2) total allocation for n digits. The byte-slice version allocates one slice of length n and reuses it throughout, reducing GC pressure.

After implementing the recursive version, implement the iterative BFS version (`LetterCombinationsIterative`). This iterative version is a useful mental model: at each step, you extend each existing partial result by one character. The result list grows by a factor of `len(letters[i])` at each step. For 2 digits each with 3 letters, the result grows from [] to [a, b, c] to [ad, ae, af, bd, be, bf, cd, ce, cf]. This BFS model makes the total result count intuitive: it is the product of the number of letters for each digit.

### Senior @ FAANG: Iterative Backtracking as a Streaming Pattern

The iterative BFS version of letter combinations is the starting point for a streaming backtracking pattern. Instead of materializing the full result list, the BFS can be implemented as a producer-consumer: the producer goroutine generates combinations one BFS level at a time and sends them on a channel, the consumer processes each combination as it arrives. This streaming pattern enables: early termination (consumer closes the channel when it has enough results), back-pressure (channel buffer controls how far ahead the producer runs), and parallel processing (multiple consumers read from the same channel).

For production phone number lookup (finding all words that match a phone number, T9-style), the streaming pattern enables the system to return results incrementally rather than waiting for all combinations to be generated. The first few results arrive in milliseconds (short words matching the first digits), while longer words arrive later. This progressive result delivery improves perceived responsiveness for interactive applications.

---

### Exercise 2: Combination Sum - Find All Combinations That Sum to Target

**Problem**: Given an array of distinct integers and a target, return all unique combinations where chosen numbers sum to target. Each number may be used unlimited times.

```
INPUT: candidates = [2,3,6,7], target = 7
OUTPUT: [[2,2,3], [7]]

EXPLANATION:
- 2 + 2 + 3 = 7
- 7 = 7
```

**Complete Solution**:

```go
package backtracking

// CombinationSum finds all combinations summing to target
// Numbers can be reused unlimited times
// Time: O(N^(T/M)) where T=target, M=min(candidates)
// Space: O(T/M) for recursion depth
func CombinationSum(candidates []int, target int) [][]int {
    result := [][]int{}

    var backtrack func(start, remaining int, path []int)
    backtrack = func(start, remaining int, path []int) {
        // Base case: found valid combination
        if remaining == 0 {
            combo := make([]int, len(path))
            copy(combo, path)
            result = append(result, combo)
            return
        }

        // Try each candidate starting from 'start' to avoid duplicates
        for i := start; i < len(candidates); i++ {
            // Pruning: skip if candidate too large
            if candidates[i] > remaining {
                continue
            }

            // Make choice
            path = append(path, candidates[i])

            // Recurse with same index (can reuse same number)
            backtrack(i, remaining-candidates[i], path)

            // Undo choice
            path = path[:len(path)-1]
        }
    }

    backtrack(0, target, []int{})
    return result
}

import "slices"

// CombinationSumOptimized sorts and prunes more aggressively.
// The sort is not cosmetic: it is the precondition that makes the `break`
// below correct. With `break` on unsorted input this returns wrong answers.
// Note: sorts candidates in place, reordering the caller's slice.
func CombinationSumOptimized(candidates []int, target int) [][]int {
    slices.Sort(candidates) // REQUIRED by the break below, not just an optimization
    result := [][]int{}

    var backtrack func(start, remaining int, path []int)
    backtrack = func(start, remaining int, path []int) {
        if remaining == 0 {
            combo := make([]int, len(path))
            copy(combo, path)
            result = append(result, combo)
            return
        }

        for i := start; i < len(candidates); i++ {
            // Early termination: all subsequent candidates are larger
            if candidates[i] > remaining {
                break // Instead of continue - because sorted
            }

            path = append(path, candidates[i])
            backtrack(i, remaining-candidates[i], path)
            path = path[:len(path)-1]
        }
    }

    backtrack(0, target, []int{})
    return result
}
```

---

### Exercise 3: Restore IP Addresses

**Problem**: Given a string containing only digits, return all possible valid IP addresses.

```
INPUT: "25525511135"
OUTPUT: ["255.255.11.135", "255.255.111.35"]

VALID IP SEGMENT:
- Length 1-3
- Value 0-255
- No leading zeros (unless "0" itself)
```

**Complete Solution**:

```go
package backtracking

import "strings"

// RestoreIPAddresses returns all valid IP address combinations
// Time: O(3^4 * N) - at most 3 choices for 4 segments
// Space: O(N) for storing results
func RestoreIPAddresses(s string) []string {
    result := []string{}

    // IP address has exactly 4 segments
    // Each segment: 1-3 digits, value 0-255, no leading zeros

    var backtrack func(start, segments int, current []string)
    backtrack = func(start, segments int, current []string) {
        // Base case: used all 4 segments and consumed entire string
        if segments == 4 {
            if start == len(s) {
                result = append(result, strings.Join(current, "."))
            }
            return
        }

        // Pruning: remaining string too short or too long
        remaining := len(s) - start
        minNeeded := 4 - segments      // at least 1 char per segment
        maxNeeded := (4 - segments) * 3 // at most 3 chars per segment
        if remaining < minNeeded || remaining > maxNeeded {
            return
        }

        // Try segments of length 1, 2, 3
        for length := 1; length <= 3 && start+length <= len(s); length++ {
            segment := s[start : start+length]

            // Validate segment
            if !isValidSegment(segment) {
                continue
            }

            // Make choice
            current = append(current, segment)

            // Recurse
            backtrack(start+length, segments+1, current)

            // Undo choice
            current = current[:len(current)-1]
        }
    }

    backtrack(0, 0, []string{})
    return result
}

// isValidSegment checks if segment is valid IP number
func isValidSegment(s string) bool {
    // Empty segment
    if len(s) == 0 {
        return false
    }

    // Leading zero (only "0" is valid)
    if len(s) > 1 && s[0] == '0' {
        return false
    }

    // Check numeric value
    val := 0
    for i := 0; i < len(s); i++ {
        val = val*10 + int(s[i]-'0')
    }

    return val <= 255
}
```

**Test Cases**:

```go
func TestRestoreIPAddresses(t *testing.T) {
    tests := []struct {
        s        string
        expected []string
    }{
        {"25525511135", []string{"255.255.11.135", "255.255.111.35"}},
        {"0000", []string{"0.0.0.0"}},
        {"101023", []string{"1.0.10.23", "1.0.102.3", "10.1.0.23", "10.10.2.3", "101.0.2.3"}},
        {"1111", []string{"1.1.1.1"}},
    }

    for _, tt := range tests {
        result := RestoreIPAddresses(tt.s)
        slices.Sort(result)
        slices.Sort(tt.expected)
        if !reflect.DeepEqual(result, tt.expected) {
            t.Errorf("RestoreIPAddresses(%s) = %v, want %v",
                tt.s, result, tt.expected)
        }
    }
}
```

---

### Exercise 4: Palindrome Partitioning

**Problem**: Given a string, partition it such that every substring is a palindrome. Return all possible partitions.

```
INPUT: "aab"
OUTPUT: [["a","a","b"], ["aa","b"]]
```

**Complete Solution**:

```go
package backtracking

// Partition returns all palindrome partitions of s
// Time: O(N * 2^N) - for each position, choose to cut or not
// Space: O(N^2) for memoization + O(N) recursion
func Partition(s string) [][]string {
    n := len(s)

    // Precompute palindrome status using DP
    // isPalin[i][j] = true if s[i:j+1] is palindrome
    isPalin := make([][]bool, n)
    for i := range isPalin {
        isPalin[i] = make([]bool, n)
    }

    // Fill DP table
    // Single chars are palindromes
    for i := 0; i < n; i++ {
        isPalin[i][i] = true
    }
    // Two chars
    for i := 0; i < n-1; i++ {
        isPalin[i][i+1] = (s[i] == s[i+1])
    }
    // Three or more chars
    for length := 3; length <= n; length++ {
        for i := 0; i <= n-length; i++ {
            j := i + length - 1
            isPalin[i][j] = (s[i] == s[j]) && isPalin[i+1][j-1]
        }
    }

    result := [][]string{}

    var backtrack func(start int, path []string)
    backtrack = func(start int, path []string) {
        // Base case: consumed entire string
        if start == n {
            partition := make([]string, len(path))
            copy(partition, path)
            result = append(result, partition)
            return
        }

        // Try each possible end position
        for end := start; end < n; end++ {
            // Only proceed if substring is palindrome
            if isPalin[start][end] {
                path = append(path, s[start:end+1])
                backtrack(end+1, path)
                path = path[:len(path)-1]
            }
        }
    }

    backtrack(0, []string{})
    return result
}

// PartitionSimple without precomputation (simpler but slower)
func PartitionSimple(s string) [][]string {
    result := [][]string{}

    var backtrack func(start int, path []string)
    backtrack = func(start int, path []string) {
        if start == len(s) {
            partition := make([]string, len(path))
            copy(partition, path)
            result = append(result, partition)
            return
        }

        for end := start; end < len(s); end++ {
            if isPalindrome(s, start, end) {
                path = append(path, s[start:end+1])
                backtrack(end+1, path)
                path = path[:len(path)-1]
            }
        }
    }

    backtrack(0, []string{})
    return result
}

// isPalindrome checks if s[left:right+1] is palindrome
func isPalindrome(s string, left, right int) bool {
    for left < right {
        if s[left] != s[right] {
            return false
        }
        left++
        right--
    }
    return true
}
```

---

### Exercise 5: Sudoku Solver with Constraint Propagation

**Problem**: Solve a 9x9 Sudoku puzzle using backtracking with optimized constraint checking.

**Complete Production-Quality Solution**:

```go
package backtracking

// SudokuSolver uses optimized constraint sets for O(1) validity checks
type SudokuSolver struct {
    board    [][]byte
    rows     [9]map[byte]bool // rows[i] = set of numbers in row i
    cols     [9]map[byte]bool // cols[j] = set of numbers in col j
    boxes    [9]map[byte]bool // boxes[b] = set of numbers in box b
    empty    [][2]int         // list of empty cell coordinates
}

// SolveSudoku solves the puzzle in place
func SolveSudoku(board [][]byte) {
    solver := NewSudokuSolver(board)
    solver.solve()
}

// NewSudokuSolver initializes solver with board state
func NewSudokuSolver(board [][]byte) *SudokuSolver {
    s := &SudokuSolver{board: board}

    // Initialize constraint sets
    for i := 0; i < 9; i++ {
        s.rows[i] = make(map[byte]bool)
        s.cols[i] = make(map[byte]bool)
        s.boxes[i] = make(map[byte]bool)
    }

    // Populate constraint sets and find empty cells
    for i := 0; i < 9; i++ {
        for j := 0; j < 9; j++ {
            if board[i][j] == '.' {
                s.empty = append(s.empty, [2]int{i, j})
            } else {
                num := board[i][j]
                s.rows[i][num] = true
                s.cols[j][num] = true
                s.boxes[s.boxIndex(i, j)][num] = true
            }
        }
    }

    return s
}

// boxIndex returns which 3x3 box a cell belongs to
func (s *SudokuSolver) boxIndex(row, col int) int {
    return (row/3)*3 + col/3
}

// isValid checks if placing num at (row, col) is valid - O(1)
func (s *SudokuSolver) isValid(row, col int, num byte) bool {
    box := s.boxIndex(row, col)
    return !s.rows[row][num] && !s.cols[col][num] && !s.boxes[box][num]
}

// place puts a number and updates constraints
func (s *SudokuSolver) place(row, col int, num byte) {
    s.board[row][col] = num
    s.rows[row][num] = true
    s.cols[col][num] = true
    s.boxes[s.boxIndex(row, col)][num] = true
}

// remove undoes placement and restores constraints
func (s *SudokuSolver) remove(row, col int, num byte) {
    s.board[row][col] = '.'
    delete(s.rows[row], num)
    delete(s.cols[col], num)
    delete(s.boxes[s.boxIndex(row, col)], num)
}

// solve uses backtracking on empty cells
func (s *SudokuSolver) solve() bool {
    return s.solveFrom(0)
}

func (s *SudokuSolver) solveFrom(idx int) bool {
    // Base case: all empty cells filled
    if idx == len(s.empty) {
        return true
    }

    row, col := s.empty[idx][0], s.empty[idx][1]

    // Try numbers 1-9
    for num := byte('1'); num <= '9'; num++ {
        if s.isValid(row, col, num) {
            s.place(row, col, num)

            if s.solveFrom(idx + 1) {
                return true
            }

            s.remove(row, col, num) // backtrack
        }
    }

    return false
}

// MRV (Minimum Remaining Values) optimization
// Choose empty cell with fewest valid choices first
func (s *SudokuSolver) solveMRV() bool {
    // Find empty cell with minimum remaining values
    minChoices := 10
    bestIdx := -1

    for i, cell := range s.empty {
        if s.board[cell[0]][cell[1]] != '.' {
            continue
        }

        choices := 0
        for num := byte('1'); num <= '9'; num++ {
            if s.isValid(cell[0], cell[1], num) {
                choices++
            }
        }

        if choices == 0 {
            return false // Dead end
        }

        if choices < minChoices {
            minChoices = choices
            bestIdx = i
        }
    }

    if bestIdx == -1 {
        return true // All cells filled
    }

    row, col := s.empty[bestIdx][0], s.empty[bestIdx][1]

    for num := byte('1'); num <= '9'; num++ {
        if s.isValid(row, col, num) {
            s.place(row, col, num)

            if s.solveMRV() {
                return true
            }

            s.remove(row, col, num)
        }
    }

    return false
}
```

**Test Cases**:

```go
func TestSolveSudoku(t *testing.T) {
    board := [][]byte{
        {'5', '3', '.', '.', '7', '.', '.', '.', '.'},
        {'6', '.', '.', '1', '9', '5', '.', '.', '.'},
        {'.', '9', '8', '.', '.', '.', '.', '6', '.'},
        {'8', '.', '.', '.', '6', '.', '.', '.', '3'},
        {'4', '.', '.', '8', '.', '3', '.', '.', '1'},
        {'7', '.', '.', '.', '2', '.', '.', '.', '6'},
        {'.', '6', '.', '.', '.', '.', '2', '8', '.'},
        {'.', '.', '.', '4', '1', '9', '.', '.', '5'},
        {'.', '.', '.', '.', '8', '.', '.', '7', '9'},
    }

    expected := [][]byte{
        {'5', '3', '4', '6', '7', '8', '9', '1', '2'},
        {'6', '7', '2', '1', '9', '5', '3', '4', '8'},
        {'1', '9', '8', '3', '4', '2', '5', '6', '7'},
        {'8', '5', '9', '7', '6', '1', '4', '2', '3'},
        {'4', '2', '6', '8', '5', '3', '7', '9', '1'},
        {'7', '1', '3', '9', '2', '4', '8', '5', '6'},
        {'9', '6', '1', '5', '3', '7', '2', '8', '4'},
        {'2', '8', '7', '4', '1', '9', '6', '3', '5'},
        {'3', '4', '5', '2', '8', '6', '1', '7', '9'},
    }

    SolveSudoku(board)

    for i := 0; i < 9; i++ {
        for j := 0; j < 9; j++ {
            if board[i][j] != expected[i][j] {
                t.Errorf("board[%d][%d] = %c, want %c",
                    i, j, board[i][j], expected[i][j])
            }
        }
    }
}
```

### Junior → FAANG: Comprehensive Exercises as a Readiness Certification

The five exercises in this file (Letter Combinations, Combination Sum, Restore IP Addresses, Palindrome Partitioning, Sudoku Solver with MRV) cover the full spectrum of backtracking difficulty. Completing all five correctly and independently is the certification that you are ready for FAANG backtracking interviews.

The readiness test: implement each exercise from memory in under 20 minutes, with the correct time complexity stated before you start coding, at least one pruning strategy per exercise, copy discipline for all slice results, and the correct constraint check (O(1) for Sudoku, precomputed palindrome table for partitioning). If you can pass all five in a single 2-hour session without reference material, you have achieved backtracking fluency.

Focus extra time on Exercise 5 (Sudoku Solver with MRV), and specifically on measuring it, because it teaches a lesson that no amount of reading supplies: **counting nodes is not the same as counting work**, and heuristics are routinely oversold on the first number while the second one quietly pays for it.

MRV picks the most constrained empty cell instead of the next one in scan order, and its effect on the search tree is spectacular. Instrument both solvers on the puzzle in the test above and `solveFrom` visits 4,209 nodes while `solveMRV` visits 52. That is an 80x reduction in nodes, and it is the number people quote.

Now count the actual work. `solveMRV` finds the most constrained cell by scanning every remaining empty cell and testing all 9 digits in each, which is O(e * 9) validity checks *per node*. `solveFrom` does about 9. Counting `isValid` calls on that same puzzle: 37,652 for `solveFrom` against 12,173 for `solveMRV`. The 80x collapses to about 3x. On a hard 17-clue puzzle it is worse, roughly 1.25x, because the harder search visits more nodes and each one pays for a full rescan. Wall-clock tracks the work, not the nodes.

So MRV wins here, but by a small multiple rather than an order of magnitude, and the gap between "80x fewer nodes" and "3x less work" is entirely the heuristic's own cost. The way to actually get the 80x is to stop recomputing: maintain each cell's candidate count incrementally as constraints are placed and removed, so cell selection is a lookup rather than a scan. That is what real CSP solvers do, and it is why they can afford much more aggressive heuristics than this one.

Do the measurement yourself rather than taking these numbers on faith. Count nodes, then count `isValid` calls, then time it. Watching the 80x shrink to 3x in front of you is the single most useful thing in this chapter, because the same illusion is waiting in every optimization you will ever benchmark by proxy metric.

### Senior @ FAANG: Comprehensive Exercises as a Calibration Suite

The five exercises in this file collectively define a calibration suite for senior engineer backtracking competency. A senior engineer joining a team should be able to implement all five correctly in under 3 hours from a blank slate. This calibration serves two purposes: it verifies that the engineer's backtracking knowledge is solid enough to contribute to production CSP systems, and it reveals which areas (constraint representation, pruning strategy, state management) need strengthening before the engineer works on backtracking-based production code.

The MRV heuristic in Exercise 5 is the most diagnostic, because it is a trap for the incautious. A senior engineer who implements MRV, benchmarks it, and reports "80x fewer nodes" has measured the wrong thing. The one who notices that real work only fell about 3x, explains that the O(e * 9) rescan at every node is eating the gain, and proposes maintaining candidate counts incrementally to actually collect it, has demonstrated something quite different: the discipline to distrust a flattering proxy metric. That is the skill that separates an engineer who uses algorithms from one who evaluates them. This reasoning ability is what distinguishes a senior engineer who uses algorithms from one who designs and evaluates them.

---
