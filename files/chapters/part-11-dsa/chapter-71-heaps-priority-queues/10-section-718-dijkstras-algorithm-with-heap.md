## 71.8 Dijkstra's Algorithm with Heap

Dijkstra's algorithm finds the shortest path from a source vertex to all others in a weighted graph with non-negative edge weights. A min-heap ordered by tentative distance implements the priority queue, and stale entries (where `curr.dist > dist[curr.node]`) are skipped rather than actively removed, making implementation straightforward at the cost of slightly higher memory usage.

```go
import "container/heap"

// Dijkstra finds shortest paths from source to all vertices.
// Requires non-negative edge weights.
// Time: O((V + E) log V), Space: O(V + E) for the lazy heap
func Dijkstra(graph map[int][]Edge, source int, n int) []int {
    const INF = 1 << 30
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
            continue // Already processed with shorter distance
        }

        for _, edge := range graph[curr.node] {
            newDist := dist[curr.node] + edge.weight
            if newDist < dist[edge.to] {
                dist[edge.to] = newDist
                heap.Push(h, DistItem{node: edge.to, dist: newDist})
            }
        }
    }

    return dist
}

type Edge struct {
    to     int
    weight int
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

// NetworkDelayTime finds max time for signal to reach all nodes
// LeetCode 743: Network Delay Time
func NetworkDelayTime(times [][]int, n int, k int) int {
    // Build graph
    graph := make(map[int][]Edge)
    for _, t := range times {
        u, v, w := t[0], t[1], t[2]
        graph[u] = append(graph[u], Edge{to: v, weight: w})
    }

    // Dijkstra
    dist := Dijkstra(graph, k, n+1) // 1-indexed

    maxDist := 0
    for i := 1; i <= n; i++ {
        if dist[i] == 1<<30 {
            return -1
        }
        if dist[i] > maxDist {
            maxDist = dist[i]
        }
    }

    return maxDist
}
```

Note the space bound. Because this version pushes a new entry on every successful relaxation instead of decreasing a key in place, the heap can hold up to O(E) entries rather than O(V). The `dist` array is O(V), the heap is not, and quoting O(V) space for a lazy-deletion Dijkstra is a claim an interviewer may well check.

### Junior → FAANG: Dijkstra's with a Heap vs Without

Many textbook presentations of Dijkstra's use an array-based priority queue with O(V^2) total time, which is acceptable for dense graphs but slow for sparse ones. The heap-based version (O((V+E) log V)) is the standard for interview solutions because most graph problems have sparse adjacency lists.

The "lazy deletion" pattern (pushing stale entries and skipping them with `if curr.dist > dist[curr.node]`) is the pragmatic choice for interview code. The alternative (an indexed priority queue with heap.Fix) is faster in theory but requires more code and is harder to implement correctly under time pressure.

Two common implementation mistakes. The first is not initializing `dist` to infinity for all vertices, which breaks relaxation because an unvisited vertex looks like it is already at distance 0.

The second is dropping the `if curr.dist > dist[curr.node]` skip, but be precise about what that costs, because this is frequently overstated. Omitting the stale check does **not** make Dijkstra incorrect on non-negative weights. The `if newDist < dist[edge.to]` guard is what protects correctness, and a stale pop can only re-relax edges using a `dist` value that is already final, so it changes nothing. What you lose is work: the algorithm rescans the adjacency list of every stale entry. Say "it is a performance bug, not a correctness bug" and you will be right where many candidates confidently are not.

What genuinely does break correctness is a negative edge weight. Dijkstra's whole argument rests on the claim that once a vertex is popped with the smallest tentative distance, no cheaper route to it can exist, because every remaining path must pass through some unpopped vertex whose distance is already at least as large, and adding non-negative edges can only make it larger. A single negative edge invalidates that step, and the algorithm can finalize a vertex too early. For negative weights you need Bellman-Ford, covered in Chapter 72.

For NetworkDelayTime specifically, note the 1-indexed vertex IDs: allocate `dist` of size `n+1` and iterate vertices 1 through n. Off-by-one errors here cause wrong answers on test cases where vertex 0 is not used.

### Senior @ FAANG: Dijkstra at Scale, Bidirectional Search, and A*

Production shortest-path systems extend the basic Dijkstra's in two important ways.

Bidirectional Dijkstra runs two simultaneous searches, one forward from the source and one backward from the destination over reversed edges. The payoff is geometric: instead of one explored ball of radius r, you explore two of radius r/2. With explored volume growing roughly as r^2 in a planar-ish road network, that is about half the work, and the saving is far more dramatic in graphs that expand faster than quadratically.

The trap is the stopping condition, and it is the single most common bug in bidirectional search. **The first time the two frontiers touch does not give you the shortest path.** The node where they meet is merely *a* connection, not necessarily the one on the optimal route: a cheaper path can still run through a node that one side has settled and the other has only seen as a tentative distance. The correct rule is to keep a running best candidate `mu`, updating it whenever a relaxation touches a node the other side has reached (`mu = min(mu, dist_f[v] + dist_b[v])`), and to stop only when the sum of the two frontiers' minimum keys is at least `mu`. At that point no undiscovered path can beat `mu`, because any such path would have to cost at least that sum. Write "stop when the frontiers meet" in an interview and a strong interviewer will hand you the counterexample.

Real routing engines go further and precompute. Contraction hierarchies, the technique behind several open-source routers such as OSRM, shortcut the graph offline so that queries only ever traverse "upward" in an importance ordering, which turns continent-scale routing into a query fast enough to feel instant. Commercial mapping products do not publish their internals, so cite contraction hierarchies and its research lineage as the known technique rather than asserting what any specific company runs.

A* adds a heuristic h(v) estimating the remaining distance from v to the destination, ordering the heap by `dist[v] + h(v)` instead of `dist[v]`. Two conditions matter and are often conflated. **Admissibility** (h never overestimates the true remaining cost) is what makes A* return an optimal path. **Consistency**, also called the triangle inequality, `h(u) <= w(u,v) + h(v)`, is the stronger property that guarantees each node is settled only once, so A* behaves exactly like Dijkstra on reweighted edges and never needs to reopen a closed node. Straight-line (haversine) distance over a road network is both, since no road is shorter than the great-circle path, which is why it is the standard example. An admissible-but-inconsistent heuristic still yields the right answer but can force nodes to be reopened, and if your implementation refuses to reopen closed nodes, it will silently return a suboptimal path.

At staff level, you own the architectural decision of which shortest-path algorithm goes into a routing service. The decision tree: static graph with positive weights and need sub-millisecond queries? Use contraction hierarchies with Dijkstra. Dynamic graph with edge weight updates (traffic)? Use time-dependent Dijkstra with temporal edge weights. Graph with potential negative weights (financial transactions, cost models)? Use Bellman-Ford with negative-cycle detection. Documenting these choices and their preconditions in the service ADR prevents future engineers from applying the wrong algorithm when graph properties change.
