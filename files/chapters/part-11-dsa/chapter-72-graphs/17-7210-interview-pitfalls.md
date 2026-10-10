## 72.15 Interview Pitfalls

### Pitfall 1: BFS Without Marking Visited Before Enqueueing

**Typical failure**: BFS on a grid passes every sample test and then hits TLE or a memory limit on the large ones. The cause is marking visited on dequeue rather than enqueue, which lets the same cell be queued once per incoming edge. Output stays correct, which is precisely why it survives review (Section 72.2 measures the blowup: 19x the queue depth for identical results).

```go
// ❌ WRONG: Mark visited on dequeue (allows duplicates)
func bfsBad(grid [][]int) int {
    visited := make(map[[2]int]bool)
    queue := [][2]int{{0, 0}}

    for len(queue) > 0 {
        cell := queue[0]
        queue = queue[1:]

        // BUG: Multiple paths could have added this cell!
        if visited[cell] {
            continue
        }
        visited[cell] = true  // Too late!

        for _, d := range directions {
            next := [2]int{cell[0] + d[0], cell[1] + d[1]}
            if isValid(next, grid) {
                queue = append(queue, next)  // Same cell added multiple times
            }
        }
    }
    return len(visited)
}

// ✅ CORRECT: Mark visited BEFORE enqueueing
func bfsGood(grid [][]int) int {
    visited := make(map[[2]int]bool)
    queue := [][2]int{{0, 0}}
    visited[[2]int{0, 0}] = true  // Mark starting cell

    for len(queue) > 0 {
        cell := queue[0]
        queue = queue[1:]

        for _, d := range directions {
            next := [2]int{cell[0] + d[0], cell[1] + d[1]}
            if isValid(next, grid) && !visited[next] {
                visited[next] = true  // Mark BEFORE adding to queue
                queue = append(queue, next)
            }
        }
    }
    return len(visited)
}
```

### Pitfall 2: DFS Not Handling Back Edges for Cycle Detection

**Typical failure**: cycle detection returns false positives on directed graphs, because "visited" is confused with "on the current DFS path". Reaching an already-visited vertex is not a cycle. It is a cycle only if that vertex is still on the recursion stack. On `1->2, 3->2`, which has no cycle at all, the single-set version reports one.

```go
// ❌ WRONG: Single visited set for directed graph cycles
func hasCycleBad(graph map[int][]int) bool {
    visited := make(map[int]bool)

    var dfs func(node int) bool
    dfs = func(node int) bool {
        if visited[node] {
            return true  // WRONG: Not all revisits are cycles!
        }
        visited[node] = true

        for _, neighbor := range graph[node] {
            if dfs(neighbor) {
                return true
            }
        }
        return false
    }

    for node := range graph {
        if dfs(node) {
            return true
        }
    }
    return false
}

// ✅ CORRECT: Separate visited and recursion stack
func hasCycleGood(graph map[int][]int) bool {
    visited := make(map[int]bool)
    inStack := make(map[int]bool)  // Currently in DFS recursion

    var dfs func(node int) bool
    dfs = func(node int) bool {
        visited[node] = true
        inStack[node] = true  // Add to current path

        for _, neighbor := range graph[node] {
            if !visited[neighbor] {
                if dfs(neighbor) {
                    return true
                }
            } else if inStack[neighbor] {
                return true  // Back edge = cycle!
            }
        }

        inStack[node] = false  // Remove from current path
        return false
    }

    for node := range graph {
        if !visited[node] && dfs(node) {
            return true
        }
    }
    return false
}
```

### Pitfall 3: Dijkstra Without Checking If Already Finalized

**Typical failure**: a Dijkstra that omits the skip check and re-expands nodes it has already finalized. Be precise about the cost, because this one is routinely overstated. It is a **performance** bug, not a correctness bug: on non-negative weights the `newDist < dist[neighbor]` guard still protects the answer, and the code returns correct distances. What it wastes is a full adjacency-list rescan for every stale heap entry, and since the heap can hold one entry per edge, that is real redundant work. Say "it re-scans stale entries" rather than quoting an invented bound like O(V²), because an interviewer may ask you to derive it.

The insight underneath: with non-negative weights, the first time a node is popped its distance is already final, so every later pop of that node is provably useless.

