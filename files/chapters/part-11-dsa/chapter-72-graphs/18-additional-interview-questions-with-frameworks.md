## Additional Interview Questions with Frameworks

These advanced interview questions go beyond basic traversal and require combining multiple graph techniques. Each question includes a visual framework diagram that breaks down the problem-solving approach, followed by a complete Go implementation. These problems are commonly asked at Google, Amazon, and Meta onsite interviews.

### Question 3: Find Critical Connections (Bridges)

**Problem**: Find all edges whose removal disconnects the graph.

```
┌─────────────────────────────────────────────────────────────────┐
│           TARJAN'S BRIDGE FINDING ALGORITHM                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Concept: An edge (u,v) is a bridge if there's no back edge     │
│  from v's subtree that reaches above u.                         │
│                                                                 │
│  Track for each node:                                           │
│  • disc[v]: Discovery time when v is first visited              │
│  • low[v]: Minimum discovery time reachable from v's subtree    │
│                                                                 │
│  Bridge Condition:                                              │
│  Edge (u,v) is a bridge if low[v] > disc[u]                     │
│  (v's subtree can't reach u or anything above it)               │
│                                                                 │
│  Example: edges 0-1, 1-2, 2-0, 1-3                              │
│                                                                 │
│        0 ─────── 1 ─── 3                                        │
│        │       ╱                                                │
│        │      ╱                                                 │
│        2 ────╱                                                  │
│                                                                 │
│  Bridge:     (1,3)  removing it strands 3                       │
│  Not bridges: 0-1, 1-2, 2-0  each lies on the triangle,         │
│               so removing any one leaves the rest connected     │
│                                                                 │
│  Note: in a TREE every edge is a bridge, since a tree has no    │
│  cycles at all. Only an edge on a cycle is safe to remove.      │
│                                                                 │
│  Time: O(V + E), Space: O(V)                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 1192: Critical Connections in a Network
// Tarjan's algorithm for finding bridges
// Time: O(V + E), Space: O(V)
func criticalConnections(n int, connections [][]int) [][]int {
    // Build adjacency list
    graph := make([][]int, n)
    for _, conn := range connections {
        u, v := conn[0], conn[1]
        graph[u] = append(graph[u], v)
        graph[v] = append(graph[v], u)
    }

    disc := make([]int, n)  // Discovery time
    low := make([]int, n)   // Lowest reachable discovery time
    for i := range disc {
        disc[i] = -1
    }

    time := 0
    result := [][]int{}

    var dfs func(node, parent int)
    dfs = func(node, parent int) {
        disc[node] = time
        low[node] = time
        time++

        for _, neighbor := range graph[node] {
            if disc[neighbor] == -1 {
                // Tree edge: not yet visited
                dfs(neighbor, node)
                low[node] = min(low[node], low[neighbor])

                // Bridge condition: can't reach node from neighbor's subtree
                if low[neighbor] > disc[node] {
                    result = append(result, []int{node, neighbor})
                }
            } else if neighbor != parent {
                // Back edge: already visited, not the parent
                low[node] = min(low[node], disc[neighbor])
            }
        }
    }

    dfs(0, -1)
    return result
}
```

On `n=4` with `[[0,1],[1,2],[2,0],[1,3]]` this returns `[[1 3]]`, the only bridge. On the tree `0-1, 1-2, 1-3, 3-4` it returns all four edges, which is correct and worth internalizing: **every edge of a tree is a bridge.**

Two preconditions the LeetCode constraints hide. `dfs(0, -1)` is called once, so a disconnected graph would leave other components unexplored (LeetCode 1192 guarantees connectivity). And the `neighbor != parent` test assumes no parallel edges: two distinct connections between the same pair form a cycle, so neither is a bridge, but this code would skip both as "the parent edge" and wrongly report a bridge. Track the edge index rather than the parent vertex if parallel edges are possible.

---

### Question 4: Cheapest Flights Within K Stops

**Problem**: Find cheapest price from source to destination with at most K stops.

