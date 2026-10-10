## 65.10 Comprehensive Exercises with Solutions

### Exercise 3: Production System Complexity Analysis

**Problem:** You're reviewing a production system. Analyze and optimize these real-world scenarios.

**Scenario A: Log Processing Pipeline**

```go
// Current implementation - analyze and optimize
func processLogs(logs []LogEntry) []Alert {
    var alerts []Alert

    // Group by user
    for _, log := range logs {
        found := false
        for i := range alerts {
            if alerts[i].UserID == log.UserID {
                alerts[i].Count++
                found = true
                break
            }
        }
        if !found {
            alerts = append(alerts, Alert{UserID: log.UserID, Count: 1})
        }
    }

    // Filter high-count alerts
    var result []Alert
    for _, alert := range alerts {
        if alert.Count > 100 {
            result = append(result, alert)
        }
    }

    return result
}
```

**Solution:**

```go
package main

type LogEntry struct {
    UserID    string
    Timestamp int64
    Message   string
}

type Alert struct {
    UserID string
    Count  int
}

// Original: O(n²) time - inner loop scans alerts for each log
// Let n = len(logs), u = unique users
// Worst case: all unique users → O(n²)

// Optimized: O(n) time using hash map
func processLogsOptimized(logs []LogEntry) []Alert {
    // O(n) - single pass to count by user
    counts := make(map[string]int, len(logs)/10) // estimate capacity
    for _, log := range logs {
        counts[log.UserID]++ // O(1) per operation
    }

    // O(u) - filter high counts
    alerts := make([]Alert, 0, len(counts)/10) // estimate capacity
    for userID, count := range counts {
        if count > 100 {
            alerts = append(alerts, Alert{UserID: userID, Count: count})
        }
    }

    return alerts
}

// Even more optimized for production: single allocation, streaming
func processLogsStreaming(logs []LogEntry, threshold int) []Alert {
    // Pre-size based on expected cardinality (estimate 10% unique users)
    estimatedUnique := len(logs) / 10
    if estimatedUnique < 16 {
        estimatedUnique = 16
    }

    counts := make(map[string]int, estimatedUnique)

    // Single pass - O(n)
    for i := range logs {
        counts[logs[i].UserID]++
    }

    // Pre-allocate result (estimate 1% will exceed threshold)
    result := make([]Alert, 0, len(counts)/100+1)

    for userID, count := range counts {
        if count > threshold {
            result = append(result, Alert{UserID: userID, Count: count})
        }
    }

    return result
}

// Complexity Comparison:
// ┌────────────────────┬─────────────┬───────────────────────────────┐
// │ Version            │ Time        │ Space                         │
// ├────────────────────┼─────────────┼───────────────────────────────┤
// │ Original           │ O(n²)       │ O(u) where u = unique users   │
// │ Optimized          │ O(n)        │ O(u)                          │
// │ Streaming          │ O(n)        │ O(u) but pre-allocated        │
// └────────────────────┴─────────────┴───────────────────────────────┘
```

**Scenario B: Real-time Leaderboard**

```go
// Current: Updates and queries
type Leaderboard struct {
    scores []PlayerScore
}

func (lb *Leaderboard) UpdateScore(playerID string, score int) {
    // Find and update
    for i := range lb.scores {
        if lb.scores[i].PlayerID == playerID {
            lb.scores[i].Score = score
            sort.Slice(lb.scores, func(i, j int) bool {
                return lb.scores[i].Score > lb.scores[j].Score
            })
            return
        }
    }
    // New player
    lb.scores = append(lb.scores, PlayerScore{playerID, score})
    sort.Slice(lb.scores, func(i, j int) bool {
        return lb.scores[i].Score > lb.scores[j].Score
    })
}

func (lb *Leaderboard) GetTopK(k int) []PlayerScore {
    if k > len(lb.scores) {
        k = len(lb.scores)
    }
    return lb.scores[:k]
}
```

**Solution:**

