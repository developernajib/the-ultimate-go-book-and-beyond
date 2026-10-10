## 72.5 Topological Sort

Topological sorting produces a linear ordering of vertices in a directed acyclic graph (DAG) such that for every edge from vertex `u` to vertex `v`, `u` appears before `v` in the ordering. This is essential for dependency resolution problems like build systems, course prerequisites, and task scheduling. Two common approaches exist: Kahn's algorithm (BFS-based, using in-degree counting) and DFS-based post-order reversal. If the graph contains a cycle, no valid topological order exists.

```go
// TopologicalSort returns vertices in topological order
// Only works for DAG (Directed Acyclic Graph)
// Kahn's algorithm using BFS
func TopologicalSort(graph *AdjacencyList) ([]int, bool) {
    n := graph.Vertices()
    inDegree := make([]int, n)

    // Calculate in-degrees
    for v := 0; v < n; v++ {
        for _, neighbor := range graph.Neighbors(v) {
            inDegree[neighbor]++
        }
    }

    // Start with vertices having in-degree 0
    queue := []int{}
    for v := 0; v < n; v++ {
        if inDegree[v] == 0 {
            queue = append(queue, v)
        }
    }

    result := []int{}
    for len(queue) > 0 {
        vertex := queue[0]
        queue = queue[1:]
        result = append(result, vertex)

        for _, neighbor := range graph.Neighbors(vertex) {
            inDegree[neighbor]--
            if inDegree[neighbor] == 0 {
                queue = append(queue, neighbor)
            }
        }
    }

    // Check if all vertices are included (no cycle)
    if len(result) != n {
        return nil, false // Graph has a cycle
    }

    return result, true
}

// TopologicalSortDFS using DFS
func TopologicalSortDFS(graph *AdjacencyList) ([]int, bool) {
    n := graph.Vertices()
    visited := make(map[int]bool)
    inStack := make(map[int]bool)
    result := []int{}
    hasCycle := false

    var dfs func(int)
    dfs = func(v int) {
        if hasCycle {
            return
        }
        visited[v] = true
        inStack[v] = true

        for _, neighbor := range graph.Neighbors(v) {
            if inStack[neighbor] {
                hasCycle = true
                return
            }
            if !visited[neighbor] {
                dfs(neighbor)
            }
        }

        inStack[v] = false
        result = append(result, v)
    }

    for v := 0; v < n; v++ {
        if !visited[v] {
            dfs(v)
        }
    }

    if hasCycle {
        return nil, false
    }

    // Reverse result
    for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
        result[i], result[j] = result[j], result[i]
    }

    return result, true
}

// CourseSchedule determines if all courses can be finished
// LeetCode 207: Course Schedule
func CanFinish(numCourses int, prerequisites [][]int) bool {
    graph := NewAdjacencyList(numCourses, true)
    for _, prereq := range prerequisites {
        graph.AddEdge(prereq[1], prereq[0])
    }

    _, ok := TopologicalSort(graph)
    return ok
}

// FindOrder returns order to take all courses
// LeetCode 210: Course Schedule II
func FindOrder(numCourses int, prerequisites [][]int) []int {
    graph := NewAdjacencyList(numCourses, true)
    for _, prereq := range prerequisites {
        graph.AddEdge(prereq[1], prereq[0])
    }

    order, ok := TopologicalSort(graph)
    if !ok {
        return []int{}
    }
    return order
}
```

Note the edge direction in `CanFinish` and `FindOrder`. LeetCode gives `prerequisites[i] = [a, b]` meaning "to take `a` you must first take `b`", so the dependency edge runs `b -> a` and the call is `AddEdge(prereq[1], prereq[0])`. Reversing this is the single most common way to fail these two problems, and it fails quietly: the reversed graph is still acyclic exactly when the original is, so `CanFinish` keeps returning the right answer while `FindOrder` hands back an order that is precisely backwards.

### Tracing Kahn's Algorithm

Take the DAG `5->2, 5->0, 4->0, 4->1, 2->3, 3->1` on vertices 0 through 5, and run the code above:

