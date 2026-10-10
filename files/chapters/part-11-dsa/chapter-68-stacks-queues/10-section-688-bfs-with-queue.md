## 68.8 BFS with Queue

BFS is the canonical queue algorithm: it processes nodes level by level, guaranteeing the shortest path in unweighted graphs and grids. Enqueueing all starting nodes simultaneously enables multi-source BFS, which distributes distances from every source in a single pass, a technique critical for problems like Walls and Gates where the answer is the nearest of many possible sources.

```go
// BFS applications using queue

// NumberOfIslands counts islands in a grid
// LeetCode 200: Number of Islands
// Time: O(m*n), Space: O(min(m,n))
func NumIslands(grid [][]byte) int {
    if len(grid) == 0 {
        return 0
    }

    m, n := len(grid), len(grid[0])
    count := 0

    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            if grid[i][j] == '1' {
                count++
                bfs(grid, i, j)
            }
        }
    }

    return count
}

func bfs(grid [][]byte, startRow, startCol int) {
    m, n := len(grid), len(grid[0])
    queue := [][2]int{{startRow, startCol}}
    grid[startRow][startCol] = '0'

    directions := [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}}

    for len(queue) > 0 {
        cell := queue[0]
        queue = queue[1:]
        row, col := cell[0], cell[1]

        for _, dir := range directions {
            newRow, newCol := row+dir[0], col+dir[1]
            if newRow >= 0 && newRow < m && newCol >= 0 && newCol < n && grid[newRow][newCol] == '1' {
                grid[newRow][newCol] = '0'
                queue = append(queue, [2]int{newRow, newCol})
            }
        }
    }
}

// WallsAndGates fills each empty room with distance to nearest gate
// LeetCode 286: Walls and Gates
// Time: O(m*n), Space: O(m*n)
func WallsAndGates(rooms [][]int) {
    if len(rooms) == 0 {
        return
    }

    m, n := len(rooms), len(rooms[0])
    const INF = 2147483647
    queue := [][2]int{}

    // Start BFS from all gates simultaneously
    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            if rooms[i][j] == 0 {
                queue = append(queue, [2]int{i, j})
            }
        }
    }

    directions := [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}}

    for len(queue) > 0 {
        cell := queue[0]
        queue = queue[1:]
        row, col := cell[0], cell[1]

        for _, dir := range directions {
            newRow, newCol := row+dir[0], col+dir[1]
            if newRow >= 0 && newRow < m && newCol >= 0 && newCol < n && rooms[newRow][newCol] == INF {
                rooms[newRow][newCol] = rooms[row][col] + 1
                queue = append(queue, [2]int{newRow, newCol})
            }
        }
    }
}

// OpenLock finds minimum turns to open lock
// LeetCode 752: Open the Lock
// Time: O(10^4 * 8), Space: O(10^4)
//
// State space: 10,000 combinations, each with 8 neighbours (4 wheels times
// 2 directions).
func OpenLock(deadends []string, target string) int {
    dead := make(map[string]bool)
    for _, d := range deadends {
        dead[d] = true
    }

    // Both endpoints must be checked up front. A target that is itself a
    // deadend is unreachable, and the ordering matters: test membership in
    // dead BEFORE the target comparison in the loop below, or a deadend
    // target is reported as reached.
    if dead["0000"] || dead[target] {
        return -1
    }
    if target == "0000" {
        return 0
    }

    visited := make(map[string]bool)
    visited["0000"] = true
    queue := []string{"0000"}
    steps := 0

    for len(queue) > 0 {
        size := len(queue) // freeze the level boundary before draining it
        steps++

        for i := 0; i < size; i++ {
            curr := queue[0]
            queue = queue[1:]

            // Generate all neighbors
            for j := 0; j < 4; j++ {
                for d := -1; d <= 1; d += 2 {
                    next := []byte(curr)
                    next[j] = byte((int(next[j]-'0')+d+10)%10 + '0')
                    nextStr := string(next)

                    // Filter first, then test for success.
                    if dead[nextStr] || visited[nextStr] {
                        continue
                    }
                    if nextStr == target {
                        return steps
                    }

                    visited[nextStr] = true
                    queue = append(queue, nextStr)
                }
            }
        }
    }

    return -1
}
```

Two details in `OpenLock` are worth dwelling on, because both are general BFS technique rather than puzzle trivia.

The digit arithmetic `(int(next[j]-'0') + d + 10) % 10` adds 10 before taking the modulus for the same reason the ring deque adds capacity before its modulus: Go's `%` keeps the sign of the dividend, so `-1 % 10` is `-1`, not `9`. Any wrap-around arithmetic in Go needs this guard.

