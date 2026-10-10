## 72.7 Shortest Path Algorithms

Finding the shortest path between vertices is one of the most practical graph problems, powering everything from GPS navigation to network routing. Different algorithms handle different constraints: Dijkstra's works for non-negative weights, Bellman-Ford handles negative weights, and Floyd-Warshall computes all-pairs shortest paths at once. Choosing the right algorithm depends on whether your graph has negative edges, whether you need single-source or all-pairs distances, and how large the graph is.

### Dijkstra's Algorithm

Dijkstra's algorithm finds the shortest path from a single source vertex to all other vertices in a graph with **non-negative edge weights**. It works by greedily selecting the unvisited vertex with the smallest known distance, then relaxing all its outgoing edges. A min-heap makes this selection efficient, giving O((V + E) log V). If any edge can be negative, the algorithm's correctness argument collapses and you should use Bellman-Ford. The next subsection makes that claim precise, because the usual one-line version of it is not quite right.

```go
import "container/heap"

// Dijkstra finds shortest paths from source. Requires non-negative weights.
// Time: O((V + E) log V)
// Space: O(V) for dist, but O(E) for the heap: this version pushes a new
// entry per successful relaxation instead of decreasing a key in place,
// so the heap can hold one entry per edge.
func Dijkstra(graph *WeightedGraph, source int) []int {
    n := graph.vertices
    dist := make([]int, n)
    for i := range dist {
        dist[i] = INF
    }
    dist[source] = 0

    h := &DistHeap{{node: source, dist: 0}}
    heap.Init(h)

    for h.Len() > 0 {
        curr := heap.Pop(h).(DistItem)

        if curr.dist > dist[curr.node] {
            continue
        }

        for _, edge := range graph.Neighbors(curr.node) {
            newDist := dist[curr.node] + edge.Weight
            if newDist < dist[edge.To] {
                dist[edge.To] = newDist
                heap.Push(h, DistItem{node: edge.To, dist: newDist})
            }
        }
    }

    return dist
}

type DistItem struct {
    node int
    dist int
}

type DistHeap []DistItem

func (h DistHeap) Len() int           { return len(h) }
func (h DistHeap) Less(i, j int) bool { return h[i].dist < h[j].dist }
func (h DistHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *DistHeap) Push(x any) { *h = append(*h, x.(DistItem)) }
func (h *DistHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

#### Why Dijkstra Needs Non-Negative Weights

The correctness argument is one sentence: when a vertex is popped with the smallest tentative distance, no cheaper route to it can exist, because any other route must leave through some vertex still in the heap whose distance is already at least as large, and adding non-negative edges can only make it larger. Every "at least as large" in that sentence is where a negative edge attacks.

Here is a concrete counterexample. Take `0->1 (1)`, `1->3 (1)`, `0->2 (5)`, `2->3 (-10)`. The true shortest distance to 3 is **-5**, via `0->2->3`. A textbook Dijkstra that marks vertices settled and refuses to reprocess them pops 3 at distance 2 (via `0->1->3`), declares it final, and later reaches `2->3` only to skip vertex 3 because it is already settled. It returns `[0 1 5 2]`, and `dist[3] = 2` is wrong.

Now the part that is usually stated too simply. The implementation above has **no settled set**. It re-pushes a vertex on every improving relaxation, so it happily corrects itself and returns `[0 1 5 -5]`, which is right. Run it against Bellman-Ford on random negative-weight DAGs and it matches every time. So "Dijkstra gives wrong answers with negative edges" is false *for this code*, and if you assert it flatly an interviewer may hand you exactly this example.

The accurate statement is this. Once weights can be negative, the lazy version stops being Dijkstra in any meaningful sense and becomes a priority-queue variant of Bellman-Ford/SPFA. It loses the property that made Dijkstra worth using: that each vertex is finalized once. Vertices can now be re-expanded repeatedly, and on adversarial graphs the number of re-expansions is exponential, so the O((V+E) log V) bound is simply gone. Worse, on a **negative cycle** it never terminates at all: each trip around the cycle lowers some distance, every lowering re-pushes, and the loop runs forever. Bellman-Ford's fixed V-1 rounds are precisely what makes detecting that cycle possible instead of hanging.

So the practical rule survives, for better reasons than usually given: **negative weights mean Bellman-Ford**, not because Dijkstra necessarily returns a wrong number, but because it forfeits its complexity guarantee and cannot detect the one case that matters.

### Bellman-Ford Algorithm

Bellman-Ford computes shortest paths from a single source and, unlike Dijkstra's, correctly handles negative edge weights. It works by relaxing every edge V-1 times, where V is the number of vertices. After V-1 iterations, if any edge can still be relaxed, the graph contains a negative-weight cycle. This makes Bellman-Ford the standard choice when negative weights are possible, though its O(V * E) time complexity is slower than Dijkstra's for non-negative graphs.

```go
// BellmanFord handles negative weights, detects negative cycles
// Time: O(V * E), Space: O(V)
func BellmanFord(edges []WeightedEdge, n, source int) ([]int, bool) {
    dist := make([]int, n)
    for i := range dist {
        dist[i] = INF
    }
    dist[source] = 0

    // Relax all edges V-1 times
    for i := 0; i < n-1; i++ {
        updated := false
        for _, edge := range edges {
            if dist[edge.From] != INF && dist[edge.From]+edge.Weight < dist[edge.To] {
                dist[edge.To] = dist[edge.From] + edge.Weight
                updated = true
            }
        }
        if !updated {
            break // Early termination
        }
    }

    // Check for negative cycle
    for _, edge := range edges {
        if dist[edge.From] != INF && dist[edge.From]+edge.Weight < dist[edge.To] {
            return nil, true // Negative cycle exists
        }
    }

    return dist, false
}
```

### Floyd-Warshall Algorithm


Floyd-Warshall computes the shortest path between every pair of vertices in a single run, making it ideal when you need all-pairs shortest paths. It uses dynamic programming over an adjacency matrix, considering each vertex as a potential intermediate node. The algorithm runs in O(V^3) time and O(V^2) space, which is acceptable for small to medium-sized graphs but too slow for large ones. It also handles negative weights (but not negative cycles).

```go
// FloydWarshall finds all-pairs shortest paths
// Time: O(V^3), Space: O(V^2)
func FloydWarshall(matrix *AdjacencyMatrix) [][]int {
    n := matrix.vertices
    dist := make([][]int, n)
    for i := range dist {
        dist[i] = make([]int, n)
        copy(dist[i], matrix.matrix[i])
    }

    for k := 0; k < n; k++ {
        for i := 0; i < n; i++ {
            for j := 0; j < n; j++ {
                if dist[i][k] != INF && dist[k][j] != INF {
                    if dist[i][k]+dist[k][j] < dist[i][j] {
                        dist[i][j] = dist[i][k] + dist[k][j]
                    }
                }
            }
        }
    }

    return dist
}
```

### Junior → FAANG: Shortest Path Algorithm Decision Tree

The decision tree for choosing a shortest path algorithm:

Is the graph unweighted? Use BFS. Time O(V+E), no heap needed.

Is the graph weighted with non-negative weights? Use Dijkstra's. Time O((V+E) log V).

Does the graph have negative edge weights? Use Bellman-Ford. Time O(V*E). Check for negative cycles explicitly (if any edge can still be relaxed after V-1 iterations, a negative cycle exists).

Do you need all-pairs shortest paths? Use Floyd-Warshall. Time O(V^3). Only practical for small graphs (V < 1000).

In interviews, always ask "are there negative edge weights?" before choosing your algorithm. It is a ten-second question that changes the answer.

One Bellman-Ford variant is worth knowing because it trips almost everyone: **Cheapest Flights Within K Stops** (LeetCode 787), where you want the cheapest path using at most K+1 edges. The natural instinct is to run Bellman-Ford for K+1 rounds and stop. That is wrong, and subtly so:

```go
// Round i must relax against the distances as they stood at the END of
// round i-1. Reading and writing the same slice lets an edge relaxed
// earlier in THIS round feed another relaxation later in the same round,
// chaining two hops into one round and undercounting the stop budget.
for i := 0; i <= k; i++ {
    next := make([]int, n)
    copy(next, dist)          // snapshot of the previous round
    for _, e := range flights {
        if dist[e.From] != INF && dist[e.From]+e.Weight < next[e.To] {
            next[e.To] = dist[e.From] + e.Weight // read dist, write next
        }
    }
    dist = next
}
```

The snapshot enforces "exactly one more edge per round". Plain Bellman-Ford does not need it, because it only cares about the final converged distances and chaining within a round merely reaches the answer sooner. Here the round count *is* the constraint, so chaining silently buys extra stops.

Concretely, with flights `0->1 (100)`, `1->2 (100)`, `0->2 (500)` and a budget of `k=0` (a direct flight only), the correct answer is **500**. Drop the snapshot and a single round relaxes `0->1` to 100 and then immediately uses that fresh value to relax `1->2` to 200, returning **200**: a two-hop itinerary sold on a zero-stop budget. The answer is cheaper, plausible, and wrong.

### Senior @ FAANG: Shortest Path in Large-Scale and Dynamic Networks

Production shortest-path systems at FAANG companies operate at scales where the textbook algorithms must be augmented or replaced.

For static graphs with millions of vertices (road networks, enterprise network topology), bidirectional Dijkstra or A* with hierarchical preprocessing reduces query time by orders of magnitude. Contraction hierarchies preprocess the graph by ordering vertices by "importance" and contracting them one at a time, adding shortcut edges to preserve distances whenever a contracted vertex sat on a unique shortest path. At query time the search only ever moves *upward* in the importance order, from both ends, which prunes almost the entire graph. It is the technique behind several open-source routers, OSRM among them. Commercial mapping products do not publish their internals, so cite contraction hierarchies as the known published approach rather than asserting what a specific company runs.

For dynamic networks where edge weights change continuously (traffic-aware routing, network congestion control), static shortest path algorithms must be replaced by time-dependent shortest path algorithms. Dijkstra's can be extended to time-dependent edge weights by making the weight a function `w(u, v, t)` where t is the time of traversal. The correctness requires that edge weight functions are FIFO (arriving later cannot lead to a shorter travel time), which holds for traffic if congestion is modeled as a function of time-of-day but not as a function of instantaneous traffic.

For graphs with negative edge weights in financial applications (arbitrage detection in currency exchange graphs), Bellman-Ford's negative cycle detection is exactly what you need: a negative cycle represents an arbitrage opportunity. The production implementation adds: multi-currency exchange rate fetching (edges), real-time cycle detection (run Bellman-Ford whenever rates update), and latency budget tracking (the arbitrage must be executed before it disappears). A staff engineer owning this system designs the end-to-end pipeline including the data ingestion, algorithm scheduling, and execution path, not just the cycle detection subroutine.