```
┌─────────────────────────────────────────────────────────────────┐
│           MODIFIED DIJKSTRA/BELLMAN-FORD FRAMEWORK              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Challenge: Regular Dijkstra doesn't track number of stops.     │
│  Need to track both cost AND stops.                             │
│                                                                 │
│  Approach 1: BFS with level tracking                            │
│  • Process all nodes at current stop count before next          │
│  • Time: O(K * E), Space: O(V)                                  │
│                                                                 │
│  Approach 2: Bellman-Ford (K+1 iterations)                      │
│  • Relax all edges K+1 times (K stops = K+1 edges)              │
│  • Time: O(K * E), Space: O(V)                                  │
│                                                                 │
│  Approach 3: Modified Dijkstra                                  │
│  • State: (node, stops_remaining)                               │
│  • Allow re-visiting node with different stops                  │
│  • Time: O(K * E * log(K*V)), Space: O(K * V)                   │
│                                                                 │
│  Best for interviews: Bellman-Ford (simplest, reliable)         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 787: Cheapest Flights Within K Stops
// Bellman-Ford approach - K+1 relaxations
// Time: O(K * E), Space: O(V)
func findCheapestPrice(n int, flights [][]int, src int, dst int, k int) int {
    const INF = 1 << 30
    prices := make([]int, n)
    for i := range prices {
        prices[i] = INF
    }
    prices[src] = 0

    // K stops means K+1 edges maximum
    for i := 0; i <= k; i++ {
        // Copy current prices to avoid using updated values in same round
        temp := make([]int, n)
        copy(temp, prices)

        for _, flight := range flights {
            from, to, price := flight[0], flight[1], flight[2]
            if prices[from] != INF {
                temp[to] = min(temp[to], prices[from]+price)
            }
        }
        prices = temp
    }

    if prices[dst] == INF {
        return -1
    }
    return prices[dst]
}

// BFS Level-by-Level approach
func findCheapestPriceBFS(n int, flights [][]int, src int, dst int, k int) int {
    const INF = 1 << 30

    // Build adjacency list
    graph := make(map[int][][2]int)
    for _, f := range flights {
        graph[f[0]] = append(graph[f[0]], [2]int{f[1], f[2]})
    }

    // BFS with (node, cost)
    dist := make([]int, n)
    for i := range dist {
        dist[i] = INF
    }
    dist[src] = 0

    queue := [][2]int{{src, 0}} // {node, cost}
    stops := 0

    for len(queue) > 0 && stops <= k {
        size := len(queue)
        // Process all nodes at current level
        for i := 0; i < size; i++ {
            curr := queue[0]
            queue = queue[1:]
            node, cost := curr[0], curr[1]

            for _, edge := range graph[node] {
                neighbor, price := edge[0], edge[1]
                newCost := cost + price

                if newCost < dist[neighbor] {
                    dist[neighbor] = newCost
                    queue = append(queue, [2]int{neighbor, newCost})
                }
            }
        }
        stops++
    }

    if dist[dst] == INF {
        return -1
    }
    return dist[dst]
}
```

---

### Question 5: Alien Dictionary

**Problem**: Given sorted words in an alien language, derive the character order.

```
┌─────────────────────────────────────────────────────────────────┐
│           TOPOLOGICAL SORT FROM CONSTRAINTS                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Key Insight: Adjacent words reveal ordering constraints.       │
│                                                                 │
│  Compare consecutive words to find edges:                       │
│  "wrt" vs "wrf" → t comes before f (edge: t→f)                  │
│  "wrf" vs "er"  → w comes before e (edge: w→e)                  │
│  "er"  vs "ett" → r comes before t (edge: r→t)                  │
│                                                                 │
│  Build directed graph and topological sort.                     │
│                                                                 │
│  Edge cases:                                                    │
│  1. Invalid: "abc" before "ab" (longer prefix first = invalid)  │
│  2. Cycle: Contradiction in orderings                           │
│  3. Multiple valid orderings: Return any                        │
│                                                                 │
│  Time: O(C) where C = total characters                          │
│  Space: O(U) where U = unique characters                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 269: Alien Dictionary
// Time: O(C) total characters, Space: O(U) unique characters
func alienOrder(words []string) string {
    // Build graph
    graph := make(map[byte]map[byte]bool)
    inDegree := make(map[byte]int)

    // Initialize all characters
    for _, word := range words {
        for i := 0; i < len(word); i++ {
            if graph[word[i]] == nil {
                graph[word[i]] = make(map[byte]bool)
            }
            inDegree[word[i]] = inDegree[word[i]] // Initialize if not exists
        }
    }

    // Compare adjacent words to find edges
    for i := 0; i < len(words)-1; i++ {
        word1, word2 := words[i], words[i+1]
        minLen := min(len(word1), len(word2))

        // Check for invalid case: "abc" before "ab"
        if len(word1) > len(word2) && word1[:minLen] == word2[:minLen] {
            return ""
        }

        // Find first different character
        for j := 0; j < minLen; j++ {
            if word1[j] != word2[j] {
                if !graph[word1[j]][word2[j]] {
                    graph[word1[j]][word2[j]] = true
                    inDegree[word2[j]]++
                }
                break
            }
        }
    }

    // Topological sort using Kahn's algorithm
    queue := []byte{}
    for char := range graph {
        if inDegree[char] == 0 {
            queue = append(queue, char)
        }
    }

    result := []byte{}
    for len(queue) > 0 {
        char := queue[0]
        queue = queue[1:]
        result = append(result, char)

        for neighbor := range graph[char] {
            inDegree[neighbor]--
            if inDegree[neighbor] == 0 {
                queue = append(queue, neighbor)
            }
        }
    }

    // Cycle detection
    if len(result) != len(graph) {
        return ""
    }

    return string(result)
}
```

---

### Question 6: Minimum Height Trees

**Problem**: Find all roots that minimize tree height in an undirected tree.

