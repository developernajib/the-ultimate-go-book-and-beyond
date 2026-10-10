## Graph Quick Reference Card

This reference brings together representation trade-offs, algorithm complexity, problem-type decision rules, grid traversal patterns, and copy-paste templates for BFS, DFS, and Union-Find. The decision table ("which algorithm for which problem") is the most time-sensitive section during an interview: knowing immediately that negative edge weights mean Bellman-Ford, and that unweighted shortest paths need only BFS, prevents over-engineering with Dijkstra. The Union-Find template uses both path compression and union by rank, giving **amortized** O(α(n)) per operation, where α is the inverse Ackermann function (below 5 for any real input, though not literally constant).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        GRAPH QUICK REFERENCE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  REPRESENTATIONS                                                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Adjacency List:  Space O(V+E), Edge lookup O(degree)                       │
│  Adjacency Matrix: Space O(V²), Edge lookup O(1)                            │
│  Edge List:       Space O(E), Good for Kruskal's MST                        │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ALGORITHM COMPLEXITY CHEAT SHEET                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Algorithm          Time            Space       Use Case                    │
│  BFS                O(V+E)          O(V)        Shortest, uniform cost      │
│  DFS                O(V+E)          O(V)        Path/cycle/connected        │
│  Dijkstra (lazy)    O((V+E)logV)    O(V)+O(E)   Shortest, NON-NEG weights   │
│  Bellman-Ford       O(V*E)          O(V)        Negative weights + cycles   │
│  Floyd-Warshall     O(V³)           O(V²)       All pairs shortest          │
│  Kruskal's MST      O(E log E)      O(V)        MST, given an edge list     │
│  Prim's MST (heap)  O(E log V)      O(V)        MST, given adjacency lists  │
│  Prim's MST (array) O(V²)           O(V)        MST on DENSE graphs         │
│  Topological Sort   O(V+E)          O(V)        DAG ordering                │
│  Union-Find         O(α(N)) amort.  O(V)        Connectivity                │
│  Tarjan's SCC       O(V+E)          O(V)        Strongly connected          │
│  Tarjan's Bridges   O(V+E)          O(V)        Find bridges                │
│                                                                             │
│  Fine print that gets tested:                                               │
│  • Dijkstra: NON-NEGATIVE, not "positive". Zero weights are fine.           │
│  • Dijkstra space: dist is O(V), but the lazy heap holds up to O(E).        │
│  • Union-Find: amortized. One Find can still cost O(log n).                 │
│  • Prim on dense graphs: the ARRAY version wins. The heap version is        │
│    O(V² log V) when E ~ V², which is worse than the plain O(V²) scan.       │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WHEN TO USE EACH ALGORITHM                                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  "Shortest path unweighted"        → BFS (all edges same cost)              │
│  "Shortest path non-negative wts"  → Dijkstra (zero weights OK)             │
│  "Shortest path negative weights"  → Bellman-Ford (also finds neg cycles)   │
│  "Shortest path with K stops"      → BFS levels or Bellman-Ford             │
│  "All pairs shortest path"         → Floyd-Warshall                         │
│  "Minimum spanning tree"           → Kruskal (sparse) or Prim (dense)       │
│  "Detect cycle (undirected)"       → DFS with parent or Union-Find          │
│  "Detect cycle (directed)"         → DFS with colors (white/gray/black)     │
│  "Topological ordering"            → Kahn's (BFS) or DFS post-order         │
│  "Connected components"            → BFS/DFS from each unvisited            │
│  "Dynamic connectivity"            → Union-Find                             │
│  "Find bridges/articulation"       → Tarjan's algorithm                     │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  GRID AS GRAPH PATTERNS                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  4-directional:  dirs := [][]int{{0,1},{0,-1},{1,0},{-1,0}}                 │
│  8-directional:  Add diagonals: {1,1},{1,-1},{-1,1},{-1,-1}                 │
│  Cell to index:  idx = row * cols + col                                     │
│  Index to cell:  row = idx / cols, col = idx % cols                         │
│  Valid cell:     0 <= r < rows && 0 <= c < cols                             │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  COMMON INTERVIEW PATTERNS                                                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  1. Islands/Connected Components:                                           │
│     DFS or BFS from each unvisited '1', count components                    │
│                                                                             │
│  2. Course Schedule / Dependencies:                                         │
│     Build DAG, topological sort, check for cycles                           │
│                                                                             │
│  3. Word Ladder / State Transformation:                                     │
│     BFS where each state is a node, edges are valid transitions             │
│                                                                             │
│  4. Network / Connection Problems:                                          │
│     Union-Find for dynamic connectivity                                     │
│                                                                             │
│  5. Shortest Path Variations:                                               │
│     Modify Dijkstra state: (node, fuel, time, stops, etc.)                  │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BFS TEMPLATE                                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  visited := make(map[Node]bool)                                             │
│  queue := []Node{start}                                                     │
│  visited[start] = true  // Mark BEFORE enqueueing!                          │
│                                                                             │
│  for len(queue) > 0 {                                                       │
│      node := queue[0]                                                       │
│      queue = queue[1:]                                                      │
│                                                                             │
│      for _, neighbor := range getNeighbors(node) {                          │
│          if !visited[neighbor] && isValid(neighbor) {                       │
│              visited[neighbor] = true                                       │
│              queue = append(queue, neighbor)                                │
│          }                                                                  │
│      }                                                                      │
│  }                                                                          │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  DFS TEMPLATE (RECURSIVE)                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  visited := make(map[Node]bool)                                             │
│                                                                             │
│  var dfs func(node Node)                                                    │
│  dfs = func(node Node) {                                                    │
│      if visited[node] || !isValid(node) {                                   │
│          return                                                             │
│      }                                                                      │
│      visited[node] = true                                                   │
│                                                                             │
│      // Process node here                                                   │
│                                                                             │
│      for _, neighbor := range getNeighbors(node) {                          │
│          dfs(neighbor)                                                      │
│      }                                                                      │
│  }                                                                          │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  UNION-FIND TEMPLATE                                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  type UnionFind struct { parent, rank []int }                               │
│                                                                             │
│  func (uf *UnionFind) Find(x int) int {                                     │
│      if uf.parent[x] != x {                                                 │
│          uf.parent[x] = uf.Find(uf.parent[x])  // Path compression          │
│      }                                                                      │
│      return uf.parent[x]                                                    │
│  }                                                                          │
│                                                                             │
│  func (uf *UnionFind) Union(x, y int) bool {                                │
│      px, py := uf.Find(x), uf.Find(y)                                       │
│      if px == py { return false }                                           │
│      if uf.rank[px] < uf.rank[py] { px, py = py, px }                       │
│      uf.parent[py] = px                                                     │
│      if uf.rank[px] == uf.rank[py] { uf.rank[px]++ }                        │
│      return true                                                            │
│  }                                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Reference Card Under Pressure

