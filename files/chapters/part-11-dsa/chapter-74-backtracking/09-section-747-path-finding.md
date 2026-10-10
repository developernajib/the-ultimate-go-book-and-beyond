## 74.7 Path Finding

### Word Search

Grid-based word search uses DFS with in-place marking: the visited cell is temporarily replaced with a sentinel character before recursing into its neighbors, then restored after the recursive call returns. This avoids a separate `visited` matrix while correctly preventing the same cell from being reused in a single path.

Read the restore line carefully, because this implementation has a wrinkle that LeetCode's grader never catches. The `return true` inside the direction loop jumps out *before* `board[i][j] = temp` runs, and so does every `return true` unwinding beneath it. On a failed search every cell is restored properly. On a **successful** search the board is left permanently scarred with `#` along the found path: search `"ABCCED"` in the classic example board and the caller gets back `###E / SF#S / A##E`. The answer is right and the caller's data is destroyed. It goes unnoticed because a grader calls `Exist` once and checks only the bool.

That is fine for LeetCode and not fine anywhere else. If the caller may reuse the board, either restore on the success path too (capture the result, restore, then return it) or work on a copy. At minimum, say so in the doc comment, which is what the version below does.

```go
// Exist checks if word exists in grid
// LeetCode 79: Word Search
// Time: O(m*n*4^L), Space: O(L) recursion depth, where L is len(word).
// (4^L is loose: after the first cell one neighbor is always the marked
//  cell we came from, so 3^L is the tighter bound.)
//
// SIDE EFFECT: mutates board. Cells are restored on failing paths, but an
// early `return true` skips the restore, so a successful search leaves '#'
// along the found path. Pass a copy if the caller reuses the board.
func Exist(board [][]byte, word string) bool {
    if len(board) == 0 || len(board[0]) == 0 {
        return false
    }

    m, n := len(board), len(board[0])
    directions := [][]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}

    var backtrack func(i, j, k int) bool
    backtrack = func(i, j, k int) bool {
        if k == len(word) {
            return true
        }

        if i < 0 || i >= m || j < 0 || j >= n || board[i][j] != word[k] {
            return false
        }

        // Mark as visited
        temp := board[i][j]
        board[i][j] = '#'

        for _, dir := range directions {
            if backtrack(i+dir[0], j+dir[1], k+1) {
                return true
            }
        }

        // Backtrack
        board[i][j] = temp
        return false
    }

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

### Path Sum II

Tree path problems collect a running path from root to leaf and record it only when two conditions hold at once: the node is a leaf (no children) and the accumulated sum equals the target.

The state management here is worth separating into its two halves, because they have opposite answers and conflating them is what produces the classic bug. The `path` slice *header* is passed by value, so `path = append(path, node.Val)` rebinds only this call's local header and the caller's header keeps its old length. That is why there is no explicit unchoose step. The backing *array*, however, is shared, and a sibling call's append will overwrite the slots beyond the caller's length. So the header restores itself and the data does not. That is precisely why the `copy` before storing into `result` is mandatory rather than stylistic: without it, the stored path is a window onto memory that later branches will scribble over.

```go
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

// PathSum finds all root-to-leaf paths with target sum
// LeetCode 113: Path Sum II
func PathSum(root *TreeNode, targetSum int) [][]int {
    result := [][]int{}

    var backtrack func(node *TreeNode, remaining int, path []int)
    backtrack = func(node *TreeNode, remaining int, path []int) {
        if node == nil {
            return
        }

        path = append(path, node.Val)

        if node.Left == nil && node.Right == nil && remaining == node.Val {
            pathCopy := make([]int, len(path))
            copy(pathCopy, path)
            result = append(result, pathCopy)
        } else {
            backtrack(node.Left, remaining-node.Val, path)
            backtrack(node.Right, remaining-node.Val, path)
        }

        // path will be restored when function returns (slice is passed by value)
    }

    backtrack(root, targetSum, []int{})
    return result
}
```

### Junior → FAANG: Path-Finding Backtracking in Interviews

Word Search (LeetCode 79) is the most commonly asked grid backtracking problem. The in-place marking trick (replace visited cell with `#` and restore it after recursing) eliminates the need for a separate `visited` matrix, saving O(m*n) space and removing a source of bugs (forgetting to unmark cells after backtracking). Know this trick by heart.