The `size := len(queue)` snapshot is what makes `steps` mean "distance from the start". The inner loop appends to the same queue it is draining, so without freezing the level boundary first, the loop would run into the next level and the step count would be meaningless. This is the level-order idiom, and it is the only correct way to count BFS depth without storing a depth on every node.

### Junior -> FAANG: BFS as a Queue Algorithm

BFS is the canonical application of a queue in algorithm interviews. Every BFS problem follows the same template: enqueue starting nodes, dequeue one node per iteration, process it, enqueue its unvisited neighbors, and repeat until the queue is empty.

**The three BFS variants to master:**
1. Single-source BFS (`NumIslands`): find all reachable nodes from one starting point.
2. Multi-source BFS (`WallsAndGates`): find distances from the nearest of multiple starting points simultaneously.
3. State-space BFS (`OpenLock`): nodes are states (e.g., lock combinations), edges are valid transitions.

**Level-order BFS:** Save the queue size before processing each level (`size := len(queue)`), process exactly `size` elements, then increment the level counter. This tracks the BFS level (distance from source) without storing level information in each node. `OpenLock` above is the worked example: `NumIslands` and `WallsAndGates` do not need it, because the former only counts components and the latter carries the distance in the grid itself.

**Common BFS bugs at entry level:**
- Marking nodes as visited when dequeued instead of when enqueued: the same node then gets enqueued once per incoming edge, and the queue blows up. Mark on enqueue.
- Forgetting to mark the starting node as visited before enqueueing it.
- Testing for the goal before filtering out invalid states, which is precisely the `OpenLock` deadend bug above. Filter, then test.
- Believing `queue = queue[1:]` is O(n). It is O(1). What it does do is abandon the front of the backing array, so the queue's memory never shrinks. That is bounded by the input for a one-shot BFS and unbounded for a long-lived queue, which is why production code uses a ring buffer. Get this one right, because it is a frequent source of confidently wrong interview answers.

**`OpenLock` as a state-space BFS template.** This problem models each lock combination as a node and each valid turn as an edge. The key insight is that the state space is finite (10^4 combinations) and the graph is implicitly defined by the transition function (increment or decrement each digit). This template applies to sliding puzzle, word ladder, and minimum number of moves problems.

### Senior @ FAANG: BFS Architecture and Multi-Source Patterns

**Multi-source BFS as a graph algorithm primitive.** The `WallsAndGates` algorithm initializes the BFS queue with all gates simultaneously and runs a single BFS pass. This is equivalent to adding a virtual super-source node connected to all gates with zero-weight edges. The result is that every room receives the shortest distance to the nearest gate, not just to any specific gate. This pattern generalizes to: nearest hospital in a city grid, nearest charging station on a map, nearest replica in a distributed cache. Any "nearest of k sources" problem on an unweighted graph is a multi-source BFS.

**BFS in distributed systems: breadth-first replication.** Graph replication in distributed systems often uses BFS to minimize the number of hops data must travel. A content delivery network that replicates files from an origin server chooses which edge servers to populate first based on BFS level from the origin, ensuring that requests served from level-1 servers can be answered before requests from level-2 servers are forwarded. This is the same algorithm as `WallsAndGates` applied to a network topology graph.

**ADR: BFS vs. Dijkstra for shortest path.** BFS finds shortest paths in unweighted graphs in O(V+E). Dijkstra finds shortest paths in weighted graphs in O((V+E) log V) with a binary heap. The choice between them depends on whether edge weights exist and vary. For grid problems with uniform step cost (move up/down/left/right), BFS is always correct and faster. For road networks with variable distances, Dijkstra is required. A common interview error is using Dijkstra (more complex code) for a problem that BFS solves correctly and more efficiently.

**`OpenLock` complexity and its implications.** The state space has 10^4 = 10,000 states, each with 8 transitions (4 digits times 2 directions), so total BFS work is bounded by 80,000 edge relaxations. This is a constant-bounded problem regardless of the `deadends` and `target` inputs, which means worst-case BFS runtime is deterministic. In production, state-space BFS for configuration reachability problems (can the system reach state X from state Y given valid transitions?) is the same algorithm at potentially larger scale. The practical concern is state representation size: if each state requires k bytes, the memory for all visited states is O(10^4 * k) bytes. For larger state spaces, bidirectional BFS (search from both source and target simultaneously) reduces the effective depth by half and dramatically reduces memory usage.
