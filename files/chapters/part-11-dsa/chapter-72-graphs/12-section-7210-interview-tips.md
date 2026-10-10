## 72.10 Interview Tips

Knowing the algorithms is only half the battle in graph interviews. You also need to quickly recognize which algorithm fits the problem, recall its complexity, and avoid the subtle bugs that trip up even experienced candidates. This section provides a complexity cheat sheet and a pattern-matching guide to help you make these decisions under pressure.

### Complexity Summary

The following table summarizes the time and space complexity of every major graph algorithm in this chapter. Use it as a quick reference when choosing an algorithm, and pay attention to the "Use Case" column: running Dijkstra's on a graph with negative weights forfeits its complexity guarantee and, in the settled-set formulation, returns wrong distances outright (Section 72.7).

| Algorithm | Time | Space | Use Case |
|-----------|------|-------|----------|
| BFS | O(V+E) | O(V) | Shortest path (unweighted, uniform cost) |
| DFS | O(V+E) | O(V) | Path finding, cycle detection |
| Dijkstra (lazy heap) | O((V+E)logV) | O(V) dist + O(E) heap | Shortest path, **non-negative** weights |
| Bellman-Ford | O(VE) | O(V) | Negative weights, detect negative cycle |
| Floyd-Warshall | O(V³) | O(V²) | All-pairs shortest paths |
| Kruskal | O(ElogE) | O(V) | MST, natural on an edge list |
| Prim (binary heap) | O(ElogV) | O(V) | MST, natural on an adjacency list |
| Prim (array scan) | O(V²) | O(V) | MST on **dense** graphs, beats the heap |
| Topological Sort | O(V+E) | O(V) | DAG ordering |
| Union-Find | O(α(n)) amortized | O(V) | Connectivity, MST |

Notes on the fine print, since each of these is a place the table is usually read too generously:

- **Dijkstra needs non-negative, not strictly positive.** Zero-weight edges are fine and the proof still holds.
- **Dijkstra's space is not O(V).** The `dist` array is O(V), but the lazy implementation pushes one heap entry per successful relaxation, so the heap itself is O(E).
- **Union-Find's bound is amortized, and α(n) is not a constant.** It is the inverse Ackermann function, which is below 5 for any input you will ever see, which is not the same claim as O(1). The amortized qualifier matters: one individual `Find` can still cost O(log n).
- **Prim's dense-graph advantage belongs to the array version**, not the heap version. On a dense graph the heap version is O(V² log V), which is worse than the plain O(V²) scan.

### Pattern Recognition

Knowing which algorithm to apply is often harder than implementing it. The diagram below maps common problem characteristics to the right algorithm choice. For example, if the problem asks for the shortest path in an unweighted graph, BFS is always the answer. If the problem involves grouping or connectivity, consider Union-Find. Memorizing these patterns will help you identify the correct approach within seconds during an interview.

```
┌─────────────────────────────────────────────────────────────────┐
│              GRAPH PROBLEM PATTERNS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  When to use BFS:                                               │
│  • Shortest path in unweighted graph                            │
│    (or any graph where EVERY edge costs the same)               │
│  • Level-by-level traversal                                     │
│  • Finding nearest node                                         │
│                                                                 │
│  When to use DFS:                                               │
│  • Path existence                                               │
│  • Cycle detection                                              │
│  • Connected components                                         │
│  • Topological sort                                             │
│                                                                 │
│  When to use Union-Find:                                        │
│  • Dynamic connectivity queries                                 │
│  • Kruskal's MST                                                │
│  • Detecting cycle in undirected graph                          │
│                                                                 │
│  When to use Dijkstra:                                          │
│  • Single-source shortest path, NON-NEGATIVE weights            │
│    (zero is fine; one negative edge and you need Bellman-Ford)  │
│                                                                 │
│  Common modeling patterns:                                      │
│  • Grid as graph: 4 or 8 directional neighbors                  │
│  • State as node: (position, time), (word, steps)               │
│  • Implicit graph: no explicit edges, generate on-the-fly       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: The First 60 Seconds of a Graph Interview

The pattern recognition chart above should become an automatic reflex. Here is a concrete protocol for the first 60 seconds of any graph problem.

Read the problem. Ask: does the problem mention paths, connectivity, ordering, or shortest routes? If any of those words appear (even implicitly), it is a graph problem.

Model the graph: what are the vertices? what are the edges? Are edges directed or undirected? Are they weighted?

Choose the algorithm using the chart. If the problem has "shortest" and the graph is unweighted, BFS. If weighted and no negative weights, Dijkstra's. If the problem has "order" or "dependencies", topological sort. If it has "connect" or "components", BFS/DFS or Union-Find.

State your plan before coding: "I'll model this as a directed graph, detect cycles with three-color DFS, and if no cycle exists, return the topological order via Kahn's algorithm." Saying this out loud gives the interviewer a chance to correct misunderstandings before you write code, and it demonstrates algorithmic thinking rather than trial-and-error.

### Senior @ FAANG: Interview Design for Graph Problems at L5 and Above

When you are the interviewer rather than the candidate, the pattern recognition chart helps you calibrate difficulty and evaluate depth.

A well-designed L5 graph interview problem has: a non-obvious graph model (the candidate must figure out vertices and edges, not just code a given algorithm), a standard algorithm that solves it (BFS, DFS, topological sort, Dijkstra's), and at least one follow-up that requires extending the algorithm (handle negative weights, add a constraint, or optimize for a different metric).

A well-designed L6 graph interview problem has: a system-design framing (not "implement Dijkstra's" but "design a routing service that finds the fastest path considering real-time traffic"), multiple valid approaches with explicit trade-offs (exact vs approximate, offline vs online, single-machine vs distributed), and a scaling dimension that invalidates the naive approach (n=1 billion vertices, edge weights change every second, 99.99% latency SLA).

The bar-raiser interview signal for graph problems at L6 is the candidate's ability to identify the hidden graph structure in a business problem, choose the algorithm based on the problem's constraints rather than pattern-matching to a known problem, and reason about edge cases (disconnected graphs, negative cycles, dynamic edge weights) that would cause production failures. Candidates who score "strong hire" at L6 can also design the system around the algorithm, not just implement the algorithm.
