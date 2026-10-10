## 72.8 Minimum Spanning Tree

A minimum spanning tree (MST) is a subset of edges that connects all vertices in an undirected weighted graph with the minimum total edge weight, without forming any cycles. MSTs have practical applications in network design (minimizing cable length), clustering (removing the heaviest edges from an MST produces clusters), and approximation algorithms. The two classic algorithms for finding MSTs are Kruskal's (edge-based, using Union-Find) and Prim's (vertex-based, using a priority queue).

### Kruskal's Algorithm

Kruskal's algorithm builds a minimum spanning tree (MST) by sorting all edges by weight and adding them one by one, skipping any edge that would form a cycle. It uses Union-Find to efficiently check whether two vertices are already connected. This greedy approach guarantees the MST because it always picks the cheapest available edge that does not create a cycle. Kruskal's is particularly well-suited for sparse graphs where the number of edges is much smaller than V^2.

```go
import "sort"

// Kruskal finds MST using Union-Find
// Time: O(E log E), Space: O(V)
func Kruskal(edges []WeightedEdge, n int) ([]WeightedEdge, int) {
    // Sort edges by weight
    sort.Slice(edges, func(i, j int) bool {
        return edges[i].Weight < edges[j].Weight
    })

    uf := NewUnionFind(n)
    mst := []WeightedEdge{}
    totalWeight := 0

    for _, edge := range edges {
        if uf.Union(edge.From, edge.To) {
            mst = append(mst, edge)
            totalWeight += edge.Weight
            if len(mst) == n-1 {
                break
            }
        }
    }

    return mst, totalWeight
}

// MinCostConnectPoints finds minimum cost to connect all points
// LeetCode 1584: Min Cost to Connect All Points
func MinCostConnectPoints(points [][]int) int {
    n := len(points)
    edges := []WeightedEdge{}

    // Create all edges
    for i := 0; i < n; i++ {
        for j := i + 1; j < n; j++ {
            dist := abs(points[i][0]-points[j][0]) + abs(points[i][1]-points[j][1])
            edges = append(edges, WeightedEdge{From: i, To: j, Weight: dist})
        }
    }

    _, cost := Kruskal(edges, n)
    return cost
}

func abs(x int) int {
    if x < 0 {
        return -x
    }
    return x
}
```

### Prim's Algorithm

Prim's algorithm builds a minimum spanning tree by starting from any vertex and repeatedly adding the cheapest edge that connects a visited vertex to an unvisited one. It uses a min-heap (priority queue) to efficiently select the next lightest edge. Unlike Kruskal's, Prim's grows the MST from a single connected component, which makes it more efficient on dense graphs where the adjacency list representation would have many edges per vertex.

