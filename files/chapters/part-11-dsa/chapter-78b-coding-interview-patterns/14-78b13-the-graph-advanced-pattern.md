## 78B.13 The Graph Advanced Pattern

Beyond basic BFS and DFS, competitive interviews test weighted-graph problems that require choosing the right shortest-path or spanning-tree algorithm based on constraints. Dijkstra's greedy relaxation via a min-heap handles non-negative weights in O((V+E) log V), while Bellman-Ford's edge-relaxation loop tolerates negative weights and can be bounded to exactly K iterations when a hop-count constraint is imposed. Kruskal's and Prim's algorithms both produce a minimum spanning tree but differ in approach: Kruskal sorts all edges globally and uses Union-Find to skip cycle-forming edges, making it ideal when edges are sparse and pre-sorted. Prim grows the tree one vertex at a time from a seed node, which is preferable on dense graphs.

**When to use each algorithm:**
- Dijkstra: shortest path, all weights ≥ 0, no constraint on hops
- Bellman-Ford / its variants: negative weights or explicit hop-count limits
- Kruskal's MST: sparse graphs, edges can be sorted upfront
- Prim's MST: dense graphs, adjacency-list traversal from a single source

```
┌─────────────────────────────────────────────────────────────────┐
│                  ADVANCED GRAPH PATTERNS                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Dijkstra: Shortest path, non-negative weights                  │
│  Priority queue + relaxation                                    │
│  O((V + E) log V)                                               │
│                                                                 │
│  Bellman-Ford: Shortest path, allows negative weights           │
│  Relax all edges V-1 times                                      │
│  O(V * E)                                                       │
│                                                                 │
│  Kruskal's MST: Sort edges, Union-Find to add non-cycle edges   │
│  O(E log E)                                                     │
│                                                                 │
│  Prim's MST: Grow tree from a node using min-heap               │
│  O((V + E) log V)                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Problem 1: Network Delay Time (LC 743), Dijkstra

**Problem:** There are `n` nodes. Given directed weighted edges `times[i] = [u, v, w]`, and a source node `k`, return the minimum time for all nodes to receive a signal. Return -1 if impossible.

**Approach:** Dijkstra's algorithm from node k. The answer is the maximum shortest distance among all reachable nodes.

```go
import (
    "container/heap"
    "math"
)

type Edge struct {
    to, weight int
}

type Item struct {
    node, dist int
}

type PQ []Item

func (pq PQ) Len() int            { return len(pq) }
func (pq PQ) Less(i, j int) bool  { return pq[i].dist < pq[j].dist }
func (pq PQ) Swap(i, j int)       { pq[i], pq[j] = pq[j], pq[i] }
func (pq *PQ) Push(x any) { *pq = append(*pq, x.(Item)) }
func (pq *PQ) Pop() any {
    old := *pq
    n := len(old)
    val := old[n-1]
    *pq = old[:n-1]
    return val
}

func networkDelayTime(times [][]int, n int, k int) int {
    // Build adjacency list
    adj := make([][]Edge, n+1)
    for _, t := range times {
        u, v, w := t[0], t[1], t[2]
        adj[u] = append(adj[u], Edge{v, w})
    }

    // Dijkstra
    dist := make([]int, n+1)
    for i := range dist {
        dist[i] = math.MaxInt // int-sized, not math.MaxInt64
    }
    dist[k] = 0

    pq := &PQ{{k, 0}}
    heap.Init(pq)

    for pq.Len() > 0 {
        item := heap.Pop(pq).(Item)
        u := item.node
        d := item.dist

        if d > dist[u] {
            continue // stale entry
        }

        for _, e := range adj[u] {
            newDist := d + e.weight
            if newDist < dist[e.to] {
                dist[e.to] = newDist
                heap.Push(pq, Item{e.to, newDist})
            }
        }
    }

    maxDist := 0
    for i := 1; i <= n; i++ {
        if dist[i] == math.MaxInt {
            return -1 // unreachable node
        }
        if dist[i] > maxDist {
            maxDist = dist[i]
        }
    }

    return maxDist
}
```

**Time Complexity:** O((V + E) log V).
**Space Complexity:** O(V + E).

Two details are worth defending out loud. The `if d > dist[u] { continue }` guard is what lets this use a plain heap with no decrease-key operation. Rather than updating an existing heap entry when a shorter path is found, the code pushes a *second* entry for the same node and discards the obsolete one when it surfaces. The heap can therefore hold up to O(E) entries rather than O(V), which is why some texts write the bound as O(E log V). Delete that guard and the algorithm still terminates and still returns correct distances, but it re-expands nodes and does redundant work.

The sentinel is `math.MaxInt`, not `math.MaxInt64`. `dist` is `[]int`, and on a 32-bit platform `math.MaxInt64` does not fit in an `int`, so the assignment is a compile-time error, not a runtime surprise. Reach for the `math.MaxInt`/`math.MinInt` family whenever the variable is a plain `int`. Also note the guard against arithmetic on the sentinel: `d` comes off the heap and is always a real distance, so `d + e.weight` cannot overflow from a sentinel. Code that relaxes straight out of the `dist` array must check for the sentinel first, or `MaxInt + w` wraps to a negative number and every "unreachable" node looks reachable and close.

**Edge cases:**
- Disconnected graph → return -1
- Single node → return 0, since `dist[k] = 0` and it is the only node checked
- Multiple edges between the same pair → handled naturally, the relaxation keeps the smaller

---

### Problem 2: Cheapest Flights Within K Stops (LC 787), Bellman-Ford Variant

**Problem:** Find the cheapest flight from `src` to `dst` with at most `k` stops.

**Approach:** Modified Bellman-Ford: run k+1 iterations (k stops = k+1 edges). Use a copy of the distance array per iteration to avoid using updates from the current iteration.

```go
import "math"

