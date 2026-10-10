## 83C.15 Mock Interview Session 7: Amazon SDE-II - Course Schedule & Leadership Principles

### Interviewer Briefing

**Company style:** Amazon. SDE-II (Senior SDE). Amazon uniquely integrates Leadership Principles (LPs) into technical interviews. Expect a 5-minute behavioral question at the start, followed by a technical problem. The interviewer evaluates both technical ability and LP alignment. "Dive Deep" is the primary LP tested in coding interviews - candidates must demonstrate thoroughness in understanding the problem and solution.

**Level:** SDE-II (equivalent to L5 at Google)

**Interview duration:** 45 minutes (5 min behavioral + 40 min coding)

**Key evaluation criteria:** Leadership Principle alignment, algorithmic thinking, code quality, edge case handling, testing rigor.

### Opening Behavioral: "Dive Deep" LP Story

**[0:00] Interviewer:** *"Before we start the coding portion, tell me about a time when you dove deep into a technical problem that others had given up on or accepted a surface-level solution for. What did you find, and what was the impact?"*

**[0:30] Candidate (Model STAR Answer):**

"**Situation:** Six months ago, our payment processing service had intermittent latency spikes - p99 latency would jump from 50ms to 2 seconds roughly every 4 hours. The team had attributed it to 'garbage collection pauses' and added a GC tuning flag, but the spikes continued. Two engineers had spent a combined week on it before moving on to other priorities.

**Task:** I volunteered to investigate because this was affecting our SLA with a major merchant partner, and we were at risk of losing a $2M annual contract. I set a personal goal of root-causing the issue within 3 days.

**Action:** I started by challenging the GC assumption. I added detailed GC telemetry - pause durations, heap sizes, allocation rates - and correlated them with the latency spikes. The GC pauses were real but only 50-100ms, not the 2 seconds we were seeing. That told me GC was a symptom, not the cause.

I dove deeper. I added distributed tracing with microsecond precision across every step of the payment flow. On the next spike, I found that 95% of the latency was in a database connection acquisition step. Our connection pool had a max of 50 connections, and during spikes, all 50 were occupied.

The next question was: why were all connections occupied every 4 hours? I wrote a monitoring query that logged every active connection's query and duration. I discovered that a batch reconciliation job - scheduled every 4 hours by a separate team - was running 50 parallel queries against the same database, each holding a connection for 3-5 seconds. During that window, the payment service had to wait for connections.

**Result:** I worked with the reconciliation team to move their batch job to a read replica and stagger their queries. The latency spikes disappeared completely. Our p99 dropped from 2 seconds to 55ms permanently. We retained the merchant partner, and the fix also improved throughput for three other services sharing that database. I documented the investigation as a postmortem template that the team now uses for all latency investigations."

**[4:30] Interviewer:** *"Good story. What's the key lesson you took from that experience?"*

**[4:45] Candidate:** "That 'examine closely' means questioning the first plausible explanation. The GC theory was plausible enough that two engineers accepted it. The real lesson was building systematic elimination - I didn't try to prove my theory was right, I tried to prove every theory wrong until only the truth remained."

### Problem Statement: Course Schedule (LeetCode 207 + 210)

**[5:00] Interviewer:** *"Now for the coding problem."*

> There are a total of `numCourses` courses you have to take, labeled from `0` to `numCourses - 1`. You are given an array `prerequisites` where `prerequisites[i] = [a, b]` indicates that you **must** take course `b` before course `a`.
>
> **Part 1:** Return `true` if you can finish all courses. (LeetCode 207)
>
> **Part 2:** Return a valid ordering of courses. If impossible, return an empty slice. (LeetCode 210)
>
> **Example 1:**
> Input: `numCourses = 4`, `prerequisites = [[1,0],[2,0],[3,1],[3,2]]`
> Output (Part 1): `true`
> Output (Part 2): `[0, 1, 2, 3]` or `[0, 2, 1, 3]`
>
> **Example 2:**
> Input: `numCourses = 2`, `prerequisites = [[1,0],[0,1]]`
> Output (Part 1): `false`
> Output (Part 2): `[]`
>
> **Constraints:**
> - `1 <= numCourses <= 2000`
> - `0 <= len(prerequisites) <= 5000`
> - All prerequisite pairs are unique
> - `prerequisites[i][0] != prerequisites[i][1]` (no self-loops)

