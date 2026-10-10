## 78B.4 The BFS/DFS Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    BFS / DFS PATTERN                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  BFS (Level-order, shortest path in unweighted graphs):         │
│  Queue: [start] → process level by level                        │
│                                                                 │
│  DFS (Explore deep first, backtrack):                           │
│  Stack/Recursion: go deep, return, try next branch              │
│                                                                 │
│        1                                                        │
│       / \         BFS order: 1, 2, 3, 4, 5, 6, 7                │
│      2   3        DFS order: 1, 2, 4, 5, 3, 6, 7                │
│     / \ / \                                                     │
│    4  5 6  7                                                    │
│                                                                 │
│  Multi-source BFS: Start from ALL sources simultaneously        │
│  Topological Sort: Process nodes with no incoming edges first   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**When to use BFS:**
- Shortest path in unweighted graph
- Level-order traversal
- Multi-source shortest distance (e.g., 01-matrix, rotting oranges)

**When to use DFS:**
- Path finding with constraints
- Connected components
- Tree traversals (inorder, preorder, postorder)
- Cycle detection

### Template: BFS

The BFS template marks each node visited before enqueueing (not after dequeuing) to prevent the same node from being added to the queue multiple times, which would cause redundant processing in graphs with multiple paths between nodes.

```go
func bfs(graph map[int][]int, start int) []int {
    visited := map[int]bool{start: true}
    queue := []int{start}
    order := []int{}

    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]
        order = append(order, node)

        for _, neighbor := range graph[node] {
            if !visited[neighbor] {
                visited[neighbor] = true
                queue = append(queue, neighbor)
            }
        }
    }

    return order
}
```

### Template: DFS (Recursive)

Recursive DFS uses the call stack implicitly, making the code concise but subject to stack overflow on deeply recursive inputs. Marking nodes visited at entry prevents cycles from causing infinite recursion, and the processing logic can appear before or after the recursive calls depending on whether pre-order or post-order traversal is needed.

```go
func dfs(graph map[int][]int, node int, visited map[int]bool) {
    visited[node] = true
    // Process node here

    for _, neighbor := range graph[node] {
        if !visited[neighbor] {
            dfs(graph, neighbor, visited)
        }
    }
}
```

---

### Problem 1: Number of Islands (LC 200)

**Problem:** Given an `m x n` grid of '1's (land) and '0's (water), count the number of islands. An island is surrounded by water and is formed by connecting adjacent lands horizontally or vertically.

**Approach:** Iterate through the grid. When a '1' is found, increment count and BFS/DFS to mark all connected '1's as visited.

```go
func numIslands(grid [][]byte) int {
    if len(grid) == 0 {
        return 0
    }

    rows, cols := len(grid), len(grid[0])
    count := 0

    var dfs func(r, c int)
    dfs = func(r, c int) {
        if r < 0 || r >= rows || c < 0 || c >= cols || grid[r][c] != '1' {
            return
        }
        grid[r][c] = '0' // mark visited
        dfs(r+1, c)
        dfs(r-1, c)
        dfs(r, c+1)
        dfs(r, c-1)
    }

    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if grid[r][c] == '1' {
                count++
                dfs(r, c)
            }
        }
    }

    return count
}
```

**Time Complexity:** O(m * n). Each cell is visited at most once.
**Space Complexity:** O(m * n) worst case for the recursion stack (a long snake-like island).

Note that this destroys the input: it sinks each island by overwriting land with water. That is the cheapest way to track visited state, but say so out loud, because a caller who needs the grid afterward has to be handed a copy or a separate visited matrix.

**Edge cases:**
- All water → 0
- All land → 1
- Single cell
- Diagonal cells are NOT connected

---

### Problem 2: Binary Tree Level Order Traversal (LC 102)

**Problem:** Given the root of a binary tree, return the level order traversal as a 2D slice.

**Approach:** BFS with level tracking using the queue size at each level.

```go
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

func levelOrder(root *TreeNode) [][]int {
    if root == nil {
        return nil
    }

    result := [][]int{}
    queue := []*TreeNode{root}

    for len(queue) > 0 {
        levelSize := len(queue)
        level := make([]int, 0, levelSize)

        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]
            level = append(level, node.Val)

            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }

        result = append(result, level)
    }

    return result
}
```

**Time Complexity:** O(n). Every node is visited once.
**Space Complexity:** O(n). The queue holds at most one full level, which is up to n/2 for a complete tree.

