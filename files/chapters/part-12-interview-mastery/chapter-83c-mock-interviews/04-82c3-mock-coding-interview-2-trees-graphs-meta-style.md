## 83C.3 Mock Coding Interview 2: Trees & Graphs (Meta-style)

### Interviewer Briefing

**Company style:** Meta (Facebook). Emphasis on speed and working code. Meta interviewers value candidates who can write correct code quickly. The problem is typically medium-to-hard difficulty. Two problems may be given if the first is solved quickly.

**Level:** E4 (Software Engineer) or E5 (Senior Software Engineer)

**Interview duration:** 45 minutes (possibly two problems)

### Problem Statement

*Read this to the candidate:*

> Given the root of a binary tree, return the **vertical order traversal** of its nodes' values. For each column from left to right, report the values from top to bottom. If two nodes are in the same row and column, order them from left to right.
>
> The vertical order of a node at position `(row, col)` is defined as:
> - The root is at `(0, 0)`
> - The left child of a node at `(row, col)` is at `(row+1, col-1)`
> - The right child of a node at `(row, col)` is at `(row+1, col+1)`
>
> **Example 1:**
> ```
> 3
> / \
> 9 20
> / \
> 15 7
> ```
> Input: `root = [3, 9, 20, nil, nil, 15, 7]`
> Output: `[[9], [3, 15], [20], [7]]`
>
> **Example 2:**
> ```
> 1
> / \
> 2 3
> / \ / \
> 4 5 6 7
> ```
> Input: `root = [1, 2, 3, 4, 5, 6, 7]`
> Output: `[[4], [2], [1, 5, 6], [3], [7]]`
>
> **Constraints:**
> - The number of nodes is in the range `[0, 100]`
> - `-100 <= Node.val <= 100`

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| 0:00-3:00 | Clarify | Confirm what "same row and column" ordering means. Ask about empty tree. |
| 3:00-8:00 | Approach | BFS (level-order) with column tracking. Use a map from column to list of values. Track min/max column. |
| 8:00-10:00 | Complexity | O(n log n) if sorting nodes at same position, O(n) if using BFS ordering. Space O(n). |
| 10:00-28:00 | Implementation | BFS with queue storing (node, row, col). Map columns to values. |
| 28:00-35:00 | Testing | Walk through both examples. Test empty tree, single node, skewed tree. |
| 35:00-40:00 | Follow-ups | See below. If done fast, interviewer gives Problem 2. |
| 40:00-45:00 | Problem 2 (if applicable) | "Given a binary tree, find the lowest common ancestor of two given nodes." |

### Expected Solution Walkthrough

**Key Insight:** BFS naturally processes nodes top-to-bottom, left-to-right. By tracking the column index of each node, we can group nodes by column. BFS order guarantees that within the same column, nodes appear in the correct top-to-bottom order, and same-row-same-column nodes appear left-to-right.

**Approach:**
1. BFS from root, tracking (node, row, col) for each entry
2. Map: col -> list of (row, val) pairs
3. Sort columns by col, then within each column sort by (row, then order of insertion which BFS guarantees is left-to-right)
4. Extract values

### Interviewer Notes: What to Look For

**Strong signals:**
- Chooses BFS over DFS - understands that BFS gives natural left-to-right ordering at same depth
- Correctly tracks column indices through the traversal
- Handles the "same row and column" tie-breaking correctly
- Defines the TreeNode struct idiomatically in Go
- Code is clean and Meta-fast (under 20 minutes of coding)

**Weak signals:**
- Uses DFS but doesn't sort correctly within columns
- Forgets to handle nil root
- Confuses row and column coordinates

**Red flags:**
- Cannot implement BFS on a tree
- Does not understand the column-tracking concept after hints

### Complete Go Solution

The solution uses BFS level-by-level traversal, tracking each node's column index. Nodes at the same column are grouped together, and within each column they are ordered top-to-bottom (by level) then left-to-right (by position in the BFS queue).