```go
package main

import "sort"

type PlayerScore struct {
    PlayerID string
    Score    int
}

// Original Analysis:
// UpdateScore: O(n) search + O(n log n) sort = O(n log n) per update
// GetTopK: O(1) - just slice
// Problem: Sorting on every update is expensive

// Solution 1: Skip List / Sorted Set approach (like Redis ZSET)
// UpdateScore: O(log n)
// GetTopK: O(k)

// Solution 2: Simplified with sorted slice + binary search
type OptimizedLeaderboard struct {
    scores   []PlayerScore          // Kept sorted by score descending
    index    map[string]int         // playerID -> position in scores
}

func NewOptimizedLeaderboard() *OptimizedLeaderboard {
    return &OptimizedLeaderboard{
        scores: make([]PlayerScore, 0),
        index:  make(map[string]int),
    }
}

// UpdateScore: O(n) due to array shifting, but no full re-sort
// Could be O(log n) with skip list or balanced BST
func (lb *OptimizedLeaderboard) UpdateScore(playerID string, newScore int) {
    if pos, exists := lb.index[playerID]; exists {
        oldScore := lb.scores[pos].Score
        if newScore == oldScore {
            return // No change
        }

        // Remove from old position
        lb.scores = append(lb.scores[:pos], lb.scores[pos+1:]...)

        // Update indices for shifted elements
        for i := pos; i < len(lb.scores); i++ {
            lb.index[lb.scores[i].PlayerID] = i
        }

        // Insert at new position
        lb.insertSorted(PlayerScore{playerID, newScore})
    } else {
        // New player
        lb.insertSorted(PlayerScore{playerID, newScore})
    }
}

// insertSorted uses binary search - O(log n) search + O(n) shift
func (lb *OptimizedLeaderboard) insertSorted(ps PlayerScore) {
    // Binary search for insert position - O(log n)
    pos := sort.Search(len(lb.scores), func(i int) bool {
        return lb.scores[i].Score <= ps.Score
    })

    // Insert at position - O(n) for shifting
    lb.scores = append(lb.scores, PlayerScore{})
    copy(lb.scores[pos+1:], lb.scores[pos:])
    lb.scores[pos] = ps

    // Update indices - O(n)
    for i := pos; i < len(lb.scores); i++ {
        lb.index[lb.scores[i].PlayerID] = i
    }
}

// GetTopK: O(k) - just slice copy
func (lb *OptimizedLeaderboard) GetTopK(k int) []PlayerScore {
    if k > len(lb.scores) {
        k = len(lb.scores)
    }
    result := make([]PlayerScore, k)
    copy(result, lb.scores[:k])
    return result
}

// GetRank: O(1) - direct lookup
func (lb *OptimizedLeaderboard) GetRank(playerID string) int {
    if pos, exists := lb.index[playerID]; exists {
        return pos + 1 // 1-indexed rank
    }
    return -1
}

// Complexity Comparison:
// ┌──────────────────┬─────────────────┬─────────────────┐
// │ Operation        │ Original        │ Optimized       │
// ├──────────────────┼─────────────────┼─────────────────┤
// │ UpdateScore      │ O(n log n)      │ O(n)            │
// │ GetTopK          │ O(1)            │ O(k)            │
// │ GetRank          │ O(n)            │ O(1)            │
// │ Space            │ O(n)            │ O(n)            │
// └──────────────────┴─────────────────┴─────────────────┘
//
// For true O(log n) updates: use balanced BST or skip list
// Redis uses skip list for sorted sets (ZADD, ZRANK, ZRANGE)
```

### Exercise 4: Memory-Efficient Algorithm Design

**Problem:** Design algorithms optimized for memory-constrained environments.

**Scenario A: Find Median in Data Stream**