### 40-Minute Timeline (Coding Portion)

| Time | Phase | What should happen |
|------|-------|--------------------|
| [5:00]-[7:00] | Read & Clarify | Candidate reads, identifies as topological sort |
| [7:00]-[9:00] | Approach Discussion | Candidate discusses BFS (Kahn's) vs DFS topological sort |
| [9:00]-[12:00] | Part 1 Implementation | Cycle detection via topological sort |
| [12:00]-[15:00] | Part 1 Testing | Trace through examples |
| [15:00]-[25:00] | Part 2 Implementation | Full topological ordering |
| [25:00]-[30:00] | Part 2 Testing | Verify valid ordering |
| [30:00]-[38:00] | Follow-up: Parallel Scheduling | Which courses can be taken simultaneously? |
| [38:00]-[45:00] | Follow-up Discussion | DFS alternative, complexity analysis |

### Interviewer Script & Candidate Response

**[5:00] Interviewer:** *"Take a moment to read both parts."*

**[6:00] Candidate:** "This is a topological sort problem. The courses form a directed graph where an edge from b to a means b is a prerequisite for a. We can finish all courses if and only if the graph has no cycles - meaning a valid topological ordering exists.

I'll use Kahn's algorithm (BFS-based topological sort) because it naturally handles both parts: detecting cycles (Part 1) and producing the ordering (Part 2). The idea is:
1. Compute in-degree for each node
2. Start with all nodes that have in-degree 0 (no prerequisites)
3. Process these nodes, decrementing in-degrees of their neighbors
4. If a neighbor's in-degree reaches 0, add it to the queue
5. If we process all nodes, no cycle exists. The processing order is a valid topological sort"

**[7:00] Candidate:** "Let me implement both parts together since Part 2 subsumes Part 1:

```go
// canFinish returns true if all courses can be completed (no cycles in prerequisite graph).
// This is Part 1 (LeetCode 207).
func canFinish(numCourses int, prerequisites [][]int) bool {
    order := findOrder(numCourses, prerequisites)
    return len(order) == numCourses
}

// findOrder returns a valid course ordering, or empty slice if impossible.
// Uses Kahn's algorithm (BFS topological sort).
// Time: O(V + E), Space: O(V + E)
func findOrder(numCourses int, prerequisites [][]int) []int {
    // Build adjacency list and compute in-degrees
    graph := make([][]int, numCourses)
    inDegree := make([]int, numCourses)

    for i := range graph {
        graph[i] = make([]int, 0)
    }

    for _, prereq := range prerequisites {
        course, prereqCourse := prereq[0], prereq[1]
        graph[prereqCourse] = append(graph[prereqCourse], course)
        inDegree[course]++
    }

    // Initialize queue with all courses that have no prerequisites
    queue := make([]int, 0)
    for i := 0; i < numCourses; i++ {
        if inDegree[i] == 0 {
            queue = append(queue, i)
        }
    }

    order := make([]int, 0, numCourses)

    for len(queue) > 0 {
        // Dequeue
        current := queue[0]
        queue = queue[1:]
        order = append(order, current)

        // Process all courses that depend on current
        for _, neighbor := range graph[current] {
            inDegree[neighbor]--
            if inDegree[neighbor] == 0 {
                queue = append(queue, neighbor)
            }
        }
    }

    // If we couldn't process all courses, there's a cycle
    if len(order) != numCourses {
        return []int{}
    }

    return order
}
```

**[15:00] Candidate:** "Let me trace Example 1: `numCourses=4, prerequisites=[[1,0],[2,0],[3,1],[3,2]]`

Graph: 0→[1,2], 1→[3], 2→[3]
In-degrees: [0, 1, 1, 2]

Initial queue: [0] (only course 0 has in-degree 0)

Step 1: Process 0, order=[0]
 - Neighbor 1: inDegree[1] = 0 → enqueue
 - Neighbor 2: inDegree[2] = 0 → enqueue
 - Queue: [1, 2]

Step 2: Process 1, order=[0, 1]
 - Neighbor 3: inDegree[3] = 1 → not ready
 - Queue: [2]

Step 3: Process 2, order=[0, 1, 2]
 - Neighbor 3: inDegree[3] = 0 → enqueue
 - Queue: [3]

Step 4: Process 3, order=[0, 1, 2, 3]
 - No neighbors
 - Queue: []

len(order) = 4 = numCourses → return [0, 1, 2, 3] ✓

Example 2: `numCourses=2, prerequisites=[[1,0],[0,1]]`
In-degrees: [1, 1] - no node has in-degree 0, queue is empty
order = [] → len(order) = 0 ≠ 2 → return [] ✓"

**[20:00] Interviewer:** *"Good. Now here's a follow-up that Amazon loves: what if courses at the same level can be taken in parallel? Given the prerequisites, what's the minimum number of semesters to complete all courses if you can take unlimited courses per semester?"*

**[20:30] Candidate:** "That's the longest path in the DAG - or equivalently, the number of levels in the BFS topological sort. I process nodes level by level instead of one at a time:

```go
// minSemesters returns the minimum number of semesters needed to complete all courses.
// Each semester, you can take all courses whose prerequisites are complete.
// Returns -1 if impossible (cycle exists).
// Time: O(V + E), Space: O(V + E)
func minSemesters(numCourses int, prerequisites [][]int) int {
    graph := make([][]int, numCourses)
    inDegree := make([]int, numCourses)

    for i := range graph {
        graph[i] = make([]int, 0)
    }

    for _, prereq := range prerequisites {
        course, prereqCourse := prereq[0], prereq[1]
        graph[prereqCourse] = append(graph[prereqCourse], course)
        inDegree[course]++
    }

    // Initialize with all zero in-degree courses
    queue := make([]int, 0)
    for i := 0; i < numCourses; i++ {
        if inDegree[i] == 0 {
            queue = append(queue, i)
        }
    }

    semesters := 0
    processed := 0

    for len(queue) > 0 {
        semesters++
        // Process entire level at once (all courses in this semester)
        levelSize := len(queue)
        for i := 0; i < levelSize; i++ {
            current := queue[0]
            queue = queue[1:]
            processed++

            for _, neighbor := range graph[current] {
                inDegree[neighbor]--
                if inDegree[neighbor] == 0 {
                    queue = append(queue, neighbor)
                }
            }
        }
    }

    if processed != numCourses {
        return -1 // Cycle detected
    }

    return semesters
}
```

For Example 1: Semester 1: [0], Semester 2: [1, 2], Semester 3: [3] → 3 semesters."

**[30:00] Interviewer:** *"What about a DFS approach to topological sort? Can you explain how that would work and when you'd prefer it?"*

**[30:30] Candidate:** "DFS topological sort uses the finishing order of DFS traversal (reversed). You mark nodes with three states: unvisited, in-progress, and completed. If you visit an in-progress node, you've found a cycle.

```go
// findOrderDFS returns a valid course ordering using DFS-based topological sort.
// Time: O(V + E), Space: O(V + E)
func findOrderDFS(numCourses int, prerequisites [][]int) []int {
    graph := make([][]int, numCourses)
    for i := range graph {
        graph[i] = make([]int, 0)
    }
    for _, prereq := range prerequisites {
        graph[prereq[1]] = append(graph[prereq[1]], prereq[0])
    }

    const (
        unvisited  = 0
        inProgress = 1
        completed  = 2
    )

    state := make([]int, numCourses)
    order := make([]int, 0, numCourses)
    hasCycle := false

    var dfs func(node int)
    dfs = func(node int) {
        if hasCycle {
            return
        }
        state[node] = inProgress

        for _, neighbor := range graph[node] {
            switch state[neighbor] {
            case inProgress:
                hasCycle = true
                return
            case unvisited:
                dfs(neighbor)
            }
        }

        state[node] = completed
        order = append(order, node)
    }

    for i := 0; i < numCourses; i++ {
        if state[i] == unvisited {
            dfs(i)
        }
    }

    if hasCycle {
        return []int{}
    }

    // Reverse the order (DFS finishing order is reverse topological)
    for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
        order[i], order[j] = order[j], order[i]
    }

    return order
}
```

I'd prefer DFS when:
- I need to detect specific cycles (DFS can identify which nodes are in the cycle)
- The graph is sparse and deep (DFS explores depth-first, better cache locality for deep chains)
- I need to find all possible topological orderings (easier to enumerate via backtracking from DFS)

I'd prefer BFS (Kahn's) when:
- I need the level structure (parallel scheduling, critical path)
- I want an iterative solution (avoids stack overflow for deep graphs)
- The problem naturally asks for 'layers' or 'stages'"