The reference card is only useful if you have internalised the decision table before the interview, not during it. The most common junior failure mode is spending the first five minutes of a graph problem deciding between Dijkstra and BFS because both "find shortest path." The rule is simple: if edges have no weight or all weights are equal, BFS produces the correct shortest path in O(V+E) and Dijkstra adds unnecessary complexity. Reaching for Dijkstra on an unweighted grid problem is a red flag to interviewers because it suggests pattern matching over understanding.

The BFS template has one critical detail that trips up many candidates: mark nodes visited when you **enqueue** them, not when you dequeue them. Marking on dequeue lets the same node be enqueued once per incoming edge, so the queue grows with E instead of V.

Be accurate about the consequence, because the overstated version is easy to disprove. Provided you keep the `if visited[node] { continue }` guard on dequeue, the traversal still returns **correct** results. This is a memory and time bug, not a correctness bug, and that is exactly what makes it dangerous: every test passes and the failure only appears as TLE or an OOM on the large hidden case. Section 72.2 measures it at 19x the peak queue depth for identical output.

For Union-Find, practice writing the struct, `Find` with path compression, and `Union` with rank from scratch in under three minutes. The template is short but interviewers notice when a candidate has to think about which line comes first in `Union`.

### Senior @ FAANG: Reference Card as an Onboarding and Review Artifact

At the staff level, a reference card like this is not just a personal study aid. It is a design artifact that communicates the team's algorithmic vocabulary. When onboarding a new L5 engineer onto a graph-heavy service (dependency resolution, network topology, route planning), a well-structured reference card anchors early code reviews: "the PR uses Floyd-Warshall on a sparse graph with 10,000 nodes, which is O(V cubed) and will time out. The reference card decision table shows Dijkstra from all sources as the correct approach here."

The algorithm complexity column carries production implications beyond interview prep. O(V squared) for an adjacency matrix representation is acceptable for a static, dense graph loaded once at startup (a routing table with 200 cities). It is catastrophic for a dynamic, sparse graph representing a microservice dependency graph with thousands of services updated in real time. A senior engineer reading an architecture proposal that uses an adjacency matrix for a sparse, high-churn graph raises this concern immediately, citing the space bound as the primary objection.

The "when to use" decision table also governs ADRs for algorithm selection. A well-written ADR for choosing Kruskal over Prim documents: the graph is sparse (E is much smaller than V squared), the edges are already sorted by weight from the data pipeline, and Kruskal avoids the priority queue overhead that Prim requires. It also documents what would change the decision: if the graph becomes dense or if edge weights arrive unsorted, Prim with a binary heap becomes competitive and the ADR should be revisited.

Bar-raiser signal for L6 and above: a strong candidate does not recite the complexity table, they qualify it. They explain that Union-Find's O(α(n)) is **amortized** over a sequence of operations, not a per-operation guarantee, and that α(n) is at most 4 for any input that will ever exist, so it is effectively constant in practice while not literally being O(1). They also know the structural limitation: Union-Find only ever merges. It cannot undo a union without rollback augmentation (which means giving up path compression, or using a union-by-rank-only variant with an undo log), and it cannot split a component at all. That is precisely why "are edges only ever added?" is the first question to ask about a dynamic connectivity problem: deletions make it a genuinely harder problem, not a small variation.

---