```
initial in-degrees: [2 2 1 1 0 0]      (vertex:  0  1  2  3  4  5)
initial queue:      [4 5]              (the in-degree 0 vertices)

pop 4 -> result=[4]           indeg=[1 1 1 1 0 0]  queue=[5]
pop 5 -> result=[4 5]         indeg=[0 1 0 1 0 0]  queue=[2 0]
pop 2 -> result=[4 5 2]       indeg=[0 1 0 0 0 0]  queue=[0 3]
pop 0 -> result=[4 5 2 0]     indeg=[0 1 0 0 0 0]  queue=[3]
pop 3 -> result=[4 5 2 0 3]   indeg=[0 0 0 0 0 0]  queue=[1]
pop 1 -> result=[4 5 2 0 3 1] indeg=[0 0 0 0 0 0]  queue=[]
```

Check the result `[4 5 2 0 3 1]` against every edge: 5 precedes 2 and 0, 4 precedes 0 and 1, 2 precedes 3, 3 precedes 1. All six edges point forward, so the order is valid.

**Why it is correct.** The invariant is that a vertex enters the queue only when its in-degree hits zero, meaning every predecessor has already been emitted. So when a vertex is appended to `result`, all of its prerequisites sit earlier in `result`, which is exactly the topological property. Decrementing `inDegree[neighbor]` after emitting `vertex` is how a vertex "uses up" its incoming edges one at a time.

**Why the cycle check works.** Every vertex is enqueued at most once, and only via in-degree reaching zero. A vertex on a cycle can never reach in-degree zero, because at least one of its predecessors on that cycle is also never emitted. So all cycle vertices, and everything downstream of them, are never enqueued, and `len(result) < n`. The converse holds too: in a DAG some vertex always has in-degree zero (follow edges backwards, and with no cycle you must eventually stop), so the queue never empties early. `len(result) != n` is therefore exactly equivalent to "the graph has a cycle", which is why the check needs no extra bookkeeping.

Running `TopologicalSortDFS` on the same graph yields `[5 4 2 3 1 0]`, a different but equally valid order. Topological orders are generally not unique, so never assert one exact answer in a test. Assert the property: every edge points forward.

### Junior → FAANG: Kahn's vs DFS Topological Sort

Both approaches produce a valid topological ordering, but they have different strengths in interviews.

Kahn's algorithm (BFS-based) is easier to verify: if the result contains fewer vertices than the graph, a cycle exists. The cycle detection is automatic. Start with all zero-in-degree vertices, process them greedily, decrement neighbors' in-degrees, and add any newly zero-in-degree vertex to the queue.

DFS-based post-order reversal is harder to verify but produces the ordering in a more natural way for problems like "find the order to take all courses." The `inStack` map (separate from `visited`) is the key addition for directed graph cycle detection during DFS topological sort.

Practice rule: if the problem asks "can all tasks be completed?" use Kahn's (the cycle check is automatic). If the problem asks "in what order should tasks be completed?" use either, but Kahn's is easier to explain and verify.

Common edge case: graphs with no prerequisites (empty edge list). Both algorithms return all vertices in some order. On three isolated vertices, Kahn's gives `[0 1 2]` and the DFS version gives `[2 1 0]`. Both are correct, since with no edges every order is topological, and the disagreement is a useful reminder not to hard-code an expected slice in your tests.

### Senior @ FAANG: Topological Sort in Build Systems and Workflow Orchestration

Topological sort is the core algorithm in every build system (Bazel, Gradle, Make), package manager (npm, pip, Go modules), and workflow orchestrator (Apache Airflow, Temporal, GitHub Actions). The scale difference between interview problems (dozens of courses) and production systems (millions of build targets) drives important engineering choices.

For Bazel with millions of build targets, the topological sort runs in parallel: once a target's in-degree drops to zero, it can be built immediately on any available worker. This is a parallel Kahn's algorithm where the queue is replaced by a work-stealing task pool. The critical engineering challenge is false dependencies: over-specified dependencies create edges that are not needed for correctness, which reduces parallelism. A staff engineer at Google owns the tooling that detects false dependencies and removes them, directly impacting build times for thousands of engineers.

For workflow orchestrators like Temporal, the DAG is dynamic: tasks are added at runtime, and the topological ordering must be maintained incrementally as new tasks arrive. The static Kahn's algorithm must be replaced by an incremental algorithm (one efficient approach: maintain in-degree counts, update them as edges are added, and add newly zero-in-degree tasks to the work queue immediately). This incremental approach has the same O(V+E) amortised complexity as the static algorithm but supports online task graph modification.

At L6, the engineering design question for a new workflow orchestrator is: should we maintain the topological ordering explicitly (lower latency to schedule a task once it becomes ready) or recompute it on demand (simpler implementation, higher scheduling latency)? The answer depends on the ratio of task additions to scheduling events, which is a measurement, not an assumption.