```go
// Prim finds MST using priority queue
// Time: O(E log V), Space: O(V)
func Prim(graph *WeightedGraph, n int) int {
    visited := make([]bool, n)
    totalWeight := 0
    edgesAdded := 0

    h := &EdgeHeap{}
    heap.Init(h)

    // Start from vertex 0
    visited[0] = true
    for _, edge := range graph.Neighbors(0) {
        heap.Push(h, edge)
    }

    for h.Len() > 0 && edgesAdded < n-1 {
        edge := heap.Pop(h).(Edge)

        if visited[edge.To] {
            continue
        }

        visited[edge.To] = true
        totalWeight += edge.Weight
        edgesAdded++

        for _, nextEdge := range graph.Neighbors(edge.To) {
            if !visited[nextEdge.To] {
                heap.Push(h, nextEdge)
            }
        }
    }

    return totalWeight
}

type EdgeHeap []Edge

func (h EdgeHeap) Len() int           { return len(h) }
func (h EdgeHeap) Less(i, j int) bool { return h[i].Weight < h[j].Weight }
func (h EdgeHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *EdgeHeap) Push(x any) { *h = append(*h, x.(Edge)) }
func (h *EdgeHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

Two caveats on the code above, both of which are the kind of thing a reviewer should catch.

**Neither function reports a disconnected graph.** An MST only exists if the graph is connected. Given 4 vertices and the single edge `0-1`, `Prim` returns 3 and `Kruskal` returns a 1-edge "MST", both silently, because both simply run out of edges. A spanning tree on n vertices has exactly n-1 edges, so the check is `len(mst) == n-1` for Kruskal and `edgesAdded == n-1` for Prim. Return that as a second value rather than handing back a number that looks like an answer. (What you actually get on a disconnected graph is a minimum spanning *forest*, which is often the useful thing, but say so deliberately.)

**`Kruskal` reorders the caller's slice.** `sort.Slice` sorts in place, so the `edges` argument comes back permuted. Clone it first if the caller still needs the original order.

### Junior → FAANG: Kruskal's vs Prim's Selection

Both algorithms find the same MST (assuming unique edge weights) but with different trade-offs.

Kruskal's: sort all edges by weight, then greedily add edges that do not form a cycle. Best for sparse graphs (E is close to V). The bottleneck is sorting edges: O(E log E). Union-Find makes the cycle check O(α(n)) per edge.

Prim's: start from any vertex and greedily add the cheapest edge to an unvisited vertex. The bottleneck is the priority queue: O(E log V) with a binary heap.

Be careful with "Prim's is better for dense graphs", which is repeated more often than it is understood. The heap version above is O(E log V), and on a dense graph E is about V^2, so that is O(V^2 log V), which is *worse* than Kruskal's is usually credited with. What actually wins on dense graphs is Prim's **without** a heap: scan an array of candidate distances to find the minimum each round, giving O(V^2) with no log factor at all. So the honest claim is that Prim's has a dense-graph implementation that beats everything else, not that the heap-based Prim's shown here is the dense-graph answer.

Interview rule of thumb: use Kruskal's if the problem gives you an edge list. Use Prim's if you are given an adjacency list or adjacency matrix. In practice, most interview problems give you an edge list (Kruskal's) or a grid of distances (Prim's or Kruskal's after generating all edges).

The `MinCostConnectPoints` function generates all O(n^2) edges and runs Kruskal's. This is correct and simple, but note that for n=1000, you generate 500,000 edges. If the problem has n=10000, generating all edges is already O(n^2) which may exceed the time limit. The faster alternative for dense point sets is Prim's algorithm that computes edge weights on-the-fly without materialising them.

### Senior @ FAANG: MST in Network Design and Clustering

Minimum spanning trees are not just academic constructs. they are the foundation for several practical algorithms in production systems.

Network infrastructure design uses MST to minimize total cable length (or latency) when connecting data centres, offices, or base stations. The input is a complete graph with edge weights equal to distance or latency. Kruskal's produces the MST in O(E log E), which for n=1000 locations is 500,000 edges processed in milliseconds. Real network design adds constraints (capacity limits, redundancy requirements) that transform the pure MST problem into a constrained optimization, solved by Lagrangian relaxation or integer programming on top of the MST approximation.

Single-linkage clustering uses the MST directly: remove the k-1 heaviest edges from the MST and the k remaining pieces are exactly the k single-linkage clusters. This is equivalent to **single**-linkage hierarchical clustering, and specifically not to complete-linkage, which is a different criterion (cluster distance measured by the *farthest* pair rather than the nearest) and has no such MST correspondence. The equivalence holds because both single-linkage merging and Kruskal's join the two components separated by the smallest inter-component edge, which is the same greedy step viewed from two directions. Kruskal's therefore hands you the entire dendrogram in O(E log E), with the merge heights being the MST edge weights. Used in bioinformatics (gene expression clustering), anomaly detection (heavy MST edges isolate outliers), and geographic segmentation. Its well-known weakness is chaining: a thin bridge of intermediate points will link two otherwise-distinct clusters, which is the direct consequence of caring only about the nearest pair.

Distributed MST (for graphs that do not fit on a single machine) uses the Borůvka's algorithm: in each round, every vertex independently selects its lightest outgoing edge, then all selected edges are added and vertices in the same component are merged. This runs in O(log V) rounds, each requiring one pass over all edges, giving O(E log V) total. The round structure maps directly to the Pregel BSP model, making Borůvka's the natural choice for distributed graph processing frameworks.
