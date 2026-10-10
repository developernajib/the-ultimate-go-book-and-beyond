## Complete Exercise Solutions

This section provides fully worked-out solutions for the exercises listed earlier in the chapter. Each solution includes the algorithm choice rationale and a brief explanation of why the approach works. Study these after attempting the exercises on your own.

### Exercise 2: Reconstruct Itinerary

**Problem**: Given airline tickets, find the itinerary that uses all tickets starting from "JFK". Visit airports in lexicographical order when tied.

```go
// LeetCode 332: Reconstruct Itinerary
// Hierholzer's algorithm for Eulerian path
// Time: O(E log E) (the log E is the sort - Hierholzer itself is O(E))
// Space: O(E)
import "sort"

func findItinerary(tickets [][]string) []string {
    // Build adjacency list with sorted destinations
    graph := make(map[string][]string)
    for _, ticket := range tickets {
        from, to := ticket[0], ticket[1]
        graph[from] = append(graph[from], to)
    }

    // Sort destinations in reverse order (we'll pop from end)
    for from := range graph {
        sort.Sort(sort.Reverse(sort.StringSlice(graph[from])))
    }

    result := []string{}

    var dfs func(airport string)
    dfs = func(airport string) {
        for len(graph[airport]) > 0 {
            // Pop next destination
            next := graph[airport][len(graph[airport])-1]
            graph[airport] = graph[airport][:len(graph[airport])-1]
            dfs(next)
        }
        // Add to result when no more destinations (post-order)
        result = append(result, airport)
    }

    dfs("JFK")

    // Reverse result
    for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
        result[i], result[j] = result[j], result[i]
    }

    return result
}
```

**Why Hierholzer's Algorithm Works**:

- An Eulerian path uses every **edge** exactly once. Vertices may repeat, which is why there is no visited set here: the ticket itself is consumed (`graph[airport] = graph[airport][:len-1]`), not the airport.
- Post-order is the load-bearing part. An airport is appended only after all its departures are exhausted, so a dead end lands at the front of `result` and ends up last after the reversal. This is what makes the algorithm robust to walking into a dead end that is not the true end of the itinerary: rather than backtracking, the stuck vertex is simply placed at the end of the path, and the remaining unused edges get stitched in ahead of it.
- Sorting each destination list in reverse and popping from the back yields the lexicographically smallest itinerary while keeping removal O(1).

On `[[JFK,SFO],[JFK,ATL],[SFO,ATL],[ATL,JFK],[ATL,SFO]]` this returns `[JFK ATL JFK SFO ATL SFO]`, note that JFK and SFO each appear twice, which a vertex-visited set would have prevented.

---

### Exercise 3: Pacific Atlantic Water Flow

**Problem**: Find cells where water can flow to both Pacific and Atlantic oceans.

```go
// LeetCode 417: Pacific Atlantic Water Flow
// Reverse BFS from oceans
// Time: O(m*n), Space: O(m*n)
func pacificAtlantic(heights [][]int) [][]int {
    if len(heights) == 0 || len(heights[0]) == 0 {
        return nil
    }

    m, n := len(heights), len(heights[0])
    pacific := make([][]bool, m)
    atlantic := make([][]bool, m)
    for i := range pacific {
        pacific[i] = make([]bool, n)
        atlantic[i] = make([]bool, n)
    }

    dirs := [][]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}

    // BFS from ocean borders (going uphill)
    bfs := func(starts [][]int, reachable [][]bool) {
        queue := starts
        for _, cell := range starts {
            reachable[cell[0]][cell[1]] = true
        }

        for len(queue) > 0 {
            cell := queue[0]
            queue = queue[1:]
            r, c := cell[0], cell[1]

            for _, d := range dirs {
                nr, nc := r+d[0], c+d[1]
                if nr >= 0 && nr < m && nc >= 0 && nc < n &&
                   !reachable[nr][nc] && heights[nr][nc] >= heights[r][c] {
                    reachable[nr][nc] = true
                    queue = append(queue, []int{nr, nc})
                }
            }
        }
    }

    // Pacific: top row and left column
    pacificStarts := [][]int{}
    for i := 0; i < m; i++ {
        pacificStarts = append(pacificStarts, []int{i, 0})
    }
    for j := 1; j < n; j++ {
        pacificStarts = append(pacificStarts, []int{0, j})
    }

    // Atlantic: bottom row and right column
    atlanticStarts := [][]int{}
    for i := 0; i < m; i++ {
        atlanticStarts = append(atlanticStarts, []int{i, n - 1})
    }
    for j := 0; j < n-1; j++ {
        atlanticStarts = append(atlanticStarts, []int{m - 1, j})
    }

    bfs(pacificStarts, pacific)
    bfs(atlanticStarts, atlantic)

    // Find cells reachable from both oceans
    result := [][]int{}
    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            if pacific[i][j] && atlantic[i][j] {
                result = append(result, []int{i, j})
            }
        }
    }

    return result
}
```

