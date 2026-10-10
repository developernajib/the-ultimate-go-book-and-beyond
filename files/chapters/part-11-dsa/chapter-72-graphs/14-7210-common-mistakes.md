## 72.12 Common Mistakes

Graph algorithms have several subtle pitfalls that cause bugs even in experienced programmers' code. The mistakes below are the most frequently observed in interviews and code reviews. Each example shows the broken code alongside the corrected version so you can learn to spot these patterns immediately.

### Mistake 1: Not Tracking Visited Nodes

One of the most common graph bugs is forgetting to track which vertices have already been visited. Without a visited set, any cycle in the graph causes an infinite loop because the traversal keeps revisiting the same vertices. Always create a `map[int]bool` (or a boolean slice) and mark each vertex as visited before or when you process it. The examples below show the broken version and the corrected version side by side.

```go
// ❌ BAD: Infinite loop on cyclic graph
func dfsBad(graph map[int][]int, start int) {
    stack := []int{start}
    for len(stack) > 0 {
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]
        for _, neighbor := range graph[node] {
            stack = append(stack, neighbor)  // May add same node multiple times!
        }
    }
}

// ✅ GOOD: Track visited nodes
func dfsGood(graph map[int][]int, start int) {
    visited := make(map[int]bool)
    stack := []int{start}

    for len(stack) > 0 {
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]

        if visited[node] {
            continue
        }
        visited[node] = true

        for _, neighbor := range graph[node] {
            if !visited[neighbor] {
                stack = append(stack, neighbor)
            }
        }
    }
}
```

### Mistake 2: Wrong BFS Queue Operations

BFS requires a queue (first-in, first-out), but a common mistake is accidentally using stack operations (last-in, first-out), which turns the traversal into DFS. In Go, a queue is implemented by dequeuing from the front with `queue[0]` and slicing with `queue[1:]`, while a stack pops from the back with `stack[len(stack)-1]`. Mixing these up produces correct-looking code that silently gives wrong results for shortest-path problems.

```go
// ❌ BAD: Using stack (LIFO) instead of queue (FIFO)
func bfsBad(graph map[int][]int, start int) []int {
    var result []int
    stack := []int{start}  // Should be queue!

    for len(stack) > 0 {
        node := stack[len(stack)-1]  // Wrong: this is pop from back (LIFO)
        stack = stack[:len(stack)-1]
        result = append(result, node)

        for _, neighbor := range graph[node] {
            stack = append(stack, neighbor)
        }
    }
    return result  // This is actually DFS!
}

// ✅ GOOD: Use proper queue (FIFO)
func bfsGood(graph map[int][]int, start int) []int {
    var result []int
    queue := []int{start}
    visited := map[int]bool{start: true}

    for len(queue) > 0 {
        node := queue[0]      // Dequeue from front
        queue = queue[1:]     // This makes it FIFO
        result = append(result, node)

        for _, neighbor := range graph[node] {
            if !visited[neighbor] {
                visited[neighbor] = true
                queue = append(queue, neighbor)
            }
        }
    }
    return result
}
```

### Junior → FAANG: Avoiding These Mistakes Under Interview Pressure

These two mistakes, missing visited tracking and FIFO/LIFO confusion, are among the most common ways a graph solution fails. Both survive simple test cases and then produce TLE or wrong answers on larger inputs, which is the worst possible failure mode: the bug is invisible exactly when you are checking for it.

For missing visited tracking: write `visited := make(map[int]bool)` and `visited[start] = true` as your first two lines for any BFS or DFS implementation. Do not start the traversal loop before both lines are written. This prevents both mistakes.

For FIFO vs LIFO confusion: name your data structure clearly. If you write `queue := []int{start}`, you are committed to FIFO dequeue: `node := queue[0]; queue = queue[1:]`. If you write `stack := []int{start}`, you are committed to LIFO dequeue: `node := stack[len(stack)-1]; stack = stack[:len(stack)-1]`. Mixing the name and the operation is the source of the confusion, and consistent naming prevents it.

One Go-specific note on `queue = queue[1:]`, since it looks like it frees memory and does not. Reslicing only moves the slice header forward. The backing array still holds every element ever enqueued, and it is not reclaimed while the slice references it, so a BFS over a large graph retains memory proportional to *total* enqueues rather than the current frontier. It is idiomatic and fine for interviews, and worth knowing about when a long-running traversal's memory profile looks wrong. The fix when it matters is an explicit head index that you reset, or a ring buffer.

A quick self-check: after writing your traversal, trace through a three-vertex cycle and verify that each vertex is visited exactly once. This two-minute verification catches both mistakes before the interviewer sees them.

### Senior @ FAANG: Common Mistakes as Technical Debt Indicators

At staff level, seeing these mistakes in code review signals insufficient test coverage, not just an individual slip. Be precise about when the bug hides, though, because the usual summary ("it only fails on cycles") is too generous.

A BFS with no visited set fails on **any** undirected graph, including a two-vertex tree, because an undirected edge is traversable both ways: you enqueue the parent from the child and loop forever. It survives only on *directed* acyclic input, and even there it survives fully intact only on a directed **tree**, where every vertex has exactly one path to it.

On a general DAG it terminates and is still catastrophic, because it re-expands each vertex once per distinct *path* to it. Chain k diamonds together (`a -> b, a -> c, b -> d, c -> d`, repeat) and the number of paths doubles per diamond. A 61-vertex graph of 20 diamonds costs 4,194,301 expansions instead of 61. The traversal returns correct results, on a graph small enough to draw on a napkin, having done seventy thousand times the necessary work.

So the bug hides in exactly one shape of test data. If your fixtures are all small directed trees you will never see it, which is the actual lesson: a passing suite proves your fixtures resemble your fixtures.

The engineering practice that prevents this is mutation testing: automatically inject the bug (remove the visited check) and verify that at least one test fails. If no test fails with the bug injected, the test suite is insufficient. Mutation testing tools for Go (`pitest` equivalent: `go-mutesting`) can automate this check.

For the FIFO vs LIFO confusion, the fix is an explicit data structure: instead of using a raw slice, use a typed `Queue[T]` or `Stack[T]` with named methods (`Enqueue`/`Dequeue` vs `Push`/`Pop`). The method name communicates intent and makes the confusion impossible. This is a code review comment worth making: "Please use the team's typed Queue implementation here rather than a raw slice to prevent accidental LIFO behavior."

The broader principle is that common mistakes in algorithmic code should be caught by tooling (linters, mutation tests, property-based tests), not by individual vigilance. Staff engineers build the tooling that makes correct code the path of least resistance.

---
