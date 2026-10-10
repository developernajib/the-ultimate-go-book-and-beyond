## 72.13 Interview Questions

These are complete, ready-to-use solutions for the most commonly asked graph interview questions at FAANG companies. Each solution demonstrates idiomatic Go patterns and includes the reasoning behind the algorithm choice. Practice implementing these from scratch before your interview.

### Question 1: Number of Islands

This classic interview problem treats a 2D grid of '1's (land) and '0's (water) as an implicit graph. Each land cell is a vertex connected to its four neighbors (up, down, left, right). The task is to count the number of connected land regions (islands). The approach is to iterate over every cell, and when you find an unvisited '1', start a DFS to mark all connected land cells as visited, then increment the island count.

```go
func numIslands(grid [][]byte) int {
    if len(grid) == 0 {
        return 0
    }

    count := 0
    rows, cols := len(grid), len(grid[0])

    var dfs func(r, c int)
    dfs = func(r, c int) {
        if r < 0 || r >= rows || c < 0 || c >= cols || grid[r][c] == '0' {
            return
        }
        grid[r][c] = '0'  // Mark visited
        dfs(r+1, c)
        dfs(r-1, c)
        dfs(r, c+1)
        dfs(r, c-1)
    }

    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if grid[r][c] == '1' {
                count++
                dfs(r, c)
            }
        }
    }

    return count
}
```

Note that this **destroys the input**: writing `grid[r][c] = '0'` uses the grid itself as the visited set, so the caller's grid comes back as all water. That is the standard trick and it is fine on LeetCode, where nobody looks at the grid afterward. It is not fine in code someone else calls. Mention the trade-off out loud (it saves an O(m*n) visited array) and say you would either clone the grid or carry a separate `visited [][]bool` if the caller still needs their data. An interviewer who has seen this a hundred times notices when a candidate is the one who flags it.

### Question 2: Course Schedule (Topological Sort)

The Course Schedule problem asks whether it is possible to finish all courses given a list of prerequisite pairs. This is equivalent to checking whether a directed graph has a cycle: if course A requires course B, draw an edge from B to A. If you can produce a valid topological ordering (all vertices processed), then all courses can be completed. If a cycle exists, some courses form a circular dependency and cannot all be finished.

```go
func canFinish(numCourses int, prerequisites [][]int) bool {
    graph := make([][]int, numCourses)
    inDegree := make([]int, numCourses)

    for _, p := range prerequisites {
        graph[p[1]] = append(graph[p[1]], p[0])
        inDegree[p[0]]++
    }

    queue := []int{}
    for i := 0; i < numCourses; i++ {
        if inDegree[i] == 0 {
            queue = append(queue, i)
        }
    }

    taken := 0
    for len(queue) > 0 {
        course := queue[0]
        queue = queue[1:]
        taken++

        for _, next := range graph[course] {
            inDegree[next]--
            if inDegree[next] == 0 {
                queue = append(queue, next)
            }
        }
    }

    return taken == numCourses
}
```

### Junior → FAANG: Structuring Your Answers for These Two Problems

Number of Islands and Course Schedule are two of the most frequently asked graph problems anywhere, and having a structured answer for each is worth more than memorizing the code.

For Number of Islands: "I'll treat the grid as an implicit graph where each land cell is a vertex connected to its four neighbors. I'll iterate over all cells, and when I find an unvisited land cell I'll DFS to mark all connected land cells as visited, then increment the count. Time O(m*n), space O(m*n) for the recursion stack in the worst case."

For Course Schedule: "I'll model courses as vertices and prerequisites as directed edges from prerequisite to course. If the directed graph has a cycle, some courses cannot be completed. I'll use Kahn's algorithm: compute in-degrees, start with all zero-in-degree courses, process them greedily, and check if all courses are processed at the end. If not, there is a cycle. Time O(V+E), space O(V+E)."

Stating the model and algorithm before writing code shows algorithmic thinking. Writing the plan takes 60 seconds and prevents 10 minutes of debugging incorrect code.

### Senior @ FAANG: Depth of Knowledge Expected at L5 and Above

For Number of Islands at L5, the interviewer may follow up with: "What if the grid is too large to fit in memory?" The answer is streaming BFS or a distributed approach: process rows as they arrive, maintain a Union-Find structure for cells on the boundary between processed and unprocessed rows, and merge components as new rows arrive. This is the online/streaming variant of the problem.

For Course Schedule at L5, the follow-up may be: "What if the graph is distributed across multiple machines?" The answer is distributed topological sort using a BSP-style algorithm: in each round, every machine processes its subset of zero-in-degree vertices, sends "decrement in-degree" messages to machines owning the dependent vertices, and repeats until all vertices are processed. A cycle is detected if a round completes with no messages sent and unprocessed vertices remain.

At L6, the interview might not present a LeetCode problem at all. Instead, it might describe a system: "We have a microservice architecture with 500 services. How would you detect circular dependencies in our service dependency graph and automatically prevent them from being introduced in future PRs?" The answer combines topological sort (for detection), graph diff (to identify new edges in each PR), and CI/CD integration (to run the check automatically). This is the level of system-aware algorithmic thinking that L6 bar-raiser interviews assess.

---