**Edge cases:**
- Empty tree → empty result
- Single node → [[val]]
- Skewed tree (all left or all right) → each level has one element

---

### Problem 3: Rotting Oranges (LC 994)

**Problem:** In a grid, 0=empty, 1=fresh orange, 2=rotten orange. Every minute, fresh oranges adjacent to rotten ones become rotten. Return the minimum minutes until no fresh orange remains, or -1 if impossible.

**Approach:** Multi-source BFS. Start from ALL rotten oranges simultaneously. Each BFS level represents one minute.

```go
func orangesRotting(grid [][]int) int {
    rows, cols := len(grid), len(grid[0])
    queue := [][2]int{} // coordinates of rotten oranges
    fresh := 0

    // Initialize: find all rotten oranges and count fresh
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if grid[r][c] == 2 {
                queue = append(queue, [2]int{r, c})
            } else if grid[r][c] == 1 {
                fresh++
            }
        }
    }

    if fresh == 0 {
        return 0
    }

    directions := [4][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}
    minutes := 0

    for len(queue) > 0 && fresh > 0 {
        minutes++
        size := len(queue)

        for i := 0; i < size; i++ {
            cell := queue[0]
            queue = queue[1:]

            for _, d := range directions {
                nr, nc := cell[0]+d[0], cell[1]+d[1]
                if nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr][nc] == 1 {
                    grid[nr][nc] = 2
                    fresh--
                    queue = append(queue, [2]int{nr, nc})
                }
            }
        }
    }

    if fresh > 0 {
        return -1
    }
    return minutes
}
```

**Time Complexity:** O(m * n).
**Space Complexity:** O(m * n) for the queue.

**Edge cases:**
- No fresh oranges → return 0
- No rotten oranges but fresh exist → return -1
- Fresh oranges isolated by empty cells → return -1

---

### Problem 4: Course Schedule (LC 207), Topological Sort

**Problem:** There are `numCourses` courses labeled 0 to numCourses-1. `prerequisites[i] = [a, b]` means you must take course b before a. Determine if it is possible to finish all courses.

