## 78B.8 The Union-Find Pattern

Union-Find (also called Disjoint Set Union) solves the dynamic connectivity problem: given a set of nodes and a stream of union operations, answer "are nodes X and Y in the same connected component?" in near-constant time. The two key optimizations (path compression and union by rank) work together to flatten the internal tree structure, reducing the effective tree height to nearly constant and giving an amortized time complexity of O(α(n)), where α is the inverse Ackermann function and never exceeds 4 for any practical input size.

```
┌─────────────────────────────────────────────────────────────────┐
│                    UNION-FIND PATTERN                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Operations:                                                    │
│  • Find(x): Return root of x's component (with path compress.)  │
│  • Union(x, y): Merge components of x and y (by rank)           │
│                                                                 │
│  Before Union(1, 5):          After Union(1, 5):                │
│  {0,1,2}  {3,4,5}            {0,1,2,3,4,5}                      │
│                                                                 │
│  Amortized O(α(n)) ≈ O(1) per operation                         │
│  with path compression + union by rank                          │
│                                                                 │
│  Use: Dynamic connectivity, cycle detection,                    │
│       Kruskal's MST, accounts merge                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Union-Find Implementation

Union-Find with path compression and union by rank achieves nearly O(1) amortized per operation. Path compression flattens the tree during `Find` by directly linking each node to its root, while union by rank always attaches the shorter tree under the taller one to minimize future path lengths.

```go
type UnionFind struct {
    parent []int
    rank   []int
    count  int // number of connected components
}

func NewUnionFind(n int) *UnionFind {
    parent := make([]int, n)
    rank := make([]int, n)
    for i := range parent {
        parent[i] = i
    }
    return &UnionFind{parent: parent, rank: rank, count: n}
}

func (uf *UnionFind) Find(x int) int {
    if uf.parent[x] != x {
        uf.parent[x] = uf.Find(uf.parent[x]) // path compression
    }
    return uf.parent[x]
}

func (uf *UnionFind) Union(x, y int) bool {
    rootX, rootY := uf.Find(x), uf.Find(y)
    if rootX == rootY {
        return false // already connected
    }

    // Union by rank
    if uf.rank[rootX] < uf.rank[rootY] {
        uf.parent[rootX] = rootY
    } else if uf.rank[rootX] > uf.rank[rootY] {
        uf.parent[rootY] = rootX
    } else {
        uf.parent[rootY] = rootX
        uf.rank[rootX]++
    }

    uf.count--
    return true
}

func (uf *UnionFind) Connected(x, y int) bool {
    return uf.Find(x) == uf.Find(y)
}
```

---

### Problem 1: Number of Connected Components in an Undirected Graph (LC 323)

**Problem:** Given `n` nodes and a list of edges, find the number of connected components.

**Approach:** Initialize Union-Find with n components. For each edge, union the two nodes. The remaining count is the answer.

```go
func countComponents(n int, edges [][]int) int {
    uf := NewUnionFind(n)

    for _, edge := range edges {
        uf.Union(edge[0], edge[1])
    }

    return uf.count
}
```

**Time Complexity:** O(n + E · α(n)) ≈ O(n + E), where E is the number of edges. The O(n) term is the initialization of the parent array and cannot be skipped even when there are no edges.
**Space Complexity:** O(n).

**Edge cases:**
- No edges → n components
- Fully connected → 1 component
- Self-loops → no effect (Find(x) == Find(x))

---

### Problem 2: Redundant Connection (LC 684)

**Problem:** A tree with n nodes has one extra edge. Find the edge that, if removed, results in a tree.

**Approach:** Process edges in order. The first edge that connects two already-connected nodes is the redundant edge.

```go
func findRedundantConnection(edges [][]int) []int {
    n := len(edges)
    uf := NewUnionFind(n + 1) // 1-indexed nodes

    for _, edge := range edges {
        if !uf.Union(edge[0], edge[1]) {
            return edge // already connected: this edge closes a cycle
        }
    }

    return nil // unreachable given the problem's guarantee
}
```

**Time Complexity:** O(n · α(n)) ≈ O(n).
**Space Complexity:** O(n).

The problem asks for the answer occurring last in the input, and this returns the first edge that closes a cycle. Those sound like opposites, and it is worth seeing why they are the same edge. Any edge on the cycle is a valid answer, since removing any one of them leaves a tree. Processing in input order, the cycle is not complete until its final edge arrives, so the first edge that fails to union *is* the last-in-input member of that cycle. The graph is a tree plus exactly one extra edge, so there is only one cycle to consider.

**Edge cases:**
- Minimum case: 3 nodes forming a triangle
- The allocation is `n + 1` because nodes are labeled 1 to n. Index 0 is allocated and never used, which is the cheapest way to handle 1-indexed input. The alternative, subtracting 1 from every label, is easy to apply inconsistently

---

### Problem 3: Accounts Merge (LC 721)

**Problem:** Given a list of accounts where each account has a name and emails, merge accounts that share any email.

**Approach:** Use Union-Find on email indices. Map each email to its first seen account index. If an email appears in multiple accounts, union those accounts.

```go
import "slices"