func findCheapestPrice(n int, flights [][]int, src int, dst int, k int) int {
    const INF = math.MaxInt // must be int-sized: dist is []int

    dist := make([]int, n)
    for i := range dist {
        dist[i] = INF
    }
    dist[src] = 0

    // K stops means at most K+1 edges
    for i := 0; i <= k; i++ {
        // Copy to avoid using current iteration's updates
        temp := make([]int, n)
        copy(temp, dist)

        for _, f := range flights {
            u, v, w := f[0], f[1], f[2]
            if dist[u] != INF && dist[u]+w < temp[v] {
                temp[v] = dist[u] + w
            }
        }

        dist = temp
    }

    if dist[dst] == INF {
        return -1
    }
    return dist[dst]
}
```

**Time Complexity:** O(k · E) where E is the number of flights.
**Space Complexity:** O(n).

The `temp` copy is the whole algorithm, not a defensive habit. Relaxing in place would let a path found earlier in *this* round be extended again later in the same round, so a single round could consume several edges and the k-stop limit would not bind. Reading from `dist` (the previous round) and writing to `temp` (this round) makes each round add at most one edge to any path, by construction. This is exactly why the bound is "at most k+1 edges" rather than a hopeful approximation of it.

Note also why Dijkstra is wrong here. Dijkstra finalizes a node at its cheapest distance, but under a hop limit the cheapest way to reach a node may use too many hops, and a more expensive route with fewer hops may be the one that extends to the destination. The hop count is part of the state, so a correct Dijkstra needs `(cost, stops)` pairs and loses its "finalize once" property. The bounded Bellman-Ford is both correct and simpler.

**Edge cases:**
- src == dst → 0, and `dist[src]` starts at 0 so no round can lower it given non-negative prices
- No path within k stops → -1
- k=0 → only direct flights, one relaxation round
- Negative prices are excluded by the constraints. They would not break this bounded version the way they break Dijkstra, since Bellman-Ford tolerates negative edges, but a negative cycle would be meaningless under a fixed hop budget

---

### Problem 3: Min Cost to Connect All Points (LC 1584), Kruskal's MST

**Problem:** Given `n` points in 2D, return the minimum cost to connect all points. Cost between two points is their Manhattan distance.

**Approach:** Generate all edges with Manhattan distance weights, sort them, and apply Kruskal's algorithm with Union-Find.

```go
import "sort"

func minCostConnectPoints(points [][]int) int {
    n := len(points)
    if n <= 1 {
        return 0
    }

    // Generate all edges
    type EdgeInfo struct {
        u, v, cost int
    }
    edges := make([]EdgeInfo, 0, n*(n-1)/2)

    for i := 0; i < n; i++ {
        for j := i + 1; j < n; j++ {
            cost := abs(points[i][0]-points[j][0]) + abs(points[i][1]-points[j][1])
            edges = append(edges, EdgeInfo{i, j, cost})
        }
    }

    // Sort edges by cost
    sort.Slice(edges, func(i, j int) bool {
        return edges[i].cost < edges[j].cost
    })

    // Kruskal's with Union-Find
    uf := NewUnionFind(n)
    totalCost := 0
    edgesUsed := 0

    for _, e := range edges {
        if uf.Union(e.u, e.v) {
            totalCost += e.cost
            edgesUsed++
            if edgesUsed == n-1 {
                break // MST complete
            }
        }
    }

    return totalCost
}

