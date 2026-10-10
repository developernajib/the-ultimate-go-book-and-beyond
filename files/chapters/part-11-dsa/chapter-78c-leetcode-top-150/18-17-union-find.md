## 78C.17 Union Find

Union-Find (Disjoint Set Union) efficiently tracks connected components with near-O(1) operations using path compression and union by rank.

---
### LC 128 - Longest Consecutive Sequence 🟡

**Key Insight**: Use a hash set. For each number that is the start of a sequence (n-1 not in set), count consecutive elements.

This problem is filed with Union-Find because it is a grouping problem and is often posed that way, but the hash-set solution below is simpler and just as fast, so it is the one to reach for. The Union-Find version unions each n with n+1 and reports the largest component. Knowing that the straightforward structure wins here is itself the interview signal: reaching for Union-Find when a set suffices is over-engineering.

```go
func longestConsecutive(nums []int) int {
    set := make(map[int]bool)
    for _, n := range nums {
        set[n] = true
    }

    best := 0
    for n := range set {
        if !set[n-1] { // start of sequence
            length := 1
            for set[n+length] {
                length++
            }
            if length > best {
                best = length
            }
        }
    }
    return best
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 200 - Number of Islands (Union-Find approach)

*(DFS approach covered in Graphs section. Union-Find alternative below.)*

```go
func numIslands(grid [][]byte) int {
    if len(grid) == 0 {
        return 0
    }
    rows, cols := len(grid), len(grid[0])

    parent := make([]int, rows*cols)
    rank := make([]int, rows*cols)
    count := 0

    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if grid[r][c] == '1' {
                parent[r*cols+c] = r*cols + c
                count++
            }
        }
    }

    var find func(x int) int
    find = func(x int) int {
        if parent[x] != x {
            parent[x] = find(parent[x])
        }
        return parent[x]
    }

    union := func(x, y int) {
        px, py := find(x), find(y)
        if px == py {
            return
        }
        if rank[px] < rank[py] {
            px, py = py, px
        }
        parent[py] = px
        if rank[px] == rank[py] {
            rank[px]++
        }
        count--
    }

    dirs := [][2]int{{0, 1}, {1, 0}}
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if grid[r][c] == '1' {
                for _, d := range dirs {
                    nr, nc := r+d[0], c+d[1]
                    if nr < rows && nc < cols && grid[nr][nc] == '1' {
                        union(r*cols+c, nr*cols+nc)
                    }
                }
            }
        }
    }
    return count
}
```
**Time**: O(m × n × alpha(m × n)).
**Space**: O(m × n).

---
### LC 261 - Graph Valid Tree

*(Covered in Graphs section.)*

---
### LC 323 - Number of Connected Components

*(Covered in Graphs section.)*

---
### LC 684 - Redundant Connection

*(Covered in Graphs section.)*

---

### Junior → FAANG: When to Reach for Union-Find

Union-Find appears in problems involving dynamic connectivity: "are these two nodes in the same component?" after a series of merge operations. The interview signal to use it is: the problem involves grouping, merging, or checking whether two elements are connected, and connections are added but never removed. Classic problems include Number of Islands (merge adjacent land cells), Redundant Connection (detect cycle in undirected graph), and Number of Connected Components. Always implement with path compression and union by rank to achieve near-O(1) amortized operations. Without path compression, union-find degrades to O(n) per operation, which will fail time limits on large inputs.

### Senior @ FAANG: Union-Find in Distributed Systems and Offline Dynamic Connectivity

At the senior level, Union-Find's limitation is that it does not support deletion (you cannot un-merge two sets). This is the "offline dynamic connectivity" problem. For scenarios where edges can be added and removed, link-cut trees provide O(log n) connectivity queries with full add/remove support, but at significant implementation complexity. The practical alternative in production is to process deletions as a reverse-time addition problem: process events offline in reverse chronological order, converting deletions into additions, then run Union-Find forward. Google's Knowledge Graph uses this technique for offline graph consistency checks. At the staff level, the design question is: "How do you scale dynamic connectivity to a graph with 100 billion edges stored in distributed storage?" The answer involves partitioning the graph, running local Union-Find within each partition, and using a global coordinator to track cross-partition edges. The ADR for such a system documents the expected edge churn rate, the acceptable latency for connectivity queries, and the consistency model (strong consistency requires coordination, eventual consistency allows local-only Union-Find with periodic global merges).
