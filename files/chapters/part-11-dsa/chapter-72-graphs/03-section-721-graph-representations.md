## 72.1 Graph Representations

There are several ways to store a graph in memory, and the right choice depends on the density of edges and the operations you need to perform most frequently. The three main representations are adjacency lists, adjacency matrices, and edge lists. Understanding the tradeoffs between them is important because it directly affects both memory usage and the time complexity of your graph algorithms.

### Adjacency List

An adjacency list stores each vertex alongside a list of its neighbors. This is the most common graph representation because it uses memory proportional to the number of vertices plus edges, making it efficient for sparse graphs. In Go, a `map[int][]int` is the idiomatic way to build an adjacency list, where each key is a vertex and the value is a slice of its neighbors.

```go
package graph

// AdjacencyList is the most common graph representation
// Space: O(V + E)
type AdjacencyList struct {
    vertices int
    edges    int
    adj      map[int][]int
    directed bool
}

// NewAdjacencyList creates a graph with n vertices
func NewAdjacencyList(n int, directed bool) *AdjacencyList {
    return &AdjacencyList{
        vertices: n,
        adj:      make(map[int][]int),
        directed: directed,
    }
}

// AddEdge adds an edge between u and v
func (g *AdjacencyList) AddEdge(u, v int) {
    g.adj[u] = append(g.adj[u], v)
    if !g.directed {
        g.adj[v] = append(g.adj[v], u)
    }
    g.edges++
}

// Neighbors returns adjacent vertices
func (g *AdjacencyList) Neighbors(v int) []int {
    return g.adj[v]
}

// HasEdge checks if edge exists
func (g *AdjacencyList) HasEdge(u, v int) bool {
    for _, neighbor := range g.adj[u] {
        if neighbor == v {
            return true
        }
    }
    return false
}

// Degree returns the degree of a vertex
func (g *AdjacencyList) Degree(v int) int {
    return len(g.adj[v])
}

// Vertices returns the number of vertices
func (g *AdjacencyList) Vertices() int {
    return g.vertices
}

// Edges returns the number of edges
func (g *AdjacencyList) Edges() int {
    return g.edges
}
```

### Weighted Adjacency List

A weighted adjacency list extends the basic adjacency list by attaching a weight (or cost) to each edge. This is essential for problems involving distances, costs, or capacities, such as finding the shortest route between cities. Instead of storing just neighbor IDs, each entry stores an `Edge` struct containing both the destination vertex and the edge weight.

```go
package graph

// Edge represents a weighted edge
type Edge struct {
    To     int
    Weight int
}

// WeightedGraph represents a weighted graph
type WeightedGraph struct {
    vertices int
    adj      map[int][]Edge
    directed bool
}

// NewWeightedGraph creates a weighted graph
func NewWeightedGraph(n int, directed bool) *WeightedGraph {
    return &WeightedGraph{
        vertices: n,
        adj:      make(map[int][]Edge),
        directed: directed,
    }
}

// AddEdge adds a weighted edge
func (g *WeightedGraph) AddEdge(u, v, weight int) {
    g.adj[u] = append(g.adj[u], Edge{To: v, Weight: weight})
    if !g.directed {
        g.adj[v] = append(g.adj[v], Edge{To: u, Weight: weight})
    }
}

// Neighbors returns adjacent edges with weights
func (g *WeightedGraph) Neighbors(v int) []Edge {
    return g.adj[v]
}
```

### Adjacency Matrix

An adjacency matrix uses a 2D array where `matrix[i][j]` holds the weight of the edge from vertex `i` to vertex `j`, or a sentinel value (like infinity) if no edge exists. This representation uses O(V^2) space, which makes it best suited for dense graphs where most vertex pairs are connected. Checking whether an edge exists is an O(1) lookup, but iterating over all neighbors of a vertex always takes O(V) time regardless of how many actual neighbors exist.

```go
package graph

// AdjacencyMatrix uses 2D array representation
// Space: O(V^2), Good for dense graphs
type AdjacencyMatrix struct {
    vertices int
    matrix   [][]int // matrix[i][j] = weight, 0 or INF for no edge
}

const INF = 1 << 30

// NewAdjacencyMatrix creates a graph with n vertices
func NewAdjacencyMatrix(n int) *AdjacencyMatrix {
    matrix := make([][]int, n)
    for i := range matrix {
        matrix[i] = make([]int, n)
        for j := range matrix[i] {
            if i != j {
                matrix[i][j] = INF
            }
        }
    }
    return &AdjacencyMatrix{vertices: n, matrix: matrix}
}

// AddEdge adds an edge with weight
func (g *AdjacencyMatrix) AddEdge(u, v, weight int) {
    g.matrix[u][v] = weight
}

// AddUndirectedEdge adds edge in both directions
func (g *AdjacencyMatrix) AddUndirectedEdge(u, v, weight int) {
    g.matrix[u][v] = weight
    g.matrix[v][u] = weight
}

// HasEdge checks if edge exists
func (g *AdjacencyMatrix) HasEdge(u, v int) bool {
    return g.matrix[u][v] != INF && g.matrix[u][v] != 0
}

// Weight returns the weight of an edge
func (g *AdjacencyMatrix) Weight(u, v int) int {
    return g.matrix[u][v]
}
```

