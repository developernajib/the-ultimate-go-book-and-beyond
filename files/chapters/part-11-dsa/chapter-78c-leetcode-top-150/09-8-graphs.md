## 78C.8 Graphs

Graph problems require BFS, DFS, topological sort, and shortest-path algorithms. Represent graphs with adjacency lists.

---
### LC 200 - Number of Islands 🟡

**Key Insight**: Each unvisited '1' starts a DFS/BFS that marks the entire island, so count the number of such starts.

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
**Time**: O(m × n).
**Space**: O(m × n) worst-case recursion.

---
### LC 133 - Clone Graph 🟡

**Key Insight**: Use a hash map from original to clone. DFS to visit all neighbors, creating clones on first visit.

```go
type Node struct {
    Val       int
    Neighbors []*Node
}

func cloneGraph(node *Node) *Node {
    if node == nil {
        return nil
    }

    visited := make(map[*Node]*Node)

    var dfs func(n *Node) *Node
    dfs = func(n *Node) *Node {
        if clone, ok := visited[n]; ok {
            return clone
        }
        clone := &Node{Val: n.Val}
        visited[n] = clone
        for _, neighbor := range n.Neighbors {
            clone.Neighbors = append(clone.Neighbors, dfs(neighbor))
        }
        return clone
    }

    return dfs(node)
}
```
**Time**: O(V + E).
**Space**: O(V).

---
### LC 207 - Course Schedule 🟡

**Key Insight**: Topological sort. Detect cycles using DFS with three states (unvisited, in-progress, done).

```go
func canFinish(numCourses int, prerequisites [][]int) bool {
    graph := make([][]int, numCourses)
    for _, p := range prerequisites {
        graph[p[1]] = append(graph[p[1]], p[0])
    }

    // 0=unvisited, 1=in-progress, 2=done
    state := make([]int, numCourses)

    var dfs func(node int) bool
    dfs = func(node int) bool {
        if state[node] == 1 {
            return false // cycle
        }
        if state[node] == 2 {
            return true
        }
        state[node] = 1
        for _, next := range graph[node] {
            if !dfs(next) {
                return false
            }
        }
        state[node] = 2
        return true
    }

    for i := 0; i < numCourses; i++ {
        if !dfs(i) {
            return false
        }
    }
    return true
}
```
**Time**: O(V + E).
**Space**: O(V + E).

---
### LC 210 - Course Schedule II 🟡

**Key Insight**: Same as cycle detection, but collect nodes in reverse post-order. That is the topological order.

```go
func findOrder(numCourses int, prerequisites [][]int) []int {
    graph := make([][]int, numCourses)
    for _, p := range prerequisites {
        graph[p[1]] = append(graph[p[1]], p[0])
    }

    state := make([]int, numCourses)
    var order []int

    var dfs func(node int) bool
    dfs = func(node int) bool {
        if state[node] == 1 {
            return false
        }
        if state[node] == 2 {
            return true
        }
        state[node] = 1
        for _, next := range graph[node] {
            if !dfs(next) {
                return false
            }
        }
        state[node] = 2
        order = append(order, node)
        return true
    }

    for i := 0; i < numCourses; i++ {
        if !dfs(i) {
            return nil
        }
    }

    // Reverse
    for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
        order[i], order[j] = order[j], order[i]
    }
    return order
}
```
**Time**: O(V + E).
**Space**: O(V + E).

---
### LC 417 - Pacific Atlantic Water Flow 🟡

**Key Insight**: BFS/DFS from the ocean borders inward. Cells reachable from both the Pacific and Atlantic borders are in the result.

```go
func pacificAtlantic(heights [][]int) [][]int {
    if len(heights) == 0 {
        return nil
    }
    rows, cols := len(heights), len(heights[0])

    pacific := make([][]bool, rows)
    atlantic := make([][]bool, rows)
    for i := range pacific {
        pacific[i] = make([]bool, cols)
        atlantic[i] = make([]bool, cols)
    }

    dirs := [][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}

    var dfs func(r, c int, visited [][]bool)
    dfs = func(r, c int, visited [][]bool) {
        visited[r][c] = true
        for _, d := range dirs {
            nr, nc := r+d[0], c+d[1]
            if nr >= 0 && nr < rows && nc >= 0 && nc < cols &&
                !visited[nr][nc] && heights[nr][nc] >= heights[r][c] {
                dfs(nr, nc, visited)
            }
        }
    }

    for r := 0; r < rows; r++ {
        dfs(r, 0, pacific)
        dfs(r, cols-1, atlantic)
    }
    for c := 0; c < cols; c++ {
        dfs(0, c, pacific)
        dfs(rows-1, c, atlantic)
    }

    var result [][]int
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if pacific[r][c] && atlantic[r][c] {
                result = append(result, []int{r, c})
            }
        }
    }
    return result
}
```
**Time**: O(m × n).
**Space**: O(m × n).

---
### LC 994 - Rotting Oranges 🟡

**Key Insight**: Multi-source BFS. Start from all rotten oranges simultaneously and spread rot level by level.

