## Summary

- **Adjacency list** for sparse graphs, **adjacency matrix** for dense ones. The matrix only pays off when E approaches V^2, or when you need O(1) edge lookups and V^2 cells are affordable
- **BFS** finds shortest paths when every edge costs the same, not merely when the graph is "unweighted". **DFS** is the versatile traversal underneath cycle detection, topological sort, and components
- **Topological sort** works only on DAGs. `len(result) != numNodes` is exactly equivalent to "there is a cycle", which is why Kahn's needs no separate cycle check
- **Union-Find** gives **amortized** O(α(n)) connectivity. It merges only: it cannot split, and it cannot undo without extra machinery
- **Dijkstra** requires **non-negative** weights (zero is fine). **Bellman-Ford** handles negatives and is the only one of the two that can detect a negative cycle
- **Kruskal** and **Prim** both find an MST. Neither reports a disconnected graph unless you check for n-1 edges
- Model real-world problems as graphs: grids, states, relationships

Graph problems are among the most common in interviews. Master BFS, DFS, topological sort, and Union-Find as your core toolkit.

### Junior → FAANG: Translating the Summary into Interview Readiness

Each bullet in this summary maps to a class of problems you will encounter. "BFS finds shortest path in unweighted graphs" covers number-of-islands variants, word ladder, and minimum steps problems. "Topological sort works only on DAGs" covers course schedule, build order, and task dependency problems. "Union-Find provides near-constant time connectivity" covers dynamic connectivity, redundant connection, and accounts-merge problems.

The actionable practice plan: for each algorithm in the summary, solve two LeetCode problems that require it, then solve one problem where a different algorithm is a tempting but wrong choice. The contrast sharpens pattern recognition under time pressure. For example, solve "Number of Islands" with DFS, then solve "Rotting Oranges" with BFS, then notice why DFS gives wrong answers on the second problem. That comparison is worth more than reading ten explanations.

A common gap at the junior level is knowing the algorithm but not the failure mode. State Dijkstra's negative-weight failure precisely, because the folk version ("it just returns wrong answers") is only half true and Section 72.7 works through why. A Dijkstra that marks vertices settled and never reprocesses them does return wrong distances on negative edges, silently and without panicking. A lazy implementation that re-pushes on every improving relaxation often returns the *right* answer while quietly losing its complexity guarantee, and it never terminates at all on a negative cycle. Either way the conclusion is the same, "negative weights mean Bellman-Ford", but knowing which failure you are describing is what separates a memorized rule from an understood one.

### Senior @ FAANG: Graph Mastery as a Platform Competency

The summary bullets read differently at the staff level. Each one is a category of production system where the algorithm is a core primitive, not just an interview pattern.

Adjacency list versus adjacency matrix is a space and access-pattern decision that shows up in service mesh topology (sparse, thousands of nodes, adjacency list), in road network routing (sparse, millions of nodes, adjacency list with compressed representations), and in recommendation engines (dense subgraphs, matrix operations using linear algebra libraries). A staff engineer choosing a graph representation for a new service documents the expected V and E bounds, the read/write ratio, and whether the graph is static or dynamic, then justifies the choice against these constraints.

Topological sort in production means dependency resolution: package managers, build systems, data pipeline DAG schedulers (Airflow, Prefect), and infrastructure-as-code tooling (Terraform plan). A staff engineer contributing to a DAG scheduler reasons about cycle detection at ingestion time (fail fast), topological level assignment for parallel execution, and incremental re-sort when a single edge changes (not full re-sort from scratch). These are L6 concerns that go well beyond the interview version of the algorithm.

Union-Find in production appears in distributed systems for partition detection, in network topology for connected-component monitoring, and in offline graph algorithms for Kruskal's MST. The operational concern at scale is persistence: a standard Union-Find is in-memory and ephemeral. When the connectivity state must survive restarts, it requires serialization to a persistent store with the rank and parent arrays, plus a replay log for incremental unions. A staff engineer designing this system chooses between full snapshot on shutdown (simple, requires clean shutdown), write-ahead log for every union (durable, higher write amplification), and periodic checkpoint plus replay (balanced). This decision is an ADR, not a code comment.

Bar-raiser expectation at L7: frame the chapter's algorithms not as a list of techniques but as a maturity model for graph-aware system design. L4 knows the algorithms. L5 applies the right algorithm to the right problem. L6 instruments the algorithm (latency histograms, queue depth metrics, cycle detection alerts) and owns the production behavior. L7 defines which graph primitives the platform provides as shared infrastructure and governs how teams across the organization adopt them, preventing duplicated, inconsistently tested implementations of the same Union-Find logic in twenty different services.
