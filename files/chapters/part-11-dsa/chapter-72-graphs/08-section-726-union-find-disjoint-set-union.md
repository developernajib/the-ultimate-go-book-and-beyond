## 72.6 Union-Find (Disjoint Set Union)

Union-Find (also called Disjoint Set Union or DSU) is a data structure that tracks a collection of non-overlapping sets. It supports two primary operations: `Find` (which set does an element belong to?) and `Union` (merge two sets together). With path compression and union by rank optimizations, both operations run in nearly O(1) amortized time. Union-Find is widely used for dynamic connectivity queries, cycle detection in undirected graphs, and Kruskal's minimum spanning tree algorithm.

```go
// UnionFind implements disjoint set data structure
// with path compression and union by rank
type UnionFind struct {
    parent []int
    rank   []int
    count  int // number of components
}

// NewUnionFind creates a union-find with n elements
func NewUnionFind(n int) *UnionFind {
    uf := &UnionFind{
        parent: make([]int, n),
        rank:   make([]int, n),
        count:  n,
    }
    for i := 0; i < n; i++ {
        uf.parent[i] = i
    }
    return uf
}

// Find returns the root of x with path compression
// Time: O(α(n)) amortized, essentially O(1)
func (uf *UnionFind) Find(x int) int {
    if uf.parent[x] != x {
        uf.parent[x] = uf.Find(uf.parent[x]) // path compression
    }
    return uf.parent[x]
}

// Union merges sets containing x and y
// Time: O(α(n)) amortized
func (uf *UnionFind) Union(x, y int) bool {
    rootX, rootY := uf.Find(x), uf.Find(y)

    if rootX == rootY {
        return false // already in same set
    }

    // Union by rank
    if uf.rank[rootX] < uf.rank[rootY] {
        rootX, rootY = rootY, rootX
    }
    uf.parent[rootY] = rootX
    if uf.rank[rootX] == uf.rank[rootY] {
        uf.rank[rootX]++
    }

    uf.count--
    return true
}

// Connected checks if x and y are in the same set
func (uf *UnionFind) Connected(x, y int) bool {
    return uf.Find(x) == uf.Find(y)
}

// Count returns the number of disjoint sets
func (uf *UnionFind) Count() int {
    return uf.count
}

// NumberOfIslands using Union-Find
// LeetCode 200: Number of Islands
func NumIslandsUF(grid [][]byte) int {
    if len(grid) == 0 {
        return 0
    }

    m, n := len(grid), len(grid[0])
    uf := NewUnionFind(m * n)
    water := 0

    getIndex := func(i, j int) int {
        return i*n + j
    }

    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            if grid[i][j] == '0' {
                water++
                continue
            }

            // Union with right and down neighbors
            if j+1 < n && grid[i][j+1] == '1' {
                uf.Union(getIndex(i, j), getIndex(i, j+1))
            }
            if i+1 < m && grid[i+1][j] == '1' {
                uf.Union(getIndex(i, j), getIndex(i+1, j))
            }
        }
    }

    return uf.Count() - water
}
```

The `uf.Count() - water` at the end is the part worth pausing on. `NewUnionFind(m*n)` creates a component for *every* cell, land and water alike, and water cells are never unioned with anything, so each one survives as its own singleton component. Subtracting `water` removes exactly those singletons and leaves the island count. On `10 / 01` it gives 2, on `111 / 111` it gives 1, and on all-water it gives 0.

### Junior → FAANG: Union-Find vs BFS/DFS for Connectivity

Union-Find and BFS/DFS both solve connectivity questions, but their strengths differ.

Use Union-Find when: the problem involves dynamic connectivity (edges are added incrementally and you need to query connectivity after each addition), when you need to count components efficiently, or when you are implementing Kruskal's MST.

Use BFS/DFS when: the problem requires finding the actual path between two vertices, when the graph is given all at once (not incrementally), or when you need to process vertices in a specific order.

For "Number of Islands" (grid problem), both work. BFS/DFS is more natural. Union-Find is more efficient if the grid is given incrementally (online version of the problem).

The two optimizations, path compression and union by rank, are not optional in an interview, and you should be able to say what each one buys separately. Union by rank alone bounds tree height at O(log n), giving O(log n) worst case per operation. Path compression alone gives O(log n) amortized. Together they give O(α(n)) amortized, where α is the inverse Ackermann function.

Be precise about α(n) rather than just calling it "basically 1", because that is the follow-up. α(n) is not constant, it is merely a function that grows so slowly it is bounded by 4 for any n that fits in the observable universe. So the bound is not O(1), it is amortized O(α(n)), and Tarjan proved this is optimal for any pointer-machine implementation. Saying "effectively constant, but formally inverse Ackermann amortized, and it is a tight bound" is the complete answer.

The word **amortized** is load-bearing too: a single `Find` can still walk a long path and cost O(log n). It is the sequence of m operations that costs O(m α(n)), because each expensive `Find` flattens the tree it walked and makes future calls cheap. Chaining 100,000 unions in a line leaves a structure whose maximum rank is 1, which is what the flattening looks like in practice.

Common mistake in `NumIslandsUF`: forgetting to subtract the water cells from the component count. Without it, every water cell inflates the answer by one. Verify with a 2x2 grid before the interview.

### Senior @ FAANG: Union-Find in Distributed Systems and Persistent Data Structures

Union-Find is a fundamentally imperative data structure: the path compression and union by rank optimizations require mutation. This makes it straightforward in Go (mutable arrays) but challenging in functional or persistent contexts.

For distributed systems where connectivity queries span multiple machines, Union-Find must be made distributed. The standard approach is to partition the vertex set across machines, with each machine maintaining a local Union-Find for its subset of vertices. Cross-partition edges are handled by a coordinator that receives "these two vertices are connected" messages and unions their partition representatives. This gives O(α(n)) amortised per local operation and O(number of cross-partition edges) coordinator operations. The Borůvka's MST algorithm uses this structure for distributed MST computation.

For persistent data structures (functional programming, undo history, versioned snapshots), path compression destroys the ability to roll back to a previous state. The persistent Union-Find replaces mutable arrays with immutable balanced BSTs (implementing the same O(log n) operations without mutation), allowing O(log n) per union/find while supporting O(1) snapshot and O(log n) rollback. This is used in persistent data stores and functional language runtimes. A staff engineer evaluating whether to use persistent Union-Find must weigh the O(log n) per-operation overhead against the snapshot requirement. for most applications, immutability is not needed and the standard mutable version is correct.