```go
// ❌ WRONG: Re-processing already finalized nodes
func dijkstraBad(graph map[int][][2]int, start int) map[int]int {
    dist := make(map[int]int)
    pq := &PriorityQueue{}
    heap.Push(pq, &Item{node: start, priority: 0})
    dist[start] = 0

    for pq.Len() > 0 {
        item := heap.Pop(pq).(*Item)
        // BUG: We might process this node again with worse priority!

        for _, edge := range graph[item.node] {
            neighbor, weight := edge[0], edge[1]
            newDist := dist[item.node] + weight
            if d, ok := dist[neighbor]; !ok || newDist < d {
                dist[neighbor] = newDist
                heap.Push(pq, &Item{node: neighbor, priority: newDist})
            }
        }
    }
    return dist
}

// ✅ CORRECT: Skip already finalized nodes
func dijkstraGood(graph map[int][][2]int, start int) map[int]int {
    dist := make(map[int]int)
    finalized := make(map[int]bool)  // Track finalized nodes
    pq := &PriorityQueue{}
    heap.Push(pq, &Item{node: start, priority: 0})
    dist[start] = 0

    for pq.Len() > 0 {
        item := heap.Pop(pq).(*Item)

        // Skip if already processed with shorter distance
        if finalized[item.node] {
            continue
        }
        finalized[item.node] = true

        for _, edge := range graph[item.node] {
            neighbor, weight := edge[0], edge[1]
            if finalized[neighbor] {
                continue  // Already finalized
            }

            newDist := dist[item.node] + weight
            if d, ok := dist[neighbor]; !ok || newDist < d {
                dist[neighbor] = newDist
                heap.Push(pq, &Item{node: neighbor, priority: newDist})
            }
        }
    }
    return dist
}
```

### Pitfall 4: Union-Find Without Path Compression or Union by Rank

**Typical failure**: a Union-Find that degrades to O(N) per operation. Without union by rank, repeatedly attaching one root under another builds a chain rather than a bush. Without path compression, every `Find` re-walks that chain from scratch instead of flattening it on the way out.

```go
// ❌ WRONG: Naive Union-Find, O(N) per operation
type BadUnionFind struct {
    parent []int
}

func (uf *BadUnionFind) Find(x int) int {
    for uf.parent[x] != x {
        x = uf.parent[x]  // Linear traversal up the tree!
    }
    return x
}

func (uf *BadUnionFind) Union(x, y int) {
    px, py := uf.Find(x), uf.Find(y)
    uf.parent[px] = py  // Always attach to py, can create chain
}

// ✅ CORRECT: Path compression + Union by rank, O(α(N)) ≈ O(1)
type GoodUnionFind struct {
    parent []int
    rank   []int
}

func (uf *GoodUnionFind) Find(x int) int {
    if uf.parent[x] != x {
        uf.parent[x] = uf.Find(uf.parent[x])  // Path compression!
    }
    return uf.parent[x]
}

func (uf *GoodUnionFind) Union(x, y int) bool {
    px, py := uf.Find(x), uf.Find(y)
    if px == py {
        return false  // Already connected
    }

    // Union by rank: attach the smaller tree under the larger
    if uf.rank[px] < uf.rank[py] {
        px, py = py, px
    }
    uf.parent[py] = px
    if uf.rank[px] == uf.rank[py] {
        uf.rank[px]++
    }
    return true
}
```

### Pitfall 5: Topological Sort Without Detecting Cycles

**Typical failure**: a topological sort that returns a silently truncated ordering when the graph has a cycle. A topological order only exists for a DAG, so on cyclic input Kahn's simply stops early and hands back a partial list. Returning it as if it were an answer means the caller schedules a subset of the work and never learns why the rest vanished.

```go
// ❌ WRONG: No cycle detection
func topoSortBad(graph map[int][]int) []int {
    inDegree := make(map[int]int)
    for node := range graph {
        inDegree[node] = 0
    }
    for _, neighbors := range graph {
        for _, n := range neighbors {
            inDegree[n]++
        }
    }

    queue := []int{}
    for node, degree := range inDegree {
        if degree == 0 {
            queue = append(queue, node)
        }
    }

    result := []int{}
    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]
        result = append(result, node)

        for _, neighbor := range graph[node] {
            inDegree[neighbor]--
            if inDegree[neighbor] == 0 {
                queue = append(queue, neighbor)
            }
        }
    }
    return result  // May be incomplete if cycle exists!
}

// ✅ CORRECT: Detect cycles
func topoSortGood(graph map[int][]int) ([]int, error) {
    inDegree := make(map[int]int)

    // Register every node, including sinks that appear only as a
    // neighbor and never as a map key.
    for node, neighbors := range graph {
        if _, ok := inDegree[node]; !ok {
            inDegree[node] = 0
        }
        for _, neighbor := range neighbors {
            inDegree[neighbor]++
        }
    }

    // Count from inDegree, NOT from len(graph). With an adjacency map,
    // a node with no outgoing edges has no key, so len(graph) undercounts
    // and the cycle check below fires on a perfectly acyclic graph.
    numNodes := len(inDegree)

    queue := []int{}
    for node, degree := range inDegree {
        if degree == 0 {
            queue = append(queue, node)
        }
    }

    result := []int{}
    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]
        result = append(result, node)

        for _, neighbor := range graph[node] {
            inDegree[neighbor]--
            if inDegree[neighbor] == 0 {
                queue = append(queue, neighbor)
            }
        }
    }

    // Cycle detection: not all nodes processed
    if len(result) != numNodes {
        return nil, fmt.Errorf("graph has cycle, topological sort impossible")
    }
    return result, nil
}
```