```go
package interview

import "sort"

// TreeNode represents a node in a binary tree.
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

type nodeInfo struct {
    row int
    col int
    val int
}

// verticalTraversal returns the vertical order traversal of a binary tree.
// Time: O(n log n) due to sorting, Space: O(n)
func verticalTraversal(root *TreeNode) [][]int {
    if root == nil {
        return nil
    }

    // BFS with column and row tracking
    type queueEntry struct {
        node *TreeNode
        row  int
        col  int
    }

    var nodes []nodeInfo
    queue := []queueEntry{{node: root, row: 0, col: 0}}

    for len(queue) > 0 {
        entry := queue[0]
        queue = queue[1:]

        nodes = append(nodes, nodeInfo{
            row: entry.row,
            col: entry.col,
            val: entry.node.Val,
        })

        if entry.node.Left != nil {
            queue = append(queue, queueEntry{
                node: entry.node.Left,
                row:  entry.row + 1,
                col:  entry.col - 1,
            })
        }
        if entry.node.Right != nil {
            queue = append(queue, queueEntry{
                node: entry.node.Right,
                row:  entry.row + 1,
                col:  entry.col + 1,
            })
        }
    }

    // Sort by column first, then row, then value for same (row, col)
    sort.Slice(nodes, func(i, j int) bool {
        if nodes[i].col != nodes[j].col {
            return nodes[i].col < nodes[j].col
        }
        if nodes[i].row != nodes[j].row {
            return nodes[i].row < nodes[j].row
        }
        return nodes[i].val < nodes[j].val
    })

    // Group by column
    var result [][]int
    var currentCol []int
    prevCol := nodes[0].col

    for _, n := range nodes {
        if n.col != prevCol {
            result = append(result, currentCol)
            currentCol = nil
            prevCol = n.col
        }
        currentCol = append(currentCol, n.val)
    }
    result = append(result, currentCol)

    return result
}
```

### Follow-up Questions

**Follow-up 1: "What if we need to return the column index with each group?"**

*Strong answer:* "Simple modification - return `[]struct{Col int. Vals []int}` instead, or a `map[int][]int`. The sort and grouping logic stays the same."

**Follow-up 2 (Bonus Problem): "Find the lowest common ancestor of two nodes."**

```go
// TreeNode represents a node in a binary tree.
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

// lowestCommonAncestor finds the LCA of nodes p and q in a binary tree.
// Time: O(n), Space: O(h) where h is tree height
func lowestCommonAncestor(root, p, q *TreeNode) *TreeNode {
    if root == nil || root == p || root == q {
        return root
    }

    left := lowestCommonAncestor(root.Left, p, q)
    right := lowestCommonAncestor(root.Right, p, q)

    if left != nil && right != nil {
        return root // root is the LCA
    }
    if left != nil {
        return left
    }
    return right
}
```

**Follow-up 3: "How would you parallelize the vertical traversal for a very large tree?"**

*Strong answer:* "I'd partition the BFS by level using a sync.WaitGroup. Each level can be processed concurrently since nodes at the same level don't depend on each other for the traversal. Use a mutex-protected map or channel-based collector for the results. However, for trees that fit in memory, the overhead of goroutine creation likely exceeds the gain - this optimization only makes sense for trees stored across multiple machines in a distributed setting."

### Scoring Rubric

| Rating | Criteria |
|--------|----------|
| **Strong Hire** | Solves vertical traversal cleanly in under 20 minutes. Correct sorting logic. Handles edge cases. Solves LCA bonus problem. Strong communication throughout. |
| **Hire** | Solves vertical traversal correctly within 35 minutes. Minor issues with sorting tie-breaking but fixes when prompted. Good communication. |
| **Lean Hire** | Gets the general approach but struggles with implementation details. Needs hints for tie-breaking logic. Code works for basic cases but misses edge cases. |
| **No Hire** | Cannot implement BFS on a binary tree. Fundamentally misunderstands column tracking. Code does not work after 35 minutes. |


### Junior → FAANG: Trees and Graphs Mock Interview Fundamentals

Trees and graphs problems appear frequently in Meta-style coding interviews. Key patterns: DFS and BFS for traversal, dynamic programming on tree structures (top-down memoization, bottom-up tabulation), union-find for connected components, and Dijkstra/Bellman-Ford for shortest paths. For trees, know the recursive structure: most tree problems have a solution where you compute something for a node in terms of solutions for its children. For graphs, know how to build an adjacency list from an edge list and how to detect cycles (DFS with a visited set and a recursion stack, or union-find).

### Senior @ FAANG: Trees/Graphs at the L5/L6 Bar: Problem Decomposition and Space Complexity

At the L5/L6 level, the evaluation of tree and graph problems includes the quality of your decomposition: did you identify the right subproblem, did you choose the right traversal strategy for the problem constraints, and did you correctly analyze the space complexity of your recursion (the implicit call stack counts toward space complexity for recursive solutions). A bar-raiser probe at this level is to ask for the iterative version of a recursive solution, which tests whether you understand the call stack mechanics explicitly. Meta-style interviews also often involve follow-up questions that change a constraint (what if the graph has cycles, what if the tree is unbalanced, what if the input is streaming), which test the adaptability of your solution approach rather than just the correctness of a single solution.

---