```go
package main

import "container/heap"

// Standard approach: Two heaps
// Time: O(log n) per element
// Space: O(n) - stores all elements

type MedianFinder struct {
    maxHeap *MaxHeap // Lower half (max at top)
    minHeap *MinHeap // Upper half (min at top)
}

type MaxHeap []int
func (h MaxHeap) Len() int           { return len(h) }
func (h MaxHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h MaxHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MaxHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MaxHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[0 : n-1]
    return x
}

type MinHeap []int
func (h MinHeap) Len() int           { return len(h) }
func (h MinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h MinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MinHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[0 : n-1]
    return x
}

func NewMedianFinder() *MedianFinder {
    mf := &MedianFinder{
        maxHeap: &MaxHeap{},
        minHeap: &MinHeap{},
    }
    heap.Init(mf.maxHeap)
    heap.Init(mf.minHeap)
    return mf
}

// AddNum - O(log n) time
func (mf *MedianFinder) AddNum(num int) {
    // Add to maxHeap first
    heap.Push(mf.maxHeap, num)

    // Balance: move max from lower half to upper half
    heap.Push(mf.minHeap, heap.Pop(mf.maxHeap))

    // Ensure lower half has equal or one more element
    if mf.maxHeap.Len() < mf.minHeap.Len() {
        heap.Push(mf.maxHeap, heap.Pop(mf.minHeap))
    }
}

// FindMedian - O(1) time
func (mf *MedianFinder) FindMedian() float64 {
    if mf.maxHeap.Len() > mf.minHeap.Len() {
        return float64((*mf.maxHeap)[0])
    }
    return (float64((*mf.maxHeap)[0]) + float64((*mf.minHeap)[0])) / 2.0
}

// Memory-efficient variant: Approximate median with the P² algorithm
// (Jain and Chlamtac, 1985) for truly memory-constrained streaming scenarios
// Time: O(1) per element
// Space: O(1) - five markers regardless of stream length

type ApproximateMedian struct {
    q     [5]float64 // marker heights
    n     [5]int     // actual marker positions (1-based)
    count int
}

func NewApproximateMedian() *ApproximateMedian {
    return &ApproximateMedian{}
}

// Add - O(1) time, O(1) space
func (am *ApproximateMedian) Add(x float64) {
    if am.count < 5 {
        am.q[am.count] = x
        am.count++
        if am.count == 5 {
            am.initialize()
        }
        return
    }
    am.update(x)
}

func (am *ApproximateMedian) initialize() {
    // Sort the first 5 observations
    for i := 0; i < 5; i++ {
        for j := i + 1; j < 5; j++ {
            if am.q[i] > am.q[j] {
                am.q[i], am.q[j] = am.q[j], am.q[i]
            }
        }
    }
    for i := range am.n {
        am.n[i] = i + 1
    }
}

func (am *ApproximateMedian) update(x float64) {
    // Step 1: find the cell containing x, extending the extremes if needed
    var k int
    switch {
    case x < am.q[0]:
        am.q[0] = x
        k = 0
    case x >= am.q[4]:
        am.q[4] = x
        k = 3
    default:
        for k = 0; k < 3; k++ {
            if x < am.q[k+1] {
                break
            }
        }
    }

    // Step 2: increment positions of all markers above the cell
    for i := k + 1; i < 5; i++ {
        am.n[i]++
    }
    am.count++

    // Step 3: nudge interior markers toward their desired positions
    // Marker probabilities for the median: 0, 0.25, 0.5, 0.75, 1
    probs := [5]float64{0, 0.25, 0.5, 0.75, 1}
    for i := 1; i < 4; i++ {
        desired := 1 + probs[i]*float64(am.count-1)
        d := desired - float64(am.n[i])
        if (d >= 1 && am.n[i+1]-am.n[i] > 1) ||
            (d <= -1 && am.n[i-1]-am.n[i] < -1) {
            sign := 1
            if d < 0 {
                sign = -1
            }
            // Parabolic (P²) height prediction
            qp := am.parabolic(i, sign)
            if am.q[i-1] < qp && qp < am.q[i+1] {
                am.q[i] = qp
            } else {
                // Fall back to linear prediction
                am.q[i] += float64(sign) * (am.q[i+sign] - am.q[i]) /
                    float64(am.n[i+sign]-am.n[i])
            }
            am.n[i] += sign
        }
    }
}

func (am *ApproximateMedian) parabolic(i, d int) float64 {
    fd := float64(d)
    return am.q[i] + fd/float64(am.n[i+1]-am.n[i-1])*
        (float64(am.n[i]-am.n[i-1]+d)*(am.q[i+1]-am.q[i])/float64(am.n[i+1]-am.n[i])+
            float64(am.n[i+1]-am.n[i]-d)*(am.q[i]-am.q[i-1])/float64(am.n[i]-am.n[i-1]))
}

// Median - O(1) time
func (am *ApproximateMedian) Median() float64 {
    if am.count == 0 {
        return 0
    }
    if am.count < 5 {
        // Sort a copy and return the middle for small counts
        temp := make([]float64, am.count)
        copy(temp, am.q[:am.count])
        for i := 0; i < len(temp); i++ {
            for j := i + 1; j < len(temp); j++ {
                if temp[i] > temp[j] {
                    temp[i], temp[j] = temp[j], temp[i]
                }
            }
        }
        return temp[am.count/2]
    }
    return am.q[2] // middle marker estimates the median
}

// Complexity Comparison:
// ┌─────────────────────┬───────────┬──────────┬─────────────────────┐
// │ Algorithm           │ AddNum    │ Median   │ Space               │
// ├─────────────────────┼───────────┼──────────┼─────────────────────┤
// │ Two Heaps           │ O(log n)  │ O(1)     │ O(n) - stores all   │
// │ P² Approximate      │ O(1)      │ O(1)     │ O(1) - 5 markers    │
// │ Sorted Array        │ O(n)      │ O(1)     │ O(n)                │
// │ Reservoir Sampling  │ O(1)      │ O(k log k)│ O(k) - sample size │
// └─────────────────────┴───────────┴──────────┴─────────────────────┘
```