### Scoring Rubric

| Dimension | 1 (Poor) | 3 (Meets Bar) | 5 (Exceptional) |
|-----------|----------|----------------|------------------|
| **LP: Dive Deep** | Vague story, no specifics, surface-level investigation | Clear STAR story with specific technical details | Compelling narrative showing systematic elimination, quantified impact, and lasting process improvement |
| **Problem Recognition** | Cannot identify as topological sort | Identifies topological sort, chooses BFS or DFS | Immediately recognizes, discusses trade-offs between BFS and DFS approaches |
| **Part 1 Implementation** | Incorrect cycle detection | Correct implementation with minor issues | Clean, bug-free code with proper edge case handling |
| **Part 2 Implementation** | Cannot extend to produce ordering | Correct topological ordering | Clean code, handles empty graph, single node, disconnected components |
| **Parallel Scheduling Follow-up** | Cannot solve the extension | Correct level-by-level BFS solution | Immediate recognition as longest path in DAG, clean implementation |
| **DFS Alternative** | Cannot explain DFS topological sort | Explains DFS approach correctly | Implements DFS alternative, explains when each is preferred with concrete reasoning |
| **Code Quality** | Poor variable names, no comments, messy structure | Readable code with reasonable structure | Self-documenting, idiomatic Go, meaningful names, focused functions |