The `numNodes := len(inDegree)` line is the subtle one, and it is worth dwelling on because the obvious `len(graph)` is wrong in a way that inverts the check. In an adjacency map, a sink has no outgoing edges and therefore no key. Given the perfectly acyclic `map[int][]int{0: {1}}`, `len(graph)` is 1 while the graph has two nodes, so `len(result)` is 2, the check fires, and the function reports a cycle in a graph that plainly has none.

What makes this nasty is that it passes the tests people naturally write. Build a fixture where every node is listed explicitly, sinks included (`{0: {1}, 1: {}}`), and it works. The bug only appears when a caller omits empty adjacency lists, which is exactly what a caller building the map from an edge list will do. Counting from `inDegree`, which is populated from both endpoints of every edge, is what makes the node count real rather than an artifact of how the caller happened to spell the map.

Section 72.5's `TopologicalSort` sidesteps this entirely by taking `graph.Vertices()` from a graph type that knows how many vertices it has. That is the better design: if the count is load-bearing, do not infer it from a map's shape.

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Late visited marking | TLE, duplicate queue entries, correct output | Mark visited BEFORE enqueueing |
| Single set for cycles | False positives on directed graphs | Separate visited and inStack |
| Re-processing in Dijkstra | Redundant rescans of stale entries | Skip finalized/stale nodes at the top of the loop |
| Naive Union-Find | O(N) per operation | Path compression + union by rank |
| No cycle check in topo sort | Silently truncated ordering | Check `len(result) == node count` |
| Node count from `len(graph)` | False "cycle" on acyclic input | Count from in-degree map, sinks have no key |
| Negative weights with Dijkstra | Wrong distances, or no termination | Use Bellman-Ford (Section 72.7) |
| Forgetting disconnected components | Missing nodes | Loop over all vertices, not just one start |

### Junior → FAANG: Building Pitfall-Resistant Habits

Each pitfall in the table above corresponds to a one-line fix that should become automatic.

Pitfall 1 (late visited marking): add the line `visited[start] = true` immediately after declaring the visited map, before writing the BFS loop. This cannot be forgotten because it is written at the same time as the queue initialization.

Pitfall 2 (single set for cycle detection in directed graphs): when you declare `visited := make(map[int]bool)`, immediately also declare `inStack := make(map[int]bool)`. Seeing both declarations together is a reminder that directed graph DFS needs both.

Pitfall 3 (re-processing in Dijkstra): write the skip as the first statement inside the main loop, before touching any edges. Two equivalent spellings exist and either is fine, as long as you do not half-write one: a `finalized`/`done` set with `if finalized[node] { continue }`, as in `dijkstraGood` above, or the stale-entry test `if item.priority > dist[item.node] { continue }`. The first says "I have already settled this node", the second says "this heap entry is out of date". Both work on non-negative weights.

Pitfall 4 (naive Union-Find): never write a Find function without path compression. The template is always the recursive version with `uf.parent[x] = uf.Find(uf.parent[x])`.

Pitfall 5 (no cycle in topo sort): the cycle check is `if len(result) != numNodes { return nil, error }`. Write this immediately after the main BFS loop, not as an afterthought.

### Senior @ FAANG: Pitfall Prevention at Scale

The pitfalls table is a reactive tool (fix bugs after they are made). At staff level, you design proactive systems that prevent these bugs from being introduced.

For Pitfall 1 and Pitfall 2: the correct fix is a typed abstraction. A `Graph` struct with a `BFS(start int) []int` method that internally handles visited tracking eliminates Pitfall 1 entirely. An `HasCycleDirected() bool` method that internally maintains both `visited` and `inStack` eliminates Pitfall 2. The caller cannot forget these because they are encapsulated.

For Pitfall 3: the lazy-deletion pattern in Dijkstra's (pushing stale entries and skipping them) is the correct production choice. The alternative (an indexed priority queue with `heap.Fix`) is harder to implement correctly and provides only a constant-factor speedup for most real graphs. Document the lazy-deletion pattern explicitly in a code comment: "We may push duplicate entries. The check `d > dist[node]` skips stale ones."

For Pitfalls 4 and 5: these are algorithmic correctness requirements that must be verified by tests, not just by code inspection. A property-based test for Union-Find verifies that after N random union operations, all elements in the same component return the same root. A property-based test for topological sort verifies that for every edge (u, v) in the result, u appears before v. These tests run in CI and catch regressions immediately if the implementation changes.

---
