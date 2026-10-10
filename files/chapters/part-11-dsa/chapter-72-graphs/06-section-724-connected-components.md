## 72.4 Connected Components

Connected components identify groups of vertices that can reach each other. In an undirected graph, a connected component is a maximal set of vertices where a path exists between any two vertices. In a directed graph, the stronger notion of "strongly connected components" requires that every vertex can reach every other vertex following edge directions. Finding connected components is fundamental to understanding graph structure and appears in problems like counting islands, network analysis, and community detection.

### Connected Components in Undirected Graph

A connected component is a group of vertices where every vertex is reachable from every other vertex in the group. To find all connected components, iterate through every vertex and start a BFS or DFS from each unvisited vertex. Each traversal discovers one complete component, and the total number of traversals gives you the number of connected components. This technique is the basis for problems like "Number of Islands."

```go
// ConnectedComponents returns number of connected components
func ConnectedComponents(graph *AdjacencyList) int {
    visited := make(map[int]bool)
    count := 0

    for v := 0; v < graph.Vertices(); v++ {
        if !visited[v] {
            bfsComponent(graph, v, visited)
            count++
        }
    }

    return count
}

func bfsComponent(graph *AdjacencyList, start int, visited map[int]bool) {
    queue := []int{start}
    visited[start] = true

    for len(queue) > 0 {
        vertex := queue[0]
        queue = queue[1:]

        for _, neighbor := range graph.Neighbors(vertex) {
            if !visited[neighbor] {
                visited[neighbor] = true
                queue = append(queue, neighbor)
            }
        }
    }
}

// GetComponents returns all components as lists of vertices
func GetComponents(graph *AdjacencyList) [][]int {
    visited := make(map[int]bool)
    components := [][]int{}

    for v := 0; v < graph.Vertices(); v++ {
        if !visited[v] {
            component := []int{}
            dfsComponent(graph, v, visited, &component)
            components = append(components, component)
        }
    }

    return components
}

func dfsComponent(graph *AdjacencyList, vertex int, visited map[int]bool, component *[]int) {
    visited[vertex] = true
    *component = append(*component, vertex)

    for _, neighbor := range graph.Neighbors(vertex) {
        if !visited[neighbor] {
            dfsComponent(graph, neighbor, visited, component)
        }
    }
}
```

### Strongly Connected Components (Kosaraju's Algorithm)

In a directed graph, a strongly connected component (SCC) is a maximal set of vertices where every vertex is reachable from every other vertex following edge directions. Kosaraju's algorithm finds all SCCs in two passes: first, it performs DFS on the original graph and records vertices by their finish time. Then, it performs DFS on the reversed graph in decreasing finish-time order. Each DFS tree in the second pass corresponds to one SCC. This runs in O(V + E) time.

```go
// SCCs finds strongly connected components in directed graph
// Kosaraju's algorithm: O(V + E)
func SCCs(graph *AdjacencyList) [][]int {
    n := graph.Vertices()

    // Step 1: Do DFS and fill stack by finish time
    visited := make(map[int]bool)
    stack := []int{}

    var fillOrder func(int)
    fillOrder = func(v int) {
        visited[v] = true
        for _, neighbor := range graph.Neighbors(v) {
            if !visited[neighbor] {
                fillOrder(neighbor)
            }
        }
        stack = append(stack, v)
    }

    for v := 0; v < n; v++ {
        if !visited[v] {
            fillOrder(v)
        }
    }

    // Step 2: Create reversed graph
    reversed := NewAdjacencyList(n, true)
    for v := 0; v < n; v++ {
        for _, neighbor := range graph.Neighbors(v) {
            reversed.AddEdge(neighbor, v)
        }
    }

    // Step 3: Do DFS on reversed graph in order of decreasing finish time
    visited = make(map[int]bool)
    sccs := [][]int{}

    for i := len(stack) - 1; i >= 0; i-- {
        v := stack[i]
        if !visited[v] {
            component := []int{}
            dfsComponent(reversed, v, visited, &component)
            sccs = append(sccs, component)
        }
    }

    return sccs
}
```

`SCCs` requires the input graph to be directed, since Step 2 reverses every edge by hand. Handing it an undirected `AdjacencyList` would double each edge and collapse every connected component into a single SCC.

### Junior → FAANG: Connected Components as the Islands Pattern

The "Number of Islands" problem is the most common connected components interview question, and it recurs constantly in disguise: regions, provinces, friend circles, and flood fill are all the same traversal wearing different nouns.

The pattern: iterate over all cells. When you find an unvisited land cell, start a DFS or BFS from it, marking all connected land cells as visited. Increment the component count. Repeat until all cells are visited.

Two common mistakes: (1) not marking cells as visited before enqueueing in BFS (causes duplicates and TLE), and (2) not handling the four-directional boundary check (accessing out-of-bounds indices causes panics). Always write the boundary check as a separate `isValid(r, c int)` function to keep the traversal logic clean.

The `SCCs` function (Kosaraju's) is harder and shows up in senior interviews. The key insight: after DFS on the original graph, the vertex with the latest finish time lies in a "source" SCC, one that nothing outside it points into. Reversing the edges makes that source a *sink*, so a DFS from it cannot escape its own component and therefore discovers exactly that SCC and nothing more. Peel it off, take the next-latest unvisited finish time, repeat.

That "cannot escape" is the whole argument, and it is worth being able to say in one sentence. The two-pass structure feels arbitrary until then. Trace it on `0->1->2->0, 2->3, 3->4->3`, which has SCCs `{0,1,2}`, `{3,4}`, and watch the reversal turn the reachability around.

### Senior @ FAANG: Connected Components in Large-Scale Systems

At production scale, connected components is a graph analytics primitive used in fraud detection (are these accounts part of the same ring?), recommendation systems (which users are in the same community?), and network reliability analysis (which sets of nodes can reach each other if specific links fail?).

For graphs with billions of vertices, sequential DFS/BFS is too slow. The production algorithm is label propagation: each vertex starts with its own ID as a label, then repeatedly adopts the minimum label among its neighbors and itself. After O(diameter) rounds, all vertices in the same component have the same label. Label propagation is embarrassingly parallel and maps directly to the Pregel BSP model.

For strongly connected components at scale, the standard approach is Tarjan's algorithm (single-pass DFS with a stack) rather than Kosaraju's (two-pass DFS with graph reversal). The reason is that graph reversal at billion-edge scale requires storing the reversed graph in memory, which doubles the memory footprint. Tarjan's algorithm finds SCCs in a single pass without materialising the reversed graph.

A staff engineer owning a community detection system at this scale owns three decisions: which SCC algorithm (Tarjan's vs Kosaraju's based on memory budget), how to parallelise it (vertex-centric Pregel model vs edge-centric PowerGraph model), and how to handle dynamic graphs (incremental SCC update algorithms when edges are added or removed continuously). Each decision is documented and justified in an engineering design document before any code is written.
