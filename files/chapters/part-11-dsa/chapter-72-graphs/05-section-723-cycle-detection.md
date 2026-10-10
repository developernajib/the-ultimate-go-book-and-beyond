## 72.3 Cycle Detection

Detecting cycles is one of the most common graph tasks in both interviews and real-world systems. A cycle means there is a path that starts and ends at the same vertex. Cycle detection is critical for validating dependency graphs (circular dependencies break build systems), detecting deadlocks in concurrent programs, and verifying that a graph is a DAG before running topological sort. The approach differs significantly between undirected and directed graphs.

### Cycle Detection in Undirected Graph

In an undirected graph, a cycle exists when DFS encounters a visited neighbor that is not the parent of the current vertex. The key idea is simple: as you traverse edges, if you reach a vertex that has already been visited and it is not the vertex you just came from, you have found a back edge that forms a cycle. This algorithm checks every connected component by starting DFS from each unvisited vertex.

```go
// HasCycleUndirected detects cycle in undirected graph using DFS
func HasCycleUndirected(graph *AdjacencyList) bool {
    visited := make(map[int]bool)

    for v := 0; v < graph.Vertices(); v++ {
        if !visited[v] {
            if hasCycleUndirectedDFS(graph, v, -1, visited) {
                return true
            }
        }
    }

    return false
}

func hasCycleUndirectedDFS(graph *AdjacencyList, vertex, parent int, visited map[int]bool) bool {
    visited[vertex] = true

    for _, neighbor := range graph.Neighbors(vertex) {
        if !visited[neighbor] {
            if hasCycleUndirectedDFS(graph, neighbor, vertex, visited) {
                return true
            }
        } else if neighbor != parent {
            // Found a back edge
            return true
        }
    }

    return false
}
```

### Cycle Detection in Directed Graph

Cycle detection in a directed graph requires a different approach than in undirected graphs. The standard technique uses three-color marking: white (unvisited), gray (currently being processed in the DFS recursion stack), and black (fully processed). A cycle exists if DFS encounters a gray vertex, which means you have found a back edge leading to an ancestor still on the current path. Simply checking "visited" is not enough because a visited-but-finished vertex (black) does not indicate a cycle.

```go
// HasCycleDirected detects cycle in directed graph
// Uses three colors: white (0), gray (1), black (2)
func HasCycleDirected(graph *AdjacencyList) bool {
    color := make(map[int]int) // 0: white, 1: gray, 2: black

    for v := 0; v < graph.Vertices(); v++ {
        if color[v] == 0 {
            if hasCycleDirectedDFS(graph, v, color) {
                return true
            }
        }
    }

    return false
}

func hasCycleDirectedDFS(graph *AdjacencyList, vertex int, color map[int]int) bool {
    color[vertex] = 1 // Mark as gray (being processed)

    for _, neighbor := range graph.Neighbors(vertex) {
        if color[neighbor] == 1 {
            // Back edge to gray vertex = cycle
            return true
        }
        if color[neighbor] == 0 {
            if hasCycleDirectedDFS(graph, neighbor, color) {
                return true
            }
        }
    }

    color[vertex] = 2 // Mark as black (finished)
    return false
}

// FindCycle returns one cycle if exists
func FindCycle(graph *AdjacencyList) []int {
    color := make(map[int]int)
    parent := make(map[int]int)
    var cycleStart, cycleEnd int
    foundCycle := false

    var dfs func(int) bool
    dfs = func(vertex int) bool {
        color[vertex] = 1

        for _, neighbor := range graph.Neighbors(vertex) {
            if color[neighbor] == 1 {
                cycleStart = neighbor
                cycleEnd = vertex
                foundCycle = true
                return true
            }
            if color[neighbor] == 0 {
                parent[neighbor] = vertex
                if dfs(neighbor) {
                    return true
                }
            }
        }

        color[vertex] = 2
        return false
    }

    for v := 0; v < graph.Vertices(); v++ {
        if color[v] == 0 && dfs(v) {
            break
        }
    }

    if !foundCycle {
        return nil
    }

    // Reconstruct cycle
    cycle := []int{cycleStart}
    for v := cycleEnd; v != cycleStart; v = parent[v] {
        cycle = append(cycle, v)
    }
    cycle = append(cycle, cycleStart)

    // Reverse
    for i, j := 0, len(cycle)-1; i < j; i, j = i+1, j-1 {
        cycle[i], cycle[j] = cycle[j], cycle[i]
    }

    return cycle
}
```

On `1->2->3->1`, `FindCycle` returns `[1 2 3 1]`, and on a self-loop `1->1` it returns `[1 1]`. Both are correct: the cycle is reported closed, repeating the entry vertex at both ends, which is what a build tool wants for an error message like "A depends on B depends on A".

### Junior → FAANG: The Critical Difference Between Undirected and Directed Cycle Detection

This distinction is tested frequently and the wrong approach produces plausible-looking but incorrect results.

For undirected graphs: a visited neighbor that is not the parent indicates a cycle. You track `parent` (the vertex you came from) to avoid treating the edge you just traversed as a back edge.

For directed graphs: a visited neighbor that is black (fully processed) does NOT indicate a cycle. Only a gray neighbor (currently on the recursion stack) indicates a cycle. This is because in a directed graph, you might visit vertex B from vertex A, finish B's subtree, mark B black, then visit B again from a different path. That is not a cycle. it is just a cross edge.

Common mistake: using a single `visited map[int]bool` for directed cycle detection. It produces false positives. Take `1->2, 3->2`, a graph with no cycle at all. DFS from 1 visits 1 then 2 and finishes. DFS from 3 sees that 2 is already visited and, with only a boolean to consult, reports a cycle. Run it and it genuinely returns `true` where three-color returns `false`. Always use white/gray/black, or the equivalent `visited` plus `inStack` pair, for directed graphs.

Do not carry the undirected trick across either. The `parent` check is meaningless in a directed graph: in `1->2, 2->1` the edge back to the parent *is* a real cycle, whereas in an undirected graph it is the same edge traversed twice. The two algorithms look similar and are answering different questions.

Interview drill: draw `1->2->3->1` (cycle) and `1->2, 3->2` (no cycle). Trace three-color and single-visited on both. Watching the boolean version fire on the second graph is what makes the distinction stick.

### Senior @ FAANG: Cycle Detection in Production Systems

Cycle detection in production systems is primarily a DAG validation problem: before running any topological-sort-based algorithm (build system, dependency resolver, workflow orchestrator), you must verify that the input is actually a DAG.

The most important production cycle detection scenario is circular dependency detection in build systems. Bazel, Pants, and Gradle all run cycle detection on the dependency graph before attempting to build anything. A circular dependency produces a clear error message ("target A depends on B depends on A") rather than an infinite build loop. The three-colour DFS is the standard implementation, but production build systems add path reconstruction (the `FindCycle` function above) so the error message includes the full cycle, not just a boolean.

At staff level, you also encounter cycle detection in distributed systems: detecting circular waits in distributed lock managers (which cause distributed deadlocks), detecting circular dependencies in service meshes (which cause request loops), and detecting feedback loops in data pipeline dependency graphs (which cause infinite recomputation). Each of these is structurally a directed graph cycle detection problem, but the node and edge semantics differ enough that you must model them correctly before applying the algorithm. That modeling step is the engineering judgment being assessed at L6.