---

### Exercise 4: Network Delay Time

**Problem**: Find time for signal to reach all nodes from source.

```go
// LeetCode 743: Network Delay Time
// Dijkstra's algorithm (non-negative weights required)
// Time: O((V+E) log V), Space: O(V+E)
import "container/heap"

func networkDelayTime(times [][]int, n int, k int) int {
    const INF = 1 << 30

    // Build graph
    graph := make(map[int][][2]int)
    for _, t := range times {
        u, v, w := t[0], t[1], t[2]
        graph[u] = append(graph[u], [2]int{v, w})
    }

    // Dijkstra
    dist := make([]int, n+1)
    for i := range dist {
        dist[i] = INF
    }
    dist[k] = 0

    // Priority queue: (distance, node)
    pq := &IntPairHeap{{0, k}}
    heap.Init(pq)

    for pq.Len() > 0 {
        item := heap.Pop(pq).([2]int)
        d, node := item[0], item[1]

        if d > dist[node] {
            continue
        }

        for _, edge := range graph[node] {
            neighbor, weight := edge[0], edge[1]
            newDist := dist[node] + weight
            if newDist < dist[neighbor] {
                dist[neighbor] = newDist
                heap.Push(pq, [2]int{newDist, neighbor})
            }
        }
    }

    // Find max distance
    maxDist := 0
    for i := 1; i <= n; i++ {
        if dist[i] == INF {
            return -1
        }
        if dist[i] > maxDist {
            maxDist = dist[i]
        }
    }

    return maxDist
}

type IntPairHeap [][2]int

func (h IntPairHeap) Len() int           { return len(h) }
func (h IntPairHeap) Less(i, j int) bool { return h[i][0] < h[j][0] }
func (h IntPairHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *IntPairHeap) Push(x any)        { *h = append(*h, x.([2]int)) }
func (h *IntPairHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

### Junior → FAANG: Patterns Across the Exercise Solutions

The three exercise solutions cover three distinct graph algorithm families.

Reconstruct Itinerary (Hierholzer's algorithm) is the only Eulerian path problem in this set and it is rare in interviews. The key insight is post-order DFS: you add an airport to the result after exhausting all its departures, then reverse. Practice this one primarily for pattern recognition: "use every edge exactly once" means Eulerian path, and it is worth knowing the contrast that makes the classification matter. Eulerian (every **edge** once) is solvable in linear time. Hamiltonian (every **vertex** once) is NP-complete. One word changes the problem from easy to intractable, and noticing which one you were asked is the entire skill.

Pacific Atlantic Water Flow (reverse BFS from boundaries) demonstrates a practical technique: when the forward direction is hard to reason about (water flows downhill from a cell to its neighbors), reverse the direction (water flows uphill from the ocean boundary). Running BFS uphill from each ocean's boundary marks all cells that can flow to that ocean. The intersection is the answer.

Network Delay Time is a direct application of Dijkstra's with 1-indexed vertices. The only tricky part is the `dist[k] = 0` initialization using the given source `k` rather than vertex 0. Practice this one to build Dijkstra's muscle memory for weighted graph problems.

### Senior @ FAANG: Algorithmic Diversity and Interview Calibration

These three exercises represent different points on the difficulty spectrum and test different cognitive skills.

Hierholzer's algorithm (Eulerian path) tests problem classification: recognizing that "visit every edge exactly once" is fundamentally different from "visit every vertex" (Hamiltonian path, NP-complete). An L6 engineer immediately identifies this distinction and chooses Hierholzer's. An L4 engineer may attempt a generic DFS and get stuck when the result is not a valid Eulerian path.

Pacific Atlantic reverse BFS tests the ability to invert a problem statement. When the forward direction requires complex state tracking, reversing the direction often simplifies it dramatically. This inversion trick appears in many production algorithms: reverse topological sort to find all dependents of a node, reverse BFS to find the set of all vertices from which a target is reachable.

Network Delay Time tests Dijkstra's implementation discipline: 1-indexed vertices (allocate `n+1` and loop 1 to n), the lazy stale-entry skip, and the final max-distance step. The edge case that separates a clean solution from a complete one is reachability: if any vertex is not reachable from `k`, the answer is -1, not the max over the reachable ones. Note the precise term, since "not strongly connected" is the wrong one here. Strong connectivity means *every* vertex reaches every other, which is far more than this problem needs. The requirement is only that all vertices are reachable **from k**, which is a one-directional property. The `dist[i] == INF` check is what enforces it.

---