### Exercise 5: Complexity of Graph Algorithms

**Problem:** Implement and analyze common graph algorithms.

**Solution:**

```go
package main

import (
    "container/heap"
    "math"
)

type Graph struct {
    adjacencyList map[int][]Edge
}

type Edge struct {
    To     int
    Weight int
}

func NewGraph() *Graph {
    return &Graph{
        adjacencyList: make(map[int][]Edge),
    }
}

func (g *Graph) AddEdge(from, to, weight int) {
    g.adjacencyList[from] = append(g.adjacencyList[from], Edge{to, weight})
}

// BFS - Breadth-First Search
// Time: O(V + E) - visit each vertex and edge once
// Space: O(V) - queue can hold all vertices in worst case
func (g *Graph) BFS(start int) []int {
    visited := make(map[int]bool)
    result := []int{}
    queue := []int{start}

    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]  // Dequeue - O(1), but the backing array is only freed when BFS ends

        if visited[node] {
            continue
        }
        visited[node] = true
        result = append(result, node)

        for _, edge := range g.adjacencyList[node] {
            if !visited[edge.To] {
                queue = append(queue, edge.To)
            }
        }
    }
    return result
}

// DFS - Depth-First Search (iterative to avoid stack overflow)
// Time: O(V + E)
// Space: O(V) - explicit stack instead of call stack
func (g *Graph) DFS(start int) []int {
    visited := make(map[int]bool)
    result := []int{}
    stack := []int{start}

    for len(stack) > 0 {
        // Pop from stack
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]

        if visited[node] {
            continue
        }
        visited[node] = true
        result = append(result, node)

        // Add neighbors to stack
        for _, edge := range g.adjacencyList[node] {
            if !visited[edge.To] {
                stack = append(stack, edge.To)
            }
        }
    }
    return result
}

// Dijkstra's Algorithm - Shortest path from source to all vertices
// Time: O((V + E) log V) with binary heap
// Space: O(V) for distances + O(V) for heap
func (g *Graph) Dijkstra(source int, numVertices int) []int {
    distances := make([]int, numVertices)
    for i := range distances {
        distances[i] = math.MaxInt32
    }
    distances[source] = 0

    // Priority queue: [distance, vertex]
    pq := &PriorityQueue{}
    heap.Init(pq)
    heap.Push(pq, &Item{value: source, priority: 0})

    for pq.Len() > 0 {
        item := heap.Pop(pq).(*Item)
        u := item.value
        dist := item.priority

        // Skip if we've found a better path
        if dist > distances[u] {
            continue
        }

        // Relax edges
        for _, edge := range g.adjacencyList[u] {
            v := edge.To
            newDist := distances[u] + edge.Weight

            if newDist < distances[v] {
                distances[v] = newDist
                heap.Push(pq, &Item{value: v, priority: newDist})
            }
        }
    }

    return distances
}

// Priority Queue implementation for Dijkstra
type Item struct {
    value    int // vertex
    priority int // distance
    index    int
}

type PriorityQueue []*Item

func (pq PriorityQueue) Len() int           { return len(pq) }
func (pq PriorityQueue) Less(i, j int) bool { return pq[i].priority < pq[j].priority }
func (pq PriorityQueue) Swap(i, j int) {
    pq[i], pq[j] = pq[j], pq[i]
    pq[i].index = i
    pq[j].index = j
}
func (pq *PriorityQueue) Push(x any) {
    n := len(*pq)
    item := x.(*Item)
    item.index = n
    *pq = append(*pq, item)
}
func (pq *PriorityQueue) Pop() any {
    old := *pq
    n := len(old)
    item := old[n-1]
    old[n-1] = nil
    item.index = -1
    *pq = old[0 : n-1]
    return item
}

// Bellman-Ford - Handles negative weights
// Time: O(V × E) - V-1 iterations, each processing E edges
// Space: O(V) for distances
func (g *Graph) BellmanFord(source int, numVertices int) ([]int, bool) {
    distances := make([]int, numVertices)
    for i := range distances {
        distances[i] = math.MaxInt32
    }
    distances[source] = 0

    // Relax edges V-1 times
    for i := 0; i < numVertices-1; i++ {
        for u, edges := range g.adjacencyList {
            if distances[u] == math.MaxInt32 {
                continue
            }
            for _, edge := range edges {
                if distances[u]+edge.Weight < distances[edge.To] {
                    distances[edge.To] = distances[u] + edge.Weight
                }
            }
        }
    }

    // Check for negative cycles
    for u, edges := range g.adjacencyList {
        if distances[u] == math.MaxInt32 {
            continue
        }
        for _, edge := range edges {
            if distances[u]+edge.Weight < distances[edge.To] {
                return nil, false // Negative cycle detected
            }
        }
    }

    return distances, true
}

// Floyd-Warshall - All pairs shortest paths
// Time: O(V³)
// Space: O(V²) for the distance matrix
func FloydWarshall(numVertices int, edges [][]int) [][]int {
    // Initialize distance matrix
    dist := make([][]int, numVertices)
    for i := range dist {
        dist[i] = make([]int, numVertices)
        for j := range dist[i] {
            if i == j {
                dist[i][j] = 0
            } else {
                dist[i][j] = math.MaxInt32 / 2 // Avoid overflow
            }
        }
    }

    // Set edge weights
    for _, e := range edges {
        dist[e[0]][e[1]] = e[2]
    }

    // Main algorithm - O(V³)
    for k := 0; k < numVertices; k++ {
        for i := 0; i < numVertices; i++ {
            for j := 0; j < numVertices; j++ {
                if dist[i][k]+dist[k][j] < dist[i][j] {
                    dist[i][j] = dist[i][k] + dist[k][j]
                }
            }
        }
    }

    return dist
}

// Graph Algorithm Complexity Summary:
// ┌─────────────────────┬────────────────────┬──────────────────────────────┐
// │ Algorithm           │ Time               │ Use Case                     │
// ├─────────────────────┼────────────────────┼──────────────────────────────┤
// │ BFS                 │ O(V + E)           │ Shortest path (unweighted)   │
// │ DFS                 │ O(V + E)           │ Traversal, connectivity      │
// │ Dijkstra            │ O((V+E) log V)     │ Shortest path (non-negative) │
// │ Bellman-Ford        │ O(V × E)           │ Shortest path (any weights)  │
// │ Floyd-Warshall      │ O(V³)              │ All pairs shortest paths     │
// │ Kruskal's MST       │ O(E log E)         │ Minimum spanning tree        │
// │ Prim's MST          │ O(E log V)         │ Minimum spanning tree        │
// │ Topological Sort    │ O(V + E)           │ DAG ordering                 │
// │ Tarjan's SCC        │ O(V + E)           │ Strongly connected components│
// └─────────────────────┴────────────────────┴──────────────────────────────┘
```