Note the sentinel trap in `HasEdge`. It treats both `INF` and `0` as "no edge", so a legitimate zero-weight edge is invisible: `AddEdge(u, v, 0)` followed by `HasEdge(u, v)` returns false. Zero-weight edges are perfectly ordinary (a free transfer, a same-city hop), so this design conflates "absent" with "costs nothing". If your problem admits zero weights, either pick a sentinel outside the legal weight range and compare only against it, or carry a separate `[][]bool` presence matrix. The same objection applies to the diagonal, initialized to 0 to mean "a vertex is distance zero from itself", which `HasEdge` then reports as no self-loop.

### Edge List

An edge list is the simplest graph representation: it stores every edge as a struct containing the source vertex, destination vertex, and weight. This format is particularly useful for algorithms like Kruskal's minimum spanning tree, which need to sort and iterate over all edges. The tradeoff is that finding all neighbors of a specific vertex requires scanning every edge, making neighbor lookups slow compared to adjacency lists.

```go
package graph

// EdgeList represents graph as list of edges
// Good for Kruskal's algorithm
type EdgeList struct {
    vertices int
    edges    []WeightedEdge
}

type WeightedEdge struct {
    From, To, Weight int
}

// NewEdgeList creates an edge list graph
func NewEdgeList(n int) *EdgeList {
    return &EdgeList{vertices: n}
}

// AddEdge adds an edge
func (g *EdgeList) AddEdge(u, v, weight int) {
    g.edges = append(g.edges, WeightedEdge{From: u, To: v, Weight: weight})
}

// GetEdges returns all edges
func (g *EdgeList) GetEdges() []WeightedEdge {
    return g.edges
}
```

### Junior → FAANG: Choosing a Representation for Interview Problems

In interviews, you almost always want an adjacency list (`map[int][]int` or `[][]int`), not a matrix. Most interview graphs are sparse, and the adjacency list uses O(V+E) space instead of O(V^2). Take 1000 vertices and 2000 undirected edges: the adjacency list stores each edge from both ends, so 4000 neighbor entries plus 1000 list headers, against 1,000,000 cells for the matrix. That is a factor of roughly 200, and it grows linearly with V, so the gap only widens.

The crossover is worth being able to state: the matrix wins on memory only when E approaches V^2, meaning a genuinely dense graph. It also wins whenever you need O(1) edge-existence checks and V is small enough that V^2 cells are affordable. Those are real cases (all-pairs shortest paths via Floyd-Warshall wants a matrix), just not the common ones.

When the problem provides a grid (2D array of cells), treat it as an implicit adjacency list. Each cell (r,c) has up to four neighbors (r+1,c), (r-1,c), (r,c+1), (r,c-1), and you generate them on the fly in BFS or DFS. Building an explicit graph first is wasted work and a common way to run out of time.

Edge lists appear mainly in MST problems (Kruskal's requires sorted edges). For any other problem, convert to an adjacency list first.

Common mistake: building a `map[int][]int` for a problem where vertices are numbered 0 to n-1. Use `[][]int` (a slice of slices) instead for O(1) neighbor lookup without hash map overhead.

### Senior @ FAANG: Representation Trade-offs in Production Graph Systems

At production scale, representation choice is a systems engineering decision, not an algorithm choice.

For sparse graphs with billions of edges (social networks, web graphs), the Compressed Sparse Row (CSR) format is the standard. CSR stores two flat arrays: `offsets`, of length V+1, giving where each vertex's edge list begins, and `destinations`, holding the target vertices back to back. Vertex `v`'s neighbors are exactly `destinations[offsets[v]:offsets[v+1]]`, which is a slice expression and no allocation.

Get the memory arithmetic right, because it is easy to state carelessly. For a **directed** graph, CSR costs E entries in `destinations` plus V+1 in `offsets`, not "2 * E". The factor of two appears only for an **undirected** graph, where each edge is stored once in each endpoint's list, giving 2E destinations. Weights, if present, add another E (or 2E) entries in a parallel array. Compare this against `map[int][]int`, which pays a hash lookup per vertex plus a separate heap allocation and slice header per adjacency list. At a billion edges those per-vertex overheads dominate, and that, more than the raw entry count, is why CSR wins.

Also be careful with the edge-existence claim: it is **not** constant time. If `destinations` is sorted within each vertex's range you can binary search it in O(log d) for degree d, and if it is unsorted you scan in O(d). Constant-time existence checking needs a hash set, which is a different structure with different memory. CSR's real strength is sequential traversal: every edge of a vertex is contiguous, so the hardware prefetcher works perfectly, which is exactly the access pattern BFS, PageRank, and friends need. CSR-like edge partitioning is standard in graph processing engines, and Spark's GraphX builds a clustered index of this kind, though vertex-centric frameworks vary in their internal layout and you should check rather than assume.

CSR's weakness is mutation. Inserting one edge shifts everything after it, so it is O(E) per modification and CSR is effectively a read-only, build-once format. For continuously changing graphs, use a per-vertex hash set of neighbors. If it must be concurrent, note that `sync.Map` only protects the outer map: the inner `map[int]struct{}` values are ordinary maps and concurrent writes to one will panic on a concurrent map write. Either guard each vertex's set with its own mutex, shard the graph by vertex hash, or make the inner sets immutable and swap them atomically. The right answer follows from the read/write ratio, and read-heavy graphs often do best with periodic rebuilds into CSR plus a small mutable delta overlay.

For dense graphs (network latency matrices, similarity matrices in recommendation systems), the matrix format is correct. But at V=10000, a 64-bit float matrix occupies 800MB. Production systems use compressed representations (sparse matrix formats, low-rank approximations) for similarity matrices and explicit routing tables (with prefix compression) for network matrices. A staff engineer owning a graph processing pipeline chooses the representation based on measured memory and access-pattern profiles, not algorithmic defaults.