```
┌─────────────────────────────────────────────────────────────────┐
│           TREE CENTER FINDING ALGORITHM                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Key Insight: The center of a tree minimizes max distance       │
│  to all other nodes. Trees have 1 or 2 centers.                 │
│                                                                 │
│  Algorithm: Repeatedly remove leaves (degree 1 nodes)           │
│  until 1 or 2 nodes remain.                                     │
│                                                                 │
│  Example:                                                       │
│       0 ─── 1 ─── 2 ─── 3 ─── 4                                 │
│                                                                 │
│  Round 1: Remove leaves 0, 4                                    │
│       1 ─── 2 ─── 3                                             │
│                                                                 │
│  Round 2: Remove leaves 1, 3                                    │
│       2 ← CENTER                                                │
│                                                                 │
│  Time: O(V), Space: O(V)                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 310: Minimum Height Trees
// Time: O(V), Space: O(V)
func findMinHeightTrees(n int, edges [][]int) []int {
    if n == 1 {
        return []int{0}
    }

    // Build adjacency list with sets for easy removal
    graph := make([]map[int]bool, n)
    for i := range graph {
        graph[i] = make(map[int]bool)
    }

    for _, edge := range edges {
        u, v := edge[0], edge[1]
        graph[u][v] = true
        graph[v][u] = true
    }

    // Find initial leaves (degree 1)
    leaves := []int{}
    for i := 0; i < n; i++ {
        if len(graph[i]) == 1 {
            leaves = append(leaves, i)
        }
    }

    remainingNodes := n

    // Repeatedly trim leaves until 1 or 2 nodes remain
    for remainingNodes > 2 {
        remainingNodes -= len(leaves)
        newLeaves := []int{}

        for _, leaf := range leaves {
            // Find the single neighbor. Name it anything but `n`: that
            // would shadow the vertex-count parameter.
            var neighbor int
            for v := range graph[leaf] {
                neighbor = v
            }

            // Remove edge
            delete(graph[neighbor], leaf)

            // Check if neighbor becomes a leaf
            if len(graph[neighbor]) == 1 {
                newLeaves = append(newLeaves, neighbor)
            }
        }

        leaves = newLeaves
    }

    return leaves
}
```

### Junior → FAANG: Framework Patterns Across the Four Problems

The four problems in this section illustrate four different ways that graph algorithms combine.

Critical Connections (Tarjan's bridges) combines DFS with discovery time tracking. The `disc` and `low` arrays record when each vertex was first visited and the minimum discovery time reachable from that vertex's subtree. A bridge exists when a child cannot reach back above its parent. This pattern generalizes to articulation point finding (vertices whose removal disconnects the graph).

Cheapest Flights Within K Stops shows that adding a constraint (number of stops) to a shortest-path problem requires a different algorithm or state representation. The Bellman-Ford approach enforces the stop constraint by limiting relaxation rounds. The BFS approach enforces it by processing level by level.

Alien Dictionary is a topological sort extraction problem: the graph is hidden inside the data and must be inferred by comparing adjacent words. This inference step (building the graph from implicit constraints) is the hardest part and appears in many disguised topological sort problems.

Minimum Height Trees uses the "leaf pruning" pattern: repeatedly remove degree-1 vertices until 1 or 2 remain. This pattern appears in any problem where you need the "center" or "core" of a tree structure.

### Senior @ FAANG: Composing Graph Primitives in System Design

At staff level, the value of knowing these four advanced problems is not the algorithms themselves but the ability to compose them into system designs.

Tarjan's bridge finding has a direct application in network reliability analysis: run bridge finding on the network topology graph to identify single points of failure, then prioritize adding redundant links for each bridge in order of traffic volume crossing that bridge. The system design includes: periodic topology discovery (LLDP or BGP route table), bridge finding (Tarjan's, O(V+E)), traffic measurement (per-link SNMP counters), and a dashboard showing bridges sorted by redundancy risk. The algorithm is one component in a reliability engineering workflow.

Cheapest Flights Within K Stops models multi-hop routing under a hop budget. The closest real analogy is BGP, which is a **path-vector** protocol: distance-vector (that is, distributed Bellman-Ford) extended so each advertisement carries the full AS-path. That path is what gives BGP loop detection for free, since a router rejects any route whose AS-path already contains its own AS number, which is the direct answer to the count-to-infinity problem that plagues plain distance-vector protocols. Be careful with the analogy's limits: AS-path length is one tiebreaker in BGP's decision process, well below local preference, and BGP does not enforce a hard K-hop budget the way LeetCode 787 does. The shared idea is "shortest path where path *length in hops* is part of the decision, not just accumulated cost".

Alien Dictionary models any problem where a total order must be inferred from scattered pairwise constraints. Compiler and build dependency analysis is the cleanest example: an include or import graph yields edges, and topological sort yields a legal processing order. Git is a better example than it first appears, but not for merge conflicts: conflict resolution is a three-way content diff and has nothing to do with topological sort. What git genuinely topologically sorts is the commit DAG itself, which is why `git log --topo-order` exists and why a parent commit can never be shown after its child. The pattern in all of these: extract constraints as directed edges, validate that no cycle exists, then topologically sort.

Composing these patterns into novel solutions is the L6 algorithmic signal: not "I know Tarjan's" but "I recognize that this network reliability problem is Tarjan's bridge finding composed with weighted top-K, and here is how I would implement it end to end."

---