**Approach:** Topological sort via BFS (Kahn's algorithm). Build an adjacency list and in-degree count. Start from all nodes with in-degree 0. If we process all nodes, no cycle exists.

```go
func canFinish(numCourses int, prerequisites [][]int) bool {
    // Build adjacency list and in-degree
    adj := make([][]int, numCourses)
    inDegree := make([]int, numCourses)

    for _, pre := range prerequisites {
        course, prereq := pre[0], pre[1]
        adj[prereq] = append(adj[prereq], course)
        inDegree[course]++
    }

    // Start with all courses that have no prerequisites
    queue := []int{}
    for i := 0; i < numCourses; i++ {
        if inDegree[i] == 0 {
            queue = append(queue, i)
        }
    }

    processed := 0
    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]
        processed++

        for _, neighbor := range adj[node] {
            inDegree[neighbor]--
            if inDegree[neighbor] == 0 {
                queue = append(queue, neighbor)
            }
        }
    }

    return processed == numCourses
}
```

**Time Complexity:** O(V + E) where V = numCourses, E = len(prerequisites).
**Space Complexity:** O(V + E).

**Edge cases:**
- No prerequisites → always possible
- Self-loop → impossible
- Disconnected graph → each component checked independently
- Single course → always possible

---

### Problem 5: Word Ladder (LC 127)

**Problem:** Given `beginWord`, `endWord`, and a `wordList`, find the length of the shortest transformation sequence from beginWord to endWord, where each step changes exactly one letter and the intermediate word must be in wordList.

**Approach:** BFS from beginWord. Each level represents one transformation. Generate all possible one-letter changes and check if they are in the word set.

```go
func ladderLength(beginWord string, endWord string, wordList []string) int {
    wordSet := make(map[string]bool)
    for _, w := range wordList {
        wordSet[w] = true
    }

    if !wordSet[endWord] {
        return 0
    }

    queue := []string{beginWord}
    visited := map[string]bool{beginWord: true}
    level := 1

    for len(queue) > 0 {
        size := len(queue)
        level++

        for i := 0; i < size; i++ {
            word := queue[0]
            queue = queue[1:]

            // Try changing each character
            wordBytes := []byte(word)
            for j := 0; j < len(wordBytes); j++ {
                original := wordBytes[j]
                for c := byte('a'); c <= byte('z'); c++ {
                    if c == original {
                        continue
                    }
                    wordBytes[j] = c
                    newWord := string(wordBytes)

                    if newWord == endWord {
                        return level
                    }

                    if wordSet[newWord] && !visited[newWord] {
                        visited[newWord] = true
                        queue = append(queue, newWord)
                    }
                }
                wordBytes[j] = original
            }
        }
    }

    return 0
}
```

**Time Complexity:** O(M² * N) where M = word length, N = number of words. For each word we try 26 * M transformations, and string creation is O(M).
**Space Complexity:** O(M * N) for the word set and visited set.

**Edge cases:**
- endWord not in wordList → 0
- beginWord == endWord → technically 1, but problem usually guarantees they differ
- No valid transformation path → 0
- Very long word list: consider bidirectional BFS for optimization

---

### Junior → FAANG: Choosing Between BFS and DFS

The most common junior confusion: using DFS when the problem asks for the shortest path. DFS finds a path, not the shortest path. BFS finds the shortest path in an unweighted graph because it explores nodes layer by layer, and the first time a node is reached it is reached by the shortest route. Internalize this rule before your interview: "shortest path in unweighted graph" equals BFS, always.

For tree problems, the choice is more nuanced. Level-order traversal (BFS) and problems requiring knowledge of depth are natural BFS. Path sum, subtree comparison, and any problem phrased as "for every node, do X" is natural DFS because DFS follows the natural recursive structure of trees. When you are unsure, ask: "do I need to process all nodes at one level before moving to the next?" If yes, BFS. If the problem processes one path at a time from root to leaf, DFS.

Visited set management is a frequent source of bugs. For grid problems, modifying the grid cell to a sentinel value (e.g., '#') and restoring it after DFS is cleaner than maintaining a separate boolean matrix, but only if the function is expected to restore the grid to its original state. For graph problems, add a node to the visited set before pushing it to the queue (not after popping) to prevent duplicate enqueues on dense graphs.

Entry-level signal: correctly implementing multi-source BFS. Interviewers distinguish candidates who initialize all sources at once from those who loop over sources one at a time (which gives wrong shortest distances when sources are at varying positions relative to the same node).

### Senior @ FAANG: BFS and DFS as Graph Computation Primitives

In production systems, BFS and DFS underlie nearly every graph-structured computation. Build dependency resolution (Bazel, Gradle, Make) uses topological sort via DFS. Service mesh topology discovery uses BFS from a root service to establish latency tiers. Dead code elimination in compilers is a reachability computation via DFS from entry points. Recognizing these connections lets you apply interview-level algorithmic reasoning to real engineering decisions.

The distinction between BFS and DFS carries memory tradeoffs in production. BFS holds the widest level of the graph in its queue at once, so its peak memory is the width of the frontier. DFS holds one root-to-current path, so its peak is the depth. Neither exceeds O(V) once a visited set is in play, but which constant you pay depends entirely on shape: a wide, shallow graph is cheap for DFS and expensive for BFS, and a long, narrow graph is the reverse. A hub-and-spoke service graph puts every spoke in the BFS frontier at once while DFS never goes more than a couple of frames deep. Pick based on the topology you actually have, and note that if you need shortest paths the choice is already made for you, because DFS does not give them.

ADR consideration: for production graph traversal in Go, prefer iterative DFS (an explicit stack) over recursive DFS when graph depth can exceed a few thousand nodes. A goroutine stack starts at 2KB and grows by copying to a larger stack when it runs out, so deep recursion is survivable but pays repeated copy costs, and the stack only shrinks back at a later GC. The hard ceiling is `runtime/debug.SetMaxStack` (1GB on 64-bit by default), and blowing it is a fatal error that no `recover` can catch. That is the real argument for the explicit stack: an iterative traversal turns an unrecoverable crash into a heap allocation you can bound and observe. Document the maximum expected graph depth and whether an iterative implementation is required at your scale.

Bar-raiser signal: the candidate explains bidirectional BFS for Word Ladder without prompting, quantifies the search space reduction (from roughly b^d nodes explored to roughly 2·b^(d/2)), and states the meeting condition, which is that the two frontiers must be checked for intersection after each expansion rather than only at the end. They also note the precondition: bidirectional BFS needs the reverse graph, so it does not apply to a directed graph whose in-edges are unavailable or expensive to build. Word Ladder happens to be undirected, since a one-letter change is symmetric, which is exactly why the optimization is available here.