### Junior → FAANG: Getting Full Value from Production System Exercises

The log processing and leaderboard exercises are more representative of real interviews than abstract algorithmic puzzles. They test whether you can identify the performance bottleneck in code that looks like it was written by a developer who prioritized correctness over efficiency, then redesign it systematically.

For the log processing exercise, the pattern is: find the inner loop, identify what data structure would answer the inner loop's question in O(1), and replace the loop with a single map lookup. This pattern transfers to almost every O(n squared) to O(n) optimization you will encounter.

For the leaderboard, note that the "truly optimal" solution (O(log n) updates) requires a skip list or balanced BST, neither of which Go provides in the standard library. Knowing this limitation and being able to propose `container/heap` as the closest standard alternative is a practical Go engineering skill. In a real interview, "the standard library does not provide a sorted set, so I would use a heap for O(log n) operations or reach for an external package like btree" is a more honest and impressive answer than pretending the problem is trivially solved.

For the median-in-stream exercise, the two-heap solution is the standard interview answer. But the P-squared approximate algorithm shows a deeper systems awareness: sometimes an exact answer is impossible or impractical, and a bounded-error approximation with O(1) space is the right engineering trade-off. Knowing both solutions and when each is appropriate is a senior-track signal.

### Senior @ FAANG: Production System Design Through a Complexity Lens

