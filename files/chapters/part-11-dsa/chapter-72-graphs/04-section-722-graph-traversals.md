## 72.2 Graph Traversals

Graph traversal means visiting every vertex in a systematic order. The two fundamental traversal strategies are BFS (breadth-first) and DFS (depth-first), and nearly every graph algorithm is built on top of one of them. BFS explores outward level by level like ripples in water, while DFS dives deep into one path before backtracking. Choosing the right traversal strategy for your problem is one of the most important decisions in graph programming.

### Breadth-First Search (BFS)

BFS explores a graph level by level, visiting all neighbors of the current vertex before moving deeper. It uses a queue (FIFO) to track which vertex to visit next, and a visited map to avoid processing the same vertex twice. BFS is the go-to algorithm for finding the shortest path in an unweighted graph, because it always reaches a vertex via the fewest edges first.

```go
// BFS traverses graph level by level
// Time: O(V + E), Space: O(V)
func BFS(graph *AdjacencyList, start int) []int {
    visited := make(map[int]bool)
    result := []int{}
    queue := []int{start}
    visited[start] = true

    for len(queue) > 0 {
        vertex := queue[0]
        queue = queue[1:]
        result = append(result, vertex)

        for _, neighbor := range graph.Neighbors(vertex) {
            if !visited[neighbor] {
                visited[neighbor] = true
                queue = append(queue, neighbor)
            }
        }
    }

    return result
}

// BFSDistance finds shortest distance from source to all vertices
// (unweighted graph)
func BFSDistance(graph *AdjacencyList, source int) map[int]int {
    dist := make(map[int]int)
    dist[source] = 0
    queue := []int{source}

    for len(queue) > 0 {
        vertex := queue[0]
        queue = queue[1:]

        for _, neighbor := range graph.Neighbors(vertex) {
            if _, found := dist[neighbor]; !found {
                dist[neighbor] = dist[vertex] + 1
                queue = append(queue, neighbor)
            }
        }
    }

    return dist
}

// ShortestPath returns the shortest path between two vertices
func ShortestPath(graph *AdjacencyList, start, end int) []int {
    parent := make(map[int]int)
    visited := make(map[int]bool)
    queue := []int{start}
    visited[start] = true
    parent[start] = -1

    for len(queue) > 0 {
        vertex := queue[0]
        queue = queue[1:]

        if vertex == end {
            break
        }

        for _, neighbor := range graph.Neighbors(vertex) {
            if !visited[neighbor] {
                visited[neighbor] = true
                parent[neighbor] = vertex
                queue = append(queue, neighbor)
            }
        }
    }

    if !visited[end] {
        return nil // No path exists
    }

    // Reconstruct path
    path := []int{}
    for v := end; v != -1; v = parent[v] {
        path = append(path, v)
    }

    // Reverse path
    for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
        path[i], path[j] = path[j], path[i]
    }

    return path
}
```

### Depth-First Search (DFS)

DFS explores a graph by going as deep as possible along each branch before backtracking. It can be implemented recursively (using the call stack) or iteratively (using an explicit stack). DFS is the foundation for many graph algorithms including cycle detection, topological sorting, and finding connected components. Unlike BFS, DFS does not guarantee the shortest path, but it uses less memory on wide graphs.

```go
// DFS traverses graph by going as deep as possible
// Time: O(V + E), Space: O(V)
func DFS(graph *AdjacencyList, start int) []int {
    visited := make(map[int]bool)
    result := []int{}
    dfsHelper(graph, start, visited, &result)
    return result
}

func dfsHelper(graph *AdjacencyList, vertex int, visited map[int]bool, result *[]int) {
    visited[vertex] = true
    *result = append(*result, vertex)

    for _, neighbor := range graph.Neighbors(vertex) {
        if !visited[neighbor] {
            dfsHelper(graph, neighbor, visited, result)
        }
    }
}

// DFSIterative uses explicit stack
func DFSIterative(graph *AdjacencyList, start int) []int {
    visited := make(map[int]bool)
    result := []int{}
    stack := []int{start}

    for len(stack) > 0 {
        vertex := stack[len(stack)-1]
        stack = stack[:len(stack)-1]

        if visited[vertex] {
            continue
        }
        visited[vertex] = true
        result = append(result, vertex)

        // Add neighbors in reverse order for consistent ordering
        neighbors := graph.Neighbors(vertex)
        for i := len(neighbors) - 1; i >= 0; i-- {
            if !visited[neighbors[i]] {
                stack = append(stack, neighbors[i])
            }
        }
    }

    return result
}

// DFSAllVertices visits all vertices even if disconnected
func DFSAllVertices(graph *AdjacencyList) []int {
    visited := make(map[int]bool)
    result := []int{}

    for v := 0; v < graph.Vertices(); v++ {
        if !visited[v] {
            dfsHelper(graph, v, visited, &result)
        }
    }

    return result
}
```