Short-circuiting matters, and the code above gets it via `if backtrack(...) { return true }` inside the direction loop, which stops the moment a direction succeeds. The common alternative spelling, `return backtrack(i+1, j, k+1) || backtrack(i-1, j, k+1) || ...`, is exactly equivalent: Go's `||` short-circuits, so the later calls never run once one returns true. Both are fine, and the loop scales better when the direction set changes (8-way movement, a hex grid).

What is *not* equivalent is evaluating the four calls into variables first and then combining them: `a := backtrack(...); b := backtrack(...); return a || b || ...`. That forces all four searches to run even after one has already found the word. It returns the same answer and does a great deal of pointless exponential work, and it is the kind of thing a reviewer notices immediately.

For Path Sum II (LeetCode 113), the Go-specific insight about pass-by-value slice semantics is worth mentioning explicitly in the interview. When you write `path = append(path, node.Val)` inside a function that received `path` as a parameter, the caller's `path` is not modified because Go passes the slice header by value. This means the "unmake" step is automatic for this particular implementation, but an explicit copy is still required when storing in the result.

### Senior @ FAANG: Grid Backtracking in Computer Vision and Robotics

Word Search on a 2D grid is structurally equivalent to path detection problems in computer vision (find a connected path of pixels matching a pattern) and in robotics (find a valid route through a grid of waypoints). The complexity O(m*n*4^L) grows exponentially with the path length L, which is impractical for large grids or long patterns. Production solutions use more efficient string matching algorithms adapted for 2D grids: Aho-Corasick automaton on the grid, or pre-processing the pattern using suffix arrays to enable faster rejection of non-matching paths.

For Word Search II (LeetCode 212), where you must find all words from a dictionary in the grid simultaneously, the backtracking approach is enhanced with a trie of all dictionary words. At each grid cell, you traverse the trie rather than checking individual characters, allowing a single DFS pass to search for all words simultaneously. This reduces the time from O(k * m * n * 4^L) (where k is the dictionary size) to O(m * n * 4^max_L) with a shared trie, a significant practical improvement for large dictionaries.

Tree path backtracking (Path Sum II) has a production analogue in distributed tracing: find all traces in an execution tree that satisfy certain properties (duration exceeds a threshold, contain a specific span type, involve a specific downstream service). The same traversal with path accumulation applies, and the same copy-before-store discipline is required to prevent trace data from being corrupted as the traversal continues.

### Junior → FAANG: In-Place Marking as an Interview Signature Move

The in-place marking trick in word search (replace `board[i][j]` with `#` before recursing, restore it after) is one of the most recognizable interview signals in backtracking. Interviewers who see this trick immediately identify the candidate as someone who has internalized backtracking state management, not just copied a template.

Know this trick precisely: the temp variable pattern (`temp := board[i][j]; board[i][j] = '#'; ...; board[i][j] = temp`) is the correct form. Never replace with the sentinel without saving the original value, because the restore step needs it. For character boards, the sentinel must not appear in the valid character set. `#` works for most letter-based word search problems because it is not a letter.

For Path Sum II, the Go pass-by-value slice semantics mean the unchoose step for the path is implicit: when the recursive call returns, the caller's `path` header still has its old length, because Go copied the header on the way in. The header restores itself. The backing array does not, and a sibling branch's append writes straight through it. That split is exactly why `copy` before storing is mandatory rather than defensive: the stored result must not be a window onto memory that later branches will overwrite.

### Senior @ FAANG: Grid Path Detection in Computer Vision and Mapping

The word search grid DFS is the computational kernel for several computer vision algorithms. Connected component analysis (find all pixels of the same color connected to a given pixel) is word search without a target word: the "word" is replaced by a color constraint, and the search explores all connected pixels of that color. Flood fill algorithms in image editing tools use this exact pattern.

For map routing in embedded systems (robotics navigation), the grid backtracking pattern appears in path planning over occupancy grids. The backtracking search finds all valid paths from start to goal, and the shortest is selected. Production robotics uses A* rather than backtracking for single-path queries, but backtracking appears in coverage path planning (find a path that visits every unoccupied cell at least once), which is used for robotic vacuum cleaners and agricultural field robots.

The trie optimization for Word Search II (find all dictionary words in a grid simultaneously) is worth understanding as a production pattern: sharing the matching structure (trie) across multiple search targets eliminates the O(k) multiplier from searching for k words independently. Any multi-target search problem where targets share common prefixes benefits from trie pre-processing. This pattern appears in DNS filtering (match incoming domain names against a blocklist), URL routing (match request paths against a rule set), and log pattern matching (match log lines against multiple alert patterns simultaneously).