The exercises in this section expose a recurring tension in production system design: the theoretically optimal algorithm is often impractical for operational reasons, and the operational constraints shape which sub-optimal algorithm is actually chosen.

The leaderboard example illustrates this clearly. Redis sorted sets use a skip list that provides O(log n) rank and score updates. This is better than the O(n) array-based solution, but worse than the O(1) operations that could theoretically be achieved with some designs. The skip list is chosen because it is cache-friendly, supports range queries efficiently, and has predictable performance without the degenerate cases that plague naive BST implementations. A senior engineer designing a leaderboard service needs to know this trade-off and be able to justify the choice in a design review.

The graph algorithm complexity table is a design decision matrix. Choosing Dijkstra over Bellman-Ford for a road network routing service is not just an algorithmic choice: it is an assertion that edge weights are never negative, which is a business rule about how distances are modeled. If that assertion is ever violated by a data error, Dijkstra produces incorrect results silently. A robust production system would validate the non-negative invariant at data ingestion time and fail loudly if violated, rather than relying on the algorithm's assumption.

Floyd-Warshall's O(V cubed) complexity makes it unsuitable for large graphs at runtime, but suitable for offline precomputation on bounded-size subgraphs. A staff engineer designing a transit routing service might use Floyd-Warshall to precompute all-pairs shortest paths for the top 1,000 most-connected stations, then use Dijkstra for queries involving less-connected stations. That hybrid approach exploits the strengths of both algorithms while respecting their practical complexity limits.

---