```go
func orangesRotting(grid [][]int) int {
    rows, cols := len(grid), len(grid[0])
    queue := [][2]int{}
    fresh := 0

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

    dirs := [][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}
    minutes := 0

    for len(queue) > 0 {
        size := len(queue)
        for i := 0; i < size; i++ {
            r, c := queue[0][0], queue[0][1]
            queue = queue[1:]
            for _, d := range dirs {
                nr, nc := r+d[0], c+d[1]
                if nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr][nc] == 1 {
                    grid[nr][nc] = 2
                    fresh--
                    queue = append(queue, [2]int{nr, nc})
                }
            }
        }
        minutes++
    }

    if fresh > 0 {
        return -1
    }
    return minutes - 1
}
```
**Time**: O(m × n).
**Space**: O(m × n).

---
### LC 743 - Network Delay Time 🟡

**Key Insight**: Dijkstra's algorithm finds the shortest path from the source to all nodes. The answer is the maximum of those shortest paths.

```go
import "container/heap"

func networkDelayTime(times [][]int, n int, k int) int {
    graph := make(map[int][][2]int)
    for _, t := range times {
        graph[t[0]] = append(graph[t[0]], [2]int{t[1], t[2]})
    }

    dist := make([]int, n+1)
    for i := range dist {
        dist[i] = 1<<31 - 1
    }
    dist[k] = 0

    h := &DistHeap{{0, k}}
    heap.Init(h)

    for h.Len() > 0 {
        top := heap.Pop(h).([2]int)
        d, u := top[0], top[1]
        if d > dist[u] {
            continue
        }
        for _, edge := range graph[u] {
            v, w := edge[0], edge[1]
            if dist[u]+w < dist[v] {
                dist[v] = dist[u] + w
                heap.Push(h, [2]int{dist[v], v})
            }
        }
    }

    maxDist := 0
    for i := 1; i <= n; i++ {
        if dist[i] == 1<<31-1 {
            return -1
        }
        if dist[i] > maxDist {
            maxDist = dist[i]
        }
    }
    return maxDist
}

type DistHeap [][2]int

func (h DistHeap) Len() int            { return len(h) }
func (h DistHeap) Less(i, j int) bool  { return h[i][0] < h[j][0] }
func (h DistHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *DistHeap) Push(x any) { *h = append(*h, x.([2]int)) }
func (h *DistHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: O(E log V).
**Space**: O(V + E).

---
### LC 787 - Cheapest Flights Within K Stops 🟡

**Key Insight**: Use Bellman-Ford limited to k+1 relaxation rounds. Each round allows one more stop.

```go
func findCheapestPrice(n int, flights [][]int, src int, dst int, k int) int {
    const inf = 1<<31 - 1
    prices := make([]int, n)
    for i := range prices {
        prices[i] = inf
    }
    prices[src] = 0

    for i := 0; i <= k; i++ {
        temp := make([]int, n)
        copy(temp, prices)
        for _, f := range flights {
            from, to, price := f[0], f[1], f[2]
            if prices[from] != inf && prices[from]+price < temp[to] {
                temp[to] = prices[from] + price
            }
        }
        prices = temp
    }

    if prices[dst] == inf {
        return -1
    }
    return prices[dst]
}
```
**Time**: O(k × E).
**Space**: O(V).

---
### LC 261 - Graph Valid Tree 🟡

**Key Insight**: A valid tree has exactly n-1 edges and is fully connected. Use Union-Find to detect cycles.

```go
func validTree(n int, edges [][]int) bool {
    if len(edges) != n-1 {
        return false
    }

    parent := make([]int, n)
    rank := make([]int, n)
    for i := range parent {
        parent[i] = i
    }

    var find func(x int) int
    find = func(x int) int {
        if parent[x] != x {
            parent[x] = find(parent[x])
        }
        return parent[x]
    }

    union := func(x, y int) bool {
        px, py := find(x), find(y)
        if px == py {
            return false
        }
        if rank[px] < rank[py] {
            px, py = py, px
        }
        parent[py] = px
        if rank[px] == rank[py] {
            rank[px]++
        }
        return true
    }

    for _, e := range edges {
        if !union(e[0], e[1]) {
            return false
        }
    }
    return true
}
```
**Time**: O(E × α(V)) ≈ O(E).
**Space**: O(V).

---
### LC 323 - Number of Connected Components in an Undirected Graph 🟡

**Key Insight**: Union-Find, where each successful union reduces the component count by one.

```go
func countComponents(n int, edges [][]int) int {
    parent := make([]int, n)
    rank := make([]int, n)
    for i := range parent {
        parent[i] = i
    }
    components := n

    var find func(x int) int
    find = func(x int) int {
        if parent[x] != x {
            parent[x] = find(parent[x])
        }
        return parent[x]
    }

    for _, e := range edges {
        px, py := find(e[0]), find(e[1])
        if px != py {
            if rank[px] < rank[py] {
                px, py = py, px
            }
            parent[py] = px
            if rank[px] == rank[py] {
                rank[px]++
            }
            components--
        }
    }
    return components
}
```
**Time**: O(E × α(V)).
**Space**: O(V).

---
### LC 269 - Alien Dictionary 🔴

**Key Insight**: Build a directed graph from adjacent word comparisons. A topological sort gives the character order.

```go
func alienOrder(words []string) string {
    graph := make(map[byte]map[byte]bool)
    inDegree := make(map[byte]int)

    // Initialize all characters
    for _, word := range words {
        for i := 0; i < len(word); i++ {
            if graph[word[i]] == nil {
                graph[word[i]] = make(map[byte]bool)
            }
            inDegree[word[i]] += 0 // ensure key exists
        }
    }

    // Build edges from adjacent words
    for i := 0; i < len(words)-1; i++ {
        w1, w2 := words[i], words[i+1]
        minLen := len(w1)
        if len(w2) < minLen {
            minLen = len(w2)
        }

        // Check for invalid case: prefix
        if len(w1) > len(w2) && w1[:minLen] == w2[:minLen] {
            return ""
        }

        for j := 0; j < minLen; j++ {
            if w1[j] != w2[j] {
                if !graph[w1[j]][w2[j]] {
                    graph[w1[j]][w2[j]] = true
                    inDegree[w2[j]]++
                }
                break
            }
        }
    }

    // Topological sort (BFS)
    queue := []byte{}
    for c := range inDegree {
        if inDegree[c] == 0 {
            queue = append(queue, c)
        }
    }

    var result []byte
    for len(queue) > 0 {
        c := queue[0]
        queue = queue[1:]
        result = append(result, c)
        for next := range graph[c] {
            inDegree[next]--
            if inDegree[next] == 0 {
                queue = append(queue, next)
            }
        }
    }

    if len(result) != len(inDegree) {
        return "" // cycle detected
    }
    return string(result)
}
```
**Time**: O(C) where C is total characters in all words.
**Space**: O(V + E) where V is unique characters.

---
### LC 684 - Redundant Connection 🟡

**Key Insight**: Union-Find. The first edge that connects two already-connected components is the redundant one.

```go
func findRedundantConnection(edges [][]int) []int {
    n := len(edges)
    parent := make([]int, n+1)
    rank := make([]int, n+1)
    for i := range parent {
        parent[i] = i
    }

    var find func(x int) int
    find = func(x int) int {
        if parent[x] != x {
            parent[x] = find(parent[x])
        }
        return parent[x]
    }

    for _, e := range edges {
        px, py := find(e[0]), find(e[1])
        if px == py {
            return e
        }
        if rank[px] < rank[py] {
            px, py = py, px
        }
        parent[py] = px
        if rank[px] == rank[py] {
            rank[px]++
        }
    }
    return nil
}
```
**Time**: O(E × α(V)).
**Space**: O(V).

---

### Junior → FAANG: Graph Representation and Traversal Setup

Before any graph traversal, the setup phase matters as much as the algorithm. Confirm three things: (1) is the graph directed or undirected (affects adjacency list construction), (2) can there be cycles (affects whether a visited set is needed), and (3) is it possible for the graph to be disconnected (affects whether you need to run BFS/DFS from every unvisited node rather than just one source).

Number of Islands is the entry-level grid graph problem. The grid is an implicit graph where each cell is a node and adjacent cells are edges. The BFS/DFS is identical to explicit graph traversal. The only difference is neighbor enumeration (four-directional vs. adjacency list lookup). Practice this problem until the grid-to-graph translation is automatic.

Course Schedule (topological sort plus cycle detection) is the most important graph problem in this section. Learn both formulations, because this chapter uses each one: Course Schedule above uses the DFS three-colour approach, and Alien Dictionary uses Kahn's algorithm. Kahn's works by maintaining an in-degree count, seeding a queue with every zero-in-degree node, and decrementing in-degrees as nodes are processed. If the number of processed nodes equals the total number of nodes, no cycle exists. The DFS version detects a cycle by re-entering a node still marked in-progress. Being able to write either one on demand, and to say which you prefer and why, is the interview signal.

### Senior @ FAANG: Graph Algorithms in Service Mesh and Dependency Management

Topological sort is the algorithm behind every build system and package manager. When `go mod tidy` resolves dependency versions, it is performing topological sort over the module dependency graph to determine the correct build order. When a circular dependency is detected, it is exactly the cycle detection step of topological sort that raises the error. Understanding this connection lets you debug "import cycle not allowed" errors in Go with algorithmic clarity rather than trial and error.

In a microservices architecture, the service dependency graph can be analyzed with the same algorithms: topological sort reveals the deployment order that minimizes downtime during rolling upgrades. Strongly connected components (Tarjan's or Kosaraju's algorithm) identify clusters of mutually dependent services that cannot be independently deployed, which is a key input for service boundary redesign decisions. Treating the service graph as a first-class algorithmic artifact, and applying graph algorithms to it, is a staff-level engineering practice that produces concrete architectural insights.