func abs(x int) int {
    if x < 0 {
        return -x
    }
    return x
}
```

**Time Complexity:** O(n² log n). There are O(n²) edges and the sort costs O(n² log n²), which is O(n² log n) because log(n²) = 2 log n.
**Space Complexity:** O(n²) for the edge list.

Worth confronting a tension with the guidance above: this graph is *complete*, and complete graphs are exactly where Prim is supposed to beat Kruskal. Kruskal is used here anyway because it is shorter to write correctly under time pressure, and at LeetCode's n ≤ 1000 the O(n²) edge list is a few hundred thousand entries, which sorts fine. Prim without a heap, scanning for the nearest unvisited point, is O(n²) with no edge list at all and is the better answer at larger n. If an interviewer asks you to scale this to a million points, neither is right and the real answer is to stop materializing all n² edges and exploit the geometry, since a Manhattan MST can be built from a linear number of candidate edges. Knowing why the textbook rule of thumb loses to "it fits and I can get it right" at this size, and where it starts winning again, is the actual signal.

The `edgesUsed == n-1` break is a genuine optimization rather than a formality: an MST on n nodes has exactly n-1 edges, so once that count is reached every remaining edge would be rejected by `Union` anyway.

**Edge cases:**
- Single point → 0, caught by the `n <= 1` guard before any edge is generated
- Two points → the Manhattan distance between them
- All points at the same location → 0, every edge has weight 0
- Duplicate points → fine, zero-weight edges sort first and get unioned immediately

---

### Junior → FAANG: Algorithm Selection for Graph Problems

Junior engineers commonly apply Dijkstra to every weighted graph problem without checking the constraints. The decision tree: if the graph has negative edges, Dijkstra gives wrong answers and Bellman-Ford is required. If the constraint is "at most K stops," Bellman-Ford bounded to K iterations is correct and simpler than Dijkstra with a (cost, stops) state pair. If the problem asks for a minimum spanning tree (connect all nodes with minimum total edge weight), Kruskal or Prim is the answer, not Dijkstra (shortest path is not spanning tree).

For "cheapest flights within K stops" (LC 787), the bounded Bellman-Ford approach processes exactly K+1 edge relaxation rounds and uses a previous-round cost array to prevent using more than K edges in a single path. A common bug is updating the cost array in-place during a round, which allows a "chain" of K+1 updates within a single round and overcounts edges. Always copy the cost array before each round.

Topological sort via DFS uses cycle detection: if DFS enters a node that is currently on the recursion stack (state = "in progress"), a cycle exists and topological sort is impossible. Using three states (unvisited, in-progress, done) is cleaner than a single boolean visited flag and correctly handles graphs with multiple disconnected components.

Entry-level signal: correctly implementing Dijkstra with a Go `container/heap` min-heap rather than a linear scan. The linear scan version is O(V²) and acceptable for dense graphs, but interviewers at FAANG expect the O((V+E) log V) heap version for sparse graphs.

### Senior @ FAANG: Graph Algorithms in Infrastructure and Platform Engineering

Dijkstra's algorithm is embedded in routing protocols. OSPF (Open Shortest Path First), used by enterprise and ISP routers, runs Dijkstra from each router's perspective to build its forwarding table. Understanding Dijkstra's O((V+E) log V) complexity lets you reason about OSPF convergence time when the network topology changes (link failure triggers a full Dijkstra re-run on the affected routers).

Distance-vector routing is Bellman-Ford run in a distributed fashion, with each router relaxing edges using its neighbors' advertised distances instead of a global edge list. RIP is the direct example. BGP is its descendant, a path-vector protocol: rather than advertising a bare distance, each router advertises the full AS-path, and rejects any route already containing its own AS. That change exists because plain distance-vector cannot tell a genuinely better route from its own stale advertisement echoing back, which is the count-to-infinity problem. Carrying the path makes loops locally detectable. The connection also explains why convergence takes time: like Bellman-Ford, information propagates one hop per round, so a change ripples outward rather than appearing globally, and route flap dampening exists to keep that ripple from being triggered constantly.

Minimum spanning trees appear in network design optimization: laying fiber optic cable to connect data centers with minimum total cable length is exactly Kruskal's algorithm on a complete graph of data centers with edge weights as geographic distances. Prim's algorithm is preferable when the graph is dense (the number of edges is close to V²), because sorting O(E) edges in Kruskal becomes expensive relative to Prim's O(E log V) priority queue approach.

ADR consideration: for production graph traversal in Go, consider whether the graph fits in memory as an adjacency list vs. an adjacency matrix. Adjacency lists use O(V+E) space and give O(degree) neighbor enumeration, appropriate for sparse graphs (social networks, road networks). Adjacency matrices use O(V²) space and give O(1) edge existence checks, appropriate for dense graphs (complete or near-complete). Document the expected density before choosing the representation, because switching representations later requires rebuilding the graph structure.

Bar-raiser signal: the candidate discusses the Johnson's algorithm for all-pairs shortest paths, which reweights edges to eliminate negative weights and then runs Dijkstra from every vertex, achieving O(V² log V + VE) time. They compare this to Floyd-Warshall's O(V³) time and explain when Johnson's is preferable (sparse graphs where E is much less than V²). The candidate also notes that in practice, production systems rarely run Floyd-Warshall on graphs with more than a few thousand nodes due to its cubic time complexity.