Notice that `DFSIterative` marks visited on **pop**, while `BFS` marks on **enqueue**. That is not an inconsistency, it is the point. BFS must claim a vertex the moment it is discovered, because the first discovery is already the shortest-distance discovery and any later one is redundant. Iterative DFS deliberately allows a vertex to sit on the stack more than once, because which copy gets popped first is what produces the correct depth-first order, and the `if visited[vertex] { continue }` guard discards the stale copies. The stack can therefore hold up to O(E) entries, which is the price of matching recursive DFS's ordering exactly.

### Junior → FAANG: BFS vs DFS Decision Rule

The rule for choosing between BFS and DFS is simpler than most candidates think.

Use BFS when: the problem asks for shortest path in an unweighted graph, the minimum number of steps, or level-by-level processing. BFS visits vertices in non-decreasing distance order from the source, which is exactly what "shortest" means in an unweighted graph.

Use DFS when: the problem asks for existence of a path, for cycle detection, for connected components, or for topological ordering. DFS is also the default for tree-based problems where you need to visit the entire subtree before returning.

A critical implementation habit: in BFS, mark vertices visited when you **enqueue** them, never when you dequeue them. Marking on dequeue lets the same vertex be enqueued once per incoming edge before any copy is popped, so the queue fills with duplicates.

This is worth quantifying, because "it still gives the right answer" is exactly why the bug survives review. Both versions produce identical output, so tests pass. On a 1000-vertex graph where each vertex has roughly 20 neighbors, marking on enqueue peaks at 999 queue entries while marking on dequeue peaks at 18,792, about 19x the memory for identical results. The queue grows with E rather than V, and on a dense graph or a large grid that is the difference between passing and a memory limit or TLE. Correct output is not evidence of a correct implementation.

Both `BFS` and `ShortestPath` above mark before enqueuing, which is why they are right.

As for recursion: `DFSIterative` matters when the *longest path* could be in the millions, not merely when the vertex count is large. Go grows goroutine stacks dynamically from 2 KB up to 1 GB, so a few thousand frames is a non-issue and recursive DFS is fine for typical interview inputs. Reach for the explicit stack when depth is unbounded or plausibly enormous, since blowing the limit is a fatal runtime error that `recover` cannot catch.

### Senior @ FAANG: Traversal in Concurrent and Distributed Systems

At production scale, BFS and DFS are not just sequential algorithms, they are coordination patterns for distributed graph processing.

Parallel BFS exploits the one place BFS genuinely parallelizes: within a level. Each level is a "frontier", every vertex in it can be expanded concurrently, and the results merge into the next frontier. Note what does *not* parallelize: the levels themselves are strictly sequential, so you synchronize at every level boundary and your speedup is capped by the number of levels. This is why parallel BFS works well on shallow, wide graphs (social networks, diameter around 6) and poorly on deep, narrow ones. DFS resists parallelization more fundamentally, since its ordering is inherently sequential.

The engineering challenges are concrete. For `visited`, do not reach for `sync.Map`: it is tuned for read-mostly workloads with stable keys, and a BFS frontier writes each key exactly once, which is close to its worst case. Use an atomic bitmap instead, a `[]uint64` with `atomic.CompareAndSwap` to claim a vertex, which is both the cheapest test-and-set and a natural dedup: whichever goroutine wins the CAS owns the vertex and the losers drop it. A sharded lock is the fallback when you need more than a bit per vertex. Beyond that, expect load imbalance from skewed degrees (a celebrity vertex with millions of followers is one work item), which is what work-stealing addresses, and memory pressure when a frontier explodes, which argues for processing it in bounded chunks.

Distributed BFS (used in Google's Pregel, Apache Giraph) partitions the graph across machines. Each machine owns a subset of vertices. BFS rounds are synchronous: in each round, each machine processes its portion of the current frontier and sends messages to machines owning the next-frontier vertices. The per-round network communication is the bottleneck. Optimizations include combining messages (if multiple vertices send to the same destination, batch them) and local aggregation (if a machine's vertex has already been visited, do not forward the message).

A staff engineer designing a distributed graph traversal system writes the correctness invariant first ("every vertex is visited exactly once"), then the fault-tolerance model ("if a machine fails, the round restarts for its vertices"), then the performance model ("target less than 10ms per round for graphs with 100M edges per partition"). The traversal algorithm is the starting point, not the deliverable.