**Scoring thresholds:**
- **Strong Hire:** LP story scores ≥ 4, technical average ≥ 4.0
- **Hire:** LP story scores ≥ 3, technical average ≥ 3.0
- **Lean No Hire:** LP story scores ≥ 2, technical average ≥ 2.5
- **No Hire:** LP story scores < 2 or technical average < 2.5


### Junior → FAANG: Amazon SDE-II Coding Mock: Course Schedule

Course Schedule (LeetCode 207) is a topological sort and cycle detection problem on a directed graph. The two standard approaches are DFS-based cycle detection (three-color marking: white = unvisited, gray = in current DFS path, black = fully processed) and Kahn's algorithm (BFS-based topological sort using in-degree counts). Both run in O(V + E) time. Practice implementing both approaches, because Amazon interviewers may ask you to implement one and then explain the other as a follow-up.

### Senior @ FAANG: Course Schedule at the SDE-III Bar: Complexity Analysis and Production Adaptation

At the SDE-III level, the Course Schedule discussion extends to production considerations. The interviewer may ask: 'how would you detect cycles in a dependency graph that is updated by multiple services simultaneously?'. This changes the problem from a static graph algorithm to a distributed consistency problem: detecting cycles in a graph that is being concurrently modified requires either pessimistic locking (which limits throughput) or optimistic concurrency control with cycle detection on commit. Another SDE-III follow-up: 'the dependency graph has millions of nodes. How would you make cycle detection work at that scale?'. This requires a distributed graph processing framework or a change-driven incremental algorithm that maintains a topological sort in the face of edge insertions and deletions, which is a research-level problem that can be discussed at a high level without a complete solution.

---