func accountsMerge(accounts [][]string) [][]string {
    emailToID := make(map[string]int)    // email -> first account index
    emailToName := make(map[string]string) // email -> account name

    uf := NewUnionFind(len(accounts))

    // Build union-find relationships
    for i, account := range accounts {
        name := account[0]
        for _, email := range account[1:] {
            emailToName[email] = name
            if prevID, exists := emailToID[email]; exists {
                uf.Union(i, prevID)
            } else {
                emailToID[email] = i
            }
        }
    }

    // Group emails by root component
    components := make(map[int][]string) // root -> emails
    for email, id := range emailToID {
        root := uf.Find(id)
        components[root] = append(components[root], email)
    }

    // Build result
    result := [][]string{}
    for _, emails := range components {
        slices.Sort(emails)
        name := emailToName[emails[0]]
        merged := append([]string{name}, emails...)
        result = append(result, merged)
    }

    return result
}
```

**Time Complexity:** O(n · k · log(n · k)) where n is the number of accounts and k the average emails per account. The union-find work is O(n · k · α(n)) and the sorting dominates it.
**Space Complexity:** O(n · k).

Note the union-find is indexed by *account*, not by email. Emails are the join key, but accounts are the things being merged, which keeps the structure at size n instead of n·k.

**Edge cases:**
- No shared emails → each account stays separate
- All emails shared → one merged account
- Same name, different people, no shared emails → correctly left unmerged, since the name is never used as a join key
- An account with a name and no emails contributes nothing to `emailToID` and so is dropped from the output entirely. If the constraints permit that input and the expected output keeps such an account, handle it separately

---

### Junior → FAANG: Union-Find vs. BFS for Connectivity

Junior candidates frequently solve connected components problems with BFS or DFS and never consider Union-Find. Both are correct, but Union-Find is preferable when: (1) edges are added dynamically (online/streaming), (2) you need to answer connectivity queries interleaved with union operations, or (3) the problem explicitly involves merging groups. BFS/DFS require the full graph to be built before traversal, which does not work for online edge streams.

The two optimizations (path compression and union by rank) work together but are independently valuable. Path compression alone gives O(log n) amortized per operation. Union by rank alone gives O(log n) worst case. Together they give O(α(n)) amortized, which is effectively O(1) for all practical input sizes. In an interview, implementing both from memory is expected at the mid-level. Not implementing either is a red flag.

Common bug: initializing the rank array with all zeros and then failing to increment rank when unioning two trees of the same rank. This causes the union-by-rank property to degrade over time and the tree to become unbalanced.

Entry-level signal: correctly implementing the `find` function with path compression using the two-line recursive form or the iterative two-pass form, and explaining why path compression does not change the logical structure of the union-find (it only flattens physical pointers, not the conceptual groups).

### Senior @ FAANG: Union-Find in Distributed Systems and Graph Databases

Union-Find's near-constant per-operation cost makes it a good fit for online clustering. Entity resolution, which deduplicates customer records that share a phone number, email, or address, is Accounts Merge at production scale. Grouping machines by failure domain and grouping endpoints by shared physical switch have the same shape. The common thread is that the grouping arrives incrementally as a stream of "these two are the same" facts, which is precisely the case BFS handles badly, since it wants the finished graph up front.

Distributing Union-Find is harder than it looks, because the parent array is shared mutable state and `Find` writes to it during path compression. The practical approaches are to partition so each shard owns a disjoint key range and merges are local, or to use a concurrent variant where the parent update is a compare-and-swap and a lost race is harmless because the loser simply retries against a tree that is already more compressed. Note the pleasant property that makes this workable: path compression is idempotent with respect to the answer. It changes pointers, never group membership, so a concurrent `Find` that reads a stale parent still reaches the correct root, just via a longer walk.

ADR consideration: Union-Find with path compression is not appropriate when union operations need to be undone (rollback). Path compression permanently restructures the tree, so there is no efficient way to reverse a union. If rollback is required (e.g., for offline dynamic connectivity where edges can be deleted), use a link-cut tree or a Union-Find with union by rank only (no path compression) and a rollback stack. Document this constraint explicitly when Union-Find is selected for a component that might later require edge deletion.

Bar-raiser signal: the candidate recognizes the Accounts Merge problem as a Union-Find problem where the universe of elements is email addresses rather than integers, explains the coordinate compression step needed to map email strings to integer indices, and discusses why using email strings directly as map keys in the parent map works but is slower due to hash computation cost. They also note that the number of union operations is bounded by the number of email-account associations, not the number of accounts, giving a tighter complexity bound than the naive O(n) accounts estimate.
